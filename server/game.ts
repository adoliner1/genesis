import type { WebSocket } from 'ws';
import {
  FLOORS,
  MAX_PLAYERS,
  T,
  TICK_RATE,
  TILE,
  spikeState,
  type ClientMsg,
  type EnemyKind,
  type FloorMsg,
  type GameEvent,
  type ItemKind,
  type Phase,
  type ServerMsg,
  type SnapMsg,
  type StatKind,
} from '../shared/protocol.ts';
import { generateFloor, type FloorData } from './dungeon.ts';

const DT = 1 / TICK_RATE;
const PLAYER_R = 5;
const START_FLOOR = Math.min(FLOORS, Math.max(1, Number(process.env.START_FLOOR) || 1));
const STATS: StatKind[] = ['vit', 'pow', 'rof', 'spd', 'dash', 'kick'];

interface Player {
  id: number;
  name: string;
  c: number;
  ws: WebSocket;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  mx: number;
  my: number;
  shoot: boolean;
  wantDash: boolean;
  wantKick: boolean;
  hp: number;
  maxHp: number;
  dmg: number;
  fireCd: number;
  fireT: number;
  speed: number;
  dashCd: number;
  dashT: number;
  dashing: number;
  kickT: number;
  kickMult: number;
  kickDmg: number;
  invuln: number;
  stagger: number;
  hazT: number;
  lvl: number;
  xp: number;
  xpNext: number;
  pending: StatKind[][];
  items: ItemKind[];
  multishot: number;
  bounce: number;
  knock: number;
  lifesteal: number;
  pierce: number;
  bulletR: number;
  down: boolean;
  rev: number;
  safeX: number;
  safeY: number;
  kills: number;
}

interface Enemy {
  id: number;
  k: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hp: number;
  maxHp: number;
  mass: number;
  speed: number;
  a: number;
  s: number;
  timer: number;
  cd: number;
  atkT: number;
  stagger: number;
  invuln: number;
  hazT: number;
  aggro: boolean;
  dirX: number;
  dirY: number;
  pattern: number;
  reps: number;
  phase2: boolean;
}

interface Bullet {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  enemy: boolean;
  pid: number;
  dmg: number;
  knock: number;
  life: number;
  bounce: number;
  pierce: number;
  r: number;
  hit: Set<number>;
}

interface Barrel {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
  kicker: number;
}

interface Item {
  id: number;
  x: number;
  y: number;
  k: ItemKind;
}

const ENEMY_DEFS: Record<EnemyKind, { hp: number; r: number; mass: number; speed: number; xp: number }> = {
  grunt: { hp: 30, r: 6, mass: 1, speed: 58, xp: 6 },
  archer: { hp: 22, r: 5, mass: 0.9, speed: 48, xp: 8 },
  brute: { hp: 70, r: 8, mass: 2.4, speed: 40, xp: 14 },
  boss: { hp: 2200, r: 14, mass: 12, speed: 42, xp: 0 },
};

