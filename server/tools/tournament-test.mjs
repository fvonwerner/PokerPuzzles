#!/usr/bin/env node
// Tests of web/js/pushfold.js (the Tournament rules shared by the server and
// the browser) against the REAL solver files. No dependencies:
//   node server/tools/tournament-test.mjs
// Reads (read-only) data/tournament/spots/*.json and data/tournament/quiz.json
// (TOURNAMENT_DIR overrides). Every check is counted; failures are listed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../../web/js/pushfold.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = existsSync(join(ROOT, 'data', 'tournament')) ? join(ROOT, 'data') : join(ROOT, '..', 'data');
const DIR = process.env.TOURNAMENT_DIR ? resolve(ROOT, process.env.TOURNAMENT_DIR) : join(DATA, 'tournament');

let passed = 0, failed = 0;
const fails = [];
function check(cond, msg) {
  if (cond) passed++;
  else { failed++; fails.push(msg); }
}
const has = (text, s) => text.includes(s);
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const section = (t) => console.log(`# ${t}`);

/** A small seeded generator, so a failing sample can be replayed. */
function rng(seed) {
  let h = seed >>> 0 || 1;
  return () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}

const files = readdirSync(join(DIR, 'spots')).filter((f) => f.endsWith('.json')).sort();
const raw = new Map();
const spots = files.map((f) => {
  const j = JSON.parse(readFileSync(join(DIR, 'spots', f), 'utf8'));
  raw.set(j.spec.name, j);
  return P.normalizeSpot(j);
});
const byName = new Map(spots.map((s) => [s.name, s]));
console.log(`${spots.length} spots from ${DIR}`);
check(spots.length === 75, `75 spots loaded (${spots.length})`);

// ---------------------------------------------------------------- basics
section('classes, cards, formats');
check(P.CLASSES.length === 169 && P.CLASSES[0] === 'AA' && P.CLASSES[1] === 'AKs' && P.CLASSES[13] === 'AKo' && P.CLASSES[12] === 'A2s' && P.CLASSES[156] === 'A2o' && P.CLASSES[168] === '22', 'grid order of the classes');
for (const s of spots) check(raw.get(s.name).classes.every((n, c) => n === P.CLASSES[c]), `${s.name}: the file's classes are the grid order`);
{
  const r = rng(7);
  let ok = true;
  for (let i = 0; i < 20000; i++) {
    const c = Math.floor(r() * 169);
    const cards = P.cardsForClass(P.CLASSES[c], r);
    if (P.classOfCards(cards) !== P.CLASSES[c]) { ok = false; break; }
  }
  check(ok, 'cardsForClass gives two cards of the class (20000 draws)');
  check(P.classOfCards(['Kc', '9d']) === 'K9o' && P.classOfCards(['9d', 'Kd']) === 'K9s' && P.classOfCards(['7s', '7c']) === '77' && P.classOfCards(['7s', '7s']) === null && P.classOfCards(['Xx', '7s']) === null, 'classOfCards');
  const counts = {};
  const r2 = rng(11);
  for (let i = 0; i < 12000; i++) { const [a, b] = P.cardsForClass('AKo', r2); counts[a[1] + b[1]] = (counts[a[1] + b[1]] || 0) + 1; }
  check(Object.keys(counts).length === 12 && Object.values(counts).every((n) => n > 800 && n < 1200), `offsuit suits are uniform over the 12 combos (${JSON.stringify(counts)})`);
}
check(P.fmtEv(0.3123, 'bb') === '+0.31 bb' && P.fmtEv(-1.1, 'bb') === '−1.10 bb' && P.fmtEv(-0.0001, 'bb') === '0.00 bb' && P.fmtEv(0.0514, 'points') === '+0.051 points', 'fmtEv: bb 2 decimals, points 3, signed');
check(P.fmtErr(0.0089, 'bb') === '±0.02' && P.fmtErr(0.0021, 'bb') === '±<0.01' && P.fmtErr(0.0009, 'points') === '±0.002', 'fmtErr: two standard errors');
check(P.fmtCost(0.31, 0.01, 'bb', false) === '0.31 bb (±0.02)' && P.fmtCost(-0.31, 0, 'bb', true) === '0.31 bb (exact)', 'fmtCost');
check(P.fmtPct(13.3) === '13%' && P.fmtPct(0.4) === '<1%' && P.fmtPct(99.6) === '>99%' && P.fmtPct(100) === '100%' && P.fmtPct(0) === '0%', 'fmtPct: whole, never 0% for something, never 100% for a mix');
{
  const [a, b] = P.pctPair(0.4542, 0.4501); const [c, d] = P.pctPair(0.4549, 0.4501); const [e, f] = P.pctPair(0.41, 0.46);
  check(a === '45.4%' && b === '45.0%' && c === '45.5%' && d === '45.0%' && e === '41%' && f === '46%', `pctPair keeps the order visible (${a} ${b} / ${c} ${d} / ${e} ${f})`);
}
check(P.ordinal(1) === '1st' && P.ordinal(2) === '2nd' && P.ordinal(3) === '3rd' && P.ordinal(4) === '4th' && P.ordinal(6) === '6th', 'ordinals');
check(JSON.stringify(P.normalizePrefs({ value: 'x', players: '9', stack: '11', seat: 'XX', kind: 'q', hands: 'z' })) === JSON.stringify(P.DRILL_DEFAULTS), 'bad drill choices fall back to the defaults');
check(P.normalizePrefs({ value: 'points', players: '4', situation: 'points-n4-co25-btn9-sb6-bb10', stack: 8 }).stack === 'any' && P.normalizePrefs({ value: 'points', players: '4', situation: 'points-n4-co25-btn9-sb6-bb10' }).situation === 'points-n4-co25-btn9-sb6-bb10' && P.normalizePrefs({ value: 'points', situation: 'points-n4-co25-btn9-sb6-bb10' }).situation === 'any', 'stack only with chips, a situation only with points and a table size');

