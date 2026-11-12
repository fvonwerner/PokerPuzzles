// The feedback panel shown after a decision, and the villain-node panel.
// Both are laid out to fill the side panel's height: a compact head, then
// tabs whose panels flex to the space that is left (the range grid sizes
// itself from that space). Also the "trying again" card of an answered
// decision and the "Copy for Claude" button.
import { h, fmtBb, fmtFreq, gradeBadge, STREETS, GRADE_LABEL, GRADE_ICON } from './ui.js';
import { actionColors, shortLabel, pctOfPot } from './poker.js';
import { rangeGrid, freqBar, equityBar } from './grid.js';
import { setLinkedText } from './learn.js';

function tabs(defs, { cls = '', initial = 0 } = {}) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  const buttons = [], panels = [];
  const select = (n, focus) => {
    buttons.forEach((b, k) => { b.setAttribute('aria-selected', String(k === n)); b.tabIndex = k === n ? 0 : -1; });
    panels.forEach((p, k) => {
      p.hidden = k !== n;
      if (k === n && !p.dataset.done) { p.dataset.done = '1'; p.append(defs[k].render()); } // render lazily
    });
    if (focus) buttons[n].focus();
  };
  defs.forEach((d, k) => {
    buttons.push(h('button.tab', {
      type: 'button', role: 'tab', id: `${id}-tab${k}`, 'aria-controls': `${id}-p${k}`,
      on: {
        click: () => select(k),
        keydown: (e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); select((k + 1) % defs.length, true); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); select((k - 1 + defs.length) % defs.length, true); }
        },
      },
    }, d.label));
    panels.push(h('div.tabpanel', { role: 'tabpanel', id: `${id}-p${k}`, 'aria-labelledby': `${id}-tab${k}` }));
  });
  const el = h(`div.tabs${cls}`, h('div.tablist', { role: 'tablist' }, buttons), panels);
  select(initial);
  return el;
}

function rangesView(d, heroClass, heroCards) {
  const colors = actionColors(d.options);
  return tabs([
    {
      label: 'Your range',
      render: () => h('div.range-view',
        freqBar(d.range.freq, d.options, colors, { title: 'Your whole range', heading: 'Your whole range' }),
        equityBar(d.range.equity ?? null, d.villainRange?.equity ?? null),
        rangeGrid({
          range: d.range, options: d.options, colors, highlight: heroClass, caption: 'Your range by action',
          exact: heroCards && d.hand?.freq ? { cards: heroCards, freq: d.hand.freq } : null, // the buttons' numbers
        })),
    },
    {
      label: "Villain's range",
      render: () => (d.villainRange
        ? h('div.range-view',
          equityBar(d.range.equity ?? (d.villainRange.equity !== null ? 1 - d.villainRange.equity : null), d.villainRange.equity),
          rangeGrid({ range: d.villainRange, heat: true, highlight: heroClass, caption: "Villain's range" }))
        : h('p.muted.pad', 'Preflop chart decisions are graded against the chart only; there is no villain range for them.')),
    },
  ], { cls: '.tabs-seg' });
}

/** An option's name on a button: "Raise to 5.4", shortened to "Raise 5.4" where buttons are narrow (phones). */
export function optLabel(o) {
  if (o.kind !== 'raise') return shortLabel(o);
  return [h('span.t-long', `Raise to ${fmtBb(o.amount)}`), h('span.t-short', shortLabel(o))];
}

/** "You chose X · EV loss" line for a reveal. */
function choiceLine(rv, note = null) {
  if (rv.timeout) return h('p.fb-choice.fb-timeout', h('b', "Time's up"), ' · no answer in time, 0 points. This is what the solver does here:');
  const d = rv.decision;
  const isChart = d.source === 'chart';
  const k = d.options.findIndex((o) => o.id === rv.choice);
  const pct = isChart || k < 0 ? null : pctOfPot(d.options[k], d.state); // no % of pot preflop
  return h('p.fb-choice', note || 'You chose ', h('b', rv.choiceLabel),
    pct !== null && !['fold', 'check', 'bet'].includes(d.options[k].kind) && !/%/.test(rv.choiceLabel) ? h('span.muted', ` (${pct}% pot)`) : null,
    isChart ? null : [' · ', h('span.fb-loss', rv.loss > 0
      ? ['EV loss ', h('b.num', `${fmtBb(rv.loss)} bb`), ' (', h('b.num', `${fmtBb(rv.lossPct)}%`), ' of pot)']
      : 'no EV lost')]);
}

