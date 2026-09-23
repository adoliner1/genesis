import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CHAR_KINDS,
  ENEMY_R,
  FLOORS,
  MAX_PLAYERS,
  T,
  TICK_RATE,
  TILE,
  spikeState,
  type CharKind,
  type ClientMsg,
  type EnemyKind,
  type FloorMsg,
  type GameEvent,
  type ItemKind,
  type Phase,
  type PlayerMeta,
  type ServerMsg,
  type StatKind,
} from '../shared/protocol.ts';
import { HELD_MASK, PRESS_MASK, neutralInput, type PlayerInput } from '../shared/sim/input.ts';
import { collides, los, moveBody, solid, tileAt } from '../shared/sim/map.ts';
import { DT, MODE, PLAYER_R, newMoveState, pickMove, resetKit, type MoveState, type MoveStats, type StepResult } from '../shared/sim/movement.ts';
import { KITS } from '../shared/sim/kits/index.ts';
import { arrowShot, arrowVolley, trapSpot } from '../shared/sim/kits/archer.ts';
import { shieldCovers } from '../shared/sim/kits/knight.ts';
import { DEAD, BOUNCED, bulletHalfStep } from '../shared/sim/bullets.ts';
import {
  B,
  BF,
  CHAR_WIRE,
  E,
  ENEMY_KINDS,
  ES_ROOTED,
  I,
  ITEM_KINDS,
  X,
  dpos,
  MSG_INPUT,
  MSG_PING,
  PF,
  decodeInputs,
  encodePong,
  encodeSnapshot,
  qang8,
  qpos,
  type Table,
  type World,
} from '../shared/net/snapshot.ts';
import { generateFloor, type FloorData } from './dungeon.ts';
import { Vision, type Viewer } from './vision.ts';

const START_FLOOR = Math.min(FLOORS, Math.max(1, Number(process.env.START_FLOOR) || 1));
const STATS: StatKind[] = ['vit', 'pow', 'atk', 'spd', 'ability', 'special'];
const PASSIVES: ItemKind[] = ['sigil', 'ricochet', 'heavy', 'fang', 'boots', 'charm'];
/** Wall impact speed (px/s) above which a launched player takes slam damage. */
const PLAYER_SLAM = 170;
const TRAP_LIFE = TICK_RATE * 12;
const TRAPS_PER_PLAYER = 3;
/** Furthest back (in ticks) the server will rewind targets for a shooter's view. */
const MAX_REWIND = process.env.LAG_COMP === '0' ? 0 : 18;
const HIST = 32;
const WORLD_HISTORY = 64;
/** Input queue depth above which the server fast-forwards a player to cut latency. */
const MAX_INPUT_BUF = 12;
const OFFLINE_TICKS = TICK_RATE * 90;

interface NetState {
  ws: WebSocket | null;
  token: string;
  offline: boolean;
  offlineAt: number;
  queue: Map<number, PlayerInput>;
  nextSeq: number;
  last: PlayerInput;
  ack: number;
  buf: number;
  starved: number;
  /** Consecutive ticks without a real input; guesses decay to neutral so an idle tab stops moving. */
  streak: number;
  newest: number;
  /** Seqs the server had to guess; a late copy's dash/kick is carried into the next input. */
  guessed: Set<number>;
  carry: number;
  snapAck: number;
  /** Newest input seq seen, so snapshot acks follow packet order (and can reset after a rejoin). */
  ackFrom: number;
  metaKey: string;
}

interface Player extends MoveState, MoveStats {
  id: number;
  name: string;
  c: number;
  char: CharKind;
  net: NetState;
  hp: number;
  maxHp: number;
  /** Damage multiplier. */
  pow: number;
  knockTaken: number;
  mass: number;
  arc: number;
  reach: number;
  deflectMult: number;
  guardCost: number;
  trapRoot: number;
  trapDmg: number;
  bashHit: Set<number>;
  invuln: number;
  hazT: number;
  lvl: number;
  xp: number;
  xpNext: number;
  pending: StatKind[][];
  items: ItemKind[];
  multishot: number;
  bounce: number;
  knock: number;
  lifesteal: number;
  pierce: number;
  bulletR: number;
  rev: number;
  safeX: number;
  safeY: number;
  kills: number;
}

interface Enemy {
  id: number;
  k: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hp: number;
  maxHp: number;
  mass: number;
  speed: number;
  a: number;
  s: number;
  timer: number;
  cd: number;
  atkT: number;
  stagger: number;
  invuln: number;
  hazT: number;
  root: number;
  slow: number;
  aggro: boolean;
  dirX: number;
  dirY: number;
  pattern: number;
  reps: number;
  phase2: boolean;
  born: number;
  hx: Float64Array;
  hy: Float64Array;
}

interface Bullet {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  enemy: boolean;
  arrow: boolean;
  pid: number;
  seq: number;
  idx: number;
  /** Shooter's view lag in ticks: enemies are tested where the shooter saw them. */
  lag: number;
  dmg: number;
  knock: number;
  life: number;
  bounce: number;
  pierce: number;
  r: number;
  hit: Set<number>;
  t0: number;
  x0: number;
  y0: number;
  dirty: boolean;
}

interface Barrel {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
  kicker: number;
}

interface Trap {
  id: number;
  x: number;
  y: number;
  pid: number;
  c: number;
  life: number;
  /** Ticks until it can trigger (the arrow is still landing). */
  arm: number;
}

interface Item {
  id: number;
  x: number;
  y: number;
  k: ItemKind;
}

const ENEMY_DEFS: Record<EnemyKind, { hp: number; r: number; mass: number; speed: number; xp: number }> = {
  grunt: { hp: 30, r: ENEMY_R.grunt, mass: 1, speed: 58, xp: 6 },
  archer: { hp: 22, r: ENEMY_R.archer, mass: 0.9, speed: 48, xp: 8 },
  brute: { hp: 70, r: ENEMY_R.brute, mass: 2.4, speed: 40, xp: 14 },
  boss: { hp: 2200, r: ENEMY_R.boss, mass: 12, speed: 42, xp: 0 },
};

/** What one team is allowed to know: its own filtered snapshot history and event log. */
interface TeamFeed {
  worlds: Map<number, World>;
  events: [number, GameEvent[]][];
  /** Bullets first seen mid-flight are re-anchored where they became visible, so their origin stays hidden. */
  anchors: Map<number, { t0: number; at: [number, number, number] }>;
}

