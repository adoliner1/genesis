import { TICK_RATE } from '../shared/protocol';
import type { NetClient } from './net/client';

const TICK_MS = 1000 / TICK_RATE;

/** F3 / backtick: live netcode stats plus simulated latency, jitter and loss. */
export class DebugOverlay {
  el: HTMLElement;
  private text: HTMLElement;
  private last = 0;
  shown = false;

  constructor(private c: NetClient) {
    const q = new URLSearchParams(location.search);
    const num = (k: string) => Math.max(0, Number(q.get(k)) || 0);
    c.net.sim = { lag: num('lag'), jitter: num('jitter'), loss: Math.min(50, num('loss')) };

    this.el = document.createElement('div');
    this.el.id = 'netdebug';
    this.el.innerHTML = `
      <div class="nd-head">NETCODE <small>F3 to hide</small></div>
      <pre></pre>
      <div class="nd-sim">
        <label>lag <input data-k="lag" type="number" min="0" max="1000" step="10"> ms</label>
        <label>jitter <input data-k="jitter" type="number" min="0" max="500" step="5"> ms</label>
        <label>loss <input data-k="loss" type="number" min="0" max="50" step="1"> %</label>
      </div>
      <div class="nd-btns">
        <button data-a="drop">Drop connection</button>
      </div>`;
    document.body.appendChild(this.el);
    this.text = this.el.querySelector('pre')!;
    for (const inp of Array.from(this.el.querySelectorAll<HTMLInputElement>("input[data-k]"))) {
      const k = inp.dataset.k as 'lag' | 'jitter' | 'loss';
      inp.value = String(c.net.sim[k]);
      inp.oninput = () => {
        c.net.sim[k] = Math.max(0, Number(inp.value) || 0);
        const u = new URLSearchParams(location.search);
        for (const key of ['lag', 'jitter', 'loss'] as const) {
          const v = c.net.sim[key];
          if (v) u.set(key, String(v));
          else u.delete(key);
        }
        history.replaceState(null, '', `?${u}`);
      };
      inp.onkeydown = (e: KeyboardEvent) => e.stopPropagation();
    }
    this.el.querySelector<HTMLButtonElement>('[data-a=drop]')!.onclick = () => c.net.simulateDrop();

    const simOn = c.net.sim.lag || c.net.sim.jitter || c.net.sim.loss;
    this.show(q.has('debug') || !!simOn);
    addEventListener('keydown', (e) => {
      if (e.key === 'F3' || e.key === '`') {
        e.preventDefault();
        this.show(!this.shown);
      }
    });
  }

  show(on: boolean) {
    this.shown = on;
    this.el.hidden = !on;
  }

  update(now: number) {
    if (!this.shown || now - this.last < 100) return;
    this.last = now;
    const c = this.c;
    const p = c.pred;
    const tl = c.tl;
    const st = c.stats;
    const sim = c.net.sim;
    const srvNow = tl.serverTick(now);
    const ahead = c.predTick() - srvNow;
    const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
    const lines = [
      `ping      ${f(c.rtt, 0)} ms  ±${f(c.rttJitter, 0)}   link ${c.net.status}`,
      `sim       ${sim.lag || sim.jitter || sim.loss ? `+${sim.lag} ms rtt, ${sim.jitter} ms jitter, ${sim.loss}% loss` : 'off'}`,
      `tick      server ${c.latestTick}  render ${f(tl.renderTick)}  predicted ${f(c.predTick())}`,
      `interp    target ${f(tl.delayTicks, 2)} ticks, actual ${f(tl.behindLatest(), 2)} (${f(tl.behindLatest() * TICK_MS, 0)} ms)  jitter ${f(tl.jitterMs, 0)} ms${tl.extrapolating ? '  EXTRAP' : ''}`,
      `predict   seq ${p.seq}  unacked ${p.pending}  ahead ${f(ahead)} ticks  pace ${f(c.pace, 3)}`,
      `inputbuf  ${f(c.bufEma, 2)} (target ${f(c.bufTarget, 1)})  server guessed ${c.starved}  skips ${c.skips}`,
      `correct   ${p.corrections}  last ${f(p.lastErr, 2)} ${p.lastErrKey}  snaps ${p.snaps}  replayed ${p.replayed}`,
      `sizes     <1px ${p.errBuckets[0]}  1-4 ${p.errBuckets[1]}  4-16 ${p.errBuckets[2]}  >16 ${p.errBuckets[3]}   blending ${f(Math.hypot(p.errX, p.errY), 2)} px`,
      `self      par ${p.state?.par ?? '–'} mode ${p.state?.pm ?? '–'}  rope ${p.state?.rm ?? '–'}  heavy ${p.state?.heavy ?? '–'}`,
      `snapshots ${f(st.snapHz, 0)}/s  in ${f(st.kbIn, 2)} KB/s  out ${f(st.kbOut, 2)} KB/s`,
      `drops     stale ${c.staleDrops}  no-baseline ${c.baseMisses}  extrap frames ${tl.extrapolatedFrames}`,
    ];
    this.text.textContent = lines.join('\n');
  }
}
