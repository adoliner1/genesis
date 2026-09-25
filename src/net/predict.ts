import type { CharKind } from '../../shared/protocol';
import type { PlayerInput } from '../../shared/sim/input';
import { PM, copyMove, moveDiff, step, type Ctx, type MoveState, type StepResult } from '../../shared/sim/player';

const HISTORY = 240;
/** Below this the prediction counts as exact. */
const EPS = 0.01;
/** Corrections larger than this snap instead of blending (respawns, level restarts). */
const SNAP_PX = 48;

/**
 * Client-side prediction for the local player: runs the shared step on every input immediately,
 * keeps the inputs (and the world each one saw) until the server acknowledges them, and on each
 * authoritative state rewinds and replays the rest. Visual error is blended out.
 */
export class Predictor {
  seq = 0;
  state: MoveState | null = null;
  prev: MoveState | null = null;
  char: CharKind = 'archer';
  errX = 0;
  errY = 0;
  corrections = 0;
  snaps = 0;
  lastErr = 0;
  lastErrKey = '';
  /** Correction counts by size: <1px, 1-4px, 4-16px, >16px. */
  errBuckets = [0, 0, 0, 0];
  replayed = 0;
  serverState: MoveState | null = null;
  private hist = new Map<number, { inp: PlayerInput; ctx: Ctx; after: MoveState }>();

  reset() {
    this.state = this.prev = this.serverState = null;
    this.hist.clear();
    this.errX = this.errY = 0;
  }

  get pending() {
    return this.hist.size;
  }

  /** Advance one tick with a fresh input. Returns what happened so the caller can play instant feedback. */
  step(inp: PlayerInput, ctx: Ctx): StepResult | null {
    this.seq = inp.seq;
    if (!this.state) return null;
    this.prev = copyMove(this.state);
    const res = step(this.state, this.char, inp, ctx);
    this.hist.set(inp.seq, { inp, ctx, after: copyMove(this.state) });
    if (this.hist.size > HISTORY) this.hist.delete(this.hist.keys().next().value!);
    return res;
  }

  reconcile(ack: number, server: MoveState) {
    this.serverState = server;
    if (!this.state) {
      this.state = copyMove(server);
      this.prev = copyMove(server);
      return;
    }
    const h = this.hist.get(ack);
    const before = this.state;
    const [err, key] = h ? moveDiff(h.after, server) : [Infinity, ''];
    if (err > EPS) {
      if (h) {
        this.corrections++;
        this.lastErr = err;
        this.lastErrKey = key;
        this.errBuckets[err < 1 ? 0 : err < 4 ? 1 : err < 16 ? 2 : 3]++;
      }
      const s = copyMove(server);
      let prev = copyMove(s);
      let n = 0;
      for (const [seq, e] of this.hist) {
        if (seq <= ack) continue;
        prev = copyMove(s);
        step(s, this.char, e.inp, e.ctx);
        e.after = copyMove(s);
        n++;
      }
      this.replayed = n;
      this.state = s;
      this.prev = prev;
      // Blend only free-flying positions; attached positions come from the parent anyway.
      if (before.pm === PM.none && s.pm === PM.none) {
        this.errX += before.x - s.x;
        this.errY += before.y - s.y;
        if (Math.hypot(this.errX, this.errY) > SNAP_PX) {
          this.errX = this.errY = 0;
          this.prev = copyMove(s);
          this.snaps++;
        }
      } else {
        this.errX = this.errY = 0;
      }
    }
    for (const seq of this.hist.keys()) {
      if (seq > ack) break;
      this.hist.delete(seq);
    }
  }

  /** Free-flying render position: interpolated between the last two predicted ticks plus the fading correction. */
  renderPos(alpha: number): [number, number] | null {
    const s = this.state;
    if (!s) return null;
    const p = this.prev ?? s;
    if (p.pm !== s.pm) return [s.x + this.errX, s.y + this.errY];
    return [p.x + (s.x - p.x) * alpha + this.errX, p.y + (s.y - p.y) * alpha + this.errY];
  }

  decay(dt: number) {
    const k = Math.exp(-dt * 12);
    this.errX *= k;
    this.errY *= k;
    if (Math.abs(this.errX) < 0.01) this.errX = 0;
    if (Math.abs(this.errY) < 0.01) this.errY = 0;
  }
}
