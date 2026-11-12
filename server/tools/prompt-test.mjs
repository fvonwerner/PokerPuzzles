#!/usr/bin/env node
// Unit test for web/js/prompt.js ("Copy for Claude"). No dependencies:
//   node server/tools/prompt-test.mjs
// The steps and reveals are made by the server's own view functions, so each
// case is exactly what the play screen holds after answering a decision.
// Reads the fixture puzzles and (read-only) the real ones in data/solutions.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../../web/js/prompt.js';
import { createPuzzleRegistry } from '../lib/puzzles.mjs';
import { publicSteps, reveal, timeoutReveal, header } from '../lib/view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = existsSync(join(ROOT, 'data', 'solutions-fixture')) ? join(ROOT, 'data') : join(ROOT, '..', 'data');

let passed = 0, failed = 0;
const fails = [];
function check(cond, msg) {
  if (cond) passed++;
  else { failed++; fails.push(msg); }
}
const has = (text, s) => text.includes(s);
const word = (text, w) => new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(text);
const num = (x) => String(Math.round(x * 100) / 100);

function load(dir, expl) {
  const reg = createPuzzleRegistry({ root: ROOT, env: { SOLUTIONS_DIR: dir, EXPLANATIONS_DIR: expl, RESCAN_MS: '0' }, log: () => {} });
  return [...reg.puzzles.values()];
}
const sets = [
  ['fixture', load(join(DATA, 'solutions-fixture'), join(DATA, 'explanations-fixture'))],
  ['real', existsSync(join(DATA, 'solutions')) ? load(join(DATA, 'solutions'), join(DATA, 'explanations')) : []],
];

/** A deterministic answer for decision i: alternately the main line and another option; every 5th a battle time-out. */
function answerFor(p, i, mode) {
  const d = p.solution.steps[p.decisionPositions[i]];
  if (mode === 'timeout' && i % 2 === 1) return null;
  if ((i + (mode === 'off' ? 1 : 0)) % 2 === 0) return d.mainLine;
  return d.options.find((o) => o.id !== d.mainLine).id;
}
const revealFor = (p, i, choice) => (choice === null ? timeoutReveal(p, i) : reveal(p, i, choice));

