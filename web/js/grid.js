// 13x13 range grids with a fixed readout, stacked frequency bars, the equity
// bar, and the full-screen chart: a click on a chart (or its "Enlarge"
// button) opens it large, every cell showing its numbers without hovering.
import { h, fmtPct, fmtFreq, trapFocus } from './ui.js';
import { classIndexName, classIndexOf, classCombos, shortLabel, cardText } from './poker.js';

const ENLARGE_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Range grid plus a fixed readout area above it.
 * Strategy grid: each cell holds horizontal segments in proportion to the
 * option frequencies; the filled height is the weight w. Heat grid
 * (heat: true): one colour with opacity by w, readout shows weight only.
 * The readout shows the hovered / focused cell as its class (the average over
 * all suit combos of that class). When nothing is hovered it shows `exact`
 * ({cards, freq}: the hero's own two cards and the strategy the action
 * buttons show) if given, else the `highlight` class, so it never jumps.
 * A click (Enter) on a cell, or the Enlarge button, opens the full-screen chart.
 * Optional hooks (the tournament charts): sub(c) replaces the readout's second
 * line, cellClass(c) adds a class to a cell (and its full-screen twin),
 * onPick(c, cell) takes a cell click instead of opening the full-screen chart,
 * overlay { extra(c), note } adds a line of numbers to each full-screen cell and
 * replaces the full-screen legend's note.
 */
