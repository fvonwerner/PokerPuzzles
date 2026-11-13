// Shared pieces of the friends and profile pages and of the finished view of
// a hand: avatars, the friend relation control, grade marks, "Others on this
// hand" (who else finished it, and what they chose) and "Others here" (who
// chose what at one decision). The server only sends other players' choices
// for a hand once the viewer has finished it; nothing here asks before that.
import { h, toast, gradeBadge, GRADE_ICON, GRADE_LABEL, STREETS } from './ui.js';
import { API } from './api.js';

export const initialOf = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';

/** A round initial: gold for you, neutral for everybody else. */
export function personAvatar(name, { me = false, big = false } = {}) {
  return h(`span.bav.${me ? 'bav-me' : 'bav-n'}${big ? '.bav-big' : ''}`, { 'aria-hidden': 'true' }, initialOf(name));
}

/** The header's request badge listens for this after any change to friends. */
export const friendsChanged = () => window.dispatchEvent(new CustomEvent('pp:friends'));

/** Did they choose differently from you at a decision (both answered)? */
export function differs(c, m) {
  if (!c || !m) return false;
  if (c.timeout || m.timeout) return !!c.timeout !== !!m.timeout;
  return c.optionId !== m.optionId;
}

/** One decision's grade as a small round mark; `diff` rings a decision where they chose differently from you. */
export function gradeMark(grade, { diff = false } = {}) {
  if (!grade) return h('span.gmark.gm-none', { title: 'No decision' }, '–');
  const text = `${GRADE_LABEL[grade] || grade}${diff ? ', a different choice from yours' : ''}`;
  return h(`span.gmark.g-${grade}${diff ? '.diff' : ''}`, { title: text }, GRADE_ICON[grade] || '?');
}

// ---------- friend relation ----------
/**
 * The friend control for one person, by relation: Add friend / Request sent
 * · Cancel / Accept · Decline / Friends (· Remove when `removable`).
 * onChange(relation) after a change (null after an error: reload). `quiet`: no
 * "Request sent" words where the list says so already.
 */
export function relationControl(person, relation, { onChange = () => {}, removable = false, quiet = false } = {}) {
  if (relation === 'you' || !relation) return null;
  const box = h('div.rel', { dataset: { rel: relation } });
  const run = async (fn, said) => {
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const r = await fn();
      toast(said(r));
      friendsChanged();
      onChange(r.relation);
    } catch (e) {
      toast(e.message, 'error');
      friendsChanged();
      onChange(null);
    }
  };
  const btn = (label, cls, fn, said, aria = null) => h(`button.btn.btn-sm${cls}`, { type: 'button', 'aria-label': aria, on: { click: () => run(fn, said) } }, label);
  if (relation === 'none') {
    box.append(btn('Add friend', '.btn-primary', () => API.friendRequest({ id: person.id }),
      (r) => (r.relation === 'friend' ? `You and ${person.name} are friends now.` : `Request sent to ${person.name}.`), `Add ${person.name} as a friend`));
  } else if (relation === 'sent') {
    if (!quiet) box.append(h('span.rel-state', 'Request sent'));
    box.append(btn('Cancel', '.btn-ghost', () => API.friendAction(person.id, 'cancel'), () => 'Request cancelled.', `Cancel your request to ${person.name}`));
  } else if (relation === 'received') {
    box.append(
      btn('Accept', '.btn-primary', () => API.friendAction(person.id, 'accept'), () => `You and ${person.name} are friends now.`, `Accept ${person.name}'s friend request`),
      btn('Decline', '.btn-ghost', () => API.friendAction(person.id, 'decline'), () => 'Request declined.', `Decline ${person.name}'s friend request`));
  } else if (relation === 'friend') {
    box.append(h('span.rel-state.rel-friends', '✓ Friends'));
    if (removable) box.append(removeButton(person, { onRemoved: () => onChange('none') }));
  }
  return box;
}

/** Remove a friend, with a confirm step in place ("Remove Sam?" Remove / Keep). */
export function removeButton(person, { onRemoved }) {
  const wrap = h('span.rel-remove');
  const idle = (focus = false) => {
    const b = h('button.btn.btn-sm.btn-ghost', { type: 'button', 'aria-label': `Remove ${person.name} from your friends`, on: { click: ask } }, 'Remove');
    wrap.replaceChildren(b);
    if (focus) b.focus();
  };
  function ask() {
    const keep = h('button.btn.btn-sm.btn-ghost', { type: 'button', on: { click: () => idle(true) } }, 'Keep');
    const yes = h('button.btn.btn-sm.btn-danger', {
      type: 'button',
      on: {
        click: async () => {
          yes.disabled = true; keep.disabled = true;
          try {
            await API.friendAction(person.id, 'remove');
            toast(`${person.name} is no longer on your friends list.`);
            friendsChanged();
            onRemoved();
          } catch (e) { toast(e.message, 'error'); idle(true); }
        },
      },
    }, 'Remove');
    wrap.replaceChildren(h('span.rel-q', `Remove ${person.name}?`), yes, keep);
    keep.focus();
  }
  idle();
  return wrap;
}

