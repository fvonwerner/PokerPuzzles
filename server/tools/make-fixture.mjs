#!/usr/bin/env node
// Generates fake but SPEC-conformant solution files (docs/SPEC.md section 3) and
// matching explanation files (section 2.3) so the server and web app can be
// built and tested before the real solver output exists.
//
//   node server/tools/make-fixture.mjs
//
// Writes data/solutions-fixture/<id>.json and data/explanations-fixture/<id>.json.
// Preflop chart frequencies come from data/ranges.json; postflop strategies are
// a crude hand-strength heuristic; the hero's own numbers (hand.freq, hand.ev)
// are hand-picked so that every grade of SPEC section 4 can be produced.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ranges = JSON.parse(readFileSync(join(ROOT, 'data', 'ranges.json'), 'utf8'));
const CPB = ranges.chipsPerBb || 10;

const R = 'AKQJT98765432';
const SUITS = 'shdc';
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- 13x13 grid helpers ----------
function classIndex(name) {
  const a = R.indexOf(name[0]), b = R.indexOf(name[1]);
  if (a === b) return 13 * a + a;
  const hi = Math.min(a, b), lo = Math.max(a, b);
  return name[2] === 's' ? 13 * hi + lo : 13 * lo + hi;
}
function classOf(c) {
  const i = Math.floor(c / 13), j = c % 13;
  if (i === j) return { hi: i, lo: i, type: 'pair' };
  if (i < j) return { hi: i, lo: j, type: 's' };
  return { hi: j, lo: i, type: 'o' };
}
function className(c) {
  const k = classOf(c);
  return k.type === 'pair' ? R[k.hi] + R[k.hi] : R[k.hi] + R[k.lo] + k.type;
}
function combosOf(c) {
  const k = classOf(c), out = [];
  for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
    if (k.type === 'pair' && s2 <= s1) continue;
    if (k.type === 's' && s1 !== s2) continue;
    if (k.type === 'o' && s1 === s2) continue;
    out.push([R[k.hi] + SUITS[s1], R[k.lo] + SUITS[s2]]);
  }
  return out;
}
const COUNT = Array.from({ length: 169 }, (_, c) => combosOf(c).length);
function handClass(cards) {
  const [a, b] = cards;
  if (a[0] === b[0]) return a[0] + b[0];
  const [h, l] = R.indexOf(a[0]) < R.indexOf(b[0]) ? [a, b] : [b, a];
  return h[0] + l[0] + (a[1] === b[1] ? 's' : 'o');
}

function parseRange(str) {
  const w = new Array(169).fill(0);
  for (const raw of str.split(',')) {
    const tok = raw.trim(); if (!tok) continue;
    const [hand, wt] = tok.split(':');
    const weight = wt === undefined ? 1 : Number(wt);
    const plus = hand.endsWith('+');
    const h = plus ? hand.slice(0, -1) : hand;
    if (h[0] === h[1]) {
      const start = R.indexOf(h[0]);
      for (let i = plus ? 0 : start; i <= start; i++) w[13 * i + i] = weight;
    } else {
      const hi = R.indexOf(h[0]), lo = R.indexOf(h[1]), t = h[2];
      for (let k = plus ? hi + 1 : lo; k <= lo; k++) {
        w[classIndex(R[hi] + R[k] + t)] = weight;
      }
    }
  }
  return w;
}
function liveShare(c, dead) {
  const all = combosOf(c);
  return all.filter(([x, y]) => !dead.includes(x) && !dead.includes(y)).length / all.length;
}