const CLIP_ICON = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><rect x="6" y="5" width="10" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 13V4.5A1.5 1.5 0 0 1 5.5 3H12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

/** "Copy for Claude": puts a prompt describing the spot on the clipboard (onCopy builds and copies it). */
export function copyButton(onCopy, { label = 'Copy for Claude', what = 'this decision' } = {}) {
  return h('button.btn.btn-ghost.btn-sm.copy-claude', {
    type: 'button',
    title: `Copies a ready-made question about ${what} (the whole situation and the solver's numbers) to paste into Claude`,
    on: { click: onCopy },
  }, h('span.copy-ico', { html: CLIP_ICON }), label);
}

/**
 * Why + ranges for one decision (shared by the feedback and end panels).
 * opts.onCopy: show "Copy for Claude" (only where the solver's answer is revealed and no decision is open).
 */
export function decisionBody(rv, puzzle, { onCopy = null } = {}) {
  const text = rv.explanation?.text;
  return [
    text || onCopy ? h('section.fb-why',
      h('div.fb-why-head', h('h3.fb-h', text ? 'Why' : 'Ask about it'), onCopy ? copyButton(onCopy) : null),
      text ? setLinkedText(h('p.explain'), text) : null) : null,
    h('section.fb-ranges', rangesView(rv.decision, puzzle.hero.handClass, puzzle.hero.hand)),
  ];
}
export { choiceLine };

/**
 * Feedback panel for a reveal: grade and points, what you chose (with the EV
 * loss for solver decisions), why, then the ranges filling the rest.
 * The hand's own strategy is shown on the answered action buttons instead.
 * opts: { puzzle, practice, onCopy }
 */
export function feedbackPanel(rv, { puzzle, practice = false, onCopy = null } = {}) {
  const d = rv.decision;
  const head = h('div.fb-head',
    h('div.fb-grade', gradeBadge(rv.grade), h('span.fb-points', h('b.num', Math.round(rv.points)), ' pts'),
      h('span.fb-street', `${STREETS[d.street]} · decision ${d.index + 1}`)), // never "of N": that would tell how the hand goes on
    practice ? h('span.tag.tag-practice', 'Practice · not counted') : null,
    choiceLine(rv));
  return h('div.feedback', { role: 'region', 'aria-label': 'Feedback' }, head, ...decisionBody(rv, puzzle, { onCopy }));
}

/**
 * "Trying again": what option `optionId` of an answered decision would have
 * scored, beside the real answer (which stays as it was). Local only.
 */