// ---------- what the others did on a hand ----------
const pickText = (c) => (!c ? 'no decision' : c.timeout ? 'ran out of time' : `${c.label}, ${GRADE_LABEL[c.grade] || c.grade}, ${Math.round(c.points)} points`);

/**
 * One player's decisions beside yours: street, their choice (grade, points),
 * yours. The same view in the finished hand and on profiles.
 *   name, choices: theirs; mineOf(i): yours at decision i (null for no second column)
 *   count: the hand's number of decisions; sel / onSelect(i): pick a decision (moves the table there)
 */
export function compareList({ name, choices, mineOf = null, count = null, sel = null, onSelect = null, fkPrefix = 'cmp', theirsLabel = null }) {
  const n = count ?? (choices.length ? Math.max(...choices.map((c) => c.index)) + 1 : 0);
  const two = typeof mineOf === 'function';
  const cell = (c, cls) => (c
    ? h(`span.cmp-pick.${cls}${c.timeout ? '.cmp-to' : ''}`, gradeMark(c.grade), h('span.cmp-label', c.timeout ? 'ran out of time' : c.label), h('b.cmp-pts.num', Math.round(c.points)))
    : h(`span.cmp-pick.${cls}.cmp-none`, '—'));
  const rows = Array.from({ length: n }, (_, i) => {
    const c = choices.find((x) => x.index === i) || null;
    const m = two ? mineOf(i) : null;
    const diff = two && differs(c, m);
    const street = c?.street || m?.street || null;
    const kids = [
      h('span.cmp-street', STREETS[street] || `#${i + 1}`),
      cell(c, 'cmp-them'),
      two ? cell(m, 'cmp-you') : null,
    ];
    const label = `${STREETS[street] || `Decision ${i + 1}`}: ${theirsLabel || name} ${pickText(c)}${two ? `; you ${pickText(m)}` : ''}.${diff ? ' A different choice.' : ''}`;
    const cls = `.cmp-row.${two ? 'c2' : 'c1'}${diff ? '.diff' : ''}${sel === i ? '.on' : ''}`;
    return onSelect
      ? h(`button${cls}`, { type: 'button', 'aria-label': `${label} Show it on the table.`, 'aria-current': sel === i ? 'true' : null, dataset: { fk: `${fkPrefix}:${i}` }, on: { click: () => onSelect(i) } }, kids)
      : h(`div${cls}`, { role: 'listitem', 'aria-label': label }, kids);
  });
  return h('div.cmp',
    h(`div.cmp-cols.${two ? 'c2' : 'c1'}`, { 'aria-hidden': 'true' }, h('span'), h('span.cmp-h-them', theirsLabel || name), two ? h('span.cmp-h-you', 'You') : null),
    h('div.cmp-rows', { role: onSelect ? 'group' : 'list', 'aria-label': `${theirsLabel || name}: decisions${two ? ', beside yours' : ''}` }, rows));
}

const LIST_FIRST = 4; // rows shown before "Show all"

/**
 * "Others on this hand" (finished view): every other player who has finished
 * it, friends first (marked), then the most recent. Name, score and one mark
 * per decision; a ring marks a decision where they chose differently from you.
 * A row opens their decisions beside yours.
 *   st: { loading, error, data, open: player id, all } (kept by the screen across redraws)
 *   mineOf(i): your choice at decision i as this screen shows it
 *   sel, onSelect(i): the selected decision / show decision i on the table
 *   onChange(): redraw (a row opened or closed, "Show all")
 *   exclude: Set of player ids left out (the opponents in a battle's review: they have their own columns)
 */
