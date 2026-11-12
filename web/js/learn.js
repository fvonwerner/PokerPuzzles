// Learn section: renders web/learn/content.json (contract: docs/LEARN.md),
// falling back to web/learn/sample.json. Also links poker terms in the play
// screen's texts to small pop-ups and a Learn overlay that keeps the hand.
//
// Content is data: every node is built with h(); nothing from the file is
// ever parsed as HTML. Unknown block types are skipped.
import { h, clear } from './ui.js';
import { cardEl, actionColors } from './poker.js';
import { rangeGrid, freqBar } from './grid.js';
import { session } from './api.js';

// ---------- content ----------
let contentPromise = null;
const ID_RE = /^[a-z0-9-]+$/;

function normalise(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.topics)) return null;
  const topics = raw.topics.filter((t) => t && typeof t.id === 'string' && ID_RE.test(t.id) && typeof t.title === 'string');
  if (!topics.length) return null;
  const byId = new Map(topics.map((t) => [t.id, t]));
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).filter((g) => g && g.id && g.title);
  // topics whose group is missing still show, under "More"
  const known = new Set(groups.map((g) => g.id));
  if (topics.some((t) => !known.has(t.group))) groups.push({ id: '__more', title: 'More' });
  const paths = (Array.isArray(raw.paths) ? raw.paths : [])
    .map((p) => ({ ...p, topics: (Array.isArray(p.topics) ? p.topics : []).filter((id) => byId.has(id)) }))
    .filter((p) => p.id && p.title && p.topics.length);
  // alias -> topic id, longest first, for linking terms in texts
  const aliasMap = new Map();
  for (const t of topics) for (const a of Array.isArray(t.aliases) ? t.aliases : []) {
    const k = String(a).trim().toLowerCase();
    if (k.length >= 3 && !aliasMap.has(k)) aliasMap.set(k, t.id);
  }
  const aliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aliasRe = aliases.length ? new RegExp(`(?<![\\p{L}\\p{N}-])(${aliases.map(esc).join('|')})(?![\\p{L}\\p{N}-])`, 'giu') : null;
  return { groups, paths, topics, byId, aliasMap, aliasRe, groupOf: (t) => (known.has(t.group) ? t.group : '__more') };
}

/** Loads content.json, falling back to sample.json when it is missing or invalid. */
export function loadContent() {
  if (!contentPromise) {
    contentPromise = (async () => {
      for (const url of ['learn/content.json', 'learn/sample.json']) {
        try {
          const r = await fetch(url, { cache: 'no-cache' });
          if (!r.ok) continue;
          const c = normalise(await r.json());
          if (c) { c.source = url; return c; }
        } catch { /* try the next one */ }
      }
      return normalise({ topics: [{ id: 'none', title: 'No lessons yet', simple: [{ type: 'p', text: 'The lessons have not been published yet.' }] }] });
    })();
  }
  return contentPromise;
}

// ---------- progress (per player, localStorage) ----------
function progressKey() { return `pokerpuzzles.learn.${session()?.player?.id || 'guest'}`; }
function loadProgress() {
  try { return { read: {}, quiz: {}, open: {}, ...JSON.parse(localStorage.getItem(progressKey()) || '{}') }; } catch { return { read: {}, quiz: {}, open: {} }; }
}
function saveProgress(p) { try { localStorage.setItem(progressKey(), JSON.stringify(p)); } catch { /* storage blocked */ } }
function updateProgress(fn) { const p = loadProgress(); fn(p); saveProgress(p); return p; }

