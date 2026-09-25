import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { CHAR_KINDS, DT, MAX_PLAYERS, TICK_RATE, TILE, type CharKind, type ClientMsg, type GameEvent, type LevelMsg, type Phase, type PlayerMeta, type ServerMsg } from '../shared/protocol.ts';
import { HELD_MASK, PRESS_MASK, inputAim, neutralInput, type PlayerInput } from '../shared/sim/input.ts';
import { T, parseRows, tileAt, isSolid, tilesToString, type LevelDef, type TileMap } from '../shared/sim/level.ts';
import {
  ARROW_G,
  BK,
  KIT,
  PM,
  attachedPos,
  copyMove,
  lerpBodies,
  massOf,
  newMoveState,
  ogreBody,
  step,
  type Ctx,
  type MoveState,
  type SimBody,
  type SimRope,
  type StepResult,
} from '../shared/sim/player.ts';
import {
  CHAR_WIRE,
  MSG_INPUT,
  MSG_PING,
  PF,
  TABLES,
  decodeInputs,
  encodePong,
  encodeSnapshot,
  qang8,
  qoff,
  qpos,
  simBodies,
  type Row,
  type Table,
  type World,
} from '../shared/net/snapshot.ts';
import { level1 } from '../shared/levels/level1.ts';

/** Send a snapshot every N simulation ticks (2 = 30 Hz at a 60 Hz sim). */
export const SEND_EVERY = Math.max(1, Number(process.env.SEND_EVERY) || 2);
/** Input queue depth above which the server fast-forwards a player to cut latency. */
const MAX_INPUT_BUF = 16;
const OFFLINE_TICKS = TICK_RATE * 90;
/** Snapshots kept as delta baselines and for looking up what a client was seeing. */
const WORLD_HISTORY = 64;
/** Furthest back (ticks) the server will rewind platforms for a player's view. */
const MAX_REWIND = 30;
const THROW_V = 600;
const LAUNCH_V = 620;
const POUND_R = 56;
const PULLEY_RATE = 1 / 80;
const GATE_SPEED = 2.5;
const ROPES_PER_OWNER = 3;
const WIN_TICKS = TICK_RATE * 4;

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
  /** Seqs the server had to guess; a late copy's presses are carried into the next input. */
  guessed: Set<number>;
  carry: number;
  snapAck: number;
  /** Newest input seq seen, so snapshot acks follow packet order (and can reset after a rejoin). */
  ackFrom: number;
}

interface Player extends MoveState {
  id: number;
  name: string;
  c: number;
  char: CharKind;
  net: NetState;
  aim: number;
  cpX: number;
  cpY: number;
}

interface Body extends SimBody {
  ch: number;
  need: number;
  /** Gates: closed y. */
  y0: number;
}

interface Pulley {
  hook: Body;
  lift: Body;
  t: number;
  hookY: number;
  liftY: number;
  travel: number;
  counter: number;
}

interface Rope extends SimRope {
  owner: number;
}

interface Arrow {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  stuck: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export class Room {
  code: string;
  players = new Map<number, Player>();
  bodies: Body[] = [];
  pulleys: Pulley[] = [];
  ropes: Rope[] = [];
  arrows: Arrow[] = [];
  events: GameEvent[] = [];
  eventLog: [number, GameEvent[]][] = [];
  worlds = new Map<number, World>();
  private worldBodies = new Map<number, SimBody[]>();
  tick = 0;
  phase: Phase = 'play';
  winTimer = 0;
  ep = 0;
  nextId = 1;
  def: LevelDef = level1;
  map!: TileMap;
  levelMsg!: LevelMsg;
  spawn = { x: 0, y: 0 };
  checkpoints: { x: number; y: number; body: Body }[] = [];
  goal = { x: 0, y: 0, w: 0, h: 0 };

  constructor(code: string) {
    this.code = code;
    this.loadLevel();
  }

