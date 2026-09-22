import { T, TILE } from '../protocol.ts';
import type { TileMap } from './map.ts';

/** Sight radius in tiles. */
export const VISION_R = 11;
/**
 * Extra tiles the server streams past what anyone can see, so entities arrive (still hidden under fog)
 * before a predicted player or an interpolated teammate reveals them on screen.
 */
export const SEND_MARGIN = 1.5;

/** A circle that blocks sight (smoke). Tiles whose centre is inside it are opaque and never revealed. */
export interface VisionBlocker {
  x: number;
  y: number;
  r: number;
}

export function opaqueGrid(m: TileMap, blockers: readonly VisionBlocker[] = []): Uint8Array {
  const out = new Uint8Array(m.w * m.h);
  for (let i = 0; i < out.length; i++) if (m.tiles[i] === T.Wall) out[i] = 1;
  for (const b of blockers) {
    const x0 = Math.max(0, Math.floor((b.x - b.r) / TILE));
    const x1 = Math.min(m.w - 1, Math.floor((b.x + b.r) / TILE));
    const y0 = Math.max(0, Math.floor((b.y - b.r) / TILE));
    const y1 = Math.min(m.h - 1, Math.floor((b.y + b.r) / TILE));
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const dx = (tx + 0.5) * TILE - b.x;
        const dy = (ty + 0.5) * TILE - b.y;
        if (dx * dx + dy * dy <= b.r * b.r) out[ty * m.w + tx] = 2;
      }
  }
  return out;
}

/**
 * Symmetric shadowcasting (walls are revealed, smoke is not) from the tile containing (px, py).
 * Calls `mark(index, dist2InTiles)` for every visible tile within `radius` tiles.
 */
export function fov(
  w: number,
  h: number,
  opaque: Uint8Array,
  px: number,
  py: number,
  radius: number,
  mark: (i: number, d2: number) => void,
) {
  const ox = Math.floor(px / TILE);
  const oy = Math.floor(py / TILE);
  if (ox < 0 || oy < 0 || ox >= w || oy >= h) return;
  mark(oy * w + ox, 0);
  const r2 = radius * radius;
  const maxDepth = Math.ceil(radius);
  const blockedAt = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || opaque[y * w + x] !== 0;

  for (let q = 0; q < 4; q++) {
    const tx = (d: number, c: number) => (q === 0 ? ox + c : q === 1 ? ox + c : q === 2 ? ox + d : ox - d);
    const ty = (d: number, c: number) => (q === 0 ? oy - d : q === 1 ? oy + d : q === 2 ? oy + c : oy + c);
    const scan = (depth: number, start: number, end: number) => {
      if (depth > maxDepth) return;
      let prev = -1;
      const lo = Math.floor(depth * start + 0.5);
      const hi = Math.ceil(depth * end - 0.5);
      for (let c = lo; c <= hi; c++) {
        const x = tx(depth, c);
        const y = ty(depth, c);
        const d2 = depth * depth + c * c;
        const inside = x >= 0 && y >= 0 && x < w && y < h;
        const op = blockedAt(x, y);
        if (inside && d2 <= r2) {
          const i = y * w + x;
          if (op ? opaque[i] === 1 : c >= depth * start && c <= depth * end) mark(i, d2);
        }
        const cur = op ? 1 : 0;
        if (prev === 1 && cur === 0) start = (2 * c - 1) / (2 * depth);
        if (prev === 0 && cur === 1) scan(depth + 1, start, (2 * c - 1) / (2 * depth));
        prev = cur;
      }
      if (prev === 0) scan(depth + 1, start, end);
    };
    scan(1, -1, 1);
  }
}

export interface Eye {
  x: number;
  y: number;
  /** Offline players leave a ghost behind but no eyes. */
  off?: boolean;
}

/** Tiles visible from any of `eyes` (1 = visible). */
export function teamVision(m: TileMap, opaque: Uint8Array, eyes: readonly Eye[], radius = VISION_R, out = new Uint8Array(m.w * m.h)) {
  out.fill(0);
  for (const e of eyes) if (!e.off) fov(m.w, m.h, opaque, e.x, e.y, radius, (i) => (out[i] = 1));
  return out;
}

export function packBits(a: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(a.length / 8));
  for (let i = 0; i < a.length; i++) if (a[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unpackBits(s: string, n: number, out = new Uint8Array(n)): Uint8Array {
  const raw = atob(s);
  for (let i = 0; i < n; i++) out[i] = (raw.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return out;
}
