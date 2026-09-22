export const TILE = 16;
export const TICK_RATE = 30;
export const MAX_PLAYERS = 4;
export const FLOORS = 4;

export const T = {
  Floor: 0,
  Wall: 1,
  Pit: 2,
  Lava: 3,
  Spikes: 4,
  Stairs: 5,
} as const;

export const SPIKE_PERIOD = 96;
export const SPIKE_UP = 34;
export const SPIKE_WARN = 18;

/** 0 = retracted, 1 = about to fire, 2 = up (damaging) */
export function spikeState(tick: number, tx: number, ty: number): 0 | 1 | 2 {
  const t = (tick + ((tx + ty) % 4) * 12) % SPIKE_PERIOD;
  if (t < SPIKE_UP) return 2;
  if (t >= SPIKE_PERIOD - SPIKE_WARN) return 1;
  return 0;
}

export const PLAYER_COLORS = ['#4fc3ff', '#ff6b8b', '#ffd23f', '#7dff8a'];

export type EnemyKind = 'grunt' | 'archer' | 'brute' | 'boss';

export const ENEMY_R: Record<EnemyKind, number> = { grunt: 6, archer: 5, brute: 8, boss: 14 };

export type ItemKind = 'potion' | 'twin' | 'bounce' | 'heavy' | 'fang' | 'boots' | 'pierce';

export const ITEM_INFO: Record<ItemKind, { name: string; desc: string }> = {
  potion: { name: 'Blood Tonic', desc: 'Heal 40 HP' },
  twin: { name: 'Twin Barrel', desc: '+1 bullet per shot' },
  bounce: { name: 'Rubber Rounds', desc: 'Bullets ricochet off walls' },
  heavy: { name: 'Heavy Slugs', desc: '+50% knockback, +20% damage' },
  fang: { name: 'Vampire Fang', desc: 'Heal 4 HP per kill' },
  boots: { name: 'Quickstep Boots', desc: '+15% speed, faster dash' },
  pierce: { name: 'Bone Piercer', desc: 'Bullets pierce one enemy' },
};

export type StatKind = 'vit' | 'pow' | 'rof' | 'spd' | 'dash' | 'kick';

export const STAT_INFO: Record<StatKind, { name: string; desc: string }> = {
  vit: { name: 'Vitality', desc: '+25 max HP, heal 25' },
  pow: { name: 'Power', desc: '+30% bullet damage' },
  rof: { name: 'Trigger Finger', desc: '+20% fire rate' },
  spd: { name: 'Fleet Foot', desc: '+12% move speed' },
  dash: { name: 'Blink', desc: '-25% dash cooldown' },
  kick: { name: 'Mule Kick', desc: '+50% kick force, 2x kick dmg' },
};

/** Reliable (JSON text) channel. Inputs, pings and snapshots use the binary channel in shared/net/snapshot.ts. */
export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'choose'; idx: number }
  | { t: 'restart' };

export interface PlayerStats {
  speed: number;
  dashCd: number;
  fireCd: number;
  multishot: number;
  bounce: number;
  pierce: number;
  bulletR: number;
}

/** Rarely-changing per-player data, sent reliably on change instead of in every snapshot. */
export interface PlayerMeta {
  id: number;
  name: string;
  items: ItemKind[];
  choices: StatKind[] | null;
  stats: PlayerStats;
}

export interface PlayerSnap {
  id: number;
  name: string;
  c: number;
  x: number;
  y: number;
  aim: number;
  hp: number;
  maxHp: number;
  lvl: number;
  xp: number;
  xpNext: number;
  down: boolean;
  rev: number;
  dash: boolean;
  inv: boolean;
  items: ItemKind[];
  choices: StatKind[] | null;
  pending: number;
  kills: number;
  dashCd: number;
  off: boolean;
}

export interface EnemySnap {
  id: number;
  k: EnemyKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  a: number;
  s: number;
}

export interface BulletSnap {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  e: boolean;
  r: number;
  /** Owning player id (0 = enemy) and the input seq/index that spawned it (0 = not predicted). */
  o: number;
  sq: number;
  i: number;
  t0: number;
  x0: number;
  y0: number;
}

export interface PropSnap {
  id: number;
  x: number;
  y: number;
}

export interface ItemSnap {
  id: number;
  x: number;
  y: number;
  k: ItemKind;
}

export type GameEvent =
  | { e: 'shot'; x: number; y: number; a: number; p: number }
  | { e: 'eshot'; x: number; y: number; a: number }
  | { e: 'hit'; x: number; y: number; a: number; who: 'enemy' | 'player'; id: number; dmg: number; by?: number; sq?: number; bi?: number }
  | { e: 'die'; x: number; y: number; k: EnemyKind; a: number; id: number; by?: number }
  | { e: 'boom'; x: number; y: number; r: number }
  | { e: 'fall'; x: number; y: number; who: 'enemy' | 'player' }
  | { e: 'pickup'; x: number; y: number; k: ItemKind; p: number }
  | { e: 'level'; p: number; lvl: number }
  | { e: 'kick'; x: number; y: number; a: number; p: number }
  | { e: 'dash'; x: number; y: number; p: number }
  | { e: 'burn'; x: number; y: number }
  | { e: 'spark'; x: number; y: number; p?: number }
  | { e: 'slam'; x: number; y: number }
  | { e: 'down'; p: number }
  | { e: 'revive'; p: number }
  | { e: 'deflect'; x: number; y: number }
  | { e: 'msg'; text: string; big?: boolean }
  | { e: 'boss'; phase: number };

export type Phase = 'play' | 'over' | 'win';

/** Client-side decoded view of the world at one point in time. */
export interface WorldView {
  tick: number;
  phase: Phase;
  floor: number;
  left: number;
  stairs: boolean;
  players: PlayerSnap[];
  enemies: EnemySnap[];
  bullets: BulletSnap[];
  barrels: PropSnap[];
  items: ItemSnap[];
}

export interface FloorMsg {
  t: 'floor';
  floor: number;
  /** Increments on every floor load so stale snapshots from a previous map are dropped. */
  ep: number;
  boss: boolean;
  w: number;
  h: number;
  tiles: string;
  seed: number;
}

export type ServerMsg =
  | { t: 'joined'; code: string; id: number; token: string; tick: number }
  | { t: 'error'; msg: string; reason?: 'expired' | 'replaced' | 'full' | 'missing' }
  | { t: 'meta'; players: PlayerMeta[] }
  | FloorMsg;
