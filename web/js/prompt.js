// "Copy for Claude": a ready-made prompt that describes an answered decision
// (or the whole finished hand) completely, to paste into Claude and ask for
// an explanation in plain poker terms.
//
// Pure: no DOM, no imports, so it runs in the browser and under plain node
// (server/tools/prompt-test.mjs). Input is what the play screen holds:
//   puzzle   the puzzle header (hero / villain seats and cards, scenario)
//   steps    the steps the client has been sent (may run past the decision)
//   reveals  { [decisionIndex]: reveal } of the answered decisions
//   index    the decision to describe, or whole: true for every decision
// Only what has been revealed is used. For one decision the steps after it
// are never read; villain strategy only where a step carries it; the
// solver's numbers come from that decision's reveal; never the header's
// board, the number of decisions or the tags.

const STREET = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };
const RANK_WORD = { A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: 'ten', 9: 'nine', 8: 'eight', 7: 'seven', 6: 'six', 5: 'five', 4: 'four', 3: 'three', 2: 'two' };
const GRADE = { best: 'Best', correct: 'Correct', inaccuracy: 'Inaccuracy', wrong: 'Wrong', blunder: 'Blunder', timeout: "Time's up" };
const POT_TYPE = { SRP: 'single-raised pot', '3BP': '3-bet pot', '4BP': '4-bet pot' };

const num = (x) => (typeof x !== 'number' || Number.isNaN(x) ? '?' : String(Math.round(x * 100) / 100));
const bb = (x) => `${num(x)} bb`;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
/** A frequency as a whole percent, never "0%" for something played or "100%" for a mix. */
function freq(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) return '?';
  const p = Math.round(x * 100);
  if (p === 0 && x > 1e-9) return '<1%';
  if (p === 100 && x < 1 - 1e-9) return '>99%';
  return `${p}%`;
}
const cardList = (cards) => (cards || []).join(' ');
const listAnd = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function handWords(cls) {
  if (!cls || cls.length < 2) return '';
  const a = RANK_WORD[cls[0]], b = RANK_WORD[cls[1]];
  if (cls[0] === cls[1]) return `a pair of ${a === 'six' ? 'sixe' : a}s`;
  return `${a}-${b} ${cls[2] === 's' ? 'suited' : 'offsuit'}`;
}

/** How an option reads as a choice: "Call 1.8 bb", "Bet 4.1 bb (75% of the pot)", "3-bet to 11 bb". */
export function optionText(o, street) {
  if (!o) return '?';
  switch (o.kind) {
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return typeof o.amount === 'number' ? `Call ${bb(o.amount)}` : 'Call';
    case 'bet': return `Bet ${bb(o.amount)}${typeof o.pctPot === 'number' ? ` (${o.pctPot}% of the pot)` : ''}`;
    case 'raise':
      if (street === 'preflop' && /-bet to/i.test(o.label || '')) return `${o.label.replace(/\s*bb$/i, '')} bb`;
      return `Raise to ${bb(o.amount)}`;
    case 'allin': return `All-in (${bb(o.amount)})`;
    default: return o.label || o.id || '?';
  }
}

/** The action as a verb phrase after a seat name ("bets 1.8 bb (33% of the pot)"). */
function actionPhrase(kind, { amount = null, pctPot = null, add = null, raiseWord = 'raises to' } = {}) {
  switch (kind) {
    case 'fold': return 'folds';
    case 'check': return 'checks';
    case 'call': return `calls ${bb(add ?? amount)}`;
    case 'bet': return `bets ${bb(amount)}${typeof pctPot === 'number' ? ` (${pctPot}% of the pot)` : ''}`;
    case 'raise': return `${raiseWord} ${bb(amount)}`;
    case 'allin': return `goes all-in (${bb(amount)})`;
    default: return kind;
  }
}

/** Index of the option the solver plays most with the hand, and every option graded Best. */
function bestOptions(d) {
  const f = d.hand?.freq || [];
  const max = Math.max(...f);
  const top = f.indexOf(max);
  const best = d.options.map((o, k) => k).filter((k) => f[k] >= max - 0.05 - 1e-9);
  return { top, best };
}

/** Per-option grade data: from the reveal (server) when there, else the EV loss worked out here. */
function lossOf(rv, k) {
  const g = rv.optionGrades?.[k];
  if (g && g.id === rv.decision.options[k].id) return { loss: g.loss, lossPct: g.lossPct, grade: g.grade, points: g.points };
  const ev = rv.decision.hand?.ev;
  if (!Array.isArray(ev)) return { loss: null, lossPct: null };
  const loss = Math.max(0, Math.max(...ev) - ev[k]);
  const pot = rv.decision.state?.pot;
  return { loss, lossPct: pot > 0 ? (100 * loss) / pot : null };
}

