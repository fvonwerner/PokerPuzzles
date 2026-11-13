// The Friends page (#/friends): requests for you (Accept / Decline), your
// friends (hands, average, last active, Remove), requests you sent (Cancel),
// finding people by name, and the people you have battled.
import { h, clear, toast, agoText } from './ui.js';
import { API } from './api.js';
import { personAvatar, relationControl, removeButton } from './social.js';

// The control beside each result already says "You", "Friends" or "Request sent"; only this needs words.
const REL_WORDS = { received: 'wants to be your friend' };

export function friendsScreen(root, { player }) {
  let data = null, destroyed = false;
  let q = '', results = null, searchErr = '', searchSeq = 0, searchTimer = null;
  // The person whose control was used last: after the redraws that follow (the lists and the search
  // results are drawn again, perhaps twice), focus goes back to their row instead of the page.
  let lastPid = null, lastPidAt = 0;
  const el = h('section.social-page.friends');
  clear(root).append(el);
  el.addEventListener('click', (e) => {
    const pid = e.target.closest?.('[data-pid]')?.dataset.pid;
    if (pid) { lastPid = pid; lastPidAt = Date.now(); }
  }, true);
  /** After a redraw: keep the search box focused, or put focus back on the row that was acted on. */
  function restoreFocus(wasInput) {
    if (wasInput) { if (document.activeElement !== input) input.focus({ preventScroll: true }); return; }
    const a = document.activeElement;
    if (!lastPid || Date.now() - lastPidAt > 4000 || (a && a !== document.body && el.contains(a))) return;
    // their name (not a button there: a stray Enter must not undo what was just done)
    const target = [...el.querySelectorAll(`[data-pid="${lastPid}"]`)].map((r) => r.querySelector('a[href]') || r.querySelector('button:not([disabled])')).find(Boolean);
    (target || el.querySelector('h1'))?.focus({ preventScroll: true });
  }

  // The search box lives outside render() so typing never loses focus.
  const input = h('input.fr-input#fr-q', {
    type: 'search', name: 'q', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '20',
    placeholder: 'Name', 'aria-describedby': 'fr-q-hint',
    on: { input: () => { q = input.value; clearTimeout(searchTimer); searchTimer = setTimeout(search, 250); } },
  });
  const resultsBox = h('div.fr-results', { 'aria-live': 'polite' });
  const searchForm = h('form.fr-search', { role: 'search', on: { submit: (e) => { e.preventDefault(); clearTimeout(searchTimer); search(); } } },
    h('label.fr-label', { for: 'fr-q' }, 'Find a player by name'),
    h('div.fr-search-row', input, h('button.btn', { type: 'submit' }, 'Search')),
    h('p.fr-hint#fr-q-hint', 'The first letters are enough (at least 2).'));

  async function search() {
    const term = q.trim();
    const my = ++searchSeq;
    if (term.length < 2) { results = null; searchErr = ''; paintResults(); return; }
    try {
      const r = await API.searchPlayers(term);
      if (destroyed || my !== searchSeq) return;
      results = r.players; searchErr = '';
    } catch (e) {
      if (destroyed || my !== searchSeq) return;
      results = null; searchErr = e.message;
    }
    paintResults();
  }
  function paintResults() {
    if (searchErr) { clear(resultsBox).append(h('p.form-error', searchErr)); return; }
    if (!results) { clear(resultsBox); return; }
    if (!results.length) { clear(resultsBox).append(h('p.muted.fr-empty', `Nobody's name starts with "${q.trim()}".`)); return; }
    clear(resultsBox).append(h('ul.fr-list', results.map((p) => personRow(p, {
      sub: REL_WORDS[p.relation] || null,
      action: p.relation === 'you' ? h('span.you', 'You') : relationControl(p, p.relation, { onChange: () => { search(); load(); } }),
    }))));
    restoreFocus(false);
  }

  /** A person in a list: avatar, name (to the profile), a line under it, the controls. */
  function personRow(p, { sub = null, action = null } = {}) {
    return h('li.fr-row', { dataset: { pid: p.id } },
      personAvatar(p.name, { me: p.id === player.id }),
      h('div.fr-main',
        h('a.fr-name', { href: `#/player/${p.id}` }, p.name),
        sub ? h('p.fr-sub', sub) : null),
      action ? h('div.fr-act', action) : null);
  }

  function friendsTable(list) {
    if (!list.length) {
      return h('p.muted.fr-empty', 'No friends yet. Find people by name, or add someone you have battled. Friends come first under "Others on this hand" and have their own leaderboard.');
    }
    return h('table.fr-table',
      h('caption.sr-only', 'Your friends'),
      h('thead', h('tr',
        h('th', { scope: 'col' }, 'Player'),
        h('th.num', { scope: 'col' }, 'Hands'),
        h('th.num', { scope: 'col' }, 'Average'),
        h('th', { scope: 'col' }, 'Last active'),
        h('th.fr-th-act', { scope: 'col' }, h('span.sr-only', 'Remove')))),
      h('tbody', list.map((f) => h('tr', { dataset: { pid: f.id } },
        h('th', { scope: 'row' }, h('span.fr-who', personAvatar(f.name), h('a.fr-name', { href: `#/player/${f.id}` }, f.name))),
        h('td.num', { dataset: { label: 'Hands' } }, f.played),
        h('td.num.strong', { dataset: { label: 'Average' } }, f.average ?? '–'),
        h('td.fr-ago', { dataset: { label: 'Last active' } }, agoText(f.lastActive)),
        h('td.fr-td-act', removeButton(f, { onRemoved: load }))))));
  }

  function render() {
    if (!data) return;
    const { friends, incoming, outgoing, battled } = data;
    const wasInput = document.activeElement === input;
    clear(el).append(
      h('div.page-head',
        h('div', h('h1', { tabindex: '-1' }, 'Friends'), h('p.muted', 'Your friends come first when you look at what the others did on a hand, and get their own leaderboard.')),
        h('a.btn.btn-ghost', { href: `#/player/${player.id}` }, 'Your profile')),
      h('div.fr-grid',
        h('div.fr-col',
          incoming.length ? h('section.panel.fr-incoming', { 'aria-labelledby': 'fr-in' },
            h('h2#fr-in', 'Requests for you', h('span.count-pill', incoming.length)),
            h('ul.fr-list', incoming.map((p) => personRow(p, {
              sub: `wants to be your friend · ${agoText(p.at)}`,
              action: relationControl(p, 'received', { onChange: load }),
            })))) : null,
          h('section.panel', { 'aria-labelledby': 'fr-mine' },
            h('h2#fr-mine', 'Your friends', friends.length ? h('span.count-pill.muted-pill', friends.length) : null),
            friendsTable(friends)),
          outgoing.length ? h('section.panel', { 'aria-labelledby': 'fr-out' },
            h('h2#fr-out', 'Requests you sent'),
            h('ul.fr-list', outgoing.map((p) => personRow(p, {
              sub: `sent ${agoText(p.at)} · waiting for an answer`,
              action: relationControl(p, 'sent', { onChange: load, quiet: true }),
            })))) : null),
        h('aside.fr-col',
          h('section.panel', { 'aria-labelledby': 'fr-add' }, h('h2#fr-add', 'Add a friend'), searchForm, resultsBox),
          h('section.panel', { 'aria-labelledby': 'fr-met' },
            h('h2#fr-met', 'People you have battled'),
            battled.length
              ? h('ul.fr-list', battled.map((p) => personRow(p, {
                sub: `${p.battles} battle${p.battles === 1 ? '' : 's'} · ${agoText(p.lastAt)}${p.relation === 'sent' ? ' · request sent' : p.relation === 'received' ? ' · wants to be your friend' : ''}`,
                action: relationControl(p, p.relation, { onChange: load }),
              })))
              : h('p.muted.fr-empty', 'Players you battle show up here, so you can add them.')))));
    paintResults();
    restoreFocus(wasInput);
  }

  async function load() {
    try {
      const next = await API.friends();
      if (destroyed) return;
      data = next;
      render();
    } catch (e) {
      if (destroyed) return;
      if (!data) clear(el).append(h('div.error-box', h('p', e.message), h('button.btn', { type: 'button', on: { click: load } }, 'Try again')));
      else toast(e.message, 'error');
    }
  }
  el.append(h('p.muted.pad', 'Loading…'));
  load();
  return { destroy() { destroyed = true; clearTimeout(searchTimer); } };
}
