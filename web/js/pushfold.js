// Tournament mode (push/fold): the rules shared by the server and the browser.
//
// Pure: no DOM, no I/O, no imports. The server grades, states the facts and
// samples the drill with it (server/lib/tournament.mjs); the browser uses the
// same functions for the charts (which hands are too close to call), the table
// and the question line, the number formats and "Copy for Claude"; the tests
// (server/tools/tournament-test.mjs) run it against the real solver files. So
// the two sides can never disagree.
//
// A spot is a solved table situation (docs/TOURNAMENT.md section 5) in the
// normalized shape of normalizeSpot(): seats in action order, stacks in bb
// before posting, posted forced bets, units ('bb' chip EV or 'points' league
// points by ICM), payouts, decisions[] with per-class arrays (169, grid order).
// A decision is identified by the earlier players who went all-in (`facing`).
// The better action is decided by the sign of ev_diff (all-in minus fold),
// never by the frequency alone.

export const PF = Object.freeze({
  closeSe: 2.5,      // too close to call: |ev_diff| <= closeSe * se ...
  closeMin: 0.02,    // ... or <= closeMin * scale (bb; points: times the scale) ...
  mixLo: 0.05,       // ... or the solver mixes: mixLo <= freq <= mixHi
  mixHi: 0.95,
  inaccuracy: 0.10,  // a wrong answer costing less than this (times the scale) is an Inaccuracy,
  wrong: 0.50,       // less than this a Wrong, otherwise a Blunder
  band: 0.5,         // "Close hands" in the drill: |ev_diff| <= band * scale
  minReach: 0.01,    // a decision facing one all-in is asked when reached in at least 1% of hands (heads-up: always)
  errMult: 2,        // the error shown next to a number is errMult standard errors
  eps: 1e-9,         // float tolerance for comparisons of 3- and 4-decimal inputs
});

