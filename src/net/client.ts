import {
  ENEMY_R,
  TICK_RATE,
  type BulletSnap,
  type EnemySnap,
  type FloorMsg,
  type GameEvent,
  type ItemSnap,
  type PlayerMeta,
  type PlayerSnap,
  type PropSnap,
  type ServerMsg,
  type TrapSnap,
  type WorldView,
} from '../../shared/protocol';
import {
  B,
  BF,
  CHAR_WIRE,
  E,
  ENEMY_KINDS,
  ES_ROOTED,
  I,
  ITEM_KINDS,
  MSG_PONG,
  MSG_SNAP,
  P,
  PF,
  TR,
  X,
  dang8,
  decodePong,
  decodeSnapshot,
  dpos,
  encodeInputs,
  encodePing,
  type World,
} from '../../shared/net/snapshot';
import { packButtons, quantizeInput, type Buttons, type PlayerInput } from '../../shared/sim/input';
import { parseTiles, type TileMap } from '../../shared/sim/map';
import { bulletAt } from '../../shared/sim/bullets';
import { PLAYER_R, type MoveState, type StepResult } from '../../shared/sim/movement';
import { shieldCovers } from '../../shared/sim/kits/knight';
import { Net } from './transport';
import { Timeline } from './timeline';
import { Predictor, type Target } from './predict';
import { FogState } from '../fog';

const TICK_MS = 1000 / TICK_RATE;
const REDUNDANCY = 4;
const BASELINES = 64;

export interface RawInput extends Buttons {
  mx: number;
  my: number;
  aim: number;
}

export interface RenderBullet {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  e: boolean;
  r: number;
  arrow: boolean;
}

