const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');

// ── Logger ──────────────────────────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // debug|info|warn|error
const levels = { debug: 0, info: 1, warn: 2, error: 3 };
function log(level, ...args) {
  if (levels[level] < levels[LOG_LEVEL]) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const prefix = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level] || 'LOG';
  console.log(`[${ts}] [${prefix}]`, ...args);
}
function getClientIp(ws) {
  try { return ws._socket?.remoteAddress || '?'; } catch (_) { return '?'; }
}

const app = express();

// HTTP request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log('info', `${req.method} ${req.path} → ${res.statusCode} ${Date.now()-start}ms (${req.ip})`);
  });
  next();
});

// Disable caching for JS/HTML — browsers (especially iOS Edge) aggressively
// cache old code, causing confusing bugs after updates.
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.html') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'client'), {
  etag: false,
  lastModified: false,
}));

// Caddy handles HTTPS; backend runs plain HTTP when behind reverse proxy
let httpsEnabled = false;
let server;
if (!process.env.REVERSE_PROXY) {
  try {
    const cert = fs.readFileSync(path.join(__dirname, 'cert.pem'));
    const key = fs.readFileSync(path.join(__dirname, 'key.pem'));
    server = https.createServer({ cert, key }, app);
    httpsEnabled = true;
  } catch (_) {
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

function isPrivateIPv4(ip) {
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  const match = ip.match(/^172\.(\d+)\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function scoreInterface(name) {
  const n = String(name || '').toLowerCase();

  // strongly de-prioritize common virtual/tunnel adapters
  if (n.includes('zerotier') || n.includes('tailscale') || n.includes('vmware') || n.includes('virtual') || n.includes('vbox') || n.includes('docker') || n.includes('hyper-v')) {
    return -100;
  }

  // prioritize real NICs
  if (n.includes('wlan') || n.includes('wi-fi') || n.includes('wifi') || n.startsWith('wlx')) {
    return 30;
  }
  if (n.includes('ethernet') || n.includes('以太网')) {
    return 20;
  }

  return 0;
}

function getLanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();

  for (const [name, interfaceEntries] of Object.entries(interfaces)) {
    for (const entry of interfaceEntries || []) {
      if (entry && entry.family === 'IPv4' && !entry.internal) {
        const isPrivate = isPrivateIPv4(entry.address);
        addresses.push({
          address: entry.address,
          interfaceName: name,
          isPrivate,
          score: scoreInterface(name) + (isPrivate ? 10 : 0),
        });
      }
    }
  }

  addresses.sort((a, b) => b.score - a.score);
  return addresses;
}

app.get('/api/access-url', (req, res) => {
  const port = parseInt(process.env.PORT || '3000', 10);
  const addressEntries = getLanAddresses();
  const addresses = addressEntries.map((item) => item.address);
  const preferred = addressEntries.find((item) => item.isPrivate && item.score >= 0) || addressEntries[0] || null;
  const proto = httpsEnabled ? 'https' : 'http';
  const host = preferred ? preferred.address : 'localhost';
  const showPort = !((httpsEnabled && port === 443) || (!httpsEnabled && port === 80));

  res.json({
    port,
    addresses,
    preferredAddress: preferred ? preferred.address : null,
    preferredInterface: preferred ? preferred.interfaceName : null,
    url: `${proto}://${host}${showPort ? ':' + port : ''}/`,
  });
});

app.get('/api/rooms', (req, res) => {
  const result = {};
  for (const [roomName, clientMap] of Object.entries(rooms)) {
    const clients = [];
    for (const [id, clientWs] of clientMap) {
      clients.push({ id, role: clientWs.role || 'host' });
    }
    result[roomName] = { clients };
  }
  res.json({ rooms: result });
});

const wss = new WebSocket.Server({ server });

let nextClientId = 1;
const rooms = {};       // room -> Map(clientId -> ws)
const roomReactions = {}; // room -> { emoji: count }

// Track connection count for monitoring
let totalConnections = 0;
let activeConnections = 0;

wss.on('connection', (ws, req) => {
  const clientIp = req?.socket?.remoteAddress || 'unknown';
  const ua = req?.headers?.['user-agent'] || 'unknown';
  totalConnections++;
  activeConnections++;
  log('info', `WS connect  #${totalConnections} active=${activeConnections} ip=${clientIp} ua=${ua.slice(0,80)}`);

  ws.id = null;
  ws.room = null;

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) {
      log('warn', `Invalid JSON from ${ws.id||'?'}: ${message.toString().slice(0,100)}`);
      return;
    }
    const { type } = data;

    if (type === 'join') {
      const room = (data.room || '').trim();
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: '电台名称不能为空' })); return; }
      const role = data.role || 'host';

      // Assign ID if first join
      if (!ws.id) ws.id = (nextClientId++).toString();

      log('info', `[room:${room}] JOIN client=${ws.id} role=${role} ip=${clientIp}`);

      // Remove any previous entry for this WebSocket (prevents self-downgrade on re-join or reconnect)
      if (ws.room && rooms[ws.room] && rooms[ws.room].has(ws.id)) {
        log('debug', `[room:${ws.room}] Removing stale entry for ${ws.id}`);
        rooms[ws.room].delete(ws.id);
        if (rooms[ws.room].size === 0) { delete rooms[ws.room]; delete roomReactions[ws.room]; }
      }

      ws.room = room;
      if (!rooms[room]) { rooms[room] = new Map(); roomReactions[room] = { '😭': 0, '👍': 0, '❤️': 0, '🥰': 0, '🥳': 0 }; }

      // Enforce single host per room: downgrade to listener if a host already exists.
      // Clean up stale hosts whose WebSocket is no longer open (e.g. page refresh).
      let yourRole = role;
      for (const [pid, pws] of rooms[room]) {
        if (pws.role !== 'host') continue;
        if (pws.readyState !== WebSocket.OPEN) {
          log('warn', `[room:${room}] Removing stale host ${pid} (dead connection)`);
          rooms[room].delete(pid);
        } else if (yourRole === 'host') {
          yourRole = 'listener';
          log('info', `[room:${room}] Downgrading ${ws.id} host→listener (host ${pid} exists)`);
        }
      }
      ws.role = yourRole;

      // build roles snapshot for the joining client
      const roles = {};
      for (const [pid, pws] of rooms[room]) {
        roles[pid] = pws.role || 'host';
      }
      const peers = Array.from(rooms[room].keys());
      rooms[room].set(ws.id, ws);

      log('info', `[room:${room}] Joined as ${yourRole}, peers=[${peers.join(',')}]`);

      ws.send(JSON.stringify({ type: 'joined', id: ws.id, peers, roles, yourRole, reactionCounts: roomReactions[room] }));

      // notify existing peers
      for (const [id, other] of rooms[room]) {
        if (id !== ws.id && other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'peer-joined', id: ws.id, role: ws.role || 'host' }));
          log('debug', `[room:${room}] Notified peer ${id} about new peer ${ws.id}`);
        }
      }

    } else if (type === 'leave') {
      log('info', `[room:${ws.room||'?'}] LEAVE client=${ws.id}`);
      // Client is navigating away — clean up immediately so a refresh
      // doesn't race with the TCP close event.
      if (ws.room && rooms[ws.room]) {
        rooms[ws.room].delete(ws.id);
        for (const [, other] of rooms[ws.room]) {
          if (other.readyState === WebSocket.OPEN) {
            other.send(JSON.stringify({ type: 'peer-left', id: ws.id }));
          }
        }
        const remaining = rooms[ws.room].size;
        if (remaining === 0) {
          log('info', `[room:${ws.room}] Room empty, deleting`);
          delete rooms[ws.room]; delete roomReactions[ws.room];
        } else {
          log('debug', `[room:${ws.room}] ${remaining} peers remaining after leave`);
        }
      }
      ws.room = null; ws.id = null;

    } else if (type === 'firework') {
      const room = ws.room;
      if (!room || !rooms[room]) return;
      log('debug', `[room:${room}] FIREWORK from ${ws.id}`);
      for (const [, other] of rooms[room]) {
        if (other !== ws && other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'firework', from: ws.id }));
        }
      }

    } else if (type === 'reaction') {
      const room = ws.room;
      if (!room || !rooms[room]) return;
      // Increment server-side count
      const counts = roomReactions[room];
      if (counts && counts[data.emoji] !== undefined) {
        counts[data.emoji]++;
      }
      // Broadcast to everyone (including sender) with cumulative count
      for (const [, other] of rooms[room]) {
        if (other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'reaction', emoji: data.emoji, from: ws.id, count: counts[data.emoji] }));
        }
      }

    } else if (type === 'offer' || type === 'answer' || type === 'ice') {
      const to = data.to;
      const room = ws.room;
      if (!room || !rooms[room]) return;
      const target = rooms[room].get(to);
      if (target && target.readyState === WebSocket.OPEN) {
        const sdpInfo = data.sdp ? ` (sdp=${data.sdp.sdp?.slice(0,60)}...)` : '';
        log('debug', `[room:${room}] RELAY ${type} from=${ws.id} to=${to}${sdpInfo}`);
        target.send(JSON.stringify(Object.assign({}, data, { from: ws.id })));
      } else {
        log('warn', `[room:${room}] ${type} from=${ws.id} to=${to} target not found or closed`);
      }
    } else {
      log('debug', `[?] Unknown message type from ${ws.id||'?'}: ${type}`);
    }
  });

  ws.on('close', (code, reason) => {
    const { room, id } = ws;
    activeConnections--;
    const closeReason = reason?.toString() || 'none';
    log('info', `WS close client=${id||'?'} room=${room||'?'} code=${code} reason="${closeReason}" active=${activeConnections}`);
    if (room && rooms[room] && rooms[room].has(id)) {
      rooms[room].delete(id);
      for (const [otherId, other] of rooms[room]) {
        if (other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'peer-left', id }));
        }
      }
      if (rooms[room].size === 0) {
        log('info', `[room:${room}] Room empty after close, deleting`);
        delete rooms[room]; delete roomReactions[room];
      }
    }
  });

  ws.on('error', (err) => {
    log('error', `WS error client=${ws.id||'?'} ip=${clientIp}: ${err.message}`);
  });
});

