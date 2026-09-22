import Phaser from 'phaser';
import {
  ENEMY_R,
  PLAYER_COLORS,
  itemInfo,
  T,
  TILE,
  spikeState,
  type FloorMsg,
  type GameEvent,
  type CharKind,
  type PlayerSnap,
  type WorldView,
} from '../shared/protocol';
import { parseTiles } from '../shared/sim/map';
import { MODE, type MoveState, type StepResult } from '../shared/sim/movement';
import { trapSpot } from '../shared/sim/kits/archer';
import { SHIELD_ARC } from '../shared/sim/kits/knight';
import { makeTextures, renderMap } from './sprites';
import { Fx } from './fx';
import { sfx } from './audio';
import { Autopilot, type BotOutput } from './autopilot';
import type { NetClient, RawInput, RenderBullet } from './net/client';
import type { Hud } from './hud';
import type { DebugOverlay } from './debug';
import { FogLayer } from './fog';
import { CameraRig } from './camera';
import type { Eye } from '../shared/sim/vision';

interface View {
  spr: Phaser.GameObjects.Image;
  x: number;
  y: number;
  spd: number;
  flash: number;
  kind: string;
  extra?: Phaser.GameObjects.GameObject[];
  vx?: number;
  vy?: number;
  /** Fade-in on first appearance so things arriving out of the fog don't pop. */
  fade: number;
  /** Props (barrels, items) stay drawn as a last-known memory once they leave sight. */
  seen?: boolean;
  ghost?: boolean;
  /** Seconds since the server stopped sending it; it fades out instead of vanishing. */
  gone?: number;
  /** Players: smoothed on-screen velocity, and when the last slash / bash started. */
  mvx?: number;
  mvy?: number;
  swingAt?: number;
  swingArc?: number;
  swingDir?: number;
  bashAt?: number;
}

const LINGER = 0.15;

export interface Boot {
  client: NetClient;
  hud: Hud;
  debug: DebugOverlay;
}

const hex = (s: string) => parseInt(s.slice(1), 16);

export class GameScene extends Phaser.Scene {
  boot!: Boot;
  fx!: Fx;
  map: { w: number; h: number; tiles: Uint8Array; boss: boolean } | null = null;
  mapImg: Phaser.GameObjects.Image | null = null;
  mapKey = '';
  decals!: Phaser.GameObjects.RenderTexture;
  spikes: { img: Phaser.GameObjects.Image; tx: number; ty: number; st: number }[] = [];
  lava: { img: Phaser.GameObjects.Image; tx: number; ty: number }[] = [];
  lavaGlows: Phaser.GameObjects.Image[] = [];
  grate: Phaser.GameObjects.Image | null = null;
  stairsGlow: Phaser.GameObjects.Image | null = null;
  stairsPos = { x: 0, y: 0 };
  players = new Map<number, View>();
  enemies = new Map<number, View>();
  bullets = new Map<number, View>();
  barrels = new Map<number, View>();
  items = new Map<number, View>();
  traps = new Map<number, View>();
  localTraps: { x: number; y: number; until: number; img: Phaser.GameObjects.Image }[] = [];
  overlay!: Phaser.GameObjects.Graphics;
  cross!: Phaser.GameObjects.Image;
  arrows: Phaser.GameObjects.Image[] = [];
  keys!: Record<string, Phaser.Input.Keyboard.Key>;
  fog!: FogLayer;
  rig!: CameraRig;
  eyes: Eye[] = [];
  camTag = document.getElementById('camtag');
  camTagKey = '';
  trauma = 0;
  kickX = 0;
  kickY = 0;
  zoomPunch = 0;
  baseZoom = 3;
  hitstopUntil = 0;
  pressA = false;
  pressB = false;
  pressMove = false;
  wasFull = false;
  aim = 0;
  lavaFrame = 0;
  floorCount = 0;
  stairsWasOpen = false;
  lastLatest: WorldView | null = null;
  bot: Autopilot | null = null;
  auto: BotOutput | null = null;

  constructor() {
    super('game');
  }

  init(data: Boot) {
    this.boot = data;
  }

  get client() {
    return this.boot.client;
  }

