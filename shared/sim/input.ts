/** Held this tick. */
export const BTN_A = 1;
/** Pressed since the previous tick (latched on keydown so sub-tick taps are not lost). */
export const BTN_MOVE_PRESS = 2;
export const BTN_B_PRESS = 4;
export const BTN_B = 8;
export const BTN_MOVE = 16;
export const BTN_A_PRESS = 32;

/** Bits a guessed (missing) input may repeat; the rest are one-shot presses that get carried instead. */
export const HELD_MASK = BTN_A | BTN_B | BTN_MOVE;
export const PRESS_MASK = BTN_A_PRESS | BTN_B_PRESS | BTN_MOVE_PRESS;

/** Raw per-tick intent. A = primary (LMB), B = secondary (RMB / F), MOVE = movement key (Shift / Space). */
export interface Buttons {
  a: boolean;
  aPress: boolean;
  b: boolean;
  bPress: boolean;
  move: boolean;
  movePress: boolean;
}

export const noButtons = (): Buttons => ({ a: false, aPress: false, b: false, bPress: false, move: false, movePress: false });

export function packButtons(b: Buttons): number {
  return (
    (b.a ? BTN_A : 0) |
    (b.aPress ? BTN_A_PRESS : 0) |
    (b.b ? BTN_B : 0) |
    (b.bPress ? BTN_B_PRESS : 0) |
    (b.move ? BTN_MOVE : 0) |
    (b.movePress ? BTN_MOVE_PRESS : 0)
  );
}

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

export function quantizeInput(seq: number, mx: number, my: number, aim: number, buttons: number, renderTick: number): PlayerInput {
  const q = (v: number) => Math.max(-127, Math.min(127, Math.round((Number.isFinite(v) ? v : 0) * 127)));
  const a = Number.isFinite(aim) ? aim : 0;
  return {
    seq,
    mx: q(mx),
    my: q(my),
    aim: Math.round((((a % TAU) + TAU) % TAU) * (65536 / TAU)) & 0xffff,
    buttons: buttons & 0xff,
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
