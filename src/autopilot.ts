import { T, TILE, type PlayerStats, type WorldView } from '../shared/protocol';
import { MODE, type MoveState } from '../shared/sim/movement';
import { SPRINT_MULT } from '../shared/sim/kits/archer';
import { noButtons, type Buttons } from '../shared/sim/input';

export interface BotView extends Omit<WorldView, 'bullets'> {
  bullets: { x: number; y: number; vx: number; vy: number; e: boolean }[];
}

export interface BotOutput extends Buttons {
  mx: number;
  my: number;
  aim: number;
}

type Threat = { d: number; b: { x: number; y: number } } | undefined;

/** Dev/demo helper enabled with ?bot=1: plays the local character so multi-tab tests can run hands-free. */
export class Autopilot {
  private next: { x: number; y: number } | null = null;
  private lastPath = 0;
  private strafe = 1;
  private lastChoose = 0;
  private releaseUntil = 0;
  private kiteUntil = 0;
  private tapAt = 0;
  private lastTrap = 0;
  private lastBash = 0;
  aimX = 0;
  aimY = 0;

  private frontier: { x: number; y: number }[] = [];
  private lastFrontier = 0;

  constructor(
    private map: () => { w: number; h: number; tiles: Uint8Array } | null,
    private choose: (i: number) => void,
    private explored: () => Uint8Array | null = () => null,
  ) {}