export function trialCard(rv, optionId, { onClose = null } = {}) {
  const d = rv.decision;
  const k = d.options.findIndex((o) => o.id === optionId);
  if (k < 0) return null;
  const o = d.options[k];
  const g = rv.optionGrades?.[k]?.id === o.id ? rv.optionGrades[k] : null;
  const isChart = d.source === 'chart';
  const ev = d.hand.ev;
  const loss = g ? g.loss : (Array.isArray(ev) ? Math.max(0, Math.max(...ev) - ev[k]) : null);
  const lossPct = g ? g.lossPct : (loss !== null && d.state.pot > 0 ? (100 * loss) / d.state.pot : null);
  const label = o.kind === 'raise' ? `Raise to ${fmtBb(o.amount)}` : shortLabel(o);
  const same = o.id === rv.choice;
  const yours = rv.timeout
    ? h('p.tc-yours', h('span.tc-k', 'Your answer'), ' ', h('b', "Time's up"), ' · ', gradeBadge('timeout', { small: true }), h('b.num', ' 0'), ' pts')
    : h('p.tc-yours', h('span.tc-k', 'Your answer'), ' ', h('b', rv.choiceLabel), ' · ', gradeBadge(rv.grade, { small: true }), ' ', h('b.num', Math.round(rv.points)), ' pts');
  return h('section.trial-card', { 'aria-label': 'Trying again: your score stays the same' },
    h('div.tc-top',
      h('p.tc-kicker', h('b', 'Trying again'), ' · your score stays the same'),
      onClose ? h('button.btn.btn-ghost.btn-sm.tc-close', { type: 'button', 'aria-label': 'Stop trying', title: 'Stop trying', on: { click: onClose } }, '✕') : null),
    h('div.tc-main',
      h('span.tc-opt', { style: { '--opt': actionColors(d.options)[k] } }, label),
      g ? gradeBadge(g.grade) : null,
      g ? h('span.tc-pts', h('b.num', Math.round(g.points)), ' pts') : h('span.tc-pts.muted', 'no grade')),
    h('p.tc-facts',
      isChart ? 'The chart plays it ' : 'The solver plays it ', h('b.num', fmtFreq(d.hand.freq[k])), ' with your hand',
      isChart || loss === null ? null : [' · ', loss > 0.0049 ? ['EV loss ', h('b.num', `${fmtBb(loss)} bb`), ' (', h('b.num', `${fmtBb(lossPct)}%`), ' of pot)'] : 'no EV lost'],
      same && !rv.timeout ? h('span.tc-same', ' · this was your answer') : null),
    rv.stale ? h('p.tc-note', 'This puzzle was re-solved since you played it: trying uses the current solution.') : null,
    yours);
}

/** Options of an answered decision as live buttons again ("try another answer"; nothing is sent). */
export function trialButtons(rv, { trying = null, tried = null, onTry }) {
  const d = rv.decision;
  const colors = actionColors(d.options);
  return h('div.bar-buttons.trial-buttons', { role: 'group', 'aria-label': 'Try another answer. Your score stays the same' },
    d.options.map((o, k) => {
      const g = rv.optionGrades?.[k]?.id === o.id ? rv.optionGrades[k] : null;
      const mine = o.id === rv.choice;
      const done = !!tried?.has(o.id) && g;
      const pct = d.source === 'chart' ? null : pctOfPot(o, d.state);
      return h(`button.opt.k-${o.kind}${mine ? '.yours' : ''}${o.id === trying ? '.trying' : ''}`, {
        type: 'button', style: { '--opt': colors[k] }, dataset: { opt: o.id, rw: `opt-${o.id}` },
        'aria-keyshortcuts': String(k + 1), 'aria-pressed': String(o.id === trying),
        'aria-label': `Try ${shortLabel(o)}${mine ? ' (your answer)' : ''}${done ? `: ${GRADE_LABEL[g.grade]}, ${Math.round(g.points)} points` : ''}`,
        on: { click: () => onTry(o.id) },
      },
      h('span.opt-key', { 'aria-hidden': 'true' }, k + 1),
      h('span.opt-main', optLabel(o)),
      h('span.opt-sub', o.kind === 'fold' || o.kind === 'check' ? ' ' : `${fmtBb(o.amount)} bb${pct !== null ? ` · ${pct}% pot` : ''}`),
      mine ? h('span.try-yours', { 'aria-hidden': 'true' }, h('span.t-long', 'your answer'), h('span.t-short', 'you')) : null,
      done ? h(`span.try-chip.g-${g.grade}`, { 'aria-hidden': 'true' }, h('span.try-ico', GRADE_ICON[g.grade]), Math.round(g.points)) : null);
    }));
}

/**
 * The answered decision as the action bar shows it: every option keeps its
 * label and colour and shows the solver/chart frequency for your hand in big
 * type, the EV loss (solver decisions), your pick and the main line marked.
 * `opp` marks battle opponents' picks: one ({ optionId, name, fresh, color }) or a list
 * of them. One opponent: a name tag and a dashed ring in their colour; two: small
 * initial chips in their colours at the button's lower corner (they never collide
 * with the "you" / "main line" tags).
 */