// ---------------------------------------------------------------- scale, askable
section('scale and askable decisions');
for (const s of spots) {
  const f = raw.get(s.name);
  if (s.units === 'points') {
    const p = f.spec.payoff.payouts, total = f.stacks.reduce((a, b) => a + b, 0);
    check(near(P.scaleOf(s), (p[0] - p[p.length - 1]) / total, 1e-12), `${s.name}: scale = (first - last) / bb on the table`);
    check(p.length === s.seats.length && p.every((x, i) => x === [15, 8, 5, 3, 2, 1][i]), `${s.name}: the league's payouts for ${s.seats.length} left`);
  } else check(P.scaleOf(s) === 1, `${s.name}: chip scale 1`);
  for (const d of s.decisions) {
    const want = d.facing.length === 0 || (d.facing.length === 1 && (s.seats.length === 2 || d.reach >= 0.01));
    check(P.isAskable(s, d) === want, `${s.name} ${d.id}: askable ${want}`);
  }
}
const askable = [];
for (const s of spots) for (const d of s.decisions) if (P.isAskable(s, d)) askable.push([s, d]);
check(askable.length === 750, `750 askable decisions (${askable.length})`);
check(spots.filter((s) => s.seats.length === 2).every((s) => s.decisions.every((d) => P.isAskable(s, d))), 'heads-up: both decisions are always asked');