const len = (x: number, y: number) => Math.sqrt(x * x + y * y);
const r1 = (v: number) => Math.round(v * 10) / 10;
const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export class Room {
  code: string;
  players = new Map<number, Player>();
  enemies: Enemy[] = [];
  bullets: Bullet[] = [];
  barrels: Barrel[] = [];
  items: Item[] = [];
  traps: Trap[] = [];
  events: GameEvent[] = [];
  tick = 0;
  phase: Phase = 'play';
  floor = 1;
  ep = 0;
  map!: FloorData;
  stairsOpen = false;
  flow = new Int32Array(0);
  nextId = 1;
  winTimer = -1;
  floorMsg!: FloorMsg;
  runSeed = (Math.random() * 1e9) | 0;
  feeds = new Map<number, TeamFeed>();
  vision!: Vision;
  bytesOut = 0;
  lagLog: number[] = [];

  constructor(code: string) {
    this.code = code;
    this.loadFloor(START_FLOOR);
  }

  get empty() {
    return this.players.size === 0;
  }

  private online() {
    return [...this.players.values()].filter((p) => !p.net.offline);
  }

  addPlayer(ws: WebSocket, name: string, char: unknown): Player | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const used = new Set([...this.players.values()].map((p) => p.c));
    let c = 0;
    while (used.has(c)) c++;
    const p = this.newPlayer(ws, name, c, CHAR_KINDS.includes(char as CharKind) ? (char as CharKind) : 'archer');
    const anchor = this.online().find((o) => !o.down);
    const sx = anchor ? anchor.x : this.map.spawn.x;
    const sy = anchor ? anchor.y : this.map.spawn.y;
    p.x = p.safeX = sx + (c % 2 ? 8 : -8);
    p.y = p.safeY = sy + (c > 1 ? 8 : 0);
    const partyLvl = Math.max(0, ...[...this.players.values()].map((o) => o.lvl));
    const target = Math.max(partyLvl, 1 + (this.floor - 1) * 2);
    while (p.lvl < target) this.gainXp(p, p.xpNext - p.xp);
    for (let i = 0; i < (this.floor - 1) * 2; i++) this.applyItem(p, PASSIVES[Math.floor(Math.random() * PASSIVES.length)]);
    resetKit(p, p);
    this.players.set(p.id, p);
    for (const e of this.enemies)
      if (e.k === 'boss' && e.hp === e.maxHp) e.hp = e.maxHp = Math.round(ENEMY_DEFS.boss.hp * (0.6 + 0.4 * this.players.size));
    this.greet(p);
    this.events.push({ e: 'msg', text: `${p.name} joined the party` });
    return p;
  }

  /** Reattach a socket to an existing slot. Returns null if the token is unknown (slot expired). */
  rejoin(ws: WebSocket, token: string): Player | null {
    const p = [...this.players.values()].find((o) => o.net.token === token);
    if (!p) return null;
    const old = p.net.ws;
    if (old && old !== ws) {
      this.sendTo(old, { t: 'error', msg: 'This slot was opened in another tab.', reason: 'replaced' });
      old.close();
    }
    const wasOffline = p.net.offline;
    Object.assign(p.net, { ws, offline: false, queue: new Map(), guessed: new Set(), carry: 0, nextSeq: 0, newest: 0, streak: 0, snapAck: 0, ackFrom: 0, metaKey: '', buf: 0 });
    p.invuln = Math.max(p.invuln, 45);
    this.greet(p);
    if (wasOffline) this.events.push({ e: 'msg', text: `${p.name} reconnected` });
    return p;
  }

  disconnect(id: number, ws: WebSocket) {
    const p = this.players.get(id);
    if (!p || p.net.ws !== ws) return;
    p.net.ws = null;
    p.net.offline = true;
    p.net.offlineAt = this.tick;
    p.vx = p.vy = 0;
    this.events.push({ e: 'msg', text: `${p.name} lost connection — holding their slot` });
    this.checkWipe();
  }

  private greet(p: Player) {
    this.send(p, { t: 'joined', code: this.code, id: p.id, token: p.net.token, tick: this.tick });
    this.send(p, this.floorMsg);
    this.send(p, { t: 'fog', ep: this.ep, explored: this.vision.explored(this.teamOf(p)) });
    this.send(p, { t: 'meta', players: this.metas() });
  }

  /** Everyone is on one co-op team today; vision, snapshots and events are already split per team. */
  teamOf(_p: Player): number {
    return 0;
  }

  removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.events.push({ e: 'msg', text: `${p.name} left` });
    this.checkWipe();
  }

  private newNet(ws: WebSocket | null): NetState {
    return {
      ws,
      token: randomBytes(12).toString('hex'),
      offline: false,
      offlineAt: 0,
      queue: new Map(),
      nextSeq: 0,
      last: neutralInput(0),
      ack: 0,
      buf: 0,
      starved: 0,
      streak: 0,
      newest: 0,
      guessed: new Set(),
      carry: 0,
      snapAck: 0,
      ackFrom: 0,
      metaKey: '',
    };
  }

  private newPlayer(ws: WebSocket | null, name: string, c: number, char: CharKind): Player {
    const kit = KITS[char];
    const p: Player = {
      ...newMoveState(),
      ...kit.stats,
      id: this.nextId++,
      name: name.slice(0, 14) || 'Crawler',
      c,
      char,
      net: this.newNet(ws),
      hp: kit.hp,
      maxHp: kit.hp,
      pow: 1,
      knockTaken: kit.knockTaken,
      mass: kit.mass,
      arc: 1.22,
      reach: 22,
      deflectMult: 1,
      guardCost: 1,
      trapRoot: 36,
      trapDmg: 0,
      bashHit: new Set(),
      invuln: 30,
      hazT: 0,
      lvl: 1,
      xp: 0,
      xpNext: 25,
      pending: [],
      items: [],
      multishot: 1,
      bounce: 0,
      knock: 1,
      lifesteal: 0,
      pierce: 0,
      bulletR: 2,
      rev: 0,
      safeX: 0,
      safeY: 0,
      kills: 0,
    };
    resetKit(p, p);
    return p;
  }

  handle(p: Player, msg: ClientMsg) {
    switch (msg.t) {
      case 'choose': {
        const set = p.pending[0];
        if (!set) break;
        const s = set[msg.idx];
        if (!s) break;
        p.pending.shift();
        this.applyStat(p, s);
        break;
      }
      case 'restart':
        if (this.phase !== 'play') this.restartRun();
        break;
    }
  }

  handleBinary(p: Player, data: Uint8Array) {
    if (data[0] === MSG_PING) {
      if (p.net.ws && data.length >= 9) {
        const t = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(1, true);
        this.sendBin(p, encodePong(t, this.tick));
      }
      return;
    }
    if (data[0] !== MSG_INPUT) return;
    const m = decodeInputs(data);
    if (!m) return;
    const n = p.net;
    if (!m.inputs.length) return;
    const newest = m.inputs[m.inputs.length - 1].seq;
    n.newest = Math.max(n.newest, newest);
    if (newest >= n.ackFrom && m.ackTick <= this.tick) {
      n.ackFrom = newest;
      n.snapAck = m.ackTick;
    }
    // Start from the oldest redundant copy so the jitter buffer begins non-empty.
    if (!n.nextSeq || m.inputs[0].seq >= n.nextSeq + 256) {
      n.nextSeq = m.inputs[0].seq;
      n.queue.clear();
    }
    for (const inp of m.inputs) {
      if (inp.seq >= n.nextSeq && inp.seq < n.nextSeq + 256 && !n.queue.has(inp.seq)) n.queue.set(inp.seq, inp);
      else if (n.guessed.delete(inp.seq)) n.carry |= inp.buttons & PRESS_MASK;
    }
  }

  /** Pops this tick's input. A missing input is replaced by the last one (minus one-shot buttons). */
  private takeInput(p: Player): PlayerInput | null {
    const n = p.net;
    if (!n.nextSeq) return null;
    let inp = n.queue.get(n.nextSeq);
    if (inp) {
      n.queue.delete(n.nextSeq);
      n.streak = 0;
    } else {
      inp = ++n.streak > 4 ? { ...neutralInput(n.nextSeq), aim: n.last.aim } : { ...n.last, seq: n.nextSeq, buttons: n.last.buttons & HELD_MASK };
      n.starved++;
      n.guessed.add(n.nextSeq);
      if (n.guessed.size > 64) n.guessed.delete(n.guessed.values().next().value!);
    }
    if (n.carry) {
      inp = { ...inp, buttons: inp.buttons | n.carry };
      n.carry = 0;
    }
    n.last = inp;
    n.ack = n.nextSeq++;
    return inp;
  }

  private restartRun() {
    this.runSeed = (Math.random() * 1e9) | 0;
    for (const [id, old] of this.players) {
      const p = this.newPlayer(null, old.name, old.c, old.char);
      p.id = id;
      p.net = old.net;
      p.net.metaKey = '';
      this.players.set(id, p);
    }
    this.phase = 'play';
    this.winTimer = -1;
    this.loadFloor(1);
  }

  private loadFloor(n: number) {
    this.floor = n;
    this.ep++;
    const boss = n === FLOORS;
    this.map = generateFloor(n, this.runSeed + n * 7919, boss);
    this.vision = new Vision(this.map);
    this.enemies = [];
    this.bullets = [];
    this.items = [];
    this.barrels = [];
    this.traps = [];
    this.stairsOpen = false;
    for (const e of this.map.enemies) this.spawnEnemy(e.k, e.x, e.y, false);
    for (const b of this.map.barrels) this.barrels.push({ id: this.nextId++, ...b, vx: 0, vy: 0, fuse: -1, kicker: 0 });
    for (const it of this.map.items) this.items.push({ id: this.nextId++, ...it });
    let i = 0;
    for (const p of this.players.values()) {
      p.x = p.safeX = this.map.spawn.x + ((i % 2) * 2 - 1) * 8;
      p.y = p.safeY = this.map.spawn.y + (i > 1 ? 10 : 0);
      p.vx = p.vy = 0;
      p.mode = p.act = p.draw = p.swing = 0;
      p.invuln = 45;
      if (p.down) {
        p.down = false;
        p.hp = Math.ceil(p.maxHp * 0.3);
      } else if (n > 1) p.hp = Math.min(p.maxHp, p.hp + 20);
      i++;
    }
    this.floorMsg = {
      t: 'floor',
      floor: n,
      ep: this.ep,
      boss,
      w: this.map.w,
      h: this.map.h,
      tiles: Array.from(this.map.tiles).join(''),
      seed: this.runSeed + n,
    };
    this.broadcast(this.floorMsg);
    this.events.push({ e: 'msg', text: boss ? "THE WARDEN'S CRYPT" : `FLOOR ${n}`, big: true });
    this.computeFlow();
  }

  private spawnEnemy(k: EnemyKind, x: number, y: number, aggro: boolean) {
    const d = ENEMY_DEFS[k];
    const scale = k === 'boss' ? 0.6 + 0.4 * Math.max(1, this.players.size) : 1 + (this.floor - 1) * 0.15;
    const hp = Math.round(d.hp * scale);
    this.enemies.push({
      id: this.nextId++,
      k,
      x,
      y,
      vx: 0,
      vy: 0,
      r: d.r,
      hp,
      maxHp: hp,
      mass: d.mass,
      speed: d.speed,
      a: 0,
      s: 0,
      timer: 0,
      cd: 30 + Math.random() * 40,
      atkT: 0,
      stagger: 0,
      invuln: 0,
      hazT: 0,
      root: 0,
      slow: 0,
      aggro: aggro || k === 'boss',
      dirX: 0,
      dirY: 0,
      pattern: 0,
      reps: 0,
      phase2: false,
      born: this.tick,
      hx: new Float64Array(HIST).fill(x),
      hy: new Float64Array(HIST).fill(y),
    });
  }

  // ---------- map helpers ----------
  tileAt(px: number, py: number): number {
    return tileAt(this.map, px, py);
  }

  solid(px: number, py: number) {
    return solid(this.map, px, py);
  }

  collides(x: number, y: number, r: number) {
    return collides(this.map, x, y, r);
  }

  move(o: { x: number; y: number; vx: number; vy: number }, r: number, bounce = 0): number {
    return moveBody(this.map, o, r, DT, bounce);
  }

  los(x0: number, y0: number, x1: number, y1: number) {
    return los(this.map, x0, y0, x1, y1);
  }

  private passable(i: number) {
    const t = this.map.tiles[i];
    return t === T.Floor || t === T.Stairs || t === T.Spikes;
  }

  private computeFlow() {
    const { w, h } = this.map;
    if (this.flow.length !== w * h) this.flow = new Int32Array(w * h);
    this.flow.fill(-1);
    const q: number[] = [];
    for (const p of this.players.values()) {
      if (p.down || p.net.offline) continue;
      const i = Math.floor(p.y / TILE) * w + Math.floor(p.x / TILE);
      if (i >= 0 && i < w * h && this.flow[i] < 0) {
        this.flow[i] = 0;
        q.push(i);
      }
    }
    for (let hd = 0; hd < q.length; hd++) {
      const i = q[hd];
      const x = i % w;
      const y = (i / w) | 0;
      const d = this.flow[i] + 1;
      if (x > 0 && this.flow[i - 1] < 0 && this.passable(i - 1)) (this.flow[i - 1] = d), q.push(i - 1);
      if (x < w - 1 && this.flow[i + 1] < 0 && this.passable(i + 1)) (this.flow[i + 1] = d), q.push(i + 1);
      if (y > 0 && this.flow[i - w] < 0 && this.passable(i - w)) (this.flow[i - w] = d), q.push(i - w);
      if (y < h - 1 && this.flow[i + w] < 0 && this.passable(i + w)) (this.flow[i + w] = d), q.push(i + w);
    }
  }

  private steer(e: Enemy, target: Player): [number, number] {
    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const d = len(dx, dy) || 1;
    if (d < 40 && this.los(e.x, e.y, target.x, target.y)) return [dx / d, dy / d];
    const { w } = this.map;
    const tx = Math.floor(e.x / TILE);
    const ty = Math.floor(e.y / TILE);
    const here = this.flow[ty * w + tx];
    let best = here < 0 ? 1e9 : here;
    let bx = 0;
    let by = 0;
    let found = false;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = tx + ox;
        const ny = ty + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= this.map.h) continue;
        if (ox && oy && (this.flow[ty * w + nx] < 0 || this.flow[ny * w + tx] < 0)) continue;
        const v = this.flow[ny * w + nx];
        if (v >= 0 && v < best) {
          best = v;
          bx = (nx + 0.5) * TILE - e.x;
          by = (ny + 0.5) * TILE - e.y;
          found = true;
        }
      }
    if (!found) return [dx / d, dy / d];
    const bl = len(bx, by) || 1;
    return [bx / bl, by / bl];
  }

  // ---------- lag compensation ----------
  /** Enemy position as of (possibly fractional) tick `t`, from a short per-enemy history ring. */
  private posAt(e: Enemy, t: number): [number, number] {
    if (t >= this.tick) return [e.x, e.y];
    const lo = Math.max(t, e.born, this.tick - HIST + 1);
    const t0 = Math.floor(lo);
    const f = lo - t0;
    const i0 = t0 & (HIST - 1);
    const ax = e.hx[i0];
    const ay = e.hy[i0];
    if (f === 0) return [ax, ay];
    let bx = e.x;
    let by = e.y;
    if (t0 + 1 < this.tick) {
      const i1 = (t0 + 1) & (HIST - 1);
      bx = e.hx[i1];
      by = e.hy[i1];
    }
    return [ax + (bx - ax) * f, ay + (by - ay) * f];
  }

  private viewLag(inp: PlayerInput) {
    if (!inp.vt8) return 0;
    return Math.max(0, Math.min(MAX_REWIND, this.tick - inp.vt8 / 8));
  }

  // ---------- combat helpers ----------
  private damageEnemy(e: Enemy, dmg: number, dx: number, dy: number, knock: number, pid: number, stagger = 5, sq = 0, bi = 0) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    const kf = knock / e.mass;
    e.vx += dx * kf;
    e.vy += dy * kf;
    if (e.k !== 'boss' || kf > 60) e.stagger = Math.max(e.stagger, stagger);
    e.aggro = true;
    this.events.push({ e: 'hit', x: r1(e.x), y: r1(e.y), a: r1(Math.atan2(dy, dx)), who: 'enemy', id: e.id, dmg: Math.round(dmg), by: pid, ...(sq ? { sq, bi } : {}) });
    if (e.hp <= 0) this.killEnemy(e, pid, Math.atan2(dy, dx));
    else if (e.k === 'boss' && !e.phase2 && e.hp < e.maxHp / 2) {
      e.phase2 = true;
      e.speed *= 1.3;
      this.events.push({ e: 'boss', phase: 2 });
      this.events.push({ e: 'msg', text: 'The Warden is enraged!', big: false });
    }
  }

  private killEnemy(e: Enemy, pid: number, a: number, fell = false) {
    e.hp = 0;
    if (!fell) this.events.push({ e: 'die', x: r1(e.x), y: r1(e.y), k: e.k, a: r1(a), id: e.id, by: pid });
    const killer = this.players.get(pid);
    if (killer) {
      killer.kills++;
      if (killer.lifesteal && !killer.down) killer.hp = Math.min(killer.maxHp, killer.hp + killer.lifesteal);
    }
    const xp = ENEMY_DEFS[e.k].xp;
    for (const p of this.players.values()) this.gainXp(p, xp);
    if (e.k !== 'boss' && Math.random() < 0.07) this.items.push({ id: this.nextId++, x: e.x, y: e.y, k: 'potion' });
    if (e.k === 'boss') {
      this.winTimer = TICK_RATE * 3;
      for (const o of this.enemies) if (o !== e) o.hp = 0;
      this.events.push({ e: 'msg', text: 'THE WARDEN FALLS', big: true });
    }
  }

  /** (dx, dy) points from the source to the player. Blockable hits from the front are soaked by a raised shield. */
  private damagePlayer(p: Player, dmg: number, dx: number, dy: number, knock: number, blockable = true) {
    if (p.down || p.net.offline || p.invuln > 0 || this.phase !== 'play') return;
    let stagger = 6;
    if (blockable && (dx || dy) && shieldCovers(p, Math.atan2(-dy, -dx))) {
      this.drainGuard(p, dmg * 2);
      dmg *= 0.35;
      knock *= 0.3;
      stagger = 2;
    }
    p.hp -= dmg;
    p.invuln = 16;
    p.vx += dx * knock * p.knockTaken;
    p.vy += dy * knock * p.knockTaken;
    p.stagger = Math.max(p.stagger, stagger);
    this.events.push({ e: 'hit', x: r1(p.x), y: r1(p.y), a: r1(Math.atan2(dy, dx)), who: 'player', id: p.id, dmg: Math.round(dmg) });
    if (p.hp <= 0) this.downPlayer(p);
  }

  private drainGuard(p: Player, cost: number) {
    p.guard -= cost * p.guardCost;
    p.guardT = 20;
    const broke = p.guard <= 0;
    if (broke) {
      p.guard = -30;
      p.block = 0;
      this.events.push({ e: 'msg', text: `${p.name}'s guard broke!` });
    }
    this.events.push({ e: 'block', x: r1(p.x + Math.cos(p.aim) * 6), y: r1(p.y + Math.sin(p.aim) * 6), a: r1(p.aim), p: p.id, ...(broke ? { broke } : {}) });
  }

  private downPlayer(p: Player) {
    p.hp = 0;
    p.down = true;
    p.rev = 0;
    this.events.push({ e: 'down', p: p.id });
    this.events.push({ e: 'msg', text: `${p.name} is down!` });
    this.checkWipe();
  }

  private checkWipe() {
    if (this.phase !== 'play') return;
    const on = this.online();
    if (on.length && on.every((p) => p.down)) {
      this.phase = 'over';
      this.events.push({ e: 'msg', text: 'THE PARTY HAS FALLEN', big: true });
    }
  }

  private gainXp(p: Player, xp: number) {
    p.xp += xp;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.lvl++;
      p.xpNext = Math.floor(p.xpNext * 1.25 + 8);
      const pool = [...STATS];
      const choice: StatKind[] = [];
      for (let i = 0; i < 3; i++) choice.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      p.pending.push(choice);
      this.events.push({ e: 'level', p: p.id, lvl: p.lvl });
    }
  }

  private applyStat(p: Player, s: StatKind) {
    switch (s) {
      case 'vit':
        p.maxHp += 25;
        if (!p.down) p.hp = Math.min(p.maxHp, p.hp + 25);
        break;
      case 'pow':
        p.pow *= 1.3;
        break;
      case 'atk':
        if (p.char === 'archer') p.drawTicks = Math.max(15, Math.round(p.drawTicks * 0.8));
        else p.atkCd *= 0.8;
        break;
      case 'spd':
        p.speed *= 1.12;
        break;
      case 'ability':
        p.abCd *= 0.7;
        break;
      case 'special':
        if (p.char === 'archer') {
          p.trapRoot = Math.round(p.trapRoot * 1.5);
          p.trapDmg += 12;
          p.specCd *= 0.8;
        } else {
          p.guardMax += 40;
          p.guard += 40;
          p.guardCost *= 0.7;
        }
        break;
    }
  }

  private applyItem(p: Player, k: ItemKind) {
    switch (k) {
      case 'potion':
        p.hp = Math.min(p.maxHp, p.hp + 40);
        return;
      case 'sigil':
        if (p.char === 'archer') p.multishot++;
        else {
          p.arc += 0.26;
          p.reach *= 1.15;
        }
        break;
      case 'ricochet':
        p.bounce += 2;
        if (p.char === 'knight') p.deflectMult *= 1.5;
        break;
      case 'heavy':
        p.knock *= 1.5;
        p.pow *= 1.2;
        if (p.char === 'archer') p.bulletR += 1;
        break;
      case 'fang':
        p.lifesteal += 4;
        break;
      case 'boots':
        p.speed *= 1.12;
        p.abCd *= 0.75;
        break;
      case 'charm':
        if (p.char === 'archer') {
          p.specMax++;
          p.spec++;
          p.pierce++;
        } else {
          p.abMax++;
          p.ab++;
          p.guardMax += 25;
        }
        break;
    }
    p.items.push(k);
  }

  private explode(x: number, y: number, pid: number) {
    const R = 46;
    this.events.push({ e: 'boom', x: r1(x), y: r1(y), r: R });
    for (const e of this.enemies) {
      const dx = e.x - x;
      const dy = e.y - y;
      const d = len(dx, dy);
      if (d > R + e.r) continue;
      const f = 1 - Math.min(1, d / (R + e.r)) * 0.6;
      const n = d || 1;
      this.damageEnemy(e, 50 * f, dx / n, dy / n, 420 * f, pid, 14);
    }
    for (const p of this.players.values()) {
      const dx = p.x - x;
      const dy = p.y - y;
      const d = len(dx, dy);
      if (d > R) continue;
      const f = 1 - (d / R) * 0.6;
      const n = d || 1;
      this.damagePlayer(p, 22 * f, dx / n, dy / n, 260 * f);
    }
    for (const b of this.barrels) {
      const dx = b.x - x;
      const dy = b.y - y;
      const d = len(dx, dy);
      if (d > R + 8 || b.fuse >= 0) continue;
      b.fuse = 5 + ((Math.random() * 4) | 0);
      b.kicker = pid;
      const n = d || 1;
      b.vx += (dx / n) * 120;
      b.vy += (dy / n) * 120;
    }
    this.bullets = this.bullets.filter((b) => !b.enemy || len(b.x - x, b.y - y) > R);
  }

  private newBullet(x: number, y: number, vx: number, vy: number): Bullet {
    return {
      id: this.nextId++,
      x,
      y,
      vx,
      vy,
      enemy: true,
      arrow: false,
      pid: 0,
      seq: 0,
      idx: 0,
      lag: 0,
      dmg: 0,
      knock: 0,
      life: 0,
      bounce: 0,
      pierce: 0,
      r: 3,
      hit: new Set(),
      t0: 0,
      x0: x,
      y0: y,
      dirty: true,
    };
  }

  private fire(p: Player, inp: PlayerInput, res: StepResult) {
    const lag = this.viewLag(inp);
    const shot = arrowVolley(p.x, p.y, p.aim, res.power, res.still, p, inp.seq);
    const base = arrowShot(res.power, res.still);
    const dmg = base.dmg * p.pow;
    const knock = base.knock * p.knock;
    for (const a of shot) {
      const b = this.newBullet(a.x, a.y, a.vx, a.vy);
      Object.assign(b, { enemy: false, arrow: true, pid: p.id, seq: inp.seq, idx: a.idx, lag, dmg, knock, life: a.life, bounce: a.bounce, pierce: a.pierce, r: a.r });
      this.bullets.push(b);
    }
    this.events.push({ e: 'shot', x: r1(p.x), y: r1(p.y), a: r1(p.aim), p: p.id, pw: r1(res.power) });
  }

  private enemyShoot(e: Enemy, a: number, speed = 125, dmg = 9) {
    const b = this.newBullet(e.x + Math.cos(a) * (e.r + 2), e.y + Math.sin(a) * (e.r + 2), Math.cos(a) * speed, Math.sin(a) * speed);
    b.dmg = dmg;
    b.knock = 130;
    b.life = 110;
    this.bullets.push(b);
  }

  private placeTrap(p: Player) {
    const [x, y] = trapSpot(this.map, p.x, p.y, p.aim);
    const mine = this.traps.filter((t) => t.pid === p.id);
    if (mine.length >= TRAPS_PER_PLAYER) this.traps.splice(this.traps.indexOf(mine[0]), 1);
    this.traps.push({ id: this.nextId++, x, y, pid: p.id, c: p.c, life: TRAP_LIFE, arm: 4 });
    this.events.push({ e: 'trap', x: r1(x), y: r1(y), x0: r1(p.x), y0: r1(p.y), p: p.id });
  }

  private inArc(p: Player, x: number, y: number, range: number) {
    const dx = x - p.x;
    const dy = y - p.y;
    const d = len(dx, dy);
    return d < range && (d < 6 || angDiff(Math.atan2(dy, dx), p.aim) < p.arc);
  }

  private slash(p: Player, inp: PlayerInput) {
    const a = p.aim;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    const seen = this.tick - this.viewLag(inp);
    this.events.push({ e: 'slash', x: r1(p.x), y: r1(p.y), a: r1(a), p: p.id, arc: r1(p.arc), reach: r1(p.reach) });
    for (const e of this.enemies) {
      const [ex, ey] = this.posAt(e, seen);
      if (this.inArc(p, ex, ey, p.reach + e.r) || this.inArc(p, e.x, e.y, p.reach + e.r)) {
        const n = len(e.x - p.x, e.y - p.y) || 1;
        this.damageEnemy(e, 20 * p.pow, ((e.x - p.x) / n + cx) / 2, ((e.y - p.y) / n + cy) / 2, 300 * p.knock, p.id, 14);
      }
    }
    for (const b of this.barrels)
      if (this.inArc(p, b.x, b.y, p.reach + 6)) {
        b.vx = cx * 300 * p.knock;
        b.vy = cy * 300 * p.knock;
        b.kicker = p.id;
      }
  }

  /** Runs every tick of the slash's active window: enemy shots inside the arc go back the way the knight faces. */
  private deflect(p: Player, inp: PlayerInput) {
    const cx = Math.cos(p.aim);
    const cy = Math.sin(p.aim);
    for (const b of this.bullets)
      if (b.enemy && this.inArc(p, b.x, b.y, p.reach + 8)) {
        b.enemy = false;
        b.pid = p.id;
        b.seq = 0;
        b.lag = this.viewLag(inp);
        b.dmg = (b.dmg + 12) * p.pow * p.deflectMult;
        b.knock = 170 * p.knock;
        b.life = 60;
        b.bounce = p.bounce;
        const sp = Math.min(420, len(b.vx, b.vy) * 1.6);
        b.vx = cx * sp;
        b.vy = cy * sp;
        b.dirty = true;
        this.events.push({ e: 'deflect', x: r1(b.x), y: r1(b.y) });
      }
  }

  private bashShove(p: Player, inp: PlayerInput) {
    const cx = Math.cos(p.aim);
    const cy = Math.sin(p.aim);
    const seen = this.tick - this.viewLag(inp);
    for (const e of this.enemies) {
      if (e.hp <= 0 || p.bashHit.has(e.id)) continue;
      const [ex, ey] = this.posAt(e, seen);
      const reach = e.r + PLAYER_R + 5;
      if (len(ex - p.x, ey - p.y) < reach || len(e.x - p.x, e.y - p.y) < reach) {
        p.bashHit.add(e.id);
        this.damageEnemy(e, 8 * p.pow, cx, cy, 360 * p.knock, p.id, 20);
        this.events.push({ e: 'shove', x: r1((e.x + p.x) / 2), y: r1((e.y + p.y) / 2), a: r1(p.aim) });
      }
    }
    for (const b of this.barrels)
      if (len(b.x - p.x, b.y - p.y) < 13) {
        b.vx = cx * 280;
        b.vy = cy * 280;
        b.kicker = p.id;
      }
  }

  private nearestPlayer(x: number, y: number): [Player | null, number] {
    let best: Player | null = null;
    let bd = 1e9;
    for (const p of this.players.values()) {
      if (p.down || p.net.offline) continue;
      const d = len(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return [best, bd];
  }

  // ---------- simulation ----------
  step() {
    this.tick++;
    if (this.phase === 'play') {
      if (this.tick % 8 === 0) this.computeFlow();
      this.updatePlayers();
      this.updateEnemies();
      this.updateBullets();
      this.updateBarrels();
      this.updateTraps();
      this.separate();
      this.updateItems();
      this.updateRevives();
      this.enemies = this.enemies.filter((e) => e.hp > 0);
      if (!this.map.boss && !this.stairsOpen && this.enemies.length === 0) {
        this.stairsOpen = true;
        this.events.push({ e: 'msg', text: 'The stairs down are open!' });
      }
      if (this.winTimer > 0 && --this.winTimer === 0) this.phase = 'win';
    } else for (const p of this.players.values()) if (!p.net.offline) this.takeInput(p);

    for (const p of this.players.values())
      if (p.net.offline && this.tick - p.net.offlineAt > OFFLINE_TICKS) this.removePlayer(p.id);

    for (const b of this.bullets)
      if (b.dirty) {
        b.dirty = false;
        b.t0 = this.tick;
        b.x0 = b.x;
        b.y0 = b.y;
      }
    const hi = this.tick & (HIST - 1);
    for (const e of this.enemies) {
      e.hx[hi] = e.x;
      e.hy[hi] = e.y;
    }

    if (process.env.DEBUG_LAG && this.tick % 150 === 0 && this.lagLog.length) {
      const l = this.lagLog.sort((a, b) => a - b);
      console.log(`[lag] hits ${l.length} rewind ticks min ${l[0].toFixed(1)} med ${l[l.length >> 1].toFixed(1)} max ${l[l.length - 1].toFixed(1)}`);
      this.lagLog = [];
    }
    this.updateVision();
    const world = this.buildWorld();
    const teams = new Set([...this.players.values()].map((p) => this.teamOf(p)));
    for (const team of teams) {
      let feed = this.feeds.get(team);
      if (!feed) this.feeds.set(team, (feed = { worlds: new Map(), events: [], anchors: new Map() }));
      feed.worlds.set(this.tick, this.teamWorld(world, team, feed));
      feed.worlds.delete(this.tick - WORLD_HISTORY);
      const evs = this.events.filter((e) => this.eventVisible(team, e));
      if (evs.length) feed.events.push([this.tick, evs]);
      while (feed.events.length && feed.events[0][0] <= this.tick - WORLD_HISTORY) feed.events.shift();
    }
    for (const team of this.feeds.keys()) if (!teams.has(team)) this.feeds.delete(team);
    this.events = [];
    this.syncMeta();
  }

  // ---------- fog of war ----------
  private updateVision() {
    const viewers: Viewer[] = [];
    for (const p of this.players.values()) viewers.push({ id: p.id, team: this.teamOf(p), x: p.x, y: p.y, eyes: !p.net.offline });
    this.vision.update(this.tick, viewers);
  }

  /** Can player `pid` see the point (or a body of radius `r`) right now, through their team's shared vision? */
  canSee(pid: number, x: number, y: number, r = 0): boolean {
    return this.vision.canSee(pid, x, y, r);
  }

  /** Drop a sight-blocking cloud (e.g. a smoke bomb) for `ticks` ticks. Returns an id for removeBlocker. */
  addVisionBlocker(x: number, y: number, r: number, ticks: number): number {
    return this.vision.addBlocker(x, y, r, this.tick + ticks);
  }

  private eventVisible(team: number, e: GameEvent): boolean {
    switch (e.e) {
      case 'pickup':
        return true;
      case 'shot':
      case 'slash':
      case 'bash':
      case 'slide':
      case 'sprint':
      case 'trap':
      case 'block': {
        // A teammate's own actions are always known; anyone else's only where the team can see them.
        const o = this.players.get(e.p);
        if (o && this.teamOf(o) === team) return true;
        break;
      }
      case 'hit':
      case 'fall':
        if (e.who === 'player') return true;
    }
    return 'x' in e ? this.vision.streamed(team, e.x, e.y, 4) : true;
  }

  /** The snapshot a team is allowed to receive: teammates always, everything else only inside its streamed vision. */
  private teamWorld(world: World, team: number, feed: TeamFeed): World {
    const v = this.vision;
    const [players, enemies, bullets, barrels, items, traps] = world.tables;
    const seen = (row: number[], ix: number, iy: number, r: number) => v.streamed(team, dpos(row[ix]), dpos(row[iy]), r);
    const pl: Table = new Map();
    for (const [id, row] of players) {
      const p = this.players.get(id);
      if ((p && this.teamOf(p) === team) || seen(row, 0, 1, PLAYER_R)) pl.set(id, row);
    }
    const en: Table = new Map();
    for (const [id, row] of enemies) if (seen(row, E.x, E.y, ENEMY_DEFS[ENEMY_KINDS[row[E.k]]].r)) en.set(id, row);
    const bu: Table = new Map();
    const anchors: TeamFeed['anchors'] = new Map();
    for (const b of this.bullets) {
      const row = bullets.get(b.id);
      if (!row) continue;
      const owner = b.enemy ? undefined : this.players.get(b.pid);
      if (owner && this.teamOf(owner) === team) {
        bu.set(b.id, row);
        continue;
      }
      if (!v.streamed(team, b.x, b.y, b.r)) continue;
      let a = feed.anchors.get(b.id);
      if (!a || a.t0 !== b.t0) a = { t0: b.t0, at: v.streamed(team, b.x0, b.y0) ? [b.t0, qpos(b.x0), qpos(b.y0)] : [this.tick, qpos(b.x), qpos(b.y)] };
      anchors.set(b.id, a);
      const r = row.slice();
      [r[B.t0], r[B.x], r[B.y]] = a.at;
      bu.set(b.id, r);
    }
    feed.anchors = anchors;
    const ba: Table = new Map();
    for (const [id, row] of barrels) if (seen(row, X.x, X.y, 6)) ba.set(id, row);
    const it: Table = new Map();
    for (const [id, row] of items) if (seen(row, I.x, I.y, 4)) it.set(id, row);
    const tr: Table = new Map();
    for (const t of this.traps) {
      const owner = this.players.get(t.pid);
      if ((owner && this.teamOf(owner) === team) || v.streamed(team, t.x, t.y, 3)) tr.set(t.id, traps.get(t.id)!);
    }
    return { ...world, tables: [pl, en, bu, ba, it, tr] };
  }

  private buildWorld(): World {
    const players: Table = new Map();
    for (const p of [...this.players.values()].sort((a, b) => a.id - b.id)) {
      const flags =
        (p.down ? PF.down : 0) | (p.block || (p.char === 'knight' && p.mode === MODE.bash) ? PF.block : 0) | (p.invuln > 0 ? PF.inv : 0) | (p.net.offline ? PF.off : 0);
      players.set(p.id, [
        qpos(p.x),
        qpos(p.y),
        qang8(p.aim),
        Math.max(0, Math.ceil(p.hp)),
        p.maxHp,
        flags,
        Math.round(Math.min(1, p.rev) * 255),
        p.lvl,
        Math.round(p.xp),
        p.xpNext,
        p.kills,
        p.pending.length,
        p.c,
        CHAR_WIRE.indexOf(p.char),
        p.mode,
        p.char === 'archer' ? Math.round(Math.min(1, p.draw / p.drawTicks) * 255) : 0,
      ]);
    }
    const enemies: Table = new Map();
    for (const e of this.enemies)
      enemies.set(e.id, [
        ENEMY_KINDS.indexOf(e.k as (typeof ENEMY_KINDS)[number]),
        qpos(e.x),
        qpos(e.y),
        Math.max(0, Math.ceil(e.hp)),
        e.maxHp,
        qang8(e.a),
        (e.stagger > 0 && e.k !== 'boss' ? 3 : e.s) | (e.root > 0 || e.slow > 0 ? ES_ROOTED : 0),
      ]);
    const bullets: Table = new Map();
    for (const b of this.bullets)
      bullets.set(b.id, [
        b.t0,
        qpos(b.x0),
        qpos(b.y0),
        Math.round(b.vx),
        Math.round(b.vy),
        (b.enemy ? BF.enemy : 0) | (Math.min(7, b.r) << 1) | (b.arrow ? BF.arrow : 0),
        b.enemy ? 0 : b.pid,
        b.enemy ? 0 : b.seq,
        b.idx,
      ]);
    const barrels: Table = new Map();
    for (const b of this.barrels) barrels.set(b.id, [qpos(b.x), qpos(b.y)]);
    const items: Table = new Map();
    for (const it of this.items) items.set(it.id, [ITEM_KINDS.indexOf(it.k), qpos(it.x), qpos(it.y)]);
    const traps: Table = new Map();
    for (const t of this.traps) traps.set(t.id, [qpos(t.x), qpos(t.y), t.c]);
    return {
      tick: this.tick,
      ep: this.ep,
      phase: this.phase,
      floor: this.floor,
      left: this.enemies.length,
      stairs: this.stairsOpen,
      tables: [players, enemies, bullets, barrels, items, traps],
    };
  }

  /** Per-client delta snapshot against the newest state that client has acknowledged. */
  sendSnapshots() {
    for (const p of this.players.values()) {
      if (!p.net.ws || p.net.ws.readyState !== 1) continue;
      const feed = this.feeds.get(this.teamOf(p));
      const world = feed?.worlds.get(this.tick);
      if (!feed || !world) continue;
      const base = p.net.snapAck ? feed.worlds.get(p.net.snapAck) ?? null : null;
      const since = base ? base.tick : this.tick - 1;
      const events = feed.events.filter(([t]) => t > since);
      const bytes = encodeSnapshot(world, base, { ack: p.net.ack, buf: p.net.buf, starved: p.net.starved & 0xffff, self: pickMove(p), events });
      this.sendBin(p, bytes);
    }
  }

  private metas(): PlayerMeta[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      char: p.char,
      items: p.items,
      choices: p.pending[0] ?? null,
      stats: {
        speed: p.speed,
        atkCd: p.atkCd,
        abCd: p.abCd,
        abMax: p.abMax,
        specCd: p.specCd,
        specMax: p.specMax,
        drawTicks: p.drawTicks,
        guardMax: p.guardMax,
        multishot: p.multishot,
        bounce: p.bounce,
        pierce: p.pierce,
        bulletR: p.bulletR,
        arc: p.arc,
        reach: p.reach,
      },
    }));
  }

  private metaKey = '';
  private syncMeta() {
    const metas = this.metas();
    const key = JSON.stringify(metas);
    if (key === this.metaKey) return;
    this.metaKey = key;
    this.broadcast({ t: 'meta', players: metas });
  }

  private updatePlayers() {
    for (const p of this.players.values()) {
      if (p.net.offline) continue;
      const inp = this.takeInput(p);
      if (!inp) continue;
      if (this.stepPlayer(p, inp)) return;
      // Fast-forward through a backlog (e.g. after a lag spike) instead of carrying the delay.
      if (p.net.queue.size > MAX_INPUT_BUF) {
        const more = this.takeInput(p);
        if (more && this.stepPlayer(p, more)) return;
      }
      // Negative depth tells the client how many ticks late its input stream is, so it can skip ahead.
      const n = p.net;
      n.buf = n.queue.size || (n.newest && n.newest < n.nextSeq ? n.newest - n.nextSeq : 0);
    }
  }

  /** Runs one input for one player. Returns true if the floor changed. */
  private stepPlayer(p: Player, inp: PlayerInput): boolean {
    p.invuln--;
    p.hazT--;
    const res = KITS[p.char].controller.step(p, p, inp, this.map);
    if (p.down) return false;
    if (res.ability) {
      if (p.char === 'knight') {
        p.bashHit.clear();
        this.events.push({ e: 'bash', x: r1(p.x), y: r1(p.y), a: r1(p.aim), p: p.id });
      } else this.events.push({ e: 'sprint', x: r1(p.x), y: r1(p.y), p: p.id });
    }
    if (res.slide) this.events.push({ e: 'slide', x: r1(p.x), y: r1(p.y), p: p.id });
    if (res.fire) this.fire(p, inp, res);
    if (res.trap) this.placeTrap(p);
    if (res.slash) this.slash(p, inp);
    if (p.swing > 0) this.deflect(p, inp);
    if (p.mode === MODE.bash) this.bashShove(p, inp);
    if (res.impact > PLAYER_SLAM && p.invuln < 16 && !p.net.offline) {
      const dmg = Math.round((res.impact - PLAYER_SLAM) / 10);
      if (dmg > 0) {
        p.hp -= dmg;
        this.events.push({ e: 'slam', x: r1(p.x), y: r1(p.y) });
        this.events.push({ e: 'hit', x: r1(p.x), y: r1(p.y), a: 0, who: 'player', id: p.id, dmg });
        if (p.hp <= 0) this.downPlayer(p);
      }
    }

    const tile = this.tileAt(p.x, p.y);
    if (p.mode !== MODE.bash) {
      if (tile === T.Pit) {
        this.events.push({ e: 'fall', x: r1(p.x), y: r1(p.y), who: 'player' });
        p.x = p.safeX;
        p.y = p.safeY;
        p.vx = p.vy = 0;
        p.invuln = 0;
        this.damagePlayer(p, 15, 0, 0, 0, false);
        p.invuln = 40;
        return false;
      }
      if (tile === T.Lava && p.hazT <= 0) {
        p.hazT = 5;
        p.hp -= 6;
        this.events.push({ e: 'burn', x: r1(p.x), y: r1(p.y) });
        if (p.hp <= 0) this.downPlayer(p);
      }
      if (tile === T.Spikes && spikeState(this.tick, Math.floor(p.x / TILE), Math.floor(p.y / TILE)) === 2) {
        const a = Math.random() * Math.PI * 2;
        this.damagePlayer(p, 14, Math.cos(a), Math.sin(a), 90, false);
      }
    }
    if (tile === T.Floor) {
      p.safeX = p.x;
      p.safeY = p.y;
    }
    if (tile === T.Stairs && this.stairsOpen && !p.down) {
      this.loadFloor(this.floor + 1);
      return true;
    }
    return false;
  }

  private updateEnemies() {
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      e.stagger--;
      e.invuln--;
      e.hazT--;
      e.atkT--;
      e.cd--;
      e.root--;
      e.slow--;
      const [t, dist] = this.nearestPlayer(e.x, e.y);
      if (t && !e.aggro && this.tick % 6 === e.id % 6 && dist < 170 && this.los(e.x, e.y, t.x, t.y)) e.aggro = true;

      let wantX = 0;
      let wantY = 0;
      let selfDriven = true;
      if (t && e.aggro && e.stagger <= 0) {
        const dx = t.x - e.x;
        const dy = t.y - e.y;
        const d = len(dx, dy) || 1;
        const seen = this.tick % 3 === 0 ? this.los(e.x, e.y, t.x, t.y) : d < 200;
        if (e.s === 0) e.a = Math.atan2(dy, dx);
        switch (e.k) {
          case 'grunt': {
            [wantX, wantY] = this.steer(e, t);
            break;
          }
          case 'archer': {
            if (seen && d < 70) [wantX, wantY] = [-dx / d, -dy / d];
            else if (!seen || d > 120) [wantX, wantY] = this.steer(e, t);
            else {
              const side = e.id % 2 ? 1 : -1;
              [wantX, wantY] = [(-dy / d) * side * 0.6, (dx / d) * side * 0.6];
            }
            if (seen && d < 210 && e.cd <= 0) {
              this.enemyShoot(e, Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.12);
              this.events.push({ e: 'eshot', x: r1(e.x), y: r1(e.y), a: r1(e.a) });
              e.cd = 48 + Math.random() * 24;
            }
            break;
          }
          case 'brute':
            [wantX, wantY, selfDriven] = this.bruteAI(e, t, dx, dy, d, seen);
            break;
          case 'boss':
            [wantX, wantY, selfDriven] = this.bossAI(e, t, dx, dy, d);
            break;
        }
      }

      if (e.stagger > 0) {
        e.vx *= 0.86;
        e.vy *= 0.86;
        if (e.k === 'brute' || e.k === 'boss') e.s = 0;
      } else if (selfDriven) {
        const sp = e.speed * (e.slow > 0 ? 0.45 : 1);
        e.vx += (wantX * sp - e.vx) * 0.22;
        e.vy += (wantY * sp - e.vy) * 0.22;
      }
      if (e.stagger <= 0 && e.root > 0) {
        e.vx = e.vy = 0;
        if (e.k === 'brute' && e.s === 2) e.s = 0;
      } else if (e.slow > 0 && !selfDriven) {
        e.vx *= 0.93;
        e.vy *= 0.93;
      }
      const preSpeed = len(e.vx, e.vy);
      const impact = this.move(e, e.r, e.stagger > 0 ? 0.35 : 0);
      if (impact > 0) {
        if (e.s === 2 && (e.k === 'brute' || e.k === 'boss')) {
          e.s = 0;
          e.stagger = e.k === 'boss' ? 28 : 40;
          e.cd = 50;
          this.events.push({ e: 'slam', x: r1(e.x), y: r1(e.y) });
          this.damageEnemy(e, e.k === 'boss' ? 30 : 15, 0, 0, 0, 0, e.stagger);
        } else if (e.stagger > 0 && preSpeed > 170) {
          this.events.push({ e: 'slam', x: r1(e.x), y: r1(e.y) });
          this.damageEnemy(e, Math.round(preSpeed / 18), 0, 0, 0, 0, 10);
        }
      }
      if (e.hp <= 0) continue;

      if (e.k !== 'boss') {
        const tile = this.tileAt(e.x, e.y);
        if (tile === T.Pit) {
          this.events.push({ e: 'fall', x: r1(e.x), y: r1(e.y), who: 'enemy' });
          this.killEnemy(e, 0, 0, true);
          continue;
        }
        if (tile === T.Lava && e.hazT <= 0) {
          e.hazT = 6;
          this.events.push({ e: 'burn', x: r1(e.x), y: r1(e.y) });
          this.damageEnemy(e, 7, 0, 0, 0, 0, 0);
        }
        if (tile === T.Spikes && e.invuln <= 0 && spikeState(this.tick, Math.floor(e.x / TILE), Math.floor(e.y / TILE)) === 2) {
          e.invuln = 15;
          this.damageEnemy(e, 12, 0, 0, 0, 0, 4);
        }
      }
      if (e.hp <= 0) continue;

      for (const p of this.players.values()) {
        if (p.down || p.net.offline) continue;
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const d = len(dx, dy);
        if (d < e.r + PLAYER_R + 1) {
          const n = d || 1;
          if (e.s === 2) this.damagePlayer(p, e.k === 'boss' ? 28 : 22, dx / n, dy / n, 380);
          else if (e.atkT <= 0 && e.stagger <= 0) {
            e.atkT = 22;
            this.damagePlayer(p, e.k === 'boss' ? 18 : e.k === 'brute' ? 14 : 9, dx / n, dy / n, 220);
          }
        }
      }
    }
  }

  private bruteAI(e: Enemy, t: Player, dx: number, dy: number, d: number, seen: boolean): [number, number, boolean] {
    if (e.s === 0) {
      if (seen && d < 120 && e.cd <= 0) {
        e.s = 1;
        e.timer = 20;
        e.dirX = dx / d;
        e.dirY = dy / d;
        e.a = Math.atan2(dy, dx);
      }
      const [sx, sy] = this.steer(e, t);
      return [sx, sy, true];
    }
    if (e.s === 1) {
      e.vx *= 0.6;
      e.vy *= 0.6;
      if (--e.timer <= 0) {
        e.s = 2;
        e.timer = 18;
        e.vx = e.dirX * 240;
        e.vy = e.dirY * 240;
      }
      return [0, 0, false];
    }
    if (--e.timer <= 0) {
      e.s = 0;
      e.cd = 45;
    }
    return [0, 0, false];
  }

  private bossAI(e: Enemy, t: Player, dx: number, dy: number, d: number): [number, number, boolean] {
    const p2 = e.phase2;
    // pattern 0 = walk, 1 = burst, 2 = charge, 3 = summon, 4 = spray
    if (e.pattern === 0) {
      if (e.cd <= 0) {
        const seq = [1, 2, 4, 3, 1, 2, 4];
        e.pattern = seq[e.reps++ % seq.length];
        e.timer = 0;
        e.s = 0;
        e.timer = e.pattern === 4 ? (p2 ? 60 : 44) : 0;
        e.dirX = p2 ? 3 : 2;
      }
      const [sx, sy] = this.steer(e, t);
      return [sx, sy, true];
    }
    const done = (cd: number) => {
      e.pattern = 0;
      e.s = 0;
      e.cd = p2 ? cd * 0.6 : cd;
    };
    switch (e.pattern) {
      case 1: {
        e.timer++;
        if (e.timer % 14 === 1) {
          const n = p2 ? 22 : 16;
          const off = e.timer * 0.13;
          for (let i = 0; i < n; i++) this.enemyShoot(e, off + (i / n) * Math.PI * 2, p2 ? 120 : 105, 10);
          this.events.push({ e: 'eshot', x: r1(e.x), y: r1(e.y), a: 0 });
        }
        e.s = 1;
        if (e.timer > (p2 ? 56 : 42)) done(40);
        return [0, 0, true];
      }
      case 2: {
        if (e.s === 0) {
          e.s = 1;
          e.timer = p2 ? 16 : 22;
          e.dirY = Math.atan2(dy, dx);
          e.a = e.dirY;
        }
        if (e.s === 1) {
          e.vx *= 0.7;
          e.vy *= 0.7;
          if (--e.timer <= 0) {
            e.s = 2;
            e.timer = 24;
            e.vx = Math.cos(e.a) * 250;
            e.vy = Math.sin(e.a) * 250;
          }
          return [0, 0, false];
        }
        if (e.s === 2) {
          if (--e.timer <= 0) e.s = 0;
          if (e.s === 0) {
            e.dirX--;
            if (e.dirX <= 0) done(30);
          }
          return [0, 0, false];
        }
        return [0, 0, false];
      }
      case 3: {
        const adds = this.enemies.filter((o) => o.k !== 'boss' && o.hp > 0).length;
        const n = Math.min(p2 ? 4 : 3, 8 - adds);
        for (let i = 0; i < n; i++) {
          const a = (i / Math.max(1, n)) * Math.PI * 2;
          const x = e.x + Math.cos(a) * 30;
          const y = e.y + Math.sin(a) * 30;
          if (!this.collides(x, y, 6) && this.tileAt(x, y) === T.Floor) this.spawnEnemy(p2 && i === 0 ? 'brute' : i % 2 ? 'archer' : 'grunt', x, y, true);
        }
        this.events.push({ e: 'msg', text: 'The Warden calls the dead...' });
        this.events.push({ e: 'boom', x: r1(e.x), y: r1(e.y), r: 0 });
        done(50);
        return [0, 0, true];
      }
      case 4: {
        e.s = 1;
        if (e.timer % 3 === 0) {
          const a = Math.atan2(dy, dx) + Math.sin(e.timer * 0.3) * 0.35;
          this.enemyShoot(e, a, 150, 8);
          this.events.push({ e: 'eshot', x: r1(e.x), y: r1(e.y), a: r1(a) });
        }
        if (--e.timer <= 0) done(40);
        return [(dx / d) * 0.3, (dy / d) * 0.3, true];
      }
    }
    return [0, 0, true];
  }

  private updateBullets() {
    const keep: Bullet[] = [];
    outer: for (const b of this.bullets) {
      for (let s = 0; s < 2; s++) {
        const st = bulletHalfStep(b, this.map);
        if (st === BOUNCED) {
          b.hit.clear();
          b.dirty = true;
          this.events.push({ e: 'spark', x: r1(b.x), y: r1(b.y), p: b.enemy ? 0 : b.pid });
        } else if (st === DEAD) {
          this.events.push({ e: 'spark', x: r1(b.x), y: r1(b.y), p: b.enemy ? 0 : b.pid });
          continue outer;
        }
        for (const br of this.barrels) {
          if (!b.enemy && br.fuse < 0 && len(br.x - b.x, br.y - b.y) < 7 + b.r) {
            br.fuse = 1;
            br.kicker = b.pid;
            continue outer;
          }
        }
        if (!b.enemy) {
          const seen = this.tick - b.lag;
          for (const e of this.enemies) {
            if (e.hp <= 0 || b.hit.has(e.id)) continue;
            const [ex, ey] = b.lag > 0 ? this.posAt(e, seen) : [e.x, e.y];
            if (len(ex - b.x, ey - b.y) < e.r + b.r) {
              const sp = len(b.vx, b.vy) || 1;
              if (process.env.DEBUG_LAG) this.lagLog.push(b.lag);
              this.damageEnemy(e, b.dmg, b.vx / sp, b.vy / sp, b.knock, b.pid, 5, b.seq, b.idx);
              b.hit.add(e.id);
              if (b.pierce > 0) b.pierce--;
              else continue outer;
            }
          }
        } else {
          for (const p of this.players.values()) {
            if (p.down || p.net.offline) continue;
            const d = len(p.x - b.x, p.y - b.y);
            if (d < PLAYER_R + b.r + 3 && shieldCovers(p, Math.atan2(-b.vy, -b.vx))) {
              this.drainGuard(p, b.dmg * 2.2);
              continue outer;
            }
            if (d < PLAYER_R + b.r) {
              const sp = len(b.vx, b.vy) || 1;
              this.damagePlayer(p, b.dmg, b.vx / sp, b.vy / sp, b.knock);
              continue outer;
            }
          }
        }
      }
      if (--b.life > 0) keep.push(b);
    }
    this.bullets = keep;
  }

  private updateBarrels() {
    const keep: Barrel[] = [];
    for (const b of this.barrels) {
      if (b.fuse >= 0 && --b.fuse <= 0) {
        this.explode(b.x, b.y, b.kicker);
        continue;
      }
      const sp = len(b.vx, b.vy);
      if (sp > 1) {
        const impact = this.move(b, 5, 0.4);
        if (impact > 130) b.fuse = 1;
        if (sp > 120)
          for (const e of this.enemies)
            if (len(e.x - b.x, e.y - b.y) < e.r + 6) {
              b.fuse = 1;
              break;
            }
        b.vx *= 0.9;
        b.vy *= 0.9;
      }
      const tile = this.tileAt(b.x, b.y);
      if (tile === T.Pit) {
        this.events.push({ e: 'fall', x: r1(b.x), y: r1(b.y), who: 'enemy' });
        continue;
      }
      if (tile === T.Lava && b.fuse < 0) b.fuse = 10;
      keep.push(b);
    }
    this.barrels = keep;
  }

  private separate() {
    type Body = { x: number; y: number; r: number; m: number; ref: { x: number; y: number } };
    const bodies: Body[] = [];
    for (const p of this.players.values()) bodies.push({ x: p.x, y: p.y, r: PLAYER_R, m: p.mode === MODE.bash ? p.mass * 3 : p.mass, ref: p });
    for (const e of this.enemies) if (e.hp > 0) bodies.push({ x: e.x, y: e.y, r: e.r, m: e.mass, ref: e });
    for (const b of this.barrels) bodies.push({ x: b.x, y: b.y, r: 6, m: 3, ref: b });
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.ref.x - a.ref.x;
        const dy = b.ref.y - a.ref.y;
        const d = len(dx, dy);
        const min = a.r + b.r;
        if (d >= min || d === 0) continue;
        const push = (min - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;
        const wa = b.m / (a.m + b.m);
        const wb = a.m / (a.m + b.m);
        this.nudge(a.ref, -nx * push * wa * 2, -ny * push * wa * 2, a.r);
        this.nudge(b.ref, nx * push * wb * 2, ny * push * wb * 2, b.r);
      }
  }

  private nudge(o: { x: number; y: number }, dx: number, dy: number, r: number) {
    if (!this.collides(o.x + dx, o.y, r)) o.x += dx;
    if (!this.collides(o.x, o.y + dy, r)) o.y += dy;
  }

  private updateTraps() {
    this.traps = this.traps.filter((t) => {
      if (--t.life <= 0) return false;
      if (--t.arm > 0) return true;
      for (const e of this.enemies) {
        if (e.hp <= 0 || len(e.x - t.x, e.y - t.y) > e.r + 4) continue;
        const owner = this.players.get(t.pid);
        const root = owner?.trapRoot ?? 36;
        if (e.k === 'boss') e.slow = Math.max(e.slow, root * 2);
        else {
          e.root = Math.max(e.root, root);
          e.slow = Math.max(e.slow, root + 30);
        }
        e.aggro = true;
        if (owner?.trapDmg) this.damageEnemy(e, owner.trapDmg * owner.pow, 0, 0, 0, owner.id, 0);
        this.events.push({ e: 'snare', x: r1(e.x), y: r1(e.y), id: e.id });
        return false;
      }
      return true;
    });
  }

  private updateItems() {
    this.items = this.items.filter((it) => {
      for (const p of this.players.values()) {
        if (p.down || p.net.offline || len(p.x - it.x, p.y - it.y) > 11) continue;
        if (it.k === 'potion' && p.hp >= p.maxHp) continue;
        this.applyItem(p, it.k);
        this.events.push({ e: 'pickup', x: r1(it.x), y: r1(it.y), k: it.k, p: p.id });
        return false;
      }
      return true;
    });
  }

  private updateRevives() {
    for (const p of this.players.values()) {
      if (!p.down) continue;
      const helper = [...this.players.values()].some((o) => !o.down && !o.net.offline && len(o.x - p.x, o.y - p.y) < 22);
      p.rev = helper ? p.rev + 1 / (TICK_RATE * 2) : Math.max(0, p.rev - 1 / (TICK_RATE * 4));
      if (p.rev >= 1) {
        p.down = false;
        p.rev = 0;
        p.hp = Math.ceil(p.maxHp * 0.4);
        p.invuln = 45;
        this.events.push({ e: 'revive', p: p.id });
        this.events.push({ e: 'msg', text: `${p.name} is back on their feet!` });
      }
    }
  }

  // ---------- networking ----------
  private sendTo(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  send(p: Player, msg: ServerMsg) {
    if (p.net.ws) this.sendTo(p.net.ws, msg);
  }

  private sendBin(p: Player, bytes: Uint8Array) {
    const ws = p.net.ws;
    if (!ws || ws.readyState !== 1) return;
    this.bytesOut += bytes.length;
    ws.send(bytes, { binary: true });
  }

  broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.net.ws?.readyState === 1) p.net.ws.send(data);
  }
}
