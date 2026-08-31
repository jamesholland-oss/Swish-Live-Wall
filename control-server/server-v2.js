const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ENROLLMENT_KEY = String(process.env.AGENT_ENROLLMENT_KEY || '');
const SLACK_WEBHOOK_URL = String(process.env.SLACK_WEBHOOK_URL || '');
const SESSION_HOURS = Math.max(1, Number(process.env.CONTROL_SESSION_HOURS || 12));
const OFFLINE_AFTER_MS = Math.max(15000, Number(process.env.OFFLINE_AFTER_MS || 30000));
const SAMPLE_INTERVAL_MS = Math.max(60000, Number(process.env.SAMPLE_INTERVAL_MS || 300000));
const MAX_SAMPLES = Math.max(288, Number(process.env.MAX_SAMPLES_PER_AGENT || 2016));

const sessions = new Map();
let persistTimer = null;

const nowIso = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function blankState() {
  return { version: 2, agents: {}, incidents: [], samples: {}, removedDevices: [] };
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      ...blankState(),
      ...saved,
      agents: saved.agents || {},
      incidents: Array.isArray(saved.incidents) ? saved.incidents : [],
      samples: saved.samples || {},
      removedDevices: Array.isArray(saved.removedDevices) ? saved.removedDevices : []
    };
  } catch (_) {
    return blankState();
  }
}

let state = loadState();

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STATE_FILE);
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, 250);
}

function parseUsers() {
  try {
    const users = JSON.parse(String(process.env.CONTROL_USERS_JSON || '[]'));
    return Array.isArray(users) ? users.map((user) => ({
      email: String(user.email || '').trim().toLowerCase(),
      password: String(user.password || ''),
      name: String(user.name || user.email || '').trim()
    })).filter((user) => user.email && user.password) : [];
  } catch (err) {
    console.error('CONTROL_USERS_JSON invalid:', err.message);
    return [];
  }
}

const users = parseUsers();

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS'
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    email: user.email,
    name: user.name,
    expiresAt: Date.now() + SESSION_HOURS * 3600000
  });
  return token;
}

function authUser(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function agentByToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  const hash = sha256(auth.slice(7).trim());
  return Object.values(state.agents).find((agent) => agent.tokenHash === hash) || null;
}

function slugify(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `room-${crypto.randomBytes(3).toString('hex')}`;
}

function uniqueRoomId(roomName) {
  const base = slugify(roomName);
  if (!Object.values(state.agents).some((agent) => agent.roomId === base)) return base;
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

function healthFor(agent, at = Date.now()) {
  const metrics = agent.metrics || {};
  const apps = metrics.productionApps || {};
  const age = at - Number(agent.lastSeen || 0);

  if (!agent.lastSeen) {
    const enrolled = agent.firstSeen ? at - Date.parse(agent.firstSeen) : OFFLINE_AFTER_MS + 1;
    if (enrolled <= OFFLINE_AFTER_MS) return { health: 'unmonitored', issue: 'Awaiting first heartbeat' };
    return { health: 'offline', issue: 'Agent offline' };
  }
  if (age > OFFLINE_AFTER_MS) return { health: 'offline', issue: 'Agent offline' };
  if (metrics.obsRunning === false) return { health: 'critical', issue: 'OBS offline' };
  if (metrics.obsRunning && metrics.obsWebSocketReachable === false) return { health: 'warning', issue: 'OBS WebSocket unavailable' };
  if (metrics.obsRunning && metrics.obsWebSocketReachable && metrics.obsWebSocketAuthenticated === false) return { health: 'warning', issue: 'OBS WebSocket not authenticated' };
  if (apps.shade?.running === true && apps.shade?.mounted === false) return { health: 'warning', issue: 'Shade storage unmounted' };
  if (Number(metrics.memoryPercent) >= 90) return { health: 'warning', issue: `RAM ${Math.round(metrics.memoryPercent)}%` };
  if (Number(metrics.cpuPercent) >= 90) return { health: 'warning', issue: `CPU ${Math.round(metrics.cpuPercent)}%` };
  if (metrics.diskFreePercent != null && Number(metrics.diskFreePercent) <= 10) return { health: 'warning', issue: `Disk ${Math.round(metrics.diskFreePercent)}% free` };
  return { health: 'healthy', issue: '' };
}

function issueKey(issue) {
  const value = String(issue || '');
  if (/^RAM \d+%$/.test(value)) return 'ram-high';
  if (/^CPU \d+%$/.test(value)) return 'cpu-high';
  if (/^Disk \d+% free$/.test(value)) return 'disk-low';
  return value.toLowerCase();
}

async function sendSlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (err) {
    console.error('Slack alert failed:', err.message);
  }
}

function slackHealthMessage(agent, health, issue) {
  const m = agent.metrics || {};
  const icon = health === 'warning' ? '⚠️' : '🔴';
  return `${icon} SWISH CONTROL — ${health.toUpperCase()}\nRoom: ${agent.roomName}\nIssue: ${issue}\nCPU: ${m.cpuPercent ?? '—'}% | RAM: ${m.memoryPercent ?? '—'}%\nDisk Free: ${m.diskFreePercent ?? '—'}%\nHost: ${agent.hostname || '—'} | IP: ${m.localIp || '—'}\nAction: Please check the room.`;
}

