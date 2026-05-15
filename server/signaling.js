const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const dgram = require('dgram');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

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
  if (n.includes('wlan') || n.includes('wi-fi') || n.includes('wifi')) {
    return 30;
  }
  if (n.includes('ethernet') || n.includes('\u4ee5\u592a\u7f51')) {
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
  const port = process.env.PORT || 3000;
  const addressEntries = getLanAddresses();
  const addresses = addressEntries.map((item) => item.address);
  const preferred = addressEntries.find((item) => item.isPrivate && item.score >= 0) || addressEntries[0] || null;

  res.json({
    port,
    addresses,
    preferredAddress: preferred ? preferred.address : null,
    preferredInterface: preferred ? preferred.interfaceName : null,
    url: preferred ? `http://${preferred.address}:${port}/` : `http://localhost:${port}/`,
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let nextClientId = 1;
const rooms = {}; // room -> Map(clientId -> ws)

wss.on('connection', (ws) => {
  ws.id = null;
  ws.room = null;

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    const { type } = data;

    if (type === 'join') {
      const { room } = data;
      ws.room = room;
      ws.id = (nextClientId++).toString();
      if (!rooms[room]) rooms[room] = new Map();

      const peers = Array.from(rooms[room].keys());
      rooms[room].set(ws.id, ws);

      ws.send(JSON.stringify({ type: 'joined', id: ws.id, peers }));

      // notify existing peers
      for (const [id, other] of rooms[room]) {
        if (id !== ws.id && other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'peer-joined', id: ws.id }));
        }
      }

    } else if (type === 'offer' || type === 'answer' || type === 'ice') {
      const to = data.to;
      const room = ws.room;
      if (!room || !rooms[room]) return;
      const target = rooms[room].get(to);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify(Object.assign({}, data, { from: ws.id })));
      }
    }
  });

  ws.on('close', () => {
    const { room, id } = ws;
    if (room && rooms[room]) {
      rooms[room].delete(id);
      for (const [otherId, other] of rooms[room]) {
        if (other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'peer-left', id }));
        }
      }
      if (rooms[room].size === 0) delete rooms[room];
    }
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
  console.warn('STUN socket error (non-fatal):', err.message);
});
stunSocket.bind(STUN_PORT, () => {
  console.log(`STUN server on UDP :${STUN_PORT}`);
});

// ── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on http://localhost:${PORT}`));
