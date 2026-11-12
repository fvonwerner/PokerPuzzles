// 13x13 range grids with a fixed readout, stacked frequency bars and the equity bar.
import { h, fmtPct, fmtFreq, fmtBb } from './ui.js';
import { classIndexName, classIndexOf, classCombos, shortLabel, cardText } from './poker.js';

/**
 * Range grid plus a fixed readout area above it.
 * Strategy grid: each cell holds horizontal segments in proportion to the
 * option frequencies; the filled height is the weight w. Heat grid
 * (heat: true): one colour with opacity by w, readout shows weight only.
 * The readout shows the hovered / focused / tapped cell as its class (the
 * average over all suit combos of that class). When nothing is hovered it
 * shows `exact` ({cards, freq}: the hero's own two cards and the strategy the
 * action buttons show) if given, else the `highlight` class, so it never jumps.
 */
export function rangeGrid({ range, options = null, colors = null, highlight = null, exact = null, heat = false, caption }) {
  const cells = [];
  const fallback = highlight ? classIndexOf(highlight) : range.w.findIndex((x) => x > 0);
  let selected = null; // tapped cell index
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
      h('p.ro-sub', w > 0 ? ['in range ', h('b.num', fmtFreq(w)), ' of the time'] : 'not in range'));
    const rows = !heat && options && range.f
      ? strategyRows(w > 0 ? range.f[c] : options.map(() => 0))
      : [h('div.ro-row',
        h('span.ro-label', 'Weight'),
        h('span.ro-bar', h('span.ro-fill.ro-heat', { style: { width: `${(w * 100).toFixed(1)}%` } })),
        h('b.ro-pct.num', fmtFreq(w)))];
    readout.replaceChildren(head, rowsEl(rows));
  };
  if (exact && !(!heat && options && exact.cards?.length === 2 && exact.freq?.length === options.length)) exact = null;
  const rest = () => (selected ? show(selected.idx) : exact ? showExact() : show(fallback));

  for (let c = 0; c < 169; c++) {
    const w = range.w[c] || 0;
    const name = classIndexName(c);
    const cls = ['cell'];
    if (w <= 0) cls.push('empty');
    if (highlight === name) cls.push('mine');
    const i = Math.floor(c / 13), j = c % 13;
    if (i === j) cls.push('pair'); else if (i < j) cls.push('suited');
    let fill;
    if (heat) {
      fill = h('span.heat', { style: { opacity: w > 0 ? (0.12 + 0.88 * w).toFixed(3) : 0 } });
    } else if (w > 0 && range.f) {
      fill = h('span.fill', { style: { height: `${Math.max(6, w * 100).toFixed(1)}%` } },
        range.f[c].map((f, k) => (f > 0 ? h('span.seg', { style: { flexGrow: f, background: colors[k] } }) : null)));
    }
    const cell = h(`button.${cls.join('.')}`, {
      type: 'button', tabindex: c === (fallback >= 0 ? fallback : 0) ? '0' : '-1', 'aria-label': w > 0 ? `${name}, in range ${fmtFreq(w)} of the time` : `${name}, not in range`,
      on: {
        mouseenter: () => show(c),
        mouseleave: rest,
        focus: () => show(c),
        click: () => {
          selected?.classList.remove('sel');
          if (selected === cell) { selected = null; rest(); return; }
          cell.classList.add('sel'); selected = cell; selected.idx = c; show(c);
        },
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
  return h('div.grid-wrap', h('div.gw', readout, h('div.grid-box', grid)));
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
