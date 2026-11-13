// The Tournament tab (#/tournament): short-stack push/fold practice on top of
// the solved spots. Home (Drill, Quiz, Charts and "How accurate is this?"),
// the quiz page (the five sets with your progress, the ranking), a set's
// results, and the routes into the question screen (tquestion.js) and the
// charts (tcharts.js).
//   #/tournament                     home
//   #/tournament/drill               the drill
//   #/tournament/quiz                the sets and the ranking
//   #/tournament/quiz/<set>          play the set (its results once all 10 are answered)
//   #/tournament/quiz/<set>/<n>      question n of the set, answered (from the results)
//   #/tournament/charts[/<spot>[/<decision>]]
import { h, clear, toast } from './ui.js';
import { API } from './api.js';
import * as PFR from './pushfold.js';
import { drillScreen, quizPlayScreen, quizReviewScreen, openDialog } from './tquestion.js';
import { chartsScreen } from './tcharts.js';

/** "How accurate is this?": plain statements, each true per docs/TOURNAMENT.md. */
export function accuracyDialog() {
  const items = [
    ['Heads-up is exact.', `Every board is counted for every pair of hands. It reproduces the published HoldemResources heads-up Nash chart: all ${HUNE_CELLS} comparable cells of the no-ante chart agree to within the chart's 0.05 bb rounding grid.`],
    ['3 to 6 players: complete deals.', 'Every spot is solved on complete deals (all cards from one deck) and valued on 4 million further deals. Each EV is shown with its sampling error (the ± is two standard errors). In the worst spot no player could gain more than 0.0007 bb per hand by changing his play (the target was 0.002).'],
    ['All-in or fold.', 'The numbers are for the all-in-or-fold game against opponents who play it perfectly. That is how short stacks are played up to about 10 bb; at 12 bb real play also uses small raises, so treat the 12 bb charts as a simplification. A call of an all-in also puts in the caller\'s whole stack, even when players are still to act behind him.'],
    ['League points.', 'Points spots use the ICM model (Malmuth-Harville) with the league\'s 15 / 8 / 5 / 3 / 2 / 1.'],
    ['Close calls.', 'When two plays are within the error (or the solver mixes them), the site says so and accepts both.'],
  ];
  openDialog({
    title: 'How accurate is this?', cls: '.tdlg-acc',
    content: h('ul.tacc', items.map(([k, t]) => h('li', h('b', k), ' ', t))),
  });
}
// Cells of the no-ante HoldemResources chart compared with the exact heads-up solution: the second
// pass over the whole chart in docs/TOURNAMENT.md section 4.1 (every cell but the three footnoted
// ones, 335, all within the 0.05 bb grid; the first pass, hune-comparison.json, 130 of 130).
const HUNE_CELLS = 335;

const accuracyLink = () => h('button.as-link.tacc-link', { type: 'button', on: { click: accuracyDialog } }, 'How accurate is this?');

/** "8 of 10 right" / "4 of 10 answered" / "not started". */
function setState(s) {
  if (s.finished) return `${s.right} of ${s.count} right`;
  if (s.answered) return `${s.answered} of ${s.count} answered`;
  return 'not started';
}
const fmtTime = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

function homePage(el, menu) {
  const done = menu.quiz.filter((s) => s.finished).length;
  const right = menu.quiz.filter((s) => s.finished).reduce((a, s) => a + s.right, 0);
  const card = (href, title, line, extra = null) => h('a.tcard', { href },
    h('h2', title), h('p', line), extra ? h('p.tcard-x', extra) : null, h('span.tcard-go', 'Open →'));
  clear(el).append(
    h('div.tpage-head',
      h('h1', 'Tournament'),
      h('p.tlead', 'Short-stack poker as the league plays it: 2 to 6 players with 4 to 12 big blinds, and every player posts an ante of 0.1 bb. You go all-in or fold, and every answer is checked against a push/fold solver.'),
      accuracyLink()),
    h('div.tcards',
      card('#/tournament/drill', 'Drill', 'Endless practice hands, graded at once, with the numbers behind each answer.',
        menu.drill.hands ? `You: ${menu.drill.hands} hand${menu.drill.hands === 1 ? '' : 's'}, ${menu.drill.right} right` : null),
      card('#/tournament/quiz', 'Quiz', 'The same 50 questions for everyone, in 5 sets of 10. Your first answer counts.',
        done ? `You: ${done} set${done === 1 ? '' : 's'} finished, ${right} right` : null),
      card('#/tournament/charts', 'Charts', 'Every solved spot as a 13×13 chart, with the EVs of each hand.')));
}

