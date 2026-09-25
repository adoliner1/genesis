import type { GameEvent, Phase } from '../protocol.ts';
import type { PlayerInput } from '../sim/input.ts';
import { MOVE_KEYS, newMoveState, ogreBody, type MoveState, type SimBody, type SimRope } from '../sim/player.ts';
import { BinReader, BinWriter } from './bin.ts';

/*
 * Wire format for the unreliable channel. Snapshots are binary, quantized and delta-compressed
 * per field against the newest snapshot the client has acknowledged. Everything here tolerates
 * loss and reordering.
 */

export const MSG_SNAP = 1;
export const MSG_PONG = 2;
export const MSG_INPUT = 1;
export const MSG_PING = 2;

type Field = 'u8' | 'u16' | 'i16' | 'u32' | 'uv';

/** Player row. Positions are 1/8 px. */
export const P = { x: 0, y: 1, flags: 2, par: 3, pm: 4, ox: 5, oy: 6, rax: 7, ray: 8, c: 9, k: 10, aim: 11, vx: 12, held: 13 } as const;
export const PF = { heavy: 1, gnd: 2, pound: 4, rope: 8, left: 16, stun: 32, off: 64 } as const;
/** Level object row (lifts, gates, hooks, switches...). */
export const BD = { k: 0, x: 1, y: 2, w: 3, h: 4, s: 5 } as const;
export const RP = { ax: 0, ay: 1, len: 2, o: 3 } as const;
export const AR = { x: 0, y: 1, a: 2, stuck: 3 } as const;

const SCHEMAS: Field[][] = [
  ['u16', 'u16', 'u8', 'uv', 'u8', 'i16', 'i16', 'u16', 'u16', 'u8', 'u8', 'u8', 'i16', 'uv'],
  ['u8', 'u16', 'u16', 'u16', 'u16', 'u8'],
  ['u16', 'u16', 'u16', 'uv'],
  ['u16', 'u16', 'u8', 'u8'],
];
export const TABLES = { players: 0, bodies: 1, ropes: 2, arrows: 3 } as const;

export const CHAR_WIRE = ['ogre', 'archer'] as const;
const PHASES: Phase[] = ['play', 'win'];

export const qpos = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 8)));
export const dpos = (q: number) => q / 8;
export const qoff = (v: number) => Math.round(v * 8);
const TAU = Math.PI * 2;
export const qang8 = (a: number) => Math.round((((a % TAU) + TAU) % TAU) * (256 / TAU)) & 0xff;
export const dang8 = (q: number) => (q * TAU) / 256;

export type Row = number[];
export type Table = Map<number, Row>;

export interface World {
  tick: number;
  ep: number;
  phase: Phase;
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

  w.u32(me.ack);
  w.i8(Math.max(-128, Math.min(127, me.buf)));
  w.u16(me.starved);
  w.u8(me.self ? 1 : 0);
  if (me.self) for (const k of MOVE_KEYS) w.f64(me.self[k]);

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

  const ack = r.u32();
  const bufDepth = r.i8();
  const starved = r.u16();
  let self: MoveState | null = null;
  if (r.u8()) {
    self = newMoveState();
    for (const k of MOVE_KEYS) self[k] = r.f64();
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
    world: { tick, ep, phase, tables },
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
    w.u16(i.buttons);
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
    for (let k = 0; k < n; k++) inputs.push({ seq: first + k, mx: r.i8(), my: r.i8(), aim: r.u16(), buttons: r.u16(), vt8: r.u32() });
    if (r.left < 0) return null;
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

/** Collision bodies as they appear in a snapshot (level objects plus ogre heads). */
export function simBodies(w: World): SimBody[] {
  const out: SimBody[] = [];
  for (const [id, r] of w.tables[TABLES.bodies]) out.push({ id, k: r[BD.k], x: dpos(r[BD.x]), y: dpos(r[BD.y]), w: dpos(r[BD.w]), h: dpos(r[BD.h]), s: r[BD.s] });
  for (const [id, r] of w.tables[TABLES.players]) if (CHAR_WIRE[r[P.k]] === 'ogre' && !(r[P.flags] & PF.off)) out.push(ogreBody(id, dpos(r[P.x]), dpos(r[P.y])));
  return out;
}

export function simRopes(w: World): SimRope[] {
  return [...w.tables[TABLES.ropes]].map(([id, r]) => ({ id, ax: dpos(r[RP.ax]), ay: dpos(r[RP.ay]), len: dpos(r[RP.len]) }));
}
