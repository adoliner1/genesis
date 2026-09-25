import { TICK_RATE, type GameEvent, type LevelMsg, type PlayerMeta, type ServerMsg, type CharKind } from '../../shared/protocol';
import {
  AR,
  BD,
  CHAR_WIRE,
  MSG_PONG,
  MSG_SNAP,
  P,
  PF,
  RP,
  TABLES,
  dang8,
  decodePong,
  decodeSnapshot,
  dpos,
  encodeInputs,
  encodePing,
  simBodies,
  simRopes,
  type World,
} from '../../shared/net/snapshot';
import { quantizeInput, type PlayerInput } from '../../shared/sim/input';
import { tilesFromString, type TileMap } from '../../shared/sim/level';
import { lerpBodies, type Ctx, type MoveState, type SimBody, type SimRope, type StepResult } from '../../shared/sim/player';
import { Net } from './transport';
import { Timeline } from './timeline';
import { Predictor } from './predict';

const TICK_MS = 1000 / TICK_RATE;
const REDUNDANCY = 4;
const BASELINES = 64;

export interface RawInput {
  mx: number;
  my: number;
  aim: number;
  buttons: number;
}

/** A remote player as drawn: interpolated, plus attachment info so riders can be glued to their parent on screen. */
export interface PlayerView {
  id: number;
  char: CharKind;
  c: number;
  x: number;
  y: number;
  vx: number;
  aim: number;
  heavy: boolean;
  gnd: boolean;
  pound: boolean;
  rope: boolean;
  rax: number;
  ray: number;
  left: boolean;
  stun: boolean;
  off: boolean;
  par: number;
  pm: number;
  ox: number;
  oy: number;
  held: number;
}

export interface ArrowView {
  id: number;
  x: number;
  y: number;
  a: number;
  stuck: boolean;
}

export interface WorldView {
  tick: number;
  phase: World['phase'];
  players: PlayerView[];
  bodies: SimBody[];
  ropes: (SimRope & { o: number })[];
  arrows: ArrowView[];
}

export interface NetHooks {
  input: () => RawInput;
  predicted: (res: StepResult, s: MoveState) => void;
  event: (e: GameEvent) => void;
  level: (l: LevelMsg) => void;
}

