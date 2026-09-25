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
const SLACK_CLIP_WEBHOOK_URL = String(process.env.SLACK_CLIP_WEBHOOK_URL || '');
const BUSINESS_INGEST_KEY = String(process.env.BUSINESS_INGEST_KEY || '');
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
  return {
    version: 3,
    agents: {},
    incidents: [],
    samples: {},
    removedDevices: [],
    media: [],
    business: {},
    roomSettings: {}
  };
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
      removedDevices: Array.isArray(saved.removedDevices) ? saved.removedDevices : [],
      media: Array.isArray(saved.media) ? saved.media : [],
      business: saved.business && typeof saved.business === 'object' ? saved.business : {},
      roomSettings: saved.roomSettings && typeof saved.roomSettings === 'object' ? saved.roomSettings : {}
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

const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  admin: [
    'wall:view', 'rooms:view', 'technical:view', 'incidents:view',
    'diagnostics:request', 'clips:view', 'sales:view', 'sales:reports',
    'users:manage', 'settings:manage'
  ],
  business: ['wall:view', 'rooms:view', 'clips:view', 'sales:view', 'sales:reports'],
  ops: ['wall:view', 'rooms:view', 'technical:view', 'incidents:view', 'diagnostics:request', 'clips:view'],
  viewer: ['wall:view', 'rooms:view'],
  wall_only: ['wall:view']
};

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role) ? role : 'admin';
}

function permissionsForRole(role, extra = []) {
  const base = ROLE_PERMISSIONS[normalizeRole(role)] || [];
  if (base.includes('*')) return ['*'];
  return [...new Set([...base, ...(Array.isArray(extra) ? extra.map(String) : [])])];
}

function hasPermission(user, permission) {
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  return permissions.includes('*') || permissions.includes(permission);
}

function requirePermission(req, res, permission) {
  const user = authUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Authentication required.' });
    return null;
  }
  if (!hasPermission(user, permission)) {
    sendJson(res, 403, { error: 'You do not have access to this resource.' });
    return null;
  }
  return user;
}

function publicUser(user) {
  return {
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: user.permissions
  };
}

