const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on http://localhost:${PORT}`));
