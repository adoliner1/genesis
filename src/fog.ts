import Phaser from 'phaser';
import { TILE } from '../shared/protocol';
import type { TileMap } from '../shared/sim/map';
import { VISION_R, fov, opaqueGrid, unpackBits, type Eye } from '../shared/sim/vision';

/**
 * Client copy of the team's sight: purely cosmetic (what's drawn dark). What the client is *sent*
 * is decided by the server, which streams a little past this so nothing pops in at the edge.
 */
export class FogState {
  w = 0;
  h = 0;
  vis = new Uint8Array(0);
  explored = new Uint8Array(0);
  private opaque: Uint8Array = new Uint8Array(0);

  reset(m: TileMap) {
    this.w = m.w;
    this.h = m.h;
    this.opaque = opaqueGrid(m);
    this.vis = new Uint8Array(m.w * m.h);
    this.explored = new Uint8Array(m.w * m.h);
  }

  applyExplored(bits: string) {
    if (!this.w) return;
    const got = unpackBits(bits, this.w * this.h);
    for (let i = 0; i < got.length; i++) this.explored[i] |= got[i];
  }

  /** Recompute visible tiles from the given eyes; also marks them explored. */
  see(eyes: readonly Eye[], writeVis = true) {
    if (!this.w) return;
    const { vis, explored } = this;
    if (writeVis) vis.fill(0);
    for (const e of eyes)
      if (!e.off)
        fov(this.w, this.h, this.opaque, e.x, e.y, VISION_R, (i) => {
          explored[i] = 1;
          if (writeVis) vis[i] = 1;
        });
  }

  visibleAt(x: number, y: number) {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h && this.vis[ty * this.w + tx] === 1;
  }
}

/** Sub-cells per tile; each is a 4x4 world-pixel block, so the fog edge reads as chunky pixel art. */
const SUB = 4;
const EXPLORED = 0.625;
const LEVELS = 8;
const FOG_RGB = [9, 5, 12];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** Draws the fog as a dithered, quantized overlay: clear where seen, dim where explored, black elsewhere. */
export class FogLayer {
  private key = '';
  private tex: Phaser.Textures.CanvasTexture | null = null;
  private img: Phaser.GameObjects.Image | null = null;
  private shade = new Float32Array(0);
  private data: ImageData | null = null;
  private n = 0;

  constructor(
    private scene: Phaser.Scene,
    private state: FogState,
  ) {}

  reset(id: number) {
    this.img?.destroy();
    if (this.key) this.scene.textures.remove(this.key);
    const { w, h } = this.state;
    this.key = `fog${id}`;
    this.tex = this.scene.textures.createCanvas(this.key, w * SUB, h * SUB);
    this.img = this.scene.add.image(0, 0, this.key).setOrigin(0).setScale(TILE / SUB).setDepth(940);
    this.data = this.tex!.context.createImageData(w * SUB, h * SUB);
    const d = this.data.data;
    for (let i = 0; i < d.length; i += 4) [d[i], d[i + 1], d[i + 2]] = FOG_RGB;
    this.shade = new Float32Array(w * h).fill(1);
    this.n = 0;
    this.update(1, true);
  }

  /** Smoothed fog darkness at a world point: 0 = in sight, ~0.6 = explored, 1 = unexplored. */
  shadeAt(x: number, y: number) {
    const { w, h } = this.state;
    if (!w) return 0;
    const fx = Math.max(0, Math.min(w - 1, x / TILE - 0.5));
    const fy = Math.max(0, Math.min(h - 1, y / TILE - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const s = this.shade;
    const top = s[y0 * w + x0] * (1 - ax) + s[y0 * w + x1] * ax;
    const bot = s[y1 * w + x0] * (1 - ax) + s[y1 * w + x1] * ax;
    return top * (1 - ay) + bot * ay;
  }

  /** 0..1 opacity for something standing at (x, y) that should only show while in sight. */
  alphaAt(x: number, y: number) {
    return Math.max(0, Math.min(1, 1 - this.shadeAt(x, y) / 0.35));
  }

  update(dt: number, force = false) {
    if (!this.tex || !this.data) return;
    const { vis, explored, w, h } = this.state;
    const s = this.shade;
    const k = 1 - Math.exp(-dt * 10);
    let changed = force;
    for (let i = 0; i < s.length; i++) {
      const want = vis[i] ? 0 : explored[i] ? EXPLORED : 1;
      const d = want - s[i];
      if (d === 0) continue;
      s[i] = Math.abs(d) < 0.01 ? want : s[i] + d * k;
      changed = true;
    }
    // Redraw at most ~30 Hz; the quantized output doesn't benefit from more.
    if (!changed || (++this.n & 1 && !force)) return;
    const W = w * SUB;
    const px = this.data.data;
    for (let y = 0; y < h * SUB; y++) {
      const fy = Math.max(0, Math.min(h - 1, (y + 0.5) / SUB - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(h - 1, y0 + 1);
      const ay = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / SUB - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(w - 1, x0 + 1);
        const ax = fx - x0;
        const a = (s[y0 * w + x0] * (1 - ax) + s[y0 * w + x1] * ax) * (1 - ay) + (s[y1 * w + x0] * (1 - ax) + s[y1 * w + x1] * ax) * ay;
        const q = Math.min(LEVELS, Math.floor(a * LEVELS + BAYER[(y & 3) * 4 + (x & 3)])) / LEVELS;
        px[(y * W + x) * 4 + 3] = q * 255;
      }
    }
    this.tex.context.putImageData(this.data, 0, 0);
    this.tex.refresh();
  }
}
