// The tournament question screen, shared by the drill, the quiz and the quiz
// review: the table (every stack, who folded, who is all-in, blinds, antes and
// the pot), the question, two big buttons (Fold and All-in, or Fold and Call),
// then the feedback panel (verdict and cost, both EVs, the solver's frequency,
// the facts, the charts, "Copy for Claude") and one button to go on. Before an
// answer the screen holds nothing the solver says: the side panel shows only
// the table's own facts. It uses the play screen's layout (body[data-screen=
// "play"]): it never scrolls the page, nothing covers the table, and on phones
// the panel sits under the table.
import { h, clear, toast, gradeBadge, copyText, trapFocus } from './ui.js';
import { API, session as apiSession } from './api.js';
import { createTable } from './table.js';
import { closeChartOverlay } from './grid.js';
import { copyButton } from './feedback.js';
import { sound } from './sound.js';
import * as PFR from './pushfold.js';
import { decisionChart, jamChart, pfColors, situationName, numbersBlock } from './tcharts.js';

// ---------- a dialog (focus kept inside, Escape and a click outside close it) ----------
export function openDialog({ title, content, onClose = null, cls = '', closeLabel = 'Close' }) {
  const prev = document.activeElement;
  const closeBtn = h('button.btn.btn-sm', { type: 'button' }, closeLabel, h('kbd', 'Esc'));
  const panel = h(`div.tdlg-panel${cls}`, { role: 'document' },
    h('div.tdlg-head', h('h2.tdlg-title', title), closeBtn),
    h('div.tdlg-body', content));
  const box = h('div.tdlg', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, panel);
  let downOutside = false;
  box.addEventListener('pointerdown', (e) => { downOutside = e.target === box; });
  box.addEventListener('click', (e) => { if (e.target === box && downOutside) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  let untrap = () => {}, closed = false;
  function close() {
    if (closed) return;
    closed = true;
    untrap();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
    box.remove();
    if (prev?.isConnected) prev.focus({ preventScroll: true });
    onClose?.();
  }
  closeBtn.addEventListener('click', close);
  document.body.append(box);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
  untrap = trapFocus(box);
  closeBtn.focus({ preventScroll: true });
  return { close, el: box };
}

// ---------- the table ----------
/** The table model (web/js/table.js) of a question; `action` after it is answered (your pick is shown on your seat). */
export function tableModel(q, action = null) {
  const sp = q.spot, d = q.decision;
  const s = PFR.situation(sp, d);
  const seats = {};
  for (const x of s.seats) {
    seats[x.seat] = {
      seat: x.seat, stack: x.behind, bet: x.bet, folded: x.status === 'folded',
      last: x.status === 'folded' ? 'Fold' : x.status === 'allin' ? 'All-in' : null,
      lastKind: x.status === 'folded' ? 'fold' : x.status === 'allin' ? 'allin' : null,
      backs: x.status === 'allin' || x.status === 'waiting', allin: x.status === 'allin',
    };
  }
  if (action) {
    const hs = seats[s.hero.seat];
    hs.last = action === 'fold' ? 'Fold' : d.facing.length ? 'Call' : 'All-in';
    hs.lastKind = action === 'fold' ? 'fold' : d.facing.length ? 'call' : 'allin';
  }
  return {
    puzzle: { hero: { hand: q.hand.cards } }, seats, pot: s.pot, board: [], noBoard: true,
    note: PFR.placesText(sp), dealer: sp.n === 2 ? 'SB' : 'BTN',
    heroSeat: s.hero.seat, villainSeat: s.jammers[0]?.seat || null,
    acting: s.hero.seat, decision: action ? null : d, end: null,
  };
}

const valueWords = (sp) => (sp.units === 'points' ? 'league points' : 'chip EV');
/** "6 players · chip EV · 10 bb" / "4 players · league points · CO 25 · BTN 9 · SB 6 · BB 10". */
export function spotLine(sp) {
  const even = sp.stacks.every((x) => x === sp.stacks[0]);
  return `${sp.n === 2 ? 'Heads-up' : `${sp.n} players`} · ${valueWords(sp)} · ${sp.units === 'points' || !even ? situationName(sp) : `${PFR.fmtChips(sp.stacks[0])} bb each`}`;
}

/** The side panel before an answer: only what the table says (stacks, forced bets, places). */
function spotCard(q, extra = null) {
  const sp = q.spot;
  const s = PFR.situation(sp, q.decision);
  return h('div.tspot', { role: 'region', 'aria-label': 'The spot' },
    h('p.tspot-k', 'The spot'),
    h('p.tspot-line', spotLine(sp)),
    h('ul.tspot-stacks', s.seats.map((x) => h(`li${x.status === 'hero' ? '.me' : ''}`,
      h('span.tspot-seat', x.seat), h('b.num', `${PFR.fmtChips(x.stack)} bb`),
      h('span.tspot-st', x.status === 'hero' ? 'you' : x.status === 'allin' ? 'all-in' : x.status === 'folded' ? 'folded' : 'to act')))),
    h('p.tspot-line', `Blinds ${PFR.fmtChips(sp.blinds.sb)} / ${PFR.fmtChips(sp.blinds.bb)} bb · ante ${PFR.fmtChips(sp.ante.amount)} bb from every player · stacks before posting`),
    sp.units === 'points' ? h('p.tspot-line', `${PFR.placesText(sp)}${sp.note ? ` · ${sp.note}` : ''}`) : null,
    extra);
}

// ---------- the feedback panel ----------
function tabs(defs) {
  const id = `tt${Math.random().toString(36).slice(2, 8)}`;
  const buttons = [], panels = [];
  const select = (n, focus) => {
    buttons.forEach((b, k) => { b.setAttribute('aria-selected', String(k === n)); b.tabIndex = k === n ? 0 : -1; });
    panels.forEach((p, k) => {
      p.hidden = k !== n;
      if (k === n && !p.dataset.done) { p.dataset.done = '1'; p.append(defs[k].render()); }
    });
    if (focus) buttons[n].focus();
  };
  defs.forEach((d, k) => {
    buttons.push(h('button.tab', {
      type: 'button', role: 'tab', id: `${id}-t${k}`, 'aria-controls': `${id}-p${k}`,
      on: {
        click: () => select(k),
        keydown: (e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); select((k + 1) % defs.length, true); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); select((k - 1 + defs.length) % defs.length, true); }
        },
      },
    }, d.label));
    panels.push(h('div.tabpanel', { role: 'tabpanel', id: `${id}-p${k}`, 'aria-labelledby': `${id}-t${k}` }));
  });
  const el = h('div.tabs.tabs-seg', h('div.tablist', { role: 'tablist' }, buttons), panels);
  select(0);
  return el;
}

