/*
 * Headless checks of the level mechanics: drives a Room directly with scripted inputs.
 * Run: npm test
 */
import type { WebSocket } from 'ws';
import { TILE } from '../shared/protocol.ts';
import { BTN, quantizeInput } from '../shared/sim/input.ts';
import { encodeInputs } from '../shared/net/snapshot.ts';
import { BK, KIT, PM } from '../shared/sim/player.ts';
import { Room } from '../server/room.ts';

const fakeWs = () => ({ readyState: 1, send() {}, close() {} }) as unknown as WebSocket;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

interface Pad {
  mx?: number;
  my?: number;
  aim?: number;
  b?: number;
}

function setup() {
  const room = new Room('TEST');
  const ogre = room.addPlayer(fakeWs(), 'Ogre', 'ogre')!;
  const archer = room.addPlayer(fakeWs(), 'Archer', 'archer')!;
  const seq = new Map<number, number>([
    [ogre.id, 1],
    [archer.id, 1],
  ]);
  const pads = new Map<number, Pad>();
  /** Advance n ticks with each player's current pad; presses (the *_P bits) fire on the first tick only. */
  const run = (n: number, set: Record<number, Pad> = {}) => {
    for (const [id, p] of Object.entries(set)) pads.set(Number(id), p);
    for (let i = 0; i < n; i++) {
      for (const p of [ogre, archer]) {
        const pad = pads.get(p.id) ?? {};
        let b = pad.b ?? 0;
        if (i > 0) b &= ~(BTN.JUMP_P | BTN.PRI_P | BTN.SEC_P | BTN.MOB_P | BTN.CTX_P);
        const s = seq.get(p.id)!;
        seq.set(p.id, s + 1);
        room.handleBinary(p as never, encodeInputs(0, [quantizeInput(s, pad.mx ?? 0, pad.my ?? 0, pad.aim ?? 0, b, room.tick)]));
      }
      room.step();
      room.sendSnapshots();
    }
    for (const id of pads.keys()) {
      const pad = pads.get(id)!;
      if (pad.b) pads.set(id, { ...pad, b: pad.b & ~(BTN.JUMP_P | BTN.PRI_P | BTN.SEC_P | BTN.MOB_P | BTN.CTX_P) });
    }
  };
  const put = (p: typeof ogre, tx: number, ty: number) => {
    Object.assign(p, { x: (tx + 0.5) * TILE, y: (ty + 1) * TILE, vx: 0, vy: 0, par: 0, pm: 0, rm: 0 });
  };
  return { room, ogre, archer, run, put };
}

const UP = -Math.PI / 2;
/** Aim from a player's hand at a tile centre. */
const aimAt = (p: { x: number; y: number; char: 'ogre' | 'archer' }, tx: number, ty: number) =>
  Math.atan2((ty + 0.5) * TILE - (p.y - KIT[p.char].h + 3), (tx + 0.5) * TILE - p.x);

// 1. Spawn and stand.
{
  const { ogre, archer, run } = setup();
  run(30);
  check('players land on the ground', ogre.gnd === 1 && archer.gnd === 1 && ogre.y === 320 && archer.y === 320, `ogre y ${ogre.y}, archer y ${archer.y}`);
  run(40, { [archer.id]: { mx: 1 } });
  check('archer walks right', archer.x > 100, `x ${archer.x.toFixed(1)}`);
}

// 2. Rope arrow: only wood holds, and the rope keeps you within its length.
{
  const { archer, run, put } = setup();
  put(archer, 21, 19);
  run(5);
  run(1, { [archer.id]: { aim: aimAt(archer, 25, 9), b: BTN.SEC_P } });
  check('rope arrow sticks to a wood beam', archer.rm === 1, `anchor ${archer.rax.toFixed(0)},${archer.ray.toFixed(0)}`);
  run(1, { [archer.id]: { mx: 1 } });
  let maxOver = 0;
  let maxX = 0;
  for (let i = 0; i < 90; i++) {
    run(1);
    maxOver = Math.max(maxOver, Math.hypot(archer.x - archer.rax, archer.y - KIT.archer.h + 3 - archer.ray) - archer.rlen);
    maxX = Math.max(maxX, archer.x);
  }
  check('rope length holds while swinging', maxOver < 1, `max stretch ${maxOver.toFixed(2)} px`);
  check('swinging carries the archer out over the pit', maxX > 23 * TILE, `max x ${maxX.toFixed(0)}`);

  put(archer, 12, 19);
  run(5, { [archer.id]: {} });
  run(1, { [archer.id]: { aim: UP, b: BTN.SEC_P } });
  check('rope arrow does not stick to rock', archer.rm === 0);
}