function parseUsers() {
  try {
    const users = JSON.parse(String(process.env.CONTROL_USERS_JSON || '[]'));
    return Array.isArray(users) ? users.map((user) => {
      const role = normalizeRole(user.role);
      return {
        email: String(user.email || '').trim().toLowerCase(),
        password: String(user.password || ''),
        name: String(user.name || user.email || '').trim(),
        role,
        permissions: permissionsForRole(role, user.permissions)
      };
    }).filter((user) => user.email && user.password) : [];
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
    role: user.role,
    permissions: user.permissions,
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

function issueKey(issue) {
  const value = String(issue || '');
  if (/^RAM \d+%$/.test(value)) return 'ram-high';
  if (/^CPU \d+%$/.test(value)) return 'cpu-high';
  if (/^Disk \d+% free$/.test(value)) return 'disk-low';
  if (value === 'Agent offline') return 'agent-offline';
  if (value === 'OBS offline') return 'obs-offline';
  if (value === 'OBS WebSocket unavailable') return 'obs-websocket-unavailable';
  if (value === 'OBS WebSocket not authenticated') return 'obs-websocket-auth';
  if (value === 'Shade storage unmounted') return 'shade-unmounted';
  return value.toLowerCase();
}

function activeHealthIncidents(agentId) {
  return state.incidents.filter((incident) => incident.agentId === agentId && incident.kind === 'health' && !incident.resolvedAt);
}

function incidentKey(incident) {
  return incident.conditionKey || issueKey(incident.message);
}

function currentConditions(agent, at = Date.now()) {
  const metrics = agent.metrics || {};
  const apps = metrics.productionApps || {};
  const existingKeys = new Set(activeHealthIncidents(agent.agentId).map(incidentKey));
  const age = at - Number(agent.lastSeen || 0);

  if (!agent.lastSeen) {
    const enrolled = agent.firstSeen ? at - Date.parse(agent.firstSeen) : OFFLINE_AFTER_MS + 1;
    if (enrolled <= OFFLINE_AFTER_MS) return [];
    return [{ key: 'agent-offline', health: 'offline', severity: 'critical', message: 'Agent offline' }];
  }
  if (age > OFFLINE_AFTER_MS) {
    return [{ key: 'agent-offline', health: 'offline', severity: 'critical', message: 'Agent offline' }];
  }

  const conditions = [];

  if (metrics.obsRunning === false) {
    conditions.push({ key: 'obs-offline', health: 'critical', severity: 'critical', message: 'OBS offline' });
  } else if (metrics.obsRunning) {
    if (metrics.obsWebSocketReachable === false) {
      conditions.push({ key: 'obs-websocket-unavailable', health: 'warning', severity: 'warning', message: 'OBS WebSocket unavailable' });
    } else if (metrics.obsWebSocketReachable && metrics.obsWebSocketAuthenticated === false) {
      conditions.push({ key: 'obs-websocket-auth', health: 'warning', severity: 'warning', message: 'OBS WebSocket not authenticated' });
    }
  }

  if (apps.shade?.running === true && apps.shade?.mounted === false) {
    conditions.push({ key: 'shade-unmounted', health: 'warning', severity: 'warning', message: 'Shade storage unmounted' });
  }

  const memoryPercent = metrics.memoryPressurePercent != null ? Number(metrics.memoryPressurePercent) : Number(metrics.memoryPercent);
  const memoryActive = existingKeys.has('ram-high');
  if (Number.isFinite(memoryPercent) && (memoryPercent >= 90 || (memoryActive && memoryPercent >= 85))) {
    conditions.push({ key: 'ram-high', health: 'warning', severity: 'warning', message: `RAM ${Math.round(memoryPercent)}%` });
  }

  const cpuPercent = Number(metrics.cpuPercent);
  const cpuActive = existingKeys.has('cpu-high');
  if (Number.isFinite(cpuPercent) && (cpuPercent >= 90 || (cpuActive && cpuPercent >= 85))) {
    conditions.push({ key: 'cpu-high', health: 'warning', severity: 'warning', message: `CPU ${Math.round(cpuPercent)}%` });
  }

  const diskFreePercent = Number(metrics.diskFreePercent);
  const diskActive = existingKeys.has('disk-low');
  if (metrics.diskFreePercent != null && Number.isFinite(diskFreePercent) && (diskFreePercent <= 10 || (diskActive && diskFreePercent <= 15))) {
    conditions.push({ key: 'disk-low', health: 'warning', severity: 'warning', message: `Disk ${Math.round(diskFreePercent)}% free` });
  }

  return conditions;
}

function healthFor(agent, at = Date.now()) {
  if (!agent.lastSeen) {
    const enrolled = agent.firstSeen ? at - Date.parse(agent.firstSeen) : OFFLINE_AFTER_MS + 1;
    if (enrolled <= OFFLINE_AFTER_MS) return { health: 'unmonitored', issue: 'Awaiting first heartbeat' };
  }

  const conditions = currentConditions(agent, at);
  if (!conditions.length) return { health: 'healthy', issue: '' };
  const primary = conditions.find((condition) => ['critical', 'offline'].includes(condition.health)) || conditions[0];
  return { health: primary.health, issue: primary.message };
}

async function sendSlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!response.ok) console.error(`Slack alert failed: HTTP ${response.status}`);
  } catch (err) {
    console.error('Slack alert failed:', err.message);
  }
}

function actionForCondition(key) {
  if (key === 'ram-high') return 'Please check the RAM.';
  if (key === 'cpu-high') return 'Please check the CPU.';
  if (key === 'disk-low') return 'Please check the storage.';
  if (key === 'shade-unmounted') return 'Please check Shade storage.';
  if (key.startsWith('obs-')) return 'Please check OBS.';
  if (key === 'agent-offline') return 'Please check the agent.';
  return 'Please check the room.';
}

function slackHealthMessage(agent, condition) {
  return `Room: ${agent.roomName}\nIssue: ${condition.message}\nAction: ${actionForCondition(condition.key)}`;
}

function slackResolvedMessage(agent, incident) {
  return `Room: ${agent.roomName}\nResolved: ${incident.message}`;
}

