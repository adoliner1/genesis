export const TILE = 16;
/** Simulation rate. Platforming wants 60 Hz; snapshots go out at a divisor of this (see server SEND_EVERY). */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const MAX_PLAYERS = 4;

export const PLAYER_COLORS = ['#4fc3ff', '#ff6b8b', '#ffd23f', '#7dff8a'];

export type CharKind = 'ogre' | 'archer';
export const CHAR_KINDS: CharKind[] = ['ogre', 'archer'];

export interface CharInfo {
  name: string;
  blurb: string;
  controls: [string, string][];
}

export const CHAR_INFO: Record<CharKind, CharInfo> = {
  ogre: {
    name: 'Ogre',
    blurb: 'Big, slow and in charge of his own mass. Teammates can ride on his head.',
    controls: [
      ['RMB', 'Toggle heavy: sinks pulleys, holds heavy plates, snaps ropes'],
      ['Shift (heavy, in air)', 'Ground pound: launches anyone standing nearby'],
      ['E', 'Grab a teammate / grab a hook · E or LMB again to throw toward the cursor'],
    ],
  },
  archer: {
    name: 'Archer',
    blurb: 'Light and quick. Swings on ropes and leaves them behind for the team.',
    controls: [
      ['LMB', 'Shoot an arrow (hits targets)'],
      ['RMB', 'Rope arrow: sticks to wood beams, then swing'],
      ['W / S', 'Climb up / down a rope'],
      ['E (on your rope)', 'Let go and leave the rope for others'],
    ],
  },
};

export const COMMON_CONTROLS: [string, string][] = [
  ['A / D', 'Move'],
  ['Space', 'Jump (also lets go of ropes, hooks and escapes a carry)'],
  ['S', 'Drop through thin platforms'],
  ['E', 'Grab ropes and hooks, pull levers (hold E in the air to catch a rope)'],
  ['Hold R', 'Restart the level for everyone'],
];

/** Reliable (JSON text) channel. Inputs, pings and snapshots use the binary channel in shared/net/snapshot.ts. */
export type ClientMsg =
  | { t: 'create'; name: string; char: CharKind }
  | { t: 'join'; code: string; name: string; char: CharKind }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'restart' }
  /** Dev: jump to a checkpoint (index into the level's checkpoints). */
  | { t: 'warp'; cp: number };

export interface PlayerMeta {
  id: number;
  name: string;
  char: CharKind;
  c: number;
}

export interface LevelMsg {
  t: 'level';
  /** Increments on every (re)load so stale snapshots from a previous attempt are dropped. */
  ep: number;
  name: string;
  w: number;
  h: number;
  tiles: string;
  signs: { x: number; y: number; text: string }[];
}

export type ServerMsg =
  | { t: 'joined'; code: string; id: number; token: string }
  | { t: 'error'; msg: string; reason?: 'expired' | 'replaced' | 'full' | 'missing' }
  | { t: 'meta'; players: PlayerMeta[] }
  | LevelMsg;

export type GameEvent =
  | { e: 'msg'; text: string; big?: boolean }
  | { e: 'jump'; p: number; x: number; y: number }
  | { e: 'land'; p: number; x: number; y: number; hard: boolean }
  | { e: 'pound'; p: number; x: number; y: number }
  | { e: 'launch'; p: number; x: number; y: number }
  | { e: 'heavy'; p: number; on: boolean }
  | { e: 'rope'; p: number; x: number; y: number; hit: boolean }
  | { e: 'snap'; x: number; y: number }
  | { e: 'grab'; p: number; who: number }
  | { e: 'throw'; p: number; who: number }
  | { e: 'die'; p: number; x: number; y: number }
  | { e: 'switch'; x: number; y: number; on: boolean }
  | { e: 'thunk'; x: number; y: number }
  | { e: 'win' };

export type Phase = 'play' | 'win';