// Crude made-hand strength in [0,1] for a class on a board, plus a little
// deterministic noise so the grids do not look like blocks.
function strength(c, board) {
  const k = classOf(c);
  const br = board.map((x) => R.indexOf(x[0])).sort((a, b) => a - b);
  const hits = [k.hi, k.lo].filter((r) => br.includes(r)).length;
  let s;
  if (k.type === 'pair' && br.includes(k.hi)) s = 0.97;
  else if (hits === 2) s = 0.92;
  else if (k.type === 'pair') s = k.hi < br[0] ? 0.82 : k.hi < br[1] ? 0.5 : 0.35;
  else if (hits === 1) {
    const r = br.includes(k.hi) ? k.hi : k.lo;
    const kick = r === k.hi ? k.lo : k.hi;
    s = r === br[0] ? 0.62 + (12 - kick) * 0.012 : r === br[1] ? 0.45 : 0.36;
  } else s = 0.08 + (12 - k.hi) * 0.012 + (k.type === 's' ? 0.06 : 0) + (k.lo - k.hi === 1 ? 0.05 : 0);
  const noise = (Math.sin(c * 12.9898 + board.length * 78.233) * 43758.5453) % 1;
  return Math.max(0, Math.min(1, s + noise * 0.05));
}

// Strategy over options for a given strength. Returns frequencies summing to 1.
function strategy(s, options) {
  const kinds = options.map((o) => o.kind);
  const f = options.map(() => 0);
  const idx = (kind, which = 'first') => {
    const ids = options.map((o, i) => (o.kind === kind ? i : -1)).filter((i) => i >= 0);
    return which === 'last' ? ids[ids.length - 1] : ids[0];
  };
  if (options.length === 1) return [1];
  if (kinds.includes('fold')) {
    const fo = idx('fold'), ca = idx('call'), ra = idx('raise') ?? idx('allin');
    let p = s >= 0.85 ? [0, 0.5, 0.5] : s >= 0.45 ? [0.08, 0.84, 0.08] : s >= 0.25 ? [0.5, 0.4, 0.1] : [0.86, 0.04, 0.1];
    f[fo] = p[0]; if (ca !== undefined) f[ca] += p[1]; else f[fo] += p[1];
    if (ra !== undefined) f[ra] += p[2]; else f[ca ?? fo] += p[2];
  } else {
    const ch = idx('check'), bs = idx('bet'), bl = idx('bet', 'last');
    let p = s >= 0.8 ? [0.1, 0.3, 0.6] : s >= 0.55 ? [0.3, 0.6, 0.1] : s >= 0.3 ? [0.82, 0.16, 0.02] : [0.5, 0.35, 0.15];
    f[ch] = p[0];
    if (bs === undefined) f[ch] += p[1] + p[2];
    else if (bs === bl) f[bs] += p[1] + p[2];
    else { f[bs] += p[1]; f[bl] += p[2]; }
  }
  // wobble with the strength so neighbouring classes differ
  const wob = (s * 7.3) % 0.1 - 0.05;
  const big = f.indexOf(Math.max(...f));
  const second = f.map((x, i) => (i === big ? -1 : x)).indexOf(Math.max(...f.filter((_, i) => i !== big)));
  if (second >= 0) { const d = Math.min(f[big], Math.max(-f[second], wob)); f[big] -= d; f[second] += d; }
  return normalise(f);
}
function normalise(f) {
  const sum = f.reduce((a, b) => a + b, 0) || 1;
  const out = f.map((x) => r3(x / sum));
  const drift = r3(1 - out.reduce((a, b) => a + b, 0));
  out[out.indexOf(Math.max(...out))] = r3(out[out.indexOf(Math.max(...out))] + drift);
  return out;
}

function rangeNode(w, f, extra = {}) {
  let combos = 0;
  const k = f[0].length, tot = new Array(k).fill(0);
  for (let c = 0; c < 169; c++) {
    const cw = w[c] * COUNT[c]; combos += cw;
    for (let o = 0; o < k; o++) tot[o] += cw * f[c][o];
  }
  return {
    w: w.map(r3),
    f: f.map((row, c) => (w[c] === 0 ? row.map(() => 0) : row.map(r3))),
    freq: normalise(tot.map((x) => x / (combos || 1))),
    ...extra,
    combos: r2(combos),
  };
}
function weightsAfter(w, f, k) { return w.map((x, c) => x * f[c][k]); }