export const GRADE_LABELS = Object.freeze({ best: 'Best', correct: 'Correct', inaccuracy: 'Inaccuracy', wrong: 'Wrong', blunder: 'Blunder' });
export const SEATS = Object.freeze(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
export const STACKS = Object.freeze([4, 5, 6, 7, 8, 9, 10, 12]);
export const UNIT = Object.freeze({ bb: 'bb', points: 'points' });

const RANKS = 'AKQJT98765432';
const SUITS = 'shdc';
const RANK_WORD = { A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: 'ten', 9: 'nine', 8: 'eight', 7: 'seven', 6: 'six', 5: 'five', 4: 'four', 3: 'three', 2: 'two' };
const WHERE = { UTG: 'under the gun', HJ: 'in the hijack', CO: 'in the cutoff', BTN: 'on the button', SB: 'in the small blind', BB: 'in the big blind' };
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// ---------- hand classes (13x13 grid order, as data/ranges.json and web/js/poker.js) ----------
export function className(c) {
  const i = Math.floor(c / 13), j = c % 13;
  if (i === j) return RANKS[i] + RANKS[i];
  if (i < j) return `${RANKS[i]}${RANKS[j]}s`;
  return `${RANKS[j]}${RANKS[i]}o`;
}
export const CLASSES = Object.freeze(Array.from({ length: 169 }, (_, c) => className(c)));
const CLASS_INDEX = new Map(CLASSES.map((n, c) => [n, c]));
/** Index of a class name ("AKs", "77", "T9o"), -1 if it is not one. */
export const classIndex = (name) => (CLASS_INDEX.has(name) ? CLASS_INDEX.get(name) : -1);
/** Combos of a class: 6 for a pair, 4 suited, 12 offsuit. */
export function classCombos(c) { const i = Math.floor(c / 13), j = c % 13; return i === j ? 6 : i < j ? 4 : 12; }
/** "king-nine offsuit", "a pair of sevens". */
export function handWords(name) {
  if (!name || name.length < 2) return '';
  const a = RANK_WORD[name[0]], b = RANK_WORD[name[1]];
  if (name[0] === name[1]) return `a pair of ${a === 'six' ? 'sixe' : a}s`;
  return `${a}-${b} ${name[2] === 's' ? 'suited' : 'offsuit'}`;
}
/** Two concrete cards of a class with random suits ("Kc", "9d"). */
export function cardsForClass(name, rng = Math.random) {
  const c = classIndex(name);
  if (c < 0) throw new Error(`unknown hand class ${name}`);
  const i = Math.floor(rng() * 4) % 4;
  const a = SUITS[i];
  if (name[2] === 's') return [name[0] + a, name[1] + a];
  const b = SUITS[(i + 1 + (Math.floor(rng() * 3) % 3)) % 4]; // one of the other three suits
  return [name[0] + a, name[1] + b];
}
/** The class of two cards (["Kc","9d"] -> "K9o"), or null if they are not two different valid cards. */
export function classOfCards(cards) {
  if (!Array.isArray(cards) || cards.length !== 2) return null;
  const ok = (x) => typeof x === 'string' && x.length === 2 && RANKS.includes(x[0]) && SUITS.includes(x[1]);
  if (!cards.every(ok) || cards[0] === cards[1]) return null;
  const [a, b] = [...cards].sort((x, y) => RANKS.indexOf(x[0]) - RANKS.indexOf(y[0]));
  if (a[0] === b[0]) return a[0] + b[0];
  return `${a[0]}${b[0]}${a[1] === b[1] ? 's' : 'o'}`;
}

// ---------- spots and decisions ----------
const rnd = (x, k) => (x === null || x === undefined ? null : Math.round(x * 10 ** k) / 10 ** k);
/**
 * A solver file (docs/TOURNAMENT.md section 5) in the shape everything here
 * uses, rounded as it is served: frequencies 3 decimals, EVs and their errors 4
 * (reach and class_reach keep the file's precision). Grading, facts and charts
 * all read these same numbers.
 */
export function normalizeSpot(f) {
  const spec = f.spec || {};
  const units = f.units === 'points' ? 'points' : 'bb';
  return {
    name: spec.name,
    units,
    seats: f.seats.slice(),
    stacks: f.stacks.slice(),
    posted: {
      live: f.posted.live.slice(),
      dead: (f.posted.dead || f.seats.map(() => 0)).slice(),
      allin_by_posting: (f.posted.allin_by_posting || f.seats.map(() => false)).slice(),
    },
    ante: spec.ante ? { ...spec.ante } : { mode: 'per_player', amount: 0.1 },
    blinds: spec.blinds ? { ...spec.blinds } : { sb: 0.5, bb: 1 },
    payouts: units === 'points' ? (spec.payoff?.payouts || []).slice() : null,
    note: spec.note || null,
    exact: f.accuracy?.method === 'exact-hu',
    decisions: f.decisions.map((d) => ({
      id: d.id, seat: d.seat, position: d.position, facing: d.facing.slice(), allin_action: d.allin_action,
      reach: d.reach, allin_pct: d.allin_pct,
      freq: d.freq.map((x) => rnd(x, 3)),
      ev_fold: d.ev_fold.map((x) => rnd(x, 4)),
      ev_allin: d.ev_allin.map((x) => rnd(x, 4)),
      ev_diff: d.ev_diff.map((x) => rnd(x, 4)),
      ev_diff_se: d.ev_diff_se.map((x) => rnd(x, 4)),
      class_reach: d.class_reach.map((x) => rnd(x, 5)),
    })),
  };
}

/** What describes a spot without any solver output: the table, the stakes, the units. */
export function spotMeta(spot) {
  return {
    name: spot.name, units: spot.units, n: spot.seats.length,
    seats: spot.seats.slice(), stacks: spot.stacks.slice(),
    posted: { live: spot.posted.live.slice(), dead: spot.posted.dead.slice(), allin_by_posting: spot.posted.allin_by_posting.slice() },
    ante: { ...spot.ante }, blinds: { ...spot.blinds },
    payouts: spot.payouts ? spot.payouts.slice() : null,
    note: spot.note, exact: !!spot.exact, scale: scaleOf(spot),
  };
}

/**
 * The size of a big blind in the spot's units: 1 for chip EV; for league
 * points (first place - last place) / (big blinds on the table), the points a
 * big blind is worth between first and last. Thresholds in bb are multiplied by it.
 */
export function scaleOf(spot) {
  if (spot.units !== 'points') return 1;
  const p = spot.payouts || [];
  const total = spot.stacks.reduce((a, b) => a + b, 0);
  return total > 0 && p.length ? (p[0] - p[p.length - 1]) / total : 1;
}

/** 'open' (nobody all-in yet), 'call' (facing one all-in) or 'multi' (two or more). */
export const kindOf = (d) => (d.facing.length === 0 ? 'open' : d.facing.length === 1 ? 'call' : 'multi');
/** Decisions the drill and the quiz ask: first in, and facing one all-in reached in at least 1% of hands (heads-up: always). */
export function isAskable(spot, d) {
  const k = kindOf(d);
  if (k === 'open') return true;
  if (k === 'call') return spot.seats.length === 2 || d.reach >= PF.minReach - PF.eps;
  return false;
}
export const decisionById = (spot, id) => spot.decisions.find((d) => d.id === id) || null;
/** The decision of `seat` facing exactly the all-ins of `facing` (any order), or null. */
export function findDecision(spot, seat, facing) {
  const want = [...facing].sort().join(',');
  return spot.decisions.find((d) => d.seat === seat && [...d.facing].sort().join(',') === want) || null;
}

// ---------- the verdict ----------
/**
 * The verdict for one answer at a decision, hand class c (index) and action
 * 'allin' (a jam or a call) or 'fold':
 *   close   too close to call: |d| <= max(2.5 se, 0.02 scale), or the solver
 *           mixes (0.05 <= freq <= 0.95). Either answer is right ("Correct").
 *   best    otherwise the better action, by the sign of d = ev_diff
 *   cost    what the answer gave up: 0 when right, |d| when wrong
 *   grade   best | correct (either answer on a close hand) | inaccuracy
 *           (cost < 0.10 scale) | wrong (< 0.50 scale) | blunder
 * opts.forceClose: grade the hand as close whatever the numbers (a quiz
 * question that failed the start-up check).
 */
export function verdict(spot, d, c, action, { forceClose = false } = {}) {
  if (action !== 'allin' && action !== 'fold') throw new Error(`bad action ${action}`);
  const dd = d.ev_diff[c];
  if (dd === null || dd === undefined) return null;
  const se = d.ev_diff_se[c] || 0;
  const f = d.freq[c];
  const scale = scaleOf(spot);
  const mixed = f >= PF.mixLo - PF.eps && f <= PF.mixHi + PF.eps;
  const small = Math.abs(dd) <= Math.max(PF.closeSe * se, PF.closeMin * scale) + PF.eps;
  const close = !!forceClose || small || mixed;
  const better = dd > 0 ? 'allin' : dd < 0 ? 'fold' : null;
  const best = close ? null : better;
  const right = close || action === best;
  const diff = Math.abs(dd);
  const cost = right ? 0 : diff;
  let grade;
  if (close) grade = 'correct';
  else if (right) grade = 'best';
  else if (diff / scale < PF.inaccuracy) grade = 'inaccuracy';
  else if (diff / scale < PF.wrong) grade = 'wrong';
  else grade = 'blunder';
  return {
    action, close, mixed, forced: !!forceClose, best, better, right, grade, label: GRADE_LABELS[grade],
    cost, diff, d: dd, se, freq: f, evFold: d.ev_fold[c], evAllin: d.ev_allin[c],
    units: spot.units, scale, exact: !!spot.exact,
  };
}

// ---------- the table at a decision ----------
/**
 * Who has done what when `d` is decided, from the spot alone (no solver output):
 * seats [{seat, index, stack (before posting), posted, ante (in the middle),
 * put (in the pot now), bet (in front of the seat), behind, status}] with status
 * 'folded' | 'allin' | 'hero' | 'waiting'; the pot; toCall (facing all-ins:
 * what calling adds to match the biggest one, at most your stack); commit
 * (what going all-in adds: a jam or a call puts in the whole stack).
 */
export function situation(spot, d) {
  const heroIndex = d.position;
  const facing = new Set(d.facing);
  const perPlayer = (spot.ante?.mode || 'per_player') === 'per_player';
  const anteAmt = perPlayer ? Number(spot.ante?.amount || 0) : 0;
  const seats = spot.seats.map((seat, i) => {
    const stack = spot.stacks[i];
    const dead = Number(spot.posted.dead?.[i] || 0);
    const posted = r4(Number(spot.posted.live[i] || 0) + dead);
    const ante = r4(Math.min(anteAmt, stack) + dead);
    const byPosting = !!spot.posted.allin_by_posting?.[i];
    let status;
    if (i === heroIndex) status = 'hero';
    else if (byPosting || (i < heroIndex && facing.has(seat))) status = 'allin';
    else if (i < heroIndex) status = 'folded';
    else status = 'waiting';
    const put = status === 'allin' ? stack : posted;
    return { seat, index: i, stack, posted, ante, put, bet: r4(put - ante), behind: r4(stack - put), status, byPosting };
  });
  const hero = seats[heroIndex];
  const jammers = seats.filter((s) => s.status === 'allin' && facing.has(s.seat));
  const top = jammers.length ? Math.max(...jammers.map((s) => s.stack)) : 0;
  return {
    n: seats.length, seats, hero, jammers,
    folded: seats.filter((s) => s.status === 'folded'),
    waiting: seats.filter((s) => s.status === 'waiting'),
    pot: r4(seats.reduce((a, s) => a + s.put, 0)),
    toCall: jammers.length ? r4(Math.min(hero.stack, top) - hero.posted) : 0,
    commit: r4(hero.stack - hero.posted),
    // facing an all-in smaller than your stack with players still to act: the call puts in your whole stack, over the top
    overTop: jammers.length > 0 && seats.some((x) => x.status === 'waiting') && hero.stack > top + PF.eps,
    kind: kindOf(d),
  };
}

/** Where a seat sits, in words ("on the button"). */
export function whereWords(spot, seat) {
  if (spot.seats.length === 2 && seat === 'SB') return 'in the small blind (on the button)';
  return WHERE[seat] || seat;
}

/** The one-line question: "Folded to you on the button with 8 bb." / "CO is all-in for 9 bb; you have 8 bb on the button." */
export function questionText(spot, d) {
  const s = situation(spot, d);
  const H = `${fmtChips(s.hero.stack)} bb`;
  if (s.kind === 'open') {
    if (s.hero.index === 0) return spot.seats.length === 2 ? `Heads-up: you act first, in the small blind, with ${H}.` : `You act first, ${whereWords(spot, s.hero.seat)}, with ${H}.`;
    return `Folded to you ${whereWords(spot, s.hero.seat)} with ${H}.`;
  }
  const j = s.jammers.map((x) => `${x.seat} is all-in for ${fmtChips(x.stack)} bb`);
  return `${listAnd(j)}; you have ${H} ${whereWords(spot, s.hero.seat)}.`;
}

/** What is still to be won in a points spot: "4 left · 15 / 8 / 5 / 3 points". */
export function placesText(spot) {
  if (spot.units !== 'points' || !spot.payouts) return null;
  return `${spot.seats.length} left · ${spot.payouts.map(fmtPoints).join(' / ')} points`;
}

// ---------- facts ----------
/**
 * Short sentences about the spot, every number read from the spot file (or
 * plain arithmetic on it), each one exactly true. [{key, text, values}]:
 *   behind      first in: who is still to act and how often each calls you (allin_pct of <seat>_vs_<you>)
 *   pickup      first in: what you win when everybody folds, against what you can lose
 *   jammer      facing one all-in: how wide the jammer jams when folded to (his first-in allin_pct)
 *   price       facing one all-in, chips, you close the action: the pot odds and this hand's share (needs c)
 *   behindCall  facing one all-in with players behind: who can still call, and how often
 *   bust        points: what going out means
 *   units       points: the EVs are league points
 */
export function facts(spot, d, c = null) {
  const s = situation(spot, d);
  const out = [];
  if (s.kind === 'open') {
    const calls = s.waiting.map((w) => ({ seat: w.seat, dec: findDecision(spot, w.seat, [s.hero.seat]) })).filter((x) => x.dec);
    if (calls.length) {
      const list = calls.map((x, i) => (i === 0 ? `${x.seat} calls ${fmtPct(x.dec.allin_pct)} of hands` : `${x.seat} ${fmtPct(x.dec.allin_pct)}`));
      out.push({
        key: 'behind', values: calls.map((x) => ({ seat: x.seat, id: x.dec.id, pct: x.dec.allin_pct })),
        text: `Behind you: ${list.join(', ')}${calls.length > 1 ? ' (each when the players between you and him fold)' : ''}.`,
      });
    }
    const pickup = r4(s.seats.reduce((a, x) => a + (x === s.hero ? 0 : x.posted), 0));
    const maxBehind = s.waiting.length ? Math.max(...s.waiting.map((w) => w.stack)) : 0;
    const risk = Math.min(s.hero.stack, maxBehind);
    out.push({
      key: 'pickup', values: { pickup, risk, stack: s.hero.stack, maxBehind },
      text: `If everyone folds you win ${fmtChips(pickup)} bb, the blinds and antes of the others. Called and beaten, you lose up to ${fmtChips(risk)} bb${risk < s.hero.stack - PF.eps ? ` of your ${fmtChips(s.hero.stack)} bb: nobody behind you has more than ${fmtChips(maxBehind)} bb` : ', your whole stack'}.`,
    });
  } else if (s.kind === 'call') {
    const j = s.jammers[0];
    const jd = findDecision(spot, j.seat, []);
    if (jd) {
      out.push({
        key: 'jammer', values: { seat: j.seat, id: jd.id, pct: jd.allin_pct },
        text: j.index === 0 ? `${j.seat} acts first and jams ${fmtPct(jd.allin_pct)} of hands.` : `${j.seat} jams ${fmtPct(jd.allin_pct)} of hands when folded to.`,
      });
    }
    if (!s.waiting.length) {
      const p = c === null ? null : priceOf(spot, d, s, c);
      if (p) {
        const [need, share] = pctPair(p.need, p.share);
        out.push({
          key: 'price', values: p,
          text: `Calling costs ${fmtChips(p.cost)} bb for a pot of ${fmtChips(p.pot)} bb: you need ${need} equity against his range; this hand has ${share}.`,
        });
      }
    } else {
      const over = s.waiting.map((w) => ({ seat: w.seat, dec: findDecision(spot, w.seat, [j.seat, s.hero.seat]) })).filter((x) => x.dec);
      const names = s.waiting.map((w) => w.seat);
      const list = over.map((x, i) => (i === 0 ? `${x.seat} calls as well with ${fmtPct(x.dec.allin_pct)} of hands` : `${x.seat} with ${fmtPct(x.dec.allin_pct)}`));
      out.push({
        key: 'behindCall', values: { seats: names, calls: over.map((x) => ({ seat: x.seat, id: x.dec.id, pct: x.dec.allin_pct })) },
        text: `Still to act behind you: ${listAnd(names)}.${s.overTop ? ` A call here puts in your whole stack (${fmtChips(s.hero.stack)} bb), over the top of ${j.seat}'s ${fmtChips(j.stack)} bb.` : ''}${list.length ? ` If you call, ${list.join(', ')}${over.length > 1 ? ' (each when the players between you and him fold)' : ''}.` : ''}`,
      });
    }
  }
  if (spot.units === 'points' && s.kind !== 'multi') {
    const b = bustOf(spot, d, s);
    out.push({ key: 'bust', values: b, text: b.text });
    out.push({ key: 'units', text: 'EVs here are league points: the points you can expect, by ICM on the stacks after the hand.' });
  }
  return out;
}

/**
 * The price of a call when you close the action in a chip spot (you face one
 * all-in, everybody else has folded). With eff = min(your stack, his stack)
 * and dead = the forced bets of the folded players:
 *   pot if you call = 2 eff + dead,  cost = eff - what you posted,
 *   needed share = cost / pot,       this hand's share = (ev_allin + eff) / pot,
 * because ev_allin = share * pot - eff and ev_fold = -(what you posted), so
 * ev_diff = share * pot - cost: calling is better exactly when share > needed.
 * Returned only when the file agrees (ev_fold equals minus what you posted, the
 * share lies in 0..1), else null.
 */
export function priceOf(spot, d, s, c) {
  if (spot.units !== 'bb' || s.kind !== 'call' || s.waiting.length) return null;
  if (s.seats.some((x) => x.status === 'allin' && x !== s.jammers[0])) return null;
  const j = s.jammers[0], hero = s.hero;
  const evA = d.ev_allin[c], evF = d.ev_fold[c];
  if (evA === null || evA === undefined || evF === null || evF === undefined) return null;
  if (Math.abs(evF + hero.posted) > 1e-6) return null;
  const eff = Math.min(hero.stack, j.stack);
  const dead = r4(s.folded.reduce((a, x) => a + x.posted, 0));
  const pot = r4(2 * eff + dead);
  const cost = r4(eff - hero.posted);
  const need = cost / pot, share = (evA + eff) / pot;
  if (!(share >= -PF.eps && share <= 1 + PF.eps)) return null;
  return { eff, dead, pot, cost, need, share };
}

/**
 * What going out means in a points spot. With N players left, a player who
 * goes out alone takes the lowest open place (N-th, payouts[N-1] points);
 * several going out in the same hand are ordered by their stacks before it
 * (more chips = better place), equal stacks share. Only a player with at
 * least your chips can put you out ("coverers"); another player with no more
 * chips than you can go out in the same hand when a third one wins both stacks.
 */
export function bustOf(spot, d, s = situation(spot, d)) {
  const n = s.n, H = s.hero.stack;
  const place = n, points = spot.payouts?.[n - 1] ?? null;
  const others = [...(s.kind === 'call' ? s.jammers : []), ...s.waiting];
  const coverers = others.filter((o) => o.stack >= H - PF.eps);
  const pts = `${fmtPoints(points)} point${points === 1 ? '' : 's'}`;
  if (!coverers.length) {
    return {
      canBust: false, place, points, coverers: [], coBusters: [],
      text: `Nobody else in this hand has as many chips as you (${fmtChips(H)} bb), so you cannot go out in it.`,
    };
  }
  const coBusters = others.filter((p) => p.stack <= H + PF.eps && coverers.some((w) => w !== p));
  const unless = coBusters.length ? `, unless ${listOr(coBusters.map((p) => p.seat))} (with no more chips than you) also goes out in this hand` : '';
  const j = s.kind === 'call' ? s.jammers[0] : null;
  const text = j && j.stack >= H - PF.eps
    ? `Call and lose and you are out in ${ordinal(place)} place: ${pts}${unless}.`
    : `${listAnd(coverers.map((w) => w.seat))} ${coverers.length > 1 ? 'have' : 'has'} at least your chips; lose your stack to ${coverers.length > 1 ? 'one of them' : 'him'} and you are out in ${ordinal(place)} place: ${pts}${unless}.`;
  return { canBust: true, place, points, coverers: coverers.map((w) => w.seat), coBusters: coBusters.map((p) => p.seat), text };
}

// ---------- the drill ----------
export const DRILL_DEFAULTS = Object.freeze({ value: 'chips', players: 'any', stack: 'any', situation: 'any', seat: 'any', kind: 'both', hands: 'close' });

/** The drill's choices, checked: anything unknown falls back to its default. */
export function normalizePrefs(p = {}) {
  const value = p.value === 'points' ? 'points' : 'chips';
  const players = [2, 3, 4, 5, 6].includes(Number(p.players)) ? Number(p.players) : 'any';
  const stack = value === 'chips' && STACKS.includes(Number(p.stack)) ? Number(p.stack) : 'any';
  const situation = value === 'points' && players !== 'any' && typeof p.situation === 'string' && /^[\w-]{1,80}$/.test(p.situation) && p.situation !== 'any' ? p.situation : 'any';
  const seat = SEATS.includes(p.seat) ? p.seat : 'any';
  const kind = ['open', 'call', 'both'].includes(p.kind) ? p.kind : 'both';
  const hands = p.hands === 'all' ? 'all' : 'close';
  return { value, players, stack, situation, seat, kind, hands };
}

/** Does a spot fit the value / players / stack / situation choices? */
export function spotMatches(spot, P) {
  if ((P.value === 'points') !== (spot.units === 'points')) return false;
  if (P.players !== 'any' && spot.seats.length !== P.players) return false;
  if (P.value === 'chips' && P.stack !== 'any' && !spot.stacks.every((x) => x === P.stack)) return false;
  if (P.value === 'points' && P.situation !== 'any' && spot.name !== P.situation) return false;
  return true;
}

const BAND_CACHE = new WeakMap(); // decision -> { all: [classes], close: [classes] }
/** Classes the drill may deal at a decision: reachable, with EVs; "Close hands" only |ev_diff| <= 0.5 scale. */
export function drillClasses(spot, d, hands) {
  let e = BAND_CACHE.get(d);
  if (!e) {
    const lim = PF.band * scaleOf(spot) + PF.eps;
    const all = [], close = [];
    for (let c = 0; c < 169; c++) {
      const dd = d.ev_diff[c];
      if (dd === null || dd === undefined || !(d.class_reach[c] > 0)) continue;
      all.push(c);
      if (Math.abs(dd) <= lim) close.push(c);
    }
    e = { all, close };
    BAND_CACHE.set(d, e);
  }
  return hands === 'all' ? e.all : e.close;
}

function pick(items, weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
  let x = rng() * total;
  for (let i = 0; i < items.length; i++) { x -= weights[i]; if (x < 0) return items[i]; }
  return items[items.length - 1];
}

/**
 * One drill question for the choices `prefs`: the spot uniformly among those
 * that match; first in or facing an all-in about equally often ("both"); the
 * decision by its reach; the hand class by combos x class_reach ("Close
 * hands": only classes with |ev_diff| <= 0.5 scale). `avoid` (a class name or
 * index) is never dealt twice in a row unless nothing else is left.
 * Returns { spot, decision, c, kind, cards } or null when nothing matches.
 */
export function sampleQuestion(spots, prefs, rng = Math.random, avoid = null) {
  const P = normalizePrefs(prefs);
  const av = typeof avoid === 'string' ? classIndex(avoid) : Number.isInteger(avoid) ? avoid : -1;
  const ok = (cs, excl) => cs.length > (excl >= 0 && cs.includes(excl) ? 1 : 0);
  for (const excl of av >= 0 ? [av, -1] : [-1]) {
    const options = [];
    for (const spot of spots) {
      if (!spotMatches(spot, P)) continue;
      const kinds = {};
      for (const d of spot.decisions) {
        if (!isAskable(spot, d)) continue;
        const k = kindOf(d);
        if (P.kind !== 'both' && P.kind !== k) continue;
        if (P.seat !== 'any' && d.seat !== P.seat) continue;
        if (!ok(drillClasses(spot, d, P.hands), excl)) continue;
        (kinds[k] ||= []).push(d);
      }
      if (kinds.open || kinds.call) options.push({ spot, kinds });
    }
    if (!options.length) continue;
    const o = options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
    const ks = ['open', 'call'].filter((k) => o.kinds[k]);
    const kind = ks[Math.min(ks.length - 1, Math.floor(rng() * ks.length))];
    const ds = o.kinds[kind];
    const d = pick(ds, ds.map((x) => x.reach), rng);
    const cs = drillClasses(o.spot, d, P.hands).filter((c) => c !== excl);
    const c = pick(cs, cs.map((x) => classCombos(x) * d.class_reach[x]), rng);
    return { spot: o.spot, decision: d, c, kind, cards: cardsForClass(CLASSES[c], rng) };
  }
  return null;
}

/** A question as it may be shown before the answer: the table and the hand, nothing the solver says. */
export function questionPayload(spot, d, c, cards) {
  return {
    spot: spotMeta(spot),
    decision: { id: d.id, seat: d.seat, position: d.position, facing: d.facing.slice(), kind: kindOf(d) },
    hand: { class: CLASSES[c], cards: cards.slice() },
  };
}

/** One decision's numbers for the client (the chart and the cell readouts). */
export function decisionData(d) {
  return {
    id: d.id, seat: d.seat, position: d.position, facing: d.facing.slice(), kind: kindOf(d),
    reach: d.reach, allin_pct: d.allin_pct,
    freq: d.freq.slice(), ev_fold: d.ev_fold.slice(), ev_allin: d.ev_allin.slice(), ev_diff: d.ev_diff.slice(), ev_diff_se: d.ev_diff_se.slice(),
  };
}

/**
 * Everything the feedback panel shows after an answer (drill and quiz alike):
 * the spot, this decision's numbers, the jammer's first-in range (facing an
 * all-in), the hand, the answer, the verdict and the facts.
 */
export function buildFeedback(spot, d, c, action, cards, { forceClose = false } = {}) {
  const v = verdict(spot, d, c, action, { forceClose });
  if (!v) return null;
  const jd = kindOf(d) === 'call' ? findDecision(spot, d.facing[0], []) : null;
  return {
    spot: spotMeta(spot),
    decision: decisionData(d),
    jammer: jd ? { id: jd.id, seat: jd.seat, allin_pct: jd.allin_pct, freq: jd.freq.slice() } : null,
    hand: { class: CLASSES[c], cards: cards.slice() },
    action,
    verdict: v,
    facts: facts(spot, d, c).map(({ key, text }) => ({ key, text })),
  };
}

/**
 * The start-up check of one quiz question against the loaded spots: the spot,
 * the decision and the class exist (else `fatal`: it cannot be asked), the
 * decision is one the drill asks, the cards are of the class, and the hand is
 * not too close to call by the verdict rule. { ok, fatal, problems, spot, decision, c, best }
 */
export function checkQuizQuestion(lookup, q) {
  const problems = [];
  const spot = lookup(q.spot);
  if (!spot) return { ok: false, fatal: true, problems: [`spot ${q.spot} is not loaded`] };
  const d = decisionById(spot, q.decision);
  if (!d) return { ok: false, fatal: true, problems: [`spot ${q.spot} has no decision ${q.decision}`] };
  const c = classIndex(q.class);
  if (c < 0) return { ok: false, fatal: true, problems: [`${q.class} is not a hand class`] };
  const v = verdict(spot, d, c, 'fold');
  if (!v) return { ok: false, fatal: true, problems: [`${q.decision} has no EVs for ${q.class}`] };
  if (!isAskable(spot, d)) problems.push(`${q.decision} is not a decision the quiz asks (first in, or facing one all-in reached in at least ${PF.minReach * 100}% of hands)`);
  if (classOfCards(q.cards) !== q.class) problems.push(`the cards ${JSON.stringify(q.cards)} are not ${q.class}`);
  if (v.close) problems.push(`${q.class} is too close to call by the verdict rule (ev_diff ${v.d}, se ${v.se}, freq ${v.freq})`);
  return { ok: !problems.length, fatal: false, problems, spot, decision: d, c, best: v.better };
}

// ---------- formats ----------
/** A chip amount in bb as the table shows it: up to 2 decimals, no trailing zeros ("8.9", "10"). */
export function fmtChips(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) return '?';
  const v = Math.round(x * 100) / 100;
  return String(Object.is(v, -0) ? 0 : v);
}
/** League points as places pay them ("15", "2.5"). */
export function fmtPoints(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) return '?';
  return String(Math.round(x * 1000) / 1000);
}
const decimalsOf = (units) => (units === 'points' ? 3 : 2);
/** An EV or a difference: bb with 2 decimals, points with 3, signed ("+0.31 bb", "−1.10 bb"). opts.minus: the minus sign ('−' on screen, '-' in plain text). */
export function fmtEv(x, units, { sign = true, minus = '−', unit = true } = {}) {
  if (typeof x !== 'number' || Number.isNaN(x)) return '?';
  const abs = Math.abs(x).toFixed(decimalsOf(units));
  const zero = Number(abs) === 0;
  const s = zero ? '' : x < 0 ? minus : sign ? '+' : '';
  return `${s}${abs}${unit ? ` ${UNIT[units] || units}` : ''}`;
}
/** The error shown with a Monte Carlo number: errMult standard errors, "±0.02" (or "±<0.01" when it rounds to 0). */
export function fmtErr(se, units) {
  const k = decimalsOf(units);
  const e = PF.errMult * (se || 0);
  const t = e.toFixed(k);
  if (Number(t) === 0) return e > 0 ? `±<${(10 ** -k).toFixed(k)}` : '±0';
  return `±${t}`;
}
/** A cost or a difference with its error: "0.31 bb (±0.02)", heads-up "0.31 bb (exact)". */
export function fmtCost(x, se, units, exact) {
  return `${fmtEv(Math.abs(x), units, { sign: false })} (${exact ? 'exact' : fmtErr(se, units)})`;
}
/** A percentage (0..100) as a whole percent; never "0%" for something that happens, never "100%" for a mix. */
export function fmtPct(p) {
  if (typeof p !== 'number' || Number.isNaN(p)) return '?';
  const r = Math.round(p);
  if (r === 0 && p > 1e-9) return '<1%';
  if (r === 100 && p < 100 - 1e-9) return '>99%';
  return `${r}%`;
}
/** A frequency (0..1) as fmtPct does. */
export const fmtFreqPct = (f) => fmtPct(100 * f);
/**
 * Two shares (0..1) as whole percent, with more decimals (up to 2) only when
 * whole percent would hide which is bigger (or make them look different when
 * they are equal).
 */
