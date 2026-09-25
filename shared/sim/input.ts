/** Held bits describe this tick; *_P bits mean "pressed since the previous tick" (latched on keydown so taps are never lost). */
export const BTN = {
  JUMP: 1,
  JUMP_P: 2,
  PRI: 4,
  PRI_P: 8,
  SEC: 16,
  SEC_P: 32,
  MOB: 64,
  MOB_P: 128,
  CTX: 256,
  CTX_P: 512,
} as const;

/** Bits a guessed (missing) input may repeat; the rest are one-shot presses that get carried instead. */
export const HELD_MASK = BTN.JUMP | BTN.PRI | BTN.SEC | BTN.MOB | BTN.CTX;
export const PRESS_MASK = BTN.JUMP_P | BTN.PRI_P | BTN.SEC_P | BTN.MOB_P | BTN.CTX_P;

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
  /** Tick (in 1/8 ticks) the client was showing the world at, so the server collides against the same platforms. */
  vt8: number;
}

const TAU = Math.PI * 2;

export function quantizeInput(seq: number, mx: number, my: number, aim: number, buttons: number, viewTick: number): PlayerInput {
  const q = (v: number) => Math.max(-127, Math.min(127, Math.round((Number.isFinite(v) ? v : 0) * 127)));
  const a = Number.isFinite(aim) ? aim : 0;
  return {
    seq,
    mx: q(mx),
    my: q(my),
    aim: Math.round((((a % TAU) + TAU) % TAU) * (65536 / TAU)) & 0xffff,
    buttons: buttons & 0xffff,
    vt8: Math.max(0, Math.round(viewTick * 8)) >>> 0,
  };
}

export const inputAim = (i: PlayerInput) => (i.aim * TAU) / 65536;

export const neutralInput = (seq: number): PlayerInput => ({ seq, mx: 0, my: 0, aim: 0, buttons: 0, vt8: 0 });