  get empty() {
    return this.players.size === 0;
  }

  // ---------- level ----------

  private body(k: number, x: number, y: number, w: number, h: number, extra: Partial<Body> = {}): Body {
    const b: Body = { id: this.nextId++, k, x, y, w, h, s: 0, ch: 0, need: 0, y0: y, ...extra };
    this.bodies.push(b);
    return b;
  }

  loadLevel() {
    this.ep++;
    this.phase = 'play';
    this.bodies = [];
    this.pulleys = [];
    this.ropes = [];
    this.arrows = [];
    this.checkpoints = [];
    this.worlds.clear();
    this.worldBodies.clear();
    this.map = parseRows(this.def.rows);
    const signs: LevelMsg['signs'] = [];
    for (const o of this.def.objects) {
      switch (o.k) {
        case 'spawn':
          this.spawn = { x: (o.x + 0.5) * TILE, y: (o.y + 1) * TILE };
          break;
        case 'checkpoint': {
          const body = this.body(BK.checkpoint, o.x * TILE + 4, o.y * TILE - 8, 8, 24);
          this.checkpoints.push({ x: (o.x + 0.5) * TILE, y: (o.y + 1) * TILE, body });
          break;
        }
        case 'pulley': {
          const hook = this.body(BK.hook, o.hookX - 5, o.hookY, 10, 6);
          const lift = this.body(BK.lift, o.liftX, o.liftY, o.liftW, 8);
          this.pulleys.push({ hook, lift, t: 0, hookY: o.hookY, liftY: o.liftY, travel: o.travel, counter: o.counter });
          break;
        }
        case 'lever':
          this.body(BK.lever, o.x * TILE + 3, o.y * TILE + 2, 10, 14, { ch: o.ch });
          break;
        case 'plate':
          this.body(BK.plate, o.x * TILE, (o.y + 1) * TILE - 3, o.w * TILE, 3, { ch: o.ch, need: o.need });
          break;
        case 'target':
          this.body(BK.target, o.x * TILE + 2, o.y * TILE + 2, 12, 12, { ch: o.ch });
          break;
        case 'gate':
          this.body(BK.gate, o.x * TILE + 2, o.y * TILE, o.w * TILE - 4, o.h * TILE, { ch: o.ch });
          break;
        case 'goal':
          this.goal = { x: o.x * TILE, y: o.y * TILE, w: o.w * TILE, h: o.h * TILE };
          this.body(BK.goal, this.goal.x, this.goal.y, this.goal.w, this.goal.h);
          break;
        case 'sign':
          signs.push({ x: o.x * TILE, y: o.y * TILE, text: o.text });
          break;
      }
    }
    this.levelMsg = { t: 'level', ep: this.ep, name: this.def.name, w: this.map.w, h: this.map.h, tiles: tilesToString(this.map), signs };
    for (const p of this.players.values()) this.placeAtStart(p);
    this.broadcast(this.levelMsg);
  }

  private placeAtStart(p: Player) {
    Object.assign(p, newMoveState());
    p.cpX = this.spawn.x + (p.c - 1.5) * 14;
    p.cpY = this.spawn.y;
    p.x = p.cpX;
    p.y = p.cpY;
  }

  // ---------- connections ----------

  addPlayer(ws: WebSocket, name: string, char: unknown): Player | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const used = new Set([...this.players.values()].map((p) => p.c));
    let c = 0;
    while (used.has(c)) c++;
    const p: Player = {
      ...newMoveState(),
      id: this.nextId++,
      name: String(name).slice(0, 14) || 'Player',
      c,
      char: CHAR_KINDS.includes(char as CharKind) ? (char as CharKind) : 'archer',
      net: this.newNet(ws),
      aim: 0,
      cpX: 0,
      cpY: 0,
    };
    this.placeAtStart(p);
    this.players.set(p.id, p);
    this.greet(p);
    this.events.push({ e: 'msg', text: `${p.name} joined as the ${p.char}` });
    this.syncMeta();
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
    Object.assign(p.net, { ws, offline: false, queue: new Map(), guessed: new Set(), carry: 0, nextSeq: 0, newest: 0, streak: 0, snapAck: 0, ackFrom: 0, buf: 0 });
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
    this.release(p);
    this.events.push({ e: 'msg', text: `${p.name} lost connection` });
  }

