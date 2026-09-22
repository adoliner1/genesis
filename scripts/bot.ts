// Headless smoke test: two bots join a room, wander and shoot at the nearest enemy over the binary protocol.
// Also reports per-client downstream bandwidth and how much the delta codec saves versus full snapshots.
import WebSocket from 'ws';
import type { ServerMsg } from '../shared/protocol.ts';
import { E, MSG_SNAP, P, decodeSnapshot, dpos, encodeInputs, type World } from '../shared/net/snapshot.ts';
import { BTN_A, BTN_A_PRESS, BTN_B_PRESS, BTN_MOVE, BTN_MOVE_PRESS, quantizeInput, type PlayerInput } from '../shared/sim/input.ts';

const URL = process.env.WS ?? 'ws://localhost:47291/ws';
const SECONDS = Number(process.env.SECONDS ?? 20);

interface Stats {
  snaps: number;
  floors: number;
  bytes: number;
  fullBytes: number;
  misses: number;
  events: Record<string, number>;
}

function bot(name: string, char: 'archer' | 'knight', code?: string): Promise<{ code: string; stats: Stats }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    let id = 0;
    let room = '';
    let seq = 0;
    let last: World | null = null;
    let lastEvent = 0;
    const worlds = new Map<number, World>();
    const recent: PlayerInput[] = [];
    const stats: Stats = { snaps: 0, floors: 0, bytes: 0, fullBytes: 0, misses: 0, events: {} };
    ws.on('open', () => ws.send(JSON.stringify(code ? { t: 'join', code, name, char } : { t: 'create', name, char })));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const buf = new Uint8Array(raw as Buffer);
        if (buf[0] !== MSG_SNAP) return;
        stats.bytes += buf.length;
        const d = decodeSnapshot(buf, (t) => worlds.get(t));
        if (!d) return void stats.misses++;
        if (d.baseTick === 0) stats.fullBytes += buf.length;
        worlds.set(d.world.tick, d.world);
        worlds.delete(d.world.tick - 64);
        if (!last || d.world.tick > last.tick) last = d.world;
        stats.snaps++;
        for (const [t, evs] of d.me.events) if (t > lastEvent) for (const e of evs) stats.events[e.e] = (stats.events[e.e] ?? 0) + 1;
        lastEvent = Math.max(lastEvent, ...d.me.events.map(([t]) => t));
        return;
      }
      const m = JSON.parse(String(raw)) as ServerMsg;
      if (m.t === 'joined') {
        id = m.id;
        room = m.code;
        if (!code) resolve({ code: room, stats });
      } else if (m.t === 'floor') stats.floors++;
      else if (m.t === 'meta') {
        if (m.players.find((p) => p.id === id)?.choices) ws.send(JSON.stringify({ t: 'choose', idx: 0 }));
      } else if (m.t === 'error') reject(new Error(m.msg));
    });
    const iv = setInterval(() => {
      const me = last?.tables[0].get(id);
      if (!me || !last) return;
      const mx = dpos(me[P.x]);
      const my = dpos(me[P.y]);
      let aim = Math.random() * 6.28;
      let best = 1e9;
      for (const e of last.tables[1].values()) {
        const d = Math.hypot(dpos(e[E.x]) - mx, dpos(e[E.y]) - my);
        if (d < best) {
          best = d;
          aim = Math.atan2(dpos(e[E.y]) - my, dpos(e[E.x]) - mx);
        }
      }
      const t = Date.now() / 1000;
      // Archer draws for ~1s then releases; both sprint/bash and use their secondary now and then.
      const held = best < 150 && seq % 40 < 30;
      const press = Math.random() < 0.02;
      const buttons = (held ? BTN_A : 0) | (best < 25 ? BTN_A_PRESS : 0) | (Math.random() < 0.01 ? BTN_B_PRESS : 0) | (press ? BTN_MOVE | BTN_MOVE_PRESS : 0);
      recent.push(quantizeInput(++seq, Math.cos(t), Math.sin(t * 0.7), aim, buttons, last.tick - 2));
      if (recent.length > 4) recent.shift();
      ws.send(encodeInputs(last.tick, recent));
    }, 1000 / 30);
    setTimeout(() => {
      clearInterval(iv);
      ws.close();
      if (code) resolve({ code: room, stats });
    }, SECONDS * 1000);
  });
}

const a = await bot('BotA', 'archer');
const b = await bot('BotB', 'knight', a.code);
console.log('room', a.code);
for (const [n, s] of [['A', a.stats] as const, ['B', b.stats] as const]) {
  console.log(n, {
    snaps: s.snaps,
    floors: s.floors,
    misses: s.misses,
    avgSnapBytes: Math.round(s.bytes / Math.max(1, s.snaps)),
    kbPerSec: +(s.bytes / 1024 / SECONDS).toFixed(2),
    events: s.events,
  });
}
process.exit(0);