function addInfoEvent(agent, message, extra = {}) {
  const at = nowIso();
  state.incidents.unshift({
    id: crypto.randomUUID(),
    agentId: agent.agentId,
    roomId: agent.roomId,
    roomName: displayRoomName(agent),
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
  const at = nowIso();
  const current = currentConditions(agent);
  const currentByKey = new Map(current.map((condition) => [condition.key, condition]));
  const existing = activeHealthIncidents(agent.agentId);
  const existingByKey = new Map(existing.map((incident) => [incidentKey(incident), incident]));
  const agentOffline = currentByKey.has('agent-offline');
  let changed = false;

  for (const incident of existing) {
    const key = incidentKey(incident);
    if (currentByKey.has(key)) continue;

    // If the agent itself is offline we cannot verify whether its other
    // conditions actually cleared, so keep those incidents open and do not
    // send false resolution messages.
    if (agentOffline && key !== 'agent-offline') continue;

    incident.resolvedAt = at;
    incident.status = 'resolved';
    incident.resolution = 'Condition cleared';
    sendSlack(slackResolvedMessage(agent, incident));
    changed = true;
  }

  for (const condition of current) {
    const incident = existingByKey.get(condition.key);
    if (incident && !incident.resolvedAt) {
      if (incident.message !== condition.message) {
        incident.message = condition.message;
        incident.lastUpdatedAt = at;
        changed = true;
      }
      continue;
    }

    state.incidents.unshift({
      id: crypto.randomUUID(),
      agentId: agent.agentId,
      roomId: agent.roomId,
      roomName: displayRoomName(agent),
      kind: 'health',
      conditionKey: condition.key,
      health: condition.health,
      severity: condition.severity,
      message: condition.message,
      openedAt: at,
      resolvedAt: null,
      status: 'open'
    });
    sendSlack(slackHealthMessage(agent, condition));
    changed = true;
  }

  const next = healthFor(agent);
  if (agent.health !== next.health || agent.issue !== next.issue) {
    agent.health = next.health;
    agent.issue = next.issue;
    agent.healthChangedAt = at;
    changed = true;
  }

  return changed;
}

function maybeSample(agent) {
  const samples = state.samples[agent.agentId] || [];
  const last = samples[samples.length - 1];
  if (last && Date.now() - Date.parse(last.at) < SAMPLE_INTERVAL_MS) return;

  samples.push({
    at: nowIso(),
    cpuPercent: agent.metrics?.cpuPercent ?? null,
    memoryPercent: agent.metrics?.memoryPercent ?? null,
    memoryPressurePercent: agent.metrics?.memoryPressurePercent ?? null,
    memoryMetric: agent.metrics?.memoryMetric ?? null,
    diskFreePercent: agent.metrics?.diskFreePercent ?? null,
    obsRunning: agent.metrics?.obsRunning ?? null,
    obsWebSocketReachable: agent.metrics?.obsWebSocketReachable ?? null,
    streamingActive: agent.metrics?.streamingActive ?? null
  });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  state.samples[agent.agentId] = samples;
}

function canonicalRoomName(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  if (
    normalized === 'sandbox' ||
    normalized === 'sandbox agent' ||
    normalized === 'the sandbox'
  ) return 'SWISH WAX';

  if (
    normalized === 'swish wax' ||
    normalized === 'swish wax fn' ||
    normalized === 'swish wax agent'
  ) return 'SWISH HITS';

  return raw;
}

function displayRoomName(agent) {
  const configured = state.roomSettings?.[agent.roomId]?.displayName;
  return String(configured || canonicalRoomName(agent.roomName) || agent.roomId);
}

function mediaForRoom(roomId, limit = 12) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
  return state.media
    .filter((item) => item.roomId === roomId)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, safeLimit);
}

function businessForRoom(roomId) {
  const value = state.business?.[roomId];
  return value && typeof value === 'object' ? value : null;
}

