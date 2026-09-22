import { TICK_RATE } from '../protocol.ts';
import { hash01, type PlayerInput } from './input.ts';
import type { TileMap } from './map.ts';

export const DT = 1 / TICK_RATE;
export const PLAYER_R = 5;

export const MODE = { walk: 0, sprint: 1, coast: 2, slide: 3, bash: 4, skid: 5 } as const;

/**
 * Everything a movement controller reads and writes each tick. Server and client run the
 * same controller on this state; the server ships it back verbatim so the client can
 * rewind and replay. Kit-specific fields live here too so they are reconciled for free;
 * kits simply leave the ones they don't use at zero.
 */
export interface MoveState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  stagger: number;
  down: boolean;
  /** One of MODE. */
  mode: number;
  /** Ticks left in a timed mode (coast window, slide, bash, skid). */
  act: number;
  /** Primary attack cooldown. */
  atkT: number;
  /** Archer: ticks the bow has been drawn (0 = not drawing). */
  draw: number;
  /** Knight: ticks left in the slash's active (deflecting) window. */
  swing: number;
  /** Movement-ability charges and recharge progress. */
  ab: number;
  abT: number;
  /** Secondary charges (archer pin traps) and recharge progress. */
  spec: number;
  specT: number;
  /** Knight shield guard; negative after a guard break until it regenerates. */
  guard: number;
  /** Ticks until guard starts regenerating. */
  guardT: number;
  /** Knight: shield raised this tick (0/1). */
  block: number;
}

export const MOVE_KEYS = [
  'x',
  'y',
  'vx',
  'vy',
  'aim',
  'stagger',
  'down',
  'mode',
  'act',
  'atkT',
  'draw',
  'swing',
  'ab',
  'abT',
  'spec',
  'specT',
  'guard',
  'guardT',
  'block',
] as const;

/** Tunables a controller reads. Perks and items change these; unused ones are ignored by a kit. */
export interface MoveStats {
  speed: number;
  atkCd: number;
  abCd: number;
  abMax: number;
  specCd: number;
  specMax: number;
  drawTicks: number;
  guardMax: number;
}

export interface StepResult {
  /** Primary projectile released (archer). */
  fire: boolean;
  /** Draw fraction 0..1 of the released arrow. */
  power: number;
  /** Shooter counted as standing still (archer passive). */
  still: boolean;
  /** Secondary used (archer pin trap). */
  trap: boolean;
  /** Melee swing started (knight). */
  slash: boolean;
  /** Movement ability started (archer sprint, knight bash). */
  ability: boolean;
  /** Slide started (archer glide, knight skid). */
  slide: boolean;
  /** Wall impact speed while staggered (knockback slam). */
  impact: number;
}

export const newResult = (): StepResult => ({ fire: false, power: 0, still: false, trap: false, slash: false, ability: false, slide: false, impact: 0 });

export interface MovementController {
  step(s: MoveState, stats: MoveStats, inp: PlayerInput, map: TileMap): StepResult;
}

export const newMoveState = (): MoveState => ({
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  aim: 0,
  stagger: 0,
  down: false,
  mode: 0,
  act: 0,
  atkT: 0,
  draw: 0,
  swing: 0,
  ab: 0,
  abT: 0,
  spec: 0,
  specT: 0,
  guard: 0,
  guardT: 0,
  block: 0,
});

/** Full charges and guard, no action in progress. */
export function resetKit(s: MoveState, st: MoveStats) {
  s.mode = s.act = s.draw = s.swing = s.block = s.abT = s.specT = s.guardT = 0;
  s.ab = st.abMax;
  s.spec = st.specMax;
  s.guard = st.guardMax;
}

export const copyMove = (s: MoveState): MoveState => ({ ...newMoveState(), ...pickMove(s) });

export function pickMove(s: MoveState): MoveState {
  const o = {} as Record<string, number | boolean>;
  for (const k of MOVE_KEYS) o[k] = s[k];
  return o as unknown as MoveState;
}

/** Per-field weight when comparing states: px for positions, ticks for timers. */
const ERR_W: Partial<Record<(typeof MOVE_KEYS)[number], number>> = { vx: 0.05, vy: 0.05, aim: 0, guard: 0.1 };

/** Largest per-field disagreement, and which field it was. */
export function moveDiff(a: MoveState, b: MoveState): [number, string] {
  let e = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  let key = 'pos';
  for (const k of MOVE_KEYS) {
    if (k === 'x' || k === 'y') continue;
    const d = k === 'down' ? (a.down !== b.down ? 99 : 0) : Math.abs(Number(a[k]) - Number(b[k])) * (ERR_W[k] ?? 1);
    if (d > e) {
      e = d;
      key = k;
    }
  }
  return [e, key];
}

export const moveError = (a: MoveState, b: MoveState) => moveDiff(a, b)[0];

export const dec = (v: number) => Math.max(v - 1, -1);

/** Recharges one charge at a time, like most limited abilities. */
export function recharge(s: MoveState, st: MoveStats) {
  if (s.ab > st.abMax) s.ab = st.abMax;
  if (s.ab < st.abMax && ++s.abT >= st.abCd) {
    s.ab++;
    s.abT = 0;
  }
  if (s.spec > st.specMax) s.spec = st.specMax;
  if (s.spec < st.specMax && ++s.specT >= st.specCd) {
    s.spec++;
    s.specT = 0;
  }
}

export const MUZZLE = 7;

/** Deterministic per-shot angles; seq keys the spread so prediction matches the server. */
export function shotAngles(aim: number, multishot: number, seq: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < multishot; i++) out.push(aim + (i - (multishot - 1) / 2) * 0.1 + (hash01(seq * 8 + i) - 0.5) * 0.03);
  return out;
}
