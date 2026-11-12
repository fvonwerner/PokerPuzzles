// Grading, SPEC section 4. The only place that decides grades and points.

export const GRADING = Object.freeze({
  bestWithin: 0.05,          // Best: freq >= maxFreq - bestWithin
  correctMinFreq: 0.035,     // Correct: freq >= correctMinFreq
  correctBase: 60,           // Correct points: correctBase + correctSpan * freq / maxFreq
  correctSpan: 40,
  correctMaxLossPct: 0.2,    // solver: lossPct <= this is at least Correct; the solver's accuracy (hands solved to ~0.15% of the pot)
  inaccuracyMaxLossPct: 1.5, // solver: lossPct < this
  wrongMaxLossPct: 6,        // solver: lossPct < this
  points: { best: 100, inaccuracy: 40, wrong: 15, blunder: 0 },
  epsilon: 1e-9,             // tolerance for float comparisons of 3-decimal inputs
});

export const GRADE_LABELS = Object.freeze({
  best: 'Best', correct: 'Correct', inaccuracy: 'Inaccuracy', wrong: 'Wrong', blunder: 'Blunder',
});
export const GRADE_ORDER = ['best', 'correct', 'inaccuracy', 'wrong', 'blunder'];

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Grade one choice at a decision step (full solution data).
 * Returns { grade, label, points, freq, maxFreq, loss, lossPct } where loss and
 * lossPct are null for chart decisions.
 */
export function gradeDecision(decision, optionId, C = GRADING) {
  const k = decision.options.findIndex((o) => o.id === optionId);
  if (k < 0) throw new Error(`unknown option ${optionId}`);
  const freqs = decision.hand.freq;
  const freq = freqs[k];
  const maxFreq = Math.max(...freqs);
  const isChart = decision.source === 'chart';
  let loss = null, lossPct = null;
  if (!isChart && Array.isArray(decision.hand.ev)) {
    const evs = decision.hand.ev;
    loss = Math.max(0, Math.max(...evs) - evs[k]);
    lossPct = decision.state.pot > 0 ? (100 * loss) / decision.state.pot : 0;
  }
  const e = C.epsilon;
  let grade, points;
  if (freq >= maxFreq - C.bestWithin - e) { grade = 'best'; points = C.points.best; }
  else if (freq >= C.correctMinFreq - e) { grade = 'correct'; points = C.correctBase + (C.correctSpan * freq) / maxFreq; }
  else if (!isChart && lossPct !== null && lossPct <= C.correctMaxLossPct + e) { grade = 'correct'; points = C.correctBase + (C.correctSpan * freq) / maxFreq; }
  else if (isChart ? freq > 0 : lossPct < C.inaccuracyMaxLossPct) { grade = 'inaccuracy'; points = C.points.inaccuracy; }
  else if (isChart ? true : lossPct < C.wrongMaxLossPct) { grade = 'wrong'; points = C.points.wrong; }
  else { grade = 'blunder'; points = C.points.blunder; }
  return {
    grade, label: GRADE_LABELS[grade], points: round2(points), freq, maxFreq,
    loss: loss === null ? null : round2(loss),
    lossPct: lossPct === null ? null : round2(lossPct),
  };
}

/** Puzzle score: mean of decision points, rounded to an integer. */
export function puzzleScore(pointsList) {
  if (!pointsList.length) return 0;
  return Math.round(pointsList.reduce((a, b) => a + b, 0) / pointsList.length);
}
