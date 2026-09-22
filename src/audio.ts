let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

export function initAudio() {
  if (ctx) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function env(g: GainNode, t: number, peak: number, dur: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  env(g, t, vol, dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol: number, freq: number, q = 1, type: BiquadFilterType = 'lowpass') {
  if (!ctx || !master || !noiseBuf) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.playbackRate.value = 0.5 + Math.random();
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, vol, dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.02);
}

const last: Record<string, number> = {};
function throttle(k: string, ms: number) {
  const now = performance.now();
  if (now - (last[k] ?? 0) < ms) return false;
  last[k] = now;
  return true;
}

export const sfx = {
  shot(local: boolean, power = 0.5) {
    if (!throttle('shot' + local, 30)) return;
    const v = local ? 1 : 0.4;
    tone('triangle', 520 + power * 380, 140, 0.12, (0.12 + power * 0.1) * v);
    noise(0.06 + power * 0.06, 0.3 * v, 5000, 0.8, 'highpass');
  },
  fullDraw() {
    tone('sine', 1400, 1800, 0.08, 0.06);
  },
  slash(local: boolean) {
    if (!throttle('slash' + local, 40)) return;
    const v = local ? 1 : 0.45;
    noise(0.14, 0.4 * v, 3800, 1.2, 'bandpass');
    tone('sawtooth', 300, 120, 0.1, 0.05 * v);
  },
  block() {
    if (!throttle('block', 40)) return;
    tone('square', 900, 700, 0.06, 0.1);
    tone('triangle', 240, 180, 0.12, 0.15);
    noise(0.05, 0.2, 6000, 1, 'highpass');
  },
  guardBreak() {
    tone('sawtooth', 500, 80, 0.3, 0.18);
    noise(0.25, 0.4, 2000);
  },
  bash() {
    noise(0.12, 0.35, 900, 1.5);
    tone('sine', 140, 60, 0.15, 0.3);
  },
  slide() {
    noise(0.35, 0.18, 2400, 0.7, 'bandpass');
  },
  trap() {
    tone('triangle', 700, 300, 0.06, 0.1);
    noise(0.04, 0.2, 1500);
  },
  snare() {
    tone('square', 180, 120, 0.2, 0.12);
    tone('triangle', 900, 1200, 0.08, 0.08, 0.02);
  },
  eshot() {
    if (!throttle('eshot', 50)) return;
    tone('sawtooth', 900, 300, 0.12, 0.05);
  },
  hit() {
    if (!throttle('hit', 25)) return;
    noise(0.07, 0.35, 900, 2);
    tone('triangle', 180, 60, 0.08, 0.2);
  },
  hurt() {
    tone('square', 220, 70, 0.18, 0.2);
    noise(0.12, 0.3, 1400);
  },
  die() {
    if (!throttle('die', 40)) return;
    noise(0.22, 0.4, 700, 1.5);
    tone('sawtooth', 140, 40, 0.25, 0.12);
  },
  boom() {
    noise(0.6, 0.9, 1800, 0.7);
    tone('sine', 110, 30, 0.5, 0.6);
  },
  kick() {
    noise(0.1, 0.35, 2400, 1, 'bandpass');
    tone('triangle', 260, 90, 0.08, 0.15);
  },
  dash() {
    noise(0.16, 0.25, 5000, 0.6, 'highpass');
  },
  pickup() {
    [660, 880, 1320].forEach((f, i) => tone('square', f, f, 0.07, 0.08, i * 0.05));
  },
  level() {
    [523, 659, 784, 1046].forEach((f, i) => tone('square', f, f * 1.01, 0.12, 0.09, i * 0.07));
  },
  slam() {
    if (!throttle('slam', 60)) return;
    tone('sine', 90, 30, 0.25, 0.5);
    noise(0.15, 0.4, 500);
  },
  fall() {
    tone('sine', 600, 60, 0.6, 0.15);
  },
  spark() {
    if (!throttle('spark', 40)) return;
    tone('square', 2400, 1800, 0.03, 0.03);
  },
  burn() {
    if (!throttle('burn', 120)) return;
    noise(0.15, 0.2, 3000, 0.5, 'highpass');
  },
  stairs() {
    [392, 523, 659, 784].forEach((f, i) => tone('triangle', f, f, 0.2, 0.1, i * 0.09));
  },
  roar() {
    tone('sawtooth', 120, 50, 0.9, 0.25);
    noise(0.8, 0.3, 600, 3);
  },
};