  create() {
    makeTextures(this);
    this.overlay = this.add.graphics().setDepth(950);
    this.cross = this.add.image(0, 0, 'cross').setDepth(1000);
    this.input.mouse?.disableContextMenu();
    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,SHIFT,F,ONE,TWO,THREE') as Record<string, Phaser.Input.Keyboard.Key>;
    const latch = (f: () => void) => (e: KeyboardEvent) => !e.repeat && f();
    kb.on('keydown-SPACE', latch(() => (this.pressMove = true)));
    kb.on('keydown-SHIFT', latch(() => (this.pressMove = true)));
    kb.on('keydown-F', latch(() => (this.pressB = true)));
    (['ONE', 'TWO', 'THREE'] as const).forEach((k, i) => kb.on(`keydown-${k}`, () => this.choose(i)));
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown()) this.pressB = true;
      if (p.leftButtonDown()) this.pressA = true;
    });
    this.boot.hud.onChoose = (i) => this.choose(i);
    this.boot.hud.onRestart = () => this.client.net.sendJson({ t: 'restart' });

    this.fog = new FogLayer(this, this.client.fog);
    this.rig = new CameraRig(this, () =>
      [...this.players.keys()].filter((id) => id !== this.client.myId).sort((a, b) => a - b),
    );
    const q = new URLSearchParams(location.search);
    this.rig.edgePan = q.get('edgepan') !== '0';
    if (q.has('bot')) this.bot = new Autopilot(() => this.map, (i) => this.choose(i), () => this.client.fog.explored);
    this.decals = this.add.renderTexture(0, 0, 16, 16).setOrigin(0).setDepth(2);
    this.fx = new Fx(this, this.decals);
    this.fx.solid = (x, y) => {
      const m = this.map;
      if (!m) return false;
      const tx = Math.floor(x / TILE);
      const ty = Math.floor(y / TILE);
      if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
      const t = m.tiles[ty * m.w + tx];
      return t === T.Wall || t === T.Pit || t === T.Lava;
    };
    this.client.hooks = {
      input: () => this.sampleInput(),
      predicted: (res, s) => this.onPredicted(res, s),
      parried: (x, y, deflected) => this.onParried(x, y, deflected),
      impact: (x, y, what, id) => this.onImpact(x, y, what, id),
      event: (e) => this.onEvent(e),
      floor: (f) => this.loadFloor(f),
    };
    if (this.client.floor) this.loadFloor(this.client.floor);
    this.scale.on('resize', () => this.fitZoom());
    this.fitZoom();
    this.events.once('shutdown', () => (this.client.hooks = null));
  }

  fitZoom() {
    const forced = Number(new URLSearchParams(location.search).get('zoom'));
    this.baseZoom = forced > 0 ? forced : Math.max(2, Math.floor(Math.min(this.scale.width / 360, this.scale.height / 230)));
  }

  choose(i: number) {
    if (this.boot.hud.choices) this.client.net.sendJson({ t: 'choose', idx: i });
  }

  /** Called by the net client once per fixed tick. */
  sampleInput(): RawInput {
    const aPress = this.pressA;
    const bPress = this.pressB;
    const movePress = this.pressMove;
    this.pressA = this.pressB = this.pressMove = false;
    const me = this.client.pred.state;
    const alive = !!me && !me.down;
    if (this.auto) return { ...this.auto, aPress: aPress && alive, bPress: bPress && alive, movePress };
    const k = this.keys;
    const pointer = this.input.activePointer;
    return {
      mx: (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0),
      my: (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0),
      aim: this.aim,
      a: pointer.leftButtonDown() && pointer.isDown && alive,
      aPress: aPress && alive,
      b: (pointer.rightButtonDown() || k.F.isDown) && alive,
      bPress: bPress && alive,
      move: k.SHIFT.isDown || k.SPACE.isDown,
      movePress,
    };
  }

  loadFloor(f: FloorMsg) {
    const tiles = parseTiles(f.tiles);
    this.map = { w: f.w, h: f.h, tiles, boss: f.boss };
    for (const t of this.localTraps) t.img.destroy();
    this.localTraps = [];
    for (const m of [this.enemies, this.bullets, this.barrels, this.items, this.traps]) {
      for (const v of m.values()) this.destroyView(v);
      m.clear();
    }
    this.mapImg?.destroy();
    if (this.mapKey) this.textures.remove(this.mapKey);
    this.mapKey = `map${++this.floorCount}`;
    renderMap(this, this.mapKey, f.w, f.h, tiles, f.seed, f.boss);
    this.mapImg = this.add.image(0, 0, this.mapKey).setOrigin(0).setDepth(0);
    this.decals?.destroy();
    this.decals = this.add.renderTexture(0, 0, f.w * TILE, f.h * TILE).setOrigin(0).setDepth(2);
    this.fx.decals = this.decals;
    this.fx.parts = [];
    for (const s of this.spikes) s.img.destroy();
    for (const l of this.lava) l.img.destroy();
    for (const g of this.lavaGlows) g.destroy();
    this.spikes = [];
    this.lava = [];
    this.lavaGlows = [];
    this.grate?.destroy();
    this.stairsGlow?.destroy();
    this.grate = this.stairsGlow = null;
    let sx = -1;
    let sy = -1;
    for (let ty = 0; ty < f.h; ty++)
      for (let tx = 0; tx < f.w; tx++) {
        const t = tiles[ty * f.w + tx];
        const x = tx * TILE;
        const y = ty * TILE;
        if (t === T.Spikes) this.spikes.push({ img: this.add.image(x, y, 'spk0').setOrigin(0).setDepth(1), tx, ty, st: 0 });
        else if (t === T.Lava) {
          this.lava.push({ img: this.add.image(x, y, 'lava0').setOrigin(0).setDepth(1), tx, ty });
          if ((tx + ty) % 2 === 0)
            this.lavaGlows.push(
              this.add
                .image(x + 8, y + 8, 'glow')
                .setTint(0xff6a1f)
                .setAlpha(0.35)
                .setScale(1.2)
                .setBlendMode(Phaser.BlendModes.ADD)
                .setDepth(3),
            );
        } else if (t === T.Stairs && sx < 0) {
          sx = tx;
          sy = ty;
        }
      }
    if (sx >= 0) {
      this.stairsPos = { x: (sx + 1) * TILE, y: (sy + 1) * TILE };
      this.grate = this.add.image(sx * TILE, sy * TILE, 'grate').setOrigin(0).setDepth(3);
      this.stairsGlow = this.add
        .image(this.stairsPos.x, this.stairsPos.y, 'glow')
        .setTint(0xffd23f)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(4)
        .setScale(1.5)
        .setVisible(false);
    }
    this.stairsWasOpen = false;
    if (this.floorCount > 1) sfx.stairs();
    this.fog.reset(this.floorCount);
    this.rig.snapBack();
    this.rig.x = -1;
  }

  destroyView(v: View) {
    v.spr.destroy();
    v.extra?.forEach((o) => o.destroy());
  }

  sync<T extends { id: number; x: number; y: number }>(
    map: Map<number, View>,
    list: T[],
    make: (o: T) => View,
    upd?: (v: View, o: T) => void,
    dt = 0,
    remember = false,
    linger = false,
  ) {
    const seen = new Set<number>();
    for (const o of list) {
      seen.add(o.id);
      let v = map.get(o.id);
      if (!v) {
        v = make(o);
        map.set(o.id, v);
      }
      v.ghost = false;
      v.gone = 0;
      if (dt > 0) {
        const k = Math.min(1, dt * 15);
        v.spd += (Math.hypot(o.x - v.x, o.y - v.y) / dt - v.spd) * k;
        v.mvx = (v.mvx ?? 0) + ((o.x - v.x) / dt - (v.mvx ?? 0)) * k;
        v.mvy = (v.mvy ?? 0) + ((o.y - v.y) / dt - (v.mvy ?? 0)) * k;
      }
      v.x = o.x;
      v.y = o.y;
      upd?.(v, o);
    }
    for (const [id, v] of map)
      if (!seen.has(id)) {
        // Out of sight is not gone: keep the last-known prop until its spot is seen again.
        if (remember && v.seen && !this.client.fog.visibleAt(v.x, v.y)) {
          v.ghost = true;
          continue;
        }
        if (linger && (v.gone = (v.gone ?? 0) + dt) < LINGER) continue;
        this.destroyView(v);
        map.delete(id);
      }
  }

  view(spr: Phaser.GameObjects.Image, x: number, y: number, kind: string, extra?: Phaser.GameObjects.GameObject[]): View {
    spr.setPosition(x, y);
    return { spr, x, y, spd: 0, flash: 0, kind, extra, fade: 0 };
  }

  /** Opacity for a non-teammate view: in sight (with fade-in), remembered, or hidden. */
  private fogAlpha(v: View, dt: number, remember = false) {
    v.fade = Math.min(1, v.fade + dt * 6);
    const a = this.fog.alphaAt(v.x, v.y);
    if (a > 0.5) v.seen = true;
    if (remember && v.seen) return v.ghost ? 1 : Math.max(a * v.fade, 1 - a);
    return a * v.fade;
  }

  private syncWorld(view: WorldView, bullets: RenderBullet[], myPos: [number, number] | null, dt: number) {
    const myId = this.client.myId;
    const players = view.players.map((p) => (p.id === myId && myPos ? { ...p, x: myPos[0], y: myPos[1] } : p));
    this.eyes = players;
    this.sync(
      this.players,
      players,
      (p) => {
        const body = this.add.image(0, 0, `hero_${p.k}${p.c}`).setOrigin(0.5, 0.8);
        const wpn = p.k === 'knight' ? this.add.image(0, 0, 'sword').setOrigin(0.22, 0.5) : this.add.image(0, 0, 'bow').setOrigin(0.3, 0.5);
        const shield = this.add.image(0, 0, `shield${p.c}`).setOrigin(0.5, 0.5).setVisible(p.k === 'knight');
        const name = this.add
          .text(0, 0, p.name, { fontFamily: 'monospace', fontSize: '5px', color: PLAYER_COLORS[p.c], stroke: '#000', strokeThickness: 2 })
          .setOrigin(0.5, 1)
          .setResolution(4)
          .setDepth(955);
        const shadow = this.add.ellipse(0, 0, 10, 4, 0x000000, 0.35).setDepth(4);
        return this.view(body, p.x, p.y, p.k, [wpn, name, shadow, shield]);
      },
      (v, p) => {
        const name = v.extra![1] as Phaser.GameObjects.Text;
        const label = p.off ? `${p.name} (offline)` : p.name;
        if (name.text !== label) name.setText(label);
      },
      dt,
    );
    this.sync(
      this.enemies,
      view.enemies,
      (e) => {
        const spr = this.add.image(0, 0, e.k).setOrigin(0.5, 0.75);
        const shadow = this.add.ellipse(0, 0, e.k === 'boss' ? 26 : e.k === 'brute' ? 14 : 10, e.k === 'boss' ? 8 : 4, 0x000000, 0.35).setDepth(4);
        return this.view(spr, e.x, e.y, e.k, [shadow]);
      },
      undefined,
      dt,
      false,
      true,
    );
    this.sync(
      this.bullets,
      bullets,
      (b) => {
        const spr = this.add.image(0, 0, this.bulletTex(b)).setDepth(800);
        const glow = this.add.image(0, 0, 'glow').setAlpha(0.8).setBlendMode(Phaser.BlendModes.ADD).setDepth(799);
        return this.view(spr, b.x, b.y, b.e ? 'eb' : 'pb', [glow]);
      },
      (v, b) => {
        const want = this.bulletTex(b);
        const glow = v.extra![0] as Phaser.GameObjects.Image;
        if (v.spr.texture.key !== want || !v.spd) {
          v.spr.setTexture(want);
          glow.setTint(b.e ? 0xff4fd8 : b.arrow ? 0xfff0c0 : 0xffb13b).setScale(b.e ? 0.35 : b.arrow ? 0.18 : 0.3);
          v.spd = 1;
        }
        v.vx = b.vx;
        v.vy = b.vy;
        v.spr.setScale(b.arrow ? (b.r > 2 ? 1.25 : 1) : b.r > 2 ? 1.4 : 1);
      },
    );
    this.sync(this.barrels, view.barrels, (b) => this.view(this.add.image(0, 0, 'barrel').setOrigin(0.5, 0.7), b.x, b.y, 'barrel'), undefined, 0, true);
    this.sync(
      this.items,
      view.items,
      (it) => {
        const glow = this.add
          .image(it.x, it.y, 'glow')
          .setTint(it.k === 'potion' ? 0xff3355 : 0xffd23f)
          .setScale(0.5)
          .setAlpha(0.6)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(5);
        return this.view(this.add.image(0, 0, `item_${it.k}`).setDepth(6), it.x, it.y, it.k, [glow]);
      },
      undefined,
      0,
      true,
    );
    this.sync(this.traps, view.traps, (t) => this.view(this.add.image(0, 0, 'trap').setOrigin(0.5, 1).setDepth(6), t.x, t.y, 'trap'));
    const now = performance.now();
    this.localTraps = this.localTraps.filter((t) => {
      const real = view.traps.some((r) => Math.hypot(r.x - t.x, r.y - t.y) < 8);
      if (real || now > t.until) {
        t.img.destroy();
        return false;
      }
      return true;
    });
  }

  private bulletTex(b: RenderBullet) {
    return b.e ? 'ebullet' : b.arrow ? 'arrowshot' : 'bullet';
  }

  private myChar(): CharKind {
    return this.client.pred.char;
  }

  private onLatest(s: WorldView) {
    if (s.stairs && !this.stairsWasOpen) {
      this.stairsWasOpen = true;
      this.grate?.setVisible(false);
      this.stairsGlow?.setVisible(true);
      this.fx.sparks(this.stairsPos.x, this.stairsPos.y, 30, 0xffd23f, 160);
      sfx.stairs();
    }
    this.boot.hud.update(s, this.client.myId);
  }

  nearest(map: Map<number, View>, x: number, y: number, r: number) {
    let best: View | null = null;
    let bd = r;
    for (const v of map.values()) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  shakeAt(x: number, y: number, amount: number) {
    const me = this.players.get(this.client.myId);
    const d = me ? Math.hypot(me.x - x, me.y - y) : 0;
    this.trauma = Math.min(1, this.trauma + amount * Math.max(0.15, 1 - d / 260));
  }

  popText(x: number, y: number, text: string, color: string) {
    if (this.fog.shadeAt(x, y) > 0.5) return;
    const t = this.add
      .text(x + (Math.random() - 0.5) * 6, y - 10, text, { fontFamily: 'monospace', fontSize: '8px', fontStyle: 'bold', color, stroke: '#000', strokeThickness: 2 })
      .setOrigin(0.5)
      .setResolution(4)
      .setDepth(960);
    this.tweens.add({ targets: t, y: t.y - 14, alpha: 0, duration: 650, ease: 'Cubic.easeOut', onComplete: () => t.destroy() });
  }

  // ---------- instant local feedback ----------
  private onPredicted(res: StepResult, s: MoveState) {
    const me = this.client.myId;
    const st = this.client.pred.stats;
    if (res.fire) this.fxShot(s.x, s.y, s.aim, true, res.power);
    if (res.slash) this.fxSlash(me, s.x, s.y, s.aim, st.arc, st.reach, true);
    if (res.ability) {
      if (this.myChar() === 'knight') this.fxBash(me, s.x, s.y, s.aim, true);
      else this.fxSprint(s.x, s.y);
    }
    if (res.slide) this.fxSlide(me, s.x, s.y, true);
    if (res.trap && this.client.map) {
      const [x, y] = trapSpot(this.client.map, s.x, s.y, s.aim);
      this.fxTrapThrow(s.x, s.y, x, y);
      const img = this.add.image(x, y, 'trap').setOrigin(0.5, 1).setDepth(6).setAlpha(0.7);
      this.localTraps.push({ x, y, until: performance.now() + this.client.rtt + 400, img });
    }
  }

  private onParried(x: number, y: number, deflected: boolean) {
    this.fx.sparks(x, y, deflected ? 10 : 6, deflected ? 0xffffff : 0xffd23f, deflected ? 140 : 90);
    if (deflected) this.fx.ring(x, y, 8, 0xffffff);
    sfx.block();
    this.trauma = Math.min(1, this.trauma + 0.1);
  }

  private onImpact(x: number, y: number, what: 'wall' | 'enemy' | 'barrel', id: number) {
    if (what === 'enemy') {
      const v = this.enemies.get(id);
      if (v) v.flash = 0.06;
      this.fx.sparks(x, y, 4, 0xffffff, 70);
      sfx.hit();
    } else {
      this.fx.sparks(x, y, 4, 0xe8d8b0, 60);
      sfx.spark();
    }
  }

  private fxShot(x: number, y: number, a: number, local: boolean, power: number) {
    const bx = x + Math.cos(a) * 8;
    const by = y - 4 + Math.sin(a) * 8;
    this.fx.sparks(bx, by, 2 + Math.round(power * 4), 0xfff0c0, 60 + power * 80);
    if (power >= 1) this.fx.ring(bx, by, 5, 0xffffff);
    sfx.shot(local, power);
    if (local) {
      this.trauma = Math.min(1, this.trauma + 0.03 + power * 0.08);
      this.kickX -= Math.cos(a) * (1 + power * 2.5);
      this.kickY -= Math.sin(a) * (1 + power * 2.5);
    }
  }

  private fxSlash(pid: number, x: number, y: number, a: number, arc: number, reach: number, local: boolean) {
    const v = this.players.get(pid);
    if (v) {
      v.swingAt = performance.now();
      v.swingArc = arc;
      v.swingDir = -(v.swingDir ?? 1);
    }
    const g = this.add.graphics().setDepth(870);
    const cy = y - 3;
    const dir = v?.swingDir ?? 1;
    const from = a - arc * dir;
    const steps = 12;
    const inner = (t: number) => reach * (0.85 - 0.45 * t);
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const a0 = from + 2 * arc * dir * t0;
      const a1 = from + 2 * arc * dir * t1;
      g.fillStyle(0xffffff, 0.2 + 0.6 * t1);
      g.beginPath();
      g.moveTo(x + Math.cos(a0) * inner(t0), cy + Math.sin(a0) * inner(t0));
      g.lineTo(x + Math.cos(a0) * reach, cy + Math.sin(a0) * reach);
      g.lineTo(x + Math.cos(a1) * reach, cy + Math.sin(a1) * reach);
      g.lineTo(x + Math.cos(a1) * inner(t1), cy + Math.sin(a1) * inner(t1));
      g.closePath();
      g.fillPath();
    }
    g.lineStyle(1, 0xffd23f, 0.9).beginPath().arc(x, cy, reach + 1, a - arc, a + arc).strokePath();
    this.tweens.add({ targets: g, alpha: 0, duration: 160, ease: 'Quad.easeIn', onComplete: () => g.destroy() });
    sfx.slash(local);
    if (local) {
      this.kickX += Math.cos(a) * 2.5;
      this.kickY += Math.sin(a) * 2.5;
      this.trauma = Math.min(1, this.trauma + 0.08);
    }
  }

  private afterimages(pid: number, n: number, gap: number) {
    const v = this.players.get(pid);
    if (!v) return;
    const pl = this.client.latest?.players.find((p) => p.id === pid);
    const tint = hex(PLAYER_COLORS[pl?.c ?? 0]);
    for (let i = 0; i < n; i++)
      this.time.delayedCall(i * gap, () => {
        const g = this.add
          .image(v.x, v.y, v.spr.texture.key)
          .setOrigin(0.5, 0.8)
          .setFlipX(v.spr.flipX)
          .setRotation(v.spr.rotation)
          .setAlpha(0.45)
          .setTintFill(tint)
          .setDepth(9);
        this.tweens.add({ targets: g, alpha: 0, duration: 220, onComplete: () => g.destroy() });
      });
  }

  private fxBash(pid: number, x: number, y: number, a: number, local: boolean) {
    const v = this.players.get(pid);
    if (v) v.bashAt = performance.now();
    this.afterimages(pid, 4, 35);
    this.fx.smoke(x - Math.cos(a) * 4, y + 2, 6, 6, 0x6a6070);
    sfx.bash();
    if (local) {
      this.trauma = Math.min(1, this.trauma + 0.12);
      this.kickX += Math.cos(a) * 3;
      this.kickY += Math.sin(a) * 3;
    }
  }

  private fxSlide(pid: number, x: number, y: number, local: boolean) {
    this.afterimages(pid, 3, 45);
    this.fx.smoke(x, y + 2, 4, 5, 0x8a8090);
    sfx.slide();
    if (local) this.trauma = Math.min(1, this.trauma + 0.05);
  }

  private fxSprint(x: number, y: number) {
    this.fx.smoke(x, y + 2, 3, 4, 0x8a8090);
  }

  private fxTrapThrow(x0: number, y0: number, x: number, y: number) {
    const a = Math.atan2(y - y0, x - x0);
    const img = this.add.image(x0, y0 - 4, 'arrowshot').setRotation(a).setDepth(800);
    this.tweens.add({
      targets: img,
      x,
      y: y - 2,
      duration: 90,
      onComplete: () => {
        img.destroy();
        this.fx.sparks(x, y, 4, 0xc89050, 50);
        sfx.trap();
      },
    });
  }

  onEvent(e: GameEvent) {
    const me = this.client.myId;
    switch (e.e) {
      case 'shot':
        this.fxShot(e.x, e.y, e.a, false, e.pw);
        break;
      case 'slash':
        this.fxSlash(e.p, e.x, e.y, e.a, e.arc, e.reach, false);
        break;
      case 'bash':
        this.fxBash(e.p, e.x, e.y, e.a, false);
        break;
      case 'slide':
        this.fxSlide(e.p, e.x, e.y, false);
        break;
      case 'sprint':
        this.fxSprint(e.x, e.y);
        break;
      case 'trap':
        this.fxTrapThrow(e.x0, e.y0, e.x, e.y);
        break;
      case 'snare': {
        const v = this.enemies.get(e.id);
        const x = v?.x ?? e.x;
        const y = v?.y ?? e.y;
        this.fx.ring(x, y, 10, 0xc89050);
        this.fx.sparks(x, y, 10, 0xe8d8b0, 80);
        this.popText(x, y - 6, 'PINNED', '#e8d8b0');
        sfx.snare();
        break;
      }
      case 'block':
        this.fx.sparks(e.x, e.y - 3, e.broke ? 20 : 8, e.broke ? 0xff6a3a : 0xffd23f, e.broke ? 150 : 100);
        if (e.broke) {
          this.fx.ring(e.x, e.y - 3, 12, 0xff6a3a);
          this.popText(e.x, e.y - 10, 'GUARD BREAK', '#ff6a3a');
          sfx.guardBreak();
        } else sfx.block();
        if (e.p === me) this.trauma = Math.min(1, this.trauma + (e.broke ? 0.4 : 0.1));
        break;
      case 'shove':
        this.fx.sparks(e.x, e.y - 3, 10, 0xffffff, 120);
        this.fx.smoke(e.x, e.y, 4, 6, 0x8a8090);
        this.shakeAt(e.x, e.y, 0.2);
        sfx.slam();
        break;
      case 'eshot':
        sfx.eshot();
        break;
      case 'hit': {
        if (e.who === 'enemy') {
          const v = this.enemies.get(e.id);
          const x = v?.x ?? e.x;
          const y = v?.y ?? e.y;
          if (v) v.flash = 0.07;
          const kind = v?.kind ?? 'grunt';
          this.fx.blood(x, y, e.a, 7, 0.8, this.fx.palette(kind));
          this.popText(x, y - (kind === 'boss' ? 16 : 4), String(e.dmg), '#ffffff');
          if (e.by !== me) sfx.hit();
          this.shakeAt(x, y, 0.06);
        } else {
          const v = this.players.get(e.id);
          const x = v?.x ?? e.x;
          const y = v?.y ?? e.y;
          if (v) v.flash = 0.12;
          this.fx.blood(x, y, e.a, 12, 1);
          this.popText(x, y - 8, String(e.dmg), '#ff5a6e');
          if (e.id === me) {
            this.trauma = Math.min(1, this.trauma + 0.45);
            this.zoomPunch += 0.04;
            this.boot.hud.flash(0.3);
            sfx.hurt();
            this.hitstopUntil = performance.now() + 60;
          } else sfx.hit();
        }
        break;
      }
      case 'die': {
        const v = this.enemies.get(e.id);
        const x = v?.x ?? e.x;
        const y = v?.y ?? e.y;
        const pal = this.fx.palette(e.k);
        this.fx.blood(x, y, e.a, e.k === 'boss' ? 120 : 34, e.k === 'boss' ? 2 : 1.4, pal);
        this.fx.blood(x, y, e.a + Math.PI, 8, 0.6, pal);
        this.fx.pool(x + Math.cos(e.a) * 4, y + Math.sin(e.a) * 4, e.k === 'boss' ? 22 : e.k === 'brute' ? 11 : 8, pal);
        this.fx.corpse(e.k, x + Math.cos(e.a) * 3, y + Math.sin(e.a) * 3, e.a + Math.PI / 2 + (Math.random() - 0.5));
        if (e.k === 'archer') this.fx.sparks(x, y, 10, 0xe8e0c8, 90);
        this.shakeAt(x, y, e.k === 'boss' ? 1 : 0.28);
        this.zoomPunch += e.k === 'boss' ? 0.12 : 0.02;
        this.hitstopUntil = performance.now() + (e.k === 'boss' ? 400 : 45);
        sfx.die();
        if (v) {
          this.destroyView(v);
          this.enemies.delete(e.id);
        }
        this.client.deadIds.add(e.id);
        if (e.k === 'boss') {
          for (let i = 0; i < 6; i++)
            this.time.delayedCall(i * 140, () => {
              this.fx.explosion(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 40, 30);
              sfx.boom();
            });
          this.boot.hud.flash(0.5);
        }
        break;
      }
      case 'boom': {
        if (e.r === 0) {
          this.fx.ring(e.x, e.y, 40, 0xb05aff);
          this.fx.smoke(e.x, e.y, 20, 40, 0x5a2280);
          sfx.roar();
          break;
        }
        this.fx.explosion(e.x, e.y, e.r);
        const gl = this.add.image(e.x, e.y, 'glow').setDepth(870).setTint(0xffc060).setScale(e.r / 14).setBlendMode(Phaser.BlendModes.ADD);
        this.tweens.add({ targets: gl, alpha: 0, scale: e.r / 10, duration: 350, onComplete: () => gl.destroy() });
        this.shakeAt(e.x, e.y, 0.9);
        this.zoomPunch += 0.05;
        this.hitstopUntil = performance.now() + 70;
        sfx.boom();
        break;
      }
      case 'fall': {
        const src = e.who === 'player' ? this.players : this.enemies;
        const v = this.nearest(src, e.x, e.y, 14) ?? this.nearest(this.barrels, e.x, e.y, 14);
        if (v) {
          const ghost = this.add.image(e.x, e.y, v.spr.texture.key).setDepth(1.5).setOrigin(0.5);
          this.tweens.add({ targets: ghost, scale: 0, angle: 200, alpha: 0.2, duration: 500, ease: 'Quad.easeIn', onComplete: () => ghost.destroy() });
        }
        this.fx.smoke(e.x, e.y, 6, 8, 0x20182a);
        sfx.fall();
        break;
      }
      case 'pickup': {
        this.fx.sparks(e.x, e.y, 18, e.k === 'potion' ? 0xff3355 : 0xffd23f, 90);
        this.fx.ring(e.x, e.y, 14, 0xffd23f);
        const info = itemInfo(e.k, this.myChar());
        this.popText(e.x, e.y - 6, info.name, '#ffd23f');
        sfx.pickup();
        if (e.p === me) this.boot.hud.feed(`${info.name}: ${info.desc}`);
        break;
      }
      case 'level': {
        const v = this.players.get(e.p);
        if (v) {
          this.fx.ring(v.x, v.y, 22, 0xffd23f);
          this.fx.sparks(v.x, v.y, 24, 0xffd23f, 110);
          this.popText(v.x, v.y - 12, 'LEVEL UP', '#ffd23f');
        }
        if (e.p === me) sfx.level();
        break;
      }
      case 'burn':
        this.fx.embers(e.x, e.y, 6);
        sfx.burn();
        break;
      case 'spark':
        this.fx.sparks(e.x, e.y, 5, 0xffe066, 80);
        sfx.spark();
        break;
      case 'slam':
        this.fx.smoke(e.x, e.y, 10, 12, 0x6a6070);
        this.fx.sparks(e.x, e.y, 12, 0xffffff, 120);
        this.shakeAt(e.x, e.y, 0.4);
        sfx.slam();
        break;
      case 'down': {
        const v = this.players.get(e.p);
        if (v) this.fx.pool(v.x, v.y, 9);
        if (e.p === me) {
          this.boot.hud.flash(0.6);
          this.trauma = 1;
        }
        sfx.die();
        break;
      }
      case 'revive': {
        const v = this.players.get(e.p);
        if (v) {
          this.fx.ring(v.x, v.y, 24, 0x7dff8a);
          this.fx.sparks(v.x, v.y, 20, 0x7dff8a, 100);
        }
        sfx.level();
        break;
      }
      case 'deflect':
        this.fx.sparks(e.x, e.y, 12, 0xffffff, 140);
        this.fx.ring(e.x, e.y, 8, 0xffffff);
        sfx.spark();
        this.shakeAt(e.x, e.y, 0.15);
        break;
      case 'msg':
        if (e.big) this.boot.hud.banner(e.text);
        else this.boot.hud.feed(e.text);
        break;
      case 'boss':
        sfx.roar();
        this.boot.hud.flash(0.4);
        this.trauma = 1;
        break;
    }
  }

  update(_t: number, dtMs: number) {
    const dt = Math.min(0.05, dtMs / 1000);
    const now = performance.now();
    const c = this.client;
    const cam = this.cameras.main;
    const frozen = now < this.hitstopUntil;

    const pointer = this.input.activePointer;
    const wp = cam.getWorldPoint(pointer.x, pointer.y);
    const meView = this.players.get(c.myId);
    if (this.auto && this.bot) {
      this.aim = this.auto.aim;
      wp.x = this.bot.aimX;
      wp.y = this.bot.aimY;
    } else if (meView) this.aim = Math.atan2(wp.y - (meView.y - 3), wp.x - meView.x);

    c.update(now);
    const latest = c.latest;
    if (latest && latest !== this.lastLatest) {
      this.lastLatest = latest;
      this.onLatest(latest);
    }
    const view = c.sample();
    const myPos = c.myRenderPos();
    const bullets = c.renderBullets(now);
    if (view && !frozen) this.syncWorld(view, bullets, myPos, dt);
    if (this.bot && latest && myPos) {
      const meSnap = latest.players.find((p) => p.id === c.myId);
      const players = latest.players.map((p) => (p.id === c.myId ? { ...p, x: myPos[0], y: myPos[1] } : p));
      this.auto = meSnap ? this.bot.step({ ...latest, players, enemies: view?.enemies ?? latest.enemies, bullets }, c.myId, now, c.pred.state, c.pred.stats) : null;
      if (this.auto?.aPress) this.pressA = true;
      if (this.auto?.bPress) this.pressB = true;
      if (this.auto?.movePress) this.pressMove = true;
    }

    if (view && latest) this.drawEntities(view, latest, dt, this.aim);
    this.cross.setPosition(wp.x, wp.y);

    this.client.fog.see(this.eyes);
    this.fog.update(dt);

    const me = this.players.get(c.myId);
    const selfFocus = me
      ? { x: me.x + Phaser.Math.Clamp((wp.x - me.x) * 0.28, -70, 70), y: me.y + Phaser.Math.Clamp((wp.y - me.y) * 0.28, -50, 50) }
      : null;
    const bounds = { w: (this.map?.w ?? 0) * TILE, h: (this.map?.h ?? 0) * TILE };
    this.rig.update(dt, selfFocus, (id) => this.players.get(id) ?? null, bounds);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.zoomPunch *= Math.exp(-dt * 10);
    this.kickX *= Math.exp(-dt * 14);
    this.kickY *= Math.exp(-dt * 14);
    const sh = this.trauma * this.trauma * 7;
    cam.setZoom(this.baseZoom * (1 + this.zoomPunch));
    cam.centerOn(this.rig.x + this.kickX + (Math.random() * 2 - 1) * sh, this.rig.y + this.kickY + (Math.random() * 2 - 1) * sh);
    cam.setRotation(this.trauma * this.trauma * (Math.random() - 0.5) * 0.03);

    this.animateTiles(now);
    this.fx.update(dt);
    const ps = c.pred.state;
    if (ps) this.boot.hud.kit(ps, c.pred.stats, c.pred.char);
    this.drawIndicators(latest, me);
    this.updateCamTag(latest);
    this.boot.debug.update(now);
  }

  private updateCamTag(s: WorldView | null) {
    const m = this.rig.mode;
    const who = m.k === 'follow' ? s?.players.find((p) => p.id === m.id) : undefined;
    const key = m.k === 'follow' ? `f${m.id}${who?.name}` : m.k;
    if (key === this.camTagKey || !this.camTag) return;
    this.camTagKey = key;
    this.camTag.hidden = m.k === 'self';
    if (m.k === 'free') this.camTag.innerHTML = '<b>FREE CAMERA</b> <kbd>C</kbd> / middle-click to return';
    else if (m.k === 'follow' && who)
      this.camTag.innerHTML = `<b>WATCHING <span style="color:${PLAYER_COLORS[who.c]}">${who.name.replace(/[&<>"']/g, '')}</span></b> <kbd>Tab</kbd> next · <kbd>C</kbd> back to you`;
  }

  drawEntities(s: WorldView, latest: WorldView, dt: number, myAim: number) {
    const o = this.overlay;
    o.clear();
    const t = performance.now() / 1000;
    const myId = this.client.myId;
    const pred = this.client.pred.state;
    const now = performance.now();
    const st = this.client.pred.stats;
    for (const sp of s.players) {
      const v = this.players.get(sp.id);
      if (!v) continue;
      const mine = sp.id === myId;
      const p: PlayerSnap = mine ? latest.players.find((q) => q.id === myId) ?? sp : sp;
      const [wpn, name, shadow, shield] = v.extra as [Phaser.GameObjects.Image, Phaser.GameObjects.Text, Phaser.GameObjects.Ellipse, Phaser.GameObjects.Image];
      const ps = mine ? pred : null;
      const aim = mine ? myAim : p.aim;
      const down = ps ? ps.down : p.down;
      const mode = ps ? ps.mode : p.mode;
      const knight = v.kind === 'knight';
      const block = ps ? ps.block > 0 || (knight && ps.mode === MODE.bash) : p.block;
      const drawF = ps ? (knight ? 0 : Math.min(1, ps.draw / st.drawTicks)) : p.draw;
      const sliding = mode === MODE.slide || mode === MODE.skid;
      const sprinting = !knight && (mode === MODE.sprint || mode === MODE.coast);
      const bashing = knight && mode === MODE.bash;
      const moving = v.spd > 12;
      const bob = moving && !down && !sliding && !bashing ? Math.abs(Math.sin(t * (sprinting ? 22 : 16) + p.id)) : 0;
      const mvx = v.mvx ?? 0;
      const flip = sprinting || sliding ? mvx < -5 || (Math.abs(mvx) <= 5 && Math.cos(aim) < 0) : Math.cos(aim) < 0;
      const side = flip ? -1 : 1;
      const hop = bashing ? Math.sin(Math.min(1, (now - (v.bashAt ?? now)) / 233) * Math.PI) * 4 : 0;
      v.spr.setPosition(v.x, v.y - bob * 1.5 - hop);
      v.spr.setFlipX(flip);
      if (sliding) v.spr.setScale(1.12, 0.84);
      else v.spr.setScale(1 + bob * 0.06, 1 - bob * 0.08);
      let rot = moving ? Math.sin(t * 16 + p.id) * 0.08 : 0;
      if (down) rot = Math.PI / 2;
      else if (sliding) rot = -0.5 * side;
      else if (sprinting) rot = 0.2 * side;
      else if (bashing) rot = 0.28 * side;
      v.spr.setRotation(rot);
      const depth = 10 + v.y * 0.01;
      v.spr.setDepth(depth);
      v.flash -= dt;
      if (down) v.spr.setTint(0x6a6070);
      else if (v.flash > 0) v.spr.setTintFill(0xffffff);
      else v.spr.clearTint();
      v.spr.setAlpha(p.off ? 0.35 : p.inv && !down && Math.floor(t * 20) % 2 ? 0.45 : 1);
      wpn.setVisible(!down);
      const hx = v.x + Math.cos(aim) * 3;
      const hy = v.y - 4 - hop + Math.sin(aim) * 3;
      if (!knight) {
        if (sprinting) wpn.setPosition(v.x - side * 2, v.y - 6 - bob).setRotation(-Math.PI / 2 + side * 0.5);
        else wpn.setPosition(hx, hy).setRotation(aim);
        wpn.setDepth(depth + (Math.sin(aim) > 0 ? 0.001 : -0.001));
        if (drawF > 0 && !down && !sprinting) this.drawBowString(o, hx, hy, aim, drawF, t);
        if (mine && drawF >= 1 && !this.wasFull) sfx.fullDraw();
        if (mine) this.wasFull = drawF >= 1;
      } else {
        const sw = v.swingAt ? (now - v.swingAt) / 140 : 1;
        if (sw < 1) {
          const arc = v.swingArc ?? 1.2;
          const dir = v.swingDir ?? 1;
          const k = 1 - (1 - sw) * (1 - sw);
          const a = aim - arc * dir + 2 * arc * dir * k;
          wpn.setPosition(v.x + Math.cos(a) * 3, v.y - 4 - hop + Math.sin(a) * 3).setRotation(a);
        } else wpn.setPosition(v.x + side * 3, v.y - 3 - hop).setRotation(aim + side * 1.05);
        wpn.setFlipY(Math.cos(wpn.rotation) < 0);
        shield.setVisible(!down);
        if (block) {
          shield
            .setPosition(v.x + Math.cos(aim) * 6, v.y - 4 - hop + Math.sin(aim) * 4)
            .setScale(1)
            .setDepth(depth + (Math.sin(aim) > -0.4 ? 0.002 : -0.002));
          wpn.setDepth(depth - 0.001);
          o.lineStyle(1, hex(PLAYER_COLORS[p.c]), 0.5).beginPath().arc(v.x, v.y - 3, 11, aim - SHIELD_ARC, aim + SHIELD_ARC).strokePath();
        } else {
          shield.setPosition(v.x - side * 4, v.y - 4 - hop - bob).setScale(0.8).setDepth(depth - 0.002);
          wpn.setDepth(depth + 0.001);
        }
      }
      if (sliding && moving && Math.random() < 0.25) this.fx.smoke(v.x, v.y + 1, 1, 2, 0x8a8090);
      if (knight && mode === MODE.skid && Math.random() < 0.5) this.fx.sparks(v.x, v.y + 1, 1, 0xffe066, 50);
      if (sprinting && moving && Math.random() < 0.25) this.fx.smoke(v.x, v.y + 1, 1, 2, 0x6a6070);
      name.setPosition(v.x, v.y - 16).setVisible(!mine);
      shadow.setPosition(v.x, v.y + 1).setScale(sliding ? 1.3 : bashing ? 0.8 : 1, 1);
      if (!mine && !p.down) this.bar(o, v.x, v.y - 14, 14, p.hp / p.maxHp, 0xff3355);
      if (p.down) {
        o.lineStyle(2, 0x000000, 0.6).strokeCircle(v.x, v.y - 2, 10);
        o.lineStyle(2, 0x7dff8a, 1).beginPath().arc(v.x, v.y - 2, 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.rev).strokePath();
      }
    }
    for (const tr of s.traps) {
      const tv = this.traps.get(tr.id);
      if (!tv) continue;
      o.lineStyle(1, hex(PLAYER_COLORS[tr.c]), 0.35 + Math.sin(t * 5) * 0.15).strokeEllipse(tv.x, tv.y, 12, 6);
      tv.spr.setPosition(tv.x, tv.y).setDepth(6 + tv.y * 0.001);
    }
    for (const lt of this.localTraps) o.lineStyle(1, 0xffffff, 0.3).strokeEllipse(lt.x, lt.y, 12, 6);
    for (const e of s.enemies) {
      const v = this.enemies.get(e.id);
      if (!v) continue;
      const shadow = v.extra![0] as Phaser.GameObjects.Ellipse;
      let x = v.x;
      let y = v.y;
      let rot = 0;
      let sx = 1;
      let sy = 1;
      if (e.s === 1) {
        x += (Math.random() - 0.5) * 2;
        sx = 1.1;
        sy = 0.9;
      } else if (e.s === 2) {
        rot = Math.cos(e.a) >= 0 ? 0.25 : -0.25;
        sx = 1.15;
        sy = 0.9;
      } else if (e.s === 3) rot = Math.sin(t * 30) * 0.25;
      else if (v.spd > 8) y -= Math.abs(Math.sin(t * 12 + e.id)) * 1.5;
      if (e.k === 'boss') y -= Math.sin(t * 3) * 2;
      v.spr.setPosition(x, y).setRotation(rot).setScale(sx, sy).setFlipX(Math.cos(e.a) < 0).setDepth(10 + v.y * 0.01);
      v.flash -= dt;
      if (v.flash > 0) v.spr.setTintFill(0xffffff);
      else if (e.s === 1 && Math.floor(t * 20) % 2) v.spr.setTint(0xff6060);
      else v.spr.clearTint();
      const fa = this.fogAlpha(v, dt);
      v.spr.setAlpha(fa).setVisible(fa > 0);
      shadow.setPosition(v.x, v.y + 1).setAlpha(fa);
      if (e.hp < e.maxHp && e.k !== 'boss' && fa > 0) this.bar(o, v.x, v.y - (e.k === 'brute' ? 16 : 13), 12, e.hp / e.maxHp, 0xff3355, fa);
      if (e.rooted && fa > 0) {
        o.lineStyle(1, 0xc89050, 0.9 * fa).strokeEllipse(v.x, v.y + 1, ENEMY_R[e.k] * 2 + 6, 6);
        o.lineStyle(1, 0xe8d8b0, 0.6 * fa).strokeEllipse(v.x, v.y + 1, ENEMY_R[e.k] * 2 + 2, 4);
      }
    }
    for (const v of this.enemies.values())
      if (v.gone) {
        const fa = this.fogAlpha(v, dt) * Math.max(0, 1 - v.gone / LINGER);
        v.spr.setAlpha(fa);
        (v.extra![0] as Phaser.GameObjects.Ellipse).setAlpha(fa);
      }
    for (const v of this.bullets.values()) {
      const fa = v.kind === 'eb' ? this.fogAlpha(v, dt) : 1;
      v.spr.setPosition(v.x, v.y - 3).setRotation(Math.atan2(v.vy ?? 0, v.vx ?? 1)).setAlpha(fa);
      (v.extra![0] as Phaser.GameObjects.Image).setPosition(v.x, v.y - 3).setAlpha(0.8 * fa);
    }
    for (const v of this.barrels.values()) v.spr.setPosition(v.x, v.y).setDepth(10 + v.y * 0.01).setAlpha(this.fogAlpha(v, dt, true));
    for (const v of this.items.values()) {
      const yy = v.ghost ? v.y - 3 : v.y - 3 - Math.sin(t * 4 + v.x) * 2;
      const fa = this.fogAlpha(v, dt, true);
      v.spr.setPosition(v.x, yy).setAlpha(fa);
      (v.extra![0] as Phaser.GameObjects.Image).setPosition(v.x, yy).setAlpha((0.4 + Math.sin(t * 5) * 0.2) * fa);
    }
    const dbg = this.boot.debug;
    const ss = this.client.pred.serverState;
    if (dbg.shown && dbg.ghost && ss) {
      o.lineStyle(1, 0xffffff, 0.7).strokeCircle(ss.x, ss.y - 3, 6);
      o.lineStyle(1, 0xffffff, 0.35).lineBetween(ss.x - 3, ss.y - 3, ss.x + 3, ss.y - 3);
    }
  }

  /** Bowstring pulled back by the draw fraction, with the nocked arrow; glints at full draw. */
  drawBowString(o: Phaser.GameObjects.Graphics, hx: number, hy: number, aim: number, f: number, t: number) {
    const c = Math.cos(aim);
    const sn = Math.sin(aim);
    const at = (fx: number, fy: number): [number, number] => [hx + c * fx - sn * fy, hy + sn * fx + c * fy];
    const [t1x, t1y] = at(-1.5, -5);
    const [t2x, t2y] = at(-1.5, 5);
    const [px, py] = at(-1.5 - f * 4.5, 0);
    o.lineStyle(0.5, 0xe8e0c8, 1).lineBetween(t1x, t1y, px, py).lineBetween(t2x, t2y, px, py);
    const [ax, ay] = at(5.5 - f * 4.5, 0);
    o.lineStyle(0.8, 0xc89050, 1).lineBetween(px, py, ax, ay);
    o.fillStyle(f >= 1 && Math.floor(t * 12) % 2 ? 0xffffff : 0xdfe4f0, 1).fillRect(ax - 0.6, ay - 0.6, 1.4, 1.4);
    if (f >= 1) o.fillStyle(0xffffff, 0.35 + Math.sin(t * 20) * 0.2).fillCircle(ax, ay, 2.2);
  }

  bar(o: Phaser.GameObjects.Graphics, x: number, y: number, w: number, f: number, c: number, alpha = 1) {
    o.fillStyle(0x000000, 0.8 * alpha).fillRect(Math.round(x - w / 2) - 1, Math.round(y) - 1, w + 2, 4);
    o.fillStyle(c, alpha).fillRect(Math.round(x - w / 2), Math.round(y), Math.max(0, Math.round(w * f)), 2);
  }

  animateTiles(now: number) {
    const tick = Math.floor(this.client.predTick());
    if (Number.isFinite(tick))
      for (const sp of this.spikes) {
        const st = spikeState(tick, sp.tx, sp.ty);
        if (st !== sp.st) {
          sp.st = st;
          sp.img.setTexture(`spk${st}`);
          if (st === 2 && Math.random() < 0.3) this.fx.sparks(sp.tx * TILE + 8, sp.ty * TILE + 8, 2, 0xd8d8e8, 40);
        }
      }
    const lf = Math.floor(now / 260);
    if (lf !== this.lavaFrame) {
      this.lavaFrame = lf;
      for (const l of this.lava) l.img.setTexture(`lava${(lf + l.tx * 2 + l.ty) % 3}`);
    }
    const tt = now / 1000;
    for (let i = 0; i < this.lavaGlows.length; i++) this.lavaGlows[i].setAlpha(0.28 + Math.sin(tt * 3 + i) * 0.08);
    if (this.lava.length && Math.random() < 0.25) {
      const l = this.lava[(Math.random() * this.lava.length) | 0];
      this.fx.embers(l.tx * TILE + 8, l.ty * TILE + 8, 1);
    }
    if (this.stairsGlow?.visible) this.stairsGlow.setAlpha(0.5 + Math.sin(tt * 4) * 0.25);
  }

  drawIndicators(s: WorldView | null, meView: View | undefined) {
    const targets: { x: number; y: number; c: number }[] = [];
    if (s && meView) {
      if (s.stairs) targets.push({ ...this.stairsPos, c: 0xffd23f });
      if (this.rig.mode.k !== 'self') targets.push({ x: meView.x, y: meView.y, c: 0xffffff });
      for (const p of s.players) if (p.id !== this.client.myId) targets.push({ x: p.x, y: p.y, c: hex(PLAYER_COLORS[p.c]) });
      if (!s.stairs && s.enemies.length <= 3)
        for (const e of s.enemies) if (this.client.fog.visibleAt(e.x, e.y)) targets.push({ x: e.x, y: e.y, c: 0xff3355 });
    }
    const view = this.cameras.main.worldView;
    let i = 0;
    for (const tg of targets) {
      if (view.contains(tg.x, tg.y) || !meView) continue;
      const cx = view.centerX;
      const cy = view.centerY;
      const a = Math.atan2(tg.y - cy, tg.x - cx);
      const m = 10 / this.baseZoom + 6;
      const hw = view.width / 2 - m;
      const hh = view.height / 2 - m;
      const k = Math.min(hw / Math.abs(Math.cos(a) || 1e-6), hh / Math.abs(Math.sin(a) || 1e-6));
      const arrow = this.arrows[i] ?? (this.arrows[i] = this.add.image(0, 0, 'arrow').setDepth(990));
      arrow
        .setVisible(true)
        .setPosition(cx + Math.cos(a) * k, cy + Math.sin(a) * k)
        .setRotation(a + Math.PI / 2)
        .setTint(tg.c);
      i++;
    }
    for (; i < this.arrows.length; i++) this.arrows[i].setVisible(false);
  }
}
