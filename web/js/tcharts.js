// Tournament charts: a push/fold decision as a 13x13 chart (the site's range
// grid: colour = how often the solver goes all-in or calls with each hand,
// hands too close to call marked with a dot), the full-screen chart with every
// number, and the Charts page (#/tournament/charts[/<spot>[/<decision>]]):
// pick the value, the table size, the stack or the situation, then a decision.
import { h, clear, toast } from './ui.js';
import { API } from './api.js';
import { rangeGrid, openChart, closeChartOverlay } from './grid.js';
import { actionColors } from './poker.js';
import * as PFR from './pushfold.js';

const OPTIONS = {
  open: [{ id: 'fold', kind: 'fold', label: 'Fold' }, { id: 'allin', kind: 'raise', label: 'All-in' }],
  call: [{ id: 'fold', kind: 'fold', label: 'Fold' }, { id: 'allin', kind: 'call', label: 'Call' }],
};
/** Fold and the all-in action of a decision (All-in first in, Call facing an all-in), as chart options. */
export const pfOptions = (d) => (d.facing.length ? OPTIONS.call : OPTIONS.open);
/** Their colours: fold blue, call green, a first-in jam red (the site's action colours). */
export const pfColors = (d) => actionColors(pfOptions(d));
const rangeOf = (freq) => ({ w: freq.map(() => 1), f: freq.map((x) => [Math.max(0, 1 - x), x]) });

const allinVerb = (d) => (d.facing.length ? 'call' : 'all-in');
/** "+0.31 bb ±0.02 · all-in better" / "too close to call": a hand's line under the readout. */
function cellLine(spot, d, c) {
  const v = PFR.verdict(spot, d, c, 'fold');
  if (!v) return 'no numbers for this hand';
  const diff = `${PFR.fmtEv(v.d, spot.units)} ${spot.exact ? 'exact' : PFR.fmtErr(v.se, spot.units)}`;
  return `${diff} · ${v.close ? 'too close to call' : `${v.best === 'allin' ? allinVerb(d) : 'fold'} better`}`;
}

/**
 * One decision's chart. spot: anything with the spot's units, stacks, payouts
 * and exact (a feedback payload's spot, or the charts' spot data); d: the
 * decision with its per-class arrays. opts: highlight (a class name, outlined),
 * caption, onPick(c) (instead of opening the full-screen chart).
 */
export function decisionChart(spot, d, { highlight = null, caption = 'Chart', onPick = null } = {}) {
  const close = d.freq.map((_, c) => !!PFR.verdict(spot, d, c, 'fold')?.close);
  return rangeGrid({
    range: rangeOf(d.freq), options: pfOptions(d), colors: pfColors(d), highlight, caption, onPick,
    sub: (c) => cellLine(spot, d, c),
    cellClass: (c) => (close[c] ? 'pf-close' : null),
    overlay: {
      extra: (c) => (d.ev_diff[c] === null ? null : PFR.fmtEv(d.ev_diff[c], spot.units, { unit: false })),
      note: `Numbers: how often the solver folds and ${d.facing.length ? 'calls' : 'goes all-in'} with each hand, in %; under them the EV of ${d.facing.length ? 'calling' : 'going all-in'} minus folding, in ${spot.units === 'points' ? 'league points' : 'bb'}. A dot: too close to call.`,
    },
  });
}

/** The jammer's first-in range (how often he jams each hand), for a decision facing his all-in. */
export function jamChart(jammer, { highlight = null } = {}) {
  const d = { facing: [], freq: jammer.freq };
  return rangeGrid({
    range: rangeOf(jammer.freq), options: pfOptions(d), colors: pfColors(d), highlight,
    caption: `${jammer.seat}'s jam range (first in)`,
    sub: (c) => `${jammer.seat} jams it ${PFR.fmtFreqPct(jammer.freq[c])} of the time`,
    overlay: { note: `Numbers: how often ${jammer.seat} folds and goes all-in with each hand when it is folded to him, in %.` },
  });
}

/**
 * The numbers of a hand at a decision: the EV of folding and of going all-in,
 * the difference with its error (or "exact"), the solver's frequency. Each
 * value large, its unit (or error) small under it.
 */
export function numbersBlock(sp, d, c) {
  const units = sp.units, unit = PFR.UNIT[units];
  const verb = PFR.allinLabel(d);
  const n = (x) => PFR.fmtEv(x, units, { unit: false });
  return h('dl.tf-nums', { 'aria-label': `The numbers for ${PFR.CLASSES[c]}` },
    h('div', h('dt', 'Fold'), h('dd.num', n(d.ev_fold[c]), h('span.tf-err', `EV, ${unit}`))),
    h('div', h('dt', verb), h('dd.num', n(d.ev_allin[c]), h('span.tf-err', `EV, ${unit}`))),
    h('div', h('dt', 'Difference'), h('dd.num', n(d.ev_diff[c]), h('span.tf-err', sp.exact ? `exact, ${unit}` : `${PFR.fmtErr(d.ev_diff_se[c], units)} ${unit}`))),
    h('div', h('dt', 'Solver'), h('dd.num', PFR.fmtFreqPct(d.freq[c]), h('span.tf-err', verb === 'Call' ? 'calls' : 'all-in'))));
}