// ---------------------------------------------------------------- the verdict
section('the verdict for every askable decision, class and answer');
let nCells = 0, nClose = 0, nContra = 0;
for (const [s, d] of askable) {
  const scale = P.scaleOf(s);
  for (let c = 0; c < 169; c++) {
    const dd = d.ev_diff[c], se = d.ev_diff_se[c], f = d.freq[c];
    if (dd === null) { check(P.verdict(s, d, c, 'fold') === null, `${s.name} ${d.id} ${P.CLASSES[c]}: no EVs, no verdict`); continue; }
    nCells++;
    const close = Math.abs(dd) <= Math.max(2.5 * se, 0.02 * scale) + 1e-9 || (f >= 0.05 - 1e-9 && f <= 0.95 + 1e-9);
    if (close) nClose++;
    const better = dd > 0 ? 'allin' : 'fold';
    for (const action of ['fold', 'allin']) {
      const v = P.verdict(s, d, c, action);
      const tag = `${s.name} ${d.id} ${P.CLASSES[c]} ${action}`;
      if (close) {
        if (!(v.close && v.right && v.grade === 'correct' && v.cost === 0 && v.best === null)) check(false, `${tag}: close: either answer right, Correct, no cost`);
        else passed++;
      } else {
        const right = action === better;
        const ratio = Math.abs(dd) / scale;
        const grade = right ? 'best' : ratio < 0.10 ? 'inaccuracy' : ratio < 0.50 ? 'wrong' : 'blunder';
        if (!(!v.close && v.best === better && v.right === right && v.grade === grade && v.label === P.GRADE_LABELS[grade] && v.cost === (right ? 0 : Math.abs(dd)))) check(false, `${tag}: best by the sign of ev_diff (${dd}), grade ${grade} (got ${JSON.stringify({ close: v.close, best: v.best, right: v.right, grade: v.grade, cost: v.cost })})`);
        else passed++;
      }
    }
    if (!close && ((dd > 0 && f < 0.05) || (dd < 0 && f > 0.95))) nContra++;
    const v = P.verdict(s, d, c, 'fold', { forceClose: true });
    if (!(v.close && v.right && v.grade === 'correct')) check(false, `${s.name} ${d.id} ${P.CLASSES[c]}: forceClose grades as close`);
  }
}
console.log(`  ${nCells} cells, ${nClose} too close to call, ${nContra} where the solver's pure play disagrees with the sign of a clear ev_diff`);
check(nCells === 750 * 169, `every askable cell has EVs (${nCells})`);
check(nContra === 0, `at the askable decisions the stored strategy never contradicts its own EVs outside the close band (${nContra})`);

