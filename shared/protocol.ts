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

export type CharKind = 'archer' | 'knight';
export const CHAR_KINDS: CharKind[] = ['archer', 'knight'];

export interface CharInfo {
  name: string;
  role: string;
  blurb: string;
  weight: string;
  controls: [string, string][];
  help: string;
}

export const CHAR_INFO: Record<CharKind, CharInfo> = {
  archer: {
    name: 'Archer',
    role: 'Fragile, fast sharpshooter',
    blurb: 'Fastest thing in the Boneyard. Sprint, slide, loose an arrow mid-glide. Mobility is the only armor.',
    weight: 'Light · takes 120% knockback',
    controls: [
      ['LMB', 'Hold to draw, release to fire. Full draw pierces'],
      ['RMB / F', 'Pin Trap: roots the first enemy to cross it (2 charges)'],
      ['Hold Shift', 'Sprint: builds speed, drifts on turns, no shooting'],
      ['Release + tap Shift', 'Slide: straight glide you can shoot from (2 charges)'],
      ['Passive', 'Arrows fly faster when standing still or sliding'],
    ],
    help: 'LMB hold+release shoot · RMB/F trap · hold Shift sprint · release, tap Shift slide',
  },
  knight: {
    name: 'Knight',
    role: 'Sword and shield, nothing else',
    blurb: 'March in behind the shield, bash to close, cut them down. Time your slash to send shots back.',
    weight: 'Heavy · takes 75% knockback',
    controls: [
      ['LMB', 'Slash: wide 140° swing, deflects projectiles'],
      ['Hold RMB / F', 'Shield: blocks toward the cursor, slows you, drains guard'],
      ['Space / Shift', 'Shield Bash: hop forward shoving enemies (2 charges)'],
      ['Hold through bash', 'Shield Skid: grind on into a slide, slash on the move'],
    ],
    help: 'LMB slash · hold RMB/F shield · Space bash · hold Space through it to skid',
  },
};

export type ItemKind = 'potion' | 'sigil' | 'ricochet' | 'heavy' | 'fang' | 'boots' | 'charm';

type PerKit = string | Record<CharKind, string>;
const perKit = (d: PerKit, k: CharKind) => (typeof d === 'string' ? d : d[k]);

const ITEM_TEXT: Record<ItemKind, { name: string; desc: PerKit }> = {
  potion: { name: 'Blood Tonic', desc: 'Heal 40 HP' },
  sigil: { name: 'Twin Sigil', desc: { archer: '+1 arrow per shot', knight: 'Slash arc +30°, reach +15%' } },
  ricochet: { name: 'Ricochet Charm', desc: { archer: 'Arrows ricochet off walls twice', knight: 'Deflected shots ricochet and hit 50% harder' } },
  heavy: { name: 'Heavy Hand', desc: '+50% knockback dealt, +20% damage' },
  fang: { name: 'Vampire Fang', desc: 'Heal 4 HP per kill' },
  boots: { name: 'Quickstep Boots', desc: { archer: '+12% speed, slides recharge 25% faster', knight: '+12% speed, bash recharges 25% faster' } },
  charm: { name: 'Marrow Charm', desc: { archer: '+1 Pin Trap charge, arrows pierce one more enemy', knight: '+1 Shield Bash charge, +25 guard' } },
};

export const itemInfo = (k: ItemKind, c: CharKind) => ({ name: ITEM_TEXT[k].name, desc: perKit(ITEM_TEXT[k].desc, c) });

export type StatKind = 'vit' | 'pow' | 'atk' | 'spd' | 'ability' | 'special';

const STAT_TEXT: Record<StatKind, Record<CharKind, { name: string; desc: string }> | { name: string; desc: string }> = {
  vit: { name: 'Vitality', desc: '+25 max HP, heal 25' },
  pow: { name: 'Power', desc: '+30% damage' },
  atk: { archer: { name: 'Quick Draw', desc: 'Full draw 20% faster' }, knight: { name: 'Swift Blade', desc: 'Slash recovers 20% faster' } },
  spd: { name: 'Fleet Foot', desc: '+12% move speed' },
  ability: { archer: { name: 'Light Step', desc: 'Slides recharge 30% faster' }, knight: { name: 'Bash Drill', desc: 'Shield Bash recharges 30% faster' } },
  special: {
    archer: { name: 'Barbed Traps', desc: 'Traps root 50% longer, deal 12 damage, recharge faster' },
    knight: { name: 'Bulwark', desc: '+40 guard, blocked hits cost 30% less guard' },
  },
};