export interface NetHooks {
  input: () => RawInput;
  predicted: (res: StepResult, s: MoveState) => void;
  /** An enemy shot was stopped locally by your shield or slash; the server confirms a moment later. */
  parried: (x: number, y: number, deflected: boolean) => void;
  impact: (x: number, y: number, what: 'wall' | 'enemy' | 'barrel', id: number) => void;
  event: (e: GameEvent) => void;
  floor: (f: FloorMsg) => void;
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
  floor: FloorMsg | null = null;
  map: TileMap | null = null;
  meta = new Map<number, PlayerMeta>();
  latest: WorldView | null = null;
  hooks: NetHooks | null = null;
  fog = new FogState();

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
  deadIds = new Set<number>();
  predictedHits = 0;
  confirmedHits = 0;
  hitMatch = { both: 0, predictedOnly: 0, overkill: 0, serverOnly: 0 };
  private killed = new Set<number>();
  private predHitKeys = new Map<string, number>();
  private worlds = new Map<number, World>();
  private inputs: PlayerInput[] = [];
  private acc = 0;
  private lastNow = 0;
  private lastPing = 0;
  private lastEventTick = 0;
  private deferred: [number, GameEvent][] = [];
  private firstSeen = new Map<number, number>();
  private hidden = new Set<number>();
  /** Where each server bullet was last drawn, for local parry checks. */
  private shown = new Map<number, [number, number]>();
  /** Locally parried shots and when to give up waiting for the server to agree. */
  private parried = new Map<number, number>();
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
    } else if (m.t === 'floor') {
      if (this.floor?.ep === m.ep) return;
      this.floor = m;
      this.map = { w: m.w, h: m.h, tiles: parseTiles(m.tiles) };
      this.pred.map = this.map;
      this.pred.bullets = [];
      this.tl.states = [];
      this.deferred = [];
      this.deadIds.clear();
      this.fog.reset(this.map);
      this.hooks?.floor(m);
    } else if (m.t === 'fog') {
      if (this.floor?.ep === m.ep) this.fog.applyExplored(m.explored);
    } else if (m.t === 'meta') {
      this.meta = new Map(m.players.map((p) => [p.id, p]));
      const mine = this.meta.get(this.myId);
      if (mine) {
        this.pred.stats = mine.stats;
        this.pred.char = mine.char;
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
    if (!this.floor || world.ep !== this.floor.ep) {
      this.staleDrops++;
      return;
    }
    this.snapsIn++;
    this.worlds.set(world.tick, world);
    for (const t of this.worlds.keys()) if (t < world.tick - BASELINES) this.worlds.delete(t);
    this.tl.push(world, now);

    for (const [t, evs] of me.events) {
      if (t <= this.lastEventTick) continue;
      for (const e of evs) this.routeEvent(t, e);
    }
    this.lastEventTick = Math.max(this.lastEventTick, ...me.events.map(([t]) => t));

    if (world.tick <= this.latestTick) return;
    this.latestTick = world.tick;
    this.pred.active = world.phase === 'play';
    if (me.self) this.pred.reconcile(me.ack, me.self);
    if (me.ack) {
      const off = world.tick - me.ack;
      this.seqOffset = Number.isNaN(this.seqOffset) || Math.abs(off - this.seqOffset) > 4 ? off : this.seqOffset + (off - this.seqOffset) * 0.1;
    }
    if (me.buf < 0 && now > this.skipUntil) {
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
      if (d) this.starveBoost = Math.min(2.5, this.starveBoost + 0.25 * d);
    }
    this.lastStarved = me.starved;
    this.starveBoost = Math.max(0, this.starveBoost - 0.004);
    this.bufTarget = Math.max(1.5, Math.min(5, 1.2 + (0.8 * (this.tl.jitterMs + this.rttJitter)) / TICK_MS + this.starveBoost));
    this.pace = 1 + Math.max(-0.08, Math.min(0.08, (this.bufEma - this.bufTarget) * 0.03));
    this.latest = this.buildView(world);
    // Keeps the explored map growing even while the tab is in the background and not rendering.
    this.fog.see(this.latest.players, false);
  }

  private routeEvent(tick: number, e: GameEvent) {
    const me = this.myId;
    if ((e.e === 'shot' || e.e === 'slash' || e.e === 'bash' || e.e === 'slide' || e.e === 'sprint' || e.e === 'trap') && e.p === me) return;
    if (e.e === 'spark' && e.p === me) return;
    let now = false;
    switch (e.e) {
      case 'msg':
      case 'level':
      case 'pickup':
      case 'boss':
      case 'down':
      case 'revive':
        now = true;
        break;
      case 'hit':
        now = e.who === 'player' ? e.id === me : e.by === me;
        if (e.who === 'enemy' && e.by === me) {
          this.confirmedHits++;
          if (e.sq && this.predHitKeys.delete(`${e.sq}:${e.bi ?? 0}:${e.id}`)) this.hitMatch.both++;
          else if (e.sq) this.hitMatch.serverOnly++;
        }
        break;
      case 'die':
        now = e.by === me;
        if (now) this.deadIds.add(e.id);
        this.killed.add(e.id);
        break;
    }
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
    if (!this.myId || this.net.status !== 'open') return;
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

  /** One fixed input tick; `renderTick` is where remote entities were on screen at that moment. */
  private auditHits(now: number) {
    for (const [k, t] of this.predHitKeys)
      if (now - t > 1500) {
        this.predHitKeys.delete(k);
        if (this.killed.has(Number(k.split(':')[2]))) this.hitMatch.overkill++;
        else this.hitMatch.predictedOnly++;
      }
  }

  private tick(renderTick: number) {
    this.auditHits(performance.now());
    const raw = this.hooks?.input();
    const rt = Number.isFinite(renderTick) ? renderTick : 0;
    const inp = quantizeInput(this.pred.seq + 1, raw?.mx ?? 0, raw?.my ?? 0, raw?.aim ?? 0, raw ? packButtons(raw) : 0, rt);
    const res = this.pred.step(inp);
    const s = this.pred.state;
    if (res && s) this.hooks?.predicted(res, s);
    if (s && s.swing > 0) this.parryLocal(s);
    const view = this.sample(rt);
    if (view) {
      const enemies: Target[] = view.enemies.map((e) => ({ id: e.id, x: e.x, y: e.y, r: ENEMY_R[e.k] }));
      const barrels: Target[] = view.barrels.map((b) => ({ id: b.id, x: b.x, y: b.y, r: 6 }));
      this.pred.stepBullets(enemies, barrels, (x, y, what, id, key) => {
        if (what === 'enemy') {
          this.predictedHits++;
          this.predHitKeys.set(key, performance.now());
        }
        this.hooks?.impact(x, y, what, id);
      });
    }
    this.inputs.push(inp);
    if (this.inputs.length > REDUNDANCY) this.inputs.shift();
    this.net.sendBin(encodeInputs(this.latestTick, this.inputs));
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

  myRenderPos() {
    return this.pred.renderPos(this.alpha);
  }

  private player(row: number[], id: number): PlayerSnap {
    const m = this.meta.get(id);
    const f = row[P.flags];
    return {
      id,
      name: m?.name ?? '…',
      c: row[P.c],
      k: CHAR_WIRE[row[P.k]] ?? 'archer',
      block: !!(f & PF.block),
      mode: row[P.mode],
      draw: row[P.draw] / 255,
      x: dpos(row[P.x]),
      y: dpos(row[P.y]),
      aim: dang8(row[P.aim]),
      hp: row[P.hp],
      maxHp: row[P.maxHp],
      lvl: row[P.lvl],
      xp: row[P.xp],
      xpNext: row[P.xpNext],
      down: !!(f & PF.down),
      rev: row[P.rev] / 255,
      inv: !!(f & PF.inv),
      off: !!(f & PF.off),
      items: m?.items ?? [],
      choices: m?.choices ?? null,
      pending: row[P.pending],
      kills: row[P.kills],
    };
  }

  private enemy(row: number[], id: number): EnemySnap {
    return {
      id,
      k: ENEMY_KINDS[row[E.k]] ?? 'grunt',
      x: dpos(row[E.x]),
      y: dpos(row[E.y]),
      hp: row[E.hp],
      maxHp: row[E.maxHp],
      a: dang8(row[E.a]),
      s: row[E.s] & 7,
      rooted: !!(row[E.s] & ES_ROOTED),
    };
  }

  private bullet(row: number[], id: number): BulletSnap {
    return {
      id,
      x: dpos(row[B.x]),
      y: dpos(row[B.y]),
      vx: row[B.vx],
      vy: row[B.vy],
      e: !!(row[B.flags] & BF.enemy),
      r: (row[B.flags] >> 1) & 7,
      arrow: !!(row[B.flags] & BF.arrow),
      o: row[B.o],
      sq: row[B.sq],
      i: row[B.i],
      t0: row[B.t0],
      x0: dpos(row[B.x]),
      y0: dpos(row[B.y]),
    };
  }

  private buildView(w: World): WorldView {
    const [pl, en, bu, ba, it, tr] = w.tables;
    return {
      tick: w.tick,
      phase: w.phase,
      floor: w.floor,
      left: w.left,
      stairs: w.stairs,
      players: [...pl].map(([id, r]) => this.player(r, id)),
      enemies: [...en].map(([id, r]) => this.enemy(r, id)),
      bullets: [...bu].map(([id, r]) => this.bullet(r, id)),
      barrels: [...ba].map(([id, r]): PropSnap => ({ id, x: dpos(r[X.x]), y: dpos(r[X.y]) })),
      items: [...it].map(([id, r]): ItemSnap => ({ id, k: ITEM_KINDS[r[I.k]] ?? 'potion', x: dpos(r[I.x]), y: dpos(r[I.y]) })),
      traps: this.traps(tr),
    };
  }

  private traps(t: World['tables'][number] | undefined): TrapSnap[] {
    return t ? [...t].map(([id, r]) => ({ id, x: dpos(r[TR.x]), y: dpos(r[TR.y]), c: r[TR.c] })) : [];
  }

  /** Remote entities interpolated at the render tick. Bullets are left empty; see renderBullets. */
  sample(t = this.tl.renderTick): WorldView | null {
    const br = this.tl.bracket(t);
    if (!br) return null;
    const { a, b, f } = br;
    const pos = (ra: number[], rb: number[] | undefined, ix: number, iy: number): [number, number] => {
      const x = dpos(ra[ix]);
      const y = dpos(ra[iy]);
      if (!rb) return [x, y];
      return [x + (dpos(rb[ix]) - x) * f, y + (dpos(rb[iy]) - y) * f];
    };
    const [pl, en, , ba, it, tr] = a.tables;
    const bt = b?.tables;
    const players = [...pl].map(([id, r]) => {
      const rb = bt?.[0].get(id);
      const p = this.player(rb && f >= 0.5 ? rb : r, id);
      [p.x, p.y] = pos(r, rb, P.x, P.y);
      if (rb) p.aim = lerpAng(dang8(r[P.aim]), dang8(rb[P.aim]), Math.min(1, f));
      return p;
    });
    const enemies: EnemySnap[] = [];
    for (const [id, r] of en) {
      if (this.deadIds.has(id)) continue;
      const rb = bt?.[1].get(id);
      const e = this.enemy(rb && f >= 0.5 ? rb : r, id);
      [e.x, e.y] = pos(r, rb, E.x, E.y);
      if (rb) e.a = lerpAng(dang8(r[E.a]), dang8(rb[E.a]), Math.min(1, f));
      enemies.push(e);
    }
    const barrels = [...ba].map(([id, r]): PropSnap => {
      const [x, y] = pos(r, bt?.[3].get(id), X.x, X.y);
      return { id, x, y };
    });
    const items = [...it].map(([id, r]): ItemSnap => ({ id, k: ITEM_KINDS[r[I.k]] ?? 'potion', x: dpos(r[I.x]), y: dpos(r[I.y]) }));
    return { tick: t, phase: a.phase, floor: a.floor, left: a.left, stairs: a.stairs, players, enemies, bullets: [], barrels, items, traps: this.traps(tr) };
  }

  /**
   * Bullets on the timeline that matches how they interact with you:
   * own shots are predicted locally; enemy shots are extrapolated to your predicted time so
   * dodging is honest; teammates' shots sit on the interpolated timeline with the enemies they hit.
   */
  renderBullets(now: number): RenderBullet[] {
    const out: RenderBullet[] = [];
    const map = this.map;
    const latest = this.tl.latest();
    if (!map || !latest) return out;
    const rt = this.tl.renderTick;
    const pt = this.predTick();
    const me = this.myRenderPos();
    const s = this.pred.state;
    const canHit = s && !s.down;
    const live = latest.tables[2];
    for (const id of this.firstSeen.keys()) if (!live.has(id)) this.firstSeen.delete(id);
    for (const id of this.hidden) if (!live.has(id)) this.hidden.delete(id);
    for (const id of this.shown.keys()) if (!live.has(id)) this.shown.delete(id);
    for (const id of this.parried.keys()) if (!live.has(id)) this.parried.delete(id);

    for (const [id, r] of live) {
      const o = r[B.o];
      if (o && o !== this.myId) continue;
      if (o === this.myId && r[B.sq] && this.pred.predictedSeqs.has(r[B.sq])) continue;
      const e = !!(r[B.flags] & BF.enemy);
      const until = this.parried.get(id);
      if (until !== undefined && (!e || now > until)) {
        this.parried.delete(id);
        this.hidden.delete(id);
      }
      if (this.hidden.has(id)) {
        if (e) continue;
        this.hidden.delete(id);
      }
      let seen = this.firstSeen.get(id);
      if (seen === undefined) this.firstSeen.set(id, (seen = now));
      const t0 = r[B.t0];
      const start = Math.max(t0, Math.min(rt, pt));
      const t = start + (pt - start) * Math.min(1, (now - seen) / 200);
      const p = bulletAt(map, dpos(r[B.x]), dpos(r[B.y]), r[B.vx], r[B.vy], t - t0);
      if (!p) continue;
      const rad = (r[B.flags] >> 1) & 7;
      const arrow = !!(r[B.flags] & BF.arrow);
      if (e && canHit && me) {
        const d = Math.hypot(p[0] - me[0], p[1] - me[1]);
        if (d < PLAYER_R + rad + 3 && shieldCovers(s, Math.atan2(-r[B.vy], -r[B.vx]))) {
          this.hidden.add(id);
          this.parried.set(id, now + this.rtt + 200);
          this.hooks?.parried(p[0], p[1], false);
          continue;
        }
        if (d < PLAYER_R + rad) {
          this.hidden.add(id);
          continue;
        }
      }
      this.shown.set(id, p);
      out.push({ id, x: p[0], y: p[1], vx: r[B.vx], vy: r[B.vy], e, r: rad, arrow });
    }

    const br = this.tl.bracket(rt);
    if (br)
      for (const [id, r] of br.a.tables[2]) {
        const o = r[B.o];
        if (!o || o === this.myId) continue;
        const p = bulletAt(map, dpos(r[B.x]), dpos(r[B.y]), r[B.vx], r[B.vy], rt - r[B.t0]);
        if (p) out.push({ id, x: p[0], y: p[1], vx: r[B.vx], vy: r[B.vy], e: false, r: (r[B.flags] >> 1) & 7, arrow: !!(r[B.flags] & BF.arrow) });
      }

    const a = this.alpha;
    for (const b of this.pred.bullets) out.push({ id: b.id, x: b.px + (b.x - b.px) * a, y: b.py + (b.y - b.py) * a, vx: b.vx, vy: b.vy, e: false, r: b.r, arrow: true });
    return out;
  }

  /** Enemy shots inside your active slash arc vanish locally; the server's deflected copy shows up as yours. */
  private parryLocal(s: MoveState) {
    const st = this.pred.stats;
    for (const [id, p] of this.shown) {
      if (this.hidden.has(id)) continue;
      const row = this.tl.latest()?.tables[2].get(id);
      if (!row || !(row[B.flags] & BF.enemy)) continue;
      const dx = p[0] - s.x;
      const dy = p[1] - s.y;
      const d = Math.hypot(dx, dy);
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - s.aim), Math.cos(Math.atan2(dy, dx) - s.aim)));
      if (d < st.reach + 8 && (d < 6 || off < st.arc)) {
        this.hidden.add(id);
        this.parried.set(id, performance.now() + this.rtt + 200);
        this.hooks?.parried(p[0], p[1], true);
      }
    }
  }
}
