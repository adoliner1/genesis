// Checks for the authoritative fog-of-war API: walls block sight, team vision is shared, smoke blocks and expires.
import assert from 'node:assert/strict';
import { T, TILE } from '../shared/protocol.ts';
import { Vision } from '../server/vision.ts';

// 30x12 map: two rooms split by a wall at x=15 with a door at y=5.
const w = 30;
const h = 12;
const tiles = new Uint8Array(w * h);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || (x === 15 && y !== 5)) tiles[y * w + x] = T.Wall;
const at = (tx: number, ty: number) => [(tx + 0.5) * TILE, (ty + 0.5) * TILE] as const;

const v = new Vision({ w, h, tiles });
const [ax, ay] = at(5, 2);
const [bx, by] = at(24, 9);
v.update(1, [{ id: 1, team: 0, x: ax, y: ay, eyes: true }]);

assert.ok(v.canSee(1, ...at(8, 8)), 'open floor in the same room is visible');
assert.ok(v.canSee(1, ...at(15, 3)), 'the wall itself is revealed');
assert.ok(!v.canSee(1, ...at(18, 2)), 'the wall blocks the next room');
assert.ok(!v.canSee(1, ...at(5 + 12, 2)), 'beyond sight radius is hidden');
assert.ok(!v.canSee(2, ...at(5, 2)), 'unknown players see nothing');

v.update(2, [
  { id: 1, team: 0, x: ax, y: ay, eyes: true },
  { id: 2, team: 0, x: bx, y: by, eyes: true },
  { id: 3, team: 1, x: bx, y: by, eyes: false },
]);
assert.ok(v.canSee(1, ...at(22, 8)), 'team shares a teammate\'s vision');
assert.ok(!v.seesDirectly(1, ...at(22, 8)), 'but not with their own eyes');
assert.ok(!v.canSee(3, ...at(22, 8)), 'players without eyes add nothing');
assert.ok(v.streamed(0, ...at(5 + 12, 2)), 'streamed region extends past the sight radius');

const smoke = v.addBlocker(...at(8, 2), TILE * 1.2);
v.update(3, [{ id: 1, team: 0, x: ax, y: ay, eyes: true }]);
assert.ok(!v.canSee(1, ...at(8, 2)), 'smoke itself is not see-through');
assert.ok(!v.canSee(1, ...at(11, 2)), 'smoke casts a shadow');
assert.ok(v.canSee(1, ...at(5, 8)), 'smoke does not hide unrelated tiles');
assert.ok(!v.lineOfSight(...at(5, 2), ...at(11, 2)), 'lineOfSight respects smoke');
assert.ok(v.lineOfSight(...at(5, 2), ...at(5, 8)), 'lineOfSight is clear otherwise');
v.removeBlocker(smoke);
v.addBlocker(...at(8, 2), TILE * 1.2, 4);
v.update(5, [{ id: 1, team: 0, x: ax, y: ay, eyes: true }]);
assert.ok(v.canSee(1, ...at(11, 2)), 'timed smoke expires');

console.log('vision: all checks passed');
