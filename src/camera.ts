import Phaser from 'phaser';

export type CamMode = { k: 'self' } | { k: 'follow'; id: number } | { k: 'free' };

const EDGE_PX = 8;
const EDGE_SPEED = 700;
const DRAG_TAP_PX = 4;

/**
 * RTS-style camera control on top of the follow camera: middle-drag or push the cursor against the
 * window edge to pan freely, Tab cycles through teammates, C (or a middle click) snaps back.
 */
export class CameraRig {
  mode: CamMode = { k: 'self' };
  x = 0;
  y = 0;
  edgePan = true;
  private snapping = false;
  private dragging = false;
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;
  private inside = false;

  constructor(
    private scene: Phaser.Scene,
    private teammates: () => number[],
  ) {
    const input = scene.input;
    input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!p.middleButtonDown()) return;
      this.dragging = true;
      this.dragMoved = 0;
      this.lastX = p.x;
      this.lastY = p.y;
    });
    input.on('pointermove', (p: Phaser.Input.Pointer) => {
      this.inside = true;
      if (!this.dragging) return;
      const zoom = scene.cameras.main.zoom;
      const dx = p.x - this.lastX;
      const dy = p.y - this.lastY;
      this.lastX = p.x;
      this.lastY = p.y;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      if (this.dragMoved < DRAG_TAP_PX) return;
      this.free();
      this.x -= dx / zoom;
      this.y -= dy / zoom;
    });
    input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (!this.dragging || p.middleButtonDown()) return;
      this.dragging = false;
      if (this.dragMoved < DRAG_TAP_PX) this.snapBack();
    });
    input.on('gameout', () => (this.inside = false));
    input.on('gameover', () => (this.inside = true));
    const kb = input.keyboard!;
    kb.addKey('TAB');
    kb.on('keydown-TAB', () => this.cycle());
    kb.on('keydown-C', () => this.snapBack());
  }

  private free() {
    this.mode = { k: 'free' };
  }

  snapBack() {
    if (this.mode.k !== 'self') this.snapping = true;
    this.mode = { k: 'self' };
  }

  cycle() {
    const ids = this.teammates();
    if (!ids.length) return this.snapBack();
    const cur = this.mode.k === 'follow' ? ids.indexOf(this.mode.id) : -1;
    if (cur === ids.length - 1) return this.snapBack();
    this.mode = { k: 'follow', id: ids[cur + 1] };
    this.snapping = true;
  }

  /**
   * Advances the camera centre. `self` is where the normal follow camera wants to be,
   * `follow(id)` a teammate's position, `bounds` the map size in world pixels.
   */
  update(dt: number, self: { x: number; y: number } | null, follow: (id: number) => { x: number; y: number } | null, bounds: { w: number; h: number }) {
    const cam = this.scene.cameras.main;
    const p = this.scene.input.activePointer;
    if (this.edgePan && this.inside && !this.dragging && document.hasFocus()) {
      const W = this.scene.scale.width;
      const H = this.scene.scale.height;
      const ex = p.x <= EDGE_PX ? -1 : p.x >= W - EDGE_PX ? 1 : 0;
      const ey = p.y <= EDGE_PX ? -1 : p.y >= H - EDGE_PX ? 1 : 0;
      if (ex || ey) {
        if (this.mode.k !== 'free') {
          this.x = cam.midPoint.x;
          this.y = cam.midPoint.y;
          this.free();
        }
        this.x += (ex * EDGE_SPEED * dt) / cam.zoom;
        this.y += (ey * EDGE_SPEED * dt) / cam.zoom;
      }
    }
    let want: { x: number; y: number } | null = null;
    if (this.mode.k === 'self') want = self;
    else if (this.mode.k === 'follow') {
      want = follow(this.mode.id);
      if (!want) this.snapBack();
    }
    if (want) {
      if (this.x < 0) [this.x, this.y] = [want.x, want.y];
      if (Math.hypot(want.x - this.x, want.y - this.y) < 6) this.snapping = false;
      const k = 1 - Math.exp(-dt * (this.snapping ? 18 : this.mode.k === 'self' ? 8 : 6));
      this.x += (want.x - this.x) * k;
      this.y += (want.y - this.y) * k;
    }
    const hw = cam.width / cam.zoom / 2;
    const hh = cam.height / cam.zoom / 2;
    if (this.mode.k === 'free') {
      this.x = Phaser.Math.Clamp(this.x, Math.min(hw, bounds.w / 2), Math.max(bounds.w - hw, bounds.w / 2));
      this.y = Phaser.Math.Clamp(this.y, Math.min(hh, bounds.h / 2), Math.max(bounds.h - hh, bounds.h / 2));
    }
  }
}