/** A decision's name in the charts: "First in from the CO", "BB facing the BTN's all-in". */
export function decisionName(spot, d) {
  if (!d.facing.length) return spot.seats.length === 2 ? `First in from the ${d.seat} (heads-up)` : `First in from the ${d.seat}`;
  if (d.facing.length === 1) return `${d.seat} facing the ${d.facing[0]}'s all-in`;
  return `${d.seat} facing all-ins from ${PFR.listAnd(d.facing)}`;
}
/** A points spot as the drill and the charts name it: "CO 25 · BTN 9 · SB 6 · BB 10". */
export const situationName = (spot) => spot.seats.map((s, i) => `${s} ${PFR.fmtChips(spot.stacks[i])}`).join(' · ');

// ---------- the Charts page ----------
const CHART_KEY = 'pokerpuzzles.tcharts';
const spotCache = new Map(); // name -> spot data (the server answers again with 304 when it has not changed)
export async function loadSpot(name) {
  if (spotCache.has(name)) return spotCache.get(name);
  const data = await API.tournamentSpot(name);
  spotCache.set(name, data);
  return data;
}

export function chartsScreen(root, { menu, spotName = null, decisionId = null }) {
  let destroyed = false;
  let sel = { value: 'chips', players: 6, stack: 10, situation: null, decision: null };
  try { sel = { ...sel, ...JSON.parse(localStorage.getItem(CHART_KEY) || '{}') }; } catch { /* ignore */ }
  const byName = new Map(menu.spots.map((s) => [s.name, s]));
  if (spotName && byName.has(spotName)) {
    const s = byName.get(spotName);
    sel.value = s.units === 'points' ? 'points' : 'chips';
    sel.players = s.n;
    if (s.units === 'points') sel.situation = s.name; else sel.stack = s.stacks[0];
    sel.decision = decisionId;
  }
  let data = null, picked = null, loading = false;
  const el = h('section.tpage.tcharts');
  clear(root).append(el);

  const save = () => { try { localStorage.setItem(CHART_KEY, JSON.stringify(sel)); } catch { /* ignore */ } };
  const spotsOf = (value, n) => menu.spots.filter((s) => (s.units === 'points') === (value === 'points') && s.n === n);
  function currentSpot() {
    const list = spotsOf(sel.value, sel.players);
    if (sel.value === 'chips') return list.find((s) => s.stacks[0] === sel.stack) || list[0] || null;
    return list.find((s) => s.name === sel.situation) || list[0] || null;
  }

  async function load() {
    const meta = currentSpot();
    if (!meta) { data = null; render(); return; }
    if (data?.name === meta.name) { render(); return; }
    loading = true; render();
    try {
      const d = await loadSpot(meta.name);
      if (destroyed) return;
      data = d;
      if (!data.decisions.some((x) => x.id === sel.decision)) sel.decision = data.decisions[0].id;
      picked = null;
    } catch (e) { if (!destroyed) toast(e.message, 'error'); }
    loading = false;
    if (!destroyed) render();
  }

  function chip(label, on, onClick, { disabled = false, title = null } = {}) {
    return h(`button.chip${on ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(on), disabled, title, on: { click: onClick } }, label);
  }
  function set(patch) {
    Object.assign(sel, patch);
    const meta = currentSpot();
    if (meta) { if (sel.value === 'chips') sel.stack = meta.stacks[0]; else sel.situation = meta.name; }
    save();
    load();
  }

  function picker() {
    const ns = [2, 3, 4, 5, 6];
    const chipsStacks = [...new Set(spotsOf('chips', sel.players).map((s) => s.stacks[0]))].sort((a, b) => a - b);
    const sits = spotsOf('points', sel.players);
    return h('div.tch-pick',
      h('div.tch-row', h('span.tch-k', 'Value'), h('div.chips', { role: 'group', 'aria-label': 'Value' },
        chip('Chips', sel.value === 'chips', () => set({ value: 'chips' })),
        chip('League points', sel.value === 'points', () => set({ value: 'points' })))),
      h('div.tch-row', h('span.tch-k', 'Players'), h('div.chips', { role: 'group', 'aria-label': 'Players' },
        ns.map((n) => chip(String(n), sel.players === n, () => set({ players: n }))))),
      sel.value === 'chips'
        ? h('div.tch-row', h('span.tch-k', 'Stack'), h('div.chips', { role: 'group', 'aria-label': 'Stack in big blinds' },
          chipsStacks.map((s) => chip(`${s} bb`, sel.stack === s, () => set({ stack: s })))))
        : h('div.tch-row', h('label.tch-k', { for: 'tch-sit' }, 'Situation'),
          h('select.tsel#tch-sit', { on: { change: (e) => set({ situation: e.target.value }) } },
            sits.map((s) => h('option', { value: s.name, selected: s.name === sel.situation }, situationName(s)))))) ;
  }

  function decisionSelect() {
    const groups = [
      ['First in', data.decisions.filter((d) => d.kind === 'open')],
      ['Facing one all-in', data.decisions.filter((d) => d.kind === 'call')],
      ['Facing two or more all-ins (rare, larger errors)', data.decisions.filter((d) => d.kind === 'multi')],
    ].filter(([, list]) => list.length);
    return h('div.tch-row.tch-dec', h('label.tch-k', { for: 'tch-dec' }, 'Decision'),
      h('select.tsel#tch-dec', {
        on: { change: (e) => { sel.decision = e.target.value; picked = null; save(); render(); el.querySelector('#tch-dec')?.focus(); } },
      }, groups.map(([label, list]) => h('optgroup', { label },
        list.map((d) => h('option', { value: d.id, selected: d.id === sel.decision }, `${decisionName(data, d)}${d.kind === 'call' && !d.askable ? ' (rare)' : ''}`))))));
  }

  /** The picked hand's numbers. */
  function details(d) {
    if (picked === null) {
      return h('div.tch-detail.tch-hint', h('p', 'Click a hand for its numbers: the EV of folding and of going all-in, the difference with its error, and how often the solver plays it.'));
    }
    const c = picked, units = data.units;
    const v = PFR.verdict(data, d, c, 'fold');
    const name = PFR.CLASSES[c];
    const verb = d.facing.length ? 'Call' : 'All-in';
    return h('div.tch-detail', { 'aria-live': 'polite' },
      h('p.tch-hand', h('b', name), h('span.muted', ` · ${PFR.handWords(name)}`)),
      numbersBlock(data, d, c),
      v ? h(`p.tch-verdict${v.close ? '.is-close' : ''}`, v.close ? 'Too close to call: both plays are fine here.' : `${v.best === 'allin' ? verb : 'Fold'} is better by ${PFR.fmtCost(v.diff, v.se, units, data.exact)}.`) : null);
  }

  function render() {
    closeChartOverlay();
    const focusId = document.activeElement?.id;
    const meta = currentSpot();
    // The chart on the left, everything else beside it: the whole chart shows without scrolling on a laptop.
    const kids = [
      h('div.tpage-head.tch-head',
        h('a.back', { href: '#/tournament' }, '← Tournament'),
        h('h1', 'Charts'),
        h('p.muted', 'Colour: how often the solver goes all-in (or calls) with each hand. A dot: too close to call.')),
    ];
    if (!meta) kids.push(h('div.tch-main', h('div.tch-ctl', picker()), h('p.muted.pad.tch-chart.tch-wait', 'No spot for these choices.')));
    else if (!data || loading) kids.push(h('div.tch-main', h('div.tch-ctl', picker()), h('p.muted.pad.tch-chart.tch-wait', 'Loading…')));
    else {
      const d = data.decisions.find((x) => x.id === sel.decision) || data.decisions[0];
      try { history.replaceState(null, '', `#/tournament/charts/${data.name}/${d.id}`); } catch { /* ignore */ }
      const verb = d.facing.length ? 'Calls' : 'Jams';
      kids.push(h('div.tch-main',
        h('div.tch-ctl', picker(), decisionSelect()),
        h('div.tch-chart', decisionChart(data, d, {
          highlight: picked !== null ? PFR.CLASSES[picked] : null,
          caption: `${decisionName(data, d)} · ${data.units === 'points' ? situationName(data) : `${data.n} players, ${PFR.fmtChips(data.stacks[0])} bb`}`,
          onPick: (c) => { picked = c; render(); el.querySelectorAll('.tch-chart .cell')[c]?.focus({ preventScroll: true }); },
        })),
        h('div.tch-info',
          h('p.tch-headline', h('b', `${verb} ${PFR.fmtPct(d.allin_pct)} of hands`), h('span.muted', ` · this decision comes up in ${PFR.fmtPct(100 * d.reach)} of hands`)),
          h('p.tch-spot', `${data.n} players · ${data.units === 'points' ? `league points · ${PFR.placesText(data)}` : 'chip EV'} · ${data.exact ? 'heads-up: exact' : `Monte Carlo: the ± is ${PFR.PF.errMult} standard errors`}`),
          data.note ? h('p.tch-spot.muted', `Chips: ${data.note}.`) : null,
          d.kind === 'multi' ? h('p.tch-notice', 'Facing two or more all-ins: this comes up rarely, so its numbers rest on fewer deals and carry larger errors (each hand shows its own ±). The drill and the quiz never ask it.') : null,
          d.kind === 'call' && !d.askable ? h('p.tch-notice', `This decision comes up in under ${PFR.PF.minReach * 100}% of hands: the drill and the quiz do not ask it.`) : null,
          details(d),
          h('p.tch-legend', h('span.tch-dot', { 'aria-hidden': 'true' }), 'too close to call. "Enlarge" shows every number at once.'))));
    }
    clear(el).append(...kids);
    if (focusId) el.querySelector(`#${focusId}`)?.focus({ preventScroll: true });
  }

  load();
  return { destroy() { destroyed = true; closeChartOverlay(); } };
}
export { openChart };