export function pctPair(a, b) {
  const cmp = (x, y) => (x > y + 1e-12 ? 1 : x < y - 1e-12 ? -1 : 0);
  const want = cmp(a, b);
  for (let k = 0; k <= 2; k++) {
    const x = (100 * a).toFixed(k), y = (100 * b).toFixed(k);
    if (cmp(Number(x), Number(y)) === want) return [`${x}%`, `${y}%`];
  }
  return [`${(100 * a).toFixed(2)}%`, `${(100 * b).toFixed(2)}%`];
}
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
export const listAnd = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export const listOr = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
/** The name of the all-in action at a decision: "All-in" first in, "Call" facing an all-in. */
export const allinLabel = (d) => (d.facing.length ? 'Call' : 'All-in');

/** The verdict in one sentence: "Too close to call: both plays are fine here (...)." / "Folding costs 0.31 bb (±0.02) here: calling is better." */
export function verdictText(v, d) {
  const verb = { allin: d.facing.length ? 'calling' : 'going all-in', fold: 'folding' };
  const name = { allin: allinLabel(d), fold: 'Fold' };
  const amount = fmtCost(v.diff, v.se, v.units, v.exact);
  if (v.forced) return 'Both plays count as right on this question.';
  if (v.close) return `Too close to call: both plays are fine here (${v.mixed ? 'the solver mixes them; ' : ''}the difference is ${amount}).`;
  if (v.right) return `${cap(name[v.best])} is right: it is worth ${amount} more than ${verb[v.best === 'allin' ? 'fold' : 'allin']}.`;
  return `${cap(verb[v.action])} costs ${amount} here: ${verb[v.best]} is better.`;
}
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

