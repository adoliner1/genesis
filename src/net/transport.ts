import type { ClientMsg, ServerMsg } from '../../shared/protocol';

/** Simulated network conditions, applied in both directions on the client. */
export interface LinkSim {
  /** Added round-trip latency, ms (half each way). */
  lag: number;
  /** Extra random delay per packet per direction, 0..jitter ms. */
  jitter: number;
  /** Percent of unreliable packets dropped per direction. */
  loss: number;
}

export type NetStatus = 'connecting' | 'open' | 'retrying' | 'dead';

const RETRY_MS = [250, 500, 1000, 1500, 2500, 4000];
const GIVE_UP_MS = 60000;
const SILENCE_MS = 5000;

/**
 * WebSocket with two logical channels: reliable JSON (ordered) and unreliable binary
 * (snapshots/inputs/pings; may be dropped or reordered by the simulator). Reconnects on drop.
 */
export class Net {
  ws: WebSocket | null = null;
  status: NetStatus = 'connecting';
  sim: LinkSim = { lag: 0, jitter: 0, loss: 0 };
  onJson: (m: ServerMsg) => void = () => {};
  onBinary: (b: Uint8Array) => void = () => {};
  onOpen: (reconnect: boolean) => void = () => {};
  onStatus: (s: NetStatus) => void = () => {};
  bytesIn = 0;
  bytesOut = 0;
  private gen = 0;
  private relOut = 0;
  private relIn = 0;
  private opened = false;
  private downSince = 0;
  private attempt = 0;
  private lastRecv = 0;
  private stopped = false;
  private watchdog = 0;

  constructor() {
    this.connect();
    this.watchdog = window.setInterval(() => {
      if (this.status === 'open' && performance.now() - this.lastRecv > SILENCE_MS) this.ws?.close();
    }, 1000);
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private connect() {
    const gen = ++this.gen;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.relOut = this.relIn = 0;
    ws.onopen = () => {
      if (gen !== this.gen) return;
      const re = this.opened;
      this.opened = true;
      this.attempt = 0;
      this.downSince = 0;
      this.lastRecv = performance.now();
      this.setStatus('open');
      this.onOpen(re);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      this.lastRecv = performance.now();
      const bin = typeof ev.data !== 'string';
      this.bytesIn += bin ? (ev.data as ArrayBuffer).byteLength : ev.data.length;
      if (bin && this.drop()) return;
      const deliver = () => {
        if (gen !== this.gen) return;
        if (bin) this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
        else this.onJson(JSON.parse(ev.data as string) as ServerMsg);
      };
      this.later(deliver, !bin, 'in');
    };
    ws.onclose = () => {
      if (gen !== this.gen || this.stopped) return;
      this.retry();
    };
  }

  private retry() {
    const now = performance.now();
    if (!this.downSince) this.downSince = now;
    if (!this.opened || now - this.downSince > GIVE_UP_MS) {
      this.setStatus('dead');
      return;
    }
    this.setStatus('retrying');
    const wait = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
    setTimeout(() => !this.stopped && this.connect(), wait);
  }

  private drop() {
    return this.sim.loss > 0 && Math.random() * 100 < this.sim.loss;
  }

  private later(fn: () => void, reliable: boolean, dir: 'in' | 'out') {
    const { lag, jitter } = this.sim;
    if (lag <= 0 && jitter <= 0) return fn();
    const now = performance.now();
    let at = now + lag / 2 + Math.random() * jitter;
    if (reliable) {
      if (dir === 'in') at = this.relIn = Math.max(this.relIn, at);
      else at = this.relOut = Math.max(this.relOut, at);
    }
    setTimeout(fn, at - now);
  }

  sendJson(m: ClientMsg) {
    const ws = this.ws;
    const data = JSON.stringify(m);
    this.later(
      () => {
        if (ws && ws === this.ws && ws.readyState === WebSocket.OPEN) {
          this.bytesOut += data.length;
          ws.send(data);
        }
      },
      true,
      'out',
    );
  }

  sendBin(b: Uint8Array) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.drop()) return;
    this.later(
      () => {
        if (ws === this.ws && ws.readyState === WebSocket.OPEN) {
          this.bytesOut += b.byteLength;
          ws.send(b);
        }
      },
      false,
      'out',
    );
  }

  /** Stop for good (e.g. slot taken over by another tab). */
  close() {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.ws?.close();
    this.setStatus('dead');
  }

  /** Force a drop to exercise the reconnect path. */
  simulateDrop() {
    this.ws?.close();
  }
}