// ---------------------------------------------------------------- facts
section('facts: every number satisfies its identity');
/** The exact bust rule by brute force: every set of callers behind, every order of hand strengths, side pots settled. */
function bustTruth(s, d) {
  const H = s.stacks[d.position];
  const N = s.seats.length;
  const jam = d.facing.map((seat) => ({ seat, stack: s.stacks[s.seats.indexOf(seat)] }));
  const behind = s.seats.map((seat, i) => ({ seat, stack: s.stacks[i], i })).filter((x) => x.i > d.position);
  let canBust = false;
  const changers = new Set();
  const perms = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
  for (let mask = 0; mask < 1 << behind.length; mask++) {
    const players = [{ seat: 'HERO', stack: H }, ...jam, ...behind.filter((_, k) => mask & (1 << k))];
    if (players.length < 2) continue;
    for (const order of perms(players.map((_, k) => k))) { // order[0] has the best hand
      const fin = players.map(() => 0);
      const levels = [...new Set(players.map((p) => p.stack))].sort((a, b) => a - b);
      let prev = 0;
      for (const L of levels) {
        const elig = players.map((p, k) => k).filter((k) => players[k].stack >= L);
        const amount = (L - prev) * elig.length;
        const winner = order.find((k) => elig.includes(k));
        fin[winner] += amount;
        prev = L;
      }
      // uncalled chips over the second-biggest stack come back (they are a level of one player)
      const out = players.map((p, k) => fin[k] <= 1e-9);
      if (!out[0]) continue;
      canBust = true;
      players.forEach((p, k) => { if (k > 0 && out[k] && p.stack <= H + 1e-9) changers.add(p.seat); });
    }
  }
  return { canBust, changers: [...changers].sort(), place: N, points: s.payouts?.[N - 1] };
}
let nFacts = 0;
for (const [s, d] of askable) {
  const sit = P.situation(s, d);
  const H = s.stacks[d.position];
  const posted = (i) => s.posted.live[i] + s.posted.dead[i];
  const tag = `${s.name} ${d.id}`;
  // the situation itself
  check(sit.hero.seat === d.seat && sit.seats.length === s.seats.length, `${tag}: the hero`);
  const pot = s.seats.reduce((a, seat, i) => a + (i < d.position && d.facing.includes(seat) ? s.stacks[i] : posted(i)), 0);
  check(near(sit.pot, pot, 1e-9), `${tag}: the pot is everybody's forced bets plus the all-ins (${sit.pot} vs ${pot})`);
  check(sit.seats.filter((x) => x.status === 'allin').map((x) => x.seat).join() === d.facing.join(), `${tag}: who is all-in`);
  check(sit.seats.filter((x) => x.status === 'folded').every((x) => x.index < d.position && !d.facing.includes(x.seat)), `${tag}: who folded`);
  const cls = [0, 13, 60, 84, 100, 168]; // a few classes for the per-class facts; the price is checked for all classes below
  for (const c of cls) {
    const fs = P.facts(s, d, c);
    const keys = fs.map((f) => f.key);
    nFacts += fs.length;
    if (d.facing.length === 0) {
      const waiting = s.seats.slice(d.position + 1);
      const behind = fs.find((f) => f.key === 'behind');
      check(!!behind && behind.values.map((v) => v.seat).join() === waiting.join(), `${tag}: "behind" names everybody still to act, in order`);
      for (const v of behind?.values || []) {
        const dx = s.decisions.find((x) => x.seat === v.seat && x.facing.length === 1 && x.facing[0] === d.seat);
        check(dx && v.pct === dx.allin_pct && has(behind.text, `${v.seat} `) && has(behind.text, P.fmtPct(dx.allin_pct)), `${tag}: ${v.seat} calls ${dx?.allin_pct}% = allin_pct of ${dx?.id}`);
      }
      const pk = fs.find((f) => f.key === 'pickup');
      const pickup = s.seats.reduce((a, _, i) => a + (i === d.position ? 0 : posted(i)), 0);
      const maxBehind = Math.max(...waiting.map((seat) => s.stacks[s.seats.indexOf(seat)]));
      const risk = Math.min(H, maxBehind);
      check(!!pk && near(pk.values.pickup, pickup, 1e-9) && near(pk.values.risk, risk, 1e-9) && has(pk.text, `win ${P.fmtChips(pickup)} bb`) && has(pk.text, `up to ${P.fmtChips(risk)} bb`), `${tag}: pick-up ${pickup} against a risk of ${risk}`);
      check(!keys.includes('jammer') && !keys.includes('price'), `${tag}: no facing-an-all-in facts first in`);
    } else {
      const j = d.facing[0];
      const jd = s.decisions.find((x) => x.seat === j && x.facing.length === 0);
      const jf = fs.find((f) => f.key === 'jammer');
      check(!!jf && jf.values.pct === jd.allin_pct && has(jf.text, `${j} `) && has(jf.text, P.fmtPct(jd.allin_pct)), `${tag}: ${j} jams ${jd.allin_pct}% (allin_pct of ${jd.id})`);
      const waiting = s.seats.slice(d.position + 1);
      if (waiting.length) {
        const bc = fs.find((f) => f.key === 'behindCall');
        check(!!bc && bc.values.seats.join() === waiting.join() && !keys.includes('price'), `${tag}: players behind named, no price sentence`);
        for (const v of bc?.values.calls || []) {
          const dx = s.decisions.find((x) => x.seat === v.seat && x.facing.length === 2 && x.facing.includes(j) && x.facing.includes(d.seat));
          check(dx && v.pct === dx.allin_pct && has(bc.text, P.fmtPct(dx.allin_pct)), `${tag}: ${v.seat} over-calls ${dx?.allin_pct}% (allin_pct of ${dx?.id})`);
        }
      } else check(s.units === 'bb' ? keys.includes('price') : !keys.includes('price'), `${tag}: the price sentence exactly in chip spots where you close the action`);
    }
    if (s.units === 'points') {
      const b = fs.find((f) => f.key === 'bust');
      const t = bustTruth(s, d);
      check(!!b && b.values.canBust === t.canBust, `${tag}: can you go out (brute force: ${t.canBust})`);
      if (b && t.canBust) {
        check(b.values.place === t.place && b.values.points === t.points && has(b.text, `${P.ordinal(t.place)} place`) && has(b.text, `${P.fmtPoints(t.points)} point`), `${tag}: out in ${t.place}th: ${t.points} points`);
        check([...b.values.coBusters].sort().join() === t.changers.join(), `${tag}: the "unless" players are exactly those who can go out with you with no more chips (${b.values.coBusters} vs ${t.changers})`);
        const jStack = d.facing.length ? s.stacks[s.seats.indexOf(d.facing[0])] : 0;
        check(has(b.text, 'Call and lose') === (d.facing.length === 1 && jStack >= H), `${tag}: "Call and lose" exactly when the jammer covers you`);
      }
      check(keys.includes('units'), `${tag}: points: the EVs are league points`);
    } else check(!keys.includes('bust') && !keys.includes('units'), `${tag}: chips: no points facts`);
  }
}
console.log(`  ${nFacts} fact sentences checked`);

