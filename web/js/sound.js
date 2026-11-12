// Synthesized sound effects (Web Audio API, no files). Quiet, short, and
// muted with one toggle. The AudioContext is created on the first user gesture.
const KEY = 'pokerpuzzles.sound';
let enabled = true;
try { enabled = localStorage.getItem(KEY) !== 'off'; } catch { /* storage blocked */ }

let ctx = null, master = null, noiseBuf = null;
const live = new Set(); // scheduled sources, so a skipped animation can silence them

function init() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  } catch { ctx = null; }
}
// Create or resume the context on the first gesture (browsers block it before).
for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, init, { capture: true, passive: true });

const ready = () => enabled && ctx && ctx.state === 'running';
function track(src) { live.add(src); src.onended = () => live.delete(src); return src; }

/** Filtered noise burst. */
function noise({ at = 0, dur = 0.12, freq = 2500, q = 0.8, type = 'bandpass', gain = 0.5, sweepTo = null }) {
  const t = ctx.currentTime + at;
  const src = track(ctx.createBufferSource());
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.02);
}
/** Enveloped oscillator note. */
function tone({ at = 0, freq = 440, dur = 0.15, type = 'sine', gain = 0.3, glideTo = null, attack = 0.008 }) {
  const t = ctx.currentTime + at;
  const o = track(ctx.createOscillator());
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

export const sound = {
  get enabled() { return enabled; },
  setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* ignore */ }
    if (!enabled) sound.stopAll();
    else init();
  },
  /** Stop everything already scheduled (used when an animation is skipped). */
  stopAll() {
    for (const s of live) { try { s.stop(); } catch { /* already stopped */ } }
    live.clear();
  },
  /** Number of live audio nodes (for testing). */
  get liveCount() { return live.size; },
  get state() { return ctx ? ctx.state : 'none'; },

  deal(cards = 1, gap = 0.09, at = 0) {
    if (!ready()) return;
    for (let i = 0; i < cards; i++) noise({ at: at + i * gap, dur: 0.09, freq: 3200, q: 0.7, sweepTo: 1400, gain: 0.45 });
  },
  chips(big = false) {
    if (!ready()) return;
    const n = big ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const at = i * 0.045 + Math.random() * 0.01;
      tone({ at, freq: 2600 + Math.random() * 900, dur: 0.05, type: 'triangle', gain: 0.18 });
      noise({ at, dur: 0.035, freq: 5000, q: 2, gain: 0.25 });
    }
  },
  check() {
    if (!ready()) return;
    tone({ freq: 180, glideTo: 90, dur: 0.09, type: 'sine', gain: 0.5, attack: 0.003 });
    tone({ at: 0.11, freq: 170, glideTo: 85, dur: 0.08, type: 'sine', gain: 0.35, attack: 0.003 });
  },
  fold() {
    if (!ready()) return;
    noise({ dur: 0.18, freq: 1200, q: 0.5, type: 'lowpass', sweepTo: 400, gain: 0.3 });
  },
  good() {
    if (!ready()) return;
    tone({ freq: 659.25, dur: 0.22, type: 'sine', gain: 0.32 });
    tone({ at: 0.1, freq: 987.77, dur: 0.32, type: 'sine', gain: 0.3 });
  },
  meh() {
    if (!ready()) return;
    tone({ freq: 523.25, dur: 0.14, type: 'triangle', gain: 0.25 });
  },
  bad() {
    if (!ready()) return;
    tone({ freq: 140, dur: 0.28, type: 'sawtooth', gain: 0.09, attack: 0.02 });
    tone({ freq: 147, dur: 0.28, type: 'square', gain: 0.05, attack: 0.02 });
  },
  grade(grade) {
    if (grade === 'best' || grade === 'correct') sound.good();
    else if (grade === 'inaccuracy') sound.meh();
    else sound.bad();
  },
  flourish(goodScore) {
    if (!ready()) return;
    const notes = goodScore ? [523.25, 659.25, 783.99, 1046.5] : [392, 493.88, 587.33];
    notes.forEach((f, i) => tone({ at: i * 0.085, freq: f, dur: 0.35, type: 'sine', gain: 0.22 }));
  },
  // ---------- battle ----------
  /** The VS hit: a rising whoosh, a low impact and a ring. `big` for the start of a battle. */
  vs(big = false) {
    if (!ready()) return;
    noise({ dur: 0.34, freq: 500, q: 0.9, sweepTo: 4200, gain: 0.32 });
    tone({ at: 0.33, freq: big ? 120 : 140, glideTo: 42, dur: 0.42, type: 'sine', gain: big ? 0.9 : 0.7, attack: 0.004 });
    noise({ at: 0.33, dur: 0.16, freq: 900, q: 0.6, type: 'lowpass', gain: 0.5 });
    tone({ at: 0.35, freq: 880, dur: big ? 0.9 : 0.6, type: 'triangle', gain: 0.12 });
    tone({ at: 0.35, freq: 1318.5, dur: big ? 0.8 : 0.5, type: 'triangle', gain: 0.08 });
    if (big) [523.25, 783.99].forEach((f, i) => tone({ at: 0.55 + i * 0.09, freq: f, dur: 0.4, type: 'sine', gain: 0.16 }));
  },
  /** One count of the synchronised 3-2-1 (n = 3, 2, 1), and the "go" at 0. */
  count(n) {
    if (!ready()) return;
    tone({ freq: n === 1 ? 784 : 587.33, dur: 0.16, type: 'triangle', gain: 0.22 });
    noise({ dur: 0.05, freq: 3000, q: 1.5, gain: 0.12 });
  },
  go() {
    if (!ready()) return;
    tone({ freq: 1046.5, dur: 0.35, type: 'triangle', gain: 0.24 });
    tone({ freq: 1568, dur: 0.3, type: 'sine', gain: 0.1 });
  },
  /** Your decision clock, last five seconds: one tick a second (higher at the end). */
  tick(secondsLeft) {
    if (!ready()) return;
    tone({ freq: secondsLeft <= 2 ? 1320 : 990, dur: 0.05, type: 'square', gain: 0.07, attack: 0.002 });
  },
  /** Your decision clock ran out. */
  timeUp() {
    if (!ready()) return;
    noise({ dur: 0.22, freq: 600, q: 0.6, type: 'lowpass', gain: 0.45 });
    tone({ freq: 220, glideTo: 110, dur: 0.38, type: 'sawtooth', gain: 0.1, attack: 0.005 });
  },
  /** Somebody pressed Ready / Continue. */
  readyPing() {
    if (!ready()) return;
    tone({ freq: 880, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  /** The opponent answered a decision you are looking at. */
  oppAnswered() {
    if (!ready()) return;
    tone({ freq: 1244.5, dur: 0.07, type: 'sine', gain: 0.16 });
    tone({ at: 0.075, freq: 1661.2, dur: 0.11, type: 'sine', gain: 0.14 });
  },
  roundWon() {
    if (!ready()) return;
    noise({ dur: 0.1, freq: 700, q: 0.7, type: 'lowpass', gain: 0.4 });
    [659.25, 830.61, 987.77, 1318.5].forEach((f, i) => tone({ at: 0.04 + i * 0.07, freq: f, dur: 0.3, type: 'triangle', gain: 0.17 }));
    for (let i = 0; i < 4; i++) tone({ at: 0.33 + i * 0.04, freq: 2600 + Math.random() * 1400, dur: 0.06, type: 'sine', gain: 0.06 });
  },
  roundLost() {
    if (!ready()) return;
    noise({ dur: 0.12, freq: 500, q: 0.7, type: 'lowpass', gain: 0.35 });
    tone({ at: 0.03, freq: 392, dur: 0.24, type: 'triangle', gain: 0.18 });
    tone({ at: 0.2, freq: 311.13, glideTo: 293.66, dur: 0.4, type: 'triangle', gain: 0.16 });
  },
  roundTied() {
    if (!ready()) return;
    noise({ dur: 0.1, freq: 600, q: 0.7, type: 'lowpass', gain: 0.35 });
    tone({ at: 0.03, freq: 523.25, dur: 0.18, type: 'triangle', gain: 0.16 });
    tone({ at: 0.18, freq: 523.25, dur: 0.3, type: 'triangle', gain: 0.14 });
  },
  round(outcome) {
    if (outcome === 'won') sound.roundWon();
    else if (outcome === 'lost') sound.roundLost();
    else sound.roundTied();
  },
  finalWin() {
    if (!ready()) return;
    tone({ freq: 98, glideTo: 49, dur: 0.5, type: 'sine', gain: 0.7, attack: 0.004 });
    const fan = [[0, 523.25], [0.12, 659.25], [0.24, 783.99], [0.4, 1046.5]];
    fan.forEach(([at, f]) => { tone({ at, freq: f, dur: 0.32, type: 'triangle', gain: 0.18 }); tone({ at, freq: f * 2, dur: 0.2, type: 'sine', gain: 0.05 }); });
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => tone({ at: 0.58, freq: f, dur: 1.3, type: 'sine', gain: 0.1, attack: 0.03 }));
    for (let i = 0; i < 10; i++) tone({ at: 0.6 + i * 0.07, freq: 2200 + Math.random() * 2400, dur: 0.07, type: 'sine', gain: 0.05 });
    noise({ at: 0.58, dur: 0.9, freq: 6000, q: 0.5, type: 'highpass', gain: 0.08 });
  },
  finalLoss() {
    if (!ready()) return;
    [[0, 392], [0.22, 349.23], [0.44, 311.13], [0.7, 261.63]].forEach(([at, f], i) => tone({ at, freq: f, dur: i === 3 ? 1.1 : 0.34, type: 'triangle', gain: 0.15, attack: 0.02 }));
    tone({ at: 0.7, freq: 130.81, dur: 1.1, type: 'sine', gain: 0.2, attack: 0.03 });
  },
  finalDraw() {
    if (!ready()) return;
    [[0, 523.25], [0.16, 659.25], [0.32, 523.25], [0.48, 659.25]].forEach(([at, f]) => tone({ at, freq: f, dur: 0.3, type: 'triangle', gain: 0.14 }));
    [523.25, 659.25].forEach((f) => tone({ at: 0.64, freq: f, dur: 0.9, type: 'sine', gain: 0.1, attack: 0.03 }));
  },
  /** Sound for a table action kind. */
  action(kind) {
    if (kind === 'fold') sound.fold();
    else if (kind === 'check') sound.check();
    else if (kind === 'call') sound.chips(false);
    else if (kind === 'bet' || kind === 'raise' || kind === 'allin') sound.chips(true);
  },
};
