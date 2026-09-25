import { DT, TILE, type CharKind } from '../protocol.ts';
import { BTN, inputAim, type PlayerInput } from './input.ts';
import { T, isSolid, tileAt, type TileMap } from './level.ts';

/*
 * Player movement shared by the server and client prediction. Everything a step reads comes from
 * its arguments, so replaying the same inputs against the same Ctx gives the same result.
 *
 * Positions: x is the horizontal centre, y is the feet.
 */

export const KIT = {
  ogre: { w: 16, h: 20, speed: 100, jump: 410, mass: 1.5, heavyMass: 4 },
  archer: { w: 10, h: 14, speed: 145, jump: 470, mass: 1, heavyMass: 1 },
} as const;

export const GRAV = 1800;
const MAX_FALL = 620;
const HEAVY_GRAV = 1.7;
const HEAVY_FALL = 900;
const HEAVY_SPEED = 0.55;
const HEAVY_JUMP = 0.55;
const GROUND_ACC = 1600;
const GROUND_DEC = 2000;
const AIR_ACC = 1000;
const AIR_DEC = 250;
const COYOTE = 6;
const JUMP_BUFFER = 6;
export const POUND_V = 820;
export const ROPE_RANGE = 260;
const ROPE_MIN = 12;
const CLIMB = 110;
const SWING_ACC = 520;
const SWING_MAX = 700;
/** How close (px, horizontally) your hand must be to a hanging rope to catch it. */
const ROPE_CATCH = 10;
const HOOK_CATCH = 20;
export const ARROW_V = 540;
export const ARROW_G = 700;
/** Ticks without re-grabbing after letting go of something, so you do not instantly re-catch it. */
const REGRAB = 12;

/** How a player is attached to a parent body (par). */
export const PM = { none: 0, stand: 1, hang: 2, carry: 3 } as const;

/** Body kinds. Players that can be stood on (ogres) show up as bodies of kind `ogre`. */
export const BK = { lift: 1, gate: 2, hook: 3, lever: 4, plate: 5, target: 6, goal: 7, checkpoint: 8, ogre: 9 } as const;
export const BODY_KINDS = ['', 'lift', 'gate', 'hook', 'lever', 'plate', 'target', 'goal', 'checkpoint', 'ogre'] as const;

/** Top-left anchored box. `s` is kind-specific state (switch on/off). */
export interface SimBody {
  id: number;
  k: number;
  x: number;
  y: number;
  w: number;
  h: number;
  s: number;
}

/** A rope left in the world: hangs straight down from its anchor while nobody swings on it. */
export interface SimRope {
  id: number;
  ax: number;
  ay: number;
  len: number;
}

/** The world as the player saw it when they sent this input. */
export interface Ctx {
  map: TileMap;
  bodies: SimBody[];
  ropes: SimRope[];
}

export const bodySolid = (k: number) => k === BK.lift || k === BK.gate;
/** Stand-on-top-only bodies (jump up through, land on top). */
export const bodyTop = (k: number) => k === BK.ogre;

export interface MoveState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: number;
  gnd: number;
  coy: number;
  jbuf: number;
  /** Ticks left of falling through one-way platforms. */
  drop: number;
  heavy: number;
  pound: number;
  /** Parent body id and attach mode (PM), with the offset from the parent's top-centre. */
  par: number;
  pm: number;
  ox: number;
  oy: number;
  /** Rope: attached flag, anchor, current length, and world rope id (0 = the archer's own line). */
  rm: number;
  rax: number;
  ray: number;
  rlen: number;
  rid: number;
  rcd: number;
  acd: number;
  gcd: number;
  /** Ticks after being thrown or launched: weak air control, and the rise is not cut short by letting go of jump. */
  stun: number;
  /** Ogre: id of the player being carried (set by the server). */
  held: number;
}

export const MOVE_KEYS = [
  'x', 'y', 'vx', 'vy', 'face', 'gnd', 'coy', 'jbuf', 'drop', 'heavy', 'pound', 'par', 'pm', 'ox', 'oy',
  'rm', 'rax', 'ray', 'rlen', 'rid', 'rcd', 'acd', 'gcd', 'stun', 'held',
] as const satisfies readonly (keyof MoveState)[];

