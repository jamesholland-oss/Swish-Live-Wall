const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');

const AGENT_VERSION = '2.0.0-beta.14';
const MAX_DIAGNOSTIC_BYTES = 25 * 1024 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function normalizeServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function primaryLocalIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const score = /^en\d+$/.test(name) ? 0 : /^eth\d+$/.test(name) ? 1 : 2;
      candidates.push({ score, address: item.address });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.address || '';
}

function execFilePromise(command, args, timeout = 2500) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), error });
    });
  });
}

async function processSnapshot() {
  if (process.platform === 'win32') {
    const result = await execFilePromise('tasklist', ['/FO', 'CSV', '/NH']);
    return result.stdout.toLowerCase();
  }
  const result = await execFilePromise('ps', ['-axo', 'command=']);
  return result.stdout.toLowerCase();
}

function processHas(snapshot, names) {
  return names.some((name) => snapshot.includes(String(name).toLowerCase()));
}

async function obsRunning(snapshot = null) {
  const processes = snapshot ?? await processSnapshot();
  if (process.platform === 'win32') return processHas(processes, ['obs64.exe']);
  return processHas(processes, ['/obs.app/', 'obs.app/contents/macos/obs', '/contents/macos/obs']);
}

async function appVersion(paths) {
  if (process.platform !== 'darwin') return '';
  for (const appPath of paths) {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) continue;
    const result = await execFilePromise('/usr/bin/defaults', ['read', plist, 'CFBundleShortVersionString']);
    if (result.ok && result.stdout.trim()) return result.stdout.trim();
  }
  return '';
}

async function shadeMountStatus() {
  if (process.platform !== 'darwin') return { mounted: null, mountPath: '' };
  const mountResult = await execFilePromise('/sbin/mount', []);
  const matchingLine = mountResult.stdout.split('\n').find((line) => /shade/i.test(line));
  if (matchingLine) {
    const match = matchingLine.match(/ on (.+?) \(/);
    return { mounted: true, mountPath: match?.[1] || '' };
  }
  try {
    const volumes = fs.readdirSync('/Volumes', { withFileTypes: true });
    const shadeVolume = volumes.find((entry) => /shade/i.test(entry.name));
    if (shadeVolume) return { mounted: true, mountPath: path.join('/Volumes', shadeVolume.name) };
  } catch (_) {}
  return { mounted: false, mountPath: '' };
}

async function productionAppMetrics(snapshot, cachedVersions) {
  const obs = processHas(snapshot, ['/obs.app/', 'obs.app/contents/macos/obs', '/contents/macos/obs', 'obs64.exe']);
  const shade = processHas(snapshot, ['/shade.app/', 'shade.app/contents', '\\shade.exe', ' shade ']);
  const obsbot = processHas(snapshot, ['obsbot center', 'obsbot_center', '/obsbot']);
  const insta360 = processHas(snapshot, ['insta360 link controller', 'insta360 link', '/insta360']);
  const streamDeck = processHas(snapshot, ['stream deck', 'streamdeck']);
  const mount = await shadeMountStatus();
  return {
    checkedAt: new Date().toISOString(),
    obs: { running: obs, version: cachedVersions.obs || '' },
    shade: { running: shade, mounted: mount.mounted, mountPath: mount.mountPath, version: cachedVersions.shade || '' },
    cameraControl: {
      running: obsbot || insta360,
      app: obsbot ? 'OBSBOT Center' : insta360 ? 'Insta360 Link Controller' : '',
      version: obsbot ? (cachedVersions.obsbot || '') : insta360 ? (cachedVersions.insta360 || '') : ''
    },
    streamDeck: { running: streamDeck, version: cachedVersions.streamDeck || '' }
  };
}

async function diskMetrics() {
  if (process.platform === 'win32') return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };
  const result = await execFilePromise('df', ['-Pk', '/']);
  if (!result.ok) return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };
  const lines = result.stdout.trim().split('\n');
  if (lines.length < 2) return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };
  const parts = lines[lines.length - 1].trim().split(/\s+/);
  const totalKb = Number(parts[1]);
  const availableKb = Number(parts[3]);
  if (!totalKb || Number.isNaN(availableKb)) return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };
  return {
    diskFreePercent: Math.round((availableKb / totalKb) * 1000) / 10,
    diskFreeGb: Math.round((availableKb / 1024 / 1024) * 10) / 10,
    diskTotalGb: Math.round((totalKb / 1024 / 1024) * 10) / 10
  };
}