/**
 * Walk the steps 0..limit-1 and describe the action street by street.
 * Returns { lines, board } (board = the cards dealt within the limit).
 */
function history({ puzzle, steps, reveals, limit, heroName }) {
  const heroSeat = puzzle.hero.seat, villainSeat = puzzle.villain.seat;
  const name = (seat) => (seat === heroSeat ? heroName : seat);
  const lines = [];
  const board = [];
  const bets = { SB: 0.5, BB: 1 }; // preflop: what each seat has in (third parties have no state)
  let raises = 0; // preflop raises so far (an open is the first)
  let street = 'preflop';
  let cur = [];
  let head = 'Preflop (blinds: SB 0.5 bb, BB 1 bb)';
  const flush = () => { lines.push(`${head}: ${cur.length ? `${cur.join(', ')}.` : 'no action yet.'}`); cur = []; };
  const raiseWord = () => { raises += 1; return raises === 1 ? 'raises to' : `${raises + 1}-bets to`; };
  for (let i = 0; i < limit && i < steps.length; i++) {
    const s = steps[i];
    if (!s) break;
    if (s.type === 'deal') {
      flush();
      street = s.street;
      board.push(...(s.cards || []));
      const pot = s.state ? `, pot ${bb(s.state.pot)}` : '';
      head = s.street === 'flop' ? `Flop ${cardList(s.cards)}${pot}` : `${STREET[s.street]} ${cardList(s.cards)} (board ${cardList(board)}${pot})`;
    } else if (s.type === 'action') {
      if (street === 'preflop') {
        const before = bets[s.seat] || 0;
        let phrase;
        if (s.kind === 'raise' || s.kind === 'allin') phrase = actionPhrase(s.kind, { amount: s.amount, raiseWord: raiseWord() });
        else if (s.kind === 'call') phrase = actionPhrase('call', { add: Math.round(((s.amount || 0) - before) * 100) / 100 });
        else phrase = actionPhrase(s.kind);
        if (typeof s.amount === 'number') bets[s.seat] = s.amount;
        cur.push(`${name(s.seat)} ${phrase}`);
      } else {
        cur.push(`${name(s.seat)} ${actionPhrase(s.kind, { amount: s.amount })}${s.kind === 'check' ? ' (the only option in this game tree)' : ''}`);
      }
    } else if (s.type === 'villain') {
      const a = s.action || {};
      let t = `${name(s.seat)} ${actionPhrase(a.kind, { amount: a.amount, pctPot: a.pctPot, raiseWord: 'raises to' })}`;
      if (typeof s.freq === 'number') t += ` [the solver's ${s.seat} does this with ${freq(s.freq)} of their range here]`;
      cur.push(t);
    } else if (s.type === 'decision') {
      if (!('mainLine' in s)) break; // not answered: nothing of it may be told
      const main = s.options.find((o) => o.id === s.mainLine);
      const before = street === 'preflop' ? (bets[heroSeat] || 0) : 0;
      let phrase;
      if (street === 'preflop' && (main.kind === 'raise' || main.kind === 'allin')) phrase = actionPhrase(main.kind, { amount: main.amount, raiseWord: raiseWord() });
      else phrase = actionPhrase(main.kind, { amount: main.amount, pctPot: main.pctPot, add: main.kind === 'call' ? main.amount : null });
      if (street === 'preflop' && s.stateAfter) bets[heroSeat] = s.stateAfter.heroBet;
      else if (street === 'preflop' && typeof main.amount === 'number') bets[heroSeat] = main.kind === 'call' ? before + main.amount : main.amount;
      const rv = reveals[s.index];
      let note = '';
      if (rv) {
        if (rv.timeout) note = ` [my decision ${s.index + 1}: I ran out of time, 0 points; the hand went on with the solver's line]`;
        else if (rv.choice !== s.mainLine) note = ` [my decision ${s.index + 1}: I chose ${optionText(s.options.find((o) => o.id === rv.choice) || { label: rv.choiceLabel }, s.street)}, graded ${GRADE[rv.grade] || rv.grade}; the puzzle goes on with the solver's line, shown here]`;
        else note = ` [my decision ${s.index + 1}, graded ${GRADE[rv.grade] || rv.grade}]`;
      }
      cur.push(`${heroName} ${phrase}${note}`);
    }
  }
  flush();
  return { lines, board };
}