function normalizeBusinessName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function resolveBusinessAgent(streamName, platform) {
  const p = normalizeBusinessName(platform);
  const n = normalizeBusinessName(streamName);

  const desiredRoomName = (() => {
    if (p === 'fanatics') {
      if (n === 'swish wax') return 'SWISH WAX';
      if (n === 'swish bats') return 'SWISH BATS';
      if (n === 'swish main' || n === 'swish breaks') return 'SWISH BREAKS FN';
    }

    if (p === 'whatnot') {
      if (n === 'swish breaks') return 'SWISH BREAKS WN';
      if (n === 'swish hits') return 'SWISH HITS';
      if (n === 'swish smash') return 'SWISH SMASH';
      if (n === 'pokeswish' || n === 'poke swish') return 'POKE SWISH';
    }

    if (p === 'tiktok') {
      if (n === 'tiktok main' || n === 'swish breaks') return 'SWISH BREAKS TT';
      if (n === 'tiktok poke' || n === 'pokeswish' || n === 'swish poke') return 'SWISH POKE TT';
      if (n === 'tiktok rips' || n === 'swish rips') return 'SWISH RIPS';
    }

    return '';
  })();

  if (!desiredRoomName) return null;
  const target = normalizeBusinessName(desiredRoomName);

  return Object.values(state.agents).find((agent) =>
    normalizeBusinessName(displayRoomName(agent)) === target
  ) || null;
}

function businessIngestAuthorized(req) {
  if (!BUSINESS_INGEST_KEY) return false;
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), BUSINESS_INGEST_KEY);
}

function storeBusinessSnapshot(agent, body = {}) {
  const numberOrNull = (value) =>
    value === null || value === undefined || value === ''
      ? null
      : (Number.isFinite(Number(value)) ? Number(value) : null);

  const next = {
    roomId: agent.roomId,
    roomName: displayRoomName(agent),
    updatedAt: nowIso(),
    source: String(body.source || 'SB-Live-Dashboard').slice(0, 80),
    sourceStreamName: String(body.streamName || body.sourceStreamName || '').slice(0, 120),
    platform: String(body.platform || '').slice(0, 40),
    live: typeof body.live === 'boolean' ? body.live : null,
    viewers: numberOrNull(body.viewers),
    peakViewers: numberOrNull(body.peakViewers),
    revenue: numberOrNull(body.revenue),
    orders: numberOrNull(body.orders),
    aov: numberOrNull(body.aov),
    currentBreak: String(body.currentBreak || '').slice(0, 240),
    streamTitle: String(body.streamTitle || '').slice(0, 240),
    windowStart: body.windowStart ? String(body.windowStart).slice(0, 80) : '',
    windowEnd: body.windowEnd ? String(body.windowEnd).slice(0, 80) : ''
  };

  state.business[agent.roomId] = next;
  schedulePersist();
  return next;
}

async function sendClipSlack(media) {
  if (!SLACK_CLIP_WEBHOOK_URL || media.kind !== 'clip') return;
  const shadeLine = media.shadeVerified
    ? 'Shade: Saved ✓'
    : media.shadeAttempted
      ? `Shade: Not confirmed ⚠`
      : 'Shade: Not attempted';
  const text = [
    `${media.roomName} — Clip Created`,
    media.fileName,
    `Local save: ${media.localSaved ? '✓' : '⚠'}`,
    shadeLine
  ].join('\n');
  try {
    const response = await fetch(SLACK_CLIP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!response.ok) console.error(`Slack clip alert failed: HTTP ${response.status}`);
  } catch (err) {
    console.error('Slack clip alert failed:', err.message);
  }
}

function wallRooms() {
  return Object.values(state.agents).map((agent) => {
    const current = healthFor(agent);
    const metrics = agent.metrics || {};
    const agentOnline = Boolean(agent.lastSeen) && Date.now() - Number(agent.lastSeen) <= OFFLINE_AFTER_MS;

    // Only publish a live/off-air decision when the room agent gives us a
    // trustworthy OBS state. If the agent or OBS WebSocket is unavailable,
    // leave the stream state unknown so the wall never hides a potentially
    // live provider page because of stale telemetry.
    let streamingActive = null;
    if (agentOnline && metrics.obsRunning === false) {
      streamingActive = false;
    } else if (
      agentOnline &&
      metrics.obsRunning === true &&
      metrics.obsWebSocketReachable === true &&
      metrics.obsWebSocketAuthenticated === true &&
      typeof metrics.streamingActive === 'boolean'
    ) {
      streamingActive = metrics.streamingActive;
    }

    return {
      roomId: agent.roomId,
      roomName: displayRoomName(agent),
      health: current.health,
      issue: current.issue,
      changedAt: agent.healthChangedAt || agent.lastSeenIso || null,
      agentOnline,
      streamingActive
    };
  }).sort((a, b) => a.roomName.localeCompare(b.roomName));
}