const lerpAng = (a: number, b: number, f: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;

/**
 * Glues transport, snapshot decoding, the render timeline and local prediction together.
 * The scene only asks it "where is everything right now" and feeds it raw input.
 */
export class NetClient {
  net: Net;
  tl = new Timeline();
  pred = new Predictor();
  myId = 0;
  code = '';
  level: LevelMsg | null = null;
  map: TileMap | null = null;
  meta = new Map<number, PlayerMeta>();
  hooks: NetHooks | null = null;

  latestTick = 0;
  seqOffset = NaN;
  bufEma = 0;
  bufTarget = 2;
  starved = 0;
  private starveBoost = 0;
  private lastStarved = -1;
  private skipUntil = 0;
  skips = 0;
  pace = 1;
  rtt = 0;
  rttJitter = 0;
  alpha = 0;
  snapsIn = 0;
  baseMisses = 0;
  staleDrops = 0;
  private worlds = new Map<number, World>();
  private bodyCache = new WeakMap<World, SimBody[]>();
  private inputs: PlayerInput[] = [];
  private acc = 0;
  private lastNow = 0;
  private lastPing = 0;
  private lastEventTick = 0;
  private deferred: [number, GameEvent][] = [];
  private rate = { t: 0, snaps: 0, bin: 0, bout: 0, snapHz: 0, kbIn: 0, kbOut: 0 };

  constructor() {
    this.net = new Net();
    this.net.onBinary = (b) => this.onBinary(b);
  }

  handleJson(m: ServerMsg) {
    if (m.t === 'joined') {
      this.myId = m.id;
      this.code = m.code;
      this.resync();
    } else if (m.t === 'level') {
      if (this.level?.ep === m.ep) return;
      this.level = m;
      this.map = tilesFromString(m.w, m.h, m.tiles);
      this.pred.reset();
      this.tl.clear();
      this.worlds.clear();
      this.deferred = [];
      this.hooks?.level(m);
    } else if (m.t === 'meta') {
      this.meta = new Map(m.players.map((p) => [p.id, p]));
      const mine = this.meta.get(this.myId);
      if (mine && mine.char !== this.pred.char) {
        this.pred.char = mine.char;
        this.pred.reset();
      }
    }
  }

  /** Drop prediction and timing state after (re)joining; decoded baselines stay valid for this room. */
  private resync() {
    this.pred.reset();
    this.tl.clear();
    this.lastStarved = -1;
    this.seqOffset = NaN;
    this.inputs = [];
    this.deferred = [];
  }

  private onBinary(b: Uint8Array) {
    const now = performance.now();
    if (b[0] === MSG_PONG) {
      const p = decodePong(b);
      const rtt = now - p.t;
      this.rttJitter += (Math.abs(rtt - this.rtt) - this.rttJitter) * 0.1;
      this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.2 : rtt;
      return;
    }
    if (b[0] !== MSG_SNAP) return;
    const d = decodeSnapshot(b, (t) => this.worlds.get(t));
    if (!d) {
      this.baseMisses++;
      return;
    }
    const { world, me } = d;
    if (!this.level || world.ep !== this.level.ep) {
      this.staleDrops++;
      return;
    }
    this.snapsIn++;
    this.worlds.set(world.tick, world);
    for (const t of this.worlds.keys()) if (t < world.tick - BASELINES * 2) this.worlds.delete(t);
    this.tl.push(world, now);

    for (const [t, evs] of me.events) {
      if (t <= this.lastEventTick) continue;
      for (const e of evs) this.routeEvent(t, e);
    }
    this.lastEventTick = Math.max(this.lastEventTick, ...me.events.map(([t]) => t));

    if (world.tick <= this.latestTick) return;
    this.latestTick = world.tick;
    if (me.self) this.pred.reconcile(me.ack, me.self);
    if (me.ack) {
      const off = world.tick - me.ack;
      this.seqOffset = Number.isNaN(this.seqOffset) || Math.abs(off - this.seqOffset) > 4 ? off : this.seqOffset + (off - this.seqOffset) * 0.1;
    }
    if (me.buf < 0 && now > this.skipUntil && now - this.lastNow < 250) {
      // Our inputs are arriving after the server needed them (e.g. after a stall): jump ahead instead of
      // letting the pace controller crawl back while every input is guessed.
      this.pred.seq += -me.buf + Math.round(this.bufTarget);
      this.skipUntil = now + this.rtt + 150;
      this.skips++;
    }
    this.bufEma += (Math.max(0, me.buf) - this.bufEma) * 0.08;
    if (this.lastStarved >= 0) {
      const d = (me.starved - this.lastStarved + 65536) % 65536;
      this.starved += d;
      if (d) this.starveBoost = Math.min(4, this.starveBoost + 0.25 * d);
    }
    this.lastStarved = me.starved;
    this.starveBoost = Math.max(0, this.starveBoost - 0.004);
    this.bufTarget = Math.max(2, Math.min(8, 1.5 + (0.8 * (this.tl.jitterMs + this.rttJitter)) / TICK_MS + this.starveBoost));
    this.pace = 1 + Math.max(-0.08, Math.min(0.08, (this.bufEma - this.bufTarget) * 0.03));
  }

  private routeEvent(tick: number, e: GameEvent) {
    const me = this.myId;
    // Things the local player did were already played when predicted.
    if ((e.e === 'jump' || e.e === 'land' || e.e === 'heavy' || e.e === 'rope') && e.p === me) return;
    const now = e.e === 'msg' || e.e === 'win' || e.e === 'die' || ((e.e === 'launch' || e.e === 'throw' || e.e === 'grab') && (e.p === me || ('who' in e && e.who === me)));
    if (now) this.hooks?.event(e);
    else this.deferred.push([tick, e]);
  }

  // ---------- per-frame ----------
  update(now: number) {
    const dt = this.lastNow ? Math.min(250, now - this.lastNow) : 0;
    this.lastNow = now;
    this.tl.advance(dt, now);
    this.pred.decay(dt / 1000);
    if (now - this.lastPing > 250 && this.net.status === 'open') {
      this.lastPing = now;
      this.net.sendBin(encodePing(now));
    }
    if (now - this.rate.t > 1000) {
      const r = this.rate;
      const s = (now - r.t) / 1000;
      r.snapHz = (this.snapsIn - r.snaps) / s;
      r.kbIn = (this.net.bytesIn - r.bin) / 1024 / s;
      r.kbOut = (this.net.bytesOut - r.bout) / 1024 / s;
      Object.assign(r, { t: now, snaps: this.snapsIn, bin: this.net.bytesIn, bout: this.net.bytesOut });
    }
    if (!this.myId || this.net.status !== 'open' || !this.map) return;
    const interval = TICK_MS * this.pace;
    this.acc += dt;
    if (this.acc > interval * 8) this.acc = interval;
    while (this.acc >= interval) {
      this.acc -= interval;
      this.tick(this.tl.renderTick - this.acc / TICK_MS);
    }
    this.alpha = this.acc / interval;

    const rt = this.tl.renderTick;
    while (this.deferred.length && this.deferred[0][0] <= rt) this.hooks?.event(this.deferred.shift()![1]);
  }

  /** One fixed input tick; `viewTick` is where the world was on screen at that moment. */
  private tick(viewTick: number) {
    const raw = this.hooks?.input();
    const vt = Number.isFinite(viewTick) ? viewTick : 0;
    const inp = quantizeInput(this.pred.seq + 1, raw?.mx ?? 0, raw?.my ?? 0, raw?.aim ?? 0, raw?.buttons ?? 0, vt);
    const ctx = this.ctxAt(inp.vt8 / 8);
    const res = ctx ? this.pred.step(inp, ctx) : ((this.pred.seq = inp.seq), null);
    const s = this.pred.state;
    if (res && s) this.hooks?.predicted(res, s);
    this.inputs.push(inp);
    if (this.inputs.length > REDUNDANCY) this.inputs.shift();
    this.net.sendBin(encodeInputs(this.latestTick, this.inputs));
  }

  private bodiesOf(w: World): SimBody[] {
    let b = this.bodyCache.get(w);
    if (!b) this.bodyCache.set(w, (b = simBodies(w)));
    return b;
  }

  /** The world exactly as the server will reconstruct it for an input stamped with tick t. */
  ctxAt(t: number): Ctx | null {
    const s = this.tl.states;
    if (!this.map || !s.length) return null;
    let i = s.length - 1;
    while (i > 0 && s[i].tick > t) i--;
    const a = s[i];
    const b = s[i + 1] && s[i].tick <= t ? s[i + 1] : null;
    const f = b ? (t - a.tick) / (b.tick - a.tick) : 0;
    const bodies = lerpBodies(this.bodiesOf(a), b ? this.bodiesOf(b) : null, Math.max(0, Math.min(1, f))).filter((o) => o.id !== this.myId);
    return { map: this.map, bodies, ropes: simRopes(s[s.length - 1]) };
  }

  // ---------- views ----------
  get stats() {
    return this.rate;
  }

  /** Server tick the local player's rendered position corresponds to. */
  predTick() {
    if (Number.isNaN(this.seqOffset)) return this.tl.serverTick(performance.now());
    return this.pred.seq - 1 + this.alpha + this.seqOffset;
  }

  private player(r: number[], id: number): PlayerView {
    const f = r[P.flags];
    return {
      id,
      char: CHAR_WIRE[r[P.k]] ?? 'archer',
      c: r[P.c],
      x: dpos(r[P.x]),
      y: dpos(r[P.y]),
      vx: r[P.vx],
      aim: dang8(r[P.aim]),
      heavy: !!(f & PF.heavy),
      gnd: !!(f & PF.gnd),
      pound: !!(f & PF.pound),
      rope: !!(f & PF.rope),
      rax: dpos(r[P.rax]),
      ray: dpos(r[P.ray]),
      left: !!(f & PF.left),
      stun: !!(f & PF.stun),
      off: !!(f & PF.off),
      par: r[P.par],
      pm: r[P.pm],
      ox: r[P.ox] / 8,
      oy: r[P.oy] / 8,
      held: r[P.held],
    };
  }

  /** Everything remote interpolated at the render tick. */
  sample(t = this.tl.renderTick): WorldView | null {
    const br = this.tl.bracket(t);
    if (!br) return null;
    const { a, b, f } = br;
    const bt = b?.tables;
    const lerp = (ra: number[], rb: number[] | undefined, ix: number) => (rb ? dpos(ra[ix]) + (dpos(rb[ix]) - dpos(ra[ix])) * f : dpos(ra[ix]));
    const players = [...a.tables[TABLES.players]].map(([id, r]) => {
      const rb = bt?.[TABLES.players].get(id);
      const p = this.player(rb && f >= 0.5 ? rb : r, id);
      p.x = lerp(r, rb, P.x);
      p.y = lerp(r, rb, P.y);
      if (rb) p.aim = lerpAng(dang8(r[P.aim]), dang8(rb[P.aim]), Math.min(1, f));
      return p;
    });
    const bodies = [...a.tables[TABLES.bodies]].map(([id, r]): SimBody => {
      const rb = bt?.[TABLES.bodies].get(id);
      return { id, k: r[BD.k], x: lerp(r, rb, BD.x), y: lerp(r, rb, BD.y), w: dpos(r[BD.w]), h: dpos(r[BD.h]), s: (rb && f >= 0.5 ? rb : r)[BD.s] };
    });
    const latest = this.tl.latest()!;
    const ropes = [...latest.tables[TABLES.ropes]].map(([id, r]) => ({ id, ax: dpos(r[RP.ax]), ay: dpos(r[RP.ay]), len: dpos(r[RP.len]), o: r[RP.o] }));
    const arrows = [...a.tables[TABLES.arrows]].map(([id, r]): ArrowView => {
      const rb = bt?.[TABLES.arrows].get(id);
      return { id, x: lerp(r, rb, AR.x), y: lerp(r, rb, AR.y), a: dang8((rb ?? r)[AR.a]), stuck: !!r[AR.stuck] };
    });
    return { tick: t, phase: a.phase, players, bodies, ropes, arrows };
  }
}