  /** Explored walkable tiles next to unexplored ones: where to go when nothing is in sight. */
  private findFrontier(): { x: number; y: number }[] {
    const m = this.map()!;
    const ex = this.explored();
    if (!ex || ex.length !== m.tiles.length) return [];
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < ex.length; i++) {
      if (!ex[i] || !this.walk(m.tiles[i])) continue;
      const x = i % m.w;
      if ((x > 0 && !ex[i - 1]) || (x < m.w - 1 && !ex[i + 1]) || (i >= m.w && !ex[i - m.w]) || (i + m.w < ex.length && !ex[i + m.w]))
        out.push({ x: x * TILE + 8, y: Math.floor(i / m.w) * TILE + 8 });
    }
    return out;
  }

  private walk(t: number) {
    return t === T.Floor || t === T.Spikes || t === T.Stairs;
  }

  private los(x0: number, y0: number, x1: number, y1: number) {
    const m = this.map()!;
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6);
    for (let i = 1; i < n; i++) {
      const x = Math.floor((x0 + ((x1 - x0) * i) / n) / TILE);
      const y = Math.floor((y0 + ((y1 - y0) * i) / n) / TILE);
      if (m.tiles[y * m.w + x] === T.Wall) return false;
    }
    return true;
  }

  private pathStep(fx: number, fy: number, goals: { x: number; y: number }[]) {
    const m = this.map()!;
    const start = Math.floor(fy / TILE) * m.w + Math.floor(fx / TILE);
    const goal = new Set(goals.map((g) => Math.floor(g.y / TILE) * m.w + Math.floor(g.x / TILE)));
    const prev = new Int32Array(m.w * m.h).fill(-2);
    prev[start] = -1;
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      if (goal.has(i)) {
        let c = i;
        while (prev[c] !== start && prev[c] >= 0) c = prev[c];
        return { x: (c % m.w) * TILE + 8, y: Math.floor(c / m.w) * TILE + 8 };
      }
      for (const n of [i - 1, i + 1, i - m.w, i + m.w]) {
        if (n < 0 || n >= m.tiles.length || prev[n] !== -2 || !this.walk(m.tiles[n])) continue;
        prev[n] = i;
        q.push(n);
      }
    }
    return null;
  }

  step(s: BotView, myId: number, now: number, ms: MoveState | null, st: PlayerStats): BotOutput {
    const me = s.players.find((p) => p.id === myId);
    const out: BotOutput = { mx: 0, my: 0, aim: 0, ...noButtons() };
    if (!me || !this.map() || me.down) return out;
    if (me.choices && now - this.lastChoose > 600) {
      this.lastChoose = now;
      this.choose(Math.floor(Math.random() * 3));
    }
    let target = null as null | { x: number; y: number; d: number };
    for (const e of s.enemies) {
      const d = Math.hypot(e.x - me.x, e.y - me.y) * (this.los(me.x, me.y, e.x, e.y) ? 1 : 2.5);
      if (!target || d < target.d) target = { x: e.x, y: e.y, d };
    }
    const seen = target && this.los(me.x, me.y - 3, target.x, target.y);
    const realD = target ? Math.hypot(target.x - me.x, target.y - me.y) : 1e9;

    let goals: { x: number; y: number }[] = [];
    const nearItem = s.items.find((i) => Math.hypot(i.x - me.x, i.y - me.y) < 120 && (i.k !== 'potion' || me.hp < me.maxHp));
    const downed = s.players.filter((p) => p.id !== myId && p.down);
    if (downed.length && (!target || realD > 70)) goals = downed;
    else if (nearItem && (!target || realD > 60)) goals = [nearItem];
    else if (target && !(seen && realD < (me.k === 'knight' ? 40 : 110))) goals = [target];
    else if (!target && s.stairs) {
      const m = this.map()!;
      for (let i = 0; i < m.tiles.length; i++) if (m.tiles[i] === T.Stairs) goals.push({ x: (i % m.w) * TILE + 8, y: Math.floor(i / m.w) * TILE + 8 });
    } else if (!target) {
      if (now - this.lastFrontier > 700) {
        this.lastFrontier = now;
        this.frontier = this.findFrontier();
      }
      // Spread out so the party's shared vision covers more ground.
      const mates = s.players.filter((p) => p.id !== myId && !p.off);
      const apart = this.frontier.filter((f) => mates.every((m) => Math.hypot(f.x - m.x, f.y - m.y) > 160));
      goals = apart.length ? apart : this.frontier;
    }

    if (goals.length) {
      if (now - this.lastPath > 150) {
        this.lastPath = now;
        this.next = this.pathStep(me.x, me.y, goals);
      }
      if (this.next) {
        const dx = this.next.x - me.x;
        const dy = this.next.y - me.y;
        const d = Math.hypot(dx, dy) || 1;
        out.mx = dx / d;
        out.my = dy / d;
      }
    } else if (target && seen) {
      const dx = target.x - me.x;
      const dy = target.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      if (Math.random() < 0.01) this.strafe *= -1;
      const away = me.k === 'knight' ? 1 : realD < 55 ? -1 : realD > 90 ? 0.6 : 0;
      out.mx = (dx / d) * away + (-dy / d) * this.strafe * 0.8;
      out.my = (dy / d) * away + (dx / d) * this.strafe * 0.8;
      const m = this.map()!;
      const nx = Math.floor((me.x + out.mx * 12) / TILE);
      const ny = Math.floor((me.y + out.my * 12) / TILE);
      if (!this.walk(m.tiles[ny * m.w + nx])) {
        this.strafe *= -1;
        out.mx = -out.mx;
        out.my = -out.my;
      }
    }

    if (target) {
      out.aim = Math.atan2(target.y - (me.y - 3), target.x - me.x);
      this.aimX = target.x;
      this.aimY = target.y;
    } else {
      out.aim = Math.atan2(out.my, out.mx);
      this.aimX = me.x + out.mx * 40;
      this.aimY = me.y + out.my * 40;
    }
    if (!ms) return out;
    const threat = s.bullets
      .filter((b) => b.e)
      .map((b) => ({ b, d: Math.hypot(b.x - me.x, b.y - me.y) }))
      .filter(({ b, d }) => d < 60 && (me.x - b.x) * b.vx + (me.y - b.y) * b.vy > 0)
      .sort((a, b) => a.d - b.d)[0];
    if (me.k === 'knight') this.knight(out, ms, st, target, !!seen, realD, threat, now);
    else this.archer(out, ms, st, target, !!seen, realD, threat, now);
    return out;
  }

  private archer(out: BotOutput, ms: MoveState, st: PlayerStats, target: { x: number; y: number } | null, seen: boolean, d: number, threat: Threat, now: number) {
    const speed = Math.hypot(ms.vx, ms.vy);
    if (target && seen && d < 55 && now > this.kiteUntil + 1500 && ms.ab >= 1) this.kiteUntil = now + 1400;
    if (threat && threat.d < 30 && now > this.kiteUntil + 800) this.kiteUntil = now + 700;
    if (now < this.kiteUntil && target) {
      // Sprint away, release and tap for a slide, draw mid-glide.
      const a = Math.atan2(ms.y - target.y, ms.x - target.x) + 0.5;
      if (ms.mode === MODE.walk || ms.mode === MODE.sprint) {
        out.mx = Math.cos(a);
        out.my = Math.sin(a);
        out.move = !(ms.mode === MODE.sprint && speed >= st.speed * SPRINT_MULT * 0.95);
        out.a = false;
      }
      if (ms.mode === MODE.coast && now > this.tapAt) {
        out.movePress = true;
        this.tapAt = now + 300;
      }
      if (ms.mode !== MODE.walk) {
        out.a = ms.mode === MODE.slide && ms.act > 2;
        return;
      }
    }
    if (!target) return;
    if (seen && d < 240) {
      if (d > 60 && d < 130) out.mx = out.my = 0;
      const want = d < 90 ? 0.45 : 0.95;
      if (now < this.releaseUntil) out.a = false;
      else if (ms.draw >= st.drawTicks * want) {
        out.a = false;
        this.releaseUntil = now + 60;
      } else out.a = true;
    }
    if (seen && d < 70 && ms.spec >= 1 && now - this.lastTrap > 2500) {
      this.lastTrap = now;
      out.bPress = true;
    }
  }

  private knight(out: BotOutput, ms: MoveState, st: PlayerStats, target: { x: number; y: number } | null, seen: boolean, d: number, threat: Threat, now: number) {
    if (threat && ms.atkT <= 0 && threat.d < st.reach + 6) {
      out.aim = Math.atan2(threat.b.y - ms.y, threat.b.x - ms.x);
      out.aPress = true;
      return;
    }
    if (threat && threat.d < 50) {
      out.aim = Math.atan2(threat.b.y - ms.y, threat.b.x - ms.x);
      out.b = true;
      return;
    }
    if (!target || !seen) return;
    if (d < 75 && d > 30 && ms.ab >= 1 && now - this.lastBash > 1200) {
      this.lastBash = now;
      out.movePress = true;
    }
    out.move = (ms.mode === MODE.bash || ms.mode === MODE.skid) && now - this.lastBash < 450;
    if (d < st.reach + 12) out.a = true;
  }
}