export function rangeGrid({ range, options = null, colors = null, highlight = null, exact = null, heat = false, caption, sub = null, cellClass = null, onPick = null, overlay = null }) {
  const cells = [];
  const fallback = highlight ? classIndexOf(highlight) : range.w.findIndex((x) => x > 0);
  const readout = h('div.readout', { 'aria-live': 'polite' });
  // The readout keeps one height per chart (no jump while hovering): tall enough for every option row.
  const optionRows = !heat && options && range.f ? options.length : 1;
  readout.style.setProperty('--ro-lines', String(optionRows > 3 ? Math.ceil(optionRows / 2) : optionRows));

  const strategyRows = (freqs) => options.map((o, k) => h('div.ro-row',
    h('span.ro-label', shortLabel(o)),
    h('span.ro-bar', h('span.ro-fill', { style: { width: `${(freqs[k] * 100).toFixed(1)}%`, background: colors[k] } })),
    h('b.ro-pct.num', fmtFreq(freqs[k]))));
  const rowsEl = (rows) => h(`div.ro-rows${rows.length > 3 ? '.ro-rows-2' : ''}`, rows);
  const COMBOS = { 6: 'all 6 combos', 4: 'all 4 suited combos', 12: 'all 12 offsuit combos' };

  // The hero's exact two cards: the same numbers as the answered action buttons.
  const showExact = () => {
    readout.replaceChildren(
      h('div.ro-top',
        h('div.ro-head', h('span.ro-class.ro-cards', exact.cards.map(cardText)), h('span.ro-you', 'your hand')),
        h('p.ro-sub', 'exactly these two cards, as on the buttons')),
      rowsEl(strategyRows(exact.freq)));
  };

  // A grid cell: the class, averaged over all its suit combos.
  const show = (c) => {
    if (c < 0 || c === undefined) { readout.replaceChildren(h('p.ro-empty', 'Empty range')); return; }
    const w = range.w[c] || 0;
    const name = classIndexName(c);
    const head = h('div.ro-top',
      h('div.ro-head', h('span.ro-class', name), h('span.ro-combos', `· ${COMBOS[classCombos(c)]}`)),
      h('p.ro-sub', sub ? sub(c) : w > 0 ? ['in range ', h('b.num', fmtFreq(w)), ' of the time'] : 'not in range'));
    const rows = !heat && options && range.f
      ? strategyRows(w > 0 ? range.f[c] : options.map(() => 0))
      : [h('div.ro-row',
        h('span.ro-label', 'Weight'),
        h('span.ro-bar', h('span.ro-fill.ro-heat', { style: { width: `${(w * 100).toFixed(1)}%` } })),
        h('b.ro-pct.num', fmtFreq(w)))];
    readout.replaceChildren(head, rowsEl(rows));
  };
  if (exact && !(!heat && options && exact.cards?.length === 2 && exact.freq?.length === options.length)) exact = null;
  const rest = () => (exact ? showExact() : show(fallback));
  const open = (c, from) => openChart({ range, options, colors, highlight, exact, heat, caption: caption || 'Range', focusClass: c, returnTo: from, cellClass, extra: overlay?.extra || null, note: overlay?.note || null });

  for (let c = 0; c < 169; c++) {
    const w = range.w[c] || 0;
    const name = classIndexName(c);
    const cls = ['cell'];
    if (w <= 0) cls.push('empty');
    if (highlight === name) cls.push('mine');
    const i = Math.floor(c / 13), j = c % 13;
    if (i === j) cls.push('pair'); else if (i < j) cls.push('suited');
    const more = cellClass?.(c);
    if (more) cls.push(...more.split(' ').filter(Boolean));
    let fill;
    if (heat) {
      fill = h('span.heat', { style: { opacity: w > 0 ? (0.12 + 0.88 * w).toFixed(3) : 0 } });
    } else if (w > 0 && range.f) {
      fill = h('span.fill', { style: { height: `${Math.max(6, w * 100).toFixed(1)}%` } },
        range.f[c].map((f, k) => (f > 0 ? h('span.seg', { style: { flexGrow: f, background: colors[k] } }) : null)));
    }
    const cell = h(`button.${cls.join('.')}`, {
      type: 'button', tabindex: c === (fallback >= 0 ? fallback : 0) ? '0' : '-1',
      'aria-label': `${name}, ${sub && options && range.f
        ? options.map((o, k) => `${o.label} ${fmtFreq(range.f[c][k])}`).join(', ')
        : w > 0 ? `in range ${fmtFreq(w)} of the time` : 'not in range'}. ${onPick ? 'Shows its numbers' : 'Opens the chart full screen'}`,
      on: {
        mouseenter: () => show(c),
        mouseleave: rest,
        focus: () => show(c),
        click: () => (onPick ? onPick(c, cell) : open(c, cell)),
        keydown: (e) => {
          const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 13, ArrowUp: -13 };
          if (!(e.key in moves)) return;
          e.preventDefault();
          e.stopPropagation();
          const n = c + moves[e.key];
          if (n >= 0 && n < 169) { cells[c].tabIndex = -1; cells[n].tabIndex = 0; cells[n].focus(); }
        },
      },
    }, fill, h('span.lbl', name));
    cells.push(cell);
  }
  const grid = h(`div.grid${heat ? '.grid-heat' : ''}`, {
    role: 'group', 'aria-label': caption || 'Range grid',
    on: { mouseleave: rest, focusout: (e) => { if (!grid.contains(e.relatedTarget)) rest(); } },
  }, cells);
  rest();
  const enlarge = h('button.ro-enlarge', {
    type: 'button', title: 'Show this chart full screen, with every number', 'aria-label': `${caption || 'Range'}: show full screen, with every number`,
    on: { click: (e) => open(null, e.currentTarget) },
  }, h('span.ro-enlarge-ico', { html: ENLARGE_ICON }), h('span.ro-enlarge-t', 'Enlarge'));
  return h('div.grid-wrap', h('div.gw', h('div.ro-wrap', readout, enlarge), h('div.grid-box', grid)));
}

// ---------- the full-screen chart ----------
let current = null; // the open chart: { close(opts) }

/** Close the full-screen chart if one is open (the hand moved on, the screen changes). */
export function closeChartOverlay() { current?.close({ restore: false }); }
export const chartOverlayOpen = () => !!current;

/** A frequency as a whole number for a cell: at least 1 for anything shown, never 100 for a mix. */
function cellPct(v) {
  const p = Math.round(v * 100);
  if (v < 1 - 1e-9) return String(Math.max(1, Math.min(99, p)));
  return '100';
}

