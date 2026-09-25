import Phaser from 'phaser';
import { PLAYER_COLORS, TILE, type GameEvent, type LevelMsg } from '../shared/protocol';
import { T, isSolid, tileAt, type TileMap } from '../shared/sim/level';
import { BK, GRAV, KIT, PM, attachedPos, handOf, ogreBody, overlapsSolid, ropeCast, type MoveState, type SimBody, type StepResult } from '../shared/sim/player';
import type { NetClient, PlayerView, WorldView } from './net/client';
import type { Input } from './input';
import type { Hud } from './hud';
import type { DebugOverlay } from './debug';

export interface Boot {
  client: NetClient;
  hud: Hud;
  debug: DebugOverlay;
  input: Input;
}

const hex = (s: string) => parseInt(s.slice(1), 16);
const COL = {
  hillFar: 0x2b3a5c,
  hillNear: 0x24304d,
  rock: 0x3b3450,
  rockDark: 0x2c2640,
  rockLight: 0x544a70,
  grass: 0x7cc46a,
  grassDark: 0x5a9c4c,
  wood: 0x9a6334,
  woodDark: 0x6b4122,
  woodLight: 0xc08450,
  plank: 0xc98f55,
  spike: 0xe6e3f0,
  rope: 0xe0c48a,
  iron: 0x8a8fa3,
  ironDark: 0x4f5366,
  gold: 0xffd23f,
  skin: 0xf2d0a4,
  ogre: 0x86b35e,
  ogreDark: 0x5f8a40,
  ogreHeavy: 0x6d7385,
  ogreHeavyDark: 0x4a4f60,
  white: 0xffffff,
  ink: 0x14101c,
};

interface Fx {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: number;
  g: number;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  life: number;
  max: number;
  color: number;
}

/** Per-player cosmetic state: walk cycle and squash. */
interface Anim {
  lastX: number;
  lastY: number;
  vy: number;
  walk: number;
  squash: number;
  seen: number;
}

/** Cosmetic Verlet chain for a rope hanging free. */
interface RopeSim {
  pts: { x: number; y: number; px: number; py: number }[];
  seg: number;
}

export class GameScene extends Phaser.Scene {
  boot!: Boot;
  hills!: Phaser.GameObjects.Graphics;
  tilesG!: Phaser.GameObjects.Graphics;
  back!: Phaser.GameObjects.Graphics;
  dyn!: Phaser.GameObjects.Graphics;
  top!: Phaser.GameObjects.Graphics;
  map: TileMap | null = null;
  signs: Phaser.GameObjects.Text[] = [];
  names = new Map<number, Phaser.GameObjects.Text>();
  fx: Fx[] = [];
  rings: Ring[] = [];
  poses = new Map<number, Anim>();
  ropeSims = new Map<number, RopeSim>();
  ropeHeld = new Map<number, [number, number]>();
  shake = 0;
  zoom = 3;
  camX = NaN;
  camY = NaN;
  restartSent = false;
  /** ?dev=1: number keys warp to checkpoints. */
  dev = new URLSearchParams(location.search).has('dev');
  view: WorldView | null = null;
  me: PlayerView | null = null;

  constructor() {
    super('game');
  }

  init(data: Boot) {
    this.boot = data;
  }

  create() {
    const { client } = this.boot;
    const q = new URLSearchParams(location.search);
    this.zoom = Number(q.get('zoom')) || Math.max(2, Math.min(4, Math.round(innerHeight / 250)));
    this.hills = this.add.graphics();
    this.tilesG = this.add.graphics();
    this.back = this.add.graphics();
    this.dyn = this.add.graphics();
    this.top = this.add.graphics();
    const cam = this.cameras.main;
    cam.setZoom(this.zoom);
    cam.setRoundPixels(false);

    client.hooks = {
      input: () => this.readInput(),
      predicted: (res, s) => this.onPredicted(res, s),
      event: (e) => this.onEvent(e),
      level: (l) => this.loadLevel(l),
    };
    if (client.level) this.loadLevel(client.level);
  }

  /** Background hills; moved each frame for parallax (see updateCamera). */
  private drawHills(mapW: number) {
    const g = this.hills;
    g.clear();
    const base = 150;
    const span = mapW + 600;
    g.fillStyle(COL.hillFar, 1);
    for (let x = -200; x < span; x += 60) {
      const hgt = 30 + ((x * 37) % 45);
      g.fillTriangle(x - 70, base, x, base - hgt, x + 70, base);
    }
    g.fillRect(-200, base, span + 200, 1200);
    g.fillStyle(COL.hillNear, 1);
    for (let x = -200; x < span; x += 45) {
      const hgt = 14 + ((x * 53) % 24);
      g.fillEllipse(x, base + 30, 90, hgt * 2);
    }
    g.fillRect(-200, base + 30, span + 200, 1200);
  }

