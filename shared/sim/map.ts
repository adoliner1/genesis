import { T, TILE } from '../protocol.ts';

export interface TileMap {
  w: number;
  h: number;
  tiles: Uint8Array;
}

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function tileAt(m: TileMap, px: number, py: number): number {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return T.Wall;
  return m.tiles[ty * m.w + tx];
}

export function solid(m: TileMap, px: number, py: number) {
  return tileAt(m, px, py) === T.Wall;
}

export function collides(m: TileMap, x: number, y: number, r: number) {
  const steps = Math.max(1, Math.ceil((r * 2) / 8));
  for (let i = 0; i <= steps; i++) {
    const o = -r + (2 * r * i) / steps;
    if (solid(m, x + o, y - r) || solid(m, x + o, y + r) || solid(m, x - r, y + o) || solid(m, x + r, y + o)) return true;
  }
  return false;
}

/** Axis-separated tile collision. Returns the impact speed if a wall was hit. */
export function moveBody(m: TileMap, o: Body, r: number, dt: number, bounce = 0): number {
  let impact = 0;
  const nx = o.x + o.vx * dt;
  if (collides(m, nx, o.y, r)) {
    impact = Math.max(impact, Math.abs(o.vx));
    o.vx = -o.vx * bounce;
  } else o.x = nx;
  const ny = o.y + o.vy * dt;
  if (collides(m, o.x, ny, r)) {
    impact = Math.max(impact, Math.abs(o.vy));
    o.vy = -o.vy * bounce;
  } else o.y = ny;
  return impact;
}

export function los(m: TileMap, x0: number, y0: number, x1: number, y1: number) {
  const d = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
  const n = Math.ceil(d / 6);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (solid(m, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

export function parseTiles(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) - 48);
}