  private greet(p: Player) {
    this.send(p, { t: 'joined', code: this.code, id: p.id, token: p.net.token });
    this.send(p, this.levelMsg);
    this.send(p, { t: 'meta', players: this.metas() });
  }

  private removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.release(p);
    this.players.delete(id);
    this.events.push({ e: 'msg', text: `${p.name} left` });
    this.syncMeta();
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
    };
  }

  handle(p: Player, msg: ClientMsg) {
    if (msg.t === 'restart') {
      this.loadLevel();
      this.events.push({ e: 'msg', text: `${p.name} restarted the level`, big: true });
    } else if (msg.t === 'warp') {
      const c = this.checkpoints[msg.cp];
      if (!c) return;
      this.release(p);
      Object.assign(p, newMoveState(), { x: c.x, y: c.y, cpX: c.x, cpY: c.y });
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
    if (!m || !m.inputs.length) return;
    const n = p.net;
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
      inp = ++n.streak > 6 ? { ...neutralInput(n.nextSeq), aim: n.last.aim, vt8: n.last.vt8 } : { ...n.last, seq: n.nextSeq, buttons: n.last.buttons & HELD_MASK };
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

  // ---------- simulation ----------

  step() {
    this.tick++;
    if (this.phase === 'win' && --this.winTimer <= 0) {
      this.loadLevel();
      return;
    }
    for (const p of this.players.values()) if (p.net.offline && this.tick - p.net.offlineAt > OFFLINE_TICKS) this.removePlayer(p.id);

    for (const p of this.players.values()) {
      if (p.net.offline) continue;
      const inp = this.takeInput(p);
      if (!inp) continue;
      this.stepPlayer(p, inp);
      // Fast-forward through a backlog (e.g. after a lag spike) instead of carrying the delay.
      if (p.net.queue.size > MAX_INPUT_BUF) {
        const more = this.takeInput(p);
        if (more) this.stepPlayer(p, more);
      }
      // Negative depth tells the client how many ticks late its input stream is, so it can skip ahead.
      const n = p.net;
      n.buf = n.queue.size || (n.newest && n.newest < n.nextSeq ? n.newest - n.nextSeq : 0);
    }
    for (const p of this.players.values()) {
      const h = p.held ? this.players.get(p.held) : undefined;
      if (p.held && (!h || h.par !== p.id || h.pm !== PM.carry)) p.held = 0;
    }
    this.updateArrows();
    this.updateMechanisms();
    this.glue();
    this.checkPlayers();
  }

  /** What this player was looking at: platforms as of the tick their screen showed, ropes as they are now. */
  private ctxFor(p: Player, vt: number): Ctx {
    const t = Math.max(this.tick - MAX_REWIND, Math.min(this.tick, vt));
    const lo = Math.floor(t / SEND_EVERY) * SEND_EVERY;
    const a = this.worldBodies.get(lo);
    const b = this.worldBodies.get(lo + SEND_EVERY) ?? null;
    let bodies: SimBody[];
    if (a) bodies = lerpBodies(a, b, (t - lo) / SEND_EVERY);
    else bodies = this.liveBodies();
    return { map: this.map, bodies: bodies.filter((o) => o.id !== p.id), ropes: this.ropes };
  }

  private liveBodies(): SimBody[] {
    const out: SimBody[] = this.bodies.map((b) => ({ id: b.id, k: b.k, x: b.x, y: b.y, w: b.w, h: b.h, s: b.s }));
    for (const p of this.players.values()) if (p.char === 'ogre' && !p.net.offline) out.push(ogreBody(p.id, p.x, p.y));
    return out;
  }

  private stepPlayer(p: Player, inp: PlayerInput) {
    p.aim = inputAim(inp);
    const res = step(p, p.char, inp, this.ctxFor(p, inp.vt8 / 8));
    this.apply(p, res);
  }

  private apply(p: Player, res: StepResult) {
    const at = { x: r1(p.x), y: r1(p.y) };
    if (res.jumped) this.events.push({ e: 'jump', p: p.id, ...at });
    if (res.land) this.events.push({ e: 'land', p: p.id, ...at, hard: res.land === 2 });
    if (res.heavy) this.events.push({ e: 'heavy', p: p.id, on: !!p.heavy });
    if (res.rope) this.events.push({ e: 'rope', p: p.id, x: r1(res.rope.x), y: r1(res.rope.y), hit: res.rope.hit });
    if (res.leave) {
      this.ropes.push({ id: this.nextId++, ax: res.leave.ax, ay: res.leave.ay, len: res.leave.len, owner: p.id });
      const mine = this.ropes.filter((r) => r.owner === p.id);
      if (mine.length > ROPES_PER_OWNER) this.ropes = this.ropes.filter((r) => r !== mine[0]);
    }
    if (res.snap) {
      const r = this.ropes.find((o) => o.id === res.snap);
      if (r) {
        this.ropes = this.ropes.filter((o) => o !== r);
        this.events.push({ e: 'snap', x: r1(r.ax), y: r1(r.ay) });
      }
    }
    if (res.arrow) this.arrows.push({ id: this.nextId++, ...res.arrow, stuck: 0 });
    if (res.lever) {
      const b = this.bodies.find((o) => o.id === res.lever);
      if (b && !b.s) {
        b.s = 1;
        this.events.push({ e: 'switch', x: r1(b.x + b.w / 2), y: r1(b.y), on: true });
      }
    }
    if (res.grab) this.grab(p);
    if (res.throw) this.throwHeld(p);
    if (res.pound) this.pound(p);
  }

  private grab(o: Player) {
    if (o.held) return;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const q of this.players.values()) {
      if (q === o || q.net.offline || q.char === 'ogre' || q.pm === PM.carry || q.pm === PM.hang) continue;
      const d = Math.hypot(q.x - o.x, q.y - KIT[q.char].h / 2 - (o.y - KIT.ogre.h / 2));
      if (d < 26 && d < bestD) {
        best = q;
        bestD = d;
      }
    }
    if (!best) return;
    Object.assign(best, { par: o.id, pm: PM.carry, ox: 0, oy: -2, rm: 0, rid: 0, vx: 0, vy: 0, gnd: 0, pound: 0 });
    o.held = best.id;
    this.events.push({ e: 'grab', p: o.id, who: best.id });
  }

  private throwHeld(o: Player) {
    const q = this.players.get(o.held);
    o.held = 0;
    if (!q || q.par !== o.id) return;
    [q.x, q.y] = attachedPos(q, ogreBody(o.id, o.x, o.y), q.char);
    Object.assign(q, { par: 0, pm: PM.none, ox: 0, oy: 0, gnd: 0, stun: 18, gcd: 12 });
    q.vx = Math.cos(o.aim) * THROW_V + o.vx * 0.5;
    q.vy = Math.sin(o.aim) * THROW_V;
    this.events.push({ e: 'throw', p: o.id, who: q.id });
  }

  private pound(o: Player) {
    this.events.push({ e: 'pound', p: o.id, x: r1(o.x), y: r1(o.y) });
    for (const q of this.players.values()) {
      if (q === o || q.net.offline) continue;
      const riding = q.par === o.id && q.pm === PM.stand;
      const near = q.gnd && (q.pm === PM.none || q.pm === PM.stand) && Math.abs(q.x - o.x) < POUND_R && Math.abs(q.y - o.y) < 10;
      if (!riding && !near) continue;
      Object.assign(q, { par: 0, pm: PM.none, ox: 0, oy: 0, gnd: 0, rm: 0 });
      q.vy = -LAUNCH_V;
      q.stun = 24;
      this.events.push({ e: 'launch', p: q.id, x: r1(q.x), y: r1(q.y) });
    }
  }

  /** Let go of whatever this player holds and whatever holds them. */
  private release(p: Player) {
    for (const q of this.players.values()) if (q.par === p.id) Object.assign(q, { par: 0, pm: PM.none, ox: 0, oy: 0, gnd: 0 });
    for (const q of this.players.values()) if (q.held === p.id) q.held = 0;
    Object.assign(p, { par: 0, pm: PM.none, ox: 0, oy: 0, held: 0, rm: 0, rid: 0 });
  }

  private updateArrows() {
    const keep: Arrow[] = [];
    outer: for (const a of this.arrows) {
      if (a.stuck) {
        if (++a.stuck < TICK_RATE * 3) keep.push(a);
        continue;
      }
      a.vy += ARROW_G * DT;
      for (let i = 0; i < 3; i++) {
        a.x += (a.vx * DT) / 3;
        a.y += (a.vy * DT) / 3;
        for (const b of this.bodies) {
          if (a.x < b.x || a.x > b.x + b.w || a.y < b.y || a.y > b.y + b.h) continue;
          if (b.k === BK.target) {
            if (!b.s) {
              b.s = 1;
              this.events.push({ e: 'switch', x: r1(b.x + b.w / 2), y: r1(b.y + b.h / 2), on: true });
            }
            continue outer;
          }
          if (b.k === BK.gate || b.k === BK.lift) {
            this.events.push({ e: 'thunk', x: r1(a.x), y: r1(a.y) });
            continue outer;
          }
        }
        if (isSolid(tileAt(this.map, Math.floor(a.x / TILE), Math.floor(a.y / TILE)))) {
          a.stuck = 1;
          this.events.push({ e: 'thunk', x: r1(a.x), y: r1(a.y) });
          keep.push(a);
          continue outer;
        }
      }
      keep.push(a);
    }
    this.arrows = keep;
  }

  /** Weight of a player plus everyone riding or carried on top of them. */
  private stackMass(p: Player, depth = 0): number {
    let m = massOf(p.char, p);
    if (depth < 4) for (const q of this.players.values()) if (q.par === p.id && (q.pm === PM.stand || q.pm === PM.carry)) m += this.stackMass(q, depth + 1);
    return m;
  }

  private updateMechanisms() {
    const live = [...this.players.values()].filter((p) => !p.net.offline);
    for (const b of this.bodies) {
      if (b.k !== BK.plate) continue;
      let m = 0;
      for (const p of live) {
        const hw = KIT[p.char].w / 2;
        if (p.gnd && p.pm === PM.none && Math.abs(p.y - (b.y + b.h)) < 0.5 && p.x + hw > b.x && p.x - hw < b.x + b.w) m += this.stackMass(p);
      }
      const on = m >= b.need ? 1 : 0;
      if (on !== b.s) this.events.push({ e: 'switch', x: r1(b.x + b.w / 2), y: r1(b.y), on: !!on });
      b.s = on;
    }
    const chans = new Set<number>();
    for (const b of this.bodies) if ((b.k === BK.lever || b.k === BK.plate || b.k === BK.target) && b.s) chans.add(b.ch);
    for (const b of this.bodies) {
      if (b.k !== BK.gate) continue;
      const want = chans.has(b.ch) ? b.y0 - b.h + 2 : b.y0;
      const prev = b.y;
      b.y = want < b.y ? Math.max(want, b.y - GATE_SPEED) : Math.min(want, b.y + GATE_SPEED * 2);
      b.s = b.y === b.y0 ? 0 : 1;
      if (b.y > prev) this.shoveOut(b);
    }
    for (const u of this.pulleys) {
      let hookLoad = 0;
      let liftLoad = 0;
      for (const p of live) {
        if (p.par === u.hook.id && p.pm === PM.hang) hookLoad += this.stackMass(p);
        if (p.par === u.lift.id && p.pm === PM.stand) liftLoad += this.stackMass(p);
      }
      const net = hookLoad - (u.counter + liftLoad);
      if (net > 0.01) u.t = Math.min(1, u.t + PULLEY_RATE);
      else if (net < -0.01) u.t = Math.max(0, u.t - PULLEY_RATE);
      u.hook.y = u.hookY + u.t * u.travel;
      u.lift.y = u.liftY - u.t * u.travel;
      u.hook.s = u.lift.s = Math.round(u.t * 255);
    }
  }

  /** A closing gate pushes anyone under it out to the nearer side. */
  private shoveOut(g: Body) {
    for (const p of this.players.values()) {
      const hw = KIT[p.char].w / 2;
      if (p.pm !== PM.none || p.x + hw <= g.x || p.x - hw >= g.x + g.w || p.y <= g.y || p.y - KIT[p.char].h >= g.y + g.h) continue;
      p.x = p.x < g.x + g.w / 2 ? g.x - hw - 0.5 : g.x + g.w + hw + 0.5;
      p.vx = 0;
    }
  }

  /** Attached players follow their parent's current position, parents before children. */
  private glue() {
    const depth = (p: Player) => {
      let d = 0;
      let q: Player | undefined = p;
      while (q && q.pm !== PM.none && d < 5) {
        d++;
        q = this.players.get(q.par);
      }
      return d;
    };
    const attached = [...this.players.values()].filter((p) => p.pm !== PM.none).sort((a, b) => depth(a) - depth(b));
    for (const p of attached) {
      const parent = this.players.get(p.par);
      const body = parent ? (parent.char === 'ogre' ? ogreBody(parent.id, parent.x, parent.y) : null) : this.bodies.find((b) => b.id === p.par);
      if (!body) {
        Object.assign(p, { par: 0, pm: PM.none, ox: 0, oy: 0, gnd: 0 });
        continue;
      }
      [p.x, p.y] = attachedPos(p, body, p.char);
    }
  }

  private checkPlayers() {
    const live = [...this.players.values()].filter((p) => !p.net.offline);
    for (const p of live) {
      const k = KIT[p.char];
      const hw = k.w / 2;
      // Spikes: feet in the lower half of a spike tile, or fell out of the world.
      let dead = p.y > this.map.h * TILE;
      for (let tx = Math.floor((p.x - hw + 1) / TILE); tx <= Math.floor((p.x + hw - 1) / TILE) && !dead; tx++) {
        const ty = Math.floor((p.y - 1) / TILE);
        if (tileAt(this.map, tx, ty) === T.Spikes && p.y - 1 - ty * TILE > TILE / 2) dead = true;
      }
      if (dead) this.respawn(p);
      for (const c of this.checkpoints)
        if (Math.abs(p.x - c.x) < 16 && Math.abs(p.y - c.y) < 24) {
          p.cpX = c.x;
          p.cpY = c.y;
          if (!c.body.s) {
            c.body.s = 1;
            this.events.push({ e: 'switch', x: r1(c.x), y: r1(c.y - 20), on: true });
          }
        }
    }
    if (this.phase === 'play' && live.length) {
      const g = this.goal;
      if (live.every((p) => p.x > g.x && p.x < g.x + g.w && p.y > g.y && p.y <= g.y + g.h + 0.5)) {
        this.phase = 'win';
        this.winTimer = WIN_TICKS;
        this.events.push({ e: 'win' }, { e: 'msg', text: 'Level complete!', big: true });
      }
    }
  }

  private respawn(p: Player) {
    this.events.push({ e: 'die', p: p.id, x: r1(p.x), y: r1(p.y) });
    this.release(p);
    Object.assign(p, newMoveState(), { x: p.cpX, y: p.cpY });
  }

  // ---------- snapshots ----------

  private buildWorld(): World {
    const players: Table = new Map();
    for (const p of this.players.values()) {
      const flags =
        (p.heavy ? PF.heavy : 0) | (p.gnd ? PF.gnd : 0) | (p.pound ? PF.pound : 0) | (p.rm ? PF.rope : 0) | (p.face < 0 ? PF.left : 0) | (p.stun ? PF.stun : 0) | (p.net.offline ? PF.off : 0);
      const row: Row = [qpos(p.x), qpos(p.y), flags, p.par, p.pm, qoff(p.ox), qoff(p.oy), qpos(p.rax), qpos(p.ray), p.c, CHAR_WIRE.indexOf(p.char), qang8(p.aim), Math.round(p.vx), p.held];
      players.set(p.id, row);
    }
    const bodies: Table = new Map();
    for (const b of this.bodies) bodies.set(b.id, [b.k, qpos(b.x), qpos(b.y), qpos(b.w), qpos(b.h), b.s]);
    const ropes: Table = new Map();
    for (const r of this.ropes) ropes.set(r.id, [qpos(r.ax), qpos(r.ay), qpos(r.len), r.owner]);
    const arrows: Table = new Map();
    for (const a of this.arrows) arrows.set(a.id, [qpos(a.x), qpos(a.y), qang8(Math.atan2(a.vy, a.vx)), a.stuck ? 1 : 0]);
    const tables: Table[] = [];
    tables[TABLES.players] = players;
    tables[TABLES.bodies] = bodies;
    tables[TABLES.ropes] = ropes;
    tables[TABLES.arrows] = arrows;
    return { tick: this.tick, ep: this.ep, phase: this.phase, tables };
  }

  /** Called every tick; records and sends a snapshot every SEND_EVERY ticks. */
  sendSnapshots() {
    this.eventLog.push([this.tick, this.events]);
    this.events = [];
    while (this.eventLog.length && this.eventLog[0][0] <= this.tick - WORLD_HISTORY * SEND_EVERY) this.eventLog.shift();
    this.syncMeta();
    if (this.tick % SEND_EVERY) return;
    const world = this.buildWorld();
    this.worlds.set(this.tick, world);
    this.worldBodies.set(this.tick, simBodies(world));
    this.worlds.delete(this.tick - WORLD_HISTORY * SEND_EVERY);
    this.worldBodies.delete(this.tick - WORLD_HISTORY * SEND_EVERY);
    for (const p of this.players.values()) {
      if (!p.net.ws || p.net.ws.readyState !== 1) continue;
      const base = p.net.snapAck ? (this.worlds.get(p.net.snapAck) ?? null) : null;
      const since = base ? base.tick : this.tick - SEND_EVERY;
      const events = this.eventLog.filter(([t, e]) => t > since && e.length);
      this.sendBin(p, encodeSnapshot(world, base, { ack: p.net.ack, buf: p.net.buf, starved: p.net.starved & 0xffff, self: copyMove(p), events }));
    }
  }

  private metas(): PlayerMeta[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, char: p.char, c: p.c }));
  }

  private metaKey = '';
  private syncMeta() {
    const metas = this.metas();
    const key = JSON.stringify(metas);
    if (key === this.metaKey) return;
    this.metaKey = key;
    this.broadcast({ t: 'meta', players: metas });
  }

  private send(p: Player, m: ServerMsg) {
    if (p.net.ws) this.sendTo(p.net.ws, m);
  }

  private sendTo(ws: WebSocket, m: ServerMsg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  private broadcast(m: ServerMsg) {
    for (const p of this.players.values()) this.send(p, m);
  }

  private sendBin(p: Player, b: Uint8Array) {
    if (p.net.ws && p.net.ws.readyState === 1) p.net.ws.send(b);
  }
}
