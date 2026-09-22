import type { PlayerStats } from '../../shared/protocol';
import type { PlayerInput } from '../../shared/sim/input';
import type { TileMap } from '../../shared/sim/map';
import { BOUNCED, DEAD, bulletHalfStep } from '../../shared/sim/bullets';
import {
  BULLET_LIFE,
  BULLET_SPEED,
  MUZZLE,
  copyMove,
  gunner,
  moveError,
  shotAngles,
  type MoveState,
  type StepResult,
} from '../../shared/sim/movement';

const HISTORY = 150;
/** Below this the prediction counts as exact (float32 wire precision). */
const EPS = 0.02;
/** Corrections larger than this snap instead of blending (teleports, floor changes). */
const SNAP_PX = 40;

function worstField(a: MoveState, b: MoveState) {
  let key = '';
  let worst = -1;
  for (const k of ['x', 'y', 'vx', 'vy', 'dashing', 'dashT', 'fireT', 'kickT', 'stagger', 'down'] as const) {
    const d = Math.abs(Number(a[k]) - Number(b[k])) * (k === 'vx' || k === 'vy' ? 0.05 : 1);
    if (d > worst) {
      worst = d;
      key = k;
    }
  }
  return key;
}

export interface LocalBullet {
  id: number;
  seq: number;
  idx: number;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  bounce: number;
  pierce: number;
  r: number;
  life: number;
  hit: Set<number>;
}

export interface Target {
  id: number;
  x: number;
  y: number;
  r: number;
}

/**
 * Client-side prediction for the local player: runs the shared movement controller on every
 * input immediately, keeps the inputs it has not seen acknowledged, and on each authoritative
 * state rewinds to the server's result and replays the rest. Visual error is blended out.
 */
export class Predictor {
  seq = 0;
  state: MoveState | null = null;
  prev: MoveState | null = null;
  active = true;
  stats: PlayerStats = { speed: 92, dashCd: 36, fireCd: 7, multishot: 1, bounce: 0, pierce: 0, bulletR: 2 };
  map: TileMap | null = null;
  errX = 0;
  errY = 0;
  corrections = 0;
  snaps = 0;
  lastErr = 0;
  lastErrKey = '';
  /** Correction counts by size: <1px, 1-4px, 4-16px, >16px. */
  errBuckets = [0, 0, 0, 0];
  errKeys: Record<string, number> = {};
  replayed = 0;
  serverState: MoveState | null = null;
  bullets: LocalBullet[] = [];
  predictedSeqs = new Set<number>();
  private hist = new Map<number, { inp: PlayerInput; after: MoveState }>();
  private nextBulletId = -1;

  reset() {
    this.state = this.prev = this.serverState = null;
    this.hist.clear();
    this.bullets = [];
    this.errX = this.errY = 0;
  }

  get pending() {
    return this.hist.size;
  }

  /** Advance one tick with a fresh input. Returns what happened so the caller can play instant feedback. */
  step(inp: PlayerInput): StepResult | null {
    this.seq = inp.seq;
    let res: StepResult | null = null;
    if (this.state && this.map) {
      this.prev = copyMove(this.state);
      if (this.active) res = gunner.step(this.state, this.stats, inp, this.map);
    }
    this.hist.set(inp.seq, { inp, after: this.state ? copyMove(this.state) : (null as unknown as MoveState) });
    if (this.hist.size > HISTORY) this.hist.delete(this.hist.keys().next().value!);
    if (res?.fired && this.state) this.spawnShots(this.state, inp.seq);
    return res;
  }

