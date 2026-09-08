const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// Control stations should stay signed in across normal day-to-day use. Keep a
// minimum seven-day server session even if Railway still has the older 12-hour
// environment value configured. The client persists the token locally, while
// server-v2 remains authoritative and can still reject/revoke expired tokens.
const configuredSessionHours = Number(process.env.CONTROL_SESSION_HOURS || 0);
process.env.CONTROL_SESSION_HOURS = String(Math.max(168, Number.isFinite(configuredSessionHours) ? configuredSessionHours : 0));

const SLACK_WEBHOOK_URL = String(process.env.SLACK_WEBHOOK_URL || '');
const SLACK_SIGNING_SECRET = String(process.env.SLACK_SIGNING_SECRET || '');
const SLACK_BOT_TOKEN = String(process.env.SLACK_BOT_TOKEN || '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const OFFLINE_AFTER_MS = Math.max(15000, Number(process.env.OFFLINE_AFTER_MS || 30000));
const STATUS_TIME_ZONE = process.env.STATUS_TIME_ZONE || 'America/New_York';
const STATUS_HOUR = 17;
const originalFetch = global.fetch.bind(global);

// Diagnostics commands are intentionally server-side only. Current room agents
// already advertise diagnostics-bundle-v1 and know how to execute the
// collect-diagnostics command returned from heartbeat responses.
const diagnosticsCommands = new Map();
const DIAGNOSTICS_COMMAND_TTL_MS = 10 * 60 * 1000;
const MAX_DIAGNOSTICS_UPLOAD_BYTES = 30 * 1024 * 1024;

function zonedParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: STATUS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: String(parts.weekday || ''),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function inPlannedMaintenance(date = new Date()) {
  const now = zonedParts(date);
  if (now.weekday === 'Mon' && now.hour >= 1 && now.hour < 9) return true;
  if (now.weekday === 'Thu' && now.hour >= 2 && now.hour < 9) return true;
  return false;
}

function isCriticalIssue(issue) {
  return issue === 'Agent offline' || issue === 'OBS offline';
}

function polishSlackText(text) {
  const value = String(text || '');

  const alert = value.match(/^Room: (.+)\nIssue: (.+)\nAction: (.+)$/s);
  if (alert) return `Room: ${alert[1]}\n${alert[2]}\n${alert[3]}`;

  const resolved = value.match(/^Room: (.+)\nResolved: (.+)$/s);
  if (!resolved) return value;

  const room = resolved[1];
  const issue = resolved[2];
  let recovery = `Resolved: ${issue}`;

  if (issue === 'Agent offline') recovery = 'Agent online';
  else if (issue === 'OBS offline') recovery = 'OBS online';

  return `Room: ${room}\n${recovery}`;
}

global.fetch = async (url, options = {}) => {
  if (SLACK_WEBHOOK_URL && String(url) === SLACK_WEBHOOK_URL && options?.body) {
    try {
      const payload = JSON.parse(String(options.body));
      if (payload && typeof payload.text === 'string') {
        const rawText = payload.text;
        const alert = rawText.match(/^Room: (.+)\nIssue: (.+)\nAction: (.+)$/s);
        const resolved = rawText.match(/^Room: (.+)\nResolved: (.+)$/s);

        if (alert) {
          const issue = alert[2];
          if (!isCriticalIssue(issue)) return new Response('', { status: 204 });
          if (issue === 'Agent offline' && inPlannedMaintenance()) return new Response('', { status: 204 });
        }

        if (resolved && !isCriticalIssue(resolved[2])) {
          return new Response('', { status: 204 });
        }

        payload.text = polishSlackText(rawText);
        options = { ...options, body: JSON.stringify(payload) };
      }
    } catch (_) {}
  }
  return originalFetch(url, options);
};

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function pct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}%` : 'N/A';
}

function online(value) {
  if (value === true) return 'Online';
  if (value === false) return 'Offline';
  return 'N/A';
}

function roomStatusBlock(agent, now = Date.now()) {
  const metrics = agent.metrics || {};
  const apps = metrics.productionApps || {};
  const ram = metrics.memoryPressurePercent != null ? metrics.memoryPressurePercent : metrics.memoryPercent;
  const isAgentOnline = Boolean(agent.lastSeen) && now - Number(agent.lastSeen) <= OFFLINE_AFTER_MS;

  if (!isAgentOnline) {
    return [
      `${agent.roomName}`,
      'Agent: Offline',
      'OBS: N/A | Shade: N/A | Stream Deck: N/A | Camera: N/A',
      'CPU: N/A | RAM: N/A | Disk: N/A'
    ].join('\n');
  }

  const shade = apps.shade?.mounted === true
    ? 'Mounted'
    : apps.shade?.mounted === false
      ? 'Unmounted'
      : 'N/A';

  return [
    `${agent.roomName}`,
    `Agent: Online | OBS: ${online(metrics.obsRunning)} | Shade: ${shade}`,
    `Stream Deck: ${online(apps.streamDeck?.running)} | Camera: ${online(apps.cameraControl?.running)}`,
    `CPU: ${pct(metrics.cpuPercent)} | RAM: ${pct(ram)} | Disk: ${metrics.diskFreePercent == null ? 'N/A' : `${pct(metrics.diskFreePercent)} free`}`
  ].join('\n');
}

function dailyStatusMessage(agents) {
  const now = Date.now();
  const blocks = agents
    .slice()
    .sort((a, b) => String(a.roomName || '').localeCompare(String(b.roomName || '')))
    .map((agent) => roomStatusBlock(agent, now));

  return [
    'Swish Control — 5:00 PM Daily Status',
    '',
    ...blocks.reduce((lines, block, index) => {
      if (index) lines.push('');
      lines.push(block);
      return lines;
    }, [])
  ].join('\n');
}

async function sendDailyStatus() {
  if (!SLACK_WEBHOOK_URL || inPlannedMaintenance()) return;
  const state = readState();
  if (!state?.agents) return;

  const agents = Object.values(state.agents);
  if (!agents.length) return;

  try {
    const response = await originalFetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: dailyStatusMessage(agents) })
    });
    if (!response.ok) console.error(`Slack daily status failed: HTTP ${response.status}`);
  } catch (err) {
    console.error('Slack daily status failed:', err.message);
  }
}

let lastStatusSlot = '';
function checkScheduledStatus() {
  const now = zonedParts();
  if (now.minute !== 0 || now.hour !== STATUS_HOUR) return;
  const slot = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  if (slot === lastStatusSlot) return;
  lastStatusSlot = slot;
  sendDailyStatus();
}

function timingSafeHexEqual(a, b) {
  try {
    const left = Buffer.from(String(a || ''), 'hex');
    const right = Buffer.from(String(b || ''), 'hex');
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

function verifySlackSignature(req, rawBody) {
  if (!SLACK_SIGNING_SECRET) return false;
  const timestamp = String(req.headers['x-slack-request-timestamp'] || '');
  const signature = String(req.headers['x-slack-signature'] || '');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  if (!signature.startsWith('v0=')) return false;
  const expected = crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');
  return timingSafeHexEqual(signature.slice(3), expected);
}

function sendText(res, status, text) {
  const body = String(text || '');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cleanupDiagnosticsCommands() {
  const now = Date.now();
  for (const [id, command] of diagnosticsCommands.entries()) {
    if (now - command.createdAt > DIAGNOSTICS_COMMAND_TTL_MS) diagnosticsCommands.delete(id);
  }
}

function findRoomFromCommand(text) {
  const state = readState();
  const agents = Object.values(state?.agents || {});
  if (!agents.length) return { error: 'No Swish Control agents are enrolled yet.' };

  let input = String(text || '').trim();
  let hours = 24;
  const hoursMatch = input.match(/(?:^|\s)(\d{1,3})h\s*$/i);
  if (hoursMatch) {
    hours = Math.max(1, Math.min(168, Number(hoursMatch[1]) || 24));
    input = input.slice(0, hoursMatch.index).trim();
  }

  if (!input) {
    const names = agents.map((agent) => agent.roomName).sort().join(', ');
    return { error: `Usage: /logs <room name> [hours]. Rooms: ${names}` };
  }

  const exact = agents.find((agent) => String(agent.roomName || '').toLowerCase() === input.toLowerCase());
  if (exact) return { agent: exact, hours };

  const partial = agents.filter((agent) => String(agent.roomName || '').toLowerCase().includes(input.toLowerCase()));
  if (partial.length === 1) return { agent: partial[0], hours };
  if (partial.length > 1) return { error: `Multiple rooms match “${input}”. Use the full room name.` };

  return { error: `Room “${input}” was not found.` };
}

async function postSlackResponse(responseUrl, text) {
  if (!responseUrl) return;
  try {
    await originalFetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text })
    });
  } catch (err) {
    console.error('Slack response failed:', err.message);
  }
}

async function slackApi(method, body) {
  if (!SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN is not configured.');
  const response = await originalFetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `Slack API ${method} failed (${response.status})`);
  return data;
}

async function uploadDiagnosticsToSlack(command, fileBuffer, fileName) {
  if (!SLACK_BOT_TOKEN) {
    await postSlackResponse(command.responseUrl, `Diagnostics received for ${command.roomName}, but SLACK_BOT_TOKEN is not configured for file uploads.`);
    return;
  }

  const safeName = String(fileName || `swish-diagnostics-${command.roomId}.zip`).replace(/[\r\n]/g, '').slice(0, 180);
  const uploadInfo = await slackApi('files.getUploadURLExternal', {
    filename: safeName,
    length: fileBuffer.length
  });

  const uploadResponse = await originalFetch(uploadInfo.upload_url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: fileBuffer
  });
  if (!uploadResponse.ok) throw new Error(`Slack file upload failed (${uploadResponse.status})`);

  await slackApi('files.completeUploadExternal', {
    files: [{ id: uploadInfo.file_id, title: `${command.roomName} diagnostics` }],
    channel_id: command.channelId,
    initial_comment: `Diagnostics — ${command.roomName} — last ${command.hours}h`
  });

  await postSlackResponse(command.responseUrl, `Diagnostics uploaded for ${command.roomName}.`);
}

async function handleSlackLogsCommand(req, res) {
  let raw;
  try {
    raw = await readRawBody(req, 256 * 1024);
  } catch (err) {
    sendText(res, 413, err.message);
    return;
  }

  const rawText = raw.toString('utf8');
  if (!verifySlackSignature(req, rawText)) {
    sendText(res, 401, 'Invalid Slack signature.');
    return;
  }

  const form = new URLSearchParams(rawText);
  const parsed = findRoomFromCommand(form.get('text'));
  if (parsed.error) {
    sendText(res, 200, parsed.error);
    return;
  }

  const agent = parsed.agent;
  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  if (!capabilities.includes('diagnostics-bundle-v1')) {
    sendText(res, 200, `${agent.roomName} is online, but its installed agent does not advertise diagnostics support.`);
    return;
  }

  const isOnline = Boolean(agent.lastSeen) && Date.now() - Number(agent.lastSeen) <= OFFLINE_AFTER_MS;
  if (!isOnline) {
    sendText(res, 200, `${agent.roomName} is offline, so logs cannot be collected right now.`);
    return;
  }

  cleanupDiagnosticsCommands();
  const id = crypto.randomUUID();
  diagnosticsCommands.set(id, {
    id,
    type: 'collect-diagnostics',
    agentId: agent.agentId,
    roomId: agent.roomId,
    roomName: agent.roomName,
    hours: parsed.hours,
    channelId: String(form.get('channel_id') || ''),
    responseUrl: String(form.get('response_url') || ''),
    requestedBy: String(form.get('user_name') || form.get('user_id') || ''),
    createdAt: Date.now(),
    deliveredAt: null
  });

  sendText(res, 200, `Collecting ${parsed.hours}h of diagnostics from ${agent.roomName}…`);
}

function authMatchesCommand(req, command) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return false;
  const tokenHash = crypto.createHash('sha256').update(auth.slice(7).trim()).digest('hex');
  const state = readState();
  const agent = state?.agents?.[command.agentId];
  return Boolean(agent?.tokenHash) && tokenHash === agent.tokenHash;
}

async function handleDiagnosticsUpload(req, res, commandId) {
  cleanupDiagnosticsCommands();
  const command = diagnosticsCommands.get(commandId);
  if (!command) {
    sendText(res, 404, 'Unknown or expired diagnostics command.');
    return;
  }
  if (!authMatchesCommand(req, command)) {
    sendText(res, 401, 'Unauthorized diagnostics upload.');
    return;
  }

  let fileBuffer;
  try {
    fileBuffer = await readRawBody(req, MAX_DIAGNOSTICS_UPLOAD_BYTES);
  } catch (err) {
    sendText(res, 413, err.message);
    return;
  }
  if (!fileBuffer.length) {
    sendText(res, 400, 'Empty diagnostics upload.');
    return;
  }

  sendText(res, 200, 'OK');
  diagnosticsCommands.delete(commandId);

  const fileName = String(req.headers['x-swish-file-name'] || `swish-diagnostics-${command.roomId}.zip`);
  uploadDiagnosticsToSlack(command, fileBuffer, fileName).catch(async (err) => {
    console.error('Slack diagnostics upload failed:', err.message);
    await postSlackResponse(command.responseUrl, `Diagnostics collection finished for ${command.roomName}, but Slack upload failed: ${err.message}`);
  });
}

// Interpose only the small amount of HTTP behavior needed for Slack diagnostics.
// All normal Swish Control routes continue to run through server-v2 untouched.
const originalCreateServer = http.createServer.bind(http);
http.createServer = function createServerWithSlackDiagnostics(handler) {
  return originalCreateServer((req, res) => {
    const pathname = (() => {
      try { return new URL(req.url || '/', 'http://localhost').pathname; }
      catch (_) { return '/'; }
    })();

    if (req.method === 'POST' && pathname === '/slack/logs') {
      handleSlackLogsCommand(req, res).catch((err) => {
        console.error('Slack logs command failed:', err.message);
        if (!res.headersSent) sendText(res, 500, 'Unable to start diagnostics collection.');
      });
      return;
    }

    const diagnosticsMatch = pathname.match(/^\/api\/agent\/diagnostics\/([^/]+)$/);
    if (req.method === 'POST' && diagnosticsMatch) {
      handleDiagnosticsUpload(req, res, decodeURIComponent(diagnosticsMatch[1])).catch((err) => {
        console.error('Diagnostics upload failed:', err.message);
        if (!res.headersSent) sendText(res, 500, 'Diagnostics upload failed.');
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/agent/heartbeat') {
      const requestChunks = [];
      req.on('data', (chunk) => requestChunks.push(Buffer.from(chunk)));

      const originalEnd = res.end.bind(res);
      res.end = function endWithDiagnosticsCommand(chunk, encoding, callback) {
        try {
          const requestBody = JSON.parse(Buffer.concat(requestChunks).toString('utf8') || '{}');
          const roomId = String(requestBody.roomId || '');
          const agentId = String(requestBody.agentId || '');
          const pending = [...diagnosticsCommands.values()].find((command) =>
            !command.deliveredAt && command.roomId === roomId && command.agentId === agentId
          );

          if (pending && chunk != null) {
            const raw = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk);
            const payload = JSON.parse(raw);
            const commands = Array.isArray(payload.commands) ? payload.commands : [];
            commands.push({ id: pending.id, type: 'collect-diagnostics', hours: pending.hours });
            payload.commands = commands;
            pending.deliveredAt = Date.now();
            chunk = JSON.stringify(payload);
            try {
              res.removeHeader('content-length');
              res.setHeader('content-length', Buffer.byteLength(chunk));
            } catch (_) {}
          }
        } catch (_) {}
        return originalEnd(chunk, encoding, callback);
      };
    }

    handler(req, res);
  });
};

setInterval(checkScheduledStatus, 30 * 1000).unref();
setInterval(cleanupDiagnosticsCommands, 60 * 1000).unref();
checkScheduledStatus();
require('./server-v2');