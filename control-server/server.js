const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const rooms = new Map();
const clients = new Set();
const OFFLINE_AFTER_MS = 15000;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function healthFor(room) {
  const age = Date.now() - room.lastSeen;
  if (age > OFFLINE_AFTER_MS) return 'offline';
  if (room.metrics?.obsRunning === false) return 'critical';
  if ((room.metrics?.memoryPercent || 0) >= 90) return 'warning';
  if ((room.metrics?.cpuPercent || 0) >= 90) return 'warning';
  return 'healthy';
}

function serializeRooms() {
  return [...rooms.values()].map((room) => ({
    ...room,
    health: healthFor(room),
    ageMs: Date.now() - room.lastSeen
  })).sort((a, b) => a.roomName.localeCompare(b.roomName));
}

function broadcast() {
  const payload = `data: ${JSON.stringify({ type: 'rooms', rooms: serializeRooms() })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, rooms: rooms.size, time: Date.now() });
  }

  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    return sendJson(res, 200, { rooms: serializeRooms() });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'rooms', rooms: serializeRooms() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
    try {
      const payload = await readJson(req);
      if (!payload.agentId || !payload.roomName || !payload.metrics) {
        return sendJson(res, 400, { error: 'agentId, roomName, and metrics are required' });
      }

      const previous = rooms.get(payload.agentId);
      rooms.set(payload.agentId, {
        agentId: String(payload.agentId),
        roomName: String(payload.roomName),
        hostname: String(payload.hostname || ''),
        platform: String(payload.platform || ''),
        appVersion: String(payload.appVersion || ''),
        metrics: payload.metrics,
        lastSeen: Date.now(),
        firstSeen: previous?.firstSeen || Date.now()
      });

      broadcast();
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

setInterval(broadcast, 5000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Swish Control server listening on port ${PORT}`);
});