const numbers = (fb) => numbersBlock(fb.spot, fb.decision, PFR.classIndex(fb.hand.class));

/** Who else answered a quiz question: a tick or a cross per name, friends first. */
function othersBlock(o) {
  if (!o) return null;
  return h('section.tf-sec.tf-others', { 'aria-label': 'How the others did' },
    h('div.tf-sec-head', h('h3.fb-h', 'Others on this question'), o.total ? h('span.tf-sum', `${o.right} of ${o.total} right`) : null),
    o.total
      ? h('ul.tf-olist', o.others.map((x) => h(`li.${x.right ? 'ok' : 'no'}`,
        h('span.tf-mark', { 'aria-hidden': 'true' }, x.right ? '✓' : '✕'),
        h('a', { href: `#/player/${x.player.id}`, 'aria-label': `${x.player.name}${x.friend ? ', friend' : ''}: ${x.right ? 'right' : 'wrong'}` }, x.player.name),
        x.friend ? h('span.ot-friend', 'friend') : null)))
      : h('p.tf-note', 'Nobody else has answered it yet.'),
    o.total > o.others.length ? h('p.tf-note', `${o.total - o.others.length} more answered it.`) : null);
}

/**
 * The feedback for an answer: the grade and the verdict, the numbers, the
 * facts, the charts (this decision; facing an all-in also the jammer's range),
 * "Copy for Claude", and in the quiz how the others did.
 */