  // ---------- level ----------

  private loadLevel(l: LevelMsg) {
    this.map = this.boot.client.map;
    const map = this.map!;
    this.drawTiles(map);
    this.drawHills(map.w * TILE);
    for (const s of this.signs) s.destroy();
    this.signs = l.signs.map((s) =>
      this.add
        .text(s.x, s.y, s.text, { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '6px', color: '#f4ecdf', align: 'left', lineSpacing: 1, resolution: this.zoom * devicePixelRatio * 2 })
        .setAlpha(0.8)
        .setDepth(1),
    );
    this.cameras.main.setBounds(0, 0, map.w * TILE, map.h * TILE);
    this.ropeSims.clear();
    this.fx = [];
    this.rings = [];
    this.camX = NaN;
    this.boot.hud.level(l.name);
  }

  private drawTiles(m: TileMap) {
    const g = this.tilesG;
    g.clear();
    const solidAt = (x: number, y: number) => isSolid(tileAt(m, x, y));
    for (let ty = 0; ty < m.h; ty++)
      for (let tx = 0; tx < m.w; tx++) {
        const t = m.tiles[ty * m.w + tx];
        const x = tx * TILE;
        const y = ty * TILE;
        if (t === T.Solid) {
          g.fillStyle(COL.rock, 1);
          g.fillRect(x, y, TILE, TILE);
          // Speckles for texture.
          g.fillStyle(COL.rockDark, 1);
          const h = (tx * 7 + ty * 13) % 5;
          g.fillRect(x + 3 + h, y + 5 + ((h * 3) % 6), 2, 2);
          g.fillRect(x + 10 - h, y + 11 - (h % 3), 2, 1);
          if (!solidAt(tx, ty - 1)) {
            g.fillStyle(COL.grassDark, 1);
            g.fillRect(x, y, TILE, 4);
            g.fillStyle(COL.grass, 1);
            g.fillRect(x, y, TILE, 2);
            if ((tx + ty) % 3 === 0) g.fillRect(x + 4, y - 2, 1, 2);
            if ((tx * 5) % 4 === 1) g.fillRect(x + 11, y - 1, 1, 1);
          }
          if (!solidAt(tx, ty + 1)) {
            g.fillStyle(COL.rockDark, 1);
            g.fillRect(x, y + TILE - 2, TILE, 2);
          }
          if (!solidAt(tx - 1, ty)) {
            g.fillStyle(COL.rockLight, 1);
            g.fillRect(x, y, 1, TILE);
          }
          if (!solidAt(tx + 1, ty)) {
            g.fillStyle(COL.rockDark, 1);
            g.fillRect(x + TILE - 1, y, 1, TILE);
          }
        } else if (t === T.Wood) {
          g.fillStyle(COL.wood, 1);
          g.fillRect(x, y, TILE, TILE);
          g.fillStyle(COL.woodDark, 1);
          g.fillRect(x, y + 4, TILE, 1);
          g.fillRect(x, y + 10, TILE, 1);
          g.fillRect(x + ((tx * 5) % 12), y + 1, 1, 3);
          g.fillStyle(COL.woodLight, 1);
          g.fillRect(x, y + TILE - 2, TILE, 2);
          g.fillStyle(COL.iron, 1);
          g.fillRect(x + 2, y + 7, 1, 1);
          g.fillRect(x + 13, y + 7, 1, 1);
        } else if (t === T.OneWay) {
          g.fillStyle(COL.woodDark, 1);
          g.fillRect(x, y, TILE, 5);
          g.fillStyle(COL.plank, 1);
          g.fillRect(x, y, TILE, 3);
          g.fillStyle(COL.woodDark, 1);
          g.fillRect(x + 2, y + 5, 1, 4);
          g.fillRect(x + 13, y + 5, 1, 4);
        } else if (t === T.Spikes) {
          g.fillStyle(COL.rockDark, 1);
          g.fillRect(x, y + TILE - 3, TILE, 3);
          g.fillStyle(COL.spike, 1);
          for (let i = 0; i < 4; i++) g.fillTriangle(x + i * 4, y + TILE - 3, x + i * 4 + 2, y + 6, x + i * 4 + 4, y + TILE - 3);
        }
      }
  }

  // ---------- input ----------

  private pointerWorld(): [number, number] {
    const p = this.cameras.main.getWorldPoint(this.boot.input.sx, this.boot.input.sy);
    return [p.x, p.y];
  }

  private readInput() {
    const { input, client } = this.boot;
    const s = input.sample();
    const st = client.pred.state;
    let aim = 0;
    if (st) {
      const [hx, hy] = this.me ? [this.me.x, this.me.y - KIT[this.me.char].h + 3] : handOf(client.pred.char, st);
      const [wx, wy] = this.pointerWorld();
      aim = Math.atan2(wy - hy, wx - hx);
    }
    return { ...s, aim };
  }

