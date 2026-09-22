import type { ClientMsg, ServerMsg } from '../shared/protocol';

type Handler = (m: ServerMsg) => void;

export class Net {
  ws: WebSocket;
  private handlers: Handler[] = [];
  private queue: ClientMsg[] = [];
  onClose: () => void = () => {};

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      for (const m of this.queue) this.ws.send(JSON.stringify(m));
      this.queue = [];
    };
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as ServerMsg;
      for (const h of this.handlers) h(m);
    };
    this.ws.onclose = () => this.onClose();
  }

  on(h: Handler) {
    this.handlers.push(h);
    return () => (this.handlers = this.handlers.filter((x) => x !== h));
  }

  send(m: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(m);
  }
}
