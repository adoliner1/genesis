import type { GameEvent, Phase } from '../protocol.ts';
import type { PlayerInput } from '../sim/input.ts';
import { MOVE_KEYS, newMoveState, type MoveState } from '../sim/movement.ts';
import { BinReader, BinWriter } from './bin.ts';

/*
 * Wire format for the unreliable channel. Snapshots are binary, quantized and delta-compressed
 * per field against the newest snapshot the client has acknowledged; anything the client can
 * derive (bullet flight from a (tick, pos, vel) anchor) is sent once and only resent on change.
 * Everything here tolerates loss and reordering so it can move to datagrams later.
 */

export const MSG_SNAP = 1;
export const MSG_PONG = 2;
export const MSG_INPUT = 1;
export const MSG_PING = 2;

type Field = 'u8' | 'u16' | 'i16' | 'u32' | 'uv';

export const P = { x: 0, y: 1, aim: 2, hp: 3, maxHp: 4, flags: 5, rev: 6, lvl: 7, xp: 8, xpNext: 9, kills: 10, pending: 11, dashCd: 12, c: 13 } as const;
export const PF = { down: 1, dash: 2, inv: 4, off: 8 } as const;
export const E = { k: 0, x: 1, y: 2, hp: 3, maxHp: 4, a: 5, s: 6 } as const;
export const B = { t0: 0, x: 1, y: 2, vx: 3, vy: 4, flags: 5, o: 6, sq: 7, i: 8 } as const;
export const X = { x: 0, y: 1 } as const;
export const I = { k: 0, x: 1, y: 2 } as const;

const SCHEMAS: Field[][] = [
  ['u16', 'u16', 'u8', 'uv', 'uv', 'u8', 'u8', 'u8', 'uv', 'uv', 'uv', 'u8', 'u8', 'u8'],
  ['u8', 'u16', 'u16', 'uv', 'uv', 'u8', 'u8'],
  ['u32', 'u16', 'u16', 'i16', 'i16', 'u8', 'uv', 'uv', 'u8'],
  ['u16', 'u16'],
  ['u8', 'u16', 'u16'],
];
export const TABLES = { players: 0, enemies: 1, bullets: 2, barrels: 3, items: 4 } as const;

export const ENEMY_KINDS = ['grunt', 'archer', 'brute', 'boss'] as const;
export const ITEM_KINDS = ['potion', 'twin', 'bounce', 'heavy', 'fang', 'boots', 'pierce'] as const;
const PHASES: Phase[] = ['play', 'over', 'win'];

export const qpos = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 8)));
export const dpos = (q: number) => q / 8;
const TAU = Math.PI * 2;
export const qang8 = (a: number) => Math.round((((a % TAU) + TAU) % TAU) * (256 / TAU)) & 0xff;
export const dang8 = (q: number) => (q * TAU) / 256;

export type Row = number[];
export type Table = Map<number, Row>;

export interface World {
  tick: number;
  ep: number;
  phase: Phase;
  floor: number;
  left: number;
  stairs: boolean;
  tables: Table[];
}