section('the price of a call when you close the action (chips), every class');
let nPrice = 0;
for (const [s, d] of askable) {
  if (s.units !== 'bb' || d.facing.length !== 1 || d.position !== s.seats.length - 1) continue;
  const i = d.position, j = s.seats.indexOf(d.facing[0]);
  const posted = (k) => s.posted.live[k] + s.posted.dead[k];
  const eff = Math.min(s.stacks[i], s.stacks[j]);
  const dead = s.seats.reduce((a, _, k) => a + (k !== i && k !== j ? posted(k) : 0), 0);
  const pot = 2 * eff + dead, cost = eff - posted(i);
  for (let c = 0; c < 169; c++) {
    const f = P.facts(s, d, c).find((x) => x.key === 'price');
    const tag = `${s.name} ${d.id} ${P.CLASSES[c]}`;
    const share = (d.ev_allin[c] + eff) / pot, need = cost / pot;
    const ok = !!f && near(f.values.pot, pot, 1e-9) && near(f.values.cost, cost, 1e-9) && near(f.values.need, need, 1e-12) && near(f.values.share, share, 1e-12)
      && near(d.ev_fold[c], -posted(i), 1e-9)                         // folding loses exactly what you posted
      && share >= 0 && share <= 1                                     // a share of the pot
      && near(d.ev_diff[c], share * pot - cost, 2e-4)                 // ev_diff = share x pot - cost (4-decimal rounding)
      && (Math.abs(d.ev_diff[c]) < 2e-4 || (d.ev_diff[c] > 0) === (share > need)); // calling is better exactly when share > needed
    if (!ok) check(false, `${tag}: price identity (share ${share}, need ${need}, ev_diff ${d.ev_diff[c]})`); else passed++;
    if (f) {
      const m = f.text.match(/you need ([\d.]+)% equity against his range; this hand has ([\d.]+)%/);
      const shown = m ? [Number(m[1]), Number(m[2])] : null;
      const order = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
      // Shown in the right order; equal only when they differ by less than the 2 decimals shown (then the hand is too close to call).
      const sameShown = shown && shown[0] === shown[1] && Math.abs(share - need) < 1e-4 && P.verdict(s, d, c, 'fold').close;
      if (!(shown && (order(shown[1], shown[0]) === order(share, need) || sameShown) && near(shown[0], 100 * need, 0.5) && near(shown[1], 100 * share, 0.5) && has(f.text, `costs ${P.fmtChips(cost)} bb for a pot of ${P.fmtChips(pot)} bb`))) check(false, `${tag}: the sentence shows the numbers in the right order (${f.text})`); else passed++;
      const v = P.verdict(s, d, c, 'fold');
      if (!v.close && (v.best === 'allin') !== (share > need)) check(false, `${tag}: the verdict agrees with the price`); else passed++;
    }
    nPrice++;
  }
}
console.log(`  ${nPrice} classes at decisions where you close the action`);
check(nPrice === (1 + 2 + 3 + 4 + 5) * 8 * 169, `price checked at every chip BB decision facing one all-in: 120 decisions x 169 (${nPrice})`);
{ // one case by hand: heads-up 10 bb, BB with KcTd against the SB's jam (exact): 0.55012, from pushfold equity over the SB's range
  const s = byName.get('chips-n2-10bb'), d = P.decisionById(s, 'BB_vs_SB'), c = P.classIndex('KTo');
  const f = P.facts(s, d, c).find((x) => x.key === 'price');
  check(near(f.values.share, 0.55012, 5e-6) && f.values.pot === 20 && near(f.values.cost, 8.9, 1e-9), `hand check: KTo in the BB at 10 bb has a 55.012% share (pushfold equity over the SB's range), pot 20, cost 8.9 (${f.values.share})`);
}

