const fs = require('fs');
const path = require('path');

// Control stations should stay signed in across normal day-to-day use. Keep a
// minimum seven-day server session even if Railway still has the older 12-hour
// environment value configured. The client persists the token locally, while
// server-v2 remains authoritative and can still reject/revoke expired tokens.
const configuredSessionHours = Number(process.env.CONTROL_SESSION_HOURS || 0);
process.env.CONTROL_SESSION_HOURS = String(Math.max(168, Number.isFinite(configuredSessionHours) ? configuredSessionHours : 0));

const SLACK_WEBHOOK_URL = String(process.env.SLACK_WEBHOOK_URL || '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const OFFLINE_AFTER_MS = Math.max(15000, Number(process.env.OFFLINE_AFTER_MS || 30000));
const STATUS_TIME_ZONE = process.env.STATUS_TIME_ZONE || 'America/New_York';
const STATUS_HOUR = 17;
const originalFetch = global.fetch.bind(global);

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

setInterval(checkScheduledStatus, 30 * 1000).unref();
checkScheduledStatus();
require('./server-v2');