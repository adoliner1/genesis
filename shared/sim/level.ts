import { TILE } from '../protocol.ts';

export const T = {
  Empty: 0,
  Solid: 1,
  /** Solid, and the only surface rope arrows stick to. */
  Wood: 2,
  /** Thin platform: stand on it, jump up through it, S to drop through. */
  OneWay: 3,
  Spikes: 4,
} as const;

const CHARS: Record<string, number> = { '.': T.Empty, ' ': T.Empty, '#': T.Solid, w: T.Wood, '-': T.OneWay, '^': T.Spikes };
const BACK = ['.', '#', 'w', '-', '^'];

export interface TileMap {
  w: number;
  h: number;
  tiles: Uint8Array;
}

/** Everything outside the map is solid, so nothing can leave it. */
export function tileAt(m: TileMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return T.Solid;
  return m.tiles[ty * m.w + tx];
}

export const isSolid = (t: number) => t === T.Solid || t === T.Wood;

export function parseRows(rows: string[]): TileMap {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const tiles = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = CHARS[rows[y][x] ?? '#'];
      if (t === undefined) throw new Error(`Unknown tile '${rows[y][x]}' at ${x},${y}`);
      tiles[y * w + x] = t;
    }
  return { w, h, tiles };
}

export const tilesToString = (m: TileMap) => Array.from(m.tiles, (t) => BACK[t]).join('');

export function tilesFromString(w: number, h: number, s: string): TileMap {
  const tiles = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) tiles[i] = CHARS[s[i]] ?? T.Solid;
  return { w, h, tiles };
}

/*
 * Level objects are placed in tile coordinates. Anything a player stands at uses the tile they
 * stand *in* (their feet rest on the top of the tile below).
 */
export type LevelObject =
  | { k: 'spawn'; x: number; y: number }
  /** Touching it makes it your respawn point. */
  | { k: 'checkpoint'; x: number; y: number }
  /**
   * A rope over a wheel: a grabbable hook on one side, a lift platform on the other. The hook side
   * sinks when the weight hanging on it beats the counterweight plus whatever stands on the lift.
   * Unlike the other objects this one is in pixels: hookX is the hook's centre, the Ys are tops at rest.
   */
  | { k: 'pulley'; hookX: number; hookY: number; liftX: number; liftY: number; liftW: number; travel: number; counter: number }
  /** E to pull. Latches on. */
  | { k: 'lever'; x: number; y: number; ch: number }
  /** Pressed while the weight standing on it reaches `need`. */
  | { k: 'plate'; x: number; y: number; w: number; need: number; ch: number }
  /** Hit it with an arrow. Latches on. */
  | { k: 'target'; x: number; y: number; ch: number }
  /** Slides up by its own height while its channel is on. */
  | { k: 'gate'; x: number; y: number; w: number; h: number; ch: number }
  /** Everyone inside at once finishes the level. */
  | { k: 'goal'; x: number; y: number; w: number; h: number }
  /** Hint text drawn in the world. */
  | { k: 'sign'; x: number; y: number; text: string };

export interface LevelDef {
  name: string;
  rows: string[];
  objects: LevelObject[];
}

export const px = (t: number) => t * TILE;
