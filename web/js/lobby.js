// Sign-in and lobby screens.
import { h, clear, toast, GRADE_LABEL, GRADE_SHORT } from './ui.js';
import { API, setSession } from './api.js';
import { positionLabel } from './poker.js';

export function loginScreen(root, { onSignedIn }) {
  const err = h('p.form-error', { role: 'alert' });
  const name = h('input#name', { name: 'name', autocomplete: 'username', required: true, minlength: '2', maxlength: '20', autocapitalize: 'words', spellcheck: 'false' });
  const pin = h('input#pin', { name: 'pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'current-password', required: true, minlength: '4', maxlength: '12' });
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Sign in');
  const form = h('form.login-form', {
    on: {
      submit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!/^\d{4,12}$/.test(pin.value)) { err.textContent = 'PIN must be 4–12 digits.'; pin.focus(); return; }
        btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          const r = await API.login(name.value, pin.value);
          setSession({ token: r.token, player: r.player });
          if (r.created) toast(`Welcome, ${r.player.name}. Your player has been created.`);
          onSignedIn(r.player);
        } catch (ex) {
          err.textContent = ex.message;
          pin.value = '';
          pin.focus();
        } finally {
          btn.disabled = false; btn.textContent = 'Sign in';
        }
      },
    },
  },
  h('label', { for: 'name' }, 'Name'), name,
  h('label', { for: 'pin' }, 'PIN'), pin,
  h('p.hint', 'New here? Pick a name and a PIN of at least 4 digits; your player is created on first sign-in. Remember the PIN — there is no reset.'),
  err, btn);

  clear(root).append(h('section.login',
    h('div.login-card',
      h('div.login-brand',
        h('span.login-mark', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#14202e"/><path d="M16 6c4 5 9 8 9 12.5A4.5 4.5 0 0 1 17.6 22l1.4 4h-6l1.4-4A4.5 4.5 0 0 1 7 18.5C7 14 12 11 16 6z" fill="#d9b46a"/></svg>' }),
        h('h1', 'PokerPuzzles')),
      h('p.login-sub', 'Solver-graded hands. Same spots for everyone. First play counts.'),
      form)));
  name.focus();
  return { destroy() {} };
}


const FILTERS_KEY = 'pokerpuzzles.filters';