  reconcile(ack: number, server: MoveState) {
    this.serverState = server;
    if (!this.map) return;
    const h = this.hist.get(ack);
    const before = this.state ? { x: this.state.x, y: this.state.y } : null;
    const err = h?.after ? moveError(h.after, server) : Infinity;
    if (err > EPS) {
      if (h?.after) {
        this.corrections++;
        this.lastErr = err;
        this.lastErrKey = worstField(h.after, server);
        this.errKeys[this.lastErrKey] = (this.errKeys[this.lastErrKey] ?? 0) + 1;
        this.errBuckets[err < 1 ? 0 : err < 4 ? 1 : err < 16 ? 2 : 3]++;
      }
      const s = copyMove(server);
      let prev = copyMove(s);
      let n = 0;
      for (const [seq, e] of this.hist) {
        if (seq <= ack) continue;
        prev = copyMove(s);
        if (this.active) gunner.step(s, this.stats, e.inp, this.map);
        e.after = copyMove(s);
        n++;
      }
      this.replayed = n;
      this.state = s;
      this.prev = prev;
      if (before) {
        this.errX += before.x - s.x;
        this.errY += before.y - s.y;
        if (Math.hypot(this.errX, this.errY) > SNAP_PX) {
          this.errX = this.errY = 0;
          this.prev = copyMove(s);
          this.snaps++;
        }
      }
    }
    for (const seq of this.hist.keys()) {
      if (seq > ack) break;
      this.hist.delete(seq);
    }
  }

  /** Render position: interpolated between the last two predicted ticks plus the fading correction offset. */
  renderPos(alpha: number): [number, number] | null {
    const s = this.state;
    if (!s) return null;
    const p = this.prev ?? s;
    return [p.x + (s.x - p.x) * alpha + this.errX, p.y + (s.y - p.y) * alpha + this.errY];
  }

  decay(dt: number) {
    const k = Math.exp(-dt * 12);
    this.errX *= k;
    this.errY *= k;
    if (Math.abs(this.errX) < 0.01) this.errX = 0;
    if (Math.abs(this.errY) < 0.01) this.errY = 0;
  }

  private spawnShots(s: MoveState, seq: number) {
    const st = this.stats;
    this.predictedSeqs.add(seq);
    if (this.predictedSeqs.size > 256) this.predictedSeqs.delete(this.predictedSeqs.values().next().value!);
    for (const [idx, a] of shotAngles(s.aim, st.multishot, seq).entries()) {
      const x = s.x + Math.cos(s.aim) * MUZZLE;
      const y = s.y + Math.sin(s.aim) * MUZZLE;
      this.bullets.push({
        id: this.nextBulletId--,
        seq,
        idx,
        x,
        y,
        px: x,
        py: y,
        vx: Math.cos(a) * BULLET_SPEED,
        vy: Math.sin(a) * BULLET_SPEED,
        bounce: st.bounce,
        pierce: st.pierce,
        r: st.bulletR,
        life: BULLET_LIFE,
        hit: new Set(),
      });
    }
  }

  /**
   * Fly own bullets on the predicted timeline against targets as currently displayed.
   * Impacts are cosmetic (the bullet disappears, a spark plays); damage stays server-side.
   */
  stepBullets(enemies: Target[], barrels: Target[], onImpact: (x: number, y: number, what: 'wall' | 'enemy' | 'barrel', id: number, key: string) => void) {
    if (!this.map) return;
    const keep: LocalBullet[] = [];
    outer: for (const b of this.bullets) {
      b.px = b.x;
      b.py = b.y;
      for (let s = 0; s < 2; s++) {
        const st = bulletHalfStep(b, this.map);
        if (st === BOUNCED) {
          b.hit.clear();
          onImpact(b.x, b.y, 'wall', 0, '');
        } else if (st === DEAD) {
          onImpact(b.x, b.y, 'wall', 0, '');
          continue outer;
        }
        for (const br of barrels)
          if (Math.hypot(br.x - b.x, br.y - b.y) < 7 + b.r) {
            onImpact(b.x, b.y, 'barrel', br.id, '');
            continue outer;
          }
        for (const e of enemies) {
          if (b.hit.has(e.id) || Math.hypot(e.x - b.x, e.y - b.y) >= e.r + b.r) continue;
          b.hit.add(e.id);
          onImpact(b.x, b.y, 'enemy', e.id, `${b.seq}:${b.idx}:${e.id}`);
          if (b.pierce > 0) b.pierce--;
          else continue outer;
        }
      }
      if (--b.life > 0) keep.push(b);
    }
    this.bullets = keep;
  }
}