function activeHealthIncident(agentId) {
  return state.incidents.find((incident) => incident.agentId === agentId && incident.kind === 'health' && !incident.resolvedAt);
}

function addInfoEvent(agent, message, extra = {}) {
  const at = nowIso();
  state.incidents.unshift({
    id: crypto.randomUUID(),
    agentId: agent.agentId,
    roomId: agent.roomId,
    roomName: agent.roomName,
    kind: 'info',
    severity: 'info',
    message,
    openedAt: at,
    resolvedAt: at,
    status: 'info',
    ...extra
  });
}

function reconcile(agent) {
  const next = healthFor(agent);
  if (agent.health === next.health && agent.issue === next.issue) return false;

  const at = nowIso();
  const existing = activeHealthIncident(agent.agentId);

  if (next.health === 'healthy' || next.health === 'unmonitored') {
    if (existing) {
      existing.resolvedAt = at;
      existing.status = 'resolved';
      existing.resolution = 'Room returned to healthy state';
      sendSlack(`✅ SWISH CONTROL — RESOLVED\nRoom: ${agent.roomName}\nResolved: ${existing.message}\nStatus: Healthy`);
    }
  } else {
    const sameCondition = existing && existing.health === next.health && issueKey(existing.message) === issueKey(next.issue);

    if (sameCondition) {
      existing.message = next.issue;
      existing.lastUpdatedAt = at;
    } else {
      if (existing) {
        existing.resolvedAt = at;
        existing.status = 'resolved';
        existing.resolution = `Replaced by ${next.health}: ${next.issue}`;
      }

      state.incidents.unshift({
        id: crypto.randomUUID(), agentId: agent.agentId, roomId: agent.roomId, roomName: agent.roomName,
        kind: 'health', health: next.health, severity: next.health === 'warning' ? 'warning' : 'critical',
        message: next.issue, openedAt: at, resolvedAt: null, status: 'open'
      });
      sendSlack(slackHealthMessage(agent, next.health, next.issue));
    }
  }

  agent.health = next.health;
  agent.issue = next.issue;
  agent.healthChangedAt = at;
  return true;
}

function maybeSample(agent) {
  const samples = state.samples[agent.agentId] || [];
  const last = samples[samples.length - 1];
  if (last && Date.now() - Date.parse(last.at) < SAMPLE_INTERVAL_MS) return;

  samples.push({
    at: nowIso(),
    cpuPercent: agent.metrics?.cpuPercent ?? null,
    memoryPercent: agent.metrics?.memoryPercent ?? null,
    diskFreePercent: agent.metrics?.diskFreePercent ?? null,
    obsRunning: agent.metrics?.obsRunning ?? null,
    obsWebSocketReachable: agent.metrics?.obsWebSocketReachable ?? null,
    streamingActive: agent.metrics?.streamingActive ?? null
  });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  state.samples[agent.agentId] = samples;
}

function wallRooms() {
  return Object.values(state.agents).map((agent) => {
    const current = healthFor(agent);
    return {
      roomId: agent.roomId,
      roomName: agent.roomName,
      health: current.health,
      issue: current.issue,
      changedAt: agent.healthChangedAt || agent.lastSeenIso || null
    };
  }).sort((a, b) => a.roomName.localeCompare(b.roomName));
}

function controlRooms() {
  return Object.values(state.agents).map((agent) => {
    const current = healthFor(agent);
    return {
      agentId: agent.agentId,
      roomId: agent.roomId,
      roomName: agent.roomName,
      hostname: agent.hostname,
      platform: agent.platform,
      appVersion: agent.appVersion,
      firstSeen: agent.firstSeen,
      lastSeen: agent.lastSeen,
      lastSeenIso: agent.lastSeenIso,
      health: current.health,
      issue: current.issue,
      healthChangedAt: agent.healthChangedAt || null,
      metrics: agent.metrics || {},
      capabilities: agent.capabilities || []
    };
  }).sort((a, b) => a.roomName.localeCompare(b.roomName));
}

async function login(req, res) {
  if (!users.length) return sendJson(res, 503, { error: 'No control users configured.' });
  const body = await readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = users.find((candidate) => candidate.email === email);
  if (!user || !safeEqual(user.password, password)) return sendJson(res, 401, { error: 'Invalid email or password.' });
  const token = createSession(user);
  return sendJson(res, 200, { token, expiresInSeconds: SESSION_HOURS * 3600, user: { email: user.email, name: user.name } });
}

