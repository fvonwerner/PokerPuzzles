// The table screen: scored play, practice replay and battle hands. When the
// hand is over the same screen becomes the finished view (also opened
// directly from the lobby's "Review"): the right panel lists every decision
// and shows the selected one's detail, the action bar shows its strategy.
//
// Looking back: at any time (not while cards are moving) the player can step
// through every moment of the hand so far: ArrowLeft / ArrowRight, or a click
// on the hand-history strip. A past moment shows the table exactly as it was
// (bets, stacks, pot, board, folds); one of your answered decisions shows its
// analysis, a villain action shows villain's strategy where it is revealed.
// Escape (or ArrowRight past the newest moment, or "Back to now") returns.
// Only what has already been shown can be visited.
import { h, clear, fmtBb, fmtSigned, toast, reducedMotion, delay, gradeBadge, STREETS, GRADE_ICON, GRADE_LABEL } from './ui.js';
import { API } from './api.js';
import { createTable } from './table.js';
import { modelAt, initialModel, applyStep } from './handstate.js';
import { shortLabel, pctOfPot, actionColors, cardText, positionLabel } from './poker.js';
import { feedbackPanel, villainPanel, answerButtons, choiceLine, decisionBody } from './feedback.js';
import { sound } from './sound.js';
import { setLinkedText, tagChips } from './learn.js';

// Pause after each step's motion (the motion itself runs ~250-500 ms).
function pauseAfter(s) {
  if (s.type === 'action') return s.kind === 'fold' && s.street === 'preflop' ? 70 : 160;
  if (s.type === 'villain') return 170;
  if (s.type === 'deal') return 140;
  if (s.type === 'decision') return 150;
  return 0;
}