// ---------- options ----------
const chips = (bb) => Math.round(bb * CPB);
const O = {
  fold: () => ({ id: 'fold', kind: 'fold', label: 'Fold' }),
  check: () => ({ id: 'check', kind: 'check', label: 'Check' }),
  call: (add) => ({ id: 'call', kind: 'call', amount: r2(add), label: `Call ${r2(add)}` }),
  bet: (pot, pct) => {
    const amount = Math.round(pot * pct * CPB) / CPB;
    const pctPot = Math.round((100 * amount) / pot);
    return { id: `bet_${chips(amount)}`, kind: 'bet', amount, pctPot, label: `Bet ${amount} (${pctPot}%)` };
  },
  raise: (to, label) => ({ id: `raise_${chips(to)}`, kind: 'raise', amount: r2(to), label: label || `Raise to ${r2(to)}` }),
  allin: (to) => ({ id: 'allin', kind: 'allin', amount: r2(to), label: `All-in ${r2(to)}` }),
};

// ---------- money tracking ----------
class Money {
  constructor(heroSeat, villainSeat) {
    this.hero = { seat: heroSeat, stack: 100, bet: 0 };
    this.villain = { seat: villainSeat, stack: 100, bet: 0 };
    this.pot = 1.5;
    for (const p of [this.hero, this.villain]) {
      if (p.seat === 'SB') { p.stack = 99.5; p.bet = 0.5; }
      if (p.seat === 'BB') { p.stack = 99; p.bet = 1; }
    }
  }
  who(seat) { return seat === this.hero.seat ? this.hero : seat === this.villain.seat ? this.villain : null; }
  to(seat, total) {
    const p = this.who(seat); if (!p) return;
    const add = total - p.bet; p.stack = r2(p.stack - add); p.bet = r2(total); this.pot = r2(this.pot + add);
  }
  add(seat, amount) { const p = this.who(seat); this.to(seat, r2(p.bet + amount)); }
  street() { this.hero.bet = 0; this.villain.bet = 0; }
  state() {
    return { pot: r2(this.pot), heroStack: r2(this.hero.stack), villainStack: r2(this.villain.stack), heroBet: r2(this.hero.bet), villainBet: r2(this.villain.bet) };
  }
}
function applyOption(m, seat, opt) {
  if (opt.kind === 'call') m.add(seat, opt.amount);
  else if (opt.kind === 'bet') m.to(seat, opt.amount);
  else if (opt.kind === 'raise' || opt.kind === 'allin') m.to(seat, opt.amount);
}