async function enroll(req, res) {
  if (!ENROLLMENT_KEY) return sendJson(res, 503, { error: 'Agent enrollment is not configured.' });
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7).trim(), ENROLLMENT_KEY)) return sendJson(res, 401, { error: 'Invalid enrollment key.' });

  const body = await readJson(req);
  const roomName = String(body.roomName || '').trim();
  const hostname = String(body.hostname || '').trim();
  if (!roomName || !hostname) return sendJson(res, 400, { error: 'roomName and hostname are required.' });

  const existing = Object.values(state.agents).find((agent) => agent.hostname === hostname && agent.roomName === roomName);
  const token = crypto.randomBytes(32).toString('hex');
  if (existing) {
    existing.tokenHash = sha256(token);
    existing.lastEnrollmentAt = nowIso();
    persist();
    return sendJson(res, 200, { agentId: existing.agentId, roomId: existing.roomId, token });
  }

  const at = nowIso();
  const agentId = crypto.randomUUID();
  const agent = {
    agentId,
    roomId: uniqueRoomId(roomName),
    roomName,
    hostname,
    platform: String(body.platform || ''),
    appVersion: '',
    tokenHash: sha256(token),
    firstSeen: at,
    lastSeen: 0,
    lastSeenIso: null,
    lastEnrollmentAt: at,
    health: 'unmonitored',
    issue: 'Awaiting first heartbeat',
    healthChangedAt: at,
    metrics: {},
    capabilities: []
  };

  state.agents[agentId] = agent;
  addInfoEvent(agent, 'Agent enrolled');
  persist();
  return sendJson(res, 201, { agentId, roomId: agent.roomId, token });
}

async function heartbeat(req, res) {
  const agent = agentByToken(req);
  if (!agent) return sendJson(res, 401, { error: 'Invalid agent credentials.' });

  const body = await readJson(req);
  if (body.agentId && String(body.agentId) !== agent.agentId) return sendJson(res, 403, { error: 'Agent ID mismatch.' });

  agent.roomName = String(body.roomName || agent.roomName);
  agent.hostname = String(body.hostname || agent.hostname);
  agent.platform = String(body.platform || agent.platform || '');
  agent.appVersion = String(body.appVersion || agent.appVersion || '');
  agent.metrics = body.metrics && typeof body.metrics === 'object' ? body.metrics : {};
  agent.capabilities = Array.isArray(body.capabilities) ? body.capabilities.slice(0, 20) : [];
  agent.lastSeen = Date.now();
  agent.lastSeenIso = nowIso();
  reconcile(agent);
  maybeSample(agent);
  schedulePersist();
  return sendJson(res, 200, { ok: true, health: agent.health, commands: [] });
}

async function removeAgent(req, res, agentId) {
  const user = authUser(req);
  if (!user) return sendJson(res, 401, { error: 'Authentication required.' });
  const agent = state.agents[agentId];
  if (!agent) return sendJson(res, 404, { error: 'Device not found.' });

  const body = await readJson(req).catch(() => ({}));
  const at = nowIso();
  const active = activeHealthIncident(agentId);
  if (active) {
    active.resolvedAt = at;
    active.status = 'resolved';
    active.resolution = 'Monitoring device removed';
  }

  addInfoEvent(agent, 'Device removed from monitoring', {
    removedBy: user.email,
    reason: String(body.reason || 'Removed from Swish Control')
  });

  state.removedDevices.unshift({
    agentId: agent.agentId,
    roomId: agent.roomId,
    roomName: agent.roomName,
    hostname: agent.hostname,
    removedAt: at,
    removedBy: user.email
  });

  delete state.agents[agentId];
  delete state.samples[agentId];
  persist();
  return sendJson(res, 200, { ok: true, removedAgentId: agentId });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, rooms: Object.keys(state.agents).length, time: nowIso() });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') return login(req, res);
    if (req.method === 'POST' && url.pathname === '/api/agent/enroll') return enroll(req, res);
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') return heartbeat(req, res);
    if (req.method === 'GET' && url.pathname === '/api/wall-status') return sendJson(res, 200, { rooms: wallRooms() });

    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required.' });
      return sendJson(res, 200, { rooms: controlRooms(), user });
    }

    if (req.method === 'GET' && url.pathname === '/api/incidents') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required.' });
      return sendJson(res, 200, { incidents: state.incidents.slice(0, 5000) });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/') && url.pathname.endsWith('/samples')) {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required.' });
      const roomId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const agent = Object.values(state.agents).find((candidate) => candidate.roomId === roomId);
      if (!agent) return sendJson(res, 404, { error: 'Room not found.' });
      return sendJson(res, 200, { roomId, samples: state.samples[agent.agentId] || [] });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/agents/')) {
      return removeAgent(req, res, decodeURIComponent(url.pathname.slice('/api/agents/'.length)));
    }

    if (req.method === 'POST' && url.pathname === '/api/commands') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required.' });
      return sendJson(res, 403, { error: 'Remote recovery commands are intentionally disabled for the pilot.' });
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Internal server error.' });
  }
});

setInterval(() => {
  let changed = false;
  for (const agent of Object.values(state.agents)) if (reconcile(agent)) changed = true;
  if (changed) schedulePersist();

  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
}, 5000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Swish Control server listening on ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Control users: ${users.length}`);
});