export function feedbackPanel(fb, { others = null, intro = null } = {}) {
  const sp = fb.spot, d = fb.decision, v = fb.verdict;
  const mine = fb.action === 'fold' ? 'Fold' : PFR.allinLabel(d);
  const chartDefs = [{ label: 'This decision', render: () => h('div.range-view', decisionChart(sp, d, { highlight: fb.hand.class, caption: `${d.seat}: ${d.facing.length ? `facing the ${d.facing[0]}'s all-in` : 'first in'} · ${spotLine(sp)}` })) }];
  if (fb.jammer) chartDefs.push({ label: `${fb.jammer.seat}'s jams`, render: () => h('div.range-view', jamChart(fb.jammer, { highlight: fb.hand.class })) });
  const copy = () => {
    const text = PFR.buildPrompt(fb);
    if (!text) { toast('There is nothing to copy here.'); return; }
    copyText(text, { done: 'Copied. Paste it into Claude.', title: 'Copy this and paste it into Claude' });
  };
  return h('div.feedback.tf', { role: 'region', 'aria-label': 'Feedback' },
    h('div.fb-head',
      h('div.fb-grade', gradeBadge(v.grade), h('span.fb-street', `${sp.exact ? 'Heads-up, exact numbers' : `Monte Carlo · ± is ${PFR.PF.errMult} standard errors`}`)),
      intro,
      h('p.fb-choice', 'You chose ', h('b', mine), ' · ', PFR.verdictText(v, d)),
      fb.stale ? h('p.tf-note', 'This question has changed since you answered it: your result stays as it was graded.') : null),
    h('section.tf-sec', numbers(fb)),
    h('section.tf-sec.tf-facts',
      h('div.tf-sec-head', h('h3.fb-h', 'The spot in numbers'), copyButton(copy, { what: 'this spot' })),
      fb.facts.length ? h('ul.tf-flist', fb.facts.map((f) => h('li', f.text))) : null),
    othersBlock(others),
    h('section.fb-ranges', tabs(chartDefs)));
}

/** The answered options in the bar: the solver's frequency for the hand in big type, the EV, your pick marked. */
function answerCards(fb) {
  const d = fb.decision, v = fb.verdict, units = fb.spot.units;
  const c = PFR.classIndex(fb.hand.class);
  const colors = pfColors(d);
  const tone = v.right ? 'good' : v.grade === 'inaccuracy' ? 'meh' : 'bad';
  const opt = (id, k, label, freq, ev) => {
    const mine = fb.action === id;
    const best = v.close || v.best === id;
    return h(`div.opt.ans.k-${id === 'fold' ? 'fold' : d.facing.length ? 'call' : 'raise'}${mine ? `.mine.affirm-${tone}` : ''}`, {
      role: 'listitem', style: { '--opt': colors[k] },
      'aria-label': `${label}: the solver plays it ${PFR.fmtFreqPct(freq)} with ${fb.hand.class}, EV ${PFR.fmtEv(ev, units)}${mine ? ', your pick' : ''}${best ? (v.close ? ', fine here' : ', the better play') : ''}`,
    },
    h('span.ans-label', label),
    h('span.ans-pct.num', PFR.fmtFreqPct(freq)),
    h('span.ans-ev.num', `EV ${PFR.fmtEv(ev, units)}`),
    mine || best ? h('span.ans-tags', mine ? h('span.ans-tag.ans-you', 'you') : null, best ? h('span.ans-tag.ans-main', v.close ? 'fine' : 'better') : null) : null,
    mine ? h('span.affirm-icon', { 'aria-hidden': 'true' }, v.right ? '✓' : v.grade === 'inaccuracy' ? '~' : '✕') : null);
  };
  return h('div.bar-buttons.answers', { role: 'list', 'aria-label': `The solver with ${fb.hand.class}` },
    opt('fold', 0, 'Fold', 1 - d.freq[c], d.ev_fold[c]),
    opt('allin', 1, PFR.allinLabel(d), d.freq[c], d.ev_allin[c]));
}

// ---------- the screen ----------
/**
 * The question view. opts:
 *   back {href, label}             the link at the top left
 *   onAnswer(q, action) -> {feedback, others?, ...}
 *   onNext()                       the big button after an answer (Enter)
 * Returns { show(q, head), answered(fb, {head, others, nextLabel, nav}), message(text, actions), setBadges(nodes), destroy() }.
 */
export function createQuestionView(root, { back, onAnswer, onNext }) {
  const st = { q: null, fb: null, phase: 'loading', head: null, nextLabel: 'Next', nav: null, badges: null };
  let destroyed = false;
  const top = h('div.play-top.tq-top');
  const tableHost = h('div.table-host');
  const bar = h('div.actionbar.tq-bar', { role: 'group', 'aria-label': 'Your options', tabindex: '-1' });
  const side = h('aside.side', { 'aria-label': 'Feedback panel' });
  const announcer = h('p.sr-only', { role: 'status', 'aria-live': 'polite' });
  const screen = h('section.play.tq', top, h('div.play-grid', h('div.play-main', tableHost, bar), side), announcer);
  clear(root).append(screen);
  const table = createTable(tableHost);

  function renderTop() {
    const hd = st.head || {};
    clear(top).append(
      h('a.back', { href: back.href }, back.label),
      h('div.play-title.tq-title', h('h1', hd.title || ''), hd.sub ? h('p.muted.small', hd.sub) : null),
      h('div.play-badges.tq-badges', st.badges));
  }
  function setSide(node) {
    clear(side);
    side.classList.toggle('has-content', !!node);
    side.scrollTop = 0;
    if (node) side.append(node);
  }

  function renderBar() {
    const topSlot = h('div.bar-slot.bar-top'), mid = h('div.bar-slot.bar-main'), bottom = h('div.bar-slot.bar-bottom');
    bar.dataset.phase = st.phase;
    if ((st.phase === 'deciding' || st.phase === 'submitting') && st.q) {
      const q = st.q, d = q.decision;
      const s = PFR.situation(q.spot, d);
      topSlot.append(h('p.bar-prompt', h('b', 'Your move'), h('span.muted', ` · pot ${PFR.fmtChips(s.pot)} bb${d.facing.length ? (s.overTop ? ` · a call puts in your whole stack, ${PFR.fmtChips(s.commit)} bb` : ` · ${PFR.fmtChips(s.toCall)} bb to call`) : ''}`)));
      const colors = pfColors(d);
      const btn = (id, k, label, sub) => h(`button.opt.k-${id === 'fold' ? 'fold' : d.facing.length ? 'call' : 'raise'}`, {
        type: 'button', style: { '--opt': colors[k] }, dataset: { opt: id }, 'aria-keyshortcuts': String(k + 1),
        disabled: st.phase === 'submitting',
        on: { click: (e) => answer(id, e.currentTarget) },
      }, h('span.opt-key', { 'aria-hidden': 'true' }, k + 1), h('span.opt-main', label), h('span.opt-sub', sub));
      mid.append(h('div.bar-buttons.tq-buttons', { role: 'group', 'aria-label': 'Fold or go all-in' },
        btn('fold', 0, 'Fold', ' '),
        d.facing.length
          ? btn('allin', 1, 'Call', s.overTop
            ? `all-in over the top, ${PFR.fmtChips(s.commit)} bb`
            : `${PFR.fmtChips(s.toCall)} bb${s.hero.stack <= Math.max(...s.jammers.map((j) => j.stack)) ? ', all-in' : ''}`)
          : btn('allin', 1, 'All-in', `${PFR.fmtChips(s.hero.stack)} bb`)));
    } else if (st.phase === 'answered' && st.fb) {
      topSlot.append(h('p.bar-prompt', h('b', st.fb.verdict.right ? (st.fb.verdict.close ? 'Too close to call: both are fine.' : 'Right.') : 'Not the best play.'),
        h('span.muted', ` · ${st.fb.hand.class}, ${PFR.handWords(st.fb.hand.class)}`)));
      mid.append(answerCards(st.fb));
      if (st.nav) bottom.append(st.nav);
      else bottom.append(h('button.btn.btn-primary.big-continue', { type: 'button', on: { click: () => onNext?.() } }, st.nextLabel, h('kbd', 'Enter')));
    } else if (st.phase === 'message' && st.msg) {
      mid.append(h('div.tq-msg', h('p', st.msg.text), st.msg.actions ? h('div.tq-msg-act', st.msg.actions) : null));
    } else if (st.phase === 'loading') {
      topSlot.append(h('p.bar-prompt.muted', 'Dealing…'));
    }
    clear(bar).append(topSlot, mid, bottom);
  }

  async function answer(action, btn) {
    if (st.phase !== 'deciding' || !st.q) return;
    closeChartOverlay();
    st.phase = 'submitting';
    bar.classList.add('busy');
    bar.querySelectorAll('button.opt').forEach((b) => { b.disabled = true; });
    btn?.classList.add('pressed');
    try {
      const r = await onAnswer(st.q, action);
      if (destroyed) return;
      bar.classList.remove('busy');
      if (r?.feedback) view.answered(r.feedback, { others: r.others || null, nextLabel: r.nextLabel, alreadyAnswered: r.alreadyAnswered });
    } catch (e) {
      if (destroyed) return;
      bar.classList.remove('busy');
      st.phase = 'deciding';
      renderBar();
      toast(e.message, 'error');
    }
  }

  function onKey(e) {
    if (destroyed || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.chart-ov, .copy-box, .tdlg, .lover, .term-pop')) return; // a dialog or overlay is open
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    if (st.phase === 'deciding' && (e.key === '1' || e.key === '2')) {
      e.preventDefault();
      bar.querySelectorAll('button.opt')[Number(e.key) - 1]?.click();
      return;
    }
    const onControl = tag === 'button' || tag === 'a' || tag === 'summary';
    if (st.phase === 'answered' && e.key === 'Enter' && !onControl) {
      e.preventDefault();
      bar.querySelector('.bar-bottom .big-continue:not([disabled])')?.click();
    }
  }
  document.addEventListener('keydown', onKey);

  const view = {
    get phase() { return st.phase; },
    get question() { return st.q; },
    setHead(head) { st.head = head; renderTop(); },
    setBadges(nodes) { st.badges = nodes; renderTop(); },
    loading() { st.phase = 'loading'; renderBar(); },
    /** A new question: the table, the line, the two buttons; the panel holds only the table's facts. */
    show(q, head = null, { sideExtra = null } = {}) {
      closeChartOverlay();
      st.q = q; st.fb = null; st.phase = 'deciding'; st.nav = null;
      if (head) st.head = head;
      renderTop();
      table.render(tableModel(q));
      renderBar();
      setSide(spotCard(q, sideExtra));
      announcer.textContent = st.head?.title || '';
      if (document.activeElement && document.activeElement !== document.body && !bar.contains(document.activeElement)) document.activeElement.blur();
      bar.focus({ preventScroll: true }); // never an option: a stray Enter must not answer
    },
    /** An answered question (also opened straight from the quiz results). */
    answered(fb, { others = null, nextLabel = null, head = null, nav = null, alreadyAnswered = false } = {}) {
      closeChartOverlay();
      const q = { spot: fb.spot, decision: fb.decision, hand: fb.hand };
      st.q = q; st.fb = fb; st.phase = 'answered'; st.nav = nav;
      if (nextLabel) st.nextLabel = nextLabel;
      if (head) st.head = head;
      renderTop();
      table.render(tableModel(q, fb.action));
      renderBar();
      setSide(feedbackPanel(fb, { others }));
      if (!nav) sound.grade(fb.verdict.grade);
      if (alreadyAnswered) toast('You had answered this already: your first answer counts.');
      announcer.textContent = `${fb.verdict.label}. ${PFR.verdictText(fb.verdict, fb.decision)}`;
      (bar.querySelector('.bar-bottom .big-continue') || bar.querySelector('.bar-bottom a, .bar-bottom button'))?.focus({ preventScroll: true });
    },
    message(text, actions = null) {
      closeChartOverlay();
      st.phase = 'message'; st.msg = { text, actions };
      renderTop(); renderBar(); setSide(null);
    },
    destroy() {
      destroyed = true;
      closeChartOverlay();
      document.removeEventListener('keydown', onKey);
    },
  };
  renderTop();
  renderBar();
  return view;
}

// ---------- the drill ----------
const PREFS_KEY = 'pokerpuzzles.tdrill.prefs';
const SESSION_KEY = 'pokerpuzzles.tdrill.session';
const loadJson = (store, key, dflt) => { try { return { ...dflt, ...JSON.parse(store.getItem(key) || '{}') }; } catch { return { ...dflt }; } };
const saveJson = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };
const SESSION0 = { hands: 0, right: 0, bb: 0, points: 0 };

const VALUE_NAME = { chips: 'Chips', points: 'League points' };
const KIND_NAME = { open: 'First in', call: 'Facing an all-in', both: 'First in and facing an all-in' };
/** The drill's choices in a few words: "Chips · 6 players · 10 bb · any seat · both · close hands". */
function prefsLine(P, menu) {
  const parts = [VALUE_NAME[P.value], P.players === 'any' ? 'any table' : P.players === 2 ? 'heads-up' : `${P.players} players`];
  if (P.value === 'chips') parts.push(P.stack === 'any' ? 'any stack' : `${P.stack} bb`);
  else if (P.situation !== 'any') { const s = menu.spots.find((x) => x.name === P.situation); if (s) parts.push(situationName(s)); }
  parts.push(P.seat === 'any' ? 'any seat' : P.seat, P.kind === 'both' ? 'both kinds' : KIND_NAME[P.kind].toLowerCase(), P.hands === 'close' ? 'close hands' : 'all hands');
  return parts.join(' · ');
}

/** The choices dialog: changes apply at once (and to the next hand). */
function choicesContent(menu, P, onChange) {
  const box = h('div.tch');
  const draw = () => {
    const chip = (group, value, label, { disabled = false } = {}) => h(`button.chip${P[group] === value ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': String(P[group] === value), disabled,
      on: { click: () => { P[group] = value; Object.assign(P, PFR.normalizePrefs(P)); onChange(P); draw(); box.querySelector(`[data-g="${group}"] .chip.on`)?.focus(); } },
    }, label);
    const row = (group, label, chips) => h('div.tch-row', { dataset: { g: group } }, h('span.tch-k', label), h('div.chips', { role: 'group', 'aria-label': label }, chips));
    const matching = menu.spots.filter((s) => PFR.spotMatches(s, { ...P, seat: 'any' }));
    const seatOk = (seat) => matching.some((s) => (P.kind !== 'call' && s.asked.open.includes(seat)) || (P.kind !== 'open' && s.asked.call.includes(seat)));
    const ns = [2, 3, 4, 5, 6];
    const sits = P.value === 'points' && P.players !== 'any' ? menu.spots.filter((s) => s.units === 'points' && s.n === P.players) : [];
    clear(box).append(...[
      row('value', 'Value', [chip('value', 'chips', 'Chips'), chip('value', 'points', 'League points')]),
      row('players', 'Players', [chip('players', 'any', 'Any'), ...ns.map((n) => chip('players', n, String(n)))]),
      P.value === 'chips'
        ? row('stack', 'Stack', [chip('stack', 'any', 'Any'), ...PFR.STACKS.map((s) => chip('stack', s, `${s} bb`))])
        : row('situation', 'Situation', [chip('situation', 'any', 'Any'), ...sits.map((s) => chip('situation', s.name, situationName(s)))]),
      P.value === 'points' && P.players === 'any' ? h('p.tch-note', 'Pick a table size to choose one of its situations.') : null,
      row('seat', 'Seat', [chip('seat', 'any', 'Any'), ...PFR.SEATS.map((s) => chip('seat', s, s, { disabled: !seatOk(s) && P.seat !== s }))]),
      row('kind', 'Spot', [chip('kind', 'open', 'First in'), chip('kind', 'call', 'Facing an all-in'), chip('kind', 'both', 'Both')]),
      row('hands', 'Hands', [chip('hands', 'close', 'Close hands'), chip('hands', 'all', 'All hands')]),
      h('p.tch-note', `Close hands: the ones where the two plays are at most ${PFR.PF.band} bb apart (in league points: ${PFR.PF.band} bb's worth). All hands: any hand, dealt as often as it comes up.`),
    ].filter(Boolean));
  };
  draw();
  return box;
}

export function drillScreen(root, { menu }) {
  let prefs = PFR.normalizePrefs(loadJson(localStorage, PREFS_KEY, PFR.DRILL_DEFAULTS));
  const sessionKey = `${SESSION_KEY}.${apiSession()?.player?.id || ''}`; // this tab's session, per player
  let session = loadJson(sessionStorage, sessionKey, SESSION0);
  let totals = menu.drill;
  let last = null, pending = null, destroyed = false;
  const fetchNext = () => API.drillNext(prefs, last);
  const view = createQuestionView(root, {
    back: { href: '#/tournament', label: '← Tournament' },
    onAnswer: async (q, action) => {
      const r = await API.drillAnswer(q, action);
      totals = r.totals;
      const v = r.feedback.verdict;
      session.hands++; session.right += v.right ? 1 : 0;
      if (q.spot.units === 'points') session.points += v.cost; else session.bb += v.cost;
      saveJson(sessionStorage, sessionKey, session);
      badges();
      pending = fetchNext(); // the next hand, ready when "Next hand" is pressed
      pending.catch(() => {});
      return { ...r, nextLabel: 'Next hand' };
    },
    onNext: () => next(),
  });

  function badges() {
    const given = [session.bb > 0 || !session.points ? `${PFR.fmtEv(session.bb, 'bb', { sign: false })}` : null, session.points > 0 ? `${PFR.fmtEv(session.points, 'points', { sign: false })}` : null].filter(Boolean).join(' + ');
    view.setBadges(h('div.tq-tally',
      h('span.tq-tally-main', { title: 'This session: right answers of hands, and the EV your answers gave up' },
        h('b.num', `${session.right}/${session.hands}`), h('span.tq-tally-k', ' right'), session.hands ? h('span.tq-tally-cost', ` · ${given} given up`) : null),
      h('button.btn.btn-sm.tq-choices', { type: 'button', on: { click: openChoices } }, 'Choices')));
  }
  function allTime() {
    if (!totals?.hands) return h('p.tspot-line.muted', 'Your drill answers are counted on your profile.');
    return h('p.tspot-line.muted', `All time: ${totals.hands} hand${totals.hands === 1 ? '' : 's'}, ${totals.right} right (${PFR.fmtPct((100 * totals.right) / totals.hands)}).`);
  }
  function head(q) {
    return { title: PFR.questionText(q.spot, q.decision), sub: `Drill · ${prefsLine(prefs, menu)}` };
  }

  async function next() {
    if (destroyed) return;
    view.loading();
    let r = null;
    try { r = pending ? await pending : null; } catch { r = null; }
    pending = null;
    try {
      if (!r) r = await fetchNext();
      if (destroyed) return;
      last = r.question.hand.class;
      view.show(r.question, head(r.question), { sideExtra: allTime() });
    } catch (e) {
      if (destroyed) return;
      view.setHead({ title: 'Drill', sub: prefsLine(prefs, menu) });
      view.message(e.status === 404 ? 'No hands match these choices.' : e.message,
        h('button.btn.btn-primary', { type: 'button', on: { click: () => (e.status === 404 ? openChoices() : next()) } }, e.status === 404 ? 'Change the choices' : 'Try again'));
    }
  }

  function openChoices() {
    const before = JSON.stringify(prefs);
    const P = { ...prefs };
    openDialog({
      title: 'Drill choices', cls: '.tdlg-choices', closeLabel: 'Done',
      content: choicesContent(menu, P, (p) => { prefs = PFR.normalizePrefs(p); saveJson(localStorage, PREFS_KEY, prefs); }),
      onClose: () => {
        if (destroyed || JSON.stringify(prefs) === before) return;
        pending = null;
        if (view.phase === 'answered') { view.setHead({ ...(view.question ? head(view.question) : {}), sub: `Drill · ${prefsLine(prefs, menu)}` }); toast('The next hand uses the new choices.'); }
        else next();
      },
    });
  }

  badges();
  view.setHead({ title: 'Drill', sub: prefsLine(prefs, menu) });
  next();
  return { destroy() { destroyed = true; view.destroy(); } };
}

// ---------- the quiz: one set, one question at a time ----------
export function quizPlayScreen(root, { menu, setId, onDone }) {
  const set = menu.quiz.find((s) => s.id === setId);
  let destroyed = false, count = set?.count || 10, index = 0;
  const line = (sp) => (set.title === 'Heads-up' ? spotLine(sp).replace(/^Heads-up · /, '') : spotLine(sp)); // no "Heads-up · Heads-up"
  const head = (q, i) => ({ title: PFR.questionText(q.spot, q.decision), sub: `Quiz · ${set.title} · question ${i + 1} of ${count} · ${line(q.spot)}` });
  const view = createQuestionView(root, {
    back: { href: '#/tournament/quiz', label: '← Quiz' },
    onAnswer: async (q, action) => {
      const r = await API.quizAnswer(setId, q.id, action);
      return { ...r, nextLabel: r.done ? 'See your results' : 'Next question' };
    },
    onNext: () => next(),
  });
  function progress(i) {
    view.setBadges(h('div.tq-progress', { 'aria-label': `Question ${i + 1} of ${count}` },
      Array.from({ length: count }, (_, k) => h(`span.tq-pip${k < i ? '.done' : k === i ? '.now' : ''}`))));
  }
  async function next() {
    if (destroyed) return;
    view.loading();
    try {
      const r = await API.quizNext(setId);
      if (destroyed) return;
      count = r.count;
      if (r.done) { onDone?.(); return; }
      index = r.index;
      progress(index);
      view.show({ ...r.question }, head(r.question, index));
    } catch (e) {
      if (destroyed) return;
      view.message(e.message, h('button.btn.btn-primary', { type: 'button', on: { click: () => next() } }, 'Try again'));
    }
  }
  if (!set) { view.message('No such quiz set.', h('a.btn', { href: '#/tournament/quiz' }, 'All sets')); return { destroy() { view.destroy(); } }; }
  view.setHead({ title: set.title, sub: `Quiz · ${set.blurb}` });
  next();
  return { destroy() { destroyed = true; view.destroy(); } };
}

/** One answered quiz question, opened from the results: your answer, the right one, the numbers. */
export function quizReviewScreen(root, { setId, index }) {
  let destroyed = false;
  const view = createQuestionView(root, { back: { href: `#/tournament/quiz/${encodeURIComponent(setId)}`, label: '← Results' }, onAnswer: null, onNext: null });
  (async () => {
    try {
      const s = await API.quizSummary(setId);
      if (destroyed) return;
      const a = s.answers[index];
      if (!a || !a.feedback) { view.message('You have not answered this question yet.', h('a.btn', { href: `#/tournament/quiz/${encodeURIComponent(setId)}` }, 'Back to the set')); return; }
      let others = null;
      try { others = await API.quizOthers(a.id); } catch { /* shown without */ }
      if (destroyed) return;
      const link = (n, label, cls = '') => h(`a.btn${cls}`, { href: `#/tournament/quiz/${encodeURIComponent(setId)}/${n + 1}` }, label);
      const nav = h('div.tq-nav',
        index > 0 ? link(index - 1, '◀ Previous') : h('span'),
        h('a.btn.btn-primary', { href: `#/tournament/quiz/${encodeURIComponent(setId)}` }, 'Back to the results'),
        index < s.answers.length - 1 ? link(index + 1, 'Next ▶') : h('span'));
      view.setBadges(h('div.tq-progress', s.answers.map((x, k) => h(`a.tq-pip.${x.right ? 'ok' : 'no'}${k === index ? '.now' : ''}`, { href: `#/tournament/quiz/${encodeURIComponent(setId)}/${k + 1}`, 'aria-label': `Question ${k + 1}: ${x.right ? 'right' : 'wrong'}` }))));
      view.answered(a.feedback, {
        others, nav,
        head: { title: PFR.questionText(a.feedback.spot, a.feedback.decision), sub: `Quiz · ${s.set.title} · question ${index + 1} of ${s.count} · ${s.set.title === 'Heads-up' ? spotLine(a.feedback.spot).replace(/^Heads-up · /, '') : spotLine(a.feedback.spot)} · answered in ${Math.round(a.timeMs / 1000)} s` },
      });
    } catch (e) {
      if (!destroyed) view.message(e.message, h('a.btn', { href: '#/tournament/quiz' }, 'Quiz'));
    }
  })();
  return { destroy() { destroyed = true; view.destroy(); } };
}
