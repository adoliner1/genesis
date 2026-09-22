import { TICK_RATE } from '../protocol.ts';
import { BTN_DASH, BTN_KICK, BTN_SHOOT, hash01, inputAim, inputDir, type PlayerInput } from './input.ts';
import { moveBody, type TileMap } from './map.ts';

export const DT = 1 / TICK_RATE;
export const PLAYER_R = 5;

/**
 * Everything a movement controller reads and writes each tick. Server and client run the
 * same controller on this state; the server ships it back verbatim so the client can
 * rewind and replay. New controllers (sprint drift, slides, charges, blinks) add fields
 * here and to MOVE_KEYS so they are reconciled too.
 */
export interface MoveState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  dashing: number;
  dashT: number;
  stagger: number;
  fireT: number;
  kickT: number;
  down: boolean;
}

export const MOVE_KEYS = ['x', 'y', 'vx', 'vy', 'aim', 'dashing', 'dashT', 'stagger', 'fireT', 'kickT', 'down'] as const;

export interface MoveStats {
  speed: number;
  dashCd: number;
  fireCd: number;
}

export interface StepResult {
  dashed: boolean;
  fired: boolean;
  kicked: boolean;
}

export interface MovementController {
  step(s: MoveState, stats: MoveStats, inp: PlayerInput, map: TileMap): StepResult;
}

export const newMoveState = (): MoveState => ({
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  aim: 0,
  dashing: 0,
  dashT: 0,
  stagger: 0,
  fireT: 0,
  kickT: 0,
  down: false,
});

export const copyMove = (s: MoveState): MoveState => ({ ...newMoveState(), ...pickMove(s) });

export function pickMove(s: MoveState): MoveState {
  const o = {} as Record<string, number | boolean>;
  for (const k of MOVE_KEYS) o[k] = s[k];
  return o as unknown as MoveState;
}

/** Largest per-field disagreement, in px for positions and ticks for timers. */
export function moveError(a: MoveState, b: MoveState): number {
  let e = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  e = Math.max(e, Math.abs(a.vx - b.vx) * 0.05, Math.abs(a.vy - b.vy) * 0.05);
  for (const k of ['dashing', 'dashT', 'fireT', 'kickT', 'stagger'] as const) e = Math.max(e, Math.abs(a[k] - b[k]));
  if (a.down !== b.down) e = Math.max(e, 99);
  return e;
}

const dec = (v: number) => Math.max(v - 1, -1);

/** Default twin-stick gunner: snappy walk, fixed-length dash, recoil on fire. */
export const gunner: MovementController = {
  step(s, st, inp, map) {
    const res: StepResult = { dashed: false, fired: false, kicked: false };
    s.aim = inputAim(inp);
    s.stagger = dec(s.stagger);
    if (s.down) {
      s.vx *= 0.8;
      s.vy *= 0.8;
      moveBody(map, s, PLAYER_R, DT);
      return res;
    }
    s.fireT = dec(s.fireT);
    s.dashT = dec(s.dashT);
    s.kickT = dec(s.kickT);
    const [mx, my] = inputDir(inp);

    if (inp.buttons & BTN_DASH && s.dashT <= 0) {
      let dx = mx;
      let dy = my;
      if (!dx && !dy) {
        dx = Math.cos(s.aim);
        dy = Math.sin(s.aim);
      }
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      s.vx = (dx / d) * 310;
      s.vy = (dy / d) * 310;
      s.dashing = 7;
      s.dashT = st.dashCd;
      res.dashed = true;
    }

    if (s.dashing > 0) {
      s.dashing--;
      if (s.dashing === 0) {
        s.vx *= 0.4;
        s.vy *= 0.4;
      }
    } else if (s.stagger > 0) {
      s.vx *= 0.85;
      s.vy *= 0.85;
    } else {
      s.vx += (mx * st.speed - s.vx) * 0.3;
      s.vy += (my * st.speed - s.vy) * 0.3;
    }
    moveBody(map, s, PLAYER_R, DT);

    if (inp.buttons & BTN_SHOOT && s.fireT <= 0 && s.dashing <= 0) {
      s.fireT += st.fireCd;
      s.vx -= Math.cos(s.aim) * 22;
      s.vy -= Math.sin(s.aim) * 22;
      res.fired = true;
    }
    if (inp.buttons & BTN_KICK && s.kickT <= 0) {
      s.kickT = 16;
      res.kicked = true;
    }
    return res;
  },
};

export const BULLET_SPEED = 330;
export const BULLET_LIFE = 40;
export const MUZZLE = 7;

/** Deterministic per-shot angles; seq keys the spread so prediction matches the server. */
export function shotAngles(aim: number, multishot: number, seq: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < multishot; i++) out.push(aim + (i - (multishot - 1) / 2) * 0.12 + (hash01(seq * 8 + i) - 0.5) * 0.05);
  return out;
}
