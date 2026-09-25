import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_RATE, type ClientMsg } from '../shared/protocol.ts';
import { Room, SEND_EVERY } from './room.ts';

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
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, tickRate: TICK_RATE, sendEvery: SEND_EVERY }));
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

const wss = new WebSocketServer({ server: http, path: '/ws', perMessageDeflate: false });
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws: WebSocket) => {
  ws.binaryType = 'nodebuffer';
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  let room: Room | null = null;
  let pid = 0;
  const fail = (msg: string, reason?: 'expired' | 'full' | 'missing') => ws.send(JSON.stringify({ t: 'error', msg, reason }));

  ws.on('message', (raw, isBinary) => {
    alive.set(ws, true);
    if (isBinary) {
      const p = room?.players.get(pid);
      if (p && p.net.ws === ws) room!.handleBinary(p, new Uint8Array(raw as Buffer));
      return;
    }
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
        pid = room.addPlayer(ws, msg.name, msg.char)!.id;
        console.log(`room ${code} created`);
      } else if (msg.t === 'join' || msg.t === 'rejoin') {
        const r = rooms.get(String(msg.code).toUpperCase().trim());
        if (!r) return fail('No room with that code.', 'missing');
        const p = msg.t === 'join' ? r.addPlayer(ws, msg.name, msg.char) : r.rejoin(ws, String(msg.token));
        if (!p) return msg.t === 'join' ? fail('That room is full (4 players max).', 'full') : fail('Your slot has expired.', 'expired');
        room = r;
        pid = p.id;
      }
      return;
    }
    const p = room.players.get(pid);
    if (p && p.net.ws === ws) room.handle(p, msg);
  });
  ws.on('close', () => room?.disconnect(pid, ws));
});

// Drop sockets that stop answering so their slot goes offline promptly instead of after a TCP timeout.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 2500);

const TICK_MS = 1000 / TICK_RATE;
let next = performance.now();
function loop() {
  const now = performance.now();
  if (now - next > 1000) next = now;
  while (now >= next) {
    next += TICK_MS;
    for (const [code, r] of rooms) {
      r.step();
      r.sendSnapshots();
      if (r.empty) {
        rooms.delete(code);
        console.log(`room ${code} closed`);
      }
    }
  }
  setTimeout(loop, Math.max(1, next - performance.now()));
}
loop();

http.listen(PORT, () => console.log(`Genesis server on http://localhost:${PORT} (ws: /ws, ${TICK_RATE} Hz sim, ${TICK_RATE / SEND_EVERY} Hz snapshots)`));
