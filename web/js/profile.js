// A player's profile (#/player/<id>): name, member since, ranks, the friend
// control; statistics (hands, average, total, the answers by grade, points
// per decision by street, battles); and every hand they have finished, newest
// first. A hand you have finished too opens to their decisions beside yours;
// one you have not shows only their score and date, and offers to play it.
import { h, clear, toast, fmtDate, STREETS, GRADE_LABEL } from './ui.js';
import { API } from './api.js';
import { personAvatar, relationControl, gradeMark, compareList, differs } from './social.js';

const GRADES = ['best', 'correct', 'inaccuracy', 'wrong', 'blunder'];

export function profileScreen(root, { id, me, onSignOut }) {
  let data = null, hands = [], next = null, destroyed = false, loadingMore = false;
  const open = new Set();
  const el = h('section.social-page.profile');
  clear(root).append(el);

  function rankBlock(r) {
    const items = [];
    const one = (x, label) => h('div.pf-rank',
      h('b.pf-rank-n.num', `#${x.rank}`),
      h('span.pf-rank-of', `of ${x.of}`),
      h('span.pf-rank-k', label));
    if (r.everyone.rank !== null) items.push(one(r.everyone, 'Everyone'));
    else {
      items.push(h('div.pf-rank.pf-unranked',
        h('b.pf-rank-n', 'Not ranked yet'),
        h('span.pf-rank-k', `Ranked from ${r.minHands} hands · ${r.played} so far`)));
    }
    // Among you and your friends: when more than one of you is ranked (else "#1 of 1" says nothing).
    if (r.friends && r.friends.rank !== null && r.friends.of > 1) items.push(one(r.friends, 'You and your friends'));
    return h('div.pf-ranks', items);
  }

  function statsPanel(s, name, minHands) {
    const tiles = h('div.pf-tiles',
      h('div.pf-tile', h('b.num', s.played), h('span', 'hands played')),
      h('div.pf-tile', h('b.num', s.average ?? '–'), h('span', 'average score')),
      h('div.pf-tile', h('b.num', s.totalPoints), h('span', 'total points')),
      h('div.pf-tile', h('b.num', s.battles.played), h('span', `battle${s.battles.played === 1 ? '' : 's'}, ${s.battles.won} won`)));
    if (!s.detail) {
      // Below the minimum the server sends no split at all: over so few hands it would describe a hand you have not played.
      return h('section.panel.pf-stats', { 'aria-labelledby': 'pf-st' }, h('h2#pf-st', 'Statistics'), tiles,
        h('p.pf-note', `${name}'s answers by grade and the points by street: shown from ${minHands} hands.`));
    }
    // Your own profile has the exact counts; anybody else's only the shares in % (they add up to 100)
    // and the street averages: counts would tell how many decisions a hand you have not played has.
    const own = !!s.grades;
    const shares = s.shares || {};
    const gradeKeys = GRADES.concat(shares.timeout || s.grades?.timeout ? ['timeout'] : []);
    const gradeName = (g) => (g === 'timeout' ? 'Ran out of time' : GRADE_LABEL[g]);
    const total = own ? gradeKeys.reduce((a, g) => a + (s.grades[g] || 0), 0) : null;
    return h('section.panel.pf-stats', { 'aria-labelledby': 'pf-st' },
      h('h2#pf-st', 'Statistics'),
      tiles,
      h('div.pf-block',
        h('h3.pf-h3', 'Answers', h('span.pf-h3-note', own ? `${total} decision${total === 1 ? '' : 's'}` : 'share of all answers')),
        s.shares
          ? [
            h('div.pf-gbar', { role: 'img', 'aria-label': gradeKeys.map((g) => `${gradeName(g)} ${shares[g] || 0}%`).join(', ') },
              gradeKeys.map((g) => (shares[g] ? h(`span.pf-gseg.g-${g}`, { style: { flex: String(shares[g]) } }) : null))),
            h(`ul.pf-glegend${own ? '' : '.pf-shares'}`, gradeKeys.map((g) => h('li',
              gradeMark(g), h('span.pf-gname', gradeName(g)),
              own ? h('b.num', s.grades[g] || 0) : null,
              h(`${own ? 'span' : 'b'}.pf-gpct.num`, `${shares[g] || 0}%`)))),
          ]
          : h('p.muted.small', 'No finished hands yet.')),
      h('div.pf-block',
        h('h3.pf-h3', 'Points per decision, by street'),
        h('ul.pf-streets', Object.keys(STREETS).map((k) => {
          const st = s.streets[k] || { average: null };
          return h('li.pf-street',
            h('span.ps-name', STREETS[k]),
            h('span.ps-bar', { 'aria-hidden': 'true' }, h('span.ps-fill', { style: { width: `${st.average ?? 0}%` } })),
            h('b.ps-avg.num', st.average ?? '–'),
            own ? h('span.ps-n', `${st.decisions} decision${st.decisions === 1 ? '' : 's'}`) : null);
        }))));
  }

  /**
   * The Tournament block: finished quiz sets with right answers (another player's: finished
   * sets only); on your own profile also the sets you are in the middle of and your drill totals.
   */
  function tournamentBlock(t, own, name) {
    if (!t) return null;
    const finished = t.sets.filter((s) => s.finished);
    const going = t.sets.filter((s) => !s.finished);
    const right = finished.reduce((a, s) => a + s.right, 0), asked = finished.reduce((a, s) => a + s.count, 0);
    const pct = (r, n) => (n ? `${Math.round((100 * r) / n)}%` : '–');
    const dr = own ? t.drill : null;
    const giveUp = (v, units) => (v.hands ? `${v.hands} hands, ${v.right} right, ${v.cost.toFixed(units === 'points' ? 3 : 2)} ${units} given up` : 'none yet');
    return h('section.panel.pf-tq', { 'aria-labelledby': 'pf-tq' },
      h('h2#pf-tq', 'Tournament quiz', finished.length ? h('span.count-pill.muted-pill', `${finished.length}/${t.setCount}`) : null),
      finished.length
        ? [h('ul.pf-tq-sets', finished.map((s) => h('li', h('span.pf-tq-t', s.title), h('b.num', `${s.right}/${s.count}`)))),
          h('p.pf-note', `${right} of ${asked} right over ${finished.length} finished set${finished.length === 1 ? '' : 's'}.`)]
        : h('p.pf-note', own ? 'No quiz set finished yet.' : `${name} has not finished a quiz set yet.`),
      own && going.length ? h('p.pf-note', `In progress: ${going.map((s) => `${s.title} (${s.answered} of ${s.count} answered)`).join(', ')}.`) : null,
      dr ? h('div.pf-block',
        h('h3.pf-h3', 'Drill', h('span.pf-h3-note', 'only you see this')),
        dr.hands
          ? h('ul.pf-tq-drill',
            h('li', h('span', 'All hands'), h('b.num', `${dr.right}/${dr.hands}`), h('span.muted', pct(dr.right, dr.hands))),
            h('li', h('span', 'First in'), h('b.num', `${dr.kinds.open.right}/${dr.kinds.open.hands}`), h('span.muted', pct(dr.kinds.open.right, dr.kinds.open.hands))),
            h('li', h('span', 'Facing an all-in'), h('b.num', `${dr.kinds.call.right}/${dr.kinds.call.hands}`), h('span.muted', pct(dr.kinds.call.right, dr.kinds.call.hands))),
            h('li.pf-tq-v', h('span', 'Chips'), h('span.muted', giveUp(dr.values.chips, 'bb'))),
            h('li.pf-tq-v', h('span', 'League points'), h('span.muted', giveUp(dr.values.points, 'points'))))
          : h('p.pf-note', 'No drill hands yet.')) : null,
      own ? h('div.pf-detail-act', h('a.btn.btn-sm', { href: '#/tournament/quiz' }, 'Quiz'), h('a.btn.btn-sm.btn-ghost', { href: '#/tournament/drill' }, 'Drill')) : null);
  }

  /** The marks of a finished hand's decisions (ringed where the viewer chose differently). */
  function marksOf(row) {
    const mine = (i) => row.mine?.choices.find((c) => c.index === i) || null;
    return h('span.pf-marks', row.choices.map((c) => gradeMark(c.grade, { diff: differs(c, mine(c.index)) })));
  }

  function detailOf(row, owner, own) {
    const pid = row.puzzle.id;
    if (own) {
      return [
        row.partial ? h('p.pf-note', 'Not scored: this hand was not played to the end.') : null,
        compareList({ name: 'You', choices: row.choices, theirsLabel: 'Your decisions' }),
        h('div.pf-detail-act',
          h('a.btn.btn-sm', { href: `#/review/${pid}` }, 'Review the hand'),
          h('a.btn.btn-sm.btn-ghost', { href: `#/practice/${pid}` }, 'Practice it')),
      ];
    }
    if (row.finished) {
      const mine = (i) => row.mine?.choices.find((c) => c.index === i) || null;
      const count = Math.max(row.choices.length, row.mine?.choices.length || 0);
      return [
        compareList({ name: owner.name, choices: row.choices, mineOf: mine, count }),
        row.stale ? h('p.pf-note', `${owner.name} played an earlier version of this hand: grades as they were then.`) : null,
        h('div.pf-detail-act',
          h('a.btn.btn-sm.btn-primary', { href: `#/review/${pid}/with/${owner.id}` }, 'Open the hand'),
          h('span.muted.small', `The table, and ${owner.name}'s decisions beside yours`)),
      ];
    }
    const go = row.battle
      ? h('a.btn.btn-sm.btn-primary', { href: `#/battle/${row.battle}` }, 'Play it in your battle')
      : h('a.btn.btn-sm.btn-primary', { href: `#/play/${pid}` }, row.yours === 'in_progress' ? 'Resume it' : 'Play it');
    return [h('div.pf-locked', h('p', `Play this hand to see ${owner.name}'s decisions.`), go)];
  }

  function handsTable(owner, own) {
    if (!hands.length) {
      return h('p.muted.fr-empty', own ? 'Your finished hands appear here.' : `${owner.name} has not finished a hand yet.`);
    }
    const cols = own ? 5 : 6;
    const first = owner.name.length > 12 ? 'Their' : `${owner.name}'s`;
    const body = [];
    for (const row of hands) {
      const pid = row.puzzle.id;
      const isOpen = open.has(pid);
      const detailId = `pf-d-${pid}`;
      const toggle = () => { if (isOpen) open.delete(pid); else open.add(pid); render({ keep: pid }); };
      const scoreTxt = row.score === null ? h('span.pf-unscored', 'not scored') : row.score;
      const yours = own ? null : row.finished ? (row.mine?.score ?? h('span.pf-unscored', 'not scored')) : h('span.muted', { title: 'You have not finished this hand' }, '–');
      body.push(h(`tr.pf-row${isOpen ? '.open' : ''}${row.finished || own ? '' : '.locked'}`, { dataset: { pid }, on: { click: (e) => { if (!e.target.closest('a, button')) toggle(); } } },
        h('td.pf-date', fmtDate(row.completedAt)),
        h('th.pf-hand', { scope: 'row' },
          h('button.pf-open', { type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': detailId, on: { click: toggle } },
            h('span.pf-num.num', `#${row.puzzle.number}`), h('span.pf-title', row.puzzle.title))),
        h('td.num.pf-score', { dataset: { label: own ? 'Score' : `${first} score` } }, scoreTxt),
        own ? null : h('td.num.pf-yours', { dataset: { label: 'Yours' } }, yours),
        h('td.pf-dec', row.finished || own ? marksOf(row) : h('span.pf-hidden', 'after you play it')),
        h('td.pf-chev', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸')));
      if (isOpen) body.push(h('tr.pf-detail', h('td', { colspan: String(cols) }, h(`div.pf-detail-in#${detailId}`, detailOf(row, owner, own)))));
    }
    return h('table.pf-table',
      h('caption.sr-only', `${own ? 'Your' : `${owner.name}'s`} finished hands, newest first`),
      h('thead', h('tr',
        h('th', { scope: 'col' }, 'Date'),
        h('th', { scope: 'col' }, 'Hand'),
        h('th.num', { scope: 'col' }, own ? 'Score' : `${first} score`),
        own ? null : h('th.num', { scope: 'col' }, 'Yours'),
        h('th', { scope: 'col' }, 'Decisions'),
        h('th', { scope: 'col' }, h('span.sr-only', 'Open')))),
      h('tbody', body));
  }

  async function more(btn) {
    if (loadingMore || !next) return;
    loadingMore = true;
    btn.disabled = true;
    try {
      const r = await API.playerHands(id, next);
      if (destroyed) return;
      hands = hands.concat(r.hands);
      next = r.next;
      render({ keepMore: true });
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    finally { loadingMore = false; }
  }

  function render({ keep = null, keepMore = false } = {}) {
    if (!data) return;
    const p = data.player, own = data.you;
    document.title = `${own ? 'Your profile' : p.name} · PokerPuzzles`;
    const rel = own ? h('div.pf-rel',
      h('a.btn.btn-sm', { href: '#/friends' }, data.friendCount ? `Friends · ${data.friendCount}` : 'Friends'),
      onSignOut ? h('button.btn.btn-sm.btn-ghost', { type: 'button', on: { click: onSignOut } }, 'Sign out') : null)
      : h('div.pf-rel', relationControl(p, data.relation, { removable: true, onChange: () => load() }));
    clear(el).append(
      h('div.pf-head',
        personAvatar(p.name, { me: own, big: true }),
        h('div.pf-id',
          h('h1', { tabindex: '-1' }, p.name, own ? h('span.you', 'You') : null),
          h('p.muted', `Member since ${fmtDate(p.since)}`)),
        rankBlock(data.rank),
        rel),
      h('div.pf-grid',
        data.tournament
          ? h('div.pf-left', statsPanel(data.stats, p.name, data.rank.minHands), tournamentBlock(data.tournament, own, p.name))
          : statsPanel(data.stats, p.name, data.rank.minHands),
        h('section.panel.pf-hands', { 'aria-labelledby': 'pf-h' },
          h('div.pf-hands-head',
            h('h2#pf-h', 'Hands played', h('span.count-pill.muted-pill', data.handsTotal)),
            own ? null : h('p.pf-hands-note', 'Hands you have both finished open to every decision, yours beside theirs.')),
          handsTable(p, own),
          next ? h('button.btn.btn-ghost.pf-more', { type: 'button', on: { click: (e) => more(e.currentTarget) } }, `Show more (${data.handsTotal - hands.length} left)`) : null)));
    if (keep) el.querySelector(`tr.pf-row[data-pid="${keep}"] .pf-open`)?.focus({ preventScroll: true });
    if (keepMore) (el.querySelector('.pf-more') || el.querySelector('.pf-table tbody tr:last-child .pf-open'))?.focus({ preventScroll: true });
  }

  async function load() {
    try {
      const r = await API.player(id);
      if (destroyed) return;
      data = r; hands = r.hands; next = r.next;
      render();
    } catch (e) {
      if (destroyed) return;
      document.title = 'Player · PokerPuzzles';
      clear(el).append(h('div.error-box', h('p', e.message), h('a.btn', { href: '#/lobby' }, 'All puzzles')));
    }
  }
  el.append(h('p.muted.pad', 'Loading…'));
  load();
  return { destroy() { destroyed = true; } };
}