  // ---------- events ----------

  private burst(x: number, y: number, n: number, color: number, speed = 60, up = 0, g = 200, size = 1.5, life = 0.5) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.fx.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, life: life * (0.6 + Math.random() * 0.4), max: life, size, color, g });
    }
  }

  private dust(x: number, y: number, n = 6) {
    for (let i = 0; i < n; i++) {
      const d = i % 2 ? 1 : -1;
      this.fx.push({ x: x + d * Math.random() * 4, y, vx: d * (20 + Math.random() * 40), vy: -Math.random() * 25, life: 0.35 + Math.random() * 0.2, max: 0.55, size: 2, color: 0xd8cfc0, g: 30 });
    }
  }

  private squash(id: number, v: number) {
    const a = this.poses.get(id);
    if (a) a.squash = v;
  }

  private onPredicted(res: StepResult, s: MoveState) {
    const id = this.boot.client.myId;
    const char = this.boot.client.pred.char;
    if (res.jumped) {
      this.dust(s.x, s.y, 4);
      this.squash(id, -0.25);
    }
    if (res.land) {
      this.dust(s.x, s.y, res.land === 2 ? 10 : 5);
      this.squash(id, res.land === 2 ? 0.35 : 0.2);
    }
    if (res.heavy) {
      this.burst(s.x, s.y - KIT[char].h / 2, 10, s.heavy ? COL.ironDark : COL.ogre, 50);
      this.squash(id, s.heavy ? 0.3 : -0.2);
    }
    if (res.rope) this.ropeFx(res.rope.x, res.rope.y, res.rope.hit);
  }

  private ropeFx(x: number, y: number, hit: boolean) {
    this.burst(x, y, hit ? 6 : 4, hit ? COL.woodLight : COL.rockLight, 40, 0, 150, 1, 0.35);
  }

  private onEvent(e: GameEvent) {
    const hud = this.boot.hud;
    switch (e.e) {
      case 'msg':
        hud.message(e.text, e.big);
        break;
      case 'win':
        hud.message('Everyone made it!', true);
        for (let i = 0; i < 40; i++) this.burst((this.me?.x ?? 0) + (Math.random() - 0.5) * 100, (this.me?.y ?? 0) - 40, 1, hex(PLAYER_COLORS[i % 4]), 120, 60, 150, 2, 1.2);
        break;
      case 'jump':
        this.dust(e.x, e.y, 3);
        this.squash(e.p, -0.25);
        break;
      case 'land':
        this.dust(e.x, e.y, e.hard ? 10 : 5);
        this.squash(e.p, e.hard ? 0.35 : 0.2);
        break;
      case 'heavy':
        this.squash(e.p, e.on ? 0.3 : -0.2);
        break;
      case 'pound':
        this.rings.push({ x: e.x, y: e.y, r: 4, life: 0.4, max: 0.4, color: COL.white });
        this.dust(e.x, e.y, 16);
        this.burst(e.x, e.y - 2, 10, COL.rockLight, 90, 60, 400, 2, 0.6);
        this.squash(e.p, 0.45);
        this.shake = Math.max(this.shake, 5);
        break;
      case 'launch':
        this.burst(e.x, e.y, 8, COL.gold, 50, 40, 100, 1.5, 0.5);
        break;
      case 'rope':
        this.ropeFx(e.x, e.y, e.hit);
        break;
      case 'snap':
        this.burst(e.x, e.y + 10, 12, COL.rope, 70, 20, 300, 1.5, 0.8);
        this.boot.hud.message('Snap! Too heavy for a rope.');
        break;
      case 'grab':
        this.squash(e.who, -0.3);
        break;
      case 'throw':
        this.squash(e.p, 0.3);
        break;
      case 'die':
        this.burst(e.x, e.y - 6, 18, 0xff6b8b, 80, 40, 200, 2, 0.7);
        if (e.p === this.boot.client.myId) this.shake = Math.max(this.shake, 4);
        break;
      case 'switch':
        this.burst(e.x, e.y, e.on ? 12 : 4, e.on ? COL.gold : COL.iron, 50, 20, 60, 1.5, 0.6);
        break;
      case 'thunk':
        this.burst(e.x, e.y, 3, COL.rockLight, 30, 0, 100, 1, 0.3);
        break;
    }
  }

  // ---------- frame ----------

  update(_time: number, delta: number) {
    const { client, debug, hud, input } = this.boot;
    const now = performance.now();
    client.update(now);
    debug.update(now);
    const dt = Math.min(0.05, delta / 1000);

    if (input.has('KeyR')) {
      input.restartHeld += dt;
      if (input.restartHeld > 0.7 && !this.restartSent) {
        this.restartSent = true;
        client.net.sendJson({ t: 'restart' });
      }
    } else {
      input.restartHeld = 0;
      this.restartSent = false;
    }
    hud.restart(Math.min(1, input.restartHeld / 0.7));
    if (this.dev) for (let i = 1; i <= 9; i++) if (input.pressedOnce(`Digit${i}`)) client.net.sendJson({ t: 'warp', cp: i - 1 });

    const view = client.sample();
    this.view = view;
    if (!view || !this.map) return;
    const positions = this.resolvePositions(view);
    this.me = positions.get(client.myId) ?? null;

    this.updateCamera(dt);
    this.stepFx(dt);

    this.back.clear();
    this.dyn.clear();
    this.top.clear();
    this.drawBodies(view.bodies);
    this.drawRopes(view, positions, dt);
    for (const a of view.arrows) this.drawArrow(a.x, a.y, a.a);
    for (const p of positions.values()) this.drawPlayer(p, dt);
    this.drawAimGuide();
    this.drawFx();
    this.updateNames(positions);
    hud.players(client.meta, client.myId);
  }

  /** Final on-screen position of every player: you from prediction, others interpolated, riders glued to what they ride. */
  private resolvePositions(view: WorldView): Map<number, PlayerView> {
    const { client } = this.boot;
    const out = new Map<number, PlayerView>();
    const raw = new Map(view.players.map((p) => [p.id, p]));
    const s = client.pred.state;
    const mine = raw.get(client.myId);
    if (s && mine) {
      raw.set(client.myId, {
        ...mine,
        char: client.pred.char,
        x: s.x,
        y: s.y,
        vx: s.vx,
        aim: this.readAimForDraw(),
        heavy: !!s.heavy,
        gnd: !!s.gnd,
        pound: !!s.pound,
        rope: !!s.rm,
        rax: s.rax,
        ray: s.ray,
        left: s.face < 0,
        stun: !!s.stun,
        par: s.par,
        pm: s.pm,
        ox: s.ox,
        oy: s.oy,
        held: s.held,
      });
    }
    const bodies = new Map(view.bodies.map((b) => [b.id, b]));
    const resolve = (id: number, depth: number): PlayerView | null => {
      const done = out.get(id);
      if (done) return done;
      const p = raw.get(id);
      if (!p) return null;
      const r = { ...p };
      if (id === client.myId && s && s.pm === PM.none) {
        const rp = client.pred.renderPos(client.alpha);
        if (rp) [r.x, r.y] = rp;
      }
      if (r.pm !== PM.none && depth < 5) {
        let parent: SimBody | undefined = bodies.get(r.par);
        if (!parent) {
          const pp = resolve(r.par, depth + 1);
          if (pp && pp.char === 'ogre') parent = ogreBody(pp.id, pp.x, pp.y);
        }
        if (parent) [r.x, r.y] = attachedPos(r as unknown as MoveState, parent, r.char);
      }
      out.set(id, r);
      return r;
    };
    for (const id of raw.keys()) resolve(id, 0);
    return out;
  }

  private readAimForDraw() {
    const s = this.boot.client.pred.state;
    if (!s || !this.me) return 0;
    const [wx, wy] = this.pointerWorld();
    return Math.atan2(wy - (this.me.y - KIT[this.me.char].h + 3), wx - this.me.x);
  }

  private updateCamera(dt: number) {
    const cam = this.cameras.main;
    const me = this.me;
    if (!me) return;
    const [wx, wy] = this.pointerWorld();
    const lookX = Math.max(-40, Math.min(40, (wx - me.x) * 0.15));
    const lookY = Math.max(-30, Math.min(30, (wy - me.y) * 0.15));
    const tx = me.x + lookX;
    const ty = me.y - 20 + lookY;
    if (!Number.isFinite(this.camX)) {
      this.camX = tx;
      this.camY = ty;
    }
    const k = 1 - Math.exp(-dt * 8);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    this.shake *= Math.exp(-dt * 10);
    const sx = (Math.random() - 0.5) * this.shake;
    const sy = (Math.random() - 0.5) * this.shake;
    cam.centerOn(this.camX + sx, this.camY + sy);
    this.hills.setPosition(cam.scrollX * 0.75, cam.scrollY * 0.85);
  }

  // ---------- drawing ----------

  /** Where a pulley rope goes up to: the first solid tile above. */
  private wheelAbove(x: number, y: number): number {
    const m = this.map!;
    let ty = Math.floor(y / TILE);
    while (ty > 0 && !isSolid(tileAt(m, Math.floor(x / TILE), ty - 1))) ty--;
    return ty * TILE + 6;
  }

  private drawBodies(bodies: SimBody[]) {
    const g = this.back;
    const byId = new Map(bodies.map((b) => [b.id, b]));
    for (const b of bodies) {
      switch (b.k) {
        case BK.hook: {
          const cx = b.x + b.w / 2;
          const lift = byId.get(b.id + 1);
          const wy = this.wheelAbove(cx, b.y);
          if (lift && lift.k === BK.lift) {
            const lx = lift.x + lift.w / 2;
            const ly = this.wheelAbove(lx, lift.y);
            const top = Math.min(wy, ly);
            g.lineStyle(1, COL.rope, 1);
            g.lineBetween(cx, top, lx, top);
            g.lineBetween(lx, top, lx, lift.y);
            this.wheel(g, lx, top);
          }
          g.lineStyle(1, COL.rope, 1);
          g.lineBetween(cx, Math.min(wy, b.y), cx, b.y);
          this.wheel(g, cx, Math.min(wy, lift ? this.wheelAbove(lift.x + lift.w / 2, lift.y) : wy));
          g.fillStyle(COL.iron, 1);
          g.fillRect(b.x + 2, b.y, b.w - 4, 2);
          g.lineStyle(2, COL.iron, 1);
          g.beginPath();
          g.arc(cx, b.y + 3, 3, Math.PI * 0.1, Math.PI * 1.05, false);
          g.strokePath();
          break;
        }
        case BK.lift: {
          g.fillStyle(COL.woodDark, 1);
          g.fillRect(b.x, b.y, b.w, b.h);
          g.fillStyle(COL.plank, 1);
          g.fillRect(b.x, b.y, b.w, 3);
          g.fillStyle(COL.iron, 1);
          g.fillRect(b.x + 1, b.y + 4, 2, 2);
          g.fillRect(b.x + b.w - 3, b.y + 4, 2, 2);
          g.lineStyle(1, COL.rope, 0.9);
          g.lineBetween(b.x + 2, b.y, b.x + b.w / 2, b.y - 8);
          g.lineBetween(b.x + b.w - 2, b.y, b.x + b.w / 2, b.y - 8);
          break;
        }
        case BK.gate: {
          g.fillStyle(COL.ironDark, 1);
          g.fillRect(b.x, b.y, b.w, 3);
          g.fillRect(b.x, b.y + b.h - 3, b.w, 3);
          g.fillStyle(COL.iron, 1);
          for (let x = b.x + 1; x < b.x + b.w - 1; x += 4) g.fillRect(x, b.y, 2, b.h);
          g.fillStyle(COL.ironDark, 1);
          g.fillRect(b.x, b.y + b.h / 2, b.w, 2);
          break;
        }
        case BK.lever: {
          const on = b.s > 0;
          const bx = b.x + b.w / 2;
          const by = b.y + b.h;
          g.fillStyle(COL.ironDark, 1);
          g.fillRect(b.x, by - 4, b.w, 4);
          const a = on ? -Math.PI / 2 + 0.7 : -Math.PI / 2 - 0.7;
          g.lineStyle(2, COL.woodLight, 1);
          g.lineBetween(bx, by - 3, bx + Math.cos(a) * 10, by - 3 + Math.sin(a) * 10);
          g.fillStyle(on ? COL.gold : 0xff6b8b, 1);
          g.fillCircle(bx + Math.cos(a) * 10, by - 3 + Math.sin(a) * 10, 2);
          break;
        }
        case BK.plate: {
          const on = b.s > 0;
          g.fillStyle(on ? COL.gold : COL.iron, 1);
          g.fillRect(b.x + 1, b.y + (on ? 2 : 0), b.w - 2, on ? 1 : 3);
          // A weight glyph so a heavy plate reads as heavy.
          g.fillStyle(on ? COL.gold : COL.ironDark, 0.9);
          const cx = b.x + b.w / 2;
          g.fillRect(cx - 4, b.y - 8, 8, 6);
          g.fillRect(cx - 2, b.y - 10, 4, 2);
          break;
        }
        case BK.target: {
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          g.fillStyle(b.s ? COL.grass : 0xe8233f, 1);
          g.fillCircle(cx, cy, 6);
          g.fillStyle(COL.white, 1);
          g.fillCircle(cx, cy, 4);
          g.fillStyle(b.s ? COL.grass : 0xe8233f, 1);
          g.fillCircle(cx, cy, 2);
          break;
        }
        case BK.goal: {
          const t = performance.now() / 1000;
          g.fillStyle(COL.gold, 0.08 + Math.sin(t * 2) * 0.03);
          g.fillRect(b.x, b.y, b.w, b.h);
          g.fillStyle(COL.gold, 0.5);
          for (let i = 0; i < 6; i++) {
            const px = b.x + ((i * 37 + t * 10) % b.w);
            const py = b.y + b.h - ((t * 12 + i * 11) % b.h);
            g.fillRect(px, py, 1, 1);
          }
          const fx = b.x + b.w - 20;
          g.fillStyle(COL.woodDark, 1);
          g.fillRect(fx, b.y + 2, 1, b.h - 2);
          g.fillStyle(COL.gold, 1);
          g.fillTriangle(fx + 1, b.y + 2, fx + 1, b.y + 10, fx + 10 + Math.sin(t * 4), b.y + 6);
          break;
        }
        case BK.checkpoint: {
          const px = b.x + 2;
          const top = b.y;
          g.fillStyle(COL.woodDark, 1);
          g.fillRect(px, top, 1, b.h);
          const on = b.s > 0;
          const fy = on ? top : top + b.h - 9;
          g.fillStyle(on ? COL.grass : COL.iron, 1);
          g.fillTriangle(px + 1, fy, px + 1, fy + 6, px + 8, fy + 3);
          break;
        }
      }
    }
  }

  private wheel(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    g.fillStyle(COL.ironDark, 1);
    g.fillCircle(x, y, 4);
    g.fillStyle(COL.iron, 1);
    g.fillCircle(x, y, 2);
  }

  private drawRopes(view: WorldView, pos: Map<number, PlayerView>, dt: number) {
    const g = this.dyn;
    const holders = new Map<string, PlayerView>();
    for (const p of pos.values()) {
      if (!p.rope) continue;
      const [hx, hy] = [p.x, p.y - KIT[p.char].h + 3];
      g.lineStyle(1, COL.rope, 1);
      g.lineBetween(p.rax, p.ray, hx, hy);
      g.fillStyle(COL.woodDark, 1);
      g.fillRect(p.rax - 1, p.ray - 1, 2, 2);
      holders.set(`${Math.round(p.rax * 8)}:${Math.round(p.ray * 8)}`, p);
    }
    const live = new Set<number>();
    for (const r of view.ropes) {
      live.add(r.id);
      const holder = holders.get(`${Math.round(r.ax * 8)}:${Math.round(r.ay * 8)}`);
      if (holder) {
        this.ropeHeld.set(r.id, [holder.x, holder.y - KIT[holder.char].h + 3]);
        this.ropeSims.delete(r.id);
        continue;
      }
      let sim = this.ropeSims.get(r.id);
      if (!sim) {
        const n = Math.max(3, Math.round(r.len / 8));
        const end = this.ropeHeld.get(r.id);
        sim = { pts: [], seg: r.len / n };
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          const x = end ? r.ax + (end[0] - r.ax) * f : r.ax;
          const y = end ? r.ay + (end[1] - r.ay) * f : r.ay + r.len * f;
          sim.pts.push({ x, y, px: x, py: y });
        }
        this.ropeSims.set(r.id, sim);
        this.ropeHeld.delete(r.id);
      }
      this.stepRope(sim, r.ax, r.ay, dt);
      g.lineStyle(1, COL.rope, 1);
      g.beginPath();
      g.moveTo(sim.pts[0].x, sim.pts[0].y);
      for (const p of sim.pts) g.lineTo(p.x, p.y);
      g.strokePath();
      g.fillStyle(COL.woodDark, 1);
      g.fillRect(r.ax - 1, r.ay - 1, 2, 2);
      const end = sim.pts[sim.pts.length - 1];
      g.fillStyle(COL.rope, 1);
      g.fillRect(end.x - 1, end.y - 1, 2, 2);
    }
    for (const id of this.ropeSims.keys()) if (!live.has(id)) this.ropeSims.delete(id);
  }

  private stepRope(sim: RopeSim, ax: number, ay: number, dt: number) {
    const pts = sim.pts;
    const d = Math.min(dt, 1 / 30);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const vx = (p.x - p.px) * 0.99;
      const vy = (p.y - p.py) * 0.99;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + GRAV * 0.3 * d * d;
    }
    pts[0].x = pts[0].px = ax;
    pts[0].y = pts[0].py = ay;
    for (let it = 0; it < 8; it++)
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1e-6;
        const diff = (len - sim.seg) / len;
        if (i === 1) {
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else {
          a.x += dx * diff * 0.5;
          a.y += dy * diff * 0.5;
          b.x -= dx * diff * 0.5;
          b.y -= dy * diff * 0.5;
        }
      }
  }

  private drawArrow(x: number, y: number, a: number) {
    const g = this.dyn;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    g.lineStyle(1, COL.woodLight, 1);
    g.lineBetween(x - dx * 7, y - dy * 7, x, y);
    g.fillStyle(COL.white, 1);
    g.fillRect(x - dx * 7 - 1, y - dy * 7 - 1, 2, 2);
    g.fillStyle(COL.iron, 1);
    g.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
  }

  private drawPlayer(p: PlayerView, dt: number) {
    if (p.off) return;
    const g = this.dyn;
    let a = this.poses.get(p.id);
    if (!a) this.poses.set(p.id, (a = { lastX: p.x, lastY: p.y, vy: 0, walk: 0, squash: 0, seen: 0 }));
    const moved = p.x - a.lastX;
    a.vy = dt > 0 ? (p.y - a.lastY) / dt : 0;
    if (p.gnd || p.pm === PM.stand) a.walk += Math.abs(moved) * 0.35;
    a.lastX = p.x;
    a.lastY = p.y;
    a.squash *= Math.exp(-dt * 10);
    const color = hex(PLAYER_COLORS[p.c] ?? PLAYER_COLORS[0]);
    const k = KIT[p.char];
    const sq = a.squash + (p.heavy ? 0.08 : 0);
    const w = k.w * (1 + sq * 0.6);
    const h = k.h * (1 - sq * 0.5);
    const x = p.x;
    const y = p.y;
    const face = p.left ? -1 : 1;
    const step = p.gnd || p.pm === PM.stand ? Math.sin(a.walk) : 0;
    const airborne = !p.gnd && p.pm === PM.none;

    // Shadow.
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(x, y, w * 0.9, 2);

    if (p.char === 'ogre') {
      const skin = p.heavy ? COL.ogreHeavy : COL.ogre;
      const dark = p.heavy ? COL.ogreHeavyDark : COL.ogreDark;
      // Legs.
      g.fillStyle(dark, 1);
      g.fillRect(x - w / 2 + 2, y - 5 + Math.max(0, step) * 1.5, 5, 5 - Math.max(0, step) * 1.5);
      g.fillRect(x + w / 2 - 7, y - 5 + Math.max(0, -step) * 1.5, 5, 5 - Math.max(0, -step) * 1.5);
      // Body.
      g.fillStyle(skin, 1);
      g.fillRoundedRect(x - w / 2, y - h, w, h - 4, 4);
      g.fillStyle(dark, 1);
      g.fillRect(x - w / 2, y - h + 11, w, 1);
      // Belly and loincloth in the player's colour.
      g.fillStyle(p.heavy ? 0x8a90a3 : 0xa9cf83, 1);
      g.fillEllipse(x, y - h * 0.42, w * 0.6, h * 0.34);
      g.fillStyle(color, 1);
      g.fillRect(x - w / 2 + 1, y - 7, w - 2, 3);
      // Face.
      const ex = x + face * 2;
      g.fillStyle(COL.white, 1);
      g.fillRect(ex - 4, y - h + 4, 2, 2);
      g.fillRect(ex + 2, y - h + 4, 2, 2);
      g.fillStyle(COL.ink, 1);
      g.fillRect(ex - 4 + (face > 0 ? 1 : 0), y - h + 5, 1, 1);
      g.fillRect(ex + 2 + (face > 0 ? 1 : 0), y - h + 5, 1, 1);
      g.fillStyle(COL.white, 1);
      g.fillRect(ex - 3, y - h + 9, 1, 2);
      g.fillRect(ex + 3, y - h + 9, 1, 2);
      // Arms: up when holding someone.
      g.fillStyle(skin, 1);
      if (p.held) {
        g.fillRect(x - w / 2 - 2, y - h - 2, 3, 8);
        g.fillRect(x + w / 2 - 1, y - h - 2, 3, 8);
      } else {
        g.fillRect(x - w / 2 - 2, y - h + 8, 3, 7);
        g.fillRect(x + w / 2 - 1, y - h + 8, 3, 7);
      }
      if (p.heavy) {
        // A little weight above his head says "heavy" at a glance.
        g.fillStyle(COL.ironDark, 1);
        g.fillRect(x - 4, y - h - 9, 8, 5);
        g.fillRect(x - 2, y - h - 11, 4, 2);
        g.fillStyle(COL.iron, 1);
        g.fillRect(x - 3, y - h - 8, 2, 1);
      }
      if (p.pound) {
        g.lineStyle(1, COL.white, 0.6);
        for (let i = -1; i <= 1; i++) g.lineBetween(x + i * 5, y - h - 14, x + i * 5, y - h - 4);
      }
    } else {
      // Archer: little hooded figure with a bow that follows the aim.
      g.fillStyle(0x3a2a20, 1);
      g.fillRect(x - 3, y - 4 + Math.max(0, step), 2, 4 - Math.max(0, step));
      g.fillRect(x + 1, y - 4 + Math.max(0, -step), 2, 4 - Math.max(0, -step));
      g.fillStyle(color, 1);
      g.fillRoundedRect(x - w / 2, y - h, w, h - 3, 3);
      g.fillStyle(0x000000, 0.2);
      g.fillRect(x - w / 2, y - h + 7, w, 1);
      g.fillStyle(COL.skin, 1);
      g.fillRect(x - 3 + face, y - h + 3, 6, 4);
      g.fillStyle(COL.ink, 1);
      g.fillRect(x - 2 + face * 2, y - h + 4, 1, 1);
      g.fillRect(x + 1 + face * 2, y - h + 4, 1, 1);
      if (airborne && !p.rope && a.vy < 0) g.fillRect(x - 1 + face * 2, y - h + 6, 2, 1);
      // Bow.
      const [hx, hy] = [x, y - k.h + 3];
      const aim = p.aim;
      const bx = hx + Math.cos(aim) * 5;
      const by = hy + Math.sin(aim) * 5 + 3;
      g.lineStyle(1, COL.woodLight, 1);
      g.beginPath();
      g.arc(bx, by, 4, aim - 1.2, aim + 1.2, false);
      g.strokePath();
      g.lineStyle(1, COL.white, 0.6);
      g.lineBetween(bx + Math.cos(aim - 1.2) * 4, by + Math.sin(aim - 1.2) * 4, bx + Math.cos(aim + 1.2) * 4, by + Math.sin(aim + 1.2) * 4);
    }
    if (p.stun && airborne) {
      g.fillStyle(COL.gold, 0.8);
      const t = performance.now() / 120;
      g.fillRect(x + Math.cos(t) * 6, y - h - 4 + Math.sin(t) * 2, 1, 1);
      g.fillRect(x + Math.cos(t + 3) * 6, y - h - 4 + Math.sin(t + 3) * 2, 1, 1);
    }
  }

  /** Where your rope arrow would land, or where your throw would go. */
  private drawAimGuide() {
    const { client } = this.boot;
    const me = this.me;
    const s = client.pred.state;
    if (!me || !s || !this.map) return;
    const g = this.top;
    const [wx, wy] = this.pointerWorld();
    g.lineStyle(1, COL.white, 0.8);
    g.strokeCircle(wx, wy, 2.5);
    g.fillStyle(COL.white, 0.9);
    g.fillRect(wx - 0.5, wy - 0.5, 1, 1);
    const [hx, hy] = [me.x, me.y - KIT[me.char].h + 3];
    const aim = Math.atan2(wy - hy, wx - hx);
    if (me.char === 'archer') {
      const c = ropeCast(this.map, hx, hy, aim);
      const len = Math.hypot(c.x - hx, c.y - hy);
      g.fillStyle(c.hit ? COL.grass : COL.white, c.hit ? 0.8 : 0.25);
      for (let d = 6; d < len; d += 5) g.fillRect(hx + Math.cos(aim) * d - 0.5, hy + Math.sin(aim) * d - 0.5, 1, 1);
      if (c.hit) {
        g.lineStyle(1, COL.grass, 0.9);
        g.strokeCircle(c.x, c.y, 3);
      }
    } else if (s.held) {
      // Throw arc preview.
      let px = me.x;
      let py = me.y - KIT.ogre.h - 2;
      let vx = Math.cos(aim) * 600 + s.vx * 0.5;
      let vy = Math.sin(aim) * 600;
      const ctx = client.ctxAt(client.tl.renderTick);
      g.fillStyle(COL.gold, 0.8);
      for (let i = 0; i < 90; i++) {
        vy += GRAV / 60;
        px += vx / 60;
        py += vy / 60;
        if (ctx && overlapsSolid(ctx, px - 5, py - 14, px + 5, py)) break;
        if (i % 3 === 0) g.fillRect(px - 0.5, py - 7, 1, 1);
      }
    }
  }

  private stepFx(dt: number) {
    for (const f of this.fx) {
      f.vy += f.g * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.life -= dt;
    }
    this.fx = this.fx.filter((f) => f.life > 0);
    for (const r of this.rings) {
      r.life -= dt;
      r.r += dt * 160;
    }
    this.rings = this.rings.filter((r) => r.life > 0);
  }

  private drawFx() {
    const g = this.top;
    for (const f of this.fx) {
      g.fillStyle(f.color, Math.min(1, (f.life / f.max) * 1.5));
      g.fillRect(f.x - f.size / 2, f.y - f.size / 2, f.size, f.size);
    }
    for (const r of this.rings) {
      g.lineStyle(2, r.color, r.life / r.max);
      g.strokeEllipse(r.x, r.y, r.r * 2, r.r * 0.6);
    }
  }

  private updateNames(pos: Map<number, PlayerView>) {
    const { client } = this.boot;
    const seen = new Set<number>();
    for (const p of pos.values()) {
      if (p.off || p.id === client.myId) continue;
      seen.add(p.id);
      let t = this.names.get(p.id);
      const name = client.meta.get(p.id)?.name ?? '';
      if (!t) {
        t = this.add
          .text(0, 0, name, { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '5px', color: PLAYER_COLORS[p.c] ?? '#fff', stroke: '#14101c', strokeThickness: 2, resolution: this.zoom * devicePixelRatio * 2 })
          .setOrigin(0.5, 1)
          .setDepth(5);
        this.names.set(p.id, t);
      }
      if (t.text !== name) t.setText(name);
      t.setPosition(p.x, p.y - KIT[p.char].h - (p.heavy ? 13 : 3));
    }
    for (const [id, t] of this.names)
      if (!seen.has(id)) {
        t.destroy();
        this.names.delete(id);
      }
  }
}