// ---------- "Copy for Claude" ----------
/**
 * A prompt that describes the spot completely (players, stacks, blinds and
 * antes, who did what, the hand, the answer given) with the solver's numbers
 * of this decision, asking for an explanation. Input: a feedback payload
 * (buildFeedback). Only this decision's numbers are used; the facts are the
 * sentences the feedback panel shows. null if the payload is incomplete.
 */
export function buildPrompt(fb) {
  if (!fb?.spot || !fb.decision || !fb.verdict || !fb.hand) return null;
  const sp = fb.spot, d = fb.decision, v = fb.verdict, units = sp.units;
  const c = classIndex(fb.hand.class);
  if (c < 0) return null;
  const s = situation(sp, d);
  const ev = (x) => fmtEv(x, units, { minus: '-' });
  const call = d.facing.length > 0;
  const allinName = call ? 'call (all-in)' : 'all-in';
  const lines = [];
  lines.push('I am practising short-stacked tournament poker (push/fold) against a solver and want to understand one decision.');
  lines.push('');
  lines.push(`Game: no-limit hold'em sit-and-go, ${sp.n} players at the table, all-in or fold only (a call of an all-in also puts in the caller's whole stack). Blinds ${fmtChips(sp.blinds.sb)} / ${fmtChips(sp.blinds.bb)} bb; ${sp.ante?.mode === 'per_player' ? `every player posts an ante of ${fmtChips(sp.ante.amount)} bb` : sp.ante?.mode === 'bb_ante' ? `the big blind posts an ante of ${fmtChips(sp.ante.amount)} bb for the table` : 'no ante'}. Amounts are in big blinds (bb).`);
  if (units === 'points') {
    lines.push(`Values: league points by ICM (Malmuth-Harville) on the stacks after the hand. ${sp.n} players left; the places pay ${sp.payouts.map(fmtPoints).join(' / ')} points (1st to ${ordinal(sp.n)}).`);
    if (sp.note) lines.push(`Chips: ${sp.note}.`);
  } else lines.push('Values: chip EV in bb, the change of a stack over the hand, measured from the stack before posting.');
  lines.push(`Stacks at the start of the hand, before blinds and antes: ${s.seats.map((x) => `${x.seat} ${fmtChips(x.stack)} bb`).join(', ')}.`);
  const actions = s.seats.filter((x) => x.index < s.hero.index).map((x) => (x.status === 'allin' ? `${x.seat} goes all-in for ${fmtChips(x.stack)} bb` : `${x.seat} folds`));
  lines.push(`The action before me: ${actions.length ? `${actions.join(', ')}.` : 'none, I am first to act.'}`);
  lines.push(`Me: ${s.hero.seat}, holding ${fb.hand.cards.join(' ')} (${fb.hand.class}, ${handWords(fb.hand.class)}), ${fmtChips(s.hero.stack)} bb. Pot now: ${fmtChips(s.pot)} bb${call ? `; to call: ${fmtChips(s.toCall)} bb${s.overTop ? ` (but a call here puts in my whole stack, ${fmtChips(s.commit)} bb more, over the top)` : ''}` : ''}.${s.waiting.length ? ` Still to act after me: ${listAnd(s.waiting.map((x) => `${x.seat} (${fmtChips(x.stack)} bb)`))}.` : ''}`);
  lines.push(`My options: fold, or ${allinName}.`);
  lines.push('');
  lines.push(`The solver's numbers for my hand at this decision (${sp.exact ? 'heads-up: exact' : `Monte Carlo: the ± is ${PF.errMult} standard errors`}):`);
  lines.push(`- Fold: EV ${ev(d.ev_fold[c])}`);
  lines.push(`- ${cap(allinName)}: EV ${ev(d.ev_allin[c])}`);
  lines.push(`- Difference (${call ? 'call' : 'all-in'} minus fold): ${ev(d.ev_diff[c])}${sp.exact ? ' (exact)' : ` ${fmtErr(d.ev_diff_se[c], units)}`}`);
  lines.push(`- The solver ${call ? 'calls' : 'goes all-in'} with this hand ${fmtFreqPct(d.freq[c])} of the time; with all its hands here it ${call ? 'calls' : 'goes all-in'} ${fmtPct(d.allin_pct)} of the time.`);
  if (fb.facts?.length) {
    lines.push('Facts about this spot, as the app states them ("you" is me):');
    for (const f of fb.facts) lines.push(`- ${f.text}`);
  }
  const mine = v.action === 'allin' ? (call ? 'Call' : 'All-in') : 'Fold';
  lines.push(`My answer: ${mine}. The app graded it ${v.label}: ${verdictText(v, d)}`);
  lines.push('');
  const bestName = v.best === 'allin' ? (call ? 'calling' : 'going all-in') : 'folding';
  const terms = `stacks, the blinds and antes, ${call ? 'his range, my pot odds' : 'who is behind me and how often they call'}${units === 'points' ? (bustOf(sp, d, s).canBust ? ', what going out would cost in league points' : ', how the stacks after the hand change my league points') : ''}`;
  lines.push('Please explain this decision to me like a good poker coach:');
  lines.push(v.close
    ? `1. Why are folding and ${call ? 'calling' : 'going all-in'} about equally good here? Explain it in plain poker terms (${terms}).`
    : `1. Why is ${bestName} better here? Explain it in plain poker terms (${terms}), and why the other play is worse.`);
  lines.push(v.right ? `2. I chose ${mine.toLowerCase()}. What makes that the right play, and what would change it?` : `2. I chose ${mine.toLowerCase()}. What did I miss?`);
  lines.push('3. Name the general principle behind this spot, so I can apply it in similar hands.');
  lines.push('Do not just repeat the numbers above; use them only where they support the explanation. Answer in the language I write my message in (English if I add nothing).');
  return lines.join('\n');
}