export const newMoveState = (): MoveState => ({
  x: 0, y: 0, vx: 0, vy: 0, face: 1, gnd: 0, coy: 0, jbuf: 0, drop: 0, heavy: 0, pound: 0, par: 0, pm: 0, ox: 0, oy: 0,
  rm: 0, rax: 0, ray: 0, rlen: 0, rid: 0, rcd: 0, acd: 0, gcd: 0, stun: 0, held: 0,
});

export const copyMove = (s: MoveState): MoveState => {
  const o = newMoveState();
  for (const k of MOVE_KEYS) o[k] = s[k];
  return o;
};

/** Largest field difference between two states. While attached to the same parent, world position is not compared: it follows the parent. */
export function moveDiff(a: MoveState, b: MoveState): [number, string] {
  const attached = a.pm !== PM.none && a.pm === b.pm && a.par === b.par;
  let worst = 0;
  let key = '';
  for (const k of MOVE_KEYS) {
    if (attached && (k === 'x' || k === 'y' || k === 'vx' || k === 'vy')) continue;
    const d = Math.abs(a[k] - b[k]);
    if (d > worst) {
      worst = d;
      key = k;
    }
  }
  return [worst, key];
}

export const massOf = (char: CharKind, s: MoveState) => (s.heavy ? KIT[char].heavyMass : KIT[char].mass);
export const handOf = (char: CharKind, s: MoveState): [number, number] => [s.x, s.y - KIT[char].h + 3];

export interface StepResult {
  jumped: boolean;
  /** 0 = no landing, 1 = soft, 2 = hard. */
  land: number;
  pound: boolean;
  heavy: boolean;
  rope: { x: number; y: number; hit: boolean } | null;
  /** Archer let go of their own line and left it hanging. */
  leave: { ax: number; ay: number; len: number } | null;
  /** World rope id snapped by a heavy grab. */
  snap: number;
  arrow: { x: number; y: number; vx: number; vy: number } | null;
  grab: boolean;
  throw: boolean;
  lever: number;
  escape: boolean;
}

const newResult = (): StepResult => ({
  jumped: false, land: 0, pound: false, heavy: false, rope: null, leave: null, snap: 0, arrow: null,
  grab: false, throw: false, lever: 0, escape: false,
});

const dec = (v: number) => (v > 0 ? v - 1 : 0);
const approach = (v: number, to: number, d: number) => (v < to ? Math.min(to, v + d) : Math.max(to, v - d));

export function findBody(ctx: Ctx, id: number): SimBody | undefined {
  for (const b of ctx.bodies) if (b.id === id) return b;
  return undefined;
}

/** Where an attached player's feet go for a given parent body. */
export function attachedPos(s: MoveState, p: SimBody, char: CharKind): [number, number] {
  if (s.pm === PM.hang) return [p.x + p.w / 2, p.y + p.h + KIT[char].h];
  return [p.x + p.w / 2 + s.ox, p.y + s.oy];
}

function unparent(s: MoveState) {
  s.par = 0;
  s.pm = PM.none;
  s.ox = s.oy = 0;
}

// ---------- collision ----------

