// Headless smoke test: two bots join a room, wander and shoot at the nearest enemy.
import WebSocket from 'ws';
import type { ServerMsg, SnapMsg } from '../shared/protocol.ts';

const URL = process.env.WS ?? 'ws://localhost:47291/ws';
const SECONDS = Number(process.env.SECONDS ?? 20);

function bot(name: string, code?: string): Promise<{ code: string; stats: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    let id = 0;
    let room = '';
    let last: SnapMsg | null = null;
    const stats: Record<string, number> = { snaps: 0, floors: 0 };
    ws.on('open', () => ws.send(JSON.stringify(code ? { t: 'join', code, name } : { t: 'create', name })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      if (m.t === 'joined') {
        id = m.id;
        room = m.code;
        if (!code) resolve({ code: room, stats });
      } else if (m.t === 'floor') stats.floors++;
      else if (m.t === 'snap') {
        stats.snaps++;
        last = m;
        for (const e of m.events) stats[e.e] = (stats[e.e] ?? 0) + 1;
      } else if (m.t === 'error') reject(new Error(m.msg));
    });
    const iv = setInterval(() => {
      const me = last?.players.find((p) => p.id === id);
      if (!me || !last) return;
      let aim = Math.random() * 6.28;
      let best = 1e9;
      for (const e of last.enemies) {
        const d = Math.hypot(e.x - me.x, e.y - me.y);
        if (d < best) {
          best = d;
          aim = Math.atan2(e.y - me.y, e.x - me.x);
        }
      }
      if (me.choices) ws.send(JSON.stringify({ t: 'choose', idx: 0 }));
      const t = Date.now() / 1000;
      ws.send(
        JSON.stringify({ t: 'input', mx: Math.cos(t), my: Math.sin(t * 0.7), aim, shoot: best < 150, dash: Math.random() < 0.02, kick: best < 25 }),
      );
    }, 50);
    setTimeout(() => {
      clearInterval(iv);
      ws.close();
      if (code) resolve({ code: room, stats });
    }, SECONDS * 1000);
  });
}

const a = await bot('BotA');
const b = await bot('BotB', a.code);
console.log('room', a.code);
console.log('A', a.stats);
console.log('B', b.stats);
process.exit(0);