/** Everything about one answered decision, as plain lines. */
function decisionBlock({ rv, board, puzzle, heading }) {
  const d = rv.decision;
  const chart = d.source === 'chart';
  const st = d.state || {};
  const out = [heading];
  out.push(`Board: ${board.length ? cardList(board) : 'none yet (preflop)'}.`);
  const streetBets = d.street !== 'preflop' && (st.heroBet || st.villainBet);
  out.push(`Pot: ${bb(st.pot)}${streetBets ? ` (this includes the bets on this street: mine ${bb(st.heroBet || 0)}, villain's ${bb(st.villainBet || 0)})` : ''}.`);
  out.push(`Stacks behind: mine ${bb(st.heroStack)}, villain's ${bb(st.villainStack)}.`);
  if (d.options.some((o) => o.kind === 'call') && d.toCall > 0) out.push(`To call: ${bb(d.toCall)}.`);
  out.push(`Options: ${d.options.map((o) => optionText(o, d.street)).join(' | ')}.`);
  const f = d.hand?.freq || [];
  const ev = d.hand?.ev;
  const hand = `${cardList(puzzle.hero.hand)}`;
  if (chart) {
    out.push(`This is a preflop decision graded against a preflop chart (no EV numbers). What the chart does with my hand (${puzzle.hero.handClass || hand}):`);
    d.options.forEach((o, k) => out.push(`- ${optionText(o, d.street)}: ${freq(f[k])}`));
  } else {
    out.push(`What the solver does with my exact hand (${hand}), with the EV of each option (EVs share one baseline; only the differences matter):`);
    d.options.forEach((o, k) => {
      const { loss, lossPct } = lossOf(rv, k);
      const evText = Array.isArray(ev) ? `, EV ${bb(ev[k])}` : '';
      const lossText = loss === null || loss === undefined ? '' : loss < 0.005 ? ', the best EV' : `, ${bb(loss)} less than the best option (${num(lossPct)}% of the pot)`;
      out.push(`- ${optionText(o, d.street)}: played ${freq(f[k])}${evText}${lossText}`);
    });
    if (typeof d.hand?.equity === 'number') out.push(`My hand's equity against villain's range here: ${pct1(d.hand.equity)}.`);
  }
  if (d.range && Array.isArray(d.range.freq)) {
    out.push(`How my whole range plays this spot (${chart ? 'chart' : 'solver'}): ${d.options.map((o, k) => `${optionText(o, d.street)} ${freq(d.range.freq[k])}`).join(', ')}.`);
  }
  if (typeof d.range?.equity === 'number' || typeof d.villainRange?.equity === 'number') {
    const mine = d.range?.equity, theirs = d.villainRange?.equity;
    out.push(`Range equity: mine ${typeof mine === 'number' ? pct1(mine) : '?'}, villain's ${typeof theirs === 'number' ? pct1(theirs) : '?'}.`);
  }
  if (rv.timeout) out.push('My answer: none, I ran out of time (0 points).');
  else {
    const k = d.options.findIndex((o) => o.id === rv.choice);
    const chosen = k >= 0 ? optionText(d.options[k], d.street) : rv.choiceLabel;
    out.push(`My answer: ${chosen}. The app graded it ${GRADE[rv.grade] || rv.grade}: ${Math.round(rv.points)} of 100 points.`);
  }
  return out;
}

function context(puzzle) {
  const h = puzzle.hero, v = puzzle.villain;
  const pos = (p) => (p === 'ip' ? 'in position' : 'out of position');
  const sc = puzzle.scenario || {};
  const stack = puzzle.startingStackBb ?? 100;
  return [
    `Game: 6-max no-limit hold'em cash game, ${num(stack)} bb stacks, no ante, no rake. Blinds 0.5 / 1 bb. All amounts are in big blinds (bb).`,
    sc.name ? `Spot: ${sc.name}${POT_TYPE[sc.potType] ? ` (${POT_TYPE[sc.potType]})` : ''}.` : null,
    `Me (hero): ${h.seat}, ${pos(h.position)} after the flop, holding ${cardList(h.hand)}${h.handClass ? ` (${h.handClass}, ${handWords(h.handClass)})` : ''}.`,
    `Villain: ${v.seat}, ${pos(v.position)}.`,
    'Grades in the app: Best (what the solver plays most with my hand, 100 points), then Correct, Inaccuracy, Wrong and Blunder (0 points).',
  ].filter(Boolean);
}

/**
 * The prompt text, or null when the decision is not answered (or not in the steps).
 * { puzzle, steps, reveals, index } for one decision; { puzzle, steps, reveals, whole: true } for the hand.
 */
export function buildPrompt({ puzzle, steps, reveals = {}, index = null, whole = false } = {}) {
  if (!puzzle?.hero || !puzzle?.villain || !Array.isArray(steps)) return null;
  const rvs = reveals || {};
  const posOf = (i) => steps.findIndex((s) => s && s.type === 'decision' && s.index === i);
  const answered = (i) => {
    const p = posOf(i);
    return p >= 0 && !!rvs[i]?.decision && 'mainLine' in steps[p];
  };
  const heroName = `${puzzle.hero.seat} (me)`;
  const title = puzzle.title ? ` (PokerPuzzles${puzzle.number ? ` #${puzzle.number}` : ''}: ${puzzle.title})` : '';
  const ask = [];

  if (!whole) {
    if (!Number.isInteger(index) || !answered(index)) return null;
    const pos = posOf(index);
    const rv = rvs[index];
    const { lines, board } = history({ puzzle, steps, reveals: rvs, limit: pos, heroName });
    const d = rv.decision;
    const { top, best } = bestOptions(d);
    const bestText = best.length > 1
      ? `the solver's preferred play (it mixes ${listAnd(best.map((k) => optionText(d.options[k], d.street)))}; mostly ${optionText(d.options[top], d.street)})`
      : optionText(d.options[top], d.street);
    const chosenK = d.options.findIndex((o) => o.id === rv.choice);
    const chosenText = chosenK >= 0 ? optionText(d.options[chosenK], d.street) : rv.choiceLabel;
    ask.push(
      'Please explain this decision to me like a good poker coach:',
      `1. Why is ${bestText} the best play here? Explain it in plain poker terms (ranges, board, position, stack and pot sizes, what villain holds and does), and why the other options are worse.`,
      rv.timeout
        ? '2. I ran out of time on this decision. What should I look at first to find the right play quickly in a spot like this?'
        : best.includes(chosenK)
          ? `2. I chose ${chosenText}. Why was that fine, and when would one of the other options be better?`
          : `2. I chose ${chosenText}. Was that fine or not, and why?`,
      '3. Name the general principle behind this spot, so I can apply it in similar hands.',
      'Do not just repeat the numbers above; use them only where they support the explanation. Answer in the language I write my message in (English if I add nothing).',
    );
    return [
      `I am training poker with a GTO solver and want to understand one of my decisions${title}.`,
      '',
      ...context(puzzle),
      '',
      'The hand so far:',
      ...lines,
      '',
      ...decisionBlock({ rv, board, puzzle, heading: `THE DECISION: my decision ${index + 1}, ${STREET[d.street].toLowerCase()}.` }),
      '',
      ...ask,
    ].join('\n');
  }

  // The whole hand: every answered decision in order (the finished view).
  const done = Object.keys(rvs).map(Number).filter((i) => Number.isInteger(i) && answered(i)).sort((a, b) => a - b);
  if (!done.length) return null;
  const finished = steps.at(-1)?.type === 'end';
  const limit = finished ? steps.length - 1 : posOf(done.at(-1)) + 1;
  const { lines } = history({ puzzle, steps, reveals: rvs, limit, heroName });
  const blocks = [];
  for (const i of done) {
    const pos = posOf(i);
    const board = [];
    for (let k = 0; k < pos; k++) if (steps[k]?.type === 'deal') board.push(...(steps[k].cards || []));
    blocks.push('', ...decisionBlock({ rv: rvs[i], board, puzzle, heading: `MY DECISION ${i + 1} (${STREET[rvs[i].decision.street].toLowerCase()}):` }));
  }
  const end = finished ? steps.at(-1) : null;
  const result = [];
  if (end) {
    const net = typeof end.heroNet === 'number' ? (end.heroNet > 0 ? `I win ${bb(end.heroNet)}` : end.heroNet < 0 ? `I lose ${bb(-end.heroNet)}` : 'I break even') : '';
    if (end.reason === 'hero_fold') result.push(`How the hand ended along the solver's line: I fold; ${net}.`);
    else if (end.reason === 'villain_fold') result.push(`How the hand ended along the solver's line: villain folds; ${net}.`);
    else if (end.showdown) {
      const sd = end.showdown;
      const low = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
      result.push(`How the hand ended along the solver's line: showdown. Villain shows ${cardList(sd.villainHand)}${sd.villainHandName ? ` (${low(sd.villainHandName)})` : ''}${sd.heroHandName ? ` against my ${low(sd.heroHandName)}` : ''}; ${sd.winner === 'split' ? 'the pot is split' : net}. (Villain's cards are one sample from their range; the result does not matter for judging the decisions.)`);
    }
  }
  ask.push(
    'Please go through my decisions in order, like a good poker coach:',
    '- For each one, explain in plain poker terms why the best option is best there, and whether my answer was fine or not, and why.',
    '- Then name the general principles this hand teaches, so I can apply them in similar hands.',
    'Do not just repeat the numbers above; use them only where they support the explanation. Answer in the language I write my message in (English if I add nothing).',
  );
  return [
    `I am training poker with a GTO solver and want to understand my decisions in this hand${title}. The puzzle always continues along the solver's line, so where I chose differently, the hand went on as shown.`,
    '',
    ...context(puzzle),
    '',
    'The hand:',
    ...lines,
    ...(result.length ? ['', ...result] : []),
    ...blocks,
    '',
    ...ask,
  ].join('\n');
}