// ---------------------------------------------------------------- the sampler
section('the drill sampler');
{
  const prefsList = [
    {}, { hands: 'all' }, { kind: 'open' }, { kind: 'call' }, { players: 2 }, { players: 6, seat: 'UTG' }, { players: 3, stack: 4 },
    { value: 'points' }, { value: 'points', players: 4 }, { value: 'points', players: 5, situation: 'points-n5-hj28-co10-btn12-sb6-bb4' },
    { seat: 'BB' }, { seat: 'SB', kind: 'call' }, { value: 'points', kind: 'call', hands: 'all' }, { stack: 12, hands: 'all', kind: 'open' },
  ];
  for (const [n, prefs] of prefsList.entries()) {
    const r = rng(1000 + n);
    const Pn = P.normalizePrefs(prefs);
    let bad = 0, avoidBroken = 0, kinds = { open: 0, call: 0 }, last = null;
    const spotCount = new Map();
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const q = P.sampleQuestion(spots, prefs, r, last);
      if (!q) { bad++; break; }
      const { spot, decision: d, c, cards } = q;
      const ok = P.isAskable(spot, d) && P.spotMatches(spot, Pn) && (Pn.kind === 'both' || P.kindOf(d) === Pn.kind) && (Pn.seat === 'any' || d.seat === Pn.seat)
        && d.class_reach[c] > 0 && d.ev_diff[c] !== null && (Pn.hands === 'all' || Math.abs(d.ev_diff[c]) <= 0.5 * P.scaleOf(spot) + 1e-9)
        && P.classOfCards(cards) === P.CLASSES[c] && P.kindOf(d) === q.kind;
      if (!ok) bad++;
      if (last !== null && P.CLASSES[c] === last) avoidBroken++;
      last = P.CLASSES[c];
      kinds[q.kind]++;
      spotCount.set(spot.name, (spotCount.get(spot.name) || 0) + 1);
    }
    check(bad === 0, `prefs ${JSON.stringify(prefs)}: every question fits the choices and is askable${Pn.hands === 'close' ? ', with |ev_diff| <= 0.5 scale' : ''} (${bad} bad)`);
    check(avoidBroken === 0, `prefs ${JSON.stringify(prefs)}: never the same class twice in a row (${avoidBroken})`);
    const matching = spots.filter((s) => P.spotMatches(s, Pn));
    if (Pn.kind === 'both' && Pn.seat === 'any') {
      const share = kinds.open / N;
      check(share > 0.45 && share < 0.55, `prefs ${JSON.stringify(prefs)}: first in and facing an all-in about equally often (${(share * 100).toFixed(1)}% first in)`);
    }
    if (Pn.seat === 'any' && matching.length > 1) {
      const exp = N / matching.length;
      const worst = Math.max(...matching.map((s) => Math.abs((spotCount.get(s.name) || 0) - exp) / Math.sqrt(exp)));
      check(spotCount.size === matching.length && worst < 4.5, `prefs ${JSON.stringify(prefs)}: spots uniform among the ${matching.length} that match (worst z ${worst.toFixed(2)})`);
    }
  }
  // weights: within a decision the class follows combos x class_reach
  const s = byName.get('chips-n6-10bb'), d = P.decisionById(s, 'BB_vs_CO');
  const r = rng(99);
  const cnt = new Map();
  let n = 0;
  for (let i = 0; i < 60000; i++) {
    const q = P.sampleQuestion([s], { players: 6, stack: 10, seat: 'BB', kind: 'call', hands: 'all' }, r, null);
    if (q.decision !== d) continue;
    n++; cnt.set(q.c, (cnt.get(q.c) || 0) + 1);
  }
  const ds = s.decisions.filter((x) => x.seat === 'BB' && x.facing.length === 1);
  const share = n / 60000, want = d.reach / ds.reduce((a, x) => a + x.reach, 0);
  check(Math.abs(share - want) < 0.01, `decisions within a kind by reach: BB_vs_CO ${(share * 100).toFixed(1)}% of BB calls (reach share ${(want * 100).toFixed(1)}%)`);
  const W = P.CLASSES.map((_, c) => P.classCombos(c) * d.class_reach[c]); const tot = W.reduce((a, b) => a + b, 0);
  const z = [0, 84, 168, 13].map((c) => { const e = (n * W[c]) / tot; return Math.abs((cnt.get(c) || 0) - e) / Math.sqrt(e); });
  check(z.every((x) => x < 4.5), `classes by combos x class_reach (z ${z.map((x) => x.toFixed(2))})`);
  check(P.sampleQuestion(spots, { value: 'points', players: 2, situation: 'nope' }, rng(3)) === null, 'nothing matches: null');
  check(P.sampleQuestion(spots, { kind: 'open', seat: 'BB' }, rng(3)) === null, 'the BB never acts first: null');
}

