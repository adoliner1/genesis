import { TILE } from '../shared/protocol.ts';
import { los as wallLos, type TileMap } from '../shared/sim/map.ts';
import { SEND_MARGIN, VISION_R, fov, opaqueGrid, packBits, type VisionBlocker } from '../shared/sim/vision.ts';

export interface Viewer {
  id: number;
  team: number;
  x: number;
  y: number;
  /** False for players who hold a slot but have no eyes (offline). */
  eyes: boolean;
}

export interface Blocker extends VisionBlocker {
  id: number;
  /** Tick after which the blocker disappears (Infinity = until removed). */
  until: number;
}

interface TeamGrid {
  /** Tiles someone on the team can actually see. */
  sees: Uint8Array;
  /** Tiles whose contents are streamed to the team: `sees` plus a margin, dilated by one tile. */
  send: Uint8Array;
  explored: Uint8Array;
}

/**
 * Authoritative fog of war. Recomputed once per tick from every player's eyes; answers
 * "can player X see point Y" for gameplay (backstab, AI reactions) and decides what each team is sent.
 */
export class Vision {
  private map: TileMap;
  private opaque: Uint8Array;
  private own = new Map<number, Uint8Array>();
  private teams = new Map<number, TeamGrid>();
  private teamOf = new Map<number, number>();
  private blockers: Blocker[] = [];
  private nextBlocker = 1;
  private dirty = true;
  private scratch: Uint8Array;

  constructor(map: TileMap) {
    this.map = map;
    this.opaque = opaqueGrid(map);
    this.scratch = new Uint8Array(map.w * map.h);
  }

  // ---------- vision-blocking volumes ----------
  addBlocker(x: number, y: number, r: number, untilTick = Infinity): number {
    const id = this.nextBlocker++;
    this.blockers.push({ id, x, y, r, until: untilTick });
    this.dirty = true;
    return id;
  }

  removeBlocker(id: number) {
    const n = this.blockers.length;
    this.blockers = this.blockers.filter((b) => b.id !== id);
    if (this.blockers.length !== n) this.dirty = true;
  }

  get activeBlockers(): readonly Blocker[] {
    return this.blockers;
  }

  // ---------- per-tick update ----------
  update(tick: number, viewers: readonly Viewer[]) {
    const before = this.blockers.length;
    this.blockers = this.blockers.filter((b) => b.until >= tick);
    if (this.dirty || this.blockers.length !== before) {
      this.opaque = opaqueGrid(this.map, this.blockers);
      this.dirty = false;
    }
    const { w, h } = this.map;
    const n = w * h;
    const exact = VISION_R * VISION_R;
    for (const t of this.teams.values()) {
      t.sees.fill(0);
      t.send.fill(0);
    }
    this.teamOf.clear();
    for (const id of this.own.keys()) if (!viewers.some((v) => v.id === id)) this.own.delete(id);
    for (const v of viewers) {
      this.teamOf.set(v.id, v.team);
      let team = this.teams.get(v.team);
      if (!team) this.teams.set(v.team, (team = { sees: new Uint8Array(n), send: new Uint8Array(n), explored: new Uint8Array(n) }));
      let own = this.own.get(v.id);
      if (!own) this.own.set(v.id, (own = new Uint8Array(n)));
      own.fill(0);
      if (!v.eyes) continue;
      const { sees, send, explored } = team;
      fov(w, h, this.opaque, v.x, v.y, VISION_R + SEND_MARGIN, (i, d2) => {
        send[i] = 1;
        if (d2 <= exact) own[i] = sees[i] = explored[i] = 1;
      });
    }
    const s = this.scratch;
    for (const t of this.teams.values()) {
      s.set(t.send);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (s[i]) continue;
          if ((x > 0 && s[i - 1]) || (x < w - 1 && s[i + 1]) || (y > 0 && s[i - w]) || (y < h - 1 && s[i + w]) ||
            (x > 0 && y > 0 && s[i - w - 1]) || (x < w - 1 && y > 0 && s[i - w + 1]) || (x > 0 && y < h - 1 && s[i + w - 1]) || (x < w - 1 && y < h - 1 && s[i + w + 1]))
            t.send[i] = 1;
        }
    }
  }

  // ---------- queries ----------
  private idx(x: number, y: number) {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return -1;
    return ty * this.map.w + tx;
  }

  /** Point test against a grid; a circle counts if its centre or any of 4 rim points is in a visible tile. */
  private hit(grid: Uint8Array | undefined, x: number, y: number, r: number) {
    if (!grid) return false;
    const at = (px: number, py: number) => {
      const i = this.idx(px, py);
      return i >= 0 && grid[i] === 1;
    };
    if (at(x, y)) return true;
    if (r <= 0) return false;
    const k = r * 0.8;
    return at(x + k, y) || at(x - k, y) || at(x, y + k) || at(x, y - k);
  }

  /** Can player `pid` (via shared team vision) see the point / a body of radius `r` at (x, y)? */
  canSee(pid: number, x: number, y: number, r = 0): boolean {
    const team = this.teamOf.get(pid);
    return team !== undefined && this.hit(this.teams.get(team)?.sees, x, y, r);
  }

  /** Can player `pid` see it with their own eyes, ignoring teammates? */
  seesDirectly(pid: number, x: number, y: number, r = 0): boolean {
    return this.hit(this.own.get(pid), x, y, r);
  }

  teamSees(team: number, x: number, y: number, r = 0): boolean {
    return this.hit(this.teams.get(team)?.sees, x, y, r);
  }

  /** Is (x, y) inside the region streamed to `team` (visible plus margin)? */
  streamed(team: number, x: number, y: number, r = 0): boolean {
    return this.hit(this.teams.get(team)?.send, x, y, r);
  }

  /**
   * Pixel-precise sight line between two points for arbitrary observers (e.g. "can this enemy see the Rogue"),
   * blocked by walls and by smoke. `maxDist` defaults to the player sight radius.
   */
  lineOfSight(x0: number, y0: number, x1: number, y1: number, maxDist = VISION_R * TILE): boolean {
    if (Math.hypot(x1 - x0, y1 - y0) > maxDist) return false;
    if (!wallLos(this.map, x0, y0, x1, y1)) return false;
    for (const b of this.blockers) if (segCircle(x0, y0, x1, y1, b.x, b.y, b.r)) return false;
    return true;
  }

  explored(team: number): string {
    const t = this.teams.get(team);
    return packBits(t ? t.explored : new Uint8Array(this.map.w * this.map.h));
  }
}

function segCircle(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / l2));
  const px = x0 + dx * t - cx;
  const py = y0 + dy * t - cy;
  return px * px + py * py <= r * r;
}
