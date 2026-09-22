import { TICK_RATE } from '../../shared/protocol';
import type { World } from '../../shared/net/snapshot';

const TICK_MS = 1000 / TICK_RATE;
const WINDOW_MS = 3000;

/**
 * Snapshot buffer plus a smoothed estimate of the server clock. Remote entities are drawn at
 * `renderTick`, which trails the newest snapshot by just enough to cover send interval + jitter,
 * and is steered by small rate changes rather than jumps.
 */
export class Timeline {
  states: World[] = [];
  renderTick = NaN;
  delayTicks = 2;
  jitterMs = 0;
  sendInterval = 1;
  extrapolating = false;
  extrapolatedFrames = 0;
  private samples: { at: number; v: number }[] = [];
  private offset = NaN;

  clear() {
    this.states = [];
    this.samples = [];
    this.offset = NaN;
    this.renderTick = NaN;
  }

  push(w: World, now: number) {
    const s = this.states;
    let i = s.length;
    while (i > 0 && s[i - 1].tick > w.tick) i--;
    if (i > 0 && s[i - 1].tick === w.tick) return;
    s.splice(i, 0, w);
    while (s.length > 2 && s[0].tick < w.tick - TICK_RATE * 2) s.shift();

    if (s.length >= 3) {
      const gaps: number[] = [];
      for (let k = Math.max(1, s.length - 12); k < s.length; k++) gaps.push(s[k].tick - s[k - 1].tick);
      gaps.sort((a, b) => a - b);
      this.sendInterval = gaps[gaps.length >> 1];
    }

    this.samples.push({ at: now, v: w.tick * TICK_MS - now });
    while (this.samples.length && this.samples[0].at < now - WINDOW_MS) this.samples.shift();
    let max = -Infinity;
    let sum = 0;
    for (const x of this.samples) {
      if (x.v > max) max = x.v;
      sum += x.v;
    }
    const mean = sum / this.samples.length;
    let varSum = 0;
    for (const x of this.samples) varSum += (x.v - mean) ** 2;
    this.jitterMs = Math.sqrt(varSum / this.samples.length);
    this.offset = max;
    const want = this.sendInterval + 0.35 + (2.2 * this.jitterMs) / TICK_MS;
    this.delayTicks += (Math.max(1.5, Math.min(10, want)) - this.delayTicks) * 0.05;
  }

  /** Newest server tick we believe exists right now (fractional). */
  serverTick(now: number) {
    return (now + this.offset) / TICK_MS;
  }

  advance(dtMs: number, now: number) {
    if (!Number.isFinite(this.offset)) return;
    const target = this.serverTick(now) - this.delayTicks;
    if (!Number.isFinite(this.renderTick) || Math.abs(target - this.renderTick) > 8) {
      this.renderTick = target;
      return;
    }
    const err = target - this.renderTick;
    const rate = 1 + Math.max(-0.12, Math.min(0.12, err * 0.08));
    this.renderTick += (dtMs / TICK_MS) * rate;
  }

  /** Bracketing snapshots for tick t. `f` may exceed 1 briefly when extrapolating past the newest one. */
  bracket(t: number): { a: World; b: World | null; f: number } | null {
    const s = this.states;
    if (!s.length) return null;
    let i = s.length - 1;
    while (i > 0 && s[i].tick > t) i--;
    const a = s[i];
    const b = s[i + 1];
    if (b) {
      this.extrapolating = false;
      return { a, b, f: Math.max(0, Math.min(1, (t - a.tick) / (b.tick - a.tick))) };
    }
    const prev = s[i - 1];
    this.extrapolating = t > a.tick + 0.01;
    if (this.extrapolating) this.extrapolatedFrames++;
    if (!prev || !this.extrapolating) return { a, b: null, f: 0 };
    const ahead = Math.min(3, t - a.tick);
    return { a: prev, b: a, f: 1 + ahead / (a.tick - prev.tick) };
  }

  latest(): World | null {
    return this.states[this.states.length - 1] ?? null;
  }
}