export function othersBlock(st, { mineOf, sel = null, onSelect = null, onChange, exclude = null }) {
  const head = (sum = null) => h('div.ot-head', h('h3.ot-title', 'Others on this hand'), sum);
  const box = (...kids) => h('section.others-block', { 'aria-label': 'Others on this hand' }, ...kids);
  if (!st || st.loading) return box(head(), h('p.ot-note', 'Loading…'));
  if (st.error) return box(head(), h('p.ot-note', st.error));
  const d = st.data;
  const list = d.others.filter((o) => !exclude?.has(o.player.id));
  const extra = Math.max(0, d.total - d.others.length); // finished it too, beyond the ones listed
  if (!list.length) return box(head(), h('p.ot-note', exclude?.size ? 'Nobody outside this battle has finished this hand yet.' : 'Nobody else has finished this hand yet.'));
  const friends = list.filter((o) => o.friend).length;
  const count = d.decisionCount;
  const shown = st.all || list.length <= LIST_FIRST + 1 ? list : list.slice(0, LIST_FIRST);
  const items = shown.map((o) => {
    const pid = o.player.id;
    const open = st.open === pid;
    const detailId = `ot-d-${pid}`;
    let nDiff = 0;
    const marks = Array.from({ length: count }, (_, i) => {
      const c = o.choices.find((x) => x.index === i);
      const diff = differs(c, mineOf(i));
      if (diff) nDiff++;
      return gradeMark(c?.grade, { diff });
    });
    const label = `${o.player.name}${o.friend ? ', friend' : ''}: ${o.score} points. ${nDiff ? `${nDiff} of ${count} choices different from yours` : 'The same choices as yours'}. ${open ? 'Hide' : 'Show'} their decisions.`;
    return h(`li.ot-item${open ? '.open' : ''}`,
      h('button.ot-row', {
        type: 'button', 'aria-expanded': String(open), 'aria-controls': open ? detailId : null, 'aria-label': label, dataset: { fk: `ot:${pid}` },
        on: { click: () => { st.open = open ? null : pid; onChange(); } },
      },
      h('span.ot-name', { 'aria-hidden': 'true' }, h('span.ot-n', o.player.name), o.friend ? h('span.ot-friend', 'friend') : null),
      h('span.ot-marks', { 'aria-hidden': 'true' }, marks),
      h('b.ot-score.num', { 'aria-hidden': 'true' }, o.score),
      h('span.ot-chev', { 'aria-hidden': 'true' }, open ? '▾' : '▸')),
      open ? h(`div.ot-detail#${detailId}`,
        compareList({ name: o.player.name, choices: o.choices, mineOf, count, sel, onSelect, fkPrefix: `od:${pid}` }),
        h('p.ot-foot',
          o.stale ? h('span.ot-stale', 'Played on an earlier version of this hand: their grades as they were then.') : null,
          h('a', { href: `#/player/${pid}` }, `${o.player.name}'s profile`))) : null);
  });
  return box(
    head(h('span.ot-sum', `${list.length + extra} finished it${friends ? ` · ${friends} friend${friends > 1 ? 's' : ''}` : ''}`)),
    h('ul.ot-list', items),
    shown.length < list.length
      ? h('button.btn.btn-ghost.btn-sm.ot-all', { type: 'button', dataset: { fk: 'ot:all' }, on: { click: () => { st.all = true; onChange(); } } }, `Show all ${list.length}`)
      : null,
    extra && shown.length === list.length ? h('p.ot-note', `${extra} more finished it; the ${list.length} shown are friends and the most recent.`) : null,
    h('p.ot-key', h('span.gmark.gm-none.diff', { 'aria-hidden': 'true' }), ' a ring: a different choice from yours'));
}

/** "Others here" for one decision: who chose what (one line per choice, the most chosen first). */
export function othersHere(st, index, { exclude = null } = {}) {
  const d = st?.data;
  if (!d) return null;
  const groups = new Map();
  for (const o of d.others) {
    if (exclude?.has(o.player.id)) continue;
    const c = o.choices.find((x) => x.index === index);
    if (!c) continue;
    const key = `${c.timeout ? '' : c.optionId}|${c.grade}`; // a play of an older version of the hand may grade the same choice differently
    const g = groups.get(key) || { label: c.timeout ? 'ran out of time' : c.label, grade: c.grade, points: c.points, names: [] };
    g.names.push(o.player.name);
    groups.set(key, g);
  }
  if (!groups.size) return null;
  const who = (ns) => (ns.length <= 4 ? ns.join(', ') : `${ns.slice(0, 3).join(', ')} and ${ns.length - 3} more`);
  const lines = [...groups.values()].sort((a, b) => b.names.length - a.names.length || b.points - a.points);
  return h('div.others-here', { role: 'group', 'aria-label': 'What the others chose here' },
    h('p.oh-k', 'Others here'),
    lines.map((g) => h('p.oh-line', h('b.oh-who', who(g.names)), h('span.oh-what', `: ${g.label} · `), gradeBadge(g.grade, { small: true }))));
}