function controlRooms(user) {
  return Object.values(state.agents).map((agent) => {
    const current = healthFor(agent);
    const room = {
      agentId: agent.agentId,
      roomId: agent.roomId,
      roomName: displayRoomName(agent),
      hostname: agent.hostname,
      platform: agent.platform,
      appVersion: agent.appVersion,
      firstSeen: agent.firstSeen,
      lastSeen: agent.lastSeen,
      lastSeenIso: agent.lastSeenIso,
      health: current.health,
      issue: current.issue,
      healthChangedAt: agent.healthChangedAt || null,
      capabilities: agent.capabilities || []
    };

    if (hasPermission(user, 'technical:view')) room.metrics = agent.metrics || {};
    if (hasPermission(user, 'sales:view')) room.business = businessForRoom(agent.roomId);
    if (hasPermission(user, 'clips:view')) room.clips = mediaForRoom(agent.roomId, 8);

    return room;
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
  return sendJson(res, 200, { token, expiresInSeconds: SESSION_HOURS * 3600, user: publicUser(user) });
}

async function enroll(req, res) {
  if (!ENROLLMENT_KEY) return sendJson(res, 503, { error: 'Agent enrollment is not configured.' });
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7).trim(), ENROLLMENT_KEY)) return sendJson(res, 401, { error: 'Invalid enrollment key.' });

  const body = await readJson(req);
  const roomName = canonicalRoomName(body.roomName);
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

  agent.roomName = canonicalRoomName(body.roomName || agent.roomName);
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

async function ingestAgentMedia(req, res) {
  const agent = agentByToken(req);
  if (!agent) return sendJson(res, 401, { error: 'Invalid agent credentials.' });

  const body = await readJson(req, 256 * 1024);
  const kind = body.kind === 'vod' ? 'vod' : body.kind === 'clip' ? 'clip' : '';
  if (!kind) return sendJson(res, 400, { error: 'kind must be clip or vod.' });

  const fileName = path.basename(String(body.fileName || '').trim());
  if (!fileName) return sendJson(res, 400, { error: 'fileName is required.' });

  const id = String(body.eventId || crypto.randomUUID());
  const existing = state.media.find((item) => item.id === id);
  if (existing) return sendJson(res, 200, { ok: true, media: existing, duplicate: true });

  const media = {
    id,
    kind,
    agentId: agent.agentId,
    roomId: agent.roomId,
    roomName: displayRoomName(agent),
    fileName,
    createdAt: String(body.createdAt || nowIso()),
    sourceBytes: Number.isFinite(Number(body.sourceBytes)) ? Number(body.sourceBytes) : null,
    localSaved: body.localSaved !== false,
    shadeAttempted: Boolean(body.shadeAttempted),
    shadeVerified: Boolean(body.shadeVerified),
    shadePath: body.shadePath ? String(body.shadePath) : '',
    error: body.error ? String(body.error).slice(0, 500) : ''
  };

  state.media.unshift(media);
  if (state.media.length > 10000) state.media.length = 10000;
  schedulePersist();
  sendClipSlack(media);
  return sendJson(res, 201, { ok: true, media });
}

async function updateRoomSettings(req, res, roomId) {
  const user = requirePermission(req, res, 'settings:manage');
  if (!user) return;

  const agent = Object.values(state.agents).find((candidate) => candidate.roomId === roomId);
  if (!agent) return sendJson(res, 404, { error: 'Room not found.' });

  const body = await readJson(req, 64 * 1024);
  const displayName = String(body.displayName || '').trim().slice(0, 120);

  state.roomSettings[roomId] = {
    ...(state.roomSettings[roomId] || {}),
    displayName,
    updatedAt: nowIso(),
    updatedBy: user.email
  };
  schedulePersist();

  return sendJson(res, 200, {
    ok: true,
    roomId,
    roomName: displayRoomName(agent),
    settings: state.roomSettings[roomId]
  });
}

async function ingestBusiness(req, res, roomId) {
  if (!BUSINESS_INGEST_KEY) return sendJson(res, 503, { error: 'Business ingest is not configured.' });
  if (!businessIngestAuthorized(req)) return sendJson(res, 401, { error: 'Invalid business ingest key.' });

  const agent = Object.values(state.agents).find((candidate) => candidate.roomId === roomId);
  if (!agent) return sendJson(res, 404, { error: 'Room not found.' });

  const body = await readJson(req, 256 * 1024);
  const business = storeBusinessSnapshot(agent, body);
  return sendJson(res, 200, { ok: true, business });
}

