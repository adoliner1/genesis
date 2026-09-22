import Phaser from 'phaser';

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  color: number;
  size: number;
  grav: number;
  drag: number;
  stamp: boolean;
  kind: 0 | 1 | 2;
}

const BLOOD = [0x8a0f1a, 0xb3141f, 0xd61f2a, 0x6a0a14];
const GOO = [0x8a0f1a, 0xb3141f, 0x3f7a2a, 0x6fbf3c];
const BONE = [0xe8e0c8, 0xb8b09a, 0x8a0f1a, 0x6a0a14];
const PURPLE = [0x5a2280, 0x8a3ab0, 0x8a0f1a, 0xb3141f];

export class Fx {
  parts: P[] = [];
  g: Phaser.GameObjects.Graphics;
  stampG: Phaser.GameObjects.Graphics;
  solid: (x: number, y: number) => boolean = () => false;

  constructor(
    private scene: Phaser.Scene,
    public decals: Phaser.GameObjects.RenderTexture,
  ) {
    this.g = scene.add.graphics().setDepth(900);
    this.stampG = scene.make.graphics({}, false);
  }

  private add(p: Partial<P> & { x: number; y: number }) {
    if (this.parts.length > 1800) this.parts.shift();
    this.parts.push({
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0.5,
      max: 0.5,
      color: 0xffffff,
      size: 1,
      grav: 0,
      drag: 0.9,
      stamp: false,
      kind: 0,
      ...p,
    } as P);
  }

  palette(kind: string) {
    return kind === 'archer' ? BONE : kind === 'grunt' ? GOO : kind === 'boss' ? PURPLE : BLOOD;
  }

  blood(x: number, y: number, a: number, n: number, force = 1, colors = BLOOD) {
    for (let i = 0; i < n; i++) {
      const ang = a + (Math.random() - 0.5) * 1.6;
      const sp = (40 + Math.random() * 140) * force;
      const life = 0.6 + Math.random() * 0.6;
      this.add({
        x,
        y,
        z: 4 + Math.random() * 4,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        vz: 30 + Math.random() * 80,
        grav: 320,
        drag: 0.96,
        life,
        max: life,
        size: Math.random() < 0.3 ? 2 : 1,
        color: colors[(Math.random() * colors.length) | 0],
        stamp: true,
      });
    }
  }

  pool(x: number, y: number, r: number, colors = BLOOD) {
    const g = this.stampG;
    g.clear();
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * r * 0.7;
      g.fillStyle(colors[i % 2 ? 0 : (Math.random() * colors.length) | 0], 0.85);
      g.fillCircle(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d), Math.round(r * (0.3 + Math.random() * 0.4)));
    }
    this.decals.draw(g);
  }

  scorch(x: number, y: number, r: number) {
    const g = this.stampG;
    g.clear();
    g.fillStyle(0x0a0608, 0.22);
    g.fillCircle(x, y, r);
    g.fillStyle(0x0a0608, 0.25);
    g.fillCircle(x, y, r * 0.55);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.8 + Math.random() * 0.6);
      g.fillRect(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d), 2, 2);
    }
    this.decals.draw(g);
  }

  corpse(key: string, x: number, y: number, rot: number) {
    const img = this.scene.make.image({ key, x, y }, false);
    img.setRotation(rot).setTint(0x8a7a8a).setAlpha(0.9);
    this.decals.draw(img);
    img.destroy();
  }

  sparks(x: number, y: number, n: number, color = 0xffe066, speed = 120) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random());
      const life = 0.15 + Math.random() * 0.2;
      this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, color, drag: 0.85 });
    }
  }

  casing(x: number, y: number, a: number) {
    const side = a + Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    const sp = 50 + Math.random() * 40;
    this.add({
      x,
      y,
      z: 5,
      vx: Math.cos(side) * sp,
      vy: Math.sin(side) * sp,
      vz: 60,
      grav: 380,
      drag: 0.95,
      life: 1.2,
      max: 1.2,
      color: 0xd8a830,
      stamp: true,
    });
  }

  smoke(x: number, y: number, n: number, spread = 10, color = 0x5a5060) {
    for (let i = 0; i < n; i++) {
      const life = 0.6 + Math.random() * 0.8;
      this.add({
        x: x + (Math.random() - 0.5) * spread,
        y: y + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 30,
        vy: -10 - Math.random() * 20,
        life,
        max: life,
        color,
        size: 3 + Math.random() * 4,
        drag: 0.97,
        kind: 1,
      });
    }
  }

  embers(x: number, y: number, n: number) {
    for (let i = 0; i < n; i++) {
      const life = 0.4 + Math.random() * 0.6;
      this.add({
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 6,
        vx: (Math.random() - 0.5) * 20,
        vy: -20 - Math.random() * 40,
        life,
        max: life,
        color: Math.random() < 0.5 ? 0xffb13b : 0xff5a1f,
        drag: 0.97,
      });
    }
  }

  ring(x: number, y: number, r: number, color = 0xffffff) {
    this.add({ x, y, life: 0.3, max: 0.3, color, size: r, kind: 2 });
  }

  explosion(x: number, y: number, r: number) {
    this.ring(x, y, r, 0xffe066);
    this.sparks(x, y, 40, 0xffb13b, 260);
    this.sparks(x, y, 20, 0xffffff, 180);
    this.smoke(x, y, 22, r * 0.8, 0x3a3040);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 160;
      this.add({
        x,
        y,
        z: 6,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        vz: 60 + Math.random() * 100,
        grav: 300,
        drag: 0.96,
        life: 1,
        max: 1,
        color: Math.random() < 0.5 ? 0x5a1a1a : 0x2a2028,
        size: 2,
        stamp: true,
      });
    }
    this.scorch(x, y, r * 0.42);
  }

  update(dt: number) {
    const g = this.g;
    g.clear();
    const sg = this.stampG;
    let stamped = false;
    sg.clear();
    const keep: P[] = [];
    const drag = (d: number) => Math.pow(d, dt * 60);
    for (const p of this.parts) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const dr = drag(p.drag);
      p.vx *= dr;
      p.vy *= dr;
      if (p.stamp && this.solid(p.x, p.y)) continue;
      if (p.grav) {
        p.vz -= p.grav * dt;
        p.z += p.vz * dt;
        if (p.z <= 0) {
          p.z = 0;
          if (p.stamp && Math.abs(p.vz) < 60) {
            sg.fillStyle(p.color, 0.9);
            sg.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
            stamped = true;
            continue;
          }
          p.vz = -p.vz * 0.35;
          p.vx *= 0.6;
          p.vy *= 0.6;
        }
      }
      if (p.life <= 0) {
        if (p.stamp) {
          sg.fillStyle(p.color, 0.9);
          sg.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
          stamped = true;
        }
        continue;
      }
      const t = p.life / p.max;
      if (p.kind === 1) {
        g.fillStyle(p.color, 0.5 * t);
        g.fillCircle(p.x, p.y, p.size * (1.6 - t));
      } else if (p.kind === 2) {
        g.lineStyle(2, p.color, t);
        g.strokeCircle(p.x, p.y, p.size * (1.2 - t * 0.9));
      } else {
        g.fillStyle(p.color, p.stamp ? 1 : Math.min(1, t * 2));
        g.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.z - p.size / 2), p.size, p.size);
      }
      keep.push(p);
    }
    this.parts = keep;
    if (stamped) this.decals.draw(sg);
  }
}