async function memoryMetrics() {
  const totalMemory = os.totalmem();
  const rawUsedMemory = totalMemory - os.freemem();
  const rawPercent = Math.round((rawUsedMemory / totalMemory) * 1000) / 10;
  const base = {
    memoryPercent: rawPercent,
    memoryPressurePercent: null,
    memoryRawUsedPercent: rawPercent,
    memoryMetric: 'used',
    memoryUsedGb: Math.round((rawUsedMemory / 1024 ** 3) * 10) / 10,
    memoryTotalGb: Math.round((totalMemory / 1024 ** 3) * 10) / 10
  };
  if (process.platform !== 'darwin') return base;
  const result = await execFilePromise('/usr/bin/memory_pressure', ['-Q'], 3000);
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/System-wide memory free percentage:\s*([0-9.]+)%/i);
  if (!match) return base;
  const freePercent = Number(match[1]);
  if (!Number.isFinite(freePercent)) return base;
  const pressurePercent = Math.max(0, Math.min(100, Math.round((100 - freePercent) * 10) / 10));
  return { ...base, memoryPercent: pressurePercent, memoryPressurePercent: pressurePercent, memoryMetric: 'pressure' };
}

function tcpReachable(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function obsAuthentication(password, challenge, salt) {
  const secret = crypto.createHash('sha256').update(`${password}${salt}`).digest('base64');
  return crypto.createHash('sha256').update(`${secret}${challenge}`).digest('base64');
}

async function queryObsWebSocket({ host, port, password }) {
  const reachable = await tcpReachable(host, port);
  if (!reachable) return { obsWebSocketReachable: false, obsWebSocketAuthenticated: false, streamingActive: null, streamReconnecting: null };
  if (typeof WebSocket === 'undefined') return { obsWebSocketReachable: true, obsWebSocketAuthenticated: false, streamingActive: null, streamReconnecting: null };
  return new Promise((resolve) => {
    let socket;
    let finished = false;
    let identified = false;
    const requestId = crypto.randomUUID();
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.close(); } catch (_) {}
      resolve({ obsWebSocketReachable: true, obsWebSocketAuthenticated: false, streamingActive: null, streamReconnecting: null, ...value });
    };
    const timer = setTimeout(() => finish({}), 2500);
    try { socket = new WebSocket(`ws://${host}:${Number(port)}`); }
    catch (_) { finish({ obsWebSocketReachable: false }); return; }
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.op === 0) {
          const hello = message.d || {};
          const auth = hello.authentication;
          if (auth && !password) { finish({ obsWebSocketAuthenticated: false }); return; }
          const identify = { op: 1, d: { rpcVersion: 1 } };
          if (auth) identify.d.authentication = obsAuthentication(password, auth.challenge, auth.salt);
          socket.send(JSON.stringify(identify));
          return;
        }
        if (message.op === 2) {
          identified = true;
          socket.send(JSON.stringify({ op: 6, d: { requestType: 'GetStreamStatus', requestId, requestData: {} } }));
          return;
        }
        if (message.op === 7 && message.d?.requestId === requestId) {
          if (!message.d?.requestStatus?.result) { finish({ obsWebSocketAuthenticated: identified }); return; }
          finish({ obsWebSocketAuthenticated: identified, streamingActive: Boolean(message.d.responseData?.outputActive), streamReconnecting: Boolean(message.d.responseData?.outputReconnecting) });
        }
      } catch (_) {}
    });
    socket.addEventListener('error', () => finish({}));
    socket.addEventListener('close', () => { if (!finished) finish({ obsWebSocketAuthenticated: identified }); });
  });
}

function createCpuSampler() {
  let previous = os.cpus();
  return () => {
    const current = os.cpus();
    let idleDelta = 0;
    let totalDelta = 0;
    current.forEach((cpu, index) => {
      const old = previous[index] || cpu;
      const currentTotal = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const previousTotal = Object.values(old.times).reduce((a, b) => a + b, 0);
      idleDelta += cpu.times.idle - old.times.idle;
      totalDelta += currentTotal - previousTotal;
    });
    previous = current;
    if (!totalDelta) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
  };
}

function diagnosticRoots() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      ['obs-logs', path.join(home, 'Library', 'Application Support', 'obs-studio', 'logs')],
      ['obs-crashes', path.join(home, 'Library', 'Application Support', 'obs-studio', 'crashes')],
      ['diagnostic-reports', path.join(home, 'Library', 'Logs', 'DiagnosticReports')],
      ['stream-deck-logs', path.join(home, 'Library', 'Logs', 'ElgatoStreamDeck')],
      ['obsbot-logs', path.join(home, 'Library', 'Logs', 'OBSBOT Center')]
    ];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      ['obs-logs', path.join(appData, 'obs-studio', 'logs')],
      ['obs-crashes', path.join(appData, 'obs-studio', 'crashes')],
      ['stream-deck-logs', path.join(appData, 'Elgato', 'StreamDeck', 'logs')],
      ['obsbot-logs', path.join(localAppData, 'OBSBOT Center', 'logs')]
    ];
  }
  return [];
}

