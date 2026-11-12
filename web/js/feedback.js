// The feedback panel shown after a decision, and the villain-node panel.
// Both are laid out to fill the side panel's height: a compact head, then
// tabs whose panels flex to the space that is left (the range grid sizes
// itself from that space).
import { h, fmtBb, fmtFreq, gradeBadge, STREETS } from './ui.js';
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

/** Why + ranges for one decision (shared by the feedback and end panels). */
export function decisionBody(rv, puzzle) {
  return [
    rv.explanation?.text ? h('section.fb-why', h('h3.fb-h', 'Why'), setLinkedText(h('p.explain'), rv.explanation.text)) : null,
    h('section.fb-ranges', rangesView(rv.decision, puzzle.hero.handClass, puzzle.hero.hand)),
  ];
}
export { choiceLine };

/**
 * Feedback panel for a reveal: grade and points, what you chose (with the EV
 * loss for solver decisions), why, then the ranges filling the rest.
 * The hand's own strategy is shown on the answered action buttons instead.
 * opts: { puzzle, practice }
 */
export function feedbackPanel(rv, { puzzle, practice = false } = {}) {
  const d = rv.decision;
  const head = h('div.fb-head',
    h('div.fb-grade', gradeBadge(rv.grade), h('span.fb-points', h('b.num', Math.round(rv.points)), ' pts'),
      h('span.fb-street', `${STREETS[d.street]} · decision ${d.index + 1}`)), // never "of N": that would tell how the hand goes on
    practice ? h('span.tag.tag-practice', 'Practice · not counted') : null,
    choiceLine(rv));
  return h('div.feedback', { role: 'region', 'aria-label': 'Feedback' }, head, ...decisionBody(rv, puzzle));
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
      h('span.ans-label', o.kind === 'raise' ? `Raise to ${fmtBb(o.amount)}` : shortLabel(o)),
      h('span.ans-pct.num', fmtFreq(d.hand.freq[k])),
      isChart ? null : h('span.ans-ev.num', loss > 0.0049 ? `−${fmtBb(loss)} bb` : 'best'),
      mine || main || theirs ? h('span.ans-tags', mine ? h('span.ans-tag.ans-you', 'you') : null, theirs ? h(`span.ans-tag.ans-opp.oc${theirs.color || 1}`, { title: `${theirs.name}'s pick` }, theirs.name) : null, main ? h('span.ans-tag.ans-main', 'main line') : null) : null,
      !single && here.length ? h('span.ans-opps', { 'aria-hidden': 'true' }, here.map((x) => h(`span.ans-chip.oc${x.color || 1}${x.fresh ? '.opp-fresh' : ''}`, { title: `${x.name}'s pick` }, (x.name || '?').trim().charAt(0).toUpperCase()))) : null,
      mine ? h('span.affirm-icon', { 'aria-hidden': 'true' }, G[1]) : null);
    }));
}

/** Panel for a villain node clicked in the log. */
export function villainPanel(step, puzzle, onClose) {
  const colors = actionColors(step.options);
  return h('div.feedback.villain-panel', { role: 'region', 'aria-label': "Villain's strategy" },
    h('div.fb-head',
      h('div.fb-grade', h('span.fb-street', `${STREETS[step.street]} · ${step.seat} (villain)`),
        h('button.btn.btn-sm', { type: 'button', on: { click: onClose } }, 'Back', h('kbd', 'Esc'))),
      h('p.fb-choice', 'Villain chose ', h('b', step.action.label || shortLabel(step.action)), h('span.muted', ` · ${fmtFreq(step.freq)} of the range does this`))),
    h('div.range-view.villain-view',
      freqBar(step.range.freq, step.options, colors, { marked: step.action.id, title: "Villain's whole range", heading: "Villain's whole range" }),
      rangeGrid({ range: step.range, options: step.options, colors, highlight: puzzle.hero.handClass, caption: "Villain's range by action" })));
}
