import { T, TILE, type EnemyKind, type ItemKind } from '../shared/protocol.ts';

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Spawn {
  x: number;
  y: number;
}

export interface FloorData {
  w: number;
  h: number;
  tiles: Uint8Array;
  spawn: Spawn;
  stairs: Spawn;
  enemies: { k: EnemyKind; x: number; y: number }[];
  barrels: Spawn[];
  items: { k: ItemKind; x: number; y: number }[];
  boss: boolean;
}

const W = 64;
const H = 48;
const PASSIVE_ITEMS: ItemKind[] = ['sigil', 'ricochet', 'heavy', 'fang', 'boots', 'charm'];

const ri = (rng: Rng, a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
const center = (r: Room) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) });
const toWorld = (tx: number, ty: number) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

function fill(tiles: Uint8Array, w: number, x: number, y: number, rw: number, rh: number, v: number) {
  for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) tiles[j * w + i] = v;
}

function carveCorridor(tiles: Uint8Array, a: Spawn, b: Spawn, rng: Rng) {
  const horizFirst = rng() < 0.5;
  const hLine = (y: number, x0: number, x1: number) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) fill(tiles, W, x, y, 1, 2, T.Floor);
  };
  const vLine = (x: number, y0: number, y1: number) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) fill(tiles, W, x, y, 2, 1, T.Floor);
  };
  if (horizFirst) {
    hLine(a.y, a.x, b.x);
    vLine(b.x, a.y, b.y);
  } else {
    vLine(a.x, a.y, b.y);
    hLine(b.y, a.x, b.x);
  }
}

function freeTiles(tiles: Uint8Array, r: Room, taken: Set<number>): number[] {
  const out: number[] = [];
  for (let y = r.y + 1; y < r.y + r.h - 1; y++)
    for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
      const i = y * W + x;
      if (tiles[i] === T.Floor && !taken.has(i)) out.push(i);
    }
  return out;
}

function takeTile(rng: Rng, list: number[], taken: Set<number>): Spawn | null {
  while (list.length) {
    const idx = Math.floor(rng() * list.length);
    const i = list.splice(idx, 1)[0];
    if (taken.has(i)) continue;
    taken.add(i);
    return toWorld(i % W, Math.floor(i / W));
  }
  return null;
}