for (const [setName, puzzles] of sets) {
  check(setName === 'real' || puzzles.length >= 3, `${setName}: puzzles loaded`);
  for (const p of puzzles) {
    const sol = p.solution;
    const id = sol.id;
    const full = sol.steps;
    for (const mode of ['main', 'off', 'timeout']) {
      const choices = Array.from({ length: p.decisionCount }, (_, i) => answerFor(p, i, mode));
      for (let a = 1; a <= p.decisionCount; a++) {
        // What the client holds after answering decisions 0..a-1 (the feedback of decision a-1, or the end).
        const steps = publicSteps(p, a);
        const puzzle = header(p, { count: a >= p.decisionCount, full: a >= p.decisionCount });
        const reveals = {};
        for (let i = 0; i < a; i++) reveals[i] = revealFor(p, i, choices[i]);
        // The open decision (if any) can never be described.
        if (a < p.decisionCount) check(buildPrompt({ puzzle, steps, reveals, index: a }) === null, `${id} ${mode} a=${a}: no prompt for the open decision ${a}`);
        for (let i = 0; i < a; i++) {
          const text = buildPrompt({ puzzle, steps, reveals, index: i });
          const tag = `${id} ${mode} a=${a} d${i}`;
          if (!text) { check(false, `${tag}: prompt built`); continue; }
          const pos = p.decisionPositions[i];
          const d = full[pos];
          // ---- nothing from later steps ----
          const shownCards = new Set([...sol.hero.hand]);
          for (let k = 0; k < pos; k++) if (full[k].type === 'deal') full[k].cards.forEach((c) => shownCards.add(c));
          const later = [];
          for (let k = pos + 1; k < full.length; k++) {
            const s = full[k];
            if (s.type === 'deal') later.push(...s.cards);
            if (s.type === 'end' && s.showdown) later.push(...s.showdown.villainHand);
          }
          const leaked = later.filter((c) => !shownCards.has(c) && word(text, c));
          check(!leaked.length, `${tag}: no card from later in the hand (${leaked})`);
          check(!/How the hand ended|showdown|Villain shows/i.test(text), `${tag}: nothing about how the hand ends`);
          for (let j = i + 1; j < p.decisionCount; j++) check(!word(text, `decision ${j + 1}`) && !has(text, `DECISION ${j + 1}`), `${tag}: no mention of decision ${j + 1}`);
          check(!/ of \d+ decisions|\d+ decisions/i.test(text), `${tag}: never tells how many decisions the hand has`);
          const laterStreets = full.slice(pos + 1).filter((s) => s.type === 'deal').map((s) => s.street);
          for (const st of laterStreets) check(!new RegExp(`^${st[0].toUpperCase()}${st.slice(1)} `, 'm').test(text), `${tag}: no ${st} line`);
          // ---- what it must contain ----
          check(has(text, '6-max') && has(text, '100 bb') && has(text, 'no ante'), `${tag}: the game`);
          check(has(text, `Me (hero): ${sol.hero.seat}`) && sol.hero.hand.every((c) => word(text, c)), `${tag}: hero seat and exact cards`);
          check(has(text, `Villain: ${sol.villain.seat}`), `${tag}: villain seat`);
          check(has(text, `Pot: ${num(d.state.pot)} bb`), `${tag}: pot at the decision`);
          check(has(text, `Stacks behind: mine ${num(d.state.heroStack)} bb, villain's ${num(d.state.villainStack)} bb`), `${tag}: stacks at the decision`);
          check(has(text, 'Options: '), `${tag}: options listed`);
          check(d.hand.freq.every((f) => f === 0 || f === 1 || has(text, `${Math.round(f * 100)}%`) || has(text, '<1%') || has(text, '>99%')), `${tag}: hand frequency per option`);
          if (d.source !== 'chart') {
            check(d.hand.ev.every((ev) => has(text, `EV ${num(ev)} bb`)), `${tag}: EV of every option`);
            const best = Math.max(...d.hand.ev);
            const worst = d.hand.ev.findIndex((ev) => best - ev >= 0.005);
            if (worst >= 0) check(has(text, `${num(Math.max(0, best - d.hand.ev[worst]))} bb less than the best option`) && has(text, '% of the pot)'), `${tag}: loss in bb and % of pot`);
            if (typeof d.hand.equity === 'number') check(has(text, `${(d.hand.equity * 100).toFixed(1)}%`), `${tag}: hero equity`);
          } else check(has(text, 'preflop chart'), `${tag}: chart decision named as such`);
          const rv = reveals[i];
          if (rv.timeout) check(has(text, 'ran out of time'), `${tag}: time-out told`);
          else check(has(text, `The app graded it ${rv.label}`), `${tag}: hero's answer and grade (${rv.label})`);
          check(has(text, 'How my whole range plays this spot'), `${tag}: the whole range`);
          check(has(text, 'general principle') && has(text, 'language I write my message in') && has(text, 'Do not just repeat the numbers'), `${tag}: the request at the end`);
          // earlier answered decisions appear in the history
          for (let j = 0; j < i; j++) check(word(text, `my decision ${j + 1}`), `${tag}: earlier decision ${j + 1} in the history`);
        }
      }
      // ---- the whole hand, finished ----
      const steps = publicSteps(p, p.decisionCount);
      const reveals = {};
      for (let i = 0; i < p.decisionCount; i++) reveals[i] = revealFor(p, i, choices[i]);
      const puzzle = header(p, { full: true });
      const text = buildPrompt({ puzzle, steps, reveals, whole: true });
      const tag = `${id} ${mode} whole`;
      check(!!text, `${tag}: built`);
      if (text) {
        let at = -1, ordered = true;
        for (let i = 0; i < p.decisionCount; i++) { const k = text.indexOf(`MY DECISION ${i + 1} (`); if (k <= at) ordered = false; at = k; }
        check(ordered, `${tag}: every decision, in order`);
        const end = full.at(-1);
        check(has(text, 'How the hand ended'), `${tag}: how it ended`);
        if (end.showdown) check(end.showdown.villainHand.every((c) => word(text, c)), `${tag}: villain's showdown cards`);
        for (const s of full) if (s.type === 'deal') check(s.cards.every((c) => word(text, c)), `${tag}: ${s.street} cards`);
        check(has(text, 'general principles') && has(text, 'language I write my message in'), `${tag}: the request`);
      }
      // A finished hand still describes one decision without anything after it.
      const d0 = buildPrompt({ puzzle, steps, reveals, index: 0 });
      const firstDeal = full.findIndex((s) => s.type === 'deal');
      if (firstDeal > p.decisionPositions[0]) check(!full[firstDeal].cards.some((c) => word(d0, c) && !sol.hero.hand.includes(c)), `${id} ${mode}: decision 1 of a finished hand shows no flop`);
    }
  }
}

