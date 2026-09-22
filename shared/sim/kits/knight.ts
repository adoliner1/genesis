import { BTN_A, BTN_A_PRESS, BTN_B, BTN_MOVE, BTN_MOVE_PRESS, inputAim, inputDir } from '../input.ts';
import { moveBody } from '../map.ts';
import { DT, MODE, PLAYER_R, dec, newResult, recharge, type MovementController, type MoveState } from '../movement.ts';

export const BASH_SPEED = 265;
export const BASH_TICKS = 7;
/** Shield Skid: hold the movement key through the end of a bash to keep grinding forward. */
export const SKID_TICKS = 14;
const SKID_KEEP = 0.6;
const SKID_BLEED = 0.93;
const SKID_STEER = 0.07;
export const SWING_TICKS = 3;
const SLASH_LUNGE = 45;
const BLOCK_WALK = 0.45;
const SWING_WALK = 0.6;
const WALK_ACCEL = 0.24;
/** Guard needed to raise the shield (it stays up while guard > 0). */
const GUARD_RAISE = 10;
const GUARD_REGEN = 1;
/** Half-width of the shield's blocking cone, radians. */
export const SHIELD_ARC = 1.15;

/**
 * Knight: slightly heavy walk, hold-to-block shield that slows you, a slash with a short
 * active window (deflects projectiles), and Shield Bash — a hop that can roll into a skid.
 */
export const knight: MovementController = {
  step(s, st, inp, map) {
    const res = newResult();
    const b = inp.buttons;
    s.aim = inputAim(inp);
    s.stagger = dec(s.stagger);
    s.swing = Math.max(0, s.swing - 1);
    if (s.down) {
      s.vx *= 0.8;
      s.vy *= 0.8;
      s.mode = MODE.walk;
      s.block = 0;
      moveBody(map, s, PLAYER_R, DT);
      return res;
    }
    s.atkT = dec(s.atkT);
    recharge(s, st);
    s.guardT = dec(s.guardT);
    const [mx, my] = inputDir(inp);
    const ax = Math.cos(s.aim);
    const ay = Math.sin(s.aim);

    if (b & BTN_MOVE_PRESS && s.ab >= 1 && s.stagger <= 0 && s.mode !== MODE.bash) {
      s.ab--;
      s.mode = MODE.bash;
      s.act = BASH_TICKS;
      s.vx = ax * BASH_SPEED;
      s.vy = ay * BASH_SPEED;
      res.ability = true;
    } else if (s.mode === MODE.bash) {
      if (--s.act <= 0) {
        if (b & BTN_MOVE) {
          s.mode = MODE.skid;
          s.act = SKID_TICKS;
          s.vx *= SKID_KEEP;
          s.vy *= SKID_KEEP;
          res.slide = true;
        } else {
          s.mode = MODE.walk;
          s.vx *= 0.35;
          s.vy *= 0.35;
        }
      }
    } else if (s.mode === MODE.skid) {
      if (--s.act <= 0 || !(b & BTN_MOVE)) s.mode = MODE.walk;
    }
    if (s.stagger > 0 && s.mode === MODE.skid) s.mode = MODE.walk;

    const wantBlock = s.mode === MODE.walk && b & BTN_B && s.guard > (s.block ? 0 : GUARD_RAISE);
    s.block = wantBlock ? 1 : 0;
    if (!s.block && s.guardT <= 0) s.guard = Math.min(st.guardMax, s.guard + GUARD_REGEN);

    if (s.mode === MODE.bash) {
      // constant hop velocity
    } else if (s.mode === MODE.skid) {
      s.vx *= SKID_BLEED;
      s.vy *= SKID_BLEED;
      if (mx || my) {
        const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
        s.vx += (mx * sp - s.vx) * SKID_STEER;
        s.vy += (my * sp - s.vy) * SKID_STEER;
      }
    } else if (s.stagger > 0) {
      s.vx *= 0.85;
      s.vy *= 0.85;
    } else {
      const w = st.speed * (s.block ? BLOCK_WALK : 1) * (s.swing > 0 ? SWING_WALK : 1);
      s.vx += (mx * w - s.vx) * WALK_ACCEL;
      s.vy += (my * w - s.vy) * WALK_ACCEL;
    }
    const impact = moveBody(map, s, PLAYER_R, DT);
    if (s.stagger > 0) res.impact = impact;

    if (b & (BTN_A | BTN_A_PRESS) && s.atkT <= 0 && !s.block && s.mode !== MODE.bash) {
      s.atkT = st.atkCd;
      s.swing = SWING_TICKS;
      res.slash = true;
      if (s.mode === MODE.walk) {
        s.vx += ax * SLASH_LUNGE;
        s.vy += ay * SLASH_LUNGE;
      }
    }
    return res;
  },
};

/** Whether the knight's shield (raised, or leading a bash) faces something arriving from angle `from`. */
export function shieldCovers(s: MoveState, from: number): boolean {
  if (!s.block && s.mode !== MODE.bash) return false;
  const d = Math.atan2(Math.sin(from - s.aim), Math.cos(from - s.aim));
  return Math.abs(d) < SHIELD_ARC;
}