export function statInfo(s: StatKind, c: CharKind): { name: string; desc: string } {
  const t = STAT_TEXT[s];
  return 'name' in t ? (t as { name: string; desc: string }) : (t as Record<CharKind, { name: string; desc: string }>)[c];
}

/** Reliable (JSON text) channel. Inputs, pings and snapshots use the binary channel in shared/net/snapshot.ts. */
export type ClientMsg =
  | { t: 'create'; name: string; char: CharKind }
  | { t: 'join'; code: string; name: string; char: CharKind }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'choose'; idx: number }
  | { t: 'restart' };

/** Everything the client needs to predict its own kit: controller tunables plus projectile modifiers. */
export interface PlayerStats {
  speed: number;
  atkCd: number;
  abCd: number;
  abMax: number;
  specCd: number;
  specMax: number;
  drawTicks: number;
  guardMax: number;
  multishot: number;
  bounce: number;
  pierce: number;
  bulletR: number;
  /** Knight slash half-angle (radians) and reach (px). */
  arc: number;
  reach: number;
}

/** Rarely-changing per-player data, sent reliably on change instead of in every snapshot. */
export interface PlayerMeta {
  id: number;
  name: string;
  char: CharKind;
  items: ItemKind[];
  choices: StatKind[] | null;
  stats: PlayerStats;
}

export interface PlayerSnap {
  id: number;
  name: string;
  c: number;
  k: CharKind;
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
  inv: boolean;
  off: boolean;
  /** Knight shield raised / leading a bash. */
  block: boolean;
  /** Movement mode (see MODE in shared/sim/movement). */
  mode: number;
  /** Archer draw fraction 0..1. */
  draw: number;
  items: ItemKind[];
  choices: StatKind[] | null;
  pending: number;
  kills: number;
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
  rooted: boolean;
}

export interface BulletSnap {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  e: boolean;
  r: number;
  arrow: boolean;
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

export interface TrapSnap {
  id: number;
  x: number;
  y: number;
  /** Owner's player color index. */
  c: number;
}

export interface ItemSnap {
  id: number;
  x: number;
  y: number;
  k: ItemKind;
}

export type GameEvent =
  | { e: 'shot'; x: number; y: number; a: number; p: number; pw: number }
  | { e: 'eshot'; x: number; y: number; a: number }
  | { e: 'hit'; x: number; y: number; a: number; who: 'enemy' | 'player'; id: number; dmg: number; by?: number; sq?: number; bi?: number }
  | { e: 'die'; x: number; y: number; k: EnemyKind; a: number; id: number; by?: number }
  | { e: 'boom'; x: number; y: number; r: number }
  | { e: 'fall'; x: number; y: number; who: 'enemy' | 'player' }
  | { e: 'pickup'; x: number; y: number; k: ItemKind; p: number }
  | { e: 'level'; p: number; lvl: number }
  | { e: 'slash'; x: number; y: number; a: number; p: number; arc: number; reach: number }
  | { e: 'bash'; x: number; y: number; a: number; p: number }
  | { e: 'slide'; x: number; y: number; p: number }
  | { e: 'sprint'; x: number; y: number; p: number }
  | { e: 'trap'; x: number; y: number; x0: number; y0: number; p: number }
  | { e: 'snare'; x: number; y: number; id: number }
  | { e: 'block'; x: number; y: number; a: number; p: number; broke?: boolean }
  | { e: 'shove'; x: number; y: number; a: number }
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
  traps: TrapSnap[];
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
  /** Team's explored tiles (bitset, base64) so late joiners and reconnects keep the revealed map. */
  | { t: 'fog'; ep: number; explored: string }
  | FloorMsg;
