// Small DOM and formatting helpers.

/** h('div.a.b#id', {attrs, on: {click}}, ...children) */
export function h(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs !== undefined && attrs !== null) children.unshift(attrs);
    attrs = {};
  }
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}
export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export const fmtBb = (x) => {
  if (x === null || x === undefined || Number.isNaN(x)) return '–';
  const r = Math.round(x * 100) / 100;
  return String(r);
};
export const fmtPct = (x, digits = 0) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(digits)}%`);
/** A strategy frequency or range weight as a whole percent; never "0%" for a
 * played option or "100%" for a mixed one ("<1%", ">99%"). Not for EV or equity. */
export const fmtFreq = (x) => {
  if (x === null || x === undefined || Number.isNaN(x)) return '–';
  const p = Math.round(x * 100);
  if (p === 0 && x > 1e-9) return '<1%';
  if (p === 100 && x < 1 - 1e-9) return '>99%';
  return `${p}%`;
};
export const fmtSigned = (x) => (x > 0 ? `+${fmtBb(x)}` : fmtBb(x));
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const STREETS = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isPhone = () => window.matchMedia('(max-width: 767px)').matches;

let toastTimer;
export function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

export const GRADE_LABEL = { best: 'Best', correct: 'Correct', inaccuracy: 'Inaccuracy', wrong: 'Wrong', blunder: 'Blunder', timeout: "Time's up" };
export const GRADE_SHORT = { best: 'B', correct: 'C', inaccuracy: 'I', wrong: 'W', blunder: 'X', timeout: 'T' };
export const GRADE_ICON = { best: '★', correct: '✓', inaccuracy: '~', wrong: '✗', blunder: '‼', timeout: '⏱' }; // timeout: a battle decision that ran out of time

export function gradeBadge(grade, { small = false } = {}) {
  return h(`span.grade.grade-${grade}${small ? '.grade-sm' : ''}`, h('span.grade-ico', { 'aria-hidden': 'true' }, GRADE_ICON[grade]), GRADE_LABEL[grade]);
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