export function lobbyScreen(root, { player }) {
  let filters = { pot: 'all', status: 'all', level: 'all' };
  try { filters = { ...filters, ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') }; } catch { /* ignore */ }
  let puzzles = [], board = null, usingFixtures = false, nextId = null;
  let sort = { key: 'average', dir: -1 };
  const el = h('section.lobby');
  clear(root).append(el);

  function chip(group, value, label) {
    const active = filters[group] === value;
    return h(`button.chip${active ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': String(active),
      on: { click: () => { filters[group] = value; try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* ignore */ } render(); } },
    }, label);
  }

  function card(p) {
    const status = p.battle ? 'In a battle' : { new: 'New', in_progress: 'In progress', done: 'Done' }[p.status];
    const meta = [
      h('p.pc-scn', p.scenario.name),
      h('p.pc-pos', h('span.pos', p.hero.seat), ` ${positionLabel(p.hero.position)} vs `, h('span.pos', p.villain.seat), p.decisionCount ? h('span.muted', ` · ${p.decisionCount} decisions`) : null), // the count is only sent for finished hands
    ];
    const levelName = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }[p.level];
    const head = h('div.pc-head', h('span.pc-num.num', `#${p.number}`), h('span.pot-type', p.scenario.potType),
      levelName ? h(`span.level.lv-${p.level}`, { title: `Difficulty rank ${p.rank} of ${puzzles.length}` }, levelName) : null,
      h(`span.status.st-${p.battle ? 'battle' : p.status}`, status));
    if (p.status === 'done') {
      return h('article.pcard.done',
        head, h('h3.pc-title', p.title), meta,
        p.tags?.length ? h('p.pc-tags', p.tags.map((t) => h('span.tag', t))) : null,
        h('div.pc-foot',
          p.scored === false
            ? h('p.pc-score.pc-unscored', { title: 'This hand was not finished, so it is not scored' }, 'not scored')
            : h('p.pc-score', h('span.num', p.score), h('span.muted.small', ' / 100')),
          h('div.pc-actions', h('a.btn.btn-sm', { href: `#/review/${p.id}` }, 'Review'), h('a.btn.btn-sm.btn-ghost', { href: `#/practice/${p.id}` }, 'Practice'))));
    }
    if (p.battle) {
      // A hand of a running battle is played there, against the opponent.
      return h('a.pcard.in-battle', { href: `#/battle/${p.battle}`, 'aria-label': `Puzzle ${p.number}: ${p.title}. Part of a battle you are playing.` },
        head, h('h3.pc-title', p.title), meta,
        h('div.pc-foot', h('span.pc-go', 'Play it in your battle →')));
    }
    return h('a.pcard', { href: `#/play/${p.id}`, 'aria-label': `Puzzle ${p.number}: ${p.title}. ${status}.` },
      head, h('h3.pc-title', p.title), meta,
      h('div.pc-foot', h('span.pc-go', p.status === 'in_progress' ? `Resume · ${p.answered} answered` : 'Play →')));
  }

  function leaderboardTable() {
    if (!board) return h('p.muted', 'Loading…');
    const rows = board.players.filter((p) => p.played > 0 || p.id === board.you);
    const keyOf = (r) => (sort.key === 'name' ? r.name.toLowerCase() : sort.key in r.grades ? r.grades[sort.key] : r[sort.key] ?? -1);
    rows.sort((a, b) => {
      const x = keyOf(a), y = keyOf(b);
      if (x < y) return -sort.dir; if (x > y) return sort.dir;
      return (b.played - a.played) || a.name.localeCompare(b.name);
    });
    // Rank by average (ties share a rank); players without plays are unranked.
    const ranked = [...board.players].filter((p) => p.played > 0).sort((a, b) => b.average - a.average);
    const rankOf = (r) => (r.played ? ranked.findIndex((x) => x.average === r.average) + 1 : null);
    const th = (key, label, cls = '') => {
      const on = sort.key === key;
      return h(`th${cls}`, { scope: 'col', 'aria-sort': on ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none' },
        h('button.sort', { type: 'button', on: { click: () => { sort = { key, dir: on ? -sort.dir : key === 'name' ? 1 : -1 }; render(); } } }, label, on ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''));
    };
    return h('div', h('div.lb-scroll', h('table.lb',
      h('caption.sr-only', 'Leaderboard'),
      h('thead', h('tr',
        h('th.num', { scope: 'col' }, '#'), th('name', 'Player'), th('played', 'Played', '.num'), th('average', 'Avg', '.num'), th('totalPoints', 'Total', '.num'),
        ['best', 'correct', 'inaccuracy', 'wrong', 'blunder'].map((g) => h(`th.num.gcol`, { scope: 'col', 'aria-sort': sort.key === g ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none' },
          h('button.sort', { type: 'button', title: GRADE_LABEL[g], 'aria-label': `${GRADE_LABEL[g]} count`, on: { click: () => { sort = { key: g, dir: sort.key === g ? -sort.dir : -1 }; render(); } } },
            h(`span.gpill.g-${g}`, GRADE_SHORT[g])))))),
      h('tbody', rows.map((r) => h(`tr${r.id === board.you ? '.me' : ''}`,
        h('td.num.muted', rankOf(r) ?? '–'),
        h('th', { scope: 'row' }, r.name, r.id === board.you ? h('span.you', 'You') : null),
        h('td.num', r.played), h('td.num.strong', r.average ?? '–'), h('td.num', r.totalPoints),
        ['best', 'correct', 'inaccuracy', 'wrong', 'blunder'].map((g) => h('td.num.gcol', r.grades[g] || 0))))))),
    h('p.small.muted.lb-note', 'Ranked by average score. Click a column to sort. Grade counts: ', ['best', 'correct', 'inaccuracy', 'wrong', 'blunder'].map((g) => h('span.lb-key', h(`span.gpill.g-${g}`, GRADE_SHORT[g]), ` ${GRADE_LABEL[g]} `))));
  }

  // "Practise your weakest hands": lowest score first, then the next lowest.
  const PRACTISED_KEY = `pokerpuzzles.practised.${player.id}`;
  function practiseWeakest(done) {
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(PRACTISED_KEY) || '[]'); } catch { /* ignore */ }
    const order = done.filter((p) => p.score !== null).sort((a, b) => a.score - b.score || a.rank - b.rank);
    if (!order.length) return;
    let pick = order.find((p) => !seen.includes(p.id));
    if (!pick) { seen = []; pick = order[0]; }
    seen.push(pick.id);
    try { localStorage.setItem(PRACTISED_KEY, JSON.stringify(seen)); } catch { /* ignore */ }
    location.hash = `#/practice/${pick.id}`;
  }

  function progressBlock(done, avg) {
    const pct = puzzles.length ? (100 * done.length) / puzzles.length : 0;
    // weakest tags: average score per tag over done puzzles, at least 2 hands
    const byTag = new Map();
    for (const p of done) for (const t of (p.score !== null ? p.tags : null) || []) { // hands that are not scored stay out
      const e = byTag.get(t) || { n: 0, sum: 0 }; e.n++; e.sum += p.score; byTag.set(t, e);
    }
    const weak = [...byTag.entries()].filter(([, e]) => e.n >= 2).map(([t, e]) => ({ t, avg: Math.round(e.sum / e.n), n: e.n }))
      .sort((a, b) => a.avg - b.avg).slice(0, 4);
    return h('section.progress-block', { 'aria-label': 'Your progress' },
      h('div.pb-main',
        h('h2.pb-title', 'Your progress'),
        h('div.progress-nums', h('span', h('b.num', done.length), h('span.muted', ` of ${puzzles.length} hands done`)), avg !== null ? h('span', h('span.muted', 'average '), h('b.num', avg)) : null),
        h('div.progress', h('span', { style: { width: `${pct}%` } }))),
      weak.length ? h('div.pb-weak', h('span.muted.small', 'Weakest spots'), h('div.pb-tags', weak.map((w) => h('span.tag.pb-tag', { title: `${w.n} hands` }, w.t, ' ', h('b.num', w.avg))))) : null,
      done.some((p) => p.score !== null) ? h('button.btn.pb-practise', { type: 'button', on: { click: () => practiseWeakest(done) } }, 'Practise your weakest hands') : null);
  }

  function render() {
    const potTypes = [...new Set(puzzles.map((p) => p.scenario.potType))].sort();
    const shown = puzzles.filter((p) => (filters.pot === 'all' || p.scenario.potType === filters.pot)
      && (filters.status === 'all' || p.status === filters.status)
      && (filters.level === 'all' || p.level === filters.level));
    const done = puzzles.filter((p) => p.status === 'done');
    const scored = done.filter((p) => p.score !== null); // a partial hand counts as played, not as a score
    const avg = scored.length ? Math.round(scored.reduce((a, p) => a + p.score, 0) / scored.length) : null;
    const pct = puzzles.length ? (100 * done.length) / puzzles.length : 0;
    const nextP = puzzles.find((p) => p.id === nextId);
    clear(el).append(
      usingFixtures ? h('div.notice', h('b', 'Fixture puzzles. '), 'These hands use fake numbers until real solver output is in data/solutions.') : '',
      h('div.lobby-head',
        h('div', h('h1', `Hi, ${player.name}`), h('p.muted', 'Your first play of each puzzle is your score. Replays are practice.')),
        nextP ? h('a.btn.btn-primary.continue-btn', { href: `#/play/${nextP.id}` }, `Continue with puzzle #${nextP.number}`) : null),
      progressBlock(done, avg),
      h('div.lobby-grid',
        h('div.lobby-puzzles',
          h('div.filters',
            h('div.chips', { role: 'group', 'aria-label': 'Pot type' }, chip('pot', 'all', 'All pots'), potTypes.map((t) => chip('pot', t, t))),
            h('div.chips', { role: 'group', 'aria-label': 'Level' }, chip('level', 'all', 'Any level'), chip('level', 'easy', 'Easy'), chip('level', 'medium', 'Medium'), chip('level', 'hard', 'Hard')),
            h('div.chips', { role: 'group', 'aria-label': 'Status' }, chip('status', 'all', 'Any status'), chip('status', 'new', 'New'), chip('status', 'in_progress', 'In progress'), chip('status', 'done', 'Done'))),
          h('p.small.muted.shown-count', `${shown.length} of ${puzzles.length} puzzles`),
          shown.length ? h('div.cards', shown.map(card)) : h('p.muted.pad', puzzles.length ? 'No puzzles match these filters.' : 'No puzzles yet.')),
        h('aside.lobby-board', h('h2', 'Leaderboard'), leaderboardTable())));
  }

  (async () => {
    try {
      const [list, lb] = await Promise.all([API.puzzles(), API.leaderboard()]);
      puzzles = list.puzzles; usingFixtures = list.usingFixtures; nextId = list.nextId; board = lb;
      render();
    } catch (e) {
      clear(el).append(h('div.error-box', h('p', e.message), h('button.btn', { type: 'button', on: { click: () => location.reload() } }, 'Try again')));
    }
  })();
  el.append(h('p.muted.pad', 'Loading…'));
  return { destroy() {} };
}
