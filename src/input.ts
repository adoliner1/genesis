import { BTN } from '../shared/sim/input';

/**
 * Keyboard + mouse. Presses are latched until a simulation tick consumes them, so a tap shorter
 * than a tick is never lost.
 */
export class Input {
  private keys = new Set<string>();
  private mouse = new Set<number>();
  private latched = 0;
  /** Pointer in screen pixels. */
  sx = 0;
  sy = 0;
  restartHeld = 0;

  constructor(target: HTMLElement) {
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.code;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) e.preventDefault();
      if (!e.repeat) {
        if (k === 'Space' || k === 'ArrowUp' || k === 'KeyK') this.latched |= BTN.JUMP_P;
        if (k === 'KeyE' || k === 'KeyF') this.latched |= BTN.CTX_P;
        if (k === 'ShiftLeft' || k === 'ShiftRight') this.latched |= BTN.MOB_P;
        if (k === 'KeyQ') this.latched |= BTN.SEC_P;
      }
      if (!e.repeat) this.taps.add(k);
      this.keys.add(k);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.clear();
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('pointermove', (e) => {
      this.sx = e.clientX;
      this.sy = e.clientY;
    });
    target.addEventListener('pointerdown', (e) => {
      this.sx = e.clientX;
      this.sy = e.clientY;
      this.mouse.add(e.button);
      if (e.button === 0) this.latched |= BTN.PRI_P;
      if (e.button === 2) this.latched |= BTN.SEC_P;
    });
    addEventListener('pointerup', (e) => this.mouse.delete(e.button));
  }

  has(k: string) {
    return this.keys.has(k);
  }

  private taps = new Set<string>();
  /** True once per keydown, even for a tap shorter than a frame. */
  pressedOnce(k: string) {
    return this.taps.delete(k);
  }

  /** Movement axes and buttons for one tick; clears latched presses. */
  sample(): { mx: number; my: number; buttons: number } {
    const k = this.keys;
    const mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const my = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') ? 1 : 0);
    let b = this.latched;
    this.latched = 0;
    if (k.has('Space') || k.has('ArrowUp') || k.has('KeyK')) b |= BTN.JUMP;
    if (k.has('KeyE') || k.has('KeyF')) b |= BTN.CTX;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) b |= BTN.MOB;
    if (this.mouse.has(0)) b |= BTN.PRI;
    if (this.mouse.has(2) || k.has('KeyQ')) b |= BTN.SEC;
    return { mx, my, buttons: b };
  }
}