// ---------- puzzle builder ----------
function build(def) {
  const sc = ranges.scenarios[def.scenario];
  const heroSide = def.hero; // 'ip' | 'oop'
  const vilSide = heroSide === 'ip' ? 'oop' : 'ip';
  const heroSeat = sc[heroSide].seat, vilSeat = sc[vilSide].seat;
  const tree = FIXTURE_TREES[sc.tree] || ranges.trees[sc.tree];
  const hand = [def.hand.slice(0, 2), def.hand.slice(2, 4)];
  const hClass = handClass(hand);
  const hIdx = classIndex(hClass);
  const board = { flop: [def.flop.slice(0, 2), def.flop.slice(2, 4), def.flop.slice(4, 6)], turn: def.turn, river: def.river };
  const m = new Money(heroSeat, vilSeat);
  const steps = [];
  let dIndex = 0;
  const decisions = def.decisions.slice();
  const villainActs = def.villain.slice();
  let street = 'preflop';
  let dead = [];

  // preflop
  const chartRaiseWeights = {};
  for (const e of sc.preflop) {
    if (e.seat === heroSeat && e.chart) {
      const chart = ranges.charts[e.chart];
      const dec = decisions.shift();
      const opts = chart.options.map((o) => {
        if (o.kind === 'fold') return O.fold();
        if (o.kind === 'call') return O.call(r2(o.amount - m.who(heroSeat).bet));
        return O.raise(o.amount, o.label.replace(/ to /, ' to '));
      });
      const actW = {};
      for (const o of chart.options) if (o.kind !== 'fold') actW[o.id] = parseRange(chart.ranges[o.id]);
      const f = Array.from({ length: 169 }, (_, c) => {
        const row = chart.options.map((o) => (o.kind === 'fold' ? 0 : actW[o.id][c]));
        row[0] = Math.max(0, 1 - row.reduce((a, b) => a + b, 0));
        return row.map(r3);
      });
      const w = e.chart.includes('3bet') && def.facingWeights ? def.facingWeights : new Array(169).fill(1);
      const state = m.state();
      const mainIdx = chart.options.findIndex((o) => o.id === e.kind || o.kind === e.kind);
      const mainOpt = opts[mainIdx];
      applyOption(m, heroSeat, mainOpt);
      steps.push({
        type: 'decision', index: dIndex++, street: 'preflop', source: 'chart', state,
        toCall: r2(Math.max(0, (e.chart.endsWith('_RFI') ? 1 : m.villain.bet) - state.heroBet)),
        options: opts,
        hand: { freq: f[hIdx], ev: null, equity: null },
        mainLine: mainOpt.id,
        stateAfter: m.state(),
        range: rangeNode(w, f.map((row, c) => (w[c] ? row : row.map(() => 0))), { equity: null }),
        villainRange: null,
      });
      if (e.kind === 'raise') chartRaiseWeights[e.chart] = actW.raise;
    } else {
      const step = { type: 'action', street: 'preflop', seat: e.seat, kind: e.kind };
      if (e.kind !== 'fold') {
        step.amount = e.amount;
        if (m.who(e.seat)) m.to(e.seat, e.amount);
        else m.pot = r2(m.pot + e.amount); // never happens in these scenarios
        step.state = m.state();
      }
      steps.push(step);
    }
  }

  // postflop ranges
  const sideRange = (side) => parseRange(ranges.charts[sc[side].chart].ranges[sc[side].action]);
  let heroW = sideRange(heroSide), vilW = sideRange(vilSide);

  const streets = [['flop', board.flop], ['turn', [board.turn]], ['river', [board.river]]];
  let ended = null;
  for (const [st, cards] of streets) {
    if (ended) break;
    street = st; dead = dead.concat(cards);
    const live = dead.slice();
    heroW = heroW.map((x, c) => x * liveShare(c, live));
    vilW = vilW.map((x, c) => x * liveShare(c, live));
    m.street();
    steps.push({ type: 'deal', street: st, cards, state: m.state() });
    const sizes = tree[st];
    // order: oop first
    const order = [heroSide === 'oop' ? 'hero' : 'villain', heroSide === 'oop' ? 'villain' : 'hero'];
    let actor = 0, streetOver = false, facing = null, lastAggressor = null, acted = 0;
    while (!streetOver && !ended) {
      const who = order[actor % 2];
      const side = who === 'hero' ? heroSide : vilSide;
      const seat = who === 'hero' ? heroSeat : vilSeat;
      const me = m.who(seat), other = who === 'hero' ? m.villain : m.hero;
      let opts;
      if (facing) {
        const raiseTo = r2(Math.min(me.stack + me.bet, other.bet * Number((sizes[side + 'Raise'] || '3x').replace('x', ''))));
        opts = [O.fold(), O.call(r2(other.bet - me.bet))];
        if (raiseTo >= me.stack + me.bet) opts.push(O.allin(r2(me.stack + me.bet)));
        else opts.push(O.raise(raiseTo));
      } else {
        const bets = (sizes[side + 'Bet'] || '').split(',').filter(Boolean).map((p) => Number(p.replace('%', '')) / 100);
        opts = [O.check(), ...bets.map((p) => O.bet(m.pot, p))];
      }
      const state = m.state();
      if (opts.length === 1) {
        steps.push({ type: 'action', street: st, seat, kind: opts[0].kind, state });
        actor++; acted++;
        continue;
      }
      if (who === 'villain') {
        const token = villainActs.shift();
        const boardNow = dead;
        const f = Array.from({ length: 169 }, (_, c) => strategy(strength(c, boardNow), opts));
        const range = rangeNode(vilW, f);
        const k = opts.findIndex((o) => o.id === token || o.kind === token);
        if (k < 0) throw new Error(`${def.id}: villain token ${token} not in ${opts.map((o) => o.id)}`);
        const opt = opts[k];
        applyOption(m, seat, opt);
        vilW = weightsAfter(vilW, f, k);
        steps.push({ type: 'villain', street: st, seat, action: opt, freq: range.freq[k], options: opts, range, state: m.state() });
        if (opt.kind === 'fold') { ended = { reason: 'villain_fold' }; break; }
        if (opt.kind === 'bet' || opt.kind === 'raise' || opt.kind === 'allin') { facing = true; lastAggressor = 'villain'; }
        else if (opt.kind === 'call') { streetOver = true; if (opt.kind === 'call' && me.stack === 0) ended = { reason: 'showdown' }; }
        else if (opt.kind === 'check' && acted >= 1) streetOver = true;
      } else {
        const d = decisions.shift();
        if (!d) throw new Error(`${def.id}: missing hero decision`);
        if (d.options && d.options.join() !== opts.map((o) => o.id).join()) {
          throw new Error(`${def.id}: expected options ${d.options} got ${opts.map((o) => o.id)}`);
        }
        const f = Array.from({ length: 169 }, (_, c) => strategy(strength(c, dead), opts));
        f[hIdx] = d.freq.slice();
        const range = rangeNode(heroW, f, { equity: d.rangeEquity });
        const k = opts.findIndex((o) => o.id === d.main || o.kind === d.main);
        const opt = opts[k];
        const toCall = facing ? r2(other.bet - me.bet) : 0;
        const villainRange = { w: vilW.map(r3), equity: r3(1 - d.rangeEquity), combos: r2(vilW.reduce((a, x, c) => a + x * COUNT[c], 0)) };
        applyOption(m, seat, opt);
        heroW = weightsAfter(heroW, f, k);
        steps.push({
          type: 'decision', index: dIndex++, street: st, source: 'solver', state,
          toCall,
          options: opts,
          hand: { freq: d.freq, ev: d.ev, equity: d.equity },
          mainLine: opt.id,
          stateAfter: m.state(),
          range, villainRange,
        });
        if (opt.kind === 'fold') { ended = { reason: 'hero_fold' }; break; }
        if (opt.kind === 'bet' || opt.kind === 'raise' || opt.kind === 'allin') { facing = true; lastAggressor = 'hero'; }
        else if (opt.kind === 'call') streetOver = true;
        else if (opt.kind === 'check' && acted >= 1) streetOver = true;
      }
      void lastAggressor;
      actor++; acted++;
    }
  }
  if (!ended) ended = { reason: 'showdown' };
  if (decisions.length || villainActs.length) throw new Error(`${def.id}: unused script entries`);

  m.street();
  const heroIn = r2(100 - m.hero.stack);
  const end = { type: 'end', reason: ended.reason, state: m.state(), showdown: null, heroNet: 0 };
  if (ended.reason === 'hero_fold') end.heroNet = r2(-heroIn);
  else if (ended.reason === 'villain_fold') end.heroNet = r2(m.pot - heroIn);
  else {
    end.showdown = { villainHand: def.showdown.villainHand, winner: def.showdown.winner, heroHandName: def.showdown.heroHandName, villainHandName: def.showdown.villainHandName };
    end.heroNet = def.showdown.winner === 'hero' ? r2(m.pot - heroIn) : def.showdown.winner === 'split' ? r2(m.pot / 2 - heroIn) : r2(-heroIn);
  }
  steps.push(end);

  return {
    version: 1,
    id: def.id,
    title: def.title,
    tags: def.tags,
    scenario: { key: def.scenario, name: sc.name, potType: sc.potType },
    hero: { seat: heroSeat, position: heroSide, hand, handClass: hClass },
    villain: { seat: vilSeat, position: vilSide },
    startingStackBb: 100,
    board,
    solver: { exploitabilityPctPot: 0.3, iterations: 400, memoryMb: 1800, seconds: 60 },
    warnings: ['fixture: fake numbers generated by server/tools/make-fixture.mjs'],
    decisionCount: dIndex,
    steps,
  };
}

