import { solid, type TileMap } from './map.ts';
import { DT } from './movement.ts';

export interface BulletBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounce: number;
}

export const FLYING = 0;
export const BOUNCED = 1;
export const DEAD = 2;

/** Bullets advance in two half-steps per tick. On a wall hit the bullet is left at its last free spot. */
export function bulletHalfStep(b: BulletBody, map: TileMap): 0 | 1 | 2 {
  const ox = b.x;
  const oy = b.y;
  b.x += (b.vx * DT) / 2;
  b.y += (b.vy * DT) / 2;
  if (!solid(map, b.x, b.y)) return FLYING;
  if (b.bounce > 0) {
    b.bounce--;
    if (solid(map, b.x, oy)) b.vx = -b.vx;
    if (solid(map, ox, b.y)) b.vy = -b.vy;
    b.x = ox;
    b.y = oy;
    return BOUNCED;
  }
  b.x = ox;
  b.y = oy;
  return DEAD;
}

/**
 * Where a straight-flying bullet is `ticks` after its anchor, or null once it has entered a wall.
 * Used to render server bullets on any timeline from a single (tick, pos, vel) anchor.
 */
export function bulletAt(
  map: TileMap,
  x0: number,
  y0: number,
  vx: number,
  vy: number,
  ticks: number,
): [number, number] | null {
  if (ticks <= 0) return [x0, y0];
  const n = Math.ceil(ticks * 2);
  for (let i = 1; i <= n; i++) {
    const t = Math.min(ticks, i / 2);
    if (solid(map, x0 + vx * DT * t, y0 + vy * DT * t)) return null;
  }
  return [x0 + vx * DT * ticks, y0 + vy * DT * ticks];
}
