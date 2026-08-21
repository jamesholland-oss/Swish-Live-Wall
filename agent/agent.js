const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');

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

async function obsRunning() {
  if (process.platform === 'win32') {
    const result = await execFilePromise('tasklist', ['/FI', 'IMAGENAME eq obs64.exe']);
    return result.ok && result.stdout.toLowerCase().includes('obs64.exe');
  }

  const exact = await execFilePromise('pgrep', ['-x', 'OBS']);
  if (exact.ok) return true;
  const bundle = await execFilePromise('pgrep', ['-f', '/OBS.app/']);
  return bundle.ok;
}

async function diskMetrics() {
  if (process.platform === 'win32') {
    return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };
  }

  const result = await execFilePromise('df', ['-Pk', '/']);
  if (!result.ok) return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };

  const lines = result.stdout.trim().split('\n');
  if (lines.length < 2) return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };

  const parts = lines[lines.length - 1].trim().split(/\s+/);
  const totalKb = Number(parts[1]);
  const availableKb = Number(parts[3]);
  if (!totalKb || Number.isNaN(availableKb)) {
    return { diskFreePercent: null, diskFreeGb: null, diskTotalGb: null };
  }

  return {
    diskFreePercent: Math.round((availableKb / totalKb) * 1000) / 10,
    diskFreeGb: Math.round((availableKb / 1024 / 1024) * 10) / 10,
    diskTotalGb: Math.round((totalKb / 1024 / 1024) * 10) / 10
  };
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
  if (!reachable) {
    return {
      obsWebSocketReachable: false,
      obsWebSocketAuthenticated: false,
      streamingActive: null,
      streamReconnecting: null
    };
  }

  if (typeof WebSocket === 'undefined') {
    return {
      obsWebSocketReachable: true,
      obsWebSocketAuthenticated: false,
      streamingActive: null,
      streamReconnecting: null
    };
  }

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
      resolve({
        obsWebSocketReachable: true,
        obsWebSocketAuthenticated: false,
        streamingActive: null,
        streamReconnecting: null,
        ...value
      });
    };

    const timer = setTimeout(() => finish({}), 2500);

    try {
      socket = new WebSocket(`ws://${host}:${Number(port)}`);
    } catch (_) {
      finish({ obsWebSocketReachable: false });
      return;
    }

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.op === 0) {
          const hello = message.d || {};
          const auth = hello.authentication;
          if (auth && !password) {
            finish({ obsWebSocketAuthenticated: false });
            return;
          }

          const identify = { op: 1, d: { rpcVersion: 1 } };
          if (auth) {
            identify.d.authentication = obsAuthentication(password, auth.challenge, auth.salt);
          }
          socket.send(JSON.stringify(identify));
          return;
        }

        if (message.op === 2) {
          identified = true;
          socket.send(JSON.stringify({
            op: 6,
            d: { requestType: 'GetStreamStatus', requestId, requestData: {} }
          }));
          return;
        }

        if (message.op === 7 && message.d?.requestId === requestId) {
          if (!message.d?.requestStatus?.result) {
            finish({ obsWebSocketAuthenticated: identified });
            return;
          }

          finish({
            obsWebSocketAuthenticated: identified,
            streamingActive: Boolean(message.d.responseData?.outputActive),
            streamReconnecting: Boolean(message.d.responseData?.outputReconnecting)
          });
        }
      } catch (_) {}
    });

    socket.addEventListener('error', () => finish({}));
    socket.addEventListener('close', () => {
      if (!finished) finish({ obsWebSocketAuthenticated: identified });
    });
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
  const sampleCpu = createCpuSampler();

  async function enroll() {
    if (credentials?.agentId && credentials?.token) return credentials;
    if (!serverUrl || !enrollmentKey) {
      throw new Error('Agent needs server URL and enrollment key for first registration.');
    }

    const response = await fetch(`${serverUrl}/api/agent/enroll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enrollmentKey}`
      },
      body: JSON.stringify({ roomName, hostname: os.hostname(), platform: `${process.platform}-${process.arch}` })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Enrollment failed (${response.status})`);

    credentials = {
      agentId: data.agentId,
      roomId: data.roomId,
      token: data.token,
      enrolledAt: new Date().toISOString()
    };
    writeJson(credentialsFile, credentials);
    enrollmentKey = '';
    if (typeof options.onEnrolled === 'function') options.onEnrolled(credentials);
    return credentials;
  }

  async function collectMetrics() {
    const totalMemory = os.totalmem();
    const usedMemory = totalMemory - os.freemem();
    const running = await obsRunning();
    const disk = await diskMetrics();

    let obs = {
      obsWebSocketReachable: false,
      obsWebSocketAuthenticated: false,
      streamingActive: null,
      streamReconnecting: null
    };

    if (running) {
      obs = await queryObsWebSocket({ host: obsHost, port: obsPort, password: obsPassword });
    }

    return {
      cpuPercent: sampleCpu(),
      memoryPercent: Math.round((usedMemory / totalMemory) * 1000) / 10,
      memoryUsedGb: Math.round((usedMemory / 1024 ** 3) * 10) / 10,
      memoryTotalGb: Math.round((totalMemory / 1024 ** 3) * 10) / 10,
      uptimeSeconds: Math.round(os.uptime()),
      localIp: primaryLocalIp(),
      obsRunning: running,
      ...obs,
      ...disk
    };
  }

  async function heartbeat() {
    if (stopped) return;

    try {
      const auth = await enroll();
      const response = await fetch(`${serverUrl}/api/agent/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.token}`
        },
        body: JSON.stringify({
          agentId: auth.agentId,
          roomId: auth.roomId,
          roomName,
          hostname: os.hostname(),
          platform: `${process.platform}-${process.arch}`,
          appVersion: '2.0.0-pilot',
          metrics: await collectMetrics(),
          capabilities: []
        })
      });

      if (response.status === 401) {
        credentials = null;
        try { fs.unlinkSync(credentialsFile); } catch (_) {}
        throw new Error('Agent credentials rejected; re-enrollment required.');
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Heartbeat failed (${response.status})`);
      }
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

  const shutdown = () => {
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startAgent };