function bfsFarthest(tiles: Uint8Array, from: Spawn, rooms: Room[]): Room {
  const dist = new Int32Array(W * H).fill(-1);
  const q = [from.y * W + from.x];
  dist[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % W;
    const y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] >= 0 || tiles[ni] === T.Wall) continue;
      dist[ni] = dist[i] + 1;
      q.push(ni);
    }
  }
  let best = rooms[rooms.length - 1];
  let bd = -1;
  for (const r of rooms) {
    const c = center(r);
    const d = dist[c.y * W + c.x];
    if (d > bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

function enemyMix(floor: number, rng: Rng): EnemyKind {
  const r = rng();
  if (floor === 1) return r < 0.7 ? 'grunt' : 'archer';
  if (floor === 2) return r < 0.5 ? 'grunt' : r < 0.8 ? 'archer' : 'brute';
  return r < 0.4 ? 'grunt' : r < 0.7 ? 'archer' : 'brute';
}

export function generateFloor(floor: number, seed: number, bossFloor: boolean): FloorData {
  const rng = mulberry32(seed);
  return bossFloor ? genBoss(rng) : genRegular(floor, rng);
}

function genRegular(floor: number, rng: Rng): FloorData {
  const tiles = new Uint8Array(W * H).fill(T.Wall);
  const rooms: Room[] = [];
  const target = 7 + Math.min(floor, 3);
  for (let tries = 0; tries < 400 && rooms.length < target; tries++) {
    const r: Room = { x: 0, y: 0, w: ri(rng, 8, 14), h: ri(rng, 7, 11) };
    r.x = ri(rng, 2, W - r.w - 2);
    r.y = ri(rng, 2, H - r.h - 2);
    const overlaps = rooms.some(
      (o) => r.x < o.x + o.w + 2 && r.x + r.w + 2 > o.x && r.y < o.y + o.h + 2 && r.y + r.h + 2 > o.y,
    );
    if (!overlaps) rooms.push(r);
  }
  for (const r of rooms) fill(tiles, W, r.x, r.y, r.w, r.h, T.Floor);

  rooms.sort((a, b) => a.x + a.y * 0.5 - (b.x + b.y * 0.5));
  const spawnRoom = rooms[0];

  for (const r of rooms) {
    if (r === spawnRoom) continue;
    const roll = rng();
    if (roll < 0.3) {
      const pw = ri(rng, 2, Math.max(2, r.w - 6));
      const ph = ri(rng, 2, Math.max(2, r.h - 5));
      fill(tiles, W, ri(rng, r.x + 2, r.x + r.w - pw - 2), ri(rng, r.y + 2, r.y + r.h - ph - 2), pw, ph, T.Lava);
    } else if (roll < 0.55) {
      const pw = ri(rng, 2, Math.max(2, r.w - 6));
      const ph = ri(rng, 2, Math.max(2, r.h - 5));
      fill(tiles, W, ri(rng, r.x + 2, r.x + r.w - pw - 2), ri(rng, r.y + 2, r.y + r.h - ph - 2), pw, ph, T.Pit);
    } else if (roll < 0.8) {
      if (rng() < 0.5) fill(tiles, W, r.x + 1, ri(rng, r.y + 2, r.y + r.h - 3), r.w - 2, 1, T.Spikes);
      else fill(tiles, W, ri(rng, r.x + 2, r.x + r.w - 3), r.y + 1, 1, r.h - 2, T.Spikes);
    }
  }

  for (let i = 1; i < rooms.length; i++) carveCorridor(tiles, center(rooms[i - 1]), center(rooms[i]), rng);
  if (rooms.length > 4) {
    const a = ri(rng, 0, rooms.length - 1);
    const b = (a + 2 + ri(rng, 0, rooms.length - 3)) % rooms.length;
    carveCorridor(tiles, center(rooms[a]), center(rooms[b]), rng);
  }

  const sc = center(spawnRoom);
  const stairsRoom = bfsFarthest(tiles, sc, rooms);
  const stc = center(stairsRoom);
  fill(tiles, W, stc.x - 1, stc.y - 1, 2, 2, T.Stairs);

  const taken = new Set<number>();
  for (let y = sc.y - 2; y <= sc.y + 2; y++) for (let x = sc.x - 2; x <= sc.x + 2; x++) taken.add(y * W + x);

  const enemies: FloorData['enemies'] = [];
  const barrels: Spawn[] = [];
  const items: FloorData['items'] = [];

  for (const r of rooms) {
    if (r === spawnRoom) continue;
    const free = freeTiles(tiles, r, taken);
    const n = ri(rng, 1 + Math.floor(floor / 2), 2 + floor);
    for (let i = 0; i < n; i++) {
      const p = takeTile(rng, free, taken);
      if (p) enemies.push({ k: enemyMix(floor, rng), ...p });
    }
    if (rng() < 0.6) {
      const p = takeTile(rng, free, taken);
      if (p) {
        barrels.push(p);
        for (let k = 0; k < ri(rng, 0, 2); k++) {
          const tx = Math.floor(p.x / TILE) + ri(rng, -1, 1);
          const ty = Math.floor(p.y / TILE) + ri(rng, -1, 1);
          const ti = ty * W + tx;
          if (tiles[ti] === T.Floor && !taken.has(ti)) {
            taken.add(ti);
            barrels.push(toWorld(tx, ty));
          }
        }
      }
    }
  }

  const pool = [...PASSIVE_ITEMS];
  const others = rooms.filter((r) => r !== spawnRoom);
  for (let i = 0; i < 2; i++) {
    const kind = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    const r = others[Math.floor(rng() * others.length)];
    const p = takeTile(rng, freeTiles(tiles, r, taken), taken);
    if (p) items.push({ k: kind, ...p });
  }
  {
    const r = others[Math.floor(rng() * others.length)];
    const p = takeTile(rng, freeTiles(tiles, r, taken), taken);
    if (p) items.push({ k: 'potion', ...p });
  }

  return {
    w: W,
    h: H,
    tiles,
    spawn: { x: sc.x * TILE, y: sc.y * TILE + TILE / 2 },
    stairs: { x: stc.x * TILE, y: stc.y * TILE },
    enemies,
    barrels,
    items,
    boss: false,
  };
}

function genBoss(rng: Rng): FloorData {
  const tiles = new Uint8Array(W * H).fill(T.Wall);
  const arena: Room = { x: 16, y: 6, w: 32, h: 24 };
  const start: Room = { x: 27, y: 36, w: 10, h: 8 };
  fill(tiles, W, arena.x, arena.y, arena.w, arena.h, T.Floor);
  fill(tiles, W, start.x, start.y, start.w, start.h, T.Floor);
  fill(tiles, W, 31, arena.y + arena.h, 2, start.y - arena.y - arena.h, T.Floor);

  fill(tiles, W, arena.x + 2, arena.y + 2, 4, 3, T.Lava);
  fill(tiles, W, arena.x + arena.w - 6, arena.y + 2, 4, 3, T.Lava);
  fill(tiles, W, arena.x + 2, arena.y + arena.h - 5, 4, 3, T.Pit);
  fill(tiles, W, arena.x + arena.w - 6, arena.y + arena.h - 5, 4, 3, T.Pit);
  fill(tiles, W, arena.x + 9, arena.y + 7, 1, 10, T.Spikes);
  fill(tiles, W, arena.x + arena.w - 10, arena.y + 7, 1, 10, T.Spikes);

  const barrels: Spawn[] = [];
  for (const [tx, ty] of [
    [arena.x + 5, arena.y + 11],
    [arena.x + 5, arena.y + 12],
    [arena.x + arena.w - 6, arena.y + 11],
    [arena.x + arena.w - 6, arena.y + 12],
    [arena.x + 14, arena.y + 3],
    [arena.x + 17, arena.y + 3],
    [arena.x + 14, arena.y + 20],
    [arena.x + 17, arena.y + 20],
  ])
    barrels.push(toWorld(tx, ty));

  void rng;
  return {
    w: W,
    h: H,
    tiles,
    spawn: { x: 32 * TILE, y: 40 * TILE },
    stairs: { x: 32 * TILE, y: 18 * TILE },
    enemies: [{ k: 'boss', x: 32 * TILE, y: 13 * TILE }],
    barrels,
    items: [
      { k: 'potion', ...toWorld(29, 39) },
      { k: 'potion', ...toWorld(35, 39) },
    ],
    boss: true,
  };
}