// 3. Leave a rope, the ogre catches it; heavy snaps it.
{
  const { room, ogre, archer, run, put } = setup();
  put(archer, 21, 19);
  run(5);
  run(1, { [archer.id]: { aim: aimAt(archer, 25, 9), b: BTN.SEC_P } });
  run(20, { [archer.id]: {} });
  run(1, { [archer.id]: { b: BTN.CTX_P } });
  check('archer leaves the rope in the world', room.ropes.length === 1 && archer.rm === 0);
  const rope = room.ropes[0];
  // Drop the ogre next to the rope, holding E.
  Object.assign(ogre, { x: rope.ax - 4, y: rope.ay + 120, vx: 0, vy: 0, gnd: 0 });
  run(3, { [ogre.id]: { b: BTN.CTX } });
  check('ogre catches the rope midair', ogre.rm === 1 && ogre.rid === rope.id);
  run(1, { [ogre.id]: { b: BTN.SEC_P } });
  check('going heavy on a rope snaps it', ogre.rm === 0 && room.ropes.length === 0);
}

// 4. Pulley: heavy ogre on the hook lifts the archer to the upper floor; light ogre does not.
{
  const { room, ogre, archer, run, put } = setup();
  const pulley = room.pulleys[0];
  put(archer, 49, 19);
  archer.x = pulley.lift.x + pulley.lift.w / 2;
  run(10);
  check('archer stands on the lift', archer.pm === PM.stand && archer.par === pulley.lift.id);
  Object.assign(ogre, { x: pulley.hook.x + 5, y: pulley.hook.y + 30, vx: 0, vy: 0, gnd: 0 });
  run(2, { [ogre.id]: { b: BTN.CTX } });
  check('ogre hangs on the hook', ogre.pm === PM.hang, `pm ${ogre.pm}`);
  run(60, { [ogre.id]: {} });
  check('light ogre cannot lift the archer', pulley.t === 0, `t ${pulley.t.toFixed(2)}`);
  run(1, { [ogre.id]: { b: BTN.SEC_P } });
  run(120, { [ogre.id]: {} });
  check('heavy ogre raises the lift', pulley.t === 1 && Math.abs(archer.y - 192) < 0.01, `t ${pulley.t.toFixed(2)}, archer y ${archer.y}`);
  run(40, { [archer.id]: { mx: 1 } });
  check('archer steps off onto the upper floor', archer.pm === PM.none && archer.gnd === 1 && archer.y === 192 && archer.x > 52 * TILE, `x ${archer.x.toFixed(0)} y ${archer.y}`);
  run(1, { [archer.id]: {}, [ogre.id]: { b: BTN.SEC_P } });
  run(120, { [ogre.id]: {} });
  check('light again, the counterweight hauls the ogre back up', pulley.t === 0 && ogre.pm === PM.hang, `t ${pulley.t.toFixed(2)}`);

  // Lever opens gate 1.
  put(archer, 54, 11);
  run(10);
  run(1, { [archer.id]: { b: BTN.CTX_P } });
  run(60, { [archer.id]: {} });
  const lever = room.bodies.find((b) => b.k === BK.lever && b.ch === 1)!;
  const gate = room.bodies.find((b) => b.k === BK.gate && b.ch === 1)!;
  check('lever opens gate 1', lever.s === 1 && gate.y < gate.y0 - 40, `gate y ${gate.y} (closed ${gate.y0})`);
}