/**
 * The full-screen chart. Exported for pages that draw their own grid (the
 * tournament charts). cellClass(c) / extra(c) / note: as rangeGrid's hooks.
 */
export function openChart({ range, options, colors, highlight, exact, heat, caption, focusClass = null, returnTo = null, cellClass = null, extra = null, note = null }) {
  current?.close({ restore: false });
  const strategy = !heat && !!options && !!range.f;
  const prevFocus = returnTo || document.activeElement;
  const rows = [];
  let focusCell = null;
  for (let i = 0; i < 13; i++) {
    const row = [];
    for (let j = 0; j < 13; j++) {
      const c = 13 * i + j;
      const w = range.w[c] || 0;
      const name = classIndexName(c);
      const cls = ['xc', i === j ? 'pair' : i < j ? 'suited' : 'offsuit'];
      if (w <= 0) cls.push('empty');
      if (highlight === name) cls.push('mine');
      if (c === focusClass) cls.push('picked');
      const more = cellClass?.(c);
      if (more) cls.push(...more.split(' ').filter(Boolean));
      const body = [h('span.xc-name', name)];
      let label = name;
      const style = {};
      if (strategy) {
        if (w > 0) {
          const f = range.f[c];
          const shown = options.map((o, k) => ({ o, k, v: f[k] || 0 })).filter((x) => x.v >= 0.005);
          body.push(...shown.map(({ k, v }) => h('b.xc-n', { style: { '--c': colors[k] } }, cellPct(v))));
          const x = extra?.(c);
          if (x) body.push(h('span.xc-x', x));
          body.push(h('span.xc-bar', { 'aria-hidden': 'true', style: { width: `${Math.max(6, w * 100).toFixed(1)}%` } },
            f.map((v, k) => (v > 0 ? h('span', { style: { flexGrow: v, background: colors[k] } }) : null))));
          label += `: ${shown.map(({ o, v }) => `${shortLabel(o)} ${fmtFreq(v)}`).join(', ')}${w < 0.995 ? `; ${fmtFreq(w)} of the class is in the range` : ''}${x ? `; ${x}` : ''}`;
        } else label += ': not in the range';
      } else if (w > 0) {
        body.push(h('b.xc-w', fmtFreq(w)));
        style['--heat-a'] = (0.1 + 0.42 * w).toFixed(3);
        label += `: ${fmtFreq(w)} of the class is in the range`;
      } else label += ': not in the range';
      const cell = h(`div.${cls.join('.')}`, { role: 'cell', 'aria-label': label, style }, body);
      if (c === focusClass) focusCell = cell;
      row.push(cell);
    }
    rows.push(h('div.cov-row', { role: 'row' }, row));
  }
  const grid = h(`div.cov-grid${strategy ? '' : '.cov-heat'}`, { role: 'table', 'aria-label': caption }, rows);
  const scroll = h('div.cov-scroll', { tabindex: '0', 'aria-label': `${caption}: the chart (scrolls when it does not fit)` }, grid);

  const exactLine = exact && strategy
    ? h('p.cov-exact', h('span.cov-you', 'Your hand'), ' ', exact.cards.map(cardText), ' ',
      options.map((o, k) => (exact.freq[k] >= 0.005 ? h('span.cov-ex-opt', h('span.cov-sw', { style: { background: colors[k] } }), shortLabel(o), ' ', h('b.num', fmtFreq(exact.freq[k]))) : null)))
    : highlight ? h('p.cov-exact', h('span.cov-you', 'Your hand'), ` ${highlight} is outlined`) : null;
  const legend = h('div.cov-legend',
    strategy
      ? [h('p.cov-keys', options.map((o, k) => h('span.cov-leg', h('span.cov-sw', { style: { background: colors[k] } }), shortLabel(o)))),
        h('p.cov-note', note || 'Numbers: how often each action is played, in %. The bar under them: how much of the hand class is in the range.')]
      : h('p.cov-note', h('span.cov-sw.cov-sw-heat'), 'Number: how much of each hand class is in the range.'),
    exactLine);

  const clockSlot = h('div.cov-clock', { 'aria-live': 'off' });
  const closeBtn = h('button.btn.cov-close', { type: 'button' }, 'Close', h('kbd', 'Esc'));
  const panel = h('div.cov-panel',
    h('div.cov-head', h('h2.cov-title', caption), clockSlot, closeBtn),
    legend, scroll);
  const ov = h('div.chart-ov', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${caption}, full screen` }, panel);
  // A click on the dimmed area outside closes it (on click, so the focus can go back to the chart afterwards).
  let downOutside = false;
  ov.addEventListener('pointerdown', (e) => { downOutside = e.target === ov; });
  ov.addEventListener('click', (e) => { if (e.target === ov && downOutside) close(); });
  closeBtn.addEventListener('click', () => close());

  // A running battle clock stays in view: the overlay shows the action bar's clock.
  const syncClock = () => {
    const src = document.querySelector('.actionbar .bclock');
    const have = clockSlot.firstElementChild;
    if (!src) { if (have) clockSlot.replaceChildren(); return; }
    if (have && have.dataset.deadline === src.dataset.deadline) return;
    clockSlot.replaceChildren(src.cloneNode(true));
  };
  syncClock();
  const iv = setInterval(syncClock, 250);

  // On window, capturing: Escape closes this before any screen (or the Learn overlay underneath) sees it.
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const onHash = () => close({ restore: false });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', onHash);
  document.documentElement.classList.add('cov-open');
  document.body.append(ov);
  const untrap = trapFocus(ov);
  closeBtn.focus({ preventScroll: true });
  if (focusCell) {
    // bring the clicked class into view (phones scroll the chart)
    const sr = scroll.getBoundingClientRect(), cr = focusCell.getBoundingClientRect();
    scroll.scrollLeft += cr.left + cr.width / 2 - (sr.left + sr.width / 2);
    scroll.scrollTop += cr.top + cr.height / 2 - (sr.top + sr.height / 2);
  }

  let closed = false;
  function close({ restore = true } = {}) {
    if (closed) return;
    closed = true;
    clearInterval(iv);
    untrap();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', onHash);
    document.documentElement.classList.remove('cov-open');
    ov.remove();
    if (current === me) current = null;
    if (restore && prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
  }
  const me = { close };
  current = me;
  return me;
}

/** Horizontal stacked bar of frequencies with a legend. */
export function freqBar(freqs, options, colors, { marked = null, legend = true, title, heading = null } = {}) {
  const bar = h('div.stack', { role: 'img', 'aria-label': (title ? title + ': ' : '') + options.map((o, k) => `${shortLabel(o)} ${fmtFreq(freqs[k])}`).join(', ') },
    options.map((o, k) => (freqs[k] > 0 ? h('span.stack-seg', { style: { flexGrow: freqs[k], background: colors[k] }, title: `${shortLabel(o)} ${fmtFreq(freqs[k])}` },
      freqs[k] >= 0.1 ? h('span.stack-txt', fmtFreq(freqs[k])) : null) : null)));
  if (!legend) return bar;
  return h('div.stack-wrap', heading ? h('p.stack-head', heading) : null, bar, h('div.legend', options.map((o, k) => h(`span.leg${marked === o.id ? '.leg-marked' : ''}`,
    h('span.sw', { style: { background: colors[k] } }), shortLabel(o), ' ', h('b.num', fmtFreq(freqs[k]))))));
}

export function equityBar(hero, villain) {
  if (hero === null || hero === undefined) return null;
  const v = villain ?? 1 - hero;
  return h('div.equity', { role: 'img', 'aria-label': `Equity: your range ${fmtPct(hero, 1)}, villain ${fmtPct(v, 1)}` },
    h('div.equity-labels', h('span', 'Your range ', h('b.num', fmtPct(hero, 1))), h('span', 'Villain ', h('b.num', fmtPct(v, 1)))),
    h('div.equity-bar', h('span.eq-hero', { style: { flexGrow: hero } }), h('span.eq-vil', { style: { flexGrow: v } })));
}