const len = (x: number, y: number) => Math.hypot(x, y);
const r1 = (v: number) => Math.round(v * 10) / 10;
const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export class Room {
  code: string;
  players = new Map<number, Player>();
  enemies: Enemy[] = [];
  bullets: Bullet[] = [];
  barrels: Barrel[] = [];
  items: Item[] = [];
  events: GameEvent[] = [];
  tick = 0;
  phase: Phase = 'play';
  floor = 1;
  map!: FloorData;
  stairsOpen = false;
  flow = new Int32Array(0);
  nextId = 1;
  winTimer = -1;
  floorMsg!: FloorMsg;
  runSeed = (Math.random() * 1e9) | 0;

  constructor(code: string) {
    this.code = code;
    this.loadFloor(START_FLOOR);
  }

  get empty() {
    return this.players.size === 0;
  }

  addPlayer(ws: WebSocket, name: string): Player | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const used = new Set([...this.players.values()].map((p) => p.c));
    let c = 0;
    while (used.has(c)) c++;
    const p = this.newPlayer(ws, name, c);
    const anchor = [...this.players.values()].find((o) => !o.down);
    const sx = anchor ? anchor.x : this.map.spawn.x;
    const sy = anchor ? anchor.y : this.map.spawn.y;
    p.x = p.safeX = sx + (c % 2 ? 8 : -8);
    p.y = p.safeY = sy + (c > 1 ? 8 : 0);
    const partyLvl = Math.max(0, ...[...this.players.values()].map((o) => o.lvl));
    const target = Math.max(partyLvl, 1 + (this.floor - 1) * 2);
    while (p.lvl < target) this.gainXp(p, p.xpNext - p.xp);
    const passives: ItemKind[] = ['twin', 'bounce', 'heavy', 'fang', 'boots', 'pierce'];
    for (let i = 0; i < (this.floor - 1) * 2; i++) this.applyItem(p, passives[Math.floor(Math.random() * passives.length)]);
    this.players.set(p.id, p);
    for (const e of this.enemies)
      if (e.k === 'boss' && e.hp === e.maxHp) e.hp = e.maxHp = Math.round(ENEMY_DEFS.boss.hp * (0.6 + 0.4 * this.players.size));
    this.send(p, { t: 'joined', code: this.code, id: p.id });
    this.send(p, this.floorMsg);
    this.events.push({ e: 'msg', text: `${p.name} joined the party` });
    return p;
  }

  removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.events.push({ e: 'msg', text: `${p.name} left` });
    this.checkWipe();
  }

  private newPlayer(ws: WebSocket, name: string, c: number): Player {
    return {
      id: this.nextId++,
      name: name.slice(0, 14) || 'Crawler',
      c,
      ws,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aim: 0,
      mx: 0,
      my: 0,
      shoot: false,
      wantDash: false,
      wantKick: false,
      hp: 100,
      maxHp: 100,
      dmg: 10,
      fireCd: 7,
      fireT: 0,
      speed: 92,
      dashCd: 36,
      dashT: 0,
      dashing: 0,
      kickT: 0,
      kickMult: 1,
      kickDmg: 6,
      invuln: 30,
      stagger: 0,
      hazT: 0,
      lvl: 1,
      xp: 0,
      xpNext: 25,
      pending: [],
      items: [],
      multishot: 1,
      bounce: 0,
      knock: 1,
      lifesteal: 0,
      pierce: 0,
      bulletR: 2,
      down: false,
      rev: 0,
      safeX: 0,
      safeY: 0,
      kills: 0,
    };
  }

  handle(p: Player, msg: ClientMsg) {
    switch (msg.t) {
      case 'input': {
        const m = len(msg.mx, msg.my);
        p.mx = m > 1 ? msg.mx / m : msg.mx || 0;
        p.my = m > 1 ? msg.my / m : msg.my || 0;
        if (Number.isFinite(msg.aim)) p.aim = msg.aim;
        p.shoot = !!msg.shoot;
        if (msg.dash) p.wantDash = true;
        if (msg.kick) p.wantKick = true;
        break;
      }
      case 'choose': {
        const set = p.pending[0];
        if (!set) break;
        const s = set[msg.idx];
        if (!s) break;
        p.pending.shift();
        this.applyStat(p, s);
        break;
      }
      case 'restart':
        if (this.phase !== 'play') this.restartRun();
        break;
    }
  }

  private restartRun() {
    this.runSeed = (Math.random() * 1e9) | 0;
    for (const [id, old] of this.players) {
      const p = this.newPlayer(old.ws, old.name, old.c);
      p.id = id;
      this.players.set(id, p);
    }
    this.phase = 'play';
    this.winTimer = -1;
    this.loadFloor(1);
  }

  private loadFloor(n: number) {
    this.floor = n;
    const boss = n === FLOORS;
    this.map = generateFloor(n, this.runSeed + n * 7919, boss);
    this.enemies = [];
    this.bullets = [];
    this.items = [];
    this.barrels = [];
    this.stairsOpen = false;
    for (const e of this.map.enemies) this.spawnEnemy(e.k, e.x, e.y, false);
    for (const b of this.map.barrels) this.barrels.push({ id: this.nextId++, ...b, vx: 0, vy: 0, fuse: -1, kicker: 0 });
    for (const it of this.map.items) this.items.push({ id: this.nextId++, ...it });
    let i = 0;
    for (const p of this.players.values()) {
      p.x = p.safeX = this.map.spawn.x + ((i % 2) * 2 - 1) * 8;
      p.y = p.safeY = this.map.spawn.y + (i > 1 ? 10 : 0);
      p.vx = p.vy = 0;
      p.invuln = 45;
      if (p.down) {
        p.down = false;
        p.hp = Math.ceil(p.maxHp * 0.3);
      } else if (n > 1) p.hp = Math.min(p.maxHp, p.hp + 20);
      i++;
    }
    this.floorMsg = {
      t: 'floor',
      floor: n,
      boss,
      w: this.map.w,
      h: this.map.h,
      tiles: Array.from(this.map.tiles).join(''),
      seed: this.runSeed + n,
    };
    this.broadcast(this.floorMsg);
    this.events.push({ e: 'msg', text: boss ? "THE WARDEN'S CRYPT" : `FLOOR ${n}`, big: true });
    this.computeFlow();
  }

  private spawnEnemy(k: EnemyKind, x: number, y: number, aggro: boolean) {
    const d = ENEMY_DEFS[k];
    const scale = k === 'boss' ? 0.6 + 0.4 * Math.max(1, this.players.size) : 1 + (this.floor - 1) * 0.15;
    const hp = Math.round(d.hp * scale);
    this.enemies.push({
      id: this.nextId++,
      k,
      x,
      y,
      vx: 0,
      vy: 0,
      r: d.r,
      hp,
      maxHp: hp,
      mass: d.mass,
      speed: d.speed,
      a: 0,
      s: 0,
      timer: 0,
      cd: 30 + Math.random() * 40,
      atkT: 0,
      stagger: 0,
      invuln: 0,
      hazT: 0,
      aggro: aggro || k === 'boss',
      dirX: 0,
      dirY: 0,
      pattern: 0,
      reps: 0,
      phase2: false,
    });
  }

  // ---------- map helpers ----------
  tileAt(px: number, py: number): number {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return T.Wall;
    return this.map.tiles[ty * this.map.w + tx];
  }

  solid(px: number, py: number) {
    return this.tileAt(px, py) === T.Wall;
  }

  collides(x: number, y: number, r: number) {
    const steps = Math.max(1, Math.ceil((r * 2) / 8));
    for (let i = 0; i <= steps; i++) {
      const o = -r + (2 * r * i) / steps;
      if (this.solid(x + o, y - r) || this.solid(x + o, y + r) || this.solid(x - r, y + o) || this.solid(x + r, y + o))
        return true;
    }
    return false;
  }

  /** Moves with axis-separated tile collision, returns impact speed if a wall was hit. */
  move(o: { x: number; y: number; vx: number; vy: number }, r: number, bounce = 0): number {
    let impact = 0;
    const nx = o.x + o.vx * DT;
    if (this.collides(nx, o.y, r)) {
      impact = Math.max(impact, Math.abs(o.vx));
      o.vx = -o.vx * bounce;
    } else o.x = nx;
    const ny = o.y + o.vy * DT;
    if (this.collides(o.x, ny, r)) {
      impact = Math.max(impact, Math.abs(o.vy));
      o.vy = -o.vy * bounce;
    } else o.y = ny;
    return impact;
  }

  los(x0: number, y0: number, x1: number, y1: number) {
    const d = len(x1 - x0, y1 - y0);
    const n = Math.ceil(d / 6);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.solid(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  private passable(i: number) {
    const t = this.map.tiles[i];
    return t === T.Floor || t === T.Stairs || t === T.Spikes;
  }

  private computeFlow() {
    const { w, h } = this.map;
    if (this.flow.length !== w * h) this.flow = new Int32Array(w * h);
    this.flow.fill(-1);
    const q: number[] = [];
    for (const p of this.players.values()) {
      if (p.down) continue;
      const i = Math.floor(p.y / TILE) * w + Math.floor(p.x / TILE);
      if (i >= 0 && i < w * h && this.flow[i] < 0) {
        this.flow[i] = 0;
        q.push(i);
      }
    }
    for (let hd = 0; hd < q.length; hd++) {
      const i = q[hd];
      const x = i % w;
      const y = (i / w) | 0;
      const d = this.flow[i] + 1;
      if (x > 0 && this.flow[i - 1] < 0 && this.passable(i - 1)) (this.flow[i - 1] = d), q.push(i - 1);
      if (x < w - 1 && this.flow[i + 1] < 0 && this.passable(i + 1)) (this.flow[i + 1] = d), q.push(i + 1);
      if (y > 0 && this.flow[i - w] < 0 && this.passable(i - w)) (this.flow[i - w] = d), q.push(i - w);
      if (y < h - 1 && this.flow[i + w] < 0 && this.passable(i + w)) (this.flow[i + w] = d), q.push(i + w);
    }
  }

  private steer(e: Enemy, target: Player): [number, number] {
    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const d = len(dx, dy) || 1;
    if (d < 40 && this.los(e.x, e.y, target.x, target.y)) return [dx / d, dy / d];
    const { w } = this.map;
    const tx = Math.floor(e.x / TILE);
    const ty = Math.floor(e.y / TILE);
    const here = this.flow[ty * w + tx];
    let best = here < 0 ? 1e9 : here;
    let bx = 0;
    let by = 0;
    let found = false;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = tx + ox;
        const ny = ty + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= this.map.h) continue;
        if (ox && oy && (this.flow[ty * w + nx] < 0 || this.flow[ny * w + tx] < 0)) continue;
        const v = this.flow[ny * w + nx];
        if (v >= 0 && v < best) {
          best = v;
          bx = (nx + 0.5) * TILE - e.x;
          by = (ny + 0.5) * TILE - e.y;
          found = true;
        }
      }
    if (!found) return [dx / d, dy / d];
    const bl = len(bx, by) || 1;
    return [bx / bl, by / bl];
  }

  // ---------- combat helpers ----------
  private damageEnemy(e: Enemy, dmg: number, dx: number, dy: number, knock: number, pid: number, stagger = 5) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    const kf = knock / e.mass;
    e.vx += dx * kf;
    e.vy += dy * kf;
    if (e.k !== 'boss' || kf > 60) e.stagger = Math.max(e.stagger, stagger);
    e.aggro = true;
    this.events.push({ e: 'hit', x: r1(e.x), y: r1(e.y), a: r1(Math.atan2(dy, dx)), who: 'enemy', id: e.id, dmg: Math.round(dmg) });
    if (e.hp <= 0) this.killEnemy(e, pid, Math.atan2(dy, dx));
    else if (e.k === 'boss' && !e.phase2 && e.hp < e.maxHp / 2) {
      e.phase2 = true;
      e.speed *= 1.3;
      this.events.push({ e: 'boss', phase: 2 });
      this.events.push({ e: 'msg', text: 'The Warden is enraged!', big: false });
    }
  }

  private killEnemy(e: Enemy, pid: number, a: number, fell = false) {
    e.hp = 0;
    if (!fell) this.events.push({ e: 'die', x: r1(e.x), y: r1(e.y), k: e.k, a: r1(a) });
    const killer = this.players.get(pid);
    if (killer) {
      killer.kills++;
      if (killer.lifesteal && !killer.down) killer.hp = Math.min(killer.maxHp, killer.hp + killer.lifesteal);
    }
    const xp = ENEMY_DEFS[e.k].xp;
    for (const p of this.players.values()) this.gainXp(p, xp);
    if (e.k !== 'boss' && Math.random() < 0.07) this.items.push({ id: this.nextId++, x: e.x, y: e.y, k: 'potion' });
    if (e.k === 'boss') {
      this.winTimer = TICK_RATE * 3;
      for (const o of this.enemies) if (o !== e) o.hp = 0;
      this.events.push({ e: 'msg', text: 'THE WARDEN FALLS', big: true });
    }
  }

  private damagePlayer(p: Player, dmg: number, dx: number, dy: number, knock: number, ignoreDash = false) {
    if (p.down || p.invuln > 0 || (p.dashing > 0 && !ignoreDash) || this.phase !== 'play') return;
    p.hp -= dmg;
    p.invuln = 16;
    p.vx += dx * knock;
    p.vy += dy * knock;
    p.stagger = 6;
    this.events.push({ e: 'hit', x: r1(p.x), y: r1(p.y), a: r1(Math.atan2(dy, dx)), who: 'player', id: p.id, dmg: Math.round(dmg) });
    if (p.hp <= 0) this.downPlayer(p);
  }

  private downPlayer(p: Player) {
    p.hp = 0;
    p.down = true;
    p.rev = 0;
    p.shoot = false;
    this.events.push({ e: 'down', p: p.id });
    this.events.push({ e: 'msg', text: `${p.name} is down!` });
    this.checkWipe();
  }

  private checkWipe() {
    if (this.phase !== 'play' || this.players.size === 0) return;
    if ([...this.players.values()].every((p) => p.down)) {
      this.phase = 'over';
      this.events.push({ e: 'msg', text: 'THE PARTY HAS FALLEN', big: true });
    }
  }

  private gainXp(p: Player, xp: number) {
    p.xp += xp;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.lvl++;
      p.xpNext = Math.floor(p.xpNext * 1.25 + 8);
      const pool = [...STATS];
      const choice: StatKind[] = [];
      for (let i = 0; i < 3; i++) choice.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      p.pending.push(choice);
      this.events.push({ e: 'level', p: p.id, lvl: p.lvl });
    }
  }

  private applyStat(p: Player, s: StatKind) {
    switch (s) {
      case 'vit':
        p.maxHp += 25;
        if (!p.down) p.hp = Math.min(p.maxHp, p.hp + 25);
        break;
      case 'pow':
        p.dmg *= 1.3;
        break;
      case 'rof':
        p.fireCd /= 1.2;
        break;
      case 'spd':
        p.speed *= 1.12;
        break;
      case 'dash':
        p.dashCd *= 0.75;
        break;
      case 'kick':
        p.kickMult *= 1.5;
        p.kickDmg *= 2;
        break;
    }
  }

  private applyItem(p: Player, k: ItemKind) {
    switch (k) {
      case 'potion':
        p.hp = Math.min(p.maxHp, p.hp + 40);
        return;
      case 'twin':
        p.multishot++;
        break;
      case 'bounce':
        p.bounce += 2;
        break;
      case 'heavy':
        p.knock *= 1.5;
        p.dmg *= 1.2;
        p.bulletR += 1;
        break;
      case 'fang':
        p.lifesteal += 4;
        break;
      case 'boots':
        p.speed *= 1.15;
        p.dashCd *= 0.8;
        break;
      case 'pierce':
        p.pierce++;
        break;
    }
    p.items.push(k);
  }

  private explode(x: number, y: number, pid: number) {
    const R = 46;
    this.events.push({ e: 'boom', x: r1(x), y: r1(y), r: R });
    for (const e of this.enemies) {
      const dx = e.x - x;
      const dy = e.y - y;
      const d = len(dx, dy);
      if (d > R + e.r) continue;
      const f = 1 - Math.min(1, d / (R + e.r)) * 0.6;
      const n = d || 1;
      this.damageEnemy(e, 50 * f, dx / n, dy / n, 420 * f, pid, 14);
    }
    for (const p of this.players.values()) {
      const dx = p.x - x;
      const dy = p.y - y;
      const d = len(dx, dy);
      if (d > R) continue;
      const f = 1 - (d / R) * 0.6;
      const n = d || 1;
      this.damagePlayer(p, 22 * f, dx / n, dy / n, 260 * f);
    }
    for (const b of this.barrels) {
      const dx = b.x - x;
      const dy = b.y - y;
      const d = len(dx, dy);
      if (d > R + 8 || b.fuse >= 0) continue;
      b.fuse = 5 + ((Math.random() * 4) | 0);
      b.kicker = pid;
      const n = d || 1;
      b.vx += (dx / n) * 120;
      b.vy += (dy / n) * 120;
    }
    this.bullets = this.bullets.filter((b) => !b.enemy || len(b.x - x, b.y - y) > R);
  }

  private fire(p: Player) {
    const n = p.multishot;
    const spread = 0.12;
    for (let i = 0; i < n; i++) {
      const a = p.aim + (i - (n - 1) / 2) * spread + (Math.random() - 0.5) * 0.05;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      this.bullets.push({
        id: this.nextId++,
        x: p.x + Math.cos(p.aim) * 7,
        y: p.y + Math.sin(p.aim) * 7,
        vx: cx * 330,
        vy: cy * 330,
        enemy: false,
        pid: p.id,
        dmg: p.dmg,
        knock: 110 * p.knock,
        life: 40,
        bounce: p.bounce,
        pierce: p.pierce,
        r: p.bulletR,
        hit: new Set(),
      });
    }
    p.vx -= Math.cos(p.aim) * 22;
    p.vy -= Math.sin(p.aim) * 22;
    this.events.push({ e: 'shot', x: r1(p.x), y: r1(p.y), a: r1(p.aim), p: p.id });
  }

  private enemyShoot(e: Enemy, a: number, speed = 125, dmg = 9) {
    this.bullets.push({
      id: this.nextId++,
      x: e.x + Math.cos(a) * (e.r + 2),
      y: e.y + Math.sin(a) * (e.r + 2),
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      enemy: true,
      pid: 0,
      dmg,
      knock: 130,
      life: 110,
      bounce: 0,
      pierce: 0,
      r: 3,
      hit: new Set(),
    });
  }

  private kick(p: Player) {
    const a = p.aim;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    this.events.push({ e: 'kick', x: r1(p.x + cx * 8), y: r1(p.y + cy * 8), a: r1(a), p: p.id });
    const inCone = (x: number, y: number, range: number) => {
      const dx = x - p.x;
      const dy = y - p.y;
      const d = len(dx, dy);
      return d < range && (d < 6 || angDiff(Math.atan2(dy, dx), a) < 0.95);
    };
    for (const e of this.enemies)
      if (inCone(e.x, e.y, 20 + e.r)) this.damageEnemy(e, p.kickDmg, cx, cy, 380 * p.kickMult, p.id, 22);
    for (const b of this.barrels)
      if (inCone(b.x, b.y, 26)) {
        b.vx = cx * 320 * p.kickMult;
        b.vy = cy * 320 * p.kickMult;
        b.kicker = p.id;
      }
    for (const b of this.bullets)
      if (b.enemy && inCone(b.x, b.y, 28)) {
        b.enemy = false;
        b.pid = p.id;
        b.dmg = 18;
        b.knock = 160;
        b.life = 60;
        const sp = len(b.vx, b.vy) * 1.6;
        b.vx = cx * sp;
        b.vy = cy * sp;
        this.events.push({ e: 'deflect', x: r1(b.x), y: r1(b.y) });
      }
  }

  private nearestPlayer(x: number, y: number): [Player | null, number] {
    let best: Player | null = null;
    let bd = 1e9;
    for (const p of this.players.values()) {
      if (p.down) continue;
      const d = len(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return [best, bd];
  }

  // ---------- simulation ----------
  step() {
    this.tick++;
    if (this.phase === 'play') {
      if (this.tick % 8 === 0) this.computeFlow();
      this.updatePlayers();
      this.updateEnemies();
      this.updateBullets();
      this.updateBarrels();
      this.separate();
      this.updateItems();
      this.updateRevives();
      this.enemies = this.enemies.filter((e) => e.hp > 0);
      if (!this.map.boss && !this.stairsOpen && this.enemies.length === 0) {
        this.stairsOpen = true;
        this.events.push({ e: 'msg', text: 'The stairs down are open!' });
      }
      if (this.winTimer > 0 && --this.winTimer === 0) this.phase = 'win';
    }
    const snap: SnapMsg = {
      t: 'snap',
      tick: this.tick,
      phase: this.phase,
      floor: this.floor,
      left: this.enemies.length,
      stairs: this.stairsOpen,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        c: p.c,
        x: r1(p.x),
        y: r1(p.y),
        aim: r1(p.aim),
        hp: Math.ceil(p.hp),
        maxHp: p.maxHp,
        lvl: p.lvl,
        xp: p.xp,
        xpNext: p.xpNext,
        down: p.down,
        rev: r1(p.rev),
        dash: p.dashing > 0,
        inv: p.invuln > 0,
        items: p.items,
        choices: p.pending[0] ?? null,
        pending: p.pending.length,
        kills: p.kills,
        dashCd: r1(Math.max(0, p.dashT) / p.dashCd),
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id,
        k: e.k,
        x: r1(e.x),
        y: r1(e.y),
        hp: Math.ceil(e.hp),
        maxHp: e.maxHp,
        a: r1(e.a),
        s: e.stagger > 0 && e.k !== 'boss' ? 3 : e.s,
      })),
      bullets: this.bullets.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy), e: b.enemy, r: b.r })),
      barrels: this.barrels.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y) })),
      items: this.items.map((i) => ({ id: i.id, x: r1(i.x), y: r1(i.y), k: i.k })),
      events: this.events,
    };
    this.broadcast(snap);
    this.events = [];
  }

  private updatePlayers() {
    for (const p of this.players.values()) {
      p.invuln--;
      p.stagger--;
      p.hazT--;
      if (p.down) {
        p.vx *= 0.8;
        p.vy *= 0.8;
        this.move(p, PLAYER_R);
        p.wantDash = p.wantKick = false;
        continue;
      }
      p.fireT = Math.max(p.fireT - 1, -1);
      p.dashT--;
      p.kickT--;

      if (p.wantDash && p.dashT <= 0) {
        let dx = p.mx;
        let dy = p.my;
        if (!dx && !dy) {
          dx = Math.cos(p.aim);
          dy = Math.sin(p.aim);
        }
        const d = len(dx, dy) || 1;
        p.vx = (dx / d) * 310;
        p.vy = (dy / d) * 310;
        p.dashing = 7;
        p.dashT = p.dashCd;
        this.events.push({ e: 'dash', x: r1(p.x), y: r1(p.y), p: p.id });
      }
      p.wantDash = false;

      if (p.dashing > 0) {
        p.dashing--;
        if (p.dashing === 0) {
          p.vx *= 0.4;
          p.vy *= 0.4;
        }
      } else if (p.stagger > 0) {
        p.vx *= 0.85;
        p.vy *= 0.85;
      } else {
        p.vx += (p.mx * p.speed - p.vx) * 0.3;
        p.vy += (p.my * p.speed - p.vy) * 0.3;
      }
      this.move(p, PLAYER_R);

      if (p.shoot && p.fireT <= 0 && p.dashing <= 0) {
        this.fire(p);
        p.fireT += p.fireCd;
      }
      if (p.wantKick && p.kickT <= 0) {
        this.kick(p);
        p.kickT = 16;
      }
      p.wantKick = false;

      const tile = this.tileAt(p.x, p.y);
      if (p.dashing <= 0) {
        if (tile === T.Pit) {
          this.events.push({ e: 'fall', x: r1(p.x), y: r1(p.y), who: 'player' });
          p.x = p.safeX;
          p.y = p.safeY;
          p.vx = p.vy = 0;
          p.invuln = 0;
          this.damagePlayer(p, 15, 0, 0, 0, true);
          p.invuln = 40;
          continue;
        }
        if (tile === T.Lava && p.hazT <= 0) {
          p.hazT = 5;
          p.hp -= 6;
          this.events.push({ e: 'burn', x: r1(p.x), y: r1(p.y) });
          if (p.hp <= 0) this.downPlayer(p);
        }
        if (tile === T.Spikes && spikeState(this.tick, Math.floor(p.x / TILE), Math.floor(p.y / TILE)) === 2) {
          const a = Math.random() * Math.PI * 2;
          this.damagePlayer(p, 14, Math.cos(a), Math.sin(a), 90);
        }
      }
      if (tile === T.Floor) {
        p.safeX = p.x;
        p.safeY = p.y;
      }
      if (tile === T.Stairs && this.stairsOpen && !p.down) {
        this.loadFloor(this.floor + 1);
        return;
      }
    }
  }

  private updateEnemies() {
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      e.stagger--;
      e.invuln--;
      e.hazT--;
      e.atkT--;
      e.cd--;
      const [t, dist] = this.nearestPlayer(e.x, e.y);
      if (t && !e.aggro && this.tick % 6 === e.id % 6 && dist < 170 && this.los(e.x, e.y, t.x, t.y)) e.aggro = true;

      let wantX = 0;
      let wantY = 0;
      let selfDriven = true;
      if (t && e.aggro && e.stagger <= 0) {
        const dx = t.x - e.x;
        const dy = t.y - e.y;
        const d = len(dx, dy) || 1;
        const seen = this.tick % 3 === 0 ? this.los(e.x, e.y, t.x, t.y) : d < 200;
        if (e.s === 0) e.a = Math.atan2(dy, dx);
        switch (e.k) {
          case 'grunt': {
            [wantX, wantY] = this.steer(e, t);
            break;
          }
          case 'archer': {
            if (seen && d < 70) [wantX, wantY] = [-dx / d, -dy / d];
            else if (!seen || d > 120) [wantX, wantY] = this.steer(e, t);
            else {
              const side = e.id % 2 ? 1 : -1;
              [wantX, wantY] = [(-dy / d) * side * 0.6, (dx / d) * side * 0.6];
            }
            if (seen && d < 210 && e.cd <= 0) {
              this.enemyShoot(e, Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.12);
              this.events.push({ e: 'eshot', x: r1(e.x), y: r1(e.y), a: r1(e.a) });
              e.cd = 48 + Math.random() * 24;
            }
            break;
          }
          case 'brute':
            [wantX, wantY, selfDriven] = this.bruteAI(e, t, dx, dy, d, seen);
            break;
          case 'boss':
            [wantX, wantY, selfDriven] = this.bossAI(e, t, dx, dy, d);
            break;
        }
      }

      if (e.stagger > 0) {
        e.vx *= 0.86;
        e.vy *= 0.86;
        if (e.k === 'brute' || e.k === 'boss') e.s = 0;
      } else if (selfDriven) {
        e.vx += (wantX * e.speed - e.vx) * 0.22;
        e.vy += (wantY * e.speed - e.vy) * 0.22;
      }
      const preSpeed = len(e.vx, e.vy);
      const impact = this.move(e, e.r, e.stagger > 0 ? 0.35 : 0);
      if (impact > 0) {
        if (e.s === 2 && (e.k === 'brute' || e.k === 'boss')) {
          e.s = 0;
          e.stagger = e.k === 'boss' ? 28 : 40;
          e.cd = 50;
          this.events.push({ e: 'slam', x: r1(e.x), y: r1(e.y) });
          this.damageEnemy(e, e.k === 'boss' ? 30 : 15, 0, 0, 0, 0, e.stagger);
        } else if (e.stagger > 0 && preSpeed > 170) {
          this.events.push({ e: 'slam', x: r1(e.x), y: r1(e.y) });
          this.damageEnemy(e, Math.round(preSpeed / 18), 0, 0, 0, 0, 10);
        }
      }
      if (e.hp <= 0) continue;

      if (e.k !== 'boss') {
        const tile = this.tileAt(e.x, e.y);
        if (tile === T.Pit) {
          this.events.push({ e: 'fall', x: r1(e.x), y: r1(e.y), who: 'enemy' });
          this.killEnemy(e, 0, 0, true);
          continue;
        }
        if (tile === T.Lava && e.hazT <= 0) {
          e.hazT = 6;
          this.events.push({ e: 'burn', x: r1(e.x), y: r1(e.y) });
          this.damageEnemy(e, 7, 0, 0, 0, 0, 0);
        }
        if (tile === T.Spikes && e.invuln <= 0 && spikeState(this.tick, Math.floor(e.x / TILE), Math.floor(e.y / TILE)) === 2) {
          e.invuln = 15;
          this.damageEnemy(e, 12, 0, 0, 0, 0, 4);
        }
      }
      if (e.hp <= 0) continue;

      for (const p of this.players.values()) {
        if (p.down) continue;
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const d = len(dx, dy);
        if (d < e.r + PLAYER_R + 1) {
          const n = d || 1;
          if (e.s === 2) this.damagePlayer(p, e.k === 'boss' ? 28 : 22, dx / n, dy / n, 380);
          else if (e.atkT <= 0 && e.stagger <= 0) {
            e.atkT = 22;
            this.damagePlayer(p, e.k === 'boss' ? 18 : e.k === 'brute' ? 14 : 9, dx / n, dy / n, 220);
          }
        }
      }
    }
  }

  private bruteAI(e: Enemy, t: Player, dx: number, dy: number, d: number, seen: boolean): [number, number, boolean] {
    if (e.s === 0) {
      if (seen && d < 120 && e.cd <= 0) {
        e.s = 1;
        e.timer = 20;
        e.dirX = dx / d;
        e.dirY = dy / d;
        e.a = Math.atan2(dy, dx);
      }
      const [sx, sy] = this.steer(e, t);
      return [sx, sy, true];
    }
    if (e.s === 1) {
      e.vx *= 0.6;
      e.vy *= 0.6;
      if (--e.timer <= 0) {
        e.s = 2;
        e.timer = 18;
        e.vx = e.dirX * 240;
        e.vy = e.dirY * 240;
      }
      return [0, 0, false];
    }
    if (--e.timer <= 0) {
      e.s = 0;
      e.cd = 45;
    }
    return [0, 0, false];
  }

  private bossAI(e: Enemy, t: Player, dx: number, dy: number, d: number): [number, number, boolean] {
    const p2 = e.phase2;
    // pattern 0 = walk, 1 = burst, 2 = charge, 3 = summon, 4 = spray
    if (e.pattern === 0) {
      if (e.cd <= 0) {
        const seq = [1, 2, 4, 3, 1, 2, 4];
        e.pattern = seq[e.reps++ % seq.length];
        e.timer = 0;
        e.s = 0;
        e.timer = e.pattern === 4 ? (p2 ? 60 : 44) : 0;
        e.dirX = p2 ? 3 : 2;
      }
      const [sx, sy] = this.steer(e, t);
      return [sx, sy, true];
    }
    const done = (cd: number) => {
      e.pattern = 0;
      e.s = 0;
      e.cd = p2 ? cd * 0.6 : cd;
    };
    switch (e.pattern) {
      case 1: {
        e.timer++;
        if (e.timer % 14 === 1) {
          const n = p2 ? 22 : 16;
          const off = e.timer * 0.13;
          for (let i = 0; i < n; i++) this.enemyShoot(e, off + (i / n) * Math.PI * 2, p2 ? 120 : 105, 10);
          this.events.push({ e: 'eshot', x: r1(e.x), y: r1(e.y), a: 0 });
        }
        e.s = 1;
        if (e.timer > (p2 ? 56 : 42)) done(40);
        return [0, 0, true];
      }
      case 2: {
        if (e.s === 0) {
          e.s = 1;
          e.timer = p2 ? 16 : 22;
          e.dirY = Math.atan2(dy, dx);
          e.a = e.dirY;
        }
        if (e.s === 1) {
          e.vx *= 0.7;
          e.vy *= 0.7;
          if (--e.timer <= 0) {
            e.s = 2;
            e.timer = 24;
            e.vx = Math.cos(e.a) * 250;
            e.vy = Math.sin(e.a) * 250;
          }
          return [0, 0, false];
        }
        if (e.s === 2) {
          if (--e.timer <= 0) e.s = 0;
          if (e.s === 0) {
            e.dirX--;
            if (e.dirX <= 0) done(30);
          }
          return [0, 0, false];
        }
        return [0, 0, false];
      }
      case 3: {
        const adds = this.enemies.filter((o) => o.k !== 'boss' && o.hp > 0).length;
        const n = Math.min(p2 ? 4 : 3, 8 - adds);
        for (let i = 0; i < n; i++) {
          const a = (i / Math.max(1, n)) * Math.PI * 2;
          const x = e.x + Math.cos(a) * 30;
          const y = e.y + Math.sin(a) * 30;
          if (!this.collides(x, y, 6) && this.tileAt(x, y) === T.Floor) this.spawnEnemy(p2 && i === 0 ? 'brute' : i % 2 ? 'archer' : 'grunt', x, y, true);
        }
        this.events.push({ e: 'msg', text: 'The Warden calls the dead...' });
        this.events.push({ e: 'boom', x: r1(e.x), y: r1(e.y), r: 0 });
        done(50);
        return [0, 0, true];
      }
      case 4: {
        e.s = 1;
        if (e.timer % 3 === 0) {
          const a = Math.atan2(dy, dx) + Math.sin(e.timer * 0.3) * 0.35;
          this.enemyShoot(e, a, 150, 8);
          this.events.push({ e: 'eshot', x: r1(e.x), y: r1(e.y), a: r1(a) });
        }
        if (--e.timer <= 0) done(40);
        return [(dx / d) * 0.3, (dy / d) * 0.3, true];
      }
    }
    return [0, 0, true];
  }

  private updateBullets() {
    const keep: Bullet[] = [];
    outer: for (const b of this.bullets) {
      for (let s = 0; s < 2; s++) {
        const ox = b.x;
        const oy = b.y;
        b.x += (b.vx * DT) / 2;
        b.y += (b.vy * DT) / 2;
        if (this.solid(b.x, b.y)) {
          if (b.bounce > 0) {
            b.bounce--;
            if (this.solid(b.x, oy)) b.vx = -b.vx;
            if (this.solid(ox, b.y)) b.vy = -b.vy;
            b.x = ox;
            b.y = oy;
            b.hit.clear();
            this.events.push({ e: 'spark', x: r1(ox), y: r1(oy) });
          } else {
            this.events.push({ e: 'spark', x: r1(ox), y: r1(oy) });
            continue outer;
          }
        }
        for (const br of this.barrels) {
          if (!b.enemy && br.fuse < 0 && len(br.x - b.x, br.y - b.y) < 7 + b.r) {
            br.fuse = 1;
            br.kicker = b.pid;
            continue outer;
          }
        }
        if (!b.enemy) {
          for (const e of this.enemies) {
            if (e.hp <= 0 || b.hit.has(e.id)) continue;
            if (len(e.x - b.x, e.y - b.y) < e.r + b.r) {
              const sp = len(b.vx, b.vy) || 1;
              this.damageEnemy(e, b.dmg, b.vx / sp, b.vy / sp, b.knock, b.pid);
              b.hit.add(e.id);
              if (b.pierce > 0) b.pierce--;
              else continue outer;
            }
          }
        } else {
          for (const p of this.players.values()) {
            if (p.down) continue;
            if (len(p.x - b.x, p.y - b.y) < PLAYER_R + b.r) {
              if (p.dashing > 0) continue;
              const sp = len(b.vx, b.vy) || 1;
              this.damagePlayer(p, b.dmg, b.vx / sp, b.vy / sp, b.knock);
              continue outer;
            }
          }
        }
      }
      if (--b.life > 0) keep.push(b);
    }
    this.bullets = keep;
  }

  private updateBarrels() {
    const keep: Barrel[] = [];
    for (const b of this.barrels) {
      if (b.fuse >= 0 && --b.fuse <= 0) {
        this.explode(b.x, b.y, b.kicker);
        continue;
      }
      const sp = len(b.vx, b.vy);
      if (sp > 1) {
        const impact = this.move(b, 5, 0.4);
        if (impact > 130) b.fuse = 1;
        if (sp > 120)
          for (const e of this.enemies)
            if (len(e.x - b.x, e.y - b.y) < e.r + 6) {
              b.fuse = 1;
              break;
            }
        b.vx *= 0.9;
        b.vy *= 0.9;
      }
      const tile = this.tileAt(b.x, b.y);
      if (tile === T.Pit) {
        this.events.push({ e: 'fall', x: r1(b.x), y: r1(b.y), who: 'enemy' });
        continue;
      }
      if (tile === T.Lava && b.fuse < 0) b.fuse = 10;
      keep.push(b);
    }
    this.barrels = keep;
  }

  private separate() {
    type Body = { x: number; y: number; r: number; m: number; ref: { x: number; y: number } };
    const bodies: Body[] = [];
    for (const p of this.players.values()) bodies.push({ x: p.x, y: p.y, r: PLAYER_R, m: 1, ref: p });
    for (const e of this.enemies) if (e.hp > 0) bodies.push({ x: e.x, y: e.y, r: e.r, m: e.mass, ref: e });
    for (const b of this.barrels) bodies.push({ x: b.x, y: b.y, r: 6, m: 3, ref: b });
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.ref.x - a.ref.x;
        const dy = b.ref.y - a.ref.y;
        const d = len(dx, dy);
        const min = a.r + b.r;
        if (d >= min || d === 0) continue;
        const push = (min - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;
        const wa = b.m / (a.m + b.m);
        const wb = a.m / (a.m + b.m);
        this.nudge(a.ref, -nx * push * wa * 2, -ny * push * wa * 2, a.r);
        this.nudge(b.ref, nx * push * wb * 2, ny * push * wb * 2, b.r);
      }
  }

  private nudge(o: { x: number; y: number }, dx: number, dy: number, r: number) {
    if (!this.collides(o.x + dx, o.y, r)) o.x += dx;
    if (!this.collides(o.x, o.y + dy, r)) o.y += dy;
  }

  private updateItems() {
    this.items = this.items.filter((it) => {
      for (const p of this.players.values()) {
        if (p.down || len(p.x - it.x, p.y - it.y) > 11) continue;
        if (it.k === 'potion' && p.hp >= p.maxHp) continue;
        this.applyItem(p, it.k);
        this.events.push({ e: 'pickup', x: r1(it.x), y: r1(it.y), k: it.k, p: p.id });
        return false;
      }
      return true;
    });
  }

  private updateRevives() {
    for (const p of this.players.values()) {
      if (!p.down) continue;
      const helper = [...this.players.values()].some((o) => !o.down && len(o.x - p.x, o.y - p.y) < 22);
      p.rev = helper ? p.rev + 1 / (TICK_RATE * 2) : Math.max(0, p.rev - 1 / (TICK_RATE * 4));
      if (p.rev >= 1) {
        p.down = false;
        p.rev = 0;
        p.hp = Math.ceil(p.maxHp * 0.4);
        p.invuln = 45;
        this.events.push({ e: 'revive', p: p.id });
        this.events.push({ e: 'msg', text: `${p.name} is back on their feet!` });
      }
    }
  }

  // ---------- networking ----------
  send(p: Player, msg: ServerMsg) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(data);
  }
}