// Bet sizes are fixed here (a copy of the original ranges.json trees) so the
// fixtures and the smoke test's hand-computed grades do not change when the
// real trees are tuned. Preflop charts still come from data/ranges.json.
const FIXTURE_TREES = {
  SRP_IP_AGGRESSOR: {
    flop: { oopBet: '', oopRaise: '3x', ipBet: '33%,75%', ipRaise: '3x' },
    turn: { oopBet: '66%,125%', oopRaise: '3x', ipBet: '66%,125%', ipRaise: '3x' },
    river: { oopBet: '50%,125%', oopRaise: '3x', ipBet: '50%,125%', ipRaise: '3x' },
  },
  '3BP_OOP_AGGRESSOR': {
    flop: { oopBet: '25%,60%', oopRaise: '2.5x', ipBet: '25%,60%', ipRaise: '2.5x' },
    turn: { oopBet: '50%,100%', oopRaise: '2.5x', ipBet: '50%,100%', ipRaise: '2.5x' },
    river: { oopBet: '50%,100%', oopRaise: '2.5x', ipBet: '50%,100%', ipRaise: '2.5x' },
  },
};

// ---------- the fixture puzzles ----------
const defs = [
  {
    // SRP, hero in position, ends at showdown. Decision 3 has Best / Wrong / Blunder.
    id: 'fx01', title: 'Top pair on a dry queen-high board', scenario: 'BTN_BB_SRP', hero: 'ip',
    hand: 'AhQd', flop: 'Qs7d2c', turn: '5h', river: 'Kc', tags: ['value', 'fixture'],
    villain: ['call', 'check', 'bet_46'],
    decisions: [
      {}, // preflop chart
      { options: ['check', 'bet_18', 'bet_41'], freq: [0.22, 0.71, 0.07], ev: [4.02, 4.1, 3.95], equity: 0.86, rangeEquity: 0.57, main: 'bet_18' },
      { options: ['check', 'bet_60', 'bet_114'], freq: [0.66, 0.32, 0.02], ev: [5.1, 5.06, 4.98], equity: 0.81, rangeEquity: 0.58, main: 'check' },
      { options: ['fold', 'call', 'raise_138'], freq: [0, 0.98, 0.02], ev: [0, 3.9, 3.5], equity: 0.44, rangeEquity: 0.49, main: 'call' },
    ],
    showdown: { villainHand: ['Kh', 'Jc'], winner: 'villain', heroHandName: 'Pair of queens', villainHandName: 'Pair of kings' },
  },
  {
    // SRP, hero out of position facing a bet, forced flop check, ends in a hero fold.
    id: 'fx02', title: 'Defending the big blind with a flush draw', scenario: 'BTN_BB_SRP', hero: 'oop',
    hand: '9h8h', flop: 'Kh7h3c', turn: '2s', river: 'Jd', tags: ['draw', 'fixture'],
    villain: ['bet_18', 'bet_60'],
    decisions: [
      {},
      { options: ['fold', 'call', 'raise_54'], freq: [0, 0.42, 0.58], ev: [0, 1.31, 1.33], equity: 0.38, rangeEquity: 0.44, main: 'call' },
      { options: ['check', 'bet_60', 'bet_114'], freq: [0.81, 0.12, 0.07], ev: [1.05, 0.98, 0.9], equity: 0.3, rangeEquity: 0.45, main: 'check' },
      { options: ['fold', 'call', 'raise_180'], freq: [0.36, 0.52, 0.12], ev: [0, 0.05, -0.35], equity: 0.22, rangeEquity: 0.41, main: 'fold' },
    ],
  },
  {
    // 3-bet pot, two preflop hero decisions (open, then call the 3-bet), ends in a villain fold.
    id: 'fx03', title: 'Raising a c-bet in a 3-bet pot', scenario: 'BTN_BB_3BP', hero: 'ip',
    hand: 'AhJh', flop: 'Td8h3h', turn: '6s', river: '2d', tags: ['draw', '3bet', 'fixture'],
    facingWeights: null, // filled below with BTN_RFI raise weights
    villain: ['bet_56', 'fold'],
    decisions: [
      {},
      {},
      { options: ['fold', 'call', 'raise_140'], freq: [0.02, 0.61, 0.37], ev: [0, 2.4, 2.38], equity: 0.47, rangeEquity: 0.46, main: 'raise' },
    ],
  },
];
defs[2].facingWeights = parseRange(ranges.charts.BTN_RFI.ranges.raise);