// ---- a made-up hand with marked values after the decision ----
{
  const st = (pot, hs, vs, hb = 0, vb = 0) => ({ pot, heroStack: hs, villainStack: vs, heroBet: hb, villainBet: vb });
  const w = Array(169).fill(0), f2 = Array(169).fill([0.5, 0.5]);
  const sol = {
    id: 'zz01', title: 'Marked', tags: ['SECRET_TAG'],
    scenario: { key: 'BTN_BB_SRP', name: 'BTN opens, BB calls', potType: 'SRP' },
    hero: { seat: 'BTN', position: 'ip', hand: ['Ah', 'Kh'], handClass: 'AKs' }, villain: { seat: 'BB', position: 'oop' },
    startingStackBb: 100, board: { flop: ['2c', '7d', 'Jh'], turn: 'Qs', river: '9c' }, decisionCount: 2,
    steps: [
      { type: 'action', street: 'preflop', seat: 'UTG', kind: 'fold' },
      { type: 'decision', index: 0, street: 'preflop', source: 'chart', state: st(1.5, 100, 99, 0, 1), toCall: 1,
        options: [{ id: 'fold', kind: 'fold', label: 'Fold' }, { id: 'raise_25', kind: 'raise', amount: 2.5, label: 'Raise to 2.5' }],
        hand: { freq: [0, 1], ev: null, equity: null }, mainLine: 'raise_25', stateAfter: st(4, 97.5, 99, 2.5, 1),
        range: { w, f: f2, freq: [0.6, 0.4], equity: null, combos: 400 }, villainRange: null },
      { type: 'action', street: 'preflop', seat: 'BB', kind: 'call', amount: 2.5, state: st(5.5, 97.5, 97.5, 2.5, 2.5) },
      { type: 'deal', street: 'flop', cards: ['2c', '7d', 'Jh'], state: st(5.5, 97.5, 97.5) },
      { type: 'villain', street: 'flop', seat: 'BB', action: { id: 'bet_77', kind: 'bet', amount: 77.77, pctPot: 1414, label: 'LATER_SENTINEL_BET' },
        freq: 0.4242, options: [{ id: 'check', kind: 'check', label: 'Check' }, { id: 'bet_77', kind: 'bet', amount: 77.77, label: 'LATER_SENTINEL_BET' }],
        range: { w, f: f2, freq: [0.5758, 0.4242], combos: 300 }, state: st(83.27, 97.5, 19.73, 0, 77.77) },
      { type: 'decision', index: 1, street: 'flop', source: 'solver', state: st(83.27, 97.5, 19.73, 0, 77.77), toCall: 19.73,
        options: [{ id: 'fold', kind: 'fold', label: 'Fold' }, { id: 'call', kind: 'call', amount: 19.73, label: 'LATER_SENTINEL_CALL' }],
        hand: { freq: [0.3131, 0.6869], ev: [0, 66.66], equity: 0.5353 }, mainLine: 'call', stateAfter: st(103, 77.77, 0, 19.73, 19.73),
        range: { w, f: f2, freq: [0.2121, 0.7879], equity: 0.4545, combos: 222 }, villainRange: { w, equity: 0.5455, combos: 111 } },
      { type: 'deal', street: 'turn', cards: ['Qs'], state: st(103, 77.77, 0) },
      { type: 'end', reason: 'showdown', state: st(103, 77.77, 0), showdown: { villainHand: ['8s', '8d'], winner: 'villain', heroHandName: 'High card', villainHandName: 'SENTINEL_HANDNAME' }, heroNet: -22.23 },
    ],
  };
  const p = { solution: sol, explanations: { decisions: {}, takeaway: null }, number: 99, decisionPositions: [1, 5], decisionCount: 2, fingerprint: 'x' };
  const ans = { 0: reveal(p, 0, 'fold') };
  const steps = publicSteps(p, 1); // after answering decision 0: up to decision 1 (stripped)
  const text = buildPrompt({ puzzle: header(p, { count: false }), steps, reveals: ans, index: 0 });
  check(!!text, 'marked hand: prompt for decision 1');
  for (const bad of ['LATER_SENTINEL', '77.77', '1414', '42%', '66.66', '53.5%', '45.5%', '31%', '69%', 'Qs', '8s', '8d', 'SENTINEL_HANDNAME', '22.23', 'SECRET_TAG', '2c', '7d', 'Jh', 'Flop'])
    check(!has(text, bad), `marked hand: decision 1 prompt does not contain "${bad}"`);
  check(has(text, 'Options: Fold | Raise to 2.5 bb.') && has(text, 'My answer: Fold. The app graded it Wrong: 15 of 100 points.'), 'marked hand: options and the answer (Fold, Wrong 15)');
  check(has(text, 'Preflop (blinds: SB 0.5 bb, BB 1 bb): UTG folds.'), 'marked hand: the action before the decision');
  check(buildPrompt({ puzzle: header(p, { count: false }), steps, reveals: ans, index: 1 }) === null, 'marked hand: the open decision has no prompt, even with a forged reveal missing');
  // a reveal for the open decision that did not come from the server must not make it describable either
  const forged = { ...ans, 1: { ...reveal(p, 1, 'call') } };
  check(buildPrompt({ puzzle: header(p, { count: false }), steps, reveals: forged, index: 1 }) === null, 'marked hand: a decision whose step is still hidden has no prompt');
  // once decision 2 is answered: its villain line, numbers and equity appear, the turn still does not
  const ans2 = { 0: ans[0], 1: reveal(p, 1, 'fold') };
  const steps2 = publicSteps(p, 2);
  const t2 = buildPrompt({ puzzle: header(p, { full: true }), steps: steps2, reveals: ans2, index: 1 });
  check(has(t2, 'bets 77.77 bb (1414% of the pot)') && has(t2, '42%') && has(t2, 'EV 66.66 bb') && has(t2, '53.5%'), 'marked hand: decision 2 prompt has the villain bet, its range share, the EV and the equity');
  check(!has(t2, 'Qs') && !has(t2, '8s') && !has(t2, 'SENTINEL_HANDNAME'), 'marked hand: decision 2 prompt has nothing after it (turn, showdown)');
  check(has(t2, 'my decision 1: I chose Fold, graded Wrong'), 'marked hand: the earlier off-line choice is told in the history');
  const whole = buildPrompt({ puzzle: header(p, { full: true }), steps: steps2, reveals: ans2, whole: true });
  check(has(whole, 'MY DECISION 1 (preflop)') && has(whole, 'MY DECISION 2 (flop)') && has(whole, 'Qs') && has(whole, '8s 8d') && has(whole, 'I lose 22.23 bb'), 'marked hand: the whole hand has both decisions, the turn and the showdown');
  check(!has(whole, 'SECRET_TAG'), 'marked hand: tags are never used');
}

if (fails.length) { console.log(fails.slice(0, 40).map((m) => `  FAIL ${m}`).join('\n')); if (fails.length > 40) console.log(`  ... and ${fails.length - 40} more`); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
