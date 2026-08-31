const fs = require('fs');
const path = require('path');

const SLACK_WEBHOOK_URL = String(process.env.SLACK_WEBHOOK_URL || '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const OFFLINE_AFTER_MS = Math.max(15000, Number(process.env.OFFLINE_AFTER_MS || 30000));
const originalFetch = global.fetch.bind(global);

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
        payload.text = polishSlackText(payload.text);
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

function hourlyMessage(agent) {
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
    `${agent.roomName} — Hourly Status`,
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

async function sendHourlyStatuses() {
  if (!SLACK_WEBHOOK_URL) return;
  const state = readState();
  if (!state?.agents) return;

  const now = Date.now();
  for (const agent of Object.values(state.agents)) {
    if (!agent?.lastSeen || now - Number(agent.lastSeen) > OFFLINE_AFTER_MS) continue;
    try {
      const response = await originalFetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: hourlyMessage(agent) })
      });
      if (!response.ok) console.error(`Hourly Slack status failed: HTTP ${response.status}`);
    } catch (err) {
      console.error('Hourly Slack status failed:', err.message);
    }
  }
}

function scheduleHourlyStatuses() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  const delay = Math.max(1000, next.getTime() - now.getTime());

  setTimeout(() => {
    sendHourlyStatuses();
    setInterval(sendHourlyStatuses, 60 * 60 * 1000).unref();
  }, delay).unref();
}

scheduleHourlyStatuses();
require('./server-v2');
