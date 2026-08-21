const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SERVER_URL = (process.env.SWISH_CONTROL_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const ROOM_NAME = process.env.SWISH_ROOM_NAME || os.hostname();
const HEARTBEAT_MS = Number(process.env.SWISH_HEARTBEAT_MS || 5000);
const STATE_DIR = path.join(os.homedir(), '.swish-control');
const AGENT_FILE = path.join(STATE_DIR, 'agent-id');

function getAgentId() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    return fs.readFileSync(AGENT_FILE, 'utf8').trim();
  } catch (_) {
    const id = crypto.randomUUID();
    fs.writeFileSync(AGENT_FILE, id);
    return id;
  }
}

const agentId = getAgentId();
let previousCpu = os.cpus();

function cpuPercent() {
  const current = os.cpus();
  let idleDelta = 0;
  let totalDelta = 0;

  current.forEach((cpu, i) => {
    const previous = previousCpu[i];
    const currentTotal = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const previousTotal = Object.values(previous.times).reduce((a, b) => a + b, 0);
    idleDelta += cpu.times.idle - previous.times.idle;
    totalDelta += currentTotal - previousTotal;
  });

  previousCpu = current;
  if (!totalDelta) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

function obsRunning() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq obs64.exe'], (err, stdout = '') => {
        resolve(!err && stdout.toLowerCase().includes('obs64.exe'));
      });
      return;
    }

    execFile('pgrep', ['-x', 'OBS'], (err) => {
      if (!err) return resolve(true);
      execFile('pgrep', ['-f', '/OBS.app/'], (fallbackErr) => resolve(!fallbackErr));
    });
  });
}

async function metrics() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return {
    cpuPercent: cpuPercent(),
    memoryPercent: Math.round((used / total) * 1000) / 10,
    memoryUsedGb: Math.round((used / 1024 ** 3) * 10) / 10,
    memoryTotalGb: Math.round((total / 1024 ** 3) * 10) / 10,
    uptimeSeconds: Math.round(os.uptime()),
    obsRunning: await obsRunning()
  };
}

async function heartbeat() {
  try {
    const response = await fetch(`${SERVER_URL}/api/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId,
        roomName: ROOM_NAME,
        hostname: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        appVersion: '2.0.0-dev',
        metrics: await metrics()
      })
    });

    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    console.log(`[${new Date().toLocaleTimeString()}] heartbeat OK — ${ROOM_NAME}`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] heartbeat failed: ${err.message}`);
  }
}

console.log(`Swish Agent ${agentId}`);
console.log(`Room: ${ROOM_NAME}`);
console.log(`Server: ${SERVER_URL}`);
heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