async function ingestBusinessByChannel(req, res) {
  if (!BUSINESS_INGEST_KEY) return sendJson(res, 503, { error: 'Business ingest is not configured.' });
  if (!businessIngestAuthorized(req)) return sendJson(res, 401, { error: 'Invalid business ingest key.' });

  const body = await readJson(req, 256 * 1024);
  const streamName = String(body.streamName || '').trim();
  const platform = String(body.platform || '').trim().toLowerCase();
  if (!streamName || !platform) {
    return sendJson(res, 400, { error: 'streamName and platform are required.' });
  }

  const agent = resolveBusinessAgent(streamName, platform);
  if (!agent) {
    return sendJson(res, 404, {
      error: 'No monitored room is mapped to this business stream.',
      streamName,
      platform
    });
  }

  const business = storeBusinessSnapshot(agent, body);
  return sendJson(res, 200, {
    ok: true,
    roomId: agent.roomId,
    roomName: displayRoomName(agent),
    business
  });
}

async function removeAgent(req, res, agentId) {
  const user = requirePermission(req, res, 'settings:manage');
  if (!user) return;
  const agent = state.agents[agentId];
  if (!agent) return sendJson(res, 404, { error: 'Device not found.' });

  const body = await readJson(req).catch(() => ({}));
  const at = nowIso();
  for (const active of activeHealthIncidents(agentId)) {
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
    roomName: displayRoomName(agent),
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
    if (req.method === 'POST' && url.pathname === '/api/agent/media') return ingestAgentMedia(req, res);
    if (req.method === 'GET' && url.pathname === '/api/wall-status') return sendJson(res, 200, { rooms: wallRooms() });

    if (req.method === 'POST' && url.pathname.startsWith('/api/rooms/') && url.pathname.endsWith('/settings')) {
      const roomId = decodeURIComponent(url.pathname.split('/')[3] || '');
      return updateRoomSettings(req, res, roomId);
    }

    if (req.method === 'POST' && url.pathname === '/api/business/ingest') {
      return ingestBusinessByChannel(req, res);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/business/rooms/')) {
      const roomId = decodeURIComponent(url.pathname.slice('/api/business/rooms/'.length));
      return ingestBusiness(req, res, roomId);
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required.' });
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      const user = requirePermission(req, res, 'rooms:view');
      if (!user) return;
      return sendJson(res, 200, { rooms: controlRooms(user), user: publicUser(user) });
    }

    if (req.method === 'GET' && url.pathname === '/api/incidents') {
      const user = requirePermission(req, res, 'incidents:view');
      if (!user) return;
      return sendJson(res, 200, { incidents: state.incidents.slice(0, 5000) });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/') && url.pathname.endsWith('/media')) {
      const user = requirePermission(req, res, 'clips:view');
      if (!user) return;
      const roomId = decodeURIComponent(url.pathname.split('/')[3] || '');
      return sendJson(res, 200, { roomId, media: mediaForRoom(roomId, Number(url.searchParams.get('limit') || 50)) });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/') && url.pathname.endsWith('/business')) {
      const user = requirePermission(req, res, 'sales:view');
      if (!user) return;
      const roomId = decodeURIComponent(url.pathname.split('/')[3] || '');
      return sendJson(res, 200, { roomId, business: businessForRoom(roomId) });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/') && url.pathname.endsWith('/samples')) {
      const user = requirePermission(req, res, 'technical:view');
      if (!user) return;
      const roomId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const agent = Object.values(state.agents).find((candidate) => candidate.roomId === roomId);
      if (!agent) return sendJson(res, 404, { error: 'Room not found.' });
      return sendJson(res, 200, { roomId, samples: state.samples[agent.agentId] || [] });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/agents/')) {
      return removeAgent(req, res, decodeURIComponent(url.pathname.slice('/api/agents/'.length)));
    }

    if (req.method === 'POST' && url.pathname === '/api/commands') {
      const user = requirePermission(req, res, 'settings:manage');
      if (!user) return;
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