const explanations = {
  fx01: {
    decisions: {
      '0': 'Ace-queen offsuit is a clear open from the button. It is near the top of the opening range and plays well against both blinds.',
      '1': 'On a dry queen-high board your range has every strong queen and overpair, so a small bet with most of it is the natural strategy. Top pair, top kicker bets almost always; checking occasionally keeps your checking range from being too weak.',
      '2': 'After the flop call, the five changes little but your hand has less to gain from big bets: worse queens and sevens will call one more bet, but rarely two. Checking back protects your checking range and controls the pot.',
      '3': 'The king on the river is a good card for the caller, who has many king-x hands, but villain also bluffs with missed hands. Folding top pair, top kicker gives up too much; raising only folds out worse.',
    },
    takeaway: 'Top pair with a good kicker on a dry board wants a small bet on the flop, a check on the turn and a bluff-catch on the river.',
  },
  fx02: {
    decisions: {
      '0': 'Nine-eight suited plays well in position-poor spots because it makes straights and flushes. It is a pure defend against a button open.',
      '1': 'With a flush draw and a backdoor straight draw you have plenty of equity against a small c-bet. Raising and calling are almost tied; raising wins the pot right away more often.',
      // decision 2 intentionally missing: the server must generate a sentence
      '3': 'The deuce bricked your draws, and a two-thirds pot bet gets a lot of value from the button. Calling is barely profitable; folding is close.',
    },
    takeaway: 'Big draws can raise small c-bets; when the turn bricks, the price matters more than the draw.',
  },
  // fx03 has no explanation file at all
};

const solDir = join(ROOT, 'data', 'solutions-fixture');
const expDir = join(ROOT, 'data', 'explanations-fixture');
mkdirSync(solDir, { recursive: true });
mkdirSync(expDir, { recursive: true });
for (const def of defs) {
  const sol = build(def);
  writeFileSync(join(solDir, `${def.id}.json`), JSON.stringify(sol) + '\n');
  if (explanations[def.id]) writeFileSync(join(expDir, `${def.id}.json`), JSON.stringify(explanations[def.id], null, 2) + '\n');
  const shape = sol.steps.map((s) => (s.type === 'decision' ? `D${s.index}:${s.mainLine}` : s.type === 'villain' ? `V:${s.action.id}` : s.type === 'action' ? `${s.seat}:${s.kind}` : s.type === 'deal' ? `|${s.street}` : `END:${s.reason}`)).join(' ');
  console.log(`${def.id}  ${sol.hero.seat} ${sol.hero.handClass}  ${sol.decisionCount} decisions  net ${sol.steps.at(-1).heroNet}\n   ${shape}`);
}
console.log(`wrote ${defs.length} solutions to ${solDir}`);
console.log(`wrote ${Object.keys(explanations).length} explanation files to ${expDir}`);
