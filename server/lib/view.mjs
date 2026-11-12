// Turns solution files into what the client may see. Raw solution files are
// never served; everything leaves the server through these functions.
import { gradeDecision, gradeOptions } from './grading.mjs';

const pct = (x) => `${Math.round(x * 100)}%`;
const bb = (x) => `${Math.round(x * 100) / 100} bb`;

/** Puzzle header. `tags` adds the tags (completed puzzles); `full` adds tags, board and solver meta (review only). */
export function header(p, { full = false, tags = false, count = true } = {}) {
  const s = p.solution;
  const h = {
    id: s.id, number: p.number, title: s.title,
    scenario: s.scenario, hero: s.hero, villain: s.villain,
    startingStackBb: s.startingStackBb ?? 100,
  };
  // How many decisions a hand has would tell an unfinished player how it goes on: finished hands only.
  if (count || full) h.decisionCount = p.decisionCount;
  if (full || tags) h.tags = s.tags || []; // tags can spoil the answer: completed puzzles only
  if (full) Object.assign(h, { board: s.board, solver: s.solver, warnings: s.warnings || [] });
  return h;
}

function stripDecision(d) {
  return { type: 'decision', index: d.index, street: d.street, source: d.source, state: d.state, toCall: d.toCall, options: d.options };
}
function stripVillain(v) {
  const out = { type: 'villain', street: v.street, seat: v.seat, action: v.action };
  if (v.state) out.state = v.state;
  return out;
}

/**
 * Steps the client may see when `answered` decisions (0..answered-1) have been
 * answered on this play: everything up to and including the first unanswered
 * decision, stripped of anything that would give the answer away.
 */
export function publicSteps(p, answered) {
  const steps = p.solution.steps;
  const all = answered >= p.decisionCount;
  const upto = all ? steps.length - 1 : p.decisionPositions[answered];
  // Position of the last answered decision: villain steps before it are revealed.
  const lastAnsweredPos = answered > 0 ? p.decisionPositions[answered - 1] : -1;
  const out = [];
  for (let i = 0; i <= upto; i++) {
    const s = steps[i];
    if (s.type === 'decision') out.push(s.index < answered ? s : stripDecision(s));
    else if (s.type === 'villain') out.push(all || i < lastAnsweredPos ? s : stripVillain(s));
    else out.push(s); // action, deal, end: nothing secret in them
  }
  return out;
}

export function decisionStep(p, index) {
  return p.solution.steps[p.decisionPositions[index]];
}

function generatedExplanation(p, d) {
  const cls = p.solution.hero.handClass || p.solution.hero.hand?.join('');
  const order = d.options.map((o, k) => k).sort((a, b) => d.hand.freq[b] - d.hand.freq[a]);
  const [b, s] = order;
  const top = d.options[b], second = s !== undefined ? d.options[s] : null;
  if (d.source === 'chart') {
    const played = order.filter((k) => d.hand.freq[k] > 0);
    if (played.length <= 1) return `With ${cls} the preflop chart always chooses ${top.label}.`;
    return `With ${cls} the preflop chart mixes ${played.map((k) => `${d.options[k].label} (${pct(d.hand.freq[k])})`).join(' and ')}.`;
  }
  const ev = d.hand.ev;
  const bestEv = Math.max(...ev);
  let text = `With ${cls} the solver prefers ${top.label} (${pct(d.hand.freq[b])})`;
  if (second) {
    const gap = Math.max(0, bestEv - ev[s]);
    text += d.hand.freq[s] > 0
      ? `; ${second.label} is played ${pct(d.hand.freq[s])} and is ${bb(gap)} below the best option.`
      : `; the next option, ${second.label}, gives up ${bb(gap)}.`;
  } else text += '.';
  return text;
}

export function explanationFor(p, index) {
  const e = p.explanations?.decisions?.[String(index)];
  if (typeof e === 'string' && e.trim()) return { text: e, generated: false };
  return { text: generatedExplanation(p, decisionStep(p, index)), generated: true };
}

/**
 * What every option of a decision would have scored, in the order of
 * `d.options` (the "try another answer" view of an answered decision). Part
 * of a reveal only, so it leaves the server together with the rest of it.
 */
export const optionGrades = (d) => gradeOptions(d);

/** The full reveal for one answered decision. */
export function reveal(p, index, optionId) {
  const d = decisionStep(p, index);
  const g = gradeDecision(d, optionId);
  const choice = d.options.find((o) => o.id === optionId);
  const main = d.options.find((o) => o.id === d.mainLine);
  const offMainLine = optionId !== d.mainLine;
  return {
    index, choice: optionId, choiceLabel: choice.label, ...g,
    decision: d,
    optionGrades: optionGrades(d),
    explanation: explanationFor(p, index),
    offMainLine,
    mainLine: { id: main.id, label: main.label },
    continuesWith: offMainLine ? `The hand continues with ${main.label}.` : null,
  };
}

/** The reveal for a battle decision that ran out of time: no choice, 0 points, the solver's answer and analysis as usual. */
export function timeoutReveal(p, index) {
  const d = decisionStep(p, index);
  const main = d.options.find((o) => o.id === d.mainLine);
  const maxFreq = Math.max(...d.hand.freq);
  return {
    index, choice: null, choiceLabel: 'No answer', grade: 'timeout', label: "Time's up", points: 0,
    freq: null, maxFreq, loss: null, lossPct: null, timeout: true,
    decision: d,
    optionGrades: optionGrades(d),
    explanation: explanationFor(p, index),
    offMainLine: false,
    mainLine: { id: main.id, label: main.label },
    continuesWith: `Time ran out. The hand continues with ${main.label}.`,
  };
}

export function endStep(p) {
  return p.solution.steps.at(-1);
}