// 5. Heavy plate holds gate 2 open only while the heavy ogre stands on it.
{
  const { room, ogre, run, put } = setup();
  const plate = room.bodies.find((b) => b.k === BK.plate)!;
  const gate = room.bodies.find((b) => b.k === BK.gate && b.ch === 2)!;
  put(ogre, 62, 19);
  run(20);
  check('light ogre does not press the heavy plate', plate.s === 0);
  run(1, { [ogre.id]: { b: BTN.SEC_P } });
  run(60, { [ogre.id]: {} });
  check('heavy ogre presses it and gate 2 opens', plate.s === 1 && gate.y < gate.y0 - 40);
}

// 6. Arrow hits the target and opens gate 3.
{
  const { room, archer, run, put } = setup();
  put(archer, 88, 11);
  archer.y = 12 * TILE;
  const target = room.bodies.find((b) => b.k === BK.target)!;
  const tx = target.x + target.w / 2;
  const ty = target.y + target.h / 2;
  // Aim a bit above the line to account for the drop.
  let hit = false;
  for (let lift = 0; lift < 0.4 && !hit; lift += 0.02) {
    put(archer, 86, 11);
    run(20, { [archer.id]: {} });
    const a = Math.atan2(ty - (archer.y - 11), tx - archer.x) - lift;
    run(1, { [archer.id]: { aim: a, b: BTN.PRI_P } });
    run(80, { [archer.id]: { aim: a } });
    hit = target.s === 1;
  }
  const gate = room.bodies.find((b) => b.k === BK.gate && b.ch === 3)!;
  run(60);
  check('arrow hits the target and gate 3 opens', hit && gate.y < gate.y0 - 40);
}

// 7. Throw: ogre grabs the archer and throws her up onto the ledge.
{
  const { ogre, archer, run, put } = setup();
  put(ogre, 92, 19);
  put(archer, 92, 19);
  run(10);
  run(1, { [ogre.id]: { b: BTN.CTX_P } });
  check('ogre grabs the archer', ogre.held === archer.id && archer.pm === PM.carry);
  run(5, { [ogre.id]: {} });
  check('carried archer rides above the ogre', Math.abs(archer.y - (ogre.y - KIT.ogre.h - 2)) < 0.01 && archer.x === ogre.x);
  let top = archer.y;
  run(1, { [ogre.id]: { aim: UP + 0.2, b: BTN.PRI_P } });
  for (let i = 0; i < 100; i++) {
    // Steer toward the middle of the ledge (cols 94-97).
    run(1, { [ogre.id]: {}, [archer.id]: { mx: Math.sign(96 * TILE - archer.x) } });
    top = Math.min(top, archer.y);
  }
  check('throw goes high enough for the ledge (y 224)', top < 224, `peak feet y ${top.toFixed(0)}`);
  check('archer lands on the ledge', archer.gnd === 1 && archer.y === 224, `y ${archer.y}, x ${(archer.x / TILE).toFixed(1)}`);
}

// 8. Pound: heavy ogre lands next to the archer and launches her.
{
  const { ogre, archer, run, put } = setup();
  put(archer, 92, 19);
  put(ogre, 90, 19);
  run(10);
  run(1, { [ogre.id]: { b: BTN.SEC_P } });
  run(2, { [ogre.id]: {} });
  run(1, { [ogre.id]: { b: BTN.JUMP_P | BTN.JUMP } });
  run(6, { [ogre.id]: { b: BTN.JUMP } });
  run(1, { [ogre.id]: { b: BTN.MOB_P } });
  let top = archer.y;
  for (let i = 0; i < 60; i++) {
    run(1, { [ogre.id]: {} });
    top = Math.min(top, archer.y);
  }
  check('ground pound launches the archer', top < 224, `peak feet y ${top.toFixed(0)}`);
}

// 9. Standing on the ogre's head and riding along.
{
  const { ogre, archer, run, put } = setup();
  put(ogre, 30, 19);
  put(ogre, 8, 19);
  put(archer, 8, 19);
  archer.y = ogre.y - KIT.ogre.h - 10;
  run(20);
  check('archer lands on the ogre', archer.pm === PM.stand && archer.par === ogre.id);
  const off = archer.x - ogre.x;
  run(30, { [ogre.id]: { mx: -1 } });
  check('archer rides the walking ogre', archer.pm === PM.stand && Math.abs(archer.x - ogre.x - off) < 0.01, `offset ${(archer.x - ogre.x).toFixed(2)}`);
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall mechanics checks passed');