function copyRecentDiagnostics(source, target, cutoffMs, budget) {
  if (!fs.existsSync(source) || budget.bytes >= MAX_DIAGNOSTIC_BYTES) return;
  let entries = [];
  try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (budget.bytes >= MAX_DIAGNOSTIC_BYTES) break;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) { copyRecentDiagnostics(sourcePath, targetPath, cutoffMs, budget); continue; }
    if (!entry.isFile()) continue;
    let stat;
    try { stat = fs.statSync(sourcePath); } catch (_) { continue; }
    if (stat.mtimeMs < cutoffMs || stat.size <= 0 || stat.size > 8 * 1024 * 1024 || budget.bytes + stat.size > MAX_DIAGNOSTIC_BYTES) continue;
    try {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(sourcePath, targetPath);
      budget.bytes += stat.size;
      budget.files += 1;
    } catch (_) {}
  }
}

async function buildDiagnosticsBundle(stateDir, hours = 24) {
  const safeHours = Math.max(1, Math.min(168, Number(hours) || 24));
  const diagnosticsDir = path.join(stateDir, 'diagnostics');
  ensureDir(diagnosticsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workDir = path.join(diagnosticsDir, `swish-diagnostics-${stamp}`);
  const archivePath = `${workDir}.zip`;
  const cutoffMs = Date.now() - safeHours * 3600000;
  const budget = { bytes: 0, files: 0 };
  ensureDir(workDir);
  for (const [label, root] of diagnosticRoots()) copyRecentDiagnostics(root, path.join(workDir, label), cutoffMs, budget);
  fs.writeFileSync(path.join(workDir, 'README.txt'), [
    'Swish Control diagnostics bundle',
    `Generated: ${new Date().toISOString()}`,
    `Hostname: ${os.hostname()}`,
    `Platform: ${process.platform}-${process.arch}`,
    `Window: last ${safeHours} hour(s)`,
    `Files: ${budget.files}`,
    '',
    'This bundle is limited to predefined production-app log/crash locations.',
    'Agent credentials, browser data, personal documents and arbitrary files are excluded.'
  ].join('\n'));
  let zipped = false;
  if (process.platform === 'darwin') {
    const result = await execFilePromise('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', workDir, archivePath], 30000);
    zipped = result.ok && fs.existsSync(archivePath);
  } else if (process.platform === 'win32') {
    const escapedSource = workDir.replace(/'/g, "''");
    const escapedTarget = archivePath.replace(/'/g, "''");
    const command = `Compress-Archive -Path '${escapedSource}\\*' -DestinationPath '${escapedTarget}' -Force`;
    const result = await execFilePromise('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], 30000);
    zipped = result.ok && fs.existsSync(archivePath);
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  if (!zipped) throw new Error('Unable to create diagnostics archive.');
  return { archivePath, files: budget.files, bytes: budget.bytes, hours: safeHours };
}

function startAgent(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl || process.env.SWISH_CONTROL_URL);
  const roomName = String(options.roomName || process.env.SWISH_ROOM_NAME || os.hostname()).trim();
  const stateDir = options.stateDir || path.join(os.homedir(), '.swish-control');
  const credentialsFile = path.join(stateDir, 'agent-credentials.json');
  const heartbeatMs = Math.max(5000, Number(options.heartbeatMs || process.env.SWISH_HEARTBEAT_MS || 10000));
  const obsHost = String(options.obsWebSocketHost || '127.0.0.1');
  const obsPort = Number(options.obsWebSocketPort || 4455);
  const obsPassword = String(options.obsWebSocketPassword || '');
  let enrollmentKey = String(options.enrollmentKey || process.env.SWISH_AGENT_ENROLLMENT_KEY || '');
  let credentials = readJson(credentialsFile, null);
  let stopped = false;
  let timer = null;
  let versionCacheAt = 0;
  let versionCache = { obs: '', shade: '', obsbot: '', insta360: '', streamDeck: '' };
  const sampleCpu = createCpuSampler();

  async function refreshVersions() {
    if (Date.now() - versionCacheAt < 15 * 60 * 1000) return versionCache;
    versionCacheAt = Date.now();
    versionCache = {
      obs: await appVersion(['/Applications/OBS.app']),
      shade: await appVersion(['/Applications/Shade.app']),
      obsbot: await appVersion(['/Applications/OBSBOT Center.app', '/Applications/OBSBOT_Center.app']),
      insta360: await appVersion(['/Applications/Insta360 Link Controller.app', '/Applications/Insta360 Link Controller 2.app']),
      streamDeck: await appVersion(['/Applications/Stream Deck.app'])
    };
    return versionCache;
  }

  async function enroll() {
    if (credentials?.agentId && credentials?.token) return credentials;
    if (!serverUrl || !enrollmentKey) throw new Error('Agent needs server URL and enrollment key for first registration.');
    const response = await fetch(`${serverUrl}/api/agent/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${enrollmentKey}` },
      body: JSON.stringify({ roomName, hostname: os.hostname(), platform: `${process.platform}-${process.arch}` })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Enrollment failed (${response.status})`);
    credentials = { agentId: data.agentId, roomId: data.roomId, token: data.token, enrolledAt: new Date().toISOString() };
    writeJson(credentialsFile, credentials);
    enrollmentKey = '';
    if (typeof options.onEnrolled === 'function') options.onEnrolled(credentials);
    return credentials;
  }

  async function collectMetrics() {
    const processes = await processSnapshot();
    const running = await obsRunning(processes);
    const disk = await diskMetrics();
    const memory = await memoryMetrics();
    const versions = await refreshVersions();
    const productionApps = await productionAppMetrics(processes, versions);
    let obs = { obsWebSocketReachable: false, obsWebSocketAuthenticated: false, streamingActive: null, streamReconnecting: null };
    if (running) obs = await queryObsWebSocket({ host: obsHost, port: obsPort, password: obsPassword });
    productionApps.obs.running = running;
    return { cpuPercent: sampleCpu(), ...memory, uptimeSeconds: Math.round(os.uptime()), localIp: primaryLocalIp(), obsRunning: running, productionApps, ...obs, ...disk };
  }

  async function handleCommands(commands, auth) {
    if (!Array.isArray(commands) || !commands.length) return;
    for (const command of commands.slice(0, 3)) {
      if (command?.type !== 'collect-diagnostics' || !command.id) continue;
      let bundle;
      try {
        bundle = await buildDiagnosticsBundle(stateDir, command.hours || 24);
        const body = fs.readFileSync(bundle.archivePath);
        const response = await fetch(`${serverUrl}/api/agent/diagnostics/${encodeURIComponent(command.id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/zip', 'x-swish-file-name': path.basename(bundle.archivePath), authorization: `Bearer ${auth.token}` },
          body
        });
        if (!response.ok && response.status !== 404) console.error(`[Swish Agent] Diagnostics upload failed (${response.status})`);
      } catch (err) {
        console.error(`[Swish Agent] Diagnostics collection failed: ${err.message}`);
      } finally {
        if (bundle?.archivePath) { try { fs.unlinkSync(bundle.archivePath); } catch (_) {} }
      }
    }
  }

  async function heartbeat() {
    if (stopped) return;
    try {
      const auth = await enroll();
      const response = await fetch(`${serverUrl}/api/agent/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({
          agentId: auth.agentId,
          roomId: auth.roomId,
          roomName,
          hostname: os.hostname(),
          platform: `${process.platform}-${process.arch}`,
          appVersion: AGENT_VERSION,
          metrics: await collectMetrics(),
          capabilities: ['production-app-health', 'shade-mount-health', 'mac-memory-pressure', 'diagnostics-bundle-v1']
        })
      });
      if (response.status === 401) {
        credentials = null;
        try { fs.unlinkSync(credentialsFile); } catch (_) {}
        throw new Error('Agent credentials rejected; re-enrollment required.');
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Heartbeat failed (${response.status})`);
      await handleCommands(data.commands, auth);
    } catch (err) {
      console.error(`[Swish Agent] ${err.message}`);
    } finally {
      if (!stopped) timer = setTimeout(heartbeat, heartbeatMs);
    }
  }

  ensureDir(stateDir);
  heartbeat();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

if (require.main === module) {
  const stop = startAgent({
    serverUrl: process.env.SWISH_CONTROL_URL,
    roomName: process.env.SWISH_ROOM_NAME,
    enrollmentKey: process.env.SWISH_AGENT_ENROLLMENT_KEY,
    obsWebSocketHost: process.env.SWISH_OBS_HOST,
    obsWebSocketPort: process.env.SWISH_OBS_PORT,
    obsWebSocketPassword: process.env.SWISH_OBS_PASSWORD
  });
  const shutdown = () => { stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startAgent, buildDiagnosticsBundle };