export function overlapsSolid(ctx: Ctx, l: number, t: number, r: number, b: number, ignore = 0): boolean {
  const m = ctx.map;
  const tx0 = Math.floor(l / TILE);
  const tx1 = Math.floor((r - 1e-6) / TILE);
  const ty0 = Math.floor(t / TILE);
  const ty1 = Math.floor((b - 1e-6) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (isSolid(tileAt(m, tx, ty))) return true;
  for (const o of ctx.bodies) if (o.id !== ignore && bodySolid(o.k) && l < o.x + o.w && r > o.x && t < o.y + o.h && b > o.y) return true;
  return false;
}

/** Moves in ≤1px steps so nothing tunnels. Returns true if blocked. */
function moveX(ctx: Ctx, s: MoveState, hw: number, h: number, dx: number, ignore = 0): boolean {
  let rem = dx;
  while (rem !== 0) {
    const stp = Math.abs(rem) > 1 ? Math.sign(rem) : rem;
    const nx = s.x + stp;
    if (overlapsSolid(ctx, nx - hw, s.y - h, nx + hw, s.y, ignore)) {
      // Close the sub-pixel gap to whatever we hit so positions settle on exact edges.
      for (const c of [...edgesX(ctx, s, hw, h, nx, stp), stp > 0 ? Math.floor((nx + hw) / TILE) * TILE - hw : Math.ceil((nx - hw) / TILE) * TILE + hw])
        if ((stp > 0 ? c > s.x && c < nx : c < s.x && c > nx) && !overlapsSolid(ctx, c - hw, s.y - h, c + hw, s.y, ignore)) {
          s.x = c;
          break;
        }
      return true;
    }
    s.x = nx;
    rem -= stp;
  }
  return false;
}

/** Candidate x positions flush against solid bodies we would run into. */
function edgesX(ctx: Ctx, s: MoveState, hw: number, h: number, nx: number, dir: number): number[] {
  const out: number[] = [];
  for (const o of ctx.bodies)
    if (bodySolid(o.k) && s.y - h < o.y + o.h && s.y > o.y && nx - hw < o.x + o.w && nx + hw > o.x) out.push(dir > 0 ? o.x - hw : o.x + o.w + hw);
  return out;
}

/** Returns 0 = free, -1 = blocked by tiles, or the id of the body landed on. */
function moveY(ctx: Ctx, s: MoveState, hw: number, h: number, dy: number, drop: boolean): number {
  let rem = dy;
  const l = s.x - hw;
  const r = s.x + hw;
  while (rem !== 0) {
    const stp = Math.abs(rem) > 1 ? Math.sign(rem) : rem;
    const ny = s.y + stp;
    if (overlapsSolid(ctx, l, ny - h, r, ny)) {
      if (stp > 0)
        for (const o of ctx.bodies)
          if (bodySolid(o.k) && l < o.x + o.w && r > o.x && s.y <= o.y + 0.001 && ny > o.y) {
            s.y = o.y;
            return o.id;
          }
      const c = stp > 0 ? Math.floor(ny / TILE) * TILE : Math.ceil((ny - h) / TILE) * TILE + h;
      if ((stp > 0 ? c > s.y && c < ny : c < s.y && c > ny) && !overlapsSolid(ctx, l, c - h, r, c)) s.y = c;
      return -1;
    }
    if (stp > 0 && !drop) {
      const line = Math.floor(ny / TILE) * TILE;
      if (s.y <= line && ny > line) {
        const ty = line / TILE;
        for (let tx = Math.floor(l / TILE); tx <= Math.floor((r - 1e-6) / TILE); tx++)
          if (tileAt(ctx.map, tx, ty) === T.OneWay) {
            s.y = line;
            return -1;
          }
      }
      for (const o of ctx.bodies)
        if (bodyTop(o.k) && l < o.x + o.w && r > o.x && s.y <= o.y && ny > o.y) {
          s.y = o.y;
          return o.id;
        }
    }
    s.y = ny;
    rem -= stp;
  }
  return 0;
}

function onOneWay(ctx: Ctx, s: MoveState, hw: number): boolean {
  if (s.y % TILE !== 0) return false;
  const ty = s.y / TILE;
  let any = false;
  for (let tx = Math.floor((s.x - hw) / TILE); tx <= Math.floor((s.x + hw - 1e-6) / TILE); tx++) {
    const t = tileAt(ctx.map, tx, ty);
    if (isSolid(t)) return false;
    if (t === T.OneWay) any = true;
  }
  return any;
}

/** Rope arrow: first solid tile along the aim. Only wood holds. */
export function ropeCast(map: TileMap, x: number, y: number, a: number): { x: number; y: number; hit: boolean } {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  for (let d = 2; d <= ROPE_RANGE; d += 2) {
    const px = x + dx * d;
    const py = y + dy * d;
    const t = tileAt(map, Math.floor(px / TILE), Math.floor(py / TILE));
    if (isSolid(t)) return { x: px, y: py, hit: t === T.Wood };
  }
  return { x: x + dx * ROPE_RANGE, y: y + dy * ROPE_RANGE, hit: false };
}

// ---------- step ----------

export function step(s: MoveState, char: CharKind, inp: PlayerInput, ctx: Ctx): StepResult {
  const k = KIT[char];
  const hw = k.w / 2;
  const res = newResult();
  const b = inp.buttons;
  const mx = inp.mx / 127;
  const my = inp.my / 127;
  const aim = inputAim(inp);
  s.rcd = dec(s.rcd);
  s.acd = dec(s.acd);
  s.gcd = dec(s.gcd);
  s.stun = dec(s.stun);
  s.drop = dec(s.drop);
  s.coy = dec(s.coy);
  s.jbuf = b & BTN.JUMP_P ? JUMP_BUFFER : dec(s.jbuf);
  if (mx > 0.2) s.face = 1;
  else if (mx < -0.2) s.face = -1;

  if (char === 'ogre' && b & BTN.SEC_P) {
    s.heavy = s.heavy ? 0 : 1;
    res.heavy = true;
  }

  // Being carried: only a jump (wriggle free) does anything.
  if (s.pm === PM.carry) {
    const p = findBody(ctx, s.par);
    if (p) [s.x, s.y] = attachedPos(s, p, char);
    s.vx = s.vy = 0;
    if (p && !s.jbuf) return res;
    unparent(s);
    s.vy = -k.jump * 0.75;
    s.jbuf = 0;
    s.gcd = REGRAB;
    res.escape = res.jumped = true;
    return res;
  }

  // Hanging from a hook: follow it; jump or E lets go.
  if (s.pm === PM.hang) {
    const p = findBody(ctx, s.par);
    if (p) [s.x, s.y] = attachedPos(s, p, char);
    s.vx = s.vy = 0;
    s.gnd = 0;
    if (p && !s.jbuf && !(b & BTN.CTX_P)) return res;
    unparent(s);
    s.gcd = REGRAB;
    if (s.jbuf) {
      s.vy = -k.jump * 0.6;
      res.jumped = true;
    }
    s.vx = mx * k.speed;
    s.jbuf = 0;
    return res;
  }

  if (s.pm === PM.stand) {
    const p = findBody(ctx, s.par);
    if (p) [s.x, s.y] = attachedPos(s, p, char);
    else {
      unparent(s);
      s.gnd = 0;
    }
  }

  const [hx, hy] = handOf(char, s);

  // ---- actions ----
  if (char === 'archer' && b & BTN.PRI_P && !s.acd) {
    s.acd = 16;
    res.arrow = { x: hx, y: hy, vx: Math.cos(aim) * ARROW_V, vy: Math.sin(aim) * ARROW_V };
  }
  if (char === 'archer' && b & BTN.SEC_P && !s.rcd) {
    s.rcd = 10;
    const c = ropeCast(ctx.map, hx, hy, aim);
    res.rope = c;
    if (c.hit) {
      if (s.pm) unparent(s);
      s.rm = 1;
      s.rid = 0;
      s.rax = c.x;
      s.ray = c.y;
      s.rlen = Math.max(ROPE_MIN, Math.hypot(hx - c.x, hy - c.y));
    }
  }

  const ctxPress = !!(b & BTN.CTX_P);
  const ctxAir = !!(b & BTN.CTX) && !s.gnd;
  if (s.held && (ctxPress || b & BTN.PRI_P)) res.throw = true;
  else if (s.rm && ctxPress) {
    if (!s.rid && char === 'archer') res.leave = { ax: s.rax, ay: s.ray, len: s.rlen };
    s.rm = s.rid = 0;
    s.gcd = REGRAB;
  } else if (!s.rm && !s.gcd && (ctxPress || ctxAir)) {
    let caught = false;
    for (const o of ctx.bodies)
      if (o.k === BK.hook && Math.hypot(o.x + o.w / 2 - hx, o.y + o.h / 2 - hy) < HOOK_CATCH) {
        s.par = o.id;
        s.pm = PM.hang;
        s.ox = s.oy = 0;
        s.rm = 0;
        [s.x, s.y] = attachedPos(s, o, char);
        s.vx = s.vy = 0;
        caught = true;
        break;
      }
    if (!caught)
      for (const r of ctx.ropes)
        if (Math.abs(hx - r.ax) < ROPE_CATCH && hy >= r.ay && hy <= r.ay + r.len + 8) {
          caught = true;
          if (s.heavy) {
            res.snap = r.id;
            break;
          }
          if (s.pm) unparent(s);
          s.rm = 1;
          s.rid = r.id;
          s.rax = r.ax;
          s.ray = r.ay;
          s.rlen = Math.max(ROPE_MIN, Math.min(r.len, hy - r.ay));
          break;
        }
    if (!caught && ctxPress) {
      for (const o of ctx.bodies)
        if (o.k === BK.lever && hx > o.x - 8 && hx < o.x + o.w + 8 && s.y > o.y - 4 && s.y - k.h < o.y + o.h + 4) {
          res.lever = o.id;
          caught = true;
          break;
        }
      if (!caught && char === 'ogre') res.grab = true;
    }
    if (s.pm === PM.hang) return res;
  }

  // ---- rope bookkeeping ----
  let maxLen = ROPE_RANGE;
  if (s.rm && s.rid) {
    const r = ctx.ropes.find((o) => o.id === s.rid);
    if (!r) s.rm = s.rid = 0;
    else maxLen = r.len;
  }
  if (s.rm && s.heavy) {
    res.snap = s.rid;
    s.rm = s.rid = 0;
  }
  if (s.rm) {
    s.rlen = Math.max(ROPE_MIN, Math.min(maxLen, s.rlen + my * CLIMB * DT));
    if (s.jbuf && !s.gnd) {
      s.rm = s.rid = 0;
      s.vy = Math.min(s.vy, 0) - 140;
      s.jbuf = 0;
      s.gcd = REGRAB;
      res.jumped = true;
    }
  }

  // ---- standing on a moving body ----
  if (s.pm === PM.stand) {
    const p = findBody(ctx, s.par)!;
    const speed = k.speed * (s.heavy ? HEAVY_SPEED : 1);
    s.vx = approach(s.vx, mx * speed, (mx ? GROUND_ACC : GROUND_DEC) * DT);
    if (moveX(ctx, s, hw, k.h, s.vx * DT, p.id)) s.vx = 0;
    s.ox = s.x - (p.x + p.w / 2);
    const off = Math.abs(s.ox) > p.w / 2 + hw - 1;
    const dropOff = bodyTop(p.k) && my > 0.6;
    if (!off && !dropOff && !s.jbuf) {
      s.vy = 0;
      s.gnd = 1;
      return res;
    }
    unparent(s);
    s.gnd = 0;
    if (s.jbuf) {
      s.vy = -k.jump * (s.heavy ? HEAVY_JUMP : 1);
      s.jbuf = 0;
      res.jumped = true;
    } else s.coy = dropOff ? 0 : COYOTE;
    if (dropOff) s.y += 1;
  }

  // ---- free movement ----
  const speed = k.speed * (s.heavy ? HEAVY_SPEED : 1);
  if (!s.pound) {
    // Thrown or launched: weak steering, and your momentum is not bled off.
    const air = s.stun ? 0.35 : 1;
    if (s.rm && !s.gnd) s.vx += mx * SWING_ACC * DT;
    else if (s.gnd) s.vx = approach(s.vx, mx * speed, (mx ? GROUND_ACC : GROUND_DEC) * DT);
    else if (mx) {
      // Air control never brakes momentum you already have in the direction you're pushing.
      if (Math.sign(s.vx) !== Math.sign(mx) || Math.abs(s.vx) < speed) s.vx = approach(s.vx, mx * speed, AIR_ACC * air * DT);
    } else if (!s.stun) s.vx = approach(s.vx, 0, AIR_DEC * DT);
  }

  if (s.jbuf && (s.gnd || s.coy) && !s.pound) {
    s.vy = -k.jump * (s.heavy ? HEAVY_JUMP : 1);
    s.gnd = 0;
    s.coy = 0;
    s.jbuf = 0;
    res.jumped = true;
  }
  if (s.gnd && my > 0.6 && onOneWay(ctx, s, hw)) {
    s.drop = 8;
    s.gnd = 0;
  }
  if (char === 'ogre' && s.heavy && !s.gnd && !s.rm && b & BTN.MOB_P && !s.pound) {
    s.pound = 1;
    s.vx = 0;
    s.vy = POUND_V;
  }

  let g = GRAV * (s.heavy ? HEAVY_GRAV : 1);
  if (s.vy < 0 && !(b & BTN.JUMP) && !s.stun && !s.rm) g *= 2.2;
  s.vy = Math.min(s.vy + g * DT, s.pound ? POUND_V : s.heavy ? HEAVY_FALL : MAX_FALL);
  if (s.rm) {
    const sp = Math.hypot(s.vx, s.vy);
    if (sp > SWING_MAX) {
      s.vx *= SWING_MAX / sp;
      s.vy *= SWING_MAX / sp;
    }
  }

  const wasGnd = s.gnd;
  const fallV = s.vy;
  if (moveX(ctx, s, hw, k.h, s.vx * DT)) s.vx = 0;
  const hit = moveY(ctx, s, hw, k.h, s.vy * DT, s.drop > 0);
  if (hit && s.vy > 0) {
    if (!wasGnd) res.land = fallV > 520 ? 2 : 1;
    s.gnd = 1;
    s.stun = 0;
    if (s.pound) {
      res.pound = true;
      s.pound = 0;
    }
    if (hit > 0) {
      const p = findBody(ctx, hit)!;
      s.par = p.id;
      s.pm = PM.stand;
      s.ox = s.x - (p.x + p.w / 2);
      s.oy = 0;
    }
    s.vy = 0;
  } else {
    if (hit && s.vy < 0) s.vy = 0;
    if (!hit) {
      if (wasGnd && !res.jumped && s.vy >= 0) s.coy = COYOTE;
      s.gnd = 0;
    }
  }

  // ---- rope constraint: never further from the anchor than the rope is long ----
  if (s.rm) {
    const [px, py] = handOf(char, s);
    const dx = px - s.rax;
    const dy = py - s.ray;
    const d = Math.hypot(dx, dy);
    if (d > s.rlen) {
      const nx = dx / d;
      const ny = dy / d;
      const cx = s.rax + nx * s.rlen - px;
      const cy = s.ray + ny * s.rlen - py;
      moveX(ctx, s, hw, k.h, cx);
      if (moveY(ctx, s, hw, k.h, cy, true) && cy > 0) s.gnd = 1;
      const vr = s.vx * nx + s.vy * ny;
      if (vr > 0) {
        s.vx -= nx * vr;
        s.vy -= ny * vr;
      }
    }
  }
  return res;
}

/** The platform an ogre's head makes, in the same box form as level bodies. */
export function ogreBody(id: number, x: number, y: number): SimBody {
  const k = KIT.ogre;
  return { id, k: BK.ogre, x: x - k.w / 2, y: y - k.h, w: k.w, h: k.h, s: 0 };
}

/** Bodies between two snapshots. Server and client call this with identical inputs so they collide against identical platforms. */
export function lerpBodies(a: SimBody[], b: SimBody[] | null, f: number): SimBody[] {
  if (!b || f <= 0) return a;
  const next = new Map(b.map((o) => [o.id, o]));
  return a.map((o) => {
    const n = next.get(o.id);
    return n ? { ...o, x: o.x + (n.x - o.x) * f, y: o.y + (n.y - o.y) * f } : o;
  });
}
