export const BTN_SHOOT = 1;
export const BTN_DASH = 2;
export const BTN_KICK = 4;

/**
 * One fixed-tick input sample. Values are stored already quantized to their wire
 * form so the client predicts with exactly what the server will simulate.
 */
export interface PlayerInput {
  seq: number;
  /** -127..127 */
  mx: number;
  my: number;
  /** 0..65535 over a full turn */
  aim: number;
  buttons: number;
  /** Render tick (in 1/8 ticks) the client was showing remote entities at, for lag compensation. */
  vt8: number;
}

const TAU = Math.PI * 2;

export function quantizeInput(
  seq: number,
  mx: number,
  my: number,
  aim: number,
  shoot: boolean,
  dash: boolean,
  kick: boolean,
  renderTick: number,
): PlayerInput {
  const q = (v: number) => Math.max(-127, Math.min(127, Math.round((Number.isFinite(v) ? v : 0) * 127)));
  const a = Number.isFinite(aim) ? aim : 0;
  return {
    seq,
    mx: q(mx),
    my: q(my),
    aim: Math.round((((a % TAU) + TAU) % TAU) * (65536 / TAU)) & 0xffff,
    buttons: (shoot ? BTN_SHOOT : 0) | (dash ? BTN_DASH : 0) | (kick ? BTN_KICK : 0),
    vt8: Math.max(0, Math.round(renderTick * 8)) >>> 0,
  };
}

export const inputAim = (i: PlayerInput) => (i.aim * TAU) / 65536;

/** Movement intent, clamped to the unit disc. */
export function inputDir(i: PlayerInput): [number, number] {
  const x = i.mx / 127;
  const y = i.my / 127;
  const m = Math.sqrt(x * x + y * y);
  return m > 1 ? [x / m, y / m] : [x, y];
}

export const neutralInput = (seq: number): PlayerInput => ({ seq, mx: 0, my: 0, aim: 0, buttons: 0, vt8: 0 });

/** Deterministic [0,1) hash so bullet spread matches between client prediction and server. */
export function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