export function answerButtons(rv, { affirm = false, opp = null } = {}) {
  const opps = (Array.isArray(opp) ? opp : opp ? [opp] : []).filter((o) => o && o.optionId);
  const single = opps.length === 1 && !Array.isArray(opp) ? opps[0] : (Array.isArray(opp) && opp.length === 1 ? opps[0] : null);
  const d = rv.decision;
  const colors = actionColors(d.options);
  const isChart = d.source === 'chart';
  const evs = d.hand.ev;
  const best = evs ? Math.max(...evs) : null;
  const G = { best: ['good', '✓'], correct: ['good', '✓'], inaccuracy: ['meh', '~'], wrong: ['bad', '✕'], blunder: ['bad', '✕'], timeout: ['bad', '⏱'] }[rv.grade];
  return h('div.bar-buttons.answers', { role: 'list', 'aria-label': isChart ? 'Chart frequencies for your hand' : 'Solver strategy for your hand' },
    d.options.map((o, k) => {
      const mine = o.id === rv.choice, main = o.id === d.mainLine;
      const here = opps.filter((x) => x.optionId === o.id);
      const theirs = single && single.optionId === o.id ? single : null;
      const loss = evs ? best - evs[k] : null;
      return h(`div.opt.ans.k-${o.kind}${mine ? `.mine.affirm-${G[0]}${affirm ? '.affirm' : ''}` : ''}${main ? '.main' : ''}${theirs ? `.opp-pick.oc${theirs.color || 1}${theirs.fresh ? '.opp-fresh' : ''}` : ''}`, {
        role: 'listitem', style: { '--opt': colors[k] },
        'aria-label': `${shortLabel(o)}: ${fmtFreq(d.hand.freq[k])}${loss !== null ? (loss > 0.0049 ? `, loses ${fmtBb(loss)} bb` : ', best EV') : ''}${mine ? ', your pick' : ''}${here.length ? `, ${here.map((x) => `${x.name}'s pick`).join(', ')}` : ''}${main ? ', main line' : ''}`,
      },
      h('span.ans-label', optLabel(o)),
      h('span.ans-pct.num', fmtFreq(d.hand.freq[k])),
      isChart ? null : h('span.ans-ev.num', loss > 0.0049 ? `−${fmtBb(loss)} bb` : 'best'),
      mine || main || theirs ? h('span.ans-tags', mine ? h('span.ans-tag.ans-you', 'you') : null, theirs ? h(`span.ans-tag.ans-opp.oc${theirs.color || 1}`, { title: `${theirs.name}'s pick` }, theirs.name) : null, main ? h('span.ans-tag.ans-main', { title: 'The hand goes on with this (the main line)' }, h('span.t-long', 'main line'), h('span.t-short', 'main')) : null) : null,
      !single && here.length ? h('span.ans-opps', { 'aria-hidden': 'true' }, here.map((x) => h(`span.ans-chip.oc${x.color || 1}${x.fresh ? '.opp-fresh' : ''}`, { title: `${x.name}'s pick` }, (x.name || '?').trim().charAt(0).toUpperCase()))) : null,
      mine ? h('span.affirm-icon', { 'aria-hidden': 'true' }, G[1]) : null);
    }));
}

/** Panel for a villain node looked back at (its strategy, once revealed). */
export function villainPanel(step, puzzle) {
  const colors = actionColors(step.options);
  return h('div.feedback.villain-panel', { role: 'region', 'aria-label': "Villain's strategy" },
    h('div.fb-head',
      h('div.fb-grade', h('span.fb-street', `${STREETS[step.street]} · ${step.seat} (villain)`)),
      h('p.fb-choice', 'Villain chose ', h('b', step.action.label || shortLabel(step.action)), h('span.muted', ` · ${fmtFreq(step.freq)} of the range does this`))),
    h('div.range-view.villain-view',
      freqBar(step.range.freq, step.options, colors, { marked: step.action.id, title: "Villain's whole range", heading: "Villain's whole range" }),
      rangeGrid({ range: step.range, options: step.options, colors, highlight: puzzle.hero.handClass, caption: "Villain's range by action" })));
}
