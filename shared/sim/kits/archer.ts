import { BTN_A, BTN_A_PRESS, BTN_B_PRESS, BTN_MOVE, BTN_MOVE_PRESS, inputAim, inputDir } from '../input.ts';
import { moveBody, solid, type TileMap } from '../map.ts';
import { DT, MODE, MUZZLE, PLAYER_R, dec, newResult, recharge, shotAngles, type MovementController } from '../movement.ts';

/** Sprint top speed as a multiple of walk speed. */
export const SPRINT_MULT = 1.75;
/** Ticks of sprint (from walk speed) to reach top speed. */
const SPRINT_BUILD = 30;
/** Fraction of top speed a sprint must be released at to open the slide window. */
const SLIDE_READY = 0.9;
/** Ticks after releasing a full-speed sprint in which a tap turns into a slide. */
const COAST_TICKS = 8;
const COAST_BLEED = 0.9;
export const SLIDE_TICKS = 15;
const SLIDE_BLEED = 0.955;
/** Perpendicular velocity kept per tick while sprinting: the drift when you change heading. */
const DRIFT_KEEP = 0.84;
/** Speed lost per tick while reversing against your own momentum. */
const REVERSE_BRAKE = 11;
const DRAW_WALK = 0.8;
export const TRAP_RANGE = 44;

/**
 * Archer: snappy walk, momentum sprint (drift on turns), and a slide that turns leftover sprint
 * speed into an unsteerable glide you can shoot from. Bow draw lives in the same state so a
 * release is predicted on the exact tick the server fires it.
 */
export const archer: MovementController = {
  step(s, st, inp, map) {
    const res = newResult();
    const b = inp.buttons;
    s.aim = inputAim(inp);
    s.stagger = dec(s.stagger);
    if (s.down) {
      s.vx *= 0.8;
      s.vy *= 0.8;
      s.mode = MODE.walk;
      s.draw = 0;
      moveBody(map, s, PLAYER_R, DT);
      return res;
    }
    s.atkT = dec(s.atkT);
    recharge(s, st);
    const [mx, my] = inputDir(inp);
    const moving = mx !== 0 || my !== 0;
    const top = st.speed * SPRINT_MULT;
    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);

    if (s.stagger > 0 && s.mode !== MODE.walk) s.mode = MODE.walk;
    switch (s.mode) {
      case MODE.walk: {
        const fresh = b & BTN_MOVE_PRESS;
        if (b & BTN_MOVE && moving && s.stagger <= 0 && (fresh || !(b & BTN_A))) {
          s.mode = MODE.sprint;
          res.ability = true;
        }
        break;
      }
      case MODE.sprint:
        if (!(b & BTN_MOVE)) {
          if (speed >= top * SLIDE_READY) {
            s.mode = MODE.coast;
            s.act = COAST_TICKS;
          } else s.mode = MODE.walk;
        }
        break;
      case MODE.coast:
        if (b & BTN_MOVE_PRESS) {
          if (s.ab >= 1) {
            s.ab--;
            s.mode = MODE.slide;
            s.act = SLIDE_TICKS;
            res.slide = true;
          } else s.mode = MODE.sprint;
        } else if (--s.act <= 0) s.mode = MODE.walk;
        break;
      case MODE.slide:
        if (--s.act <= 0) s.mode = MODE.walk;
        break;
    }

    const sprinting = s.mode === MODE.sprint || s.mode === MODE.coast;
    if (sprinting) s.draw = 0;

    if (s.stagger > 0) {
      s.vx *= 0.85;
      s.vy *= 0.85;
    } else if (s.mode === MODE.walk) {
      const w = st.speed * (s.draw > 0 ? DRAW_WALK : 1);
      s.vx = mx * w;
      s.vy = my * w;
    } else if (s.mode === MODE.sprint) {
      if (moving) {
        const d = Math.sqrt(mx * mx + my * my);
        const dx = mx / d;
        const dy = my / d;
        let par = s.vx * dx + s.vy * dy;
        const px = s.vx - par * dx;
        const py = s.vy - par * dy;
        if (par < 0) par = Math.min(0, par + REVERSE_BRAKE);
        else if (par < st.speed) par = Math.min(st.speed, par + st.speed * 0.35);
        else par = Math.min(top, par + (top - st.speed) / SPRINT_BUILD);
        s.vx = dx * par + px * DRIFT_KEEP;
        s.vy = dy * par + py * DRIFT_KEEP;
      } else {
        s.vx *= COAST_BLEED;
        s.vy *= COAST_BLEED;
      }
    } else if (s.mode === MODE.coast) {
      s.vx *= COAST_BLEED;
      s.vy *= COAST_BLEED;
    } else if (s.mode === MODE.slide) {
      s.vx *= SLIDE_BLEED;
      s.vy *= SLIDE_BLEED;
    }
    const impact = moveBody(map, s, PLAYER_R, DT);
    if (s.stagger > 0) res.impact = impact;

    if (!sprinting && s.atkT <= 0) {
      const still = s.mode === MODE.slide || (s.mode === MODE.walk && !moving && s.stagger <= 0);
      const release = (p: number) => {
        res.fire = true;
        res.power = Math.min(1, p / st.drawTicks);
        res.still = still;
        s.atkT = st.atkCd;
        s.draw = 0;
      };
      if (b & BTN_A) s.draw = Math.min(st.drawTicks, s.draw + 1);
      else if (s.draw > 0) release(s.draw);
      else if (b & BTN_A_PRESS) release(1);
    }

    if (b & BTN_B_PRESS && !sprinting && s.spec >= 1) {
      s.spec--;
      res.trap = true;
    }
    return res;
  },
};

/** Arrow flight parameters for a release at draw fraction `p`. Shared so predicted arrows fly like the server's. */
export function arrowShot(p: number, still: boolean) {
  const full = p >= 1;
  return {
    speed: Math.min(520, (200 + 220 * p) * (still ? 1.3 : 1)),
    dmg: (5 + 30 * p) * (full ? 1.25 : 1),
    knock: 50 + 170 * p,
    r: full ? 3 : 2,
    pierce: full ? 1 : 0,
    life: 40,
  };
}

export interface ArrowMods {
  multishot: number;
  bounce: number;
  pierce: number;
  bulletR: number;
}

export interface ArrowSpawn {
  idx: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  pierce: number;
  bounce: number;
  life: number;
}

export function arrowVolley(x: number, y: number, aim: number, power: number, still: boolean, m: ArrowMods, seq: number): ArrowSpawn[] {
  const a = arrowShot(power, still);
  const ox = x + Math.cos(aim) * MUZZLE;
  const oy = y + Math.sin(aim) * MUZZLE;
  return shotAngles(aim, m.multishot, seq).map((ang, idx) => ({
    idx,
    x: ox,
    y: oy,
    vx: Math.cos(ang) * a.speed,
    vy: Math.sin(ang) * a.speed,
    r: a.r + Math.max(0, m.bulletR - 2),
    pierce: a.pierce + m.pierce,
    bounce: m.bounce,
    life: a.life,
  }));
}

/** Where a pin trap lands: TRAP_RANGE along the aim, stopping short of walls. */
export function trapSpot(map: TileMap, x: number, y: number, aim: number): [number, number] {
  const cx = Math.cos(aim);
  const cy = Math.sin(aim);
  let d = 0;
  while (d + 4 <= TRAP_RANGE && !solid(map, x + cx * (d + 4), y + cy * (d + 4))) d += 4;
  return [x + cx * Math.max(0, d - 2), y + cy * Math.max(0, d - 2)];
}