// ---------------------------------------------------------------- the quiz
section('the quiz');
{
  const quiz = JSON.parse(readFileSync(join(DIR, 'quiz.json'), 'utf8'));
  const qs = quiz.sets.flatMap((s) => s.questions);
  check(quiz.sets.length === 5 && quiz.sets.every((s) => s.questions.length === 10) && qs.length === 50, '5 sets of 10');
  check(new Set(qs.map((q) => q.id)).size === 50 && new Set(qs.map((q) => q.class)).size === 50, 'unique question ids, no hand class twice');
  for (const set of quiz.sets) {
    let allin = 0;
    for (const q of set.questions) {
      const r = P.checkQuizQuestion((name) => byName.get(name), q);
      check(r.ok && !r.fatal, `${q.id}: resolves and passes the start-up check (${r.problems?.join('; ')})`);
      if (!r.spot) continue;
      const d = r.decision, c = r.c;
      const expected = d.freq[c] >= 0.999 ? 'allin' : d.freq[c] <= 0.001 ? 'fold' : null;
      const v = P.verdict(r.spot, d, c, 'fold');
      check(!v.close && expected !== null && v.best === expected && (v.d > 0) === (expected === 'allin'), `${q.id}: not close, the expected answer ${expected} (solver plays it pure) = the sign of ev_diff (${v.d})`);
      check(P.verdict(r.spot, d, c, expected).grade === 'best' && P.verdict(r.spot, d, c, expected === 'allin' ? 'fold' : 'allin').right === false, `${q.id}: graded Best only for ${expected}`);
      check(Math.abs(v.d) >= 0.08 * P.scaleOf(r.spot) - 1e-9 && Math.abs(v.d) <= 0.5 * P.scaleOf(r.spot) + 1e-9 && Math.abs(v.d) >= 5 * v.se, `${q.id}: inside the quiz's margins (0.08 to 0.5 scale, at least 5 standard errors)`);
      if (expected === 'allin') allin++;
      const fb = P.buildFeedback(r.spot, d, c, expected, q.cards);
      check(fb.verdict.right && fb.hand.class === q.class && fb.spot.name === q.spot && fb.decision.id === q.decision, `${q.id}: feedback for the right answer`);
      const qp = P.questionPayload(r.spot, d, c, q.cards);
      const bad = ['freq', 'ev_fold', 'ev_allin', 'ev_diff', 'ev_diff_se', 'class_reach', 'allin_pct', 'reach', 'verdict', 'facts'].filter((k) => JSON.stringify(qp).includes(`"${k}"`));
      check(!bad.length, `${q.id}: the question payload has nothing the solver says (${bad})`);
    }
    check(allin === 5, `set ${set.id}: 5 all-in and 5 fold answers (${allin} all-in)`);
  }
  // the start-up check flags what is wrong
  const s = byName.get('chips-n6-10bb');
  const closeC = P.CLASSES.findIndex((_, c) => P.verdict(s, P.decisionById(s, 'BTN_open'), c, 'fold').close);
  check(P.checkQuizQuestion((n) => byName.get(n), { id: 'x', spot: 'chips-n6-10bb', decision: 'BTN_open', class: P.CLASSES[closeC], cards: P.cardsForClass(P.CLASSES[closeC], rng(1)) }).ok === false, 'a close hand fails the check');
  check(P.checkQuizQuestion((n) => byName.get(n), { id: 'x', spot: 'nope', decision: 'BTN_open', class: 'AA', cards: ['As', 'Ah'] }).fatal === true, 'an unknown spot is fatal');
  check(P.checkQuizQuestion((n) => byName.get(n), { id: 'x', spot: 'chips-n6-10bb', decision: 'BB_vs_CO_BTN', class: 'AA', cards: ['As', 'Ah'] }).ok === false, 'a multi-way decision fails the check');
  check(P.checkQuizQuestion((n) => byName.get(n), { id: 'x', spot: 'chips-n6-10bb', decision: 'BTN_open', class: 'AA', cards: ['As', 'Kh'] }).ok === false, 'cards of another class fail the check');
}