function quizPage(el, menu) {
  let scope = 'everyone', board = null, destroyed = false, seq = 0;
  try { if (localStorage.getItem('pokerpuzzles.tqscope') === 'friends') scope = 'friends'; } catch { /* ignore */ }
  async function loadBoard() {
    const my = ++seq;
    try { const b = await API.quizRanking(scope); if (destroyed || my !== seq) return; board = b; render(); }
    catch (e) { if (!destroyed) toast(e.message, 'error'); }
  }
  function ranking() {
    if (!board) return h('p.muted', 'Loading…');
    const chipS = (v, label) => h(`button.chip${scope === v ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': String(scope === v),
      on: { click: () => { if (scope === v) return; scope = v; try { localStorage.setItem('pokerpuzzles.tqscope', v); } catch { /* ignore */ } loadBoard(); } },
    }, label);
    const rows = board.players;
    return h('section.panel.tq-rank', { 'aria-labelledby': 'tq-rank-h' },
      h('div.lb-head', h('h2#tq-rank-h', 'Ranking'), h('div.chips.lb-scope', { role: 'group', 'aria-label': 'Whose results' }, chipS('everyone', 'Everyone'), chipS('friends', 'Friends'))),
      rows.length
        ? h('div.lb-scroll', h('table.lb',
          h('caption.sr-only', 'Quiz ranking: right answers over all finished sets'),
          h('thead', h('tr', h('th.num', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'Player'), h('th.num', { scope: 'col' }, 'Right'), h('th.num', { scope: 'col' }, 'Sets'))),
          h('tbody', rows.map((r) => h(`tr${r.id === board.you ? '.me' : ''}`,
            h('td.num.muted', r.rank),
            h('th', { scope: 'row' }, h('a.lb-name', { href: `#/player/${r.id}` }, r.name), r.id === board.you ? h('span.you', 'You') : r.friend && board.scope !== 'friends' ? h('span.lb-friend', 'friend') : null),
            h('td.num.strong', `${r.right}`, h('span.muted', ` / ${r.answered}`)),
            h('td.num', r.sets))))))
        : h('p.muted', board.scope === 'friends' ? 'None of your friends has finished a set yet.' : 'Nobody has finished a set yet.'),
      h('p.small.muted.lb-note', `Ranked by right answers over all finished sets (a hand too close to call counts as right); equal numbers share a place. A player is ranked once a set is finished.${board.ranked ? '' : ' Finish a set to be ranked.'}`));
  }
  function render() {
    clear(el).append(
      h('div.tpage-head',
        h('a.back', { href: '#/tournament' }, '← Tournament'),
        h('h1', 'Quiz'),
        h('p.tlead', 'The same 50 questions for everyone, 5 sets of 10. Your first answer counts and cannot be changed; the time you take is recorded. After each question you see how the others did.'),
        accuracyLink()),
      h('div.tq-grid',
        h('div.tq-sets', menu.quiz.map((s) => h('a.tset', { href: `#/tournament/quiz/${encodeURIComponent(s.id)}` },
          h('div.tset-top', h('h2', s.title), h(`span.tset-state${s.finished ? '.done' : s.answered ? '.going' : ''}`, setState(s))),
          h('p', s.blurb),
          h('span.tcard-go', s.finished ? 'Results →' : s.answered ? 'Continue →' : 'Start →')))),
        ranking()));
  }
  render();
  loadBoard();
  return { destroy() { destroyed = true; } };
}

