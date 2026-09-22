// Runs a real Room headlessly and checks that snapshots and events never carry anything outside the team's vision.
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { Room } from '../server/game.ts';
import { B, E, I, MSG_SNAP, X, decodeSnapshot, dpos, encodeInputs, type World } from '../shared/net/snapshot.ts';
import { quantizeInput } from '../shared/sim/input.ts';
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

const p = room.addPlayer(ws, 'Tester')!;
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
  room.handleBinary(p, encodeInputs(latest?.tick ?? 0, [quantizeInput(++seq, 0, 0, a, t % 3 === 0, false, false, 0)]));
  room.step();
  room.sendSnapshots();
}

assert.ok(fogMsgs >= 1, 'explored map is sent on join');
assert.equal(leaks, 0, 'nothing outside the streamed vision reached the client');
assert.ok(hiddenEnemyTicks > 0, 'fog actually hid some enemies');
const [ex, ey] = [room.map.spawn.x, room.map.spawn.y];
assert.equal(typeof room.canSee(p.id, ex, ey), 'boolean');
console.log(`fog: ${snaps} snapshots, avg ${Math.round(bytes / snaps)} B, ${checkedEvents} positional events checked, enemies hidden on ${hiddenEnemyTicks} ticks, 0 leaks`);