// ---------------------------------------------------------------- Copy for Claude
section('the "Copy for Claude" prompt');
{
  let n = 0;
  const r = rng(5);
  // Every other decision filled with marked numbers: none of them may reach the prompt.
  const MARK = { freq: Array(169).fill(0.123), ev_fold: Array(169).fill(913.1357), ev_allin: Array(169).fill(802.4681), ev_diff: Array(169).fill(-705.9753), ev_diff_se: Array(169).fill(3.2109) };
  const marked = new Map(spots.map((s) => [s.name, { s: structuredClone(s), orig: new Map(s.decisions.map((x) => [x.id, x])) }]));
  for (const [s0, d0] of askable) {
    const { s, orig } = marked.get(s0.name);
    for (const x of s.decisions) for (const k of Object.keys(MARK)) x[k] = x.id === d0.id ? orig.get(x.id)[k] : MARK[k];
    for (const c of [Math.floor(r() * 169), 0, 168]) {
      for (const action of ['fold', 'allin']) {
        const d = P.decisionById(s, d0.id);
        const cards = P.cardsForClass(P.CLASSES[c], r);
        const fb = P.buildFeedback(s, d, c, action, cards);
        const text = P.buildPrompt(fb);
        const same = text === P.buildPrompt(P.buildFeedback(s0, d0, c, action, cards)); // the marked numbers changed nothing
        const tag = `${s.name} ${d.id} ${P.CLASSES[c]} ${action}`;
        n++;
        const units = s.units;
        const ev = (x) => P.fmtEv(x, units, { minus: '-' });
        const okStacks = s.seats.every((seat, i) => has(text, `${seat} ${P.fmtChips(s.stacks[i])} bb`));
        const okHand = has(text, cards.join(' ')) && has(text, `(${P.CLASSES[c]}, ${P.handWords(P.CLASSES[c])})`);
        const mine = action === 'fold' ? 'Fold' : d.facing.length ? 'Call' : 'All-in';
        const okAnswer = has(text, `My answer: ${mine}. The app graded it ${fb.verdict.label}`);
        const okNums = has(text, `Fold: EV ${ev(d.ev_fold[c])}`) && has(text, `EV ${ev(d.ev_allin[c])}`) && has(text, `minus fold): ${ev(d.ev_diff[c])}`)
          && has(text, s.exact ? '(exact)' : P.fmtErr(d.ev_diff_se[c], units)) && has(text, `with this hand ${P.fmtFreqPct(d.freq[c])} of the time`) && has(text, `${P.fmtPct(d.allin_pct)} of the time`);
        const okGame = has(text, `${s.seats.length} players`) && has(text, 'Blinds 0.5 / 1 bb') && has(text, 'ante of 0.1 bb') && (units === 'points' ? has(text, 'ICM') && has(text, s.payouts.map(P.fmtPoints).join(' / ')) : has(text, 'chip EV'));
        const before = s.seats.slice(0, d.position).map((seat) => (d.facing.includes(seat) ? `${seat} goes all-in for ${P.fmtChips(s.stacks[s.seats.indexOf(seat)])} bb` : `${seat} folds`));
        const okAction = before.length ? has(text, `The action before me: ${before.join(', ')}.`) : has(text, 'none, I am first to act');
        const okFacts = fb.facts.every((f) => has(text, f.text));
        const marks = ['913.1', '802.4', '705.9', '±6.42'].filter((m) => has(text, m));
        const all = okStacks && okHand && okAnswer && okNums && okGame && okAction && okFacts && !marks.length && same;
        if (!all) check(false, `${tag}: prompt complete and nothing from other decisions (stacks ${okStacks}, hand ${okHand}, answer ${okAnswer}, numbers ${okNums}, game ${okGame}, action ${okAction}, facts ${okFacts}, marks ${marks}, unchanged by other decisions' numbers ${same})`);
        else passed++;
      }
    }
  }
  console.log(`  ${n} prompts`);
  check(P.buildPrompt(null) === null && P.buildPrompt({ spot: {} }) === null, 'no prompt without a complete payload');
}

if (fails.length) { console.log(fails.slice(0, 40).map((m) => `  FAIL ${m}`).join('\n')); if (fails.length > 40) console.log(`  ... and ${fails.length - 40} more`); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