// ---------- inline marks: **bold**, [[id|text]], {Ah} ----------
const INLINE_RE = /\*\*(.+?)\*\*|\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]|\{([AKQJT2-9][shdc])\}/g;
function inline(text, ctx, depth = 0) {
  const out = [];
  const s = String(text ?? '');
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1] !== undefined) out.push(h('strong', depth < 2 ? inline(m[1], ctx, depth + 1) : m[1]));
    else if (m[2] !== undefined) out.push(ctx.link(m[2], m[3] || ctx.content.byId.get(m[2])?.title || m[2]));
    else if (m[4] !== undefined) out.push(cardChip(m[4]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
function cardChip(c) {
  return h(`span.ctext.suit-${c[1]}`, { role: 'img', 'aria-label': c }, (c[0] === 'T' ? '10' : c[0]) + SUIT_SYM[c[1]]);
}

// ---------- blocks ----------
const validCards = (a) => (Array.isArray(a) ? a.filter((c) => typeof c === 'string' && /^[AKQJT2-9][shdc]$/.test(c)) : []);

function block(b, ctx) {
  if (!b || typeof b !== 'object') return null;
  switch (b.type) {
    case 'p': return h('p.lp', inline(b.text, ctx));
    case 'h': return h('h4.lh', inline(b.text, ctx));
    case 'list': {
      const items = (Array.isArray(b.items) ? b.items : []).map((t) => h('li', inline(t, ctx)));
      return b.ordered ? h('ol.llist', items) : h('ul.llist', items);
    }
    case 'tip': return h('div.callout.callout-tip', h('span.callout-k', 'Rule of thumb'), h('p', inline(b.text, ctx)));
    case 'warn': return h('div.callout.callout-warn', h('span.callout-k', 'Common mistake'), h('p', inline(b.text, ctx)));
    case 'hand': {
      const row = (label, cards, size) => (cards.length ? h('div.lhand-row', h('span.lhand-k', label), h('div.lhand-cards', cards.map((c) => cardEl(c, { size })))) : null);
      return h('figure.lhand',
        b.title ? h('figcaption.lfig-title', inline(b.title, ctx)) : null,
        h('div.lhand-felt',
          row('You', validCards(b.hero), 'md'),
          row('Board', validCards(b.board), 'md'),
          row('Villain', validCards(b.villain), 'md')),
        b.caption ? h('figcaption.lcap', inline(b.caption, ctx)) : null);
    }
    case 'calc': {
      const steps = Array.isArray(b.steps) ? b.steps : [];
      return h('div.lcalc',
        b.title ? h('p.lfig-title', inline(b.title, ctx)) : null,
        h('ol.lcalc-steps', steps.map((s) => h('li', h('span.lcalc-label', inline(s?.label, ctx)), h('span.lcalc-value', inline(s?.value, ctx))))),
        b.result ? h('p.lcalc-result', h('span.lcalc-eq', { 'aria-hidden': 'true' }, '='), h('span', inline(b.result, ctx))) : null);
    }
    case 'table': {
      const head = Array.isArray(b.head) ? b.head : [];
      const rows = Array.isArray(b.rows) ? b.rows : [];
      return h('figure.ltable',
        h('div.ltable-scroll', h('table',
          head.length ? h('thead', h('tr', head.map((t) => h('th', { scope: 'col' }, inline(t, ctx))))) : null,
          h('tbody', rows.map((r) => h('tr', (Array.isArray(r) ? r : []).map((t) => h('td', inline(t, ctx)))))))),
        b.caption ? h('figcaption.lcap', inline(b.caption, ctx)) : null);
    }
    case 'range': return rangeBlock(b, ctx);
    case 'quiz': return quiz(b, ctx, ctx.quizKey());
    default: return null; // unknown block types are skipped
  }
}

function rangeBlock(b, ctx) {
  const r = b.range;
  if (!r || !Array.isArray(r.w) || r.w.length !== 169) return null;
  const options = (Array.isArray(b.options) ? b.options : []).filter((o) => o && o.id);
  const single = options.length <= 1;
  const f = Array.isArray(r.f) && r.f.length === 169 ? r.f.map((row) => (Array.isArray(row) ? row.map(Number) : options.map(() => 0))) : null;
  const range = { w: r.w.map((x) => Number(x) || 0), f };
  const colors = actionColors(options.map((o) => ({ ...o, amount: o.amount || 0 })));
  const parts = [];
  if (!single && f) {
    // overall frequencies, weighted by combos
    const tot = options.map(() => 0); let all = 0;
    range.w.forEach((w, c) => {
      const i = Math.floor(c / 13), j = c % 13; const n = (i === j ? 6 : i < j ? 4 : 12) * w;
      all += n; options.forEach((_, k) => { tot[k] += n * (f[c][k] || 0); });
    });
    parts.push(freqBar(tot.map((x) => (all ? x / all : 0)), options, colors, { title: b.title || 'Range' }));
  }
  parts.push(h('div.lrange-grid', rangeGrid({
    range, options: single ? null : options, colors, heat: single || !f, highlight: typeof b.highlight === 'string' ? b.highlight : null, caption: b.title || 'Range grid',
  })));
  return h('figure.lrange',
    b.title ? h('figcaption.lfig-title', inline(b.title, ctx)) : null,
    ...parts,
    b.caption ? h('figcaption.lcap', inline(b.caption, ctx)) : null);
}

function quiz(b, ctx, key) {
  const opts = Array.isArray(b.options) ? b.options : [];
  if (!b.q || opts.length < 2 || typeof b.answer !== 'number') return null;
  const why = h('div.quiz-why', { hidden: true, 'aria-live': 'polite' });
  const buttons = opts.map((t, i) => h('button.quiz-opt', {
    type: 'button',
    on: {
      click: () => {
        if (wrap.dataset.done === 'right') return;
        const right = i === b.answer;
        buttons.forEach((x) => x.classList.remove('right', 'wrong'));
        buttons[i].classList.add(right ? 'right' : 'wrong');
        why.hidden = false;
        why.replaceChildren(
          h('p.quiz-verdict', right ? '✓ Right.' : '✕ Not quite.'),
          b.why ? h('p', inline(b.why, ctx)) : null,
          right ? null : h('button.btn.btn-sm.quiz-retry', { type: 'button', on: { click: () => { why.hidden = true; buttons.forEach((x) => { x.classList.remove('right', 'wrong'); x.disabled = false; }); delete wrap.dataset.done; buttons[0].focus(); } } }, 'Try again'));
        if (right) {
          wrap.dataset.done = 'right';
          buttons.forEach((x, k) => { if (k !== i) x.disabled = true; });
          updateProgress((p) => { p.quiz[key] = true; });
          ctx.onProgress?.();
        } else {
          wrap.dataset.done = 'wrong';
          buttons.forEach((x, k) => { if (k !== i) x.disabled = true; });
        }
      },
    },
  }, h('span.quiz-letter', String.fromCharCode(65 + i)), h('span', inline(t, ctx))));
  const wrap = h('div.quiz', h('p.quiz-q', inline(b.q, ctx)), h('div.quiz-opts', buttons), why);
  if (loadProgress().quiz[key]) wrap.append(h('p.quiz-done.small', 'You answered this one correctly before.'));
  return wrap;
}

function blocks(list, ctx) { return (Array.isArray(list) ? list : []).map((b) => block(b, ctx)).filter(Boolean); }

// ---------- topic view ----------
function pathFor(content, id) { return content.paths.find((p) => p.topics.includes(id)) || null; }
function orderFor(content, id) {
  const p = pathFor(content, id);
  if (p) return { list: p.topics, title: p.title };
  const t = content.byId.get(id);
  return { list: content.topics.filter((x) => content.groupOf(x) === content.groupOf(t)).map((x) => x.id), title: null };
}

/**
 * Topic article. opts: { link(id, text) -> node, go(id), onProgress }
 */
export function topicView(content, id, opts) {
  const t = content.byId.get(id);
  if (!t) return h('div.learn-empty', h('p', 'This topic does not exist (yet).'));
  updateProgress((p) => { p.read[id] = true; });
  let qn = 0;
  const ctx = { content, link: opts.link, onProgress: opts.onProgress, quizKey: () => `${id}:${qn++}` };
  const prog = loadProgress();
  const group = content.groups.find((g) => g.id === content.groupOf(t));
  const section = (key, title, list, { collapsible = true } = {}) => {
    const body = blocks(list, ctx);
    if (!body.length) return null;
    if (!collapsible) return h(`section.lsec.lsec-${key}`, h('h2.lsec-title', title), body);
    const det = h(`details.lsec.lsec-${key}`, {
      open: !!prog.open[`${id}:${key}`],
      on: { toggle: () => updateProgress((p) => { if (det.open) p.open[`${id}:${key}`] = true; else delete p.open[`${id}:${key}`]; }) },
    }, h('summary.lsec-title', title, h('span.lsec-count', `${body.length} part${body.length > 1 ? 's' : ''}`)), h('div.lsec-body', body));
    return det;
  };
  const { list: order, title: orderTitle } = orderFor(content, id);
  const k = order.indexOf(id);
  const prev = k > 0 ? content.byId.get(order[k - 1]) : null;
  const next = k >= 0 && k < order.length - 1 ? content.byId.get(order[k + 1]) : null;
  const related = (Array.isArray(t.related) ? t.related : []).filter((r) => content.byId.has(r));
  const checks = blocks((Array.isArray(t.check) ? t.check : []).map((q) => ({ ...q, type: 'quiz' })), ctx);

  return h('article.topic', { 'aria-labelledby': `topic-${id}` },
    h('header.topic-head',
      group && group.id !== '__more' ? h('p.topic-crumb', group.title) : null,
      h('h1', { id: `topic-${id}` }, t.title),
      t.short ? h('p.topic-short', inline(t.short, ctx)) : null),
    section('simple', 'In simple terms', t.simple, { collapsible: false }),
    section('deeper', 'A closer look', t.deeper),
    section('examples', 'Worked examples', t.examples),
    checks.length ? h('section.lsec.lsec-check', h('h2.lsec-title', 'Check yourself'), h('p.small.muted', 'Pick an answer to see the explanation. No score, try as often as you like.'), checks) : null,
    related.length ? h('section.lrelated', h('h2.lsec-title', 'Related'), h('div.lchips', related.map((r) => opts.link(r, content.byId.get(r).title, 'lchip')))) : null,
    (prev || next) ? h('nav.lnav', { 'aria-label': orderTitle ? `${orderTitle}: previous and next` : 'Previous and next' },
      prev ? h('button.btn.lnav-prev', { type: 'button', on: { click: () => opts.go(prev.id) } }, '← ', prev.title) : h('span'),
      next ? h('button.btn.btn-primary.lnav-next', { type: 'button', on: { click: () => opts.go(next.id) } }, next.title, ' →') : h('span')) : null);
}

// ---------- the Learn screen ----------
export function learnScreen(root, { topicId = null } = {}) {
  const el = h('section.learn');
  clear(root).append(el);
  let content = null, filter = '';
  const listPane = h('aside.learn-list', { 'aria-label': 'Topics' });
  const topicPane = h('div.learn-topic', { tabindex: '-1' });
  el.append(listPane, topicPane);
  el.classList.toggle('has-topic', !!topicId);

  const link = (id, text, cls = 'llink') => h(`a.${cls}`, { href: `#/learn/${id}` }, text);
  const go = (id) => { location.hash = `#/learn/${id}`; };

  function renderList() {
    const prog = loadProgress();
    const read = content.topics.filter((t) => prog.read[t.id]).length;
    const q = filter.trim().toLowerCase();
    const match = (t) => !q || [t.title, t.short, ...(t.aliases || [])].some((s) => String(s || '').toLowerCase().includes(q));
    const item = (t, n) => h('li', h(`a.ltopic${t.id === topicId ? '.on' : ''}`, { href: `#/learn/${t.id}`, 'aria-current': t.id === topicId ? 'page' : null },
      n ? h('span.ltopic-n', n) : null,
      h('span.ltopic-title', t.title),
      prog.read[t.id] ? h('span.ltick', { title: 'Read', 'aria-label': 'read' }, '✓') : null));
    const search = h('input.learn-search', { type: 'search', placeholder: 'Search topics', value: filter, 'aria-label': 'Search topics', on: { input: (e) => { filter = e.target.value; renderList(); const s = listPane.querySelector('.learn-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } } });
    const path = content.paths[0];
    const groups = content.groups.map((g) => {
      const ts = content.topics.filter((t) => content.groupOf(t) === g.id && match(t));
      return ts.length ? h('div.lgroup', h('h3.lgroup-title', g.title), h('ul.ltopics', ts.map((t) => item(t)))) : null;
    }).filter(Boolean);
    clear(listPane).append(
      h('div.learn-list-head', h('h1', 'Learn'), h('p.learn-progress.small', h('b.num', read), ` of ${content.topics.length} read`)),
      search,
      h('div.learn-list-scroll',
        path && !q ? h('div.lgroup.lpath', h('h3.lgroup-title', path.title), h('ol.ltopics', path.topics.map((id, i) => item(content.byId.get(id), i + 1)))) : null,
        groups.length ? groups : h('p.muted.small.pad', 'No topic matches.')));
  }

  function renderTopic() {
    if (!topicId) {
      const path = content.paths[0];
      clear(topicPane).append(h('div.learn-welcome',
        h('h1', 'Poker ideas, explained simply'),
        h('p', 'Each topic starts with the idea in everyday words. Open "A closer look" for the maths and "Worked examples" for real hands, then check yourself with a few questions.'),
        path ? h('button.btn.btn-primary', { type: 'button', on: { click: () => go(path.topics[0]) } }, `Start with ${content.byId.get(path.topics[0]).title}`) : null));
      return;
    }
    clear(topicPane).append(
      h('a.learn-back', { href: '#/learn' }, '← All topics'),
      topicView(content, topicId, { link, go, onProgress: renderList }));
    topicPane.scrollTop = 0;
    document.title = `${content.byId.get(topicId)?.title || 'Learn'} · PokerPuzzles`;
  }

  el.append(h('p.muted.pad', 'Loading…'));
  loadContent().then((c) => {
    content = c;
    el.querySelector(':scope > p')?.remove();
    renderTopic();
    renderList();
    if (topicId) topicPane.focus({ preventScroll: true });
  });
  return { destroy() {} };
}

// ---------- terms in play-screen texts ----------
/** Text -> nodes with alias words turned into term buttons (first occurrence per topic). */
export function linkTerms(text, content) {
  const s = String(text ?? '');
  if (!content?.aliasRe) return [s];
  const out = []; const used = new Set(); let last = 0;
  for (const m of s.matchAll(content.aliasRe)) {
    const id = content.aliasMap.get(m[1].toLowerCase());
    if (!id || used.has(id)) continue;
    used.add(id);
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(termButton(m[1], id, content));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
/** Fill `el` with `text`, then link its terms once the content has loaded. */
export function setLinkedText(el, text) {
  el.textContent = text;
  loadContent().then((c) => { el.replaceChildren(...linkTerms(text, c)); });
  return el;
}

/** Tag chips; a tag that names a topic becomes a term link. */
export function tagChips(el, tags) {
  const plain = () => tags.map((t) => h('span.tag', t));
  el.replaceChildren(...plain());
  loadContent().then((c) => {
    el.replaceChildren(...tags.map((t) => {
      const id = c.aliasMap.get(String(t).toLowerCase());
      return id ? h('span.tag', termButton(t, id, c)) : h('span.tag', t);
    }));
  });
  return el;
}

function termButton(label, id, content) {
  return h('button.term', { type: 'button', 'aria-haspopup': 'dialog', on: { click: (e) => openPopover(e.currentTarget, id, content) } }, label);
}

let popover = null;
function closePopover() {
  if (!popover) return;
  const { el, anchor, off } = popover;
  popover = null;
  el.remove(); off();
  anchor?.focus?.({ preventScroll: true });
}
function openPopover(anchor, id, content) {
  closePopover();
  const t = content.byId.get(id);
  if (!t) return;
  const el = h('div.term-pop', { role: 'dialog', 'aria-label': t.title },
    h('p.term-pop-title', t.title),
    h('p.term-pop-short', t.short || ''),
    h('div.term-pop-actions',
      h('button.btn.btn-sm.btn-primary', { type: 'button', on: { click: () => { closePopover(); openLearnOverlay(id); } } }, 'Read more'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', on: { click: closePopover } }, 'Close')));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 8 + hgt < window.innerHeight;
  el.style.left = `${left}px`;
  el.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - hgt - 8)}px`;
  const onDown = (e) => { if (!el.contains(e.target) && e.target !== anchor) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closePopover(); } };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  popover = { el, anchor, off: () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); } };
  el.querySelector('.btn-primary').focus({ preventScroll: true });
}

/** Learn topic in an overlay on top of the current screen (the hand stays as it is). */
export async function openLearnOverlay(id) {
  const content = await loadContent();
  const prevFocus = document.activeElement;
  const body = h('div.lover-body');
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); prevFocus?.focus?.({ preventScroll: true }); };
  const show = (tid) => {
    const link = (lid, text, cls = 'llink') => h(`button.${cls}.as-link`, { type: 'button', on: { click: () => show(lid) } }, text);
    body.replaceChildren(topicView(content, tid, { link, go: show }));
    body.scrollTop = 0;
  };
  const overlay = h('div.lover', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Learn' , on: { pointerdown: (e) => { if (e.target === overlay) close(); } } },
    h('div.lover-panel',
      h('div.lover-bar', h('span.lover-k', 'Learn'), h('a.btn.btn-sm.btn-ghost', { href: `#/learn/${id}`, title: 'Leaves the hand; your scored progress is saved' }, 'Open in Learn'), h('button.btn.btn-sm', { type: 'button', on: { click: close } }, 'Back to the hand', h('kbd', 'Esc'))),
      body));
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  show(id);
  overlay.querySelector('.lover-bar .btn:last-child').focus({ preventScroll: true });
}
