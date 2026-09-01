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
const STATUS_HOURS = new Set([0, 9, 13, 17, 20]);
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
  else if (issue === 'OBS WebSocket unavailable' || issue === 'OBS WebSocket not authenticated') recovery = 'OBS connection restored';
  else if (issue === 'Shade storage unmounted') recovery = 'Shade storage mounted';
  else if (/^RAM \d+%$/.test(issue)) recovery = 'RAM back to normal';
  else if (/^CPU \d+%$/.test(issue)) recovery = 'CPU back to normal';
  else if (/^Disk \d+% free$/.test(issue)) recovery = 'Storage back to normal';

  return `Room: ${room}\n${recovery}`;
}

global.fetch = async (url, options = {}) => {
  if (SLACK_WEBHOOK_URL && String(url) === SLACK_WEBHOOK_URL && options?.body) {
    try {
      const payload = JSON.parse(String(options.body));
      if (payload && typeof payload.text === 'string') {
        const rawText = payload.text;
        const isOfflineAlert = /\nIssue: Agent offline\n/.test(rawText);
        if (isOfflineAlert && inPlannedMaintenance()) {
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

function statusMessage(agent) {
  const metrics = agent.metrics || {};
  const apps = metrics.productionApps || {};
  const ram = metrics.memoryPressurePercent != null ? metrics.memoryPressurePercent : metrics.memoryPercent;

  const obsWebSocket = metrics.obsRunning === false
    ? 'N/A'
    : metrics.obsWebSocketReachable === false
      ? 'Unavailable'
      : metrics.obsWebSocketAuthenticated === false
        ? 'Not authenticated'
        : metrics.obsWebSocketReachable === true
          ? 'Connected'
          : 'N/A';

  const shade = apps.shade?.mounted === true
    ? 'Mounted'
    : apps.shade?.mounted === false
      ? 'Unmounted'
      : 'N/A';

  return [
    `${agent.roomName} — Status Update`,
    '',
    `CPU: ${pct(metrics.cpuPercent)}`,
    `RAM: ${pct(ram)}`,
    `Disk: ${metrics.diskFreePercent == null ? 'N/A' : `${pct(metrics.diskFreePercent)} free`}`,
    '',
    `OBS: ${online(metrics.obsRunning)}`,
    `OBS WebSocket: ${obsWebSocket}`,
    `Shade: ${shade}`,
    `Stream Deck: ${online(apps.streamDeck?.running)}`,
    `Camera Control: ${online(apps.cameraControl?.running)}`
  ].join('\n');
}

async function sendStatuses() {
  if (!SLACK_WEBHOOK_URL || inPlannedMaintenance()) return;
  const state = readState();
  if (!state?.agents) return;

  const now = Date.now();
  for (const agent of Object.values(state.agents)) {
    if (!agent?.lastSeen || now - Number(agent.lastSeen) > OFFLINE_AFTER_MS) continue;
    try {
      const response = await originalFetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: statusMessage(agent) })
      });
      if (!response.ok) console.error(`Slack status failed: HTTP ${response.status}`);
    } catch (err) {
      console.error('Slack status failed:', err.message);
    }
  }
}

let lastStatusSlot = '';
function checkScheduledStatus() {
  const now = zonedParts();
  if (now.minute !== 0 || !STATUS_HOURS.has(now.hour)) return;
  const slot = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}-${String(now.hour).padStart(2, '0')}`;
  if (slot === lastStatusSlot) return;
  lastStatusSlot = slot;
  sendStatuses();
}

setInterval(checkScheduledStatus, 30 * 1000).unref();
checkScheduledStatus();
require('./server-v2');