/** A set's results: one mark per question, right answers, time, every question reviewable. */
function resultsPage(el, setId) {
  let destroyed = false;
  el.append(h('p.muted.pad', 'Loading…'));
  (async () => {
    try {
      const s = await API.quizSummary(setId);
      if (destroyed) return;
      document.title = `${s.set.title} · Quiz · PokerPuzzles`;
      const rows = s.answers.map((a) => {
        const fb = a.feedback;
        const name = (x) => (x === 'fold' ? 'Fold' : fb ? PFR.allinLabel(fb.decision) : 'All-in');
        const best = fb?.verdict.close ? 'either' : fb?.verdict.best ? name(fb.verdict.best) : '–';
        return h('li', h('a.tres-row', { href: `#/tournament/quiz/${encodeURIComponent(setId)}/${a.index + 1}` },
          h(`span.gmark.g-${a.grade}`, { 'aria-hidden': 'true' }, a.right ? '✓' : '✕'),
          h('span.tres-n.num', a.index + 1),
          h('span.tres-q', fb ? PFR.questionText(fb.spot, fb.decision) : a.id, fb ? h('span.muted', ` · ${fb.hand.class}`) : null),
          h('span.tres-a', 'You: ', h('b', name(a.action)), h('span.muted', ` · best: ${best}`)),
          h('span.tres-c.num', a.right ? '' : fb ? PFR.fmtEv(-a.cost, fb.spot.units) : ''),
          h('span.tres-t.num.muted', fmtTime(a.timeMs))));
      });
      clear(el).append(
        h('div.tpage-head',
          h('a.back', { href: '#/tournament/quiz' }, '← Quiz'),
          h('h1', s.set.title),
          h('p.tlead', s.set.blurb)),
        h('section.panel.tres',
          h('div.tres-head',
            h('p.tres-score', h('b.num', s.right), h('span', ` of ${s.count} right`)),
            h('p.muted', s.finished ? `Time answering: ${fmtTime(s.timeMs)}` : `${s.answered} of ${s.count} answered`),
            h('div.tres-marks', { 'aria-label': `${s.right} of ${s.answered} right` }, s.answers.map((a) => h(`span.gmark.g-${a.grade}`, { title: `Question ${a.index + 1}: ${PFR.GRADE_LABELS[a.grade] || a.grade}` }, a.right ? '✓' : '✕')))),
          s.finished ? null : h('a.btn.btn-primary', { href: `#/tournament/quiz/${encodeURIComponent(setId)}` }, 'Continue the set'),
          h('ol.tres-list', rows),
          h('p.small.muted', 'Open a question for your answer, the better play, the numbers and how the others did.')));
    } catch (e) {
      if (!destroyed) clear(el).append(h('div.error-box', h('p', e.message), h('a.btn', { href: '#/tournament/quiz' }, 'Quiz')));
    }
  })();
  return { destroy() { destroyed = true; } };
}

/**
 * The Tournament tab. `path` is the part of the hash after #/tournament
 * ('' | '/drill' | '/quiz' | '/quiz/<set>' | '/quiz/<set>/<n>' | '/charts/...').
 */
export function tournamentScreen(root, { path = '' }) {
  let current = null, destroyed = false;
  const parts = path.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  const sub = parts[0] || '';
  const playLike = sub === 'drill' || (sub === 'quiz' && parts[1]);
  document.body.dataset.screen = playLike ? 'play' : 'tournament';
  const el = h('section.tpage');
  clear(root).append(playLike ? h('p.muted.pad', 'Loading…') : el);
  if (!playLike) el.append(h('p.muted.pad', 'Loading…'));

  const notInstalled = () => {
    document.body.dataset.screen = 'tournament';
    clear(root).append(h('section.tpage', h('div.tpage-head', h('h1', 'Tournament'),
      h('p.tlead', 'The tournament data is not installed on this server, so there is nothing to practise yet.'))));
  };

  (async () => {
    let menu;
    try {
      menu = await API.tournament(); // small (no solver output); fresh, so progress and totals are current
    } catch (e) {
      if (destroyed) return;
      clear(root).append(h('div.error-box', h('p', e.message), h('button.btn', { type: 'button', on: { click: () => location.reload() } }, 'Try again')));
      return;
    }
    if (destroyed) return;
    if (!menu.installed) { notInstalled(); return; }
    if (sub === 'drill') { document.title = 'Drill · Tournament · PokerPuzzles'; current = drillScreen(root, { menu }); return; }
    if (sub === 'charts') { document.title = 'Charts · Tournament · PokerPuzzles'; clear(root).append(el); current = chartsScreen(el, { menu, spotName: parts[1] || null, decisionId: parts[2] || null }); return; }
    if (sub === 'quiz' && parts[1]) {
      const setId = parts[1];
      const set = menu.quiz.find((s) => s.id === setId);
      if (!set) { document.body.dataset.screen = 'tournament'; clear(root).append(h('div.error-box', h('p', 'No such quiz set.'), h('a.btn', { href: '#/tournament/quiz' }, 'Quiz'))); return; }
      document.title = `${set.title} · Quiz · PokerPuzzles`;
      const n = Number(parts[2]);
      if (parts[2] && Number.isInteger(n) && n >= 1) { current = quizReviewScreen(root, { setId, index: n - 1 }); return; }
      const results = () => {
        current?.destroy?.();
        document.body.dataset.screen = 'tournament';
        clear(root).append(el);
        clear(el);
        current = resultsPage(el, setId);
      };
      if (set.finished) { results(); return; }
      current = quizPlayScreen(root, { menu, setId, onDone: results });
      return;
    }
    if (sub === 'quiz') { document.title = 'Quiz · Tournament · PokerPuzzles'; current = quizPage(el, menu); return; }
    document.title = 'Tournament · PokerPuzzles';
    if (sub) history.replaceState(null, '', '#/tournament');
    homePage(el, menu);
  })();

  return { destroy() { destroyed = true; current?.destroy?.(); } };
}
