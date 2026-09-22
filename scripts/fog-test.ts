// Runs a real Room headlessly and checks that snapshots and events never carry anything outside the team's vision.
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { Room } from '../server/game.ts';
import { B, E, I, MSG_SNAP, X, decodeSnapshot, dpos, encodeInputs, type World } from '../shared/net/snapshot.ts';
import { BTN_A, BTN_B_PRESS, quantizeInput } from '../shared/sim/input.ts';
import type { ServerMsg } from '../shared/protocol.ts';

function fakeSocket(onBin: (b: Uint8Array) => void, onJson: (m: ServerMsg) => void) {
  return {
    readyState: 1,
    send(data: unknown) {
      if (typeof data === 'string') onJson(JSON.parse(data));
      else onBin(new Uint8Array(data as Uint8Array));
    },
    close() {},
  } as unknown as WebSocket;
}

const room = new Room('TEST');
const worlds = new Map<number, World>();
let latest = null as World | null;
let bytes = 0;
let snaps = 0;
let fogMsgs = 0;
let leaks = 0;
let hiddenEnemyTicks = 0;
let checkedEvents = 0;

const ws = fakeSocket(
  (b) => {
    if (b[0] !== MSG_SNAP) return;
    const d = decodeSnapshot(b, (t) => worlds.get(t));
    assert.ok(d, 'baseline available');
    bytes += b.length;
    snaps++;
    worlds.set(d.world.tick, d.world);
    latest = d.world;
    const streamed = (x: number, y: number, r: number) => room.vision.streamed(0, x, y, r);
    for (const row of d.world.tables[1].values()) if (!streamed(dpos(row[E.x]), dpos(row[E.y]), 14)) leaks++;
    for (const row of d.world.tables[3].values()) if (!streamed(dpos(row[X.x]), dpos(row[X.y]), 6)) leaks++;
    for (const row of d.world.tables[4].values()) if (!streamed(dpos(row[I.x]), dpos(row[I.y]), 4)) leaks++;
    for (const row of d.world.tables[2].values()) if (!row[B.o] && !streamed(dpos(row[B.x]), dpos(row[B.y]), 8)) leaks++;
    if (room.enemies.length > d.world.tables[1].size) hiddenEnemyTicks++;
    for (const [, evs] of d.me.events)
      for (const e of evs)
        if ('x' in e && (e.e === 'eshot' || e.e === 'die' || (e.e === 'hit' && e.who === 'enemy'))) {
          checkedEvents++;
          if (!streamed(e.x, e.y, 16)) leaks++;
        }
  },
  (m) => {
    if (m.t === 'fog') fogMsgs++;
  },
);

const p = room.addPlayer(ws, 'Tester', 'archer')!;
let seq = 0;
for (let t = 0; t < 30 * 20; t++) {
  // Every 2 s, hop next to a live enemy so combat events happen at the edge of sight.
  const e = room.enemies[(t / 60) % room.enemies.length | 0];
  if (t % 60 === 0 && e)
    for (const [ox, oy] of [[60, 0], [-60, 0], [0, 60], [0, -60]])
      if (!room.collides(e.x + ox, e.y + oy, 6)) {
        p.x = e.x + ox;
        p.y = e.y + oy;
        break;
      }
  const a = e ? Math.atan2(e.y - p.y, e.x - p.x) : 0;
  room.handleBinary(p, encodeInputs(latest?.tick ?? 0, [quantizeInput(++seq, 0, 0, a, t % 20 < 15 ? BTN_A : t % 20 === 19 ? BTN_B_PRESS : 0, 0)]));
  room.step();
  room.sendSnapshots();
}

assert.ok(fogMsgs >= 1, 'explored map is sent on join');
assert.equal(leaks, 0, 'nothing outside the streamed vision reached the client');
assert.ok(hiddenEnemyTicks > 0, 'fog actually hid some enemies');
const [ex, ey] = [room.map.spawn.x, room.map.spawn.y];
assert.equal(typeof room.canSee(p.id, ex, ey), 'boolean');
console.log(`fog: ${snaps} snapshots, avg ${Math.round(bytes / snaps)} B, ${checkedEvents} positional events checked, enemies hidden on ${hiddenEnemyTicks} ticks, 0 leaks`);

// Rival team: their traps, arrows and ability events must stay hidden unless team 0 can see them.
{
  const r2 = new Room('TST2');
  r2.teamOf = (q) => (q.name === 'Rival' ? 1 : 0);
  const w2 = new Map<number, World>();
  let last2 = null as World | null;
  let rivalId = 0;
  let rivalLeaks = 0;
  let rivalHidden = 0;
  const seen0 = (x: number, y: number, r: number) => r2.vision.streamed(0, x, y, r);
  const me = r2.addPlayer(
    fakeSocket(
      (b) => {
        if (b[0] !== MSG_SNAP) return;
        const d = decodeSnapshot(b, (t) => w2.get(t))!;
        w2.set(d.world.tick, d.world);
        last2 = d.world;
        for (const row of d.world.tables[5].values()) if (!seen0(dpos(row[0]), dpos(row[1]), 3)) rivalLeaks++;
        for (const row of d.world.tables[2].values()) if (row[B.o] === rivalId && !seen0(dpos(row[B.x]), dpos(row[B.y]), 8)) rivalLeaks++;
        for (const [, evs] of d.me.events) for (const e of evs) if ('p' in e && e.p === rivalId && 'x' in e && !seen0(e.x, e.y, 16)) rivalLeaks++;
      },
      () => {},
    ),
    'Tester',
    'knight',
  )!;
  const rival = r2.addPlayer(fakeSocket(() => {}, () => {}), 'Rival', 'archer')!;
  rivalId = rival.id;
  r2.step();
  const m = r2.map;
  let spot: [number, number] | null = null;
  for (let i = 0; i < m.tiles.length && !spot; i++) {
    const x = (i % m.w) * 16 + 8;
    const y = Math.floor(i / m.w) * 16 + 8;
    if (m.tiles[i] === 0 && !r2.collides(x, y, 6) && Math.hypot(x - me.x, y - me.y) > 300) spot = [x, y];
  }
  assert.ok(spot, 'found a far-away spot');
  let s1 = 0;
  let s2 = 0;
  let rivalPlaced = 0;
  for (let t = 0; t < 30 * 8; t++) {
    rival.x = spot![0];
    rival.y = spot![1];
    const btn = t % 20 < 12 ? BTN_A : t % 20 === 15 ? BTN_B_PRESS : 0;
    r2.handleBinary(me, encodeInputs(last2?.tick ?? 0, [quantizeInput(++s1, 0, 0, 0, 0, 0)]));
    r2.handleBinary(rival, encodeInputs(r2.tick, [quantizeInput(++s2, 0, 0, t * 0.3, btn, 0)]));
    r2.step();
    r2.sendSnapshots();
    if (r2.traps.some((q) => q.pid === rivalId)) rivalPlaced++;
    if (r2.traps.some((q) => q.pid === rivalId) && last2 && ![...last2.tables[5].keys()].some((id) => r2.traps.find((q) => q.id === id)?.pid === rivalId)) rivalHidden++;
  }
  assert.ok(rivalPlaced > 0, 'rival placed traps');
  assert.ok(rivalHidden > 0, 'rival traps were hidden by fog');
  assert.equal(rivalLeaks, 0, 'no rival traps, arrows or ability events leaked through fog');
  console.log(`fog (rival team): traps hidden on ${rivalHidden} ticks, 0 leaks`);
}