export interface Personal {
  /** Last input seq the server simulated for this client. */
  ack: number;
  /** Server-side input queue depth after consuming this tick's input (drives client pacing). */
  buf: number;
  /** Running count (mod 65536) of ticks the server had no input for this client and had to guess. */
  starved: number;
  self: MoveState | null;
  events: [number, GameEvent[]][];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeField(w: BinWriter, f: Field, v: number) {
  switch (f) {
    case 'u8':
      return w.u8(v);
    case 'u16':
      return w.u16(v);
    case 'i16':
      return w.i16(v);
    case 'u32':
      return w.u32(v);
    case 'uv':
      return w.uv(v);
  }
}

function readField(r: BinReader, f: Field): number {
  switch (f) {
    case 'u8':
      return r.u8();
    case 'u16':
      return r.u16();
    case 'i16':
      return r.i16();
    case 'u32':
      return r.u32();
    case 'uv':
      return r.uv();
  }
}

export function encodeSnapshot(cur: World, base: World | null, me: Personal): Uint8Array {
  const w = new BinWriter();
  w.u8(MSG_SNAP);
  w.u32(cur.tick);
  w.u32(base ? base.tick : 0);
  w.u16(cur.ep);
  w.u8(PHASES.indexOf(cur.phase));
  w.u8(cur.floor);
  w.uv(cur.left);
  w.u8(cur.stairs ? 1 : 0);

  w.u32(me.ack);
  w.i8(Math.max(-128, Math.min(127, me.buf)));
  w.u16(me.starved);
  w.u8(me.self ? 1 : 0);
  if (me.self) for (const k of MOVE_KEYS) w.f32(Number(me.self[k]));

  for (let t = 0; t < SCHEMAS.length; t++) {
    const schema = SCHEMAS[t];
    const rows = cur.tables[t];
    const prev = base?.tables[t];
    const wide = schema.length > 8;
    const recs: [number, number, Row][] = [];
    for (const [id, row] of rows) {
      const old = prev?.get(id);
      let mask = 0;
      for (let f = 0; f < schema.length; f++) if (!old || old[f] !== row[f]) mask |= 1 << f;
      if (mask) recs.push([id, mask, row]);
    }
    w.uv(recs.length);
    let last = 0;
    for (const [id, mask, row] of recs) {
      w.uv(id - last);
      last = id;
      if (wide) w.u16(mask);
      else w.u8(mask);
      for (let f = 0; f < schema.length; f++) if (mask & (1 << f)) writeField(w, schema[f], row[f]);
    }
    const gone: number[] = [];
    if (prev) for (const id of prev.keys()) if (!rows.has(id)) gone.push(id);
    w.uv(gone.length);
    last = 0;
    for (const id of gone) {
      w.uv(id - last);
      last = id;
    }
  }
  if (me.events.length) w.bytes(enc.encode(JSON.stringify(me.events)));
  else w.uv(0);
  return w.done();
}

export interface DecodedSnapshot {
  world: World;
  me: Personal;
  baseTick: number;
}

/** Returns null when the referenced baseline is no longer available on this side. */
export function decodeSnapshot(buf: Uint8Array, baseline: (tick: number) => World | undefined): DecodedSnapshot | null {
  const r = new BinReader(buf);
  if (r.u8() !== MSG_SNAP) return null;
  const tick = r.u32();
  const baseTick = r.u32();
  const base = baseTick ? baseline(baseTick) : undefined;
  if (baseTick && !base) return null;
  const ep = r.u16();
  const phase = PHASES[r.u8()] ?? 'play';
  const floor = r.u8();
  const left = r.uv();
  const stairs = r.u8() === 1;

  const ack = r.u32();
  const bufDepth = r.i8();
  const starved = r.u16();
  let self: MoveState | null = null;
  if (r.u8()) {
    self = newMoveState();
    const s = self as unknown as Record<string, number | boolean>;
    for (const k of MOVE_KEYS) s[k] = r.f32();
    self.down = !!s.down;
  }

  const tables: Table[] = [];
  for (let t = 0; t < SCHEMAS.length; t++) {
    const schema = SCHEMAS[t];
    const wide = schema.length > 8;
    const prev = base?.tables[t];
    const out: Table = new Map(prev ?? []);
    const n = r.uv();
    let id = 0;
    for (let i = 0; i < n; i++) {
      id += r.uv();
      const mask = wide ? r.u16() : r.u8();
      const row = (prev?.get(id) ?? new Array(schema.length).fill(0)).slice();
      for (let f = 0; f < schema.length; f++) if (mask & (1 << f)) row[f] = readField(r, schema[f]);
      out.set(id, row);
    }
    const gone = r.uv();
    id = 0;
    for (let i = 0; i < gone; i++) {
      id += r.uv();
      out.delete(id);
    }
    tables.push(out);
  }
  const evBytes = r.bytes();
  const events = evBytes.length ? (JSON.parse(dec.decode(evBytes)) as [number, GameEvent[]][]) : [];
  return {
    world: { tick, ep, phase, floor, left, stairs, tables },
    me: { ack, buf: bufDepth, starved, self, events },
    baseTick,
  };
}

export function encodeInputs(ackTick: number, inputs: PlayerInput[]): Uint8Array {
  const w = new BinWriter();
  w.u8(MSG_INPUT);
  w.u32(ackTick);
  w.u8(inputs.length);
  w.u32(inputs.length ? inputs[0].seq : 0);
  for (const i of inputs) {
    w.i8(i.mx);
    w.i8(i.my);
    w.u16(i.aim);
    w.u8(i.buttons);
    w.u32(i.vt8);
  }
  return w.done();
}

export function decodeInputs(buf: Uint8Array): { ackTick: number; inputs: PlayerInput[] } | null {
  try {
    const r = new BinReader(buf);
    if (r.u8() !== MSG_INPUT) return null;
    const ackTick = r.u32();
    const n = r.u8();
    const first = r.u32();
    const inputs: PlayerInput[] = [];
    for (let k = 0; k < n; k++) inputs.push({ seq: first + k, mx: r.i8(), my: r.i8(), aim: r.u16(), buttons: r.u8(), vt8: r.u32() });
    return { ackTick, inputs };
  } catch {
    return null;
  }
}

export function encodePing(t: number): Uint8Array {
  const w = new BinWriter();
  w.u8(MSG_PING);
  w.f64(t);
  return w.done();
}

export function encodePong(t: number, tick: number): Uint8Array {
  const w = new BinWriter();
  w.u8(MSG_PONG);
  w.f64(t);
  w.u32(tick);
  return w.done();
}

export function decodePong(buf: Uint8Array): { t: number; tick: number } {
  const r = new BinReader(buf);
  r.u8();
  return { t: r.f64(), tick: r.u32() };
}