// ── Embedded STUN server ─────────────────────────────────────────────
// Answers Binding Requests on UDP so that clients behind the same campus
// router can discover their RFC 1918 address.  No external dependency.
const STUN_MAGIC = 0x2112A442;
const BINDING_REQUEST  = 0x0001;
const BINDING_RESPONSE = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

function buildStunResponse(req, rinfo) {
  if (req.length < 20) return null;
  if (req.readUInt16BE(0) !== BINDING_REQUEST) return null;
  if (req.readUInt32BE(4) !== STUN_MAGIC) return null;

  const tid = req.slice(8, 20); // transaction id
  const ip = rinfo.address.split('.').map(Number);

  // XOR-MAPPED-ADDRESS: family=IPv4, x-port, x-ip
  const xPort   = rinfo.port ^ (STUN_MAGIC >>> 16);
  const attrLen = 8;                         // 4 + family(1) + port(2) + ip(4)
  const msgLen  = 4 + attrLen;
  const buf = Buffer.alloc(20 + 4 + attrLen);

  buf.writeUInt16BE(BINDING_RESPONSE, 0);
  buf.writeUInt16BE(msgLen, 2);
  buf.writeUInt32BE(STUN_MAGIC, 4);
  tid.copy(buf, 8);

  let off = 20;
  buf.writeUInt16BE(XOR_MAPPED_ADDRESS, off); off += 2;
  buf.writeUInt16BE(attrLen, off);            off += 2;
  buf[off++] = 0;                             // reserved
  buf[off++] = 0x01;                          // IPv4
  buf.writeUInt16BE(xPort, off);              off += 2;
  for (let i = 0; i < 4; i++) {
    buf[off++] = ip[i] ^ ((STUN_MAGIC >> ((3 - i) * 8)) & 0xFF);
  }

  return buf;
}

const STUN_PORT = process.env.STUN_PORT || 3478;
const stunSocket = dgram.createSocket('udp4');
stunSocket.on('message', (msg, rinfo) => {
  const res = buildStunResponse(msg, rinfo);
  if (res) stunSocket.send(res, rinfo.port, rinfo.address);
});
stunSocket.on('error', (err) => {
  log('warn', `STUN socket error (non-fatal): ${err.message}`);
});
stunSocket.bind(STUN_PORT, () => {
  log('info', `STUN server on UDP :${STUN_PORT}`);
});

// ── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log('info', `Server start on ${httpsEnabled ? 'https' : 'http'}://localhost:${PORT}`);
  log('info', `Log level: ${LOG_LEVEL}`);
  log('info', `Node ${process.version}, ${os.hostname()}, ${os.platform()} ${os.release()}`);
});
