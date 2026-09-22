import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_RATE, type ClientMsg } from '../shared/protocol.ts';
import { Room } from './game.ts';

const PORT = Number(process.env.PORT ?? 47291);
const DIST = join(import.meta.dirname, '..', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const rooms = new Map<string, Room>();

function makeCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (!existsSync(DIST)) {
    res.writeHead(404).end('Client not built. In dev, open the Vite server instead (npm run dev).');
    return;
  }
  let path = normalize(join(DIST, url.pathname));
  if (!path.startsWith(DIST) || !existsSync(path) || url.pathname === '/') path = join(DIST, 'index.html');
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;
  let pid = 0;
  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!room) {
      if (msg.t === 'create') {
        const code = makeCode();
        room = new Room(code);
        rooms.set(code, room);
        pid = room.addPlayer(ws, msg.name)!.id;
        console.log(`room ${code} created`);
      } else if (msg.t === 'join') {
        const r = rooms.get(String(msg.code).toUpperCase().trim());
        if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'No room with that code.' }));
        const p = r.addPlayer(ws, msg.name);
        if (!p) return ws.send(JSON.stringify({ t: 'error', msg: 'That room is full (4 players max).' }));
        room = r;
        pid = p.id;
      }
      return;
    }
    const p = room.players.get(pid);
    if (p) room.handle(p, msg);
  });
  ws.on('close', () => {
    if (!room) return;
    room.removePlayer(pid);
    if (room.empty) {
      rooms.delete(room.code);
      console.log(`room ${room.code} closed`);
    }
  });
});

setInterval(() => {
  for (const r of rooms.values()) r.step();
}, 1000 / TICK_RATE);

http.listen(PORT, () => console.log(`Boneyard server on http://localhost:${PORT} (ws: /ws)`));