export function playScreen(root, { id, mode, nav, battle = null }) {
  // mode: 'scored' | 'practice' | 'battle'. In a battle, `battle` (battle.js)
  // supplies the API calls, the battle bar in place of the title row, the
  // opponents' picks on the feedback, the clocks and waiting states in the
  // action bar, and the duel panel at the end of the hand; it moves the hand
  // on (advance()) when the server's shared cursor moves.
  const callStart = () => (battle ? battle.start() : API.start(id, mode));
  const callAct = (index, optionId) => (battle ? battle.act(index, optionId) : API.act(id, index, optionId, mode === 'practice' ? 'practice' : 'scored'));
  const st = {
    puzzle: null, steps: [], reveals: {}, shown: 0, phase: 'loading', end: null,
    pending: null, skip: false, sheetCollapsed: false,
    sel: null, moreOpen: false, decisionPos: 0,
    view: null,        // looking back: the moment (step index, -1 = blinds) shown, or null for now
    nowModel: null,    // the table as it is now (to come back to)
    savedSide: null,   // the side panel of now, while looking back
  };
  let destroyed = false;

  const top = h('div.play-top');
  const tableHost = h('div.table-host');
  const bar = h('div.actionbar', { role: 'group', 'aria-label': 'Your options', tabindex: '-1' });
  const log = h('div.log', { 'aria-label': 'Hand history: pick a moment to see the table as it was' });
  const side = h('aside.side', { 'aria-label': 'Hand panel' });
  const main = h('div.play-main', tableHost, bar, log);
  const screen = h('section.play', top, h('div.play-grid', main, side));
  clear(root).append(screen);
  const table = createTable(tableHost);
  const pastBadge = h('div.past-badge', { role: 'status', hidden: true });
  tableHost.append(pastBadge);
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => screen.style.setProperty('--bar-h', `${bar.offsetHeight}px`)) : null;
  ro?.observe(bar);

  // ---------- rendering ----------
  const opts = () => ({ reveals: st.reveals });
  function model(n = st.shown) { return modelAt(st.puzzle, st.steps, n, opts()); }
  const sortedReveals = () => Object.values(st.reveals).sort((a, b) => a.index - b.index);
  /** Draw the table as it is now and remember it. */
  function drawNow(m) { st.nowModel = m; table.render(m); }

  function renderTop() {
    const p = st.puzzle;
    if (battle) { battle.renderTop(top, viewApi()); return; }
    document.title = `#${p.number} ${p.title} · PokerPuzzles`;
    const ended = st.phase === 'end';
    // One circle per answered decision, appearing as it is answered: never placeholders for the
    // decisions to come (their number would tell how the hand goes on).
    const decisions = sortedReveals().map((rv) => {
      const i = rv.index;
      const on = ended && st.sel === i;
      const label = `Decision ${i + 1}: ${GRADE_LABEL[rv.grade]}`;
      const dot = h(`span.dot.g-${rv.grade}${on ? '.current' : ''}`, { title: label, 'aria-label': label }, GRADE_ICON[rv.grade]);
      if (ended) return h('button.dot-btn', { type: 'button', on: { click: () => select(i, true) }, 'aria-label': `Show ${label}` }, dot);
      return dot;
    });
    clear(top).append(
      h('a.back', { href: '#/lobby' }, '← All puzzles'),
      h('div.play-title',
        h('h1', h('span.num.muted', `#${p.number} `), p.title),
        h('p.muted.small', `${p.scenario.name} · You are ${p.hero.seat}, ${positionLabel(p.hero.position)}`)),
      h('div.play-badges',
        mode === 'practice' ? h('span.tag.tag-practice', 'Practice · not counted') : null,
        h('div.dots', { role: 'list', 'aria-label': 'Decisions' }, decisions.map((d) => h('span', { role: 'listitem' }, d)))));
  }

  /** The hand-history strip (always the present hand so far; the moment looked at is marked). */
  function renderLog(m) {
    const list = momentList();
    const can = (i) => !!list && list.includes(i);
    const groups = [];
    let cur = null;
    for (const e of m.log) {
      if (e.deal || !cur) {
        cur = { street: e.street || 'preflop', cards: e.deal ? e.cards : null, i: e.deal ? e.i : -1, items: [] };
        groups.push(cur);
        if (e.deal) continue;
      }
      cur.items.push(e);
    }
    if (!groups.length) groups.push({ street: 'preflop', cards: null, i: -1, items: [] });
    const momentBtn = (i, cls, content, title) => (can(i)
      ? h(`button.${cls}.log-click${st.view === i ? '.at' : ''}`, { type: 'button', title, dataset: { moment: String(i) }, on: { click: () => goMoment(i) } }, content)
      : h(`span.${cls}`, content));
    clear(log).append(h('h2.sr-only', 'Hand history'), ...groups.map((g) => h('div.log-street',
      momentBtn(g.i, 'log-st', [STREETS[g.street], g.cards ? h('span.log-cards', g.cards.map(cardText)) : null], g.i < 0 ? 'The table with the blinds posted' : `The table when the ${g.street} was dealt`),
      g.items.map((e) => {
        const txt = [h('span.log-seat', e.hero ? `${e.seat} (you)` : e.seat), ' ', h(`span.log-act.k-${e.kind}`, e.text)];
        if (e.chose) txt.push(h('span.log-note', ` · you chose ${e.chose}`));
        if (e.grade) txt.push(' ', h(`span.log-grade.g-${e.grade}`, { title: GRADE_LABEL[e.grade] }, GRADE_ICON[e.grade]));
        if (e.villain && e.revealed) txt.push(h('span.log-eye', { 'aria-hidden': 'true', title: "Villain's strategy is shown here" }, '◔'));
        const title = e.decisionIndex !== undefined ? 'The table when you decided, with the analysis' : e.villain && e.revealed ? "The table after this action, with villain's strategy" : 'The table after this action';
        return momentBtn(e.i, `log-item${e.forced ? '.log-forced' : ''}`, txt, title);
      }))));
    // keep the moment looked at (or the newest) in view, scrolling the strip only (never the page)
    const at = log.querySelector('.at');
    if (at) {
      const lr = log.getBoundingClientRect(), r = at.getBoundingClientRect();
      if (r.top < lr.top) log.scrollTop += r.top - lr.top - 4; else if (r.bottom > lr.bottom) log.scrollTop += r.bottom - lr.bottom + 4;
      if (r.left < lr.left) log.scrollLeft += r.left - lr.left - 8; else if (r.right > lr.right) log.scrollLeft += r.right - lr.right + 8;
    } else { log.scrollTop = log.scrollHeight; log.scrollLeft = log.scrollWidth; }
  }

  function setSide(content) {
    clear(side);
    side.classList.toggle('has-content', !!content);
    side.classList.toggle('sheet', !!content);
    side.classList.toggle('collapsed', st.sheetCollapsed && !!content);
    if (!content) return;
    side.append(h('button.sheet-handle', {
      type: 'button', 'aria-expanded': String(!st.sheetCollapsed),
      on: { click: () => { st.sheetCollapsed = !st.sheetCollapsed; side.classList.toggle('collapsed', st.sheetCollapsed); side.querySelector('.sheet-handle').setAttribute('aria-expanded', String(!st.sheetCollapsed)); } },
    }, h('span.handle-bar', { 'aria-hidden': 'true' }), h('span.sr-only', 'Show or hide the panel')));
    side.append(content);
  }
  function restoreSide(nodes) {
    clear(side).append(...nodes);
    const has = nodes.length > 0;
    side.classList.toggle('has-content', has);
    side.classList.toggle('sheet', has);
  }

  // ---------- action bar ----------
  // The bar always has the same three slots and one fixed height (CSS), so
  // the table above it never moves: a line (prompt / note / result / clock),
  // the buttons, and the Continue row. Empty slots keep their space.
  function renderBar(m) {
    const topSlot = h('div.bar-slot.bar-top'), mid = h('div.bar-slot.bar-main'), bottom = h('div.bar-slot.bar-bottom');
    const wasPhase = bar.dataset.phase;
    bar.dataset.phase = st.phase;
    if (st.phase === 'animating') {
      topSlot.append(h('button.btn.btn-ghost.btn-sm.skip', { type: 'button', on: { click: skip } }, 'Skip animation', h('kbd', 'Space')));
    } else if (st.phase === 'deciding' && m?.decision) {
      const d = m.decision;
      const colors = actionColors(d.options);
      const toCall = d.toCall > 0 ? ` · ${fmtBb(d.toCall)} to call` : '';
      topSlot.append(h('p.bar-prompt', h('b', `${STREETS[d.street]}: your move`), h('span.muted', ` · pot ${fmtBb(d.state.pot)}${toCall}`)));
      // Redrawn for the same decision (a battle poll): keep the very same buttons (focus, hover, no re-animation).
      const keep = bar.querySelector(`.bar-main[data-dec="${d.index}"] > .bar-buttons:not(.answers)`);
      mid.dataset.dec = String(d.index);
      if (keep && wasPhase === 'deciding') mid.append(keep);
      else mid.append(h('div.bar-buttons.bar-in', d.options.map((o, k) => {
        const pct = d.source === 'chart' ? null : pctOfPot(o, d.state); // no % of pot preflop
        return h(`button.opt.k-${o.kind}`, {
          type: 'button', style: { '--opt': colors[k] }, dataset: { opt: o.id },
          'aria-keyshortcuts': String(k + 1),
          on: { click: (e) => choose(o.id, e.currentTarget) },
        },
        h('span.opt-key', { 'aria-hidden': 'true' }, k + 1),
        h('span.opt-main', o.kind === 'raise' ? `Raise to ${fmtBb(o.amount)}` : shortLabel(o)),
        h('span.opt-sub', o.kind === 'fold' || o.kind === 'check' ? ' ' : `${fmtBb(o.amount)} bb${pct !== null ? ` · ${pct}% pot` : ''}`));
      })));
    } else if (st.phase === 'feedback' && st.pending) {
      // The buttons stay and show the answer; the big Continue sits right under them.
      const rv = st.pending.reveal;
      const last = st.pending.next === null;
      if (rv.continuesWith) topSlot.append(h('p.continues-note', rv.continuesWith));
      mid.append(answerButtons(rv, { affirm: st.affirmNow, opp: battle?.oppPick(rv.index) }));
      bottom.append(h('button.btn.btn-primary.big-continue.bar-in', { type: 'button', on: { click: cont } }, last ? 'Finish hand' : 'Continue', h('kbd', 'Enter')));
    } else if (st.phase === 'end') {
      const rv = st.reveals[st.sel];
      const btn = h('button.btn.btn-primary.big-continue', { type: 'button', disabled: true }, 'Next puzzle', h('kbd', 'Enter'));
      if (!battle) {
        nextTarget().then((next) => {
          if (destroyed || !btn.isConnected) return;
          btn.disabled = false;
          if (next) btn.onclick = () => { location.hash = `#/play/${next}`; };
          else { btn.firstChild.textContent = 'All puzzles'; btn.onclick = () => { location.hash = '#/lobby'; }; }
        });
      }
      topSlot.append(h('p.bar-prompt', h('b', 'Hand over. '), h('span.muted', endLine(st.steps.at(-1)))));
      if (rv) mid.append(answerButtons(rv, { opp: battle?.oppPick(rv.index) }));
      bottom.append(h('div.end-bar',
        st.view !== null ? h('button.btn.btn-ghost.final-btn', { type: 'button', on: { click: goPresent } }, 'Final board') : '',
        btn));
    }
    // In a battle the clocks, the waiting states and the shared Continue / Next hand live here.
    battle?.decorateBar({ top: topSlot, mid, bottom }, st.phase, { onContinue: cont, decision: m?.decision || null, pending: st.pending });
    bar.classList.toggle('past', st.view !== null);
    clear(bar).append(topSlot, mid, bottom);
  }

  // The puzzle to go to next (server nextId), fetched once per finished hand.
  let nextPromise = null;
  function nextTarget() {
    if (!nextPromise) nextPromise = nav.nextId().catch(() => null);
    return nextPromise;
  }

  function skip() {
    st.skip = true;
    table.finishAll();
    sound.stopAll();
  }

  // How the hand ended along the solver's main line (not necessarily the player's choices).
  function endLine(end) {
    if (!end || end.type !== 'end') return '';
    const net = Math.abs(end.heroNet);
    const result = end.heroNet > 0 ? `you win ${fmtBb(net)} bb` : end.heroNet < 0 ? `you lose ${fmtBb(net)} bb` : 'you break even';
    let how;
    if (end.reason === 'hero_fold') how = `you fold and ${result.replace('you ', '')}`;
    else if (end.reason === 'villain_fold') how = `villain folds and ${result}`;
    else {
      const w = end.showdown?.winner;
      how = w === 'split' ? `the pot is split at showdown (${fmtSigned(end.heroNet)} bb)` : `${result} at showdown`;
    }
    return `The hand as the solver played it: ${how}.`;
  }

  // ---------- flow ----------
  async function animateTo(target, { keepSkip = false } = {}) {
    if (st.view !== null) goPresent({ quiet: true });
    st.phase = 'animating';
    if (!keepSkip) st.skip = false;
    renderBar(null);
    let m = model(st.shown);
    for (let i = st.shown; i < target; i++) {
      const prev = table.snapshot(m);
      applyStep(m, st.steps[i], i, opts());
      st.shown = i + 1;
      if (destroyed) return;
      if (st.skip) continue;
      renderLog(m);
      await table.transition(prev, m, st.steps[i]);
      if (!st.skip && !destroyed) await delay(reducedMotion() ? 60 : pauseAfter(st.steps[i]));
      if (destroyed) return;
    }
    if (st.skip) { table.finishAll(); sound.stopAll(); }
    m = model(st.shown);
    drawNow(m);
    settle(m, { animated: !st.skip });
    renderLog(m);
  }

  function settle(m, { animated = false } = {}) {
    if (m.decision) {
      st.phase = 'deciding';
      st.decisionPos = st.shown - 1;
      renderBar(m);
      setSide(null);
      renderTop();
      // Focus the bar itself, not an option: a stray Space/Enter must never commit an action.
      if (document.activeElement && document.activeElement !== document.body && !bar.contains(document.activeElement)) document.activeElement.blur();
      bar.focus({ preventScroll: true });
      battle?.onDeciding(m.decision.index);
    } else if (m.end) {
      showEnd({ animated });
      if (battle) battle.onHandEnd({ animated });
      else if (animated) {
        const rs = sortedReveals();
        const avg = rs.length ? rs.reduce((a, r) => a + r.points, 0) / rs.length : 0;
        sound.flourish(avg >= 70);
      }
      bar.querySelector('.big-continue')?.focus({ preventScroll: true });
    }
  }

  /** Answer the open decision (optionId null: report a battle time-out). */
  async function choose(optionId, btn) {
    if (st.phase !== 'deciding') return;
    if (st.view !== null && optionId !== null) return; // looking back: the buttons are inactive
    if (st.view !== null) goPresent({ quiet: true });
    const m = st.nowModel || model();
    const d = m.decision;
    st.phase = 'submitting';
    btn = btn || (optionId ? bar.querySelector(`.opt[data-opt="${optionId}"]`) : null);
    bar.classList.add('busy');
    bar.querySelectorAll('.opt').forEach((b) => { b.disabled = true; });
    btn?.classList.add('pressed');
    try {
      const res = await callAct(d.index, optionId);
      if (destroyed) return;
      showFeedback(res, m);
      if (res.alreadyAnswered) {
        toast(res.timedOut ? (optionId ? 'Too late: the clock had run out.' : "Time's up.")
          : battle ? 'That decision was already answered; showing the recorded choice.' : 'That decision was already answered on your first play; showing the recorded choice.');
      }
    } catch (e) {
      st.phase = 'deciding';
      bar.classList.remove('busy');
      renderBar(m);
      toast(e.message, 'error');
      if (e.status === 409) setTimeout(() => { if (!destroyed) nav.reload(); }, 1800);
    }
  }

  function showFeedback(res, m) {
    st.reveals[res.reveal.index] = res.reveal;
    st.pending = res;
    st.steps = res.steps;
    st.end = res.end;
    st.sheetCollapsed = false;
    renderTop();
    const fb = feedbackPanel(res.reveal, { puzzle: st.puzzle, practice: mode === 'practice' });
    battle?.decorateFeedback(fb, res.reveal);
    setSide(fb);
    if (battle && res.reveal.timeout) battle.onTimeUp?.();
    else sound.grade(res.reveal.grade);
    st.phase = 'feedback';
    st.affirmNow = true;
    bar.classList.remove('busy');
    renderBar(m);
    st.affirmNow = false;
    renderLog(model(st.decisionPos)); // revealed villain steps become visitable
    bar.querySelector('.big-continue')?.focus({ preventScroll: true });
  }

  function cont() {
    if (st.phase !== 'feedback') return;
    if (battle) { battle.onContinue(); return; } // in a battle the hand moves on for everybody together
    st.pending = null;
    setSide(null);
    st.shown = st.decisionPos;
    animateTo(st.steps.length);
  }

  /** Battle: the shared cursor moved on; fetch the hand as it is now and play it forward. */
  async function advance() {
    if (st.phase !== 'feedback' && st.phase !== 'deciding') return false;
    const r = await callStart();
    if (destroyed) return true;
    st.steps = r.steps; st.end = r.end;
    for (const a of r.answers || []) st.reveals[a.index] = a;
    st.pending = null;
    if (st.view !== null) goPresent({ quiet: true });
    setSide(null);
    st.shown = Math.min(st.decisionPos, st.steps.length);
    animateTo(st.steps.length);
    return true;
  }

  /** Battle: the clock ran out (locally, or the server says so); get the time-out and its analysis. */
  function timeoutNow() {
    if (st.phase !== 'deciding') return;
    choose(null);
  }

  // ---------- finished hand ----------
  function showEnd({ animated = false } = {}) {
    st.phase = 'end';
    st.endAnimated = animated;
    const rs = sortedReveals();
    // Default: the decision with the fewest points (ties: the earliest).
    st.sel = rs.length ? rs.reduce((a, r) => (r.points < a.points ? r : a), rs[0]).index : null;
    st.view = null;
    renderTop();
    renderEndPanel();
    renderBar(st.nowModel || model());
  }

  /** Select a decision in the finished view; `rewind` moves the table to it. */
  function select(i, rewind) {
    if (!st.reveals[i]) return;
    st.sel = i;
    if (rewind) {
      const pos = st.steps.findIndex((s) => s.type === 'decision' && s.index === i);
      if (pos >= 0) { goMoment(pos); return; }
    }
    renderTop();
    renderEndPanel();
    renderBar(null);
  }

  function renderEndPanel() {
    if (battle) {
      const keep = side.querySelector('.endpanel')?.scrollTop || 0;
      setSide(battle.endPanel(viewApi()));
      const ep = side.querySelector('.endpanel');
      if (ep && keep) ep.scrollTop = keep;
      return;
    }
    const end = st.end;
    const step = st.steps.at(-1);
    const rs = sortedReveals();
    const stored = mode === 'scored' && end?.recap ? Object.fromEntries(end.recap.map((r) => [r.index, r])) : {};
    const score = mode === 'practice'
      ? (rs.length ? Math.round(rs.reduce((a, r) => a + r.points, 0) / rs.length) : 0)
      : end?.score;
    const sd = step.showdown;
    const tags = end?.tags || st.puzzle.tags || [];
    const others = end?.others || [];
    const rv = st.reveals[st.sel];

    const more = h('details.end-more', { open: st.moreOpen, on: { toggle: (e) => { st.moreOpen = e.currentTarget.open; } } },
      h('summary', h('span.end-more-text', end?.takeaway ? ['Takeaway: ', end.takeaway] : 'Takeaway and friends'),
        h('span.end-more-friends', others.length ? `${others.length} friend${others.length > 1 ? 's' : ''} played` : 'no friends yet')),
      end?.takeaway ? setLinkedText(h('p.end-takeaway'), end.takeaway) : null,
      tags.length ? tagChips(h('p.end-tags'), tags) : null,
      others.length
        ? h('ol.others-list', others.map((o) => h('li', h('span', o.name), h('b.num', o.score))))
        : h('p.muted.small', 'Nobody else has finished this one yet.'),
      h('p.end-links', mode === 'scored' ? h('a', { href: `#/practice/${id}` }, 'Replay in practice mode') : null, h('a', { href: '#/lobby' }, 'All puzzles')));

    // The decisions as a row of chips (street, grade, points): compact, so the
    // selected decision's ranges get the room.
    const chips = rs.map((r) => {
      const pts = stored[r.index]?.points ?? r.points;
      const grade = stored[r.index]?.grade ?? r.grade;
      const on = r.index === st.sel;
      return h(`button.recap-chip.g-${grade}${on ? '.on' : ''}`, {
        type: 'button', role: 'tab', 'aria-selected': String(on), tabindex: on ? '0' : '-1',
        'aria-label': `${STREETS[r.decision.street]}: ${r.choiceLabel}, ${GRADE_LABEL[grade]}, ${Math.round(pts)} points`,
        on: { click: () => select(r.index, true) },
      },
      h('span.rc-street', STREETS[r.decision.street]),
      h('span.rc-grade', { 'aria-hidden': 'true' }, GRADE_ICON[grade]),
      h('span.rc-pts.num', Math.round(pts)));
    });

    setSide(h('div.endpanel', { role: 'region', 'aria-label': 'End of hand' },
      h('div.end-head',
        end?.partial && mode !== 'practice'
          ? h('div.end-score-box.end-unscored', h('p.end-kicker', 'Not finished'), h('p.end-unscored-text', 'This hand was not played to the end, so it is not scored.'))
          : h('div.end-score-box',
            h('p.end-kicker', mode === 'practice' ? 'Practice · not counted' : 'Puzzle score'),
            h('p.end-score', h('span.num', score), h('span.end-of', '/100'))),
        h('div.end-head-text',
          h('p.end-result', endLine(step)),
          sd ? h('p.end-showdown',
            h('span', h('span.muted', 'You '), st.puzzle.hero.hand.map(cardText), sd.heroHandName ? ` ${sd.heroHandName}` : ''),
            h('span', h('span.muted', 'Villain '), sd.villainHand.map(cardText), sd.villainHandName ? ` ${sd.villainHandName}` : '')) : null)),
      more,
      h('div.recap-chips', { role: 'tablist', 'aria-label': 'Your decisions' }, chips),
      rv ? h('div.end-detail',
        h('div.end-detail-head', gradeBadge(rv.grade, { small: true }), h('span.num.end-detail-pts', `${Math.round(rv.points)} pts`), choiceLine(rv)),
        ...decisionBody(rv, st.puzzle)) : null));
  }

  // ---------- looking back ----------
  /** The moments that can be visited now (-1 = blinds posted, then step indexes), or null. */
  function momentList() {
    if (!st.puzzle || !['deciding', 'feedback', 'end'].includes(st.phase)) return null;
    const limit = st.phase === 'end' ? st.steps.length - 1 : st.decisionPos; // the present itself is not a moment
    const out = [-1];
    for (let i = 0; i < limit; i++) if (st.steps[i] && st.steps[i].type !== 'end') out.push(i);
    return out;
  }
  /** The table at a moment: after the step, or for one of your decisions as it was when you decided. */
  function momentModel(i) {
    if (i < 0) return modelAt(st.puzzle, st.steps, 0, opts());
    const s = st.steps[i];
    if (s.type === 'decision') {
      const m = modelAt(st.puzzle, st.steps, i, opts());
      const hs = m.seats[m.heroSeat], vs = m.seats[m.villainSeat];
      m.pot = s.state.pot; hs.stack = s.state.heroStack; hs.bet = s.state.heroBet; vs.stack = s.state.villainStack; vs.bet = s.state.villainBet;
      m.acting = m.heroSeat;
      return m;
    }
    return modelAt(st.puzzle, st.steps, i + 1, opts());
  }
  function momentLabel(i) {
    if (i < 0) return 'Preflop · blinds posted';
    const s = st.steps[i];
    if (s.type === 'deal') return `${STREETS[s.street]} dealt`;
    if (s.type === 'decision') return `${STREETS[s.street]} · your decision ${s.index + 1}`;
    if (s.type === 'villain') return `${STREETS[s.street]} · ${s.seat} ${shortLabel(s.action)}`;
    if (s.type === 'action') return `${STREETS[s.street]} · ${s.seat} ${s.kind}${s.amount ? ` ${fmtBb(s.amount)}` : ''}`;
    return 'Earlier moment';
  }
  function presentLogModel() {
    if (st.phase === 'feedback') return model(st.decisionPos);
    if (st.phase === 'end') return model(st.steps.length);
    return model();
  }

  function goMoment(i) {
    const list = momentList();
    if (!list || !list.includes(i)) return;
    if (st.view === null && st.phase !== 'end') st.savedSide = Array.from(side.childNodes);
    st.view = i;
    table.finishAll();
    table.render(momentModel(i));
    const s = i >= 0 ? st.steps[i] : null;
    const rv = s?.type === 'decision' ? st.reveals[s.index] : null;
    if (rv) {
      if (st.phase === 'end') { st.sel = s.index; renderEndPanel(); }
      else {
        const fb = feedbackPanel(rv, { puzzle: st.puzzle, practice: mode === 'practice' });
        battle?.decorateFeedback(fb, rv);
        setSide(fb);
      }
    } else if (s?.type === 'villain' && 'range' in s) {
      setSide(villainPanel(s, st.puzzle, () => goPresent()));
    } else if (st.phase === 'end') {
      if (!side.querySelector('.endpanel')) renderEndPanel();
    } else if (st.savedSide) restoreSide(st.savedSide);
    pastBadge.hidden = false;
    clear(pastBadge).append(
      h('span.past-k', 'Earlier moment'), h('span.past-what', momentLabel(i)),
      h('button.btn.btn-sm.past-back', { type: 'button', on: { click: () => goPresent() } }, 'Back to now', h('kbd', 'Esc')));
    renderTop();
    renderBar(st.phase === 'deciding' ? st.nowModel : null);
    renderLog(presentLogModel());
  }

  function goPresent({ quiet = false } = {}) {
    if (st.view === null) return;
    st.view = null;
    pastBadge.hidden = true;
    if (quiet) return; // the caller redraws
    table.finishAll();
    if (st.nowModel) table.render(st.nowModel);
    if (st.phase === 'end') renderEndPanel();
    else if (st.savedSide) {
      restoreSide(st.savedSide);
      // In a battle the opponents may have answered meanwhile.
      if (battle && st.phase === 'feedback' && st.pending) {
        const fb = side.querySelector('.feedback:not(.villain-panel)');
        if (fb) battle.decorateFeedback(fb, st.pending.reveal);
      }
    } else setSide(null);
    st.savedSide = null;
    renderTop();
    renderBar(st.phase === 'deciding' ? st.nowModel : null);
    renderLog(presentLogModel());
    if (st.phase === 'deciding') bar.focus({ preventScroll: true });
  }

  function step(dir) {
    const list = momentList();
    if (!list) return false;
    if (st.view === null) {
      if (dir > 0) return false;
      goMoment(list[list.length - 1]);
      return true;
    }
    const k = list.indexOf(st.view) + dir;
    if (k >= list.length) { goPresent(); return true; }
    if (k < 0) return true;
    goMoment(list[k]);
    return true;
  }

  // ---------- keyboard ----------
  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.lover, .term-pop, .vs-intro')) return; // Learn overlay, term pop-up or a battle intro open
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const onButton = tag === 'button' || tag === 'a' || tag === 'summary';
    if (st.phase === 'animating' && (e.key === ' ' || e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); skip(); return; }
    const inGrid = e.target.closest?.('.grid,.tablist:not(.recap)');
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !inGrid) {
      if (step(e.key === 'ArrowLeft' ? -1 : 1)) {
        e.preventDefault();
        if (st.phase === 'end') side.querySelector('.recap-chip[aria-selected="true"], .duel-row[aria-selected="true"]')?.blur();
      }
      return;
    }
    if (st.view !== null) {
      // Looking back: nothing commits; Escape, Enter or Space return to now.
      if (e.key === 'Escape' || ((e.key === 'Enter' || e.key === ' ') && !onButton)) { e.preventDefault(); goPresent(); }
      else if (/^[1-9]$/.test(e.key)) e.preventDefault();
      return;
    }
    if (st.phase === 'deciding' && /^[1-9]$/.test(e.key)) {
      const btn = bar.querySelectorAll('button.opt')[Number(e.key) - 1];
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    if (st.phase === 'feedback' && (e.key === 'Enter' || e.key === ' ') && !onButton) {
      e.preventDefault();
      const b = bar.querySelector('.bar-bottom button.big-continue:not([disabled])');
      if (b) b.click(); else if (!battle) cont();
      return;
    }
    if (st.phase === 'end' && e.key === 'Enter' && !onButton) { e.preventDefault(); bar.querySelector('.bar-bottom button.big-continue:not([disabled])')?.click(); }
  }
  document.addEventListener('keydown', onKey);

  // ---------- load ----------
  (async () => {
    try {
      const r = await callStart();
      if (destroyed) return;
      st.puzzle = r.puzzle; st.steps = r.steps; st.end = r.end;
      for (const a of r.answers || []) st.reveals[a.index] = a;
      renderTop();
      setSide(null);
      if (r.completed) {
        // A finished hand (or the lobby's "Review"): draw the final state at once.
        st.shown = st.steps.length;
        const m = model();
        drawNow(m); renderLog(m);
        settle(m);
        renderLog(m);
        return;
      }
      if (r.restarted) toast('This puzzle was updated since you started it, so it starts again from the first decision.');
      const lastStep = st.steps.at(-1);
      if (battle && lastStep?.type === 'decision' && st.reveals[lastStep.index]) {
        // Battle, back in the middle: you have answered the open decision already; its feedback again.
        st.decisionPos = st.steps.length - 1;
        st.shown = st.decisionPos + 1;
        const m = momentModel(st.decisionPos);
        drawNow(m);
        showFeedback({ reveal: st.reveals[lastStep.index], steps: st.steps, next: r.next, end: null }, m);
        renderLog(model(st.decisionPos));
        return;
      }
      if (Object.keys(st.reveals).length || battle?.rejoining?.()) {
        // Resume (or rejoining a battle decision that has been open a while): draw the current position immediately.
        st.shown = st.steps.length;
        const m = model();
        drawNow(m);
        if (!battle) toast('Resumed where you left off.');
        settle(m);
        renderLog(m);
      } else {
        st.phase = 'animating';
        st.skip = false;
        renderBar(null);
        await table.dealIn(initialModel(st.puzzle));
        if (destroyed) return;
        animateTo(st.steps.length, { keepSkip: true });
      }
    } catch (e) {
      if (destroyed) return;
      if (battle?.onLoadError?.(e)) return;
      clear(main).append(h('div.error-box', h('p', e.message),
        battle ? h('a.btn', { href: '#/battle' }, 'Battles')
          : e.data?.battle ? h('a.btn.btn-primary', { href: `#/battle/${e.data.battle}` }, 'Go to the battle') : h('a.btn', { href: '#/lobby' }, 'All puzzles')));
    }
  })();

  // ---------- battle hooks ----------
  /** What the battle module may read and do on this screen. */
  function viewApi() {
    return {
      puzzle: st.puzzle, steps: st.steps, end: st.end, reveals: st.reveals, sel: st.sel, phase: st.phase,
      animated: !!st.endAnimated, endLine: () => endLine(st.steps.at(-1)), looking: st.view !== null,
      select: (i) => select(i, true),
    };
  }
  /** New battle state arrived (poll): redraw what shows the opponents, without disturbing the player. */
  function refreshBattle({ changed = false } = {}) {
    if (destroyed || !st.puzzle) return;
    renderTop();
    // The action bar only when something it shows changed (clocks tick by themselves).
    const sig = battle.barSig?.() ?? null;
    if (['deciding', 'feedback', 'end'].includes(st.phase) && (changed || sig !== st.barSig)) { st.barSig = sig; renderBar(st.phase === 'deciding' ? st.nowModel : null); }
    if (!changed) return; // nothing about the opponents' picks on this hand changed
    if (st.phase === 'feedback' && st.pending && st.view === null) {
      const fb = side.querySelector('.feedback:not(.villain-panel)');
      if (fb) battle.decorateFeedback(fb, st.pending.reveal);
    } else if (st.phase === 'end') {
      const s = st.view !== null && st.view >= 0 ? st.steps[st.view] : null;
      if (!(s?.type === 'villain' && 'range' in s)) renderEndPanel();
    }
  }

  return {
    destroy() { destroyed = true; ro?.disconnect(); table.finishAll(); sound.stopAll(); document.removeEventListener('keydown', onKey); },
    refreshBattle, advance, timeoutNow,
    get phase() { return st.phase; },
    /** The decision on screen: open (deciding) or answered (feedback). */
    get decisionIndex() { return st.phase === 'deciding' || st.phase === 'feedback' ? st.steps[st.decisionPos]?.index ?? null : null; },
    get puzzleReady() { return !!st.puzzle; },
  };
}
