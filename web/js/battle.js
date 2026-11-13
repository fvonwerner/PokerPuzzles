// Battles: two or three players, the same five hands, live and in lockstep.
//
//   battleHome    #/battle       start (duel or three-way), join by code, open challenges, your battles, head-to-head
//   battleScreen  #/battle/<id>  join confirm, waiting room, ready check with a shared 3-2-1, the hands
//                                (the normal play screen in battle mode: battle bar, everybody's picks,
//                                the clocks and waiting states, the duel panel at the end of a hand),
//                                the versus lead-in between hands, the result
//
// The server keeps one shared cursor (live.phase / hand / index) and is the
// only clock. This screen polls it about once a second, keeps an estimate of
// the difference between its own clock and the server's, and moves the hand
// on when the cursor moves.
import { h, clear, toast, reducedMotion, gradeBadge, STREETS, GRADE_ICON, GRADE_LABEL } from './ui.js';
import { API, session } from './api.js';
import { playScreen } from './play.js';
import { sound } from './sound.js';
import { choiceLine, decisionBody, copyButton } from './feedback.js';
import { cardText } from './poker.js';
import { setLinkedText, tagChips } from './learn.js';
import { othersBlock, othersHere } from './social.js';

const POLL_MS = 1000, POLL_HIDDEN_MS = 4000, HOME_POLL_MS = 4000;
const LEVEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const CELEBRATED_KEY = 'pokerpuzzles.battle.celebrated';
const SWORDS = '<svg viewBox="0 0 24 24" width="22" height="22"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/>'
  + '<path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/></g></svg>';
export const CLOCK_RULE = 'Once somebody answers a decision, everybody else has 20 seconds for it.';

// ---------- the server's clock ----------
// skew = server time - local time, from the request with the shortest round trip lately.
let skew = 0;
const skewSamples = [];
function noteServer(serverNow, t0, t1) {
  if (!serverNow) return;
  skewSamples.push({ rtt: t1 - t0, est: serverNow - (t0 + t1) / 2 });
  if (skewSamples.length > 10) skewSamples.shift();
  skew = skewSamples.reduce((a, s) => (s.rtt < a.rtt ? s : a)).est;
}
const toLocal = (serverMs) => serverMs - skew;
async function timed(fn) {
  const t0 = Date.now();
  const r = await fn();
  noteServer((r.battle || r)?.serverNow, t0, Date.now());
  return r;
}

// ---------- small pieces ----------
const initial = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';
/** who: 'me' (gold), 'o1' (violet), 'o2' (teal), 'wait'. */
function avatar(name, who = 'o1', { big = false } = {}) {
  return h(`span.bav.bav-${who}${big ? '.bav-big' : ''}`, { 'aria-hidden': 'true' }, initial(name));
}
const oc = (o) => `o${o?.color || 1}`;
function ago(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
const agoAt = (t) => (t ? ago(Date.now() - t) : '');
const names = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
/** Count a number element up (or down) to `to`. */
function countTo(el, from, to, dur = 900) {
  if (!el) return;
  if (reducedMotion() || from === to || from === null || from === undefined) { el.textContent = to; return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = to;
  };
  el.textContent = from;
  requestAnimationFrame(step);
}
function onlineDot(online, title) { return h(`span.bdot${online ? '.on' : ''}`, { title, 'aria-label': title }); }
function copyText(text, input) {
  const done = () => toast('Link copied. Send it to your friends.');
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(done, () => fallback());
  return fallback();
  function fallback() { try { input.select(); document.execCommand('copy'); done(); } catch { toast('Select the link and copy it.'); } }
}
const battleLink = (id) => `${location.origin}${location.pathname}#/battle/${id}`;
function celebrated(id) { try { return JSON.parse(localStorage.getItem(CELEBRATED_KEY) || '[]').includes(id); } catch { return false; } }
function markCelebrated(id) {
  try {
    const list = JSON.parse(localStorage.getItem(CELEBRATED_KEY) || '[]').filter((x) => x !== id);
    list.push(id);
    localStorage.setItem(CELEBRATED_KEY, JSON.stringify(list.slice(-50)));
  } catch { /* storage blocked */ }
}

// ---------- clocks ----------
/**
 * A draining clock: `deadline` in server time. mine: the player's own
 * decision clock (urgent in the last five seconds); calm: an anti-stall wait.
 */
function clockEl(deadline, { total, mine = false, calm = false, label = null, mini = false }) {
  const el = h(`span.bclock${mine ? '.mine' : ''}${calm ? '.calm' : ''}${mini ? '.mini' : ''}`, {
    dataset: { deadline: String(toLocal(deadline)), total: String(total), mine: mine ? '1' : '' }, role: 'timer',
  },
  mini ? null : h('span.bc-track', { 'aria-hidden': 'true' }, h('span.bc-fill')),
  h('b.bc-num.num'), label ? h('span.bc-label', label) : null);
  paintClock(el);
  return el;
}
function paintClock(el) {
  const rem = Number(el.dataset.deadline) - Date.now();
  const total = Number(el.dataset.total) || 20000;
  const fill = el.querySelector('.bc-fill');
  if (fill) fill.style.transform = `scaleX(${Math.max(0, Math.min(1, rem / total))})`;
  const num = el.querySelector('.bc-num');
  const secs = Math.max(0, Math.ceil(rem / 1000));
  const txt = el.classList.contains('mini') ? `⏱ ${secs} s` : `${secs} s`;
  if (num.textContent !== txt) num.textContent = txt;
  el.classList.toggle('urgent', !!el.dataset.mine && rem <= 5000);
  el.classList.toggle('over', rem <= 0);
}

/** Where a player is right now, in words (full and short), from the shared cursor. */
function statusOf(st, o) {
  const L = st.live;
  const answered = !!L?.answered?.includes(o.id), ready = !!L?.ready?.includes(o.id), timedOut = !!L?.timedOut?.includes(o.id);
  let text = '', short = '', clock = null;
  switch (L?.phase) {
    case 'ready': text = ready ? 'ready' : 'not ready yet'; short = ready ? 'ready' : 'not ready'; break;
    case 'countdown': text = short = 'ready'; break;
    case 'decide':
      if (answered) { text = timedOut ? 'ran out of time' : 'has answered'; short = timedOut ? 'time out' : 'answered'; }
      else { text = `thinking on decision ${L.index + 1}`; short = 'thinking'; clock = L.deadline; }
      break;
    case 'review': text = ready ? 'ready to go on' : 'reading the analysis'; short = ready ? 'ready' : 'reading'; break;
    case 'handEnd': text = ready ? 'ready for the next hand' : 'looking at the hand'; short = ready ? 'ready' : 'looking'; break;
    case 'done': text = short = 'finished'; break;
    default: text = short = o.done ? 'finished' : '';
  }
  if (!o.online) {
    text = `offline${text ? ` · ${text}` : ''}${o.lastSeenAgo !== null && o.lastSeenAgo !== undefined ? ` · seen ${ago(o.lastSeenAgo)}` : ''}`;
    short = 'offline';
  }
  return { text, short, clock, answered, ready, timedOut };
}

/** Round marker state for hand n as you see it. */
function roundOf(st, n, { hide = null } = {}) {
  const hd = st.hands[n];
  if (!hd) return 'todo';
  if (hd.outcome && hide !== n) return hd.outcome;
  const L = st.live;
  if (L && L.hand === n && ['decide', 'review', 'countdown'].includes(L.phase)) return 'current';
  if (L && L.hand === n && L.phase === 'handEnd') return 'wait';
  return 'todo';
}
const ROUND_TEXT = { won: 'you won', lost: 'you lost', tied: 'shared', wait: 'just finished', current: 'playing now', todo: 'to come' };
const ROUND_ICON = { won: '▲', lost: '▼', tied: '=', wait: '…', current: '', todo: '' };
function roundMarkers(st, { viewHand = null, hide = null } = {}) {
  return h('ol.brounds', { 'aria-label': 'Hands' }, st.hands.map((hd, n) => {
    const r = roundOf(st, n, { hide });
    const label = `Hand ${n + 1}: ${ROUND_TEXT[r]}`;
    return h(`li.bround.r-${r}${viewHand === n ? '.viewing' : ''}`, { title: label, 'aria-label': label }, h('span', ROUND_ICON[r] || n + 1));
  }));
}

/** Confetti and chips bursting from a point and falling (celebration). */
function confetti({ x = window.innerWidth / 2, y = window.innerHeight * 0.3, count = 110, chips = true } = {}) {
  if (reducedMotion()) return;
  const layer = h('div.fx-layer', { 'aria-hidden': 'true' });
  document.body.append(layer);
  const colors = ['#d9b46a', '#f3e2b4', '#3fbf8f', '#ef5866', '#9cc2ff', '#ffffff', '#b18cff', '#5fe0cf'];
  let longest = 0;
  for (let i = 0; i < count; i++) {
    const chip = chips && i % 7 === 0;
    const p = h(`span.fx-p${chip ? '.fx-chip' : ''}`, { style: chip ? {} : { background: colors[i % colors.length], '--w': `${6 + Math.random() * 6}px`, '--h': `${8 + Math.random() * 10}px` } });
    if (chip) p.append(h('span.chipico'));
    p.style.left = `${x}px`; p.style.top = `${y}px`;
    layer.append(p);
    const ang = Math.random() * Math.PI * 2, pow = 120 + Math.random() * 260;
    const bx = Math.cos(ang) * pow, by = Math.sin(ang) * pow * 0.7 - 120;
    const fall = window.innerHeight - y + 80 + Math.random() * 120;
    const dur = 2200 + Math.random() * 1600, rot = (Math.random() - 0.5) * 1440;
    longest = Math.max(longest, dur);
    p.animate([
      { transform: 'translate(-50%, -50%) scale(0.4) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${bx}px), calc(-50% + ${by}px)) scale(1) rotate(${rot * 0.3}deg)`, opacity: 1, offset: 0.25 },
      { transform: `translate(calc(-50% + ${bx * 1.4 + (Math.random() - 0.5) * 120}px), calc(-50% + ${fall}px)) rotate(${rot}deg)`, opacity: 0.85 },
    ], { duration: dur, delay: Math.random() * 180, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'both' });
  }
  setTimeout(() => layer.remove(), longest + 400);
}

/**
 * The shared start: every player's screen shows the same countdown, ending
 * at the server's start moment. Before the first hand (and when a battle
 * resumes) a big 3 - 2 - 1; between hands the versus lead-in. Resolves at
 * the start moment (a tap hides it earlier; the hand still starts on time).
 */
function startOverlay(st) {
  return new Promise((resolve) => {
    const L = st.live;
    const n = L.hand;
    const big = L.kind !== 'lead';
    const hd = st.hands[n];
    const startsLocal = toLocal(L.startsAt);
    const opps = st.opps;
    const right = opps.length === 1
      ? h('div.vs-side.vs-right', avatar(opps[0].name, 'o1', { big: true }), h('span.vs-name', opps[0].name), h('span.vs-score.num', opps[0].total))
      : h('div.vs-side.vs-right.vs-two', opps.map((o) => h(`div.vs-one.${oc(o)}`, avatar(o.name, oc(o), { big: true }), h('span.vs-name', o.name), h('span.vs-score.num', o.total))));
    const num = h('p.vs-count.num', { 'aria-live': 'assertive' });
    const ov = h(`div.vs-intro${big ? '.vs-first' : ''}${opps.length > 1 ? '.vs-three' : ''}`, { role: 'dialog', 'aria-label': `${big ? (L.kind === 'resume' ? 'The battle resumes. ' : 'Battle start. ') : ''}Hand ${n + 1} of ${st.handCount}` },
      h('div.vs-bg'),
      h('div.vs-stage',
        h('div.vs-side.vs-left', avatar(st.you.name, 'me', { big: true }), h('span.vs-name', st.you.name), h('span.vs-score.num', st.me.total)),
        h('div.vs-mark', h('span', 'VS')),
        right),
      h('div.vs-info',
        h('p.vs-kicker', big ? (L.kind === 'resume' ? 'The battle resumes' : 'Battle start') : (n === st.handCount - 1 ? 'Final hand' : 'Next hand')),
        h('p.vs-hand', `Hand ${n + 1} of ${st.handCount}`, hd?.level ? h(`span.level.lv-${hd.level}`, LEVEL[hd.level]) : null),
        roundMarkers(st, { viewHand: n }),
        num),
      h('p.vs-skip', big ? 'Everybody starts at the same moment' : 'Same moment for everybody · tap to hide'));
    document.body.append(ov);
    const rm = reducedMotion();
    let done = false, last = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(iv);
      ov.classList.add('vs-out');
      setTimeout(() => ov.remove(), rm ? 0 : 260);
    };
    ov.addEventListener('pointerdown', () => { if (!big) finish(); });
    const tick = () => {
      const rem = startsLocal - Date.now();
      if (rem <= 0) {
        if (last !== 0) { last = 0; num.textContent = big ? 'Go!' : ''; if (big) sound.go(); }
        setTimeout(() => { finish(); resolve(); }, big ? 350 : 0);
        clearInterval(iv);
        return;
      }
      const s = Math.min(big ? 3 : 2, Math.ceil(rem / 1000));
      if (s !== last) {
        last = s;
        num.textContent = String(s);
        num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
        if (big) sound.count(s);
      }
    };
    const iv = setInterval(tick, 50);
    setTimeout(() => { if (!done) ov.classList.add('vs-hit'); }, rm ? 0 : 380);
    sound.vs(big);
    tick();
  });
}

// =====================================================================
// Battle home
// =====================================================================
export function battleHome(root, { player }) {
  let data = null, destroyed = false, timer = null, showAllDone = false;
  const lists = h('div.bh-lists');
  const codeIn = h('input.bh-code-in#bh-code', {
    name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '5', placeholder: 'ABCD',
    'aria-label': 'Battle code', inputmode: 'text',
    on: { input: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); } },
  });
  const joinErr = h('p.form-error.bh-err', { role: 'alert' });
  const startBtn = h('button.btn.btn-primary.bh-start', { type: 'button', on: { click: () => start(2, startBtn) } }, h('span.bh-swords', { 'aria-hidden': 'true', html: SWORDS }), 'Start a battle');
  const threeBtn = h('button.btn.bh-three', { type: 'button', on: { click: () => start(3, threeBtn) } }, 'Three-way · 3 players');
  const el = h('section.bhome',
    h('div.bh-hero',
      h('div.bh-hero-text',
        h('p.bh-kicker', 'Battle'),
        h('h1', 'Challenge a friend'),
        h('p.bh-sub', 'Five hands, the same cards for everybody, played live and together: every decision appears for all of you at the same moment and is graded by the solver. Highest total wins.'),
        h('p.bh-rule', '⏱ ', CLOCK_RULE)),
      h('div.bh-actions',
        startBtn,
        h('p.bh-size-note', 'A duel, 2 players. Or a ', threeBtn),
        h('form.bh-join', { on: { submit: join } },
          h('label', { for: 'bh-code' }, 'Join with a code'),
          h('div.bh-join-row', codeIn, h('button.btn', { type: 'submit' }, 'Join')),
          joinErr))),
    lists);
  clear(root).append(el);

  async function start(size, btn) {
    btn.disabled = true;
    try {
      const r = await API.createBattle(size);
      location.hash = `#/battle/${r.battle.id}`;
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  }
  async function join(e) {
    e.preventDefault();
    joinErr.textContent = '';
    const code = codeIn.value.trim();
    if (code.length !== 4) { joinErr.textContent = 'A battle code is 4 letters.'; codeIn.focus(); return; }
    try {
      const r = await API.joinBattleCode(code);
      location.hash = `#/battle/${r.battle.id}`;
    } catch (ex) { joinErr.textContent = ex.message; codeIn.focus(); }
  }
  async function accept(o, btn) {
    btn.disabled = true;
    try { await API.joinBattle(o.id); location.hash = `#/battle/${o.id}`; } catch (e) { toast(e.message, 'error'); btn.disabled = false; load(); }
  }
  async function cancel(id, btn, msg) {
    btn.disabled = true;
    try { await API.cancelBattle(id); toast(msg); load(); } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  }
  const sizeTag = (size) => h(`span.bsize.s${size}`, size === 3 ? 'Three-way' : 'Duel');

  function challengeRow(o) {
    const invite = o.invite === 'you';
    const btn = h('button.btn.btn-primary.btn-sm', { type: 'button', on: { click: (e) => accept(o, e.currentTarget) } }, invite ? 'Accept rematch' : 'Join');
    const sub = o.size === 3 ? `${o.joined.length} of 3 joined${o.joined.length > 1 ? ` (${names(o.joined.map((x) => x.name))})` : ''}` : '';
    return h(`li.bh-row.bh-challenge${invite ? '.bh-invite' : ''}`,
      avatar(o.creator?.name),
      h('div.bh-row-main',
        h('p.bh-row-title', h('b', o.creator?.name || 'Someone'), invite ? ' wants a rematch' : o.size === 3 ? ' started a three-way' : ' is looking for an opponent', ' ', sizeTag(o.size)),
        h('p.bh-row-sub', [sub, agoAt(o.createdAt)].filter(Boolean).join(' · '))),
      h('div.bh-row-act', btn, invite ? h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: (e) => cancel(o.id, e.currentTarget, 'Rematch declined.') } }, 'Decline') : null));
  }

  function scoreBits(b) {
    return h('div.bh-score.num', h('span.me', b.me.total), b.opps.map((o) => [h('span.sep', '–'), h(`span.${oc(o)}`, o.total)]));
  }

  function runningRow(b) {
    const href = `#/battle/${b.id}`;
    if (b.status === 'open') {
      const invite = b.invite === 'them';
      const joined = b.players.length;
      return h('li.bh-row.bh-open',
        h('span.bav.bav-wait', { 'aria-hidden': 'true' }, '?'),
        h('div.bh-row-main',
          h('p.bh-row-title', invite ? ['Rematch sent to ', h('b', names(b.invited.map((x) => x.name)) || b.opponent?.name)] : b.size === 3 ? `Three-way · ${joined} of 3 joined` : 'Waiting for an opponent', ' ', sizeTag(b.size)),
          h('p.bh-row-sub', invite ? `waiting for an answer · ${agoAt(b.createdAt)}` : ['code ', h('b.bh-code-sm', b.code), ` · ${agoAt(b.createdAt)}`])),
        h('div.bh-row-act',
          h('a.btn.btn-sm', { href }, 'Open'),
          b.youCreated ? h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: (e) => cancel(b.id, e.currentTarget, 'Battle cancelled.') } }, 'Cancel') : null));
    }
    const L = b.live;
    const anyOnline = b.opps.some((o) => o.online);
    const where = !L ? '' : L.phase === 'ready' ? 'Ready check' : L.phase === 'done' ? 'Finished' : `Hand ${L.hand + 1} of ${b.handCount}${anyOnline ? ' · live' : ' · resting'}`;
    return h('li.bh-row.bh-active',
      avatar(b.opps[0]?.name, 'o1'),
      h('div.bh-row-main',
        h('p.bh-row-title', 'You vs ', h('b', names(b.opps.map((o) => o.name))), ' ', b.opps.map((o) => onlineDot(o.online, `${o.name} ${o.online ? 'is here' : 'is away'}`)), ' ', sizeTag(b.size)),
        h('p.bh-row-sub', where),
        roundMarkers(b)),
      scoreBits(b),
      h('div.bh-row-act', h('a.btn.btn-sm.btn-primary', { href }, L?.phase === 'ready' ? 'Open' : 'Rejoin')));
  }

  function doneRow(b) {
    const href = `#/battle/${b.id}`;
    if (b.status === 'cancelled') {
      const why = { hands_updated: 'cancelled: the hands were updated', creator: 'cancelled', declined: 'declined' }[b.cancelReason] || 'cancelled';
      return h('li', h('a.bh-row.bh-done.bh-cancelled', { href },
        h('span.bh-res.res-x', '–'),
        h('div.bh-row-main', h('p.bh-row-title', b.opps.length ? ['vs ', h('b', names(b.opps.map((o) => o.name)))] : 'Open challenge', ' ', sizeTag(b.size)), h('p.bh-row-sub', `${why} · ${agoAt(b.cancelledAt)}`)),
        b.joinedAt ? scoreBits(b) : null));
    }
    const word = { win: 'Won', loss: 'Lost', draw: 'Draw', shared: 'Shared 1st', place: ordinal(b.place || 2) }[b.outcome] || '';
    const cls = b.outcome === 'win' || b.outcome === 'shared' ? 'win' : b.outcome === 'draw' ? 'draw' : 'loss';
    return h('li', h(`a.bh-row.bh-done.o-${cls}`, { href },
      h(`span.bh-res.res-${cls}`, word),
      h('div.bh-row-main', h('p.bh-row-title', 'vs ', h('b', names(b.opps.map((o) => o.name))), ' ', sizeTag(b.size)), h('p.bh-row-sub', agoAt(b.finishedAt)), roundMarkers(b)),
      scoreBits(b)));
  }

  function recordBlock(rec) {
    if (!rec.length) return h('p.muted.small', 'Your record against each friend appears here after your first finished battle. In a three-way every pair counts: who finished higher.');
    return h('ul.bh-record', rec.map((r) => {
      const n = r.wins + r.losses + r.draws;
      return h('li.bh-rec',
        avatar(r.opponent.name),
        h('div.bh-rec-main',
          h('p', h('b', r.opponent.name), h('span.muted.small', ` · ${n} battle${n === 1 ? '' : 's'}`)),
          h('div.bh-rec-bar', { 'aria-hidden': 'true' },
            h('span.w', { style: { flex: String(r.wins) } }), h('span.d', { style: { flex: String(r.draws) } }), h('span.l', { style: { flex: String(r.losses) } }))),
        h('p.bh-rec-nums.num', h('b.w', `${r.wins}W`), ' ', h('span.d', `${r.draws}D`), ' ', h('b.l', `${r.losses}L`)));
    }));
  }

  function render() {
    if (!data) return;
    const running = data.battles.filter((b) => b.status === 'open' || b.status === 'active' || (b.status === 'finished' && b.live && b.live.phase !== 'done'));
    const done = data.battles.filter((b) => (b.status === 'finished' && (!b.live || b.live.phase === 'done')) || (b.status === 'cancelled' && b.joinedAt));
    const shownDone = showAllDone ? done : done.slice(0, 8);
    clear(lists).append(
      h('div.bh-grid',
        h('div.bh-col',
          h('section.bh-card', { 'aria-labelledby': 'bh-ch' },
            h('h2#bh-ch', 'Open challenges', data.open.length ? h('span.bh-count', data.open.length) : null),
            data.open.length ? h('ul.bh-list', data.open.map(challengeRow)) : h('p.muted.small', 'Nobody is looking for an opponent right now. Start a battle and send the link.')),
          h('section.bh-card', { 'aria-labelledby': 'bh-run' },
            h('h2#bh-run', 'Your battles'),
            running.length ? h('ul.bh-list', running.map(runningRow)) : h('p.muted.small', 'No battles running.')),
          h('section.bh-card', { 'aria-labelledby': 'bh-done' },
            h('h2#bh-done', 'Finished'),
            done.length ? h('ul.bh-list', shownDone.map(doneRow)) : h('p.muted.small', 'Finished battles appear here, open to review.'),
            done.length > shownDone.length ? h('button.btn.btn-ghost.btn-sm', { type: 'button', on: { click: () => { showAllDone = true; render(); } } }, `Show all ${done.length}`) : null)),
        h('aside.bh-card.bh-h2h', { 'aria-labelledby': 'bh-rec' }, h('h2#bh-rec', 'Head to head'), recordBlock(data.record))));
  }

  let lastSig = '', lastRender = 0;
  async function load() {
    try {
      const next = await API.battles();
      if (destroyed) return;
      const sig = JSON.stringify(next, (k, v) => (k === 'lastSeenAgo' || k === 'serverNow' ? undefined : v));
      data = next;
      if (sig === lastSig && Date.now() - lastRender < 60000) return;
      lastSig = sig; lastRender = Date.now();
      render();
    } catch (e) {
      if (!data) clear(lists).append(h('div.error-box', h('p', e.message), h('button.btn', { type: 'button', on: { click: load } }, 'Try again')));
    }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(async () => { if (!document.hidden) await load(); if (!destroyed) schedule(); }, HOME_POLL_MS); }
  lists.append(h('p.muted.pad', 'Loading…'));
  load().then(schedule);
  return { destroy() { destroyed = true; clearTimeout(timer); } };
}

// =====================================================================
// One battle
// =====================================================================
export function battleScreen(root, { id, nav }) {
  let st = null, sub = null, destroyed = false, timer = null, failures = 0;
  let barTotals = null;       // totals the battle bar shows (they count up at reveal moments)
  let holdTotals = false;     // a hand is being revealed: keep the old totals until the hit
  let overlayFor = null;      // the start moment an overlay is running for
  let readySent = null;       // `${phase}:${hand}:${index}` of the last Ready we sent (optimistic)
  const clockFired = new Set();

  const kindFor = (s) => {
    if (s.outsider) return s.joinable ? 'join' : 'closed';
    if (s.status === 'open') return 'waiting';
    if (s.status === 'cancelled') return 'cancelled';
    const L = s.live;
    if (!L || L.phase === 'done') return 'final';
    if (L.phase === 'ready') return 'readyroom';
    if (L.phase === 'countdown') return 'countdown';
    return 'hand';
  };

  function go(kind, opts = {}) {
    if (destroyed) return;
    sub?.destroy?.();
    sub = null;
    window.scrollTo(0, 0);
    if (kind === 'hand') sub = handView(opts.hand ?? st.live.hand, {});
    else if (kind === 'review') sub = handView(opts.hand, { review: true });
    else sub = { join: joinView, closed: closedView, waiting: waitingView, readyroom: readyRoom, cancelled: cancelledView, final: finalView }[kind]();
    sub.kind = kind;
  }

  /** New battle state (a poll or an action): follow the shared cursor. */
  function apply(next) {
    const prev = st;
    st = next;
    if (destroyed) return;
    const kind = kindFor(st);
    if (kind === 'countdown') {
      // Everybody sees the same countdown, then the hand starts at the shared moment.
      if (overlayFor !== st.live.startsAt) {
        overlayFor = st.live.startsAt;
        const handN = st.live.hand;
        if (sub?.kind !== 'hand' && sub?.kind !== 'readyroom') go('readyroom');
        startOverlay(st).then(() => { if (!destroyed) { holdTotals = false; go('hand', { hand: handN }); } });
      } else sub?.update?.(prev, st);
      return;
    }
    if (!sub) return go(kind);
    if (sub.kind === 'review') { if (kind === 'cancelled') go('cancelled'); return; }
    if (sub.kind === 'hand') {
      if (kind === 'cancelled') { toast(st.cancelReason === 'hands_updated' ? 'The puzzle set was updated, so this battle was ended.' : 'This battle was cancelled.'); return go('cancelled'); }
      if (kind === 'final') return go('final'); // the result appears for everybody together
      if (kind === 'hand' && st.live.hand !== sub.hand) return go('hand'); // joined late: the hand everybody is at
      return sub.update(prev, st);
    }
    if (kind !== sub.kind) return go(kind);
    sub.update(prev, st);
  }

  async function poll() {
    if (destroyed) return;
    try {
      const r = await timed(() => API.battle(id));
      failures = 0;
      if (!destroyed) apply(r.battle);
    } catch (e) {
      failures++;
      if (e.status === 404 || e.status === 403) { showError(e.message); return; }
    }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (destroyed) return;
    timer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : Math.min(POLL_MS * (1 + failures), 6000));
  }
  const onVis = () => { if (!document.hidden && !destroyed) { clearTimeout(timer); poll(); } };
  document.addEventListener('visibilitychange', onVis);

  // One ticker for every clock on the page; your own decision clock ticks and times out.
  const ticker = setInterval(() => {
    for (const el of document.querySelectorAll('.bclock')) {
      paintClock(el);
      if (!el.dataset.mine) continue;
      const rem = Number(el.dataset.deadline) - Date.now();
      const key = el.dataset.deadline;
      const s = Math.ceil(rem / 1000);
      if (rem > 0 && s <= 5 && !clockFired.has(`${key}:${s}`)) { clockFired.add(`${key}:${s}`); sound.tick(s); }
      // the last 5 s: nothing may hide your options (looking back, a full-screen chart)
      if (rem > 0 && rem <= 5000 && !clockFired.has(`${key}:near`)) { clockFired.add(`${key}:near`); sub?.clockUrgent?.(); }
      if (rem <= 0 && !clockFired.has(`${key}:up`)) { clockFired.add(`${key}:up`); sound.timeUp(); el.closest('.actionbar')?.classList.add('timeup'); }
      if (rem <= -((st?.timing?.graceMs || 1500) + 300) && !clockFired.has(`${key}:ask`)) { clockFired.add(`${key}:ask`); sub?.timeUp?.(); }
    }
  }, 100);

  function showError(msg) {
    document.body.dataset.screen = 'battle';
    clear(root).append(h('div.error-box', h('p', msg), h('a.btn', { href: '#/battle' }, 'Battles')));
  }

  async function sendReady(on = true) {
    const L = st.live;
    const key = `${L.phase}:${L.hand}:${L.index}:${on}`;
    if (readySent === key) return;
    readySent = key;
    // optimistic: show it at once
    if (on && !L.ready.includes(st.you.id)) L.ready = [...L.ready, st.you.id];
    if (!on) L.ready = L.ready.filter((x) => x !== st.you.id);
    sub?.update?.(st, st);
    try { apply((await timed(() => API.battleReady(id, on))).battle); } catch (e) { readySent = null; toast(e.message, 'error'); poll(); }
  }

  // ---------- join confirm (a link or a rematch invite) ----------
  function joinView() {
    document.body.dataset.screen = 'battle';
    document.title = 'Battle · PokerPuzzles';
    const invite = st.invite === 'you';
    const three = st.size === 3;
    const btn = h('button.btn.btn-primary.big-continue.bj-accept', { type: 'button', on: { click: accept } }, invite ? 'Accept the rematch' : three ? 'Join the three-way' : 'Accept the battle');
    async function accept() {
      btn.disabled = true;
      try { const r = await timed(() => API.joinBattle(id)); apply(r.battle); } catch (e) { toast(e.message, 'error'); btn.disabled = false; poll(); }
    }
    async function decline(e) {
      e.currentTarget.disabled = true;
      try { await API.cancelBattle(id); toast('Rematch declined.'); location.hash = '#/battle'; } catch (ex) { toast(ex.message, 'error'); }
    }
    const joined = (st.joined || []).map((x) => x.name);
    const others = (st.others || []).map((x) => x.name);
    clear(root).append(h('section.bstage',
      h('div.bcard.bjoin',
        h('div.bj-face', joined.map((n, i) => avatar(n, i ? 'o2' : 'o1', { big: true })), h('span.bj-vs', 'VS'), avatar(session()?.player?.name || 'You', 'me', { big: true })),
        h('p.bh-kicker', invite ? 'Rematch' : three ? 'Three-way battle' : 'Battle'),
        h('h1', h('span.opp-name', st.creator?.name || 'Someone'), invite ? ' wants a rematch' : three ? ' started a three-way' : ' challenges you'),
        three && !invite ? h('p.bj-seats', `${joined.length} of 3 joined: ${names(joined)}. ${3 - joined.length} seat${3 - joined.length === 1 ? '' : 's'} left.`) : null,
        invite && others.length ? h('p.bj-seats', `Also invited: ${names(others)}.`) : null,
        h('ul.bj-rules',
          h('li', h('b', `${st.handCount} hands`), ', the same cards for everybody, played live and together.'),
          h('li', 'Every decision appears for all of you at the same moment and is graded by the solver, 0–100 per hand.'),
          h('li', CLOCK_RULE),
          h('li', 'After each decision you see everybody\'s pick. Highest total wins.')),
        btn,
        h('div.bj-more', invite ? h('button.btn.btn-ghost', { type: 'button', on: { click: decline } }, 'Decline') : null, h('a.btn.btn-ghost', { href: '#/battle' }, 'Not now')))));
    btn.focus({ preventScroll: true });
    return { update() {}, destroy() {} };
  }

  function closedView() {
    document.body.dataset.screen = 'battle';
    const msg = st.status === 'cancelled'
      ? (st.cancelReason === 'hands_updated' ? 'This battle was ended because the hands were updated.' : st.cancelReason === 'declined' ? 'This rematch was declined.' : 'This battle was cancelled.')
      : st.invite === 'them' ? 'This rematch is for someone else.' : 'This battle is already full or has started.';
    clear(root).append(h('section.bstage', h('div.bcard', h('p.bh-kicker', 'Battle'), h('h1', msg),
      h('div.bj-more', h('a.btn.btn-primary', { href: '#/battle' }, 'Start your own battle')))));
    return { update() {}, destroy() {} };
  }

  // ---------- waiting room (not full yet) ----------
  function waitingView() {
    document.body.dataset.screen = 'battle';
    const el = h('section.bstage');
    clear(root).append(el);
    let lastSig = '';
    function render() {
      const s = st;
      const invite = s.inviteOnly;
      const sig = JSON.stringify([s.players, s.invited, s.declined, s.canStart]);
      if (sig === lastSig) return;
      lastSig = sig;
      document.title = invite ? 'Rematch · PokerPuzzles' : `Battle ${s.code} · PokerPuzzles`;
      const link = battleLink(id);
      const linkIn = h('input.bw-link', { value: link, readonly: true, 'aria-label': 'Battle link', on: { focus: (e) => e.target.select() } });
      const others = s.players.filter((p) => p.id !== s.you.id);
      const seats = [];
      others.forEach((p, i) => seats.push(h('div.bw-seat.in', avatar(p.name, i ? 'o2' : 'o1', { big: true }), h('span', p.name), h('small', 'joined'))));
      s.invited.forEach((p) => seats.push(h('div.bw-seat.invited', h('span.bw-ghost', avatar(p.name, others.length ? 'o2' : 'o1', { big: true })), h('span', p.name), h('small', 'not answered yet'))));
      s.declined.forEach((p) => seats.push(h('div.bw-seat.declined', avatar(p.name, 'wait', { big: true }), h('span', p.name), h('small', 'declined'))));
      for (let k = seats.length; k < s.size - 1; k++) seats.push(h('div.bw-seat.empty', h('span.bav.bav-wait.bav-big', '?'), h('span', 'open seat'), h('small', 'waiting')));
      const need = s.size - s.players.length;
      const startBtn = s.canStart ? h('button.btn.btn-primary.bw-startwith', {
        type: 'button',
        on: { click: async (e) => { e.currentTarget.disabled = true; try { apply((await timed(() => API.beginBattle(id))).battle); } catch (ex) { toast(ex.message, 'error'); e.currentTarget.disabled = false; } } },
      }, `Start with ${s.players.length}`) : null;
      clear(el).append(h('div.bcard.bwait',
        h('p.bh-kicker', invite ? 'Rematch' : s.size === 3 ? 'Three-way · waiting room' : 'Your battle is open'),
        invite ? h('h1', 'Waiting for ', h('span.opp-name', names(s.invited.map((p) => p.name)) || 'the others'), ' to accept')
          : h('h1', s.size === 3 ? 'Send the code or the link to two friends' : 'Send the code or the link to a friend'),
        invite ? null : h('div.bw-code', { 'aria-label': `Battle code ${s.code.split('').join(' ')}` }, s.code.split('').map((c, i) => h('span.bw-tile', { style: { '--i': String(i) } }, c))),
        invite ? null : h('div.bw-linkrow', linkIn,
          h('button.btn.btn-primary', { type: 'button', on: { click: () => copyText(link, linkIn) } }, 'Copy link'),
          navigator.share ? h('button.btn', { type: 'button', on: { click: () => navigator.share({ title: 'PokerPuzzles battle', text: `Battle me on PokerPuzzles, code ${s.code}`, url: link }).catch(() => {}) } }, 'Share') : null),
        h('div.bw-seats',
          h('div.bw-seat.in.you', h('div.bw-radar', { 'aria-hidden': 'true' }, h('span.ring'), h('span.ring.r2'), h('span.ring.r3'), avatar(s.you.name, 'me', { big: true })), h('span', 'You'), h('small', s.youCreated ? 'host' : 'joined')),
          seats),
        h('p.bw-status', { role: 'status' },
          need > 0 ? (s.size === 3 ? `${s.players.length} of 3 joined · waiting for ${need === 1 ? 'one more' : 'two more'}` : 'Waiting for an opponent') : 'Everybody is here',
          h('span.bw-dots', h('i'), h('i'), h('i'))),
        startBtn ? h('div.bw-startrow', startBtn, h('span.muted.small', invite ? 'Go on with whoever has accepted.' : 'Nobody has to wait for a third player.')) : null,
        !s.youCreated ? h('p.muted.small', `${s.creator.name} can start with the players who are here.`) : null,
        h('p.muted.small.bw-note', 'When everybody is in, there is a ready check and then a 3-2-1: the battle is played live. ', CLOCK_RULE),
        s.youCreated ? h('button.btn.btn-ghost', {
          type: 'button',
          on: { click: async (e) => { e.currentTarget.disabled = true; try { await API.cancelBattle(id); toast(invite ? 'Rematch withdrawn.' : 'Battle cancelled.'); location.hash = '#/battle'; } catch (ex) { toast(ex.message, 'error'); poll(); } } },
        }, invite ? 'Withdraw the rematch' : 'Cancel the battle') : null));
    }
    render();
    return { update(prev, next) { if (prev && next.players.length > prev.players.length) sound.readyPing(); render(); }, destroy() {} };
  }

  // ---------- ready check ----------
  function readyRoom() {
    document.body.dataset.screen = 'battle';
    document.title = 'Ready check · PokerPuzzles';
    const el = h('section.bstage');
    clear(root).append(el);
    let lastSig = '';
    function render() {
      const s = st;
      const L = s.live;
      const sig = JSON.stringify([L.phase, L.ready, s.opps.map((o) => o.online)]);
      if (sig === lastSig) return;
      lastSig = sig;
      const meReady = L.ready.includes(s.you.id);
      const resume = L.started;
      const toggle = h(`button.btn.big-continue.br-toggle${meReady ? '.btn-ghost.on' : '.btn-primary'}`, {
        type: 'button', 'aria-pressed': String(meReady), disabled: L.phase !== 'ready',
        on: { click: () => sendReady(!meReady) },
      }, meReady ? 'Ready ✓ · tap to take it back' : 'Ready', meReady ? null : h('kbd', 'Enter'));
      const playerRow = (name, who, ready, online, you = false) => h(`div.br-player${ready ? '.ready' : ''}`,
        avatar(name, who, { big: true }), h('span.br-name', you ? 'You' : name),
        h('span.br-state', ready ? '✓ Ready' : online || you ? 'not ready yet' : 'offline'));
      clear(el).append(h('div.bcard.bready',
        h('p.bh-kicker', resume ? 'The battle resumes' : s.size === 3 && s.players.length === 3 ? 'Three-way · ready check' : 'Ready check'),
        h('h1', resume ? 'Ready to go on?' : 'Ready?'),
        h('div.br-players', playerRow(s.you.name, 'me', meReady, true, true), s.opps.map((o) => playerRow(o.name, oc(o), L.ready.includes(o.id), o.online))),
        toggle,
        h('ul.bj-rules',
          h('li', 'When everybody is ready, a 3 - 2 - 1 counts down and hand 1 starts for all of you at the same moment.'),
          h('li', CLOCK_RULE),
          h('li', 'After each decision the hand goes on when everybody has pressed Continue (or 30 seconds after the first did).')),
        s.canCancel ? h('button.btn.btn-ghost', {
          type: 'button',
          on: { click: async (e) => { e.currentTarget.disabled = true; try { await API.cancelBattle(id); toast('Battle cancelled.'); location.hash = '#/battle'; } catch (ex) { toast(ex.message, 'error'); poll(); } } },
        }, 'Cancel the battle') : null));
      if (!meReady) toggle.focus({ preventScroll: true });
    }
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || /input|textarea|button|a/i.test(e.target.tagName)) return;
      if (st.live?.phase === 'ready' && !st.live.ready.includes(st.you.id)) { e.preventDefault(); sendReady(true); }
    };
    document.addEventListener('keydown', onKey);
    render();
    return {
      update(prev, next) {
        if (prev?.live && next.live && next.live.ready.length > prev.live.ready.length) sound.readyPing();
        render();
      },
      destroy() { document.removeEventListener('keydown', onKey); },
    };
  }

  // ---------- cancelled (as a player) ----------
  function cancelledView() {
    document.body.dataset.screen = 'battle';
    document.title = 'Battle cancelled · PokerPuzzles';
    const o = names(st.opps.map((x) => x.name));
    const msg = {
      hands_updated: 'The puzzle set was updated while this battle was running, so it was ended. Scores of finished hands stay in your stats.',
      creator: st.youCreated ? 'You cancelled this battle before it started.' : `${st.creator.name} cancelled this battle.`,
      declined: st.youCreated ? 'The rematch was declined.' : 'You declined this rematch.',
    }[st.cancelReason] || 'This battle was cancelled.';
    const again = st.joinedAt && st.opps.length ? h('button.btn.btn-primary', {
      type: 'button',
      on: { click: async (e) => { e.currentTarget.disabled = true; try { const r = await API.rematch(id); location.hash = `#/battle/${r.battle.id}`; } catch (ex) { toast(ex.message, 'error'); } } },
    }, `New battle with ${o}`) : h('a.btn.btn-primary', { href: '#/battle' }, 'Start a new battle');
    clear(root).append(h('section.bstage', h('div.bcard',
      h('p.bh-kicker', 'Battle cancelled'),
      h('h1', st.cancelReason === 'hands_updated' ? 'The hands were updated' : 'No battle this time'),
      h('p.bc-msg', msg),
      st.joinedAt && st.opps.length ? h('div.bc-partial', h('p.muted.small', 'Score when it ended'), scoreLine(st), roundMarkers(st)) : null,
      h('div.bj-more', again, h('a.btn.btn-ghost', { href: '#/battle' }, 'Battles')))));
    return { update() {}, destroy() {} };
  }

  function scoreLine(s, { big = false } = {}) {
    return h(`div.bscore${big ? '.bscore-big' : ''}`,
      h('div.bs-side.bs-me', avatar(s.you.name, 'me', { big }), h('span.bs-name', s.you.name), h('b.bs-num.num', s.me.total)),
      s.opps.map((o) => [h('span.bs-sep', '–'), h(`div.bs-side.bs-opp.${oc(o)}`, h('b.bs-num.num', o.total), h('span.bs-name', o.name), avatar(o.name, oc(o), { big }))]));
  }

  // ---------- a hand (the play screen in battle mode) ----------
  function handView(n, { review = false } = {}) {
    document.body.dataset.screen = 'play';
    const hv = { hand: n, revealed: false, sig: null, hitDone: false, seenPicks: new Set(), fresh: new Set() };
    const L0 = () => st.live || {};
    const myAnsweredAt = (i) => !!st.hands[n]?.me.choices?.some((c) => c.index === i);
    const pickOf = (oi, i) => st.hands[n]?.opps[oi]?.choices?.find((c) => c.index === i) || null;
    const myChoice = (i) => st.hands[n]?.me.choices?.find((c) => c.index === i) || null;
    const sigOf = (s) => { const x = s.hands[n]; return x ? JSON.stringify([x.opps.map((o) => [o.choices?.length, o.score]), x.outcome]) : ''; };
    hv.sig = sigOf(st);
    for (const [oi, o] of (st.hands[n]?.opps || []).entries()) for (const c of o.choices || []) hv.seenPicks.add(`${oi}:${c.index}`);
    if (!barTotals) barTotals = { me: st.me.total, opps: st.opps.map((o) => o.total) };
    document.title = `Battle · Hand ${n + 1}/${st.handCount} · PokerPuzzles`;
    // "Others on this hand" only when the hand is opened again in review: the live battle already
    // shows the opponents. The opponents of this battle are left out (they have their own columns).
    const others = review ? { loading: true, data: null, error: null, open: null, all: false } : null;
    const othersExclude = new Set(st.opps.map((o) => o.id));
    if (review && st.hands[n]?.puzzle?.id) {
      API.others(st.hands[n].puzzle.id).then((data) => { Object.assign(others, { loading: false, data }); },
        (e) => { Object.assign(others, { loading: false, error: e.status === 403 ? e.message : 'Could not load what the others did.' }); })
        .finally(() => { if (!destroyed && sub === me) screen.refreshBattle({ changed: true }); });
    }

    const hooks = {
      start: async () => timed(async () => { const r = await API.battleStart(id, n); st = r.battle; hv.sig = sigOf(st); return r; }),
      act: async (i, optionId) => {
        for (let tries = 0; ; tries++) {
          try {
            const r = await timed(() => API.battleAct(id, n, i, optionId));
            st = r.battle;
            hv.sig = sigOf(st);
            return r;
          } catch (e) {
            // a time-out the server does not see yet: try again when it should
            if (optionId === null && e.status === 409 && e.data?.retryInMs && tries < 5) { await new Promise((res) => setTimeout(res, e.data.retryInMs)); continue; }
            throw e;
          }
        }
      },
      renderTop: (top, v) => renderBar(top, v),
      oppPick: (i) => st.opps.map((o, oi) => { const c = pickOf(oi, i); return c && !c.timeout ? { optionId: c.optionId, name: o.name, color: o.color, fresh: hv.fresh.has(`${oi}:${i}`) } : null; }).filter(Boolean),
      decorateFeedback: (fb, rv) => {
        fb.querySelector('.duel-picks')?.remove();
        fb.querySelector('.fb-head')?.after(h('div.duel-picks', st.opps.map((o, oi) => oppLine(o, oi, rv))));
      },
      decorateBar: (slots, phase, ctx) => decorateBar(slots, phase, ctx),
      endPanel: (v) => duelPanel(v),
      onHandEnd: ({ animated }) => { if (!animated) { holdTotals = false; screen.refreshBattle(); } },
      onDeciding: () => {},
      onContinue: () => sendReady(true),
      onTimeUp: () => {},
      onLoadError: (e) => {
        // a moment too early for the server (clock difference): load the hand again
        if (e.status === 409 && !review) { setTimeout(() => { if (!destroyed && sub === me && st.live?.hand === n) go('hand', { hand: n }); else poll(); }, 600); return true; }
        return false;
      },
      // Coming back to a decision that opened a while ago (reload, reconnect): no deal animation while the clock runs.
      rejoining: () => { const L = st.live; return !!L && L.phase !== 'countdown' && L.decideAt && Date.now() - toLocal(L.decideAt) > 4000; },
      barSig: () => { const L = st.live || {}; return JSON.stringify([L.phase, L.hand, L.index, L.deadline, L.answered, L.ready, L.autoAt, st.opps.map((o) => o.online)]); },
      // The shared cursor as the play screen compares it: looking back returns to now when it moves or somebody answers.
      liveState: () => { const L = st.live || {}; return { phase: L.phase, hand: L.hand, index: L.index, deadline: L.deadline || null, answered: (L.answered || []).length }; },
      // Somebody may still be answering a decision of this hand: no "Copy for Claude" meanwhile.
      decisionOpen: () => { if (review) return false; const L = st.live || {}; return L.phase === 'decide' && L.hand === n; },
    };
    const screen = playScreen(root, { id, mode: 'battle', nav, battle: hooks });

    // --- the battle bar (in place of the title row) ---
    function renderBar(top, v) {
      const s = st;
      const shown = holdTotals ? barTotals : { me: s.me.total, opps: s.opps.map((o) => o.total) };
      top.classList.add('battle-top');
      const meDots = Object.values(v.reveals || {}).sort((a, b) => a.index - b.index).map((rv) => {
        const i = rv.index;
        const label = `Your decision ${i + 1}: ${GRADE_LABEL[rv.grade]}`;
        const dot = h(`span.bb-dot.g-${rv.grade}${v.phase === 'end' && v.sel === i ? '.current' : ''}`, { title: label, 'aria-label': label }, GRADE_ICON[rv.grade]);
        return v.phase === 'end' ? h('button.dot-btn', { type: 'button', on: { click: () => v.select(i) }, 'aria-label': `Show decision ${i + 1}` }, dot) : dot;
      });
      const meTot = h('b.bb-total.num', shown.me);
      const oppTots = [];
      const oppBlock = (o, oi) => {
        const ho = s.hands[n]?.opps[oi];
        const stt = statusOf(s, o);
        // one dot per answered decision, never placeholders
        const dots = Array.from({ length: ho?.answered || 0 }, (_, i) => {
          const c = ho.choices?.find((x) => x.index === i);
          const label = c ? `${o.name}, decision ${i + 1}: ${GRADE_LABEL[c.grade]}` : `${o.name} answered decision ${i + 1}`;
          return h(`span.bb-dot.opp.${oc(o)}${c ? `.g-${c.grade}` : '.answered'}`, { title: label, 'aria-label': label }, c ? GRADE_ICON[c.grade] : '');
        });
        const tot = h('b.bb-total.num', shown.opps[oi] ?? o.total);
        oppTots.push([tot, oi]);
        const status = h('span.bb-status', { title: stt.text },
          stt.clock && !review ? [clockEl(stt.clock, { total: s.timing.clockMs, mini: true }), o.online ? null : h('span.bb-off', ' · offline')] : [h('span.long', stt.text), h('span.short', stt.short)]);
        return { tot, dots, status, stt };
      };
      let oppsEl;
      if (s.opps.length === 1) {
        const o = s.opps[0];
        const b = oppBlock(o, 0);
        oppsEl = h('div.bb-side.bb-opp.o1',
          b.tot,
          h('div.bb-who', h('span.bb-name', onlineDot(o.online, o.online ? 'here now' : 'offline'), o.name), b.status, h('span.bb-dots', { 'aria-label': `${o.name}'s decisions this hand` }, b.dots)),
          avatar(o.name, 'o1'));
      } else {
        oppsEl = h('div.bb-opps', s.opps.map((o, oi) => {
          const b = oppBlock(o, oi);
          return h(`div.bb-orow.${oc(o)}`, avatar(o.name, oc(o)),
            h('div.bb-who', h('span.bb-name', onlineDot(o.online, o.online ? 'here now' : 'offline'), o.name, h('span.bb-dots', b.dots)), b.status),
            b.tot);
        }));
      }
      const bbar = h(`div.bbar${s.opps.length > 1 ? '.three' : ''}`, { role: 'group', 'aria-label': `Battle: you ${shown.me}, ${s.opps.map((o, oi) => `${o.name} ${shown.opps[oi]}`).join(', ')}` },
        h('a.bb-back', { href: '#/battle', 'aria-label': 'All battles', title: 'All battles' }, '←'),
        h('div.bb-side.bb-me',
          avatar(s.you.name, 'me'),
          h('div.bb-who', h('span.bb-name', s.you.name), h('span.bb-dots', { 'aria-label': 'Your decisions this hand' }, meDots)),
          meTot),
        h('div.bb-mid',
          roundMarkers(s, { viewHand: n, hide: holdTotals ? n : null }),
          h('p.bb-hand', { title: v.puzzle ? `#${v.puzzle.number} ${v.puzzle.title} · ${v.puzzle.scenario.name}` : '' },
            h('b', `Hand ${n + 1}/${s.handCount}`), review ? ' · review' : '', v.puzzle ? h('span.bb-title', ` · ${v.puzzle.title}`) : null)),
        oppsEl);
      const old = top.querySelector('.bbar');
      const moved = !holdTotals && (barTotals.me !== shown.me || shown.opps.some((t, i) => barTotals.opps[i] !== t));
      if (old && !moved && old.innerHTML.replace(/<b class="bc-num[^<]*<\/b>/g, '') === bbar.innerHTML.replace(/<b class="bc-num[^<]*<\/b>/g, '')) return;
      clear(top).append(bbar);
      if (!holdTotals) {
        countTo(meTot, barTotals.me, shown.me);
        if (barTotals.me !== shown.me) meTot.classList.add('bump');
        for (const [el, oi] of oppTots) { countTo(el, barTotals.opps[oi], shown.opps[oi]); if (barTotals.opps[oi] !== shown.opps[oi]) el.classList.add('bump'); }
        barTotals = { me: shown.me, opps: shown.opps.slice() };
      }
    }

    // --- everybody's pick on the feedback panel ---
    function oppLine(o, oi, rv) {
      const c = pickOf(oi, rv.index);
      const fresh = hv.fresh.has(`${oi}:${rv.index}`);
      if (c?.timeout) {
        return h(`div.duel-pick.${oc(o)}.timedout${fresh ? '.fresh' : ''}`, avatar(o.name, oc(o)),
          h('div.dp-main', h('p.dp-line', h('b.opp-name', o.name), ' ran out of time'), h('p.dp-grade', gradeBadge('timeout', { small: true }), h('b.num', ' 0'), ' pts')));
      }
      if (c) {
        const same = c.optionId === rv.choice;
        const diff = Math.round(rv.points) - Math.round(c.points);
        return h(`div.duel-pick.${oc(o)}${fresh ? '.fresh' : ''}`,
          avatar(o.name, oc(o)),
          h('div.dp-main',
            h('p.dp-line', h('b.opp-name', o.name), ' chose ', h('b', c.label), same ? h('span.dp-same', 'same as you') : null),
            h('p.dp-grade', gradeBadge(c.grade, { small: true }), h('b.num', ` ${Math.round(c.points)}`), ' pts',
              rv.timeout ? null : h(`span.dp-diff${diff > 0 ? '.up' : diff < 0 ? '.down' : ''}`, diff === 0 ? 'level' : diff > 0 ? `you +${diff}` : `you ${diff}`))));
      }
      const L = L0();
      const stt = statusOf(st, o);
      const open = L.phase === 'decide' && L.hand === n && L.index === rv.index;
      return h(`div.duel-pick.pending.${oc(o)}`,
        avatar(o.name, oc(o)),
        h('div.dp-main',
          h('p.dp-line', h('b.opp-name', o.name), open ? ' has not decided yet' : ' —', open ? h('span.bw-dots', h('i'), h('i'), h('i')) : null),
          h('p.dp-status', open && L.deadline ? [clockEl(L.deadline, { total: st.timing.clockMs, mini: true }), ` left · ${stt.text}`] : stt.text)));
    }

    // --- clocks, waiting states and the shared Continue / Next hand in the action bar ---
    function decorateBar({ top, mid, bottom }, phase, { pending, looking = false }) {
      const L = L0();
      const s = st;
      if (looking) {
        // Looking back: the clock that runs stays in view, in the bar's top line (the rest waits for the return).
        if (review || L.hand !== n) return;
        let clock = null;
        if (phase === 'deciding' && L.phase === 'decide' && L.deadline) clock = clockEl(L.deadline, { total: s.timing.clockMs, mine: true });
        else if (phase === 'feedback' && L.phase === 'decide' && L.deadline) clock = clockEl(L.deadline, { total: s.timing.clockMs, label: 'left for the others' });
        else if (((phase === 'feedback' && L.phase === 'review') || (phase === 'end' && L.phase === 'handEnd')) && L.autoAt) clock = clockEl(L.autoAt, { total: s.timing.autoMs, calm: true, label: 'until it goes on' });
        if (clock) (top.querySelector('.rw-top') || top).append(h('div.rw-clock', clock));
        return;
      }
      const meReady = L.ready?.includes(s.you.id);
      const notMe = (ids) => s.opps.filter((o) => !ids.includes(o.id));
      const waitBlock = (text, clock) => h('div.bwaitbar', { role: 'status' }, h('span.bwait-text', text, h('span.bw-dots', h('i'), h('i'), h('i'))), clock);
      const bigBtn = (label, onClick) => h('button.btn.btn-primary.big-continue.bar-in', { type: 'button', on: { click: onClick } }, label, h('kbd', 'Enter'));
      if (review) {
        if (phase === 'end') clear(bottom).append(h('div.end-bar', bigBtn('Back to the result', () => go('final'))));
        return;
      }
      if (phase === 'deciding') {
        if (L.phase === 'decide' && L.deadline) {
          const prompt = top.querySelector('.bar-prompt');
          clear(top).append(h('div.bclock-row', prompt, clockEl(L.deadline, { total: s.timing.clockMs, mine: true, label: `${L.firstBy} answered` })));
        } else if (L.phase === 'decide') {
          top.querySelector('.bar-prompt')?.append(h('span.bhint', ' · the first answer starts a 20 s clock'));
        }
      } else if (phase === 'feedback') {
        const last = pending?.next === null;
        if (L.phase === 'decide' && L.hand === n) {
          const waiting = notMe(L.answered || []);
          clear(bottom).append(waitBlock(`Waiting for ${names(waiting.map((o) => o.name))} to answer`,
            L.deadline ? clockEl(L.deadline, { total: s.timing.clockMs, label: 'left' }) : null));
        } else if (L.phase === 'review' && L.hand === n) {
          const autoClock = L.autoAt ? clockEl(L.autoAt, { total: s.timing.autoMs, calm: true, label: 'until it goes on' }) : null;
          if (!meReady) {
            clear(bottom).append(bigBtn(last ? 'Finish hand' : 'Continue', () => sendReady(true)));
            const readyOnes = s.opps.filter((o) => L.ready.includes(o.id));
            if (readyOnes.length && autoClock) clear(top).append(h('div.bclock-row.calm', h('span.bready-note', `${names(readyOnes.map((o) => o.name))} ${readyOnes.length > 1 ? 'are' : 'is'} ready`), autoClock));
          } else {
            const waiting = notMe(L.ready);
            clear(bottom).append(waitBlock(`Waiting for ${names(waiting.map((o) => o.name))} to finish reading`, autoClock));
          }
        } else {
          clear(bottom).append(waitBlock('The hand goes on', null));
        }
      } else if (phase === 'end') {
        let el;
        if (L.phase === 'handEnd' && L.hand === n) {
          const autoClock = L.autoAt ? clockEl(L.autoAt, { total: s.timing.autoMs, calm: true, label: 'until it goes on' }) : null;
          const lastHand = n === s.handCount - 1;
          if (!meReady) el = bigBtn(lastHand ? 'See the result' : `Next hand · ${n + 2} of ${s.handCount}`, () => sendReady(true));
          else el = waitBlock(`Waiting for ${names(notMe(L.ready).map((o) => o.name))}`, autoClock);
          if (!meReady && autoClock) {
            const readyOnes = s.opps.filter((o) => L.ready.includes(o.id));
            if (readyOnes.length) top.append(h('div.bclock-row.calm', h('span.bready-note', `${names(readyOnes.map((o) => o.name))} ${readyOnes.length > 1 ? 'are' : 'is'} ready`), autoClock));
          }
        } else if (L.phase === 'countdown') el = waitBlock('The next hand is starting', null);
        else if (L.phase === 'done' || s.status === 'finished') el = bigBtn('See the result', () => go('final'));
        else el = waitBlock('…', null);
        clear(bottom).append(h('div.end-bar', el));
      }
    }

    // --- the duel panel at the end of the hand ---
    function duelPanel(v) {
      const hd = st.hands[n];
      const rs = Object.values(v.reveals).sort((a, b) => a.index - b.index);
      const animate = v.animated && !hv.revealed;
      const myScore = hd.me.score ?? v.end?.score ?? null;
      const out = hd.outcome;
      const winners = (hd.winners || []).map((wid) => (wid === st.you.id ? 'you' : st.opps.find((o) => o.id === wid)?.name));
      let bannerText = '';
      if (out === 'won') bannerText = 'You take this hand';
      else if (out === 'tied') bannerText = `Shared: ${names(winners.map((w) => (w === 'you' ? 'you' : w)))}`;
      else if (out === 'lost') bannerText = `${names(winners)} ${winners.length > 1 ? 'share' : 'takes'} this hand`;
      const place = st.opps.length > 1 && hd.place ? h('span.duel-place', `You: ${ordinal(hd.place)} in this hand`) : null;
      const banner = out
        ? h(`p.duel-banner.o-${out}${hv.hitDone || !animate ? '.shown' : ''}`, bannerText, place)
        : h('p.duel-banner.waiting', 'Waiting for the scores', h('span.bw-dots', h('i'), h('i'), h('i')));
      const meNum = h('b.dh-num.num', animate ? 0 : myScore);
      const oppNums = st.opps.map((o, oi) => h('b.dh-num.num', hd.opps[oi].score === null ? '…' : animate ? 0 : hd.opps[oi].score));
      const head = h(`div.duel-head${out ? `.o-${out}` : ''}${st.opps.length > 1 ? '.three' : ''}`,
        h('div.dh-side.dh-me', avatar(st.you.name, 'me'), h('span.dh-name', 'You'), meNum),
        h('div.dh-mid', h('span.dh-hand', `Hand ${n + 1}`), h('span.dh-vs', 'vs')),
        st.opps.map((o, oi) => h(`div.dh-side.dh-opp.${oc(o)}`, oppNums[oi], h('span.dh-name', o.name), avatar(o.name, oc(o)))));
      const step = v.steps.at(-1);
      const sd = step?.showdown;
      const cols = st.opps.length + 1;
      const rows = rs.map((r, k) => {
        const on = r.index === v.sel;
        const mine = myChoice(r.index);
        const g = mine?.grade ?? r.grade, pts = mine?.points ?? r.points;
        const cell = (c, cls) => (c ? h(`span.dr-pick.${cls}${c.timeout ? '.dr-to' : ''}`, h(`span.dr-g.g-${c.grade}`, GRADE_ICON[c.grade]), h('span.dr-label', c.timeout ? 'ran out of time' : c.label), h('b.dr-pts.num', Math.round(c.points)))
          : h(`span.dr-pick.${cls}.dr-wait`, h('span.dr-label', '—')));
        return h(`button.duel-row${on ? '.on' : ''}.c${cols}`, {
          type: 'button', role: 'tab', 'aria-selected': String(on), tabindex: on ? '0' : '-1', style: { '--i': String(k) },
          'aria-label': `${STREETS[r.decision.street]}: you ${r.choiceLabel}, ${GRADE_LABEL[g]} ${Math.round(pts)}; ${st.opps.map((o, oi) => { const c = pickOf(oi, r.index); return c ? `${o.name} ${c.timeout ? 'ran out of time' : c.label}, ${Math.round(c.points)}` : `${o.name} -`; }).join('; ')}`,
          on: { click: () => v.select(r.index) },
        },
        h('span.dr-street', STREETS[r.decision.street]),
        cell({ grade: g, points: pts, label: r.choiceLabel, timeout: r.timeout }, 'dr-me'),
        st.opps.map((o, oi) => cell(pickOf(oi, r.index), `dr-opp.${oc(o)}`)));
      });
      const end = v.end;
      const tags = end?.tags || v.puzzle.tags || [];
      const more = h('details.end-more',
        h('summary', h('span.end-more-text', end?.takeaway ? ['Takeaway: ', end.takeaway] : 'Takeaway'), h('span.end-more-friends', `#${v.puzzle.number}`)),
        end?.takeaway ? setLinkedText(h('p.end-takeaway'), end.takeaway) : null,
        tags.length ? tagChips(h('p.end-tags'), tags) : null,
        h('p.end-result', v.endLine()),
        sd ? h('p.end-showdown',
          h('span', h('span.muted', 'You '), v.puzzle.hero.hand.map(cardText), sd.heroHandName ? ` ${sd.heroHandName}` : ''),
          h('span', h('span.muted', 'Villain '), sd.villainHand.map(cardText), sd.villainHandName ? ` ${sd.villainHandName}` : '')) : null);
      const rv = v.reveals[v.sel];
      let detail = null;
      if (rv) {
        const mine = myChoice(rv.index);
        detail = h('div.end-detail',
          h('div.end-detail-head',
            gradeBadge(mine?.grade ?? rv.grade, { small: true }), h('span.num.end-detail-pts', `${Math.round(mine?.points ?? rv.points)} pts`), choiceLine(rv),
            h('div.dp-opp-lines', st.opps.map((o, oi) => {
              const c = pickOf(oi, rv.index);
              return h(`p.fb-choice.dp-opp-line.${oc(o)}`, h('b.opp-name', o.name),
                c ? (c.timeout ? [' ran out of time · ', gradeBadge('timeout', { small: true }), ' 0 pts'] : [' chose ', h('b', c.label), ' · ', gradeBadge(c.grade, { small: true }), ` ${Math.round(c.points)} pts`, c.optionId === rv.choice ? h('span.dp-same', 'same as you') : null])
                  : ' —');
            })),
            review ? othersHere(others, rv.index, { exclude: othersExclude }) : null),
          ...decisionBody(rv, v.puzzle, { onCopy: v.canCopy ? () => v.copy(rv.index) : null }));
      }
      const panel = h(`div.endpanel.duelpanel${animate ? '.duel-in' : ''}`, { role: 'region', 'aria-label': 'End of hand: everybody\'s picks' },
        head, banner,
        h(`div.duel-cols.c${cols}`, { 'aria-hidden': 'true' }, h('span'), h('span.dc-me', 'You'), st.opps.map((o) => h(`span.dc-opp.${oc(o)}`, o.name))),
        h('div.duel-rows', { role: 'tablist', 'aria-label': 'Decisions' }, rows),
        v.canCopy && rs.length ? h('div.duel-copy', copyButton(() => v.copy('hand'), { label: 'Copy the hand for Claude', what: 'the whole hand' })) : null,
        more,
        review ? othersBlock(others, {
          mineOf: (i) => myChoice(i), sel: v.sel, onSelect: (i) => v.select(i),
          onChange: () => screen.refreshBattle({ changed: true }), exclude: othersExclude,
        }) : null,
        detail);
      if (animate) {
        hv.revealed = true;
        const rm = reducedMotion();
        const t0 = rm ? 0 : 250 + rs.length * 130;
        setTimeout(() => countTo(meNum, 0, myScore, 800), t0);
        st.opps.forEach((o, oi) => { if (hd.opps[oi].score !== null) setTimeout(() => countTo(oppNums[oi], 0, hd.opps[oi].score, 800), rm ? 0 : t0 + 150 * (oi + 1)); });
        if (out) setTimeout(() => hit(panel, out), rm ? 300 : t0 + 1100);
        else setTimeout(() => { holdTotals = false; screen.refreshBattle(); }, rm ? 0 : t0 + 900);
      }
      return panel;
    }

    /** The round result lands: banner, sound, the totals in the bar count. */
    function hit(panel, out) {
      hv.hitDone = true;
      if (destroyed || !panel.isConnected) { holdTotals = false; return; }
      const banner = panel.querySelector('.duel-banner');
      banner?.classList.add('shown', 'hit');
      panel.querySelector('.duel-head')?.classList.add('hit');
      sound.round(out);
      if ((out === 'won' || out === 'tied') && !reducedMotion()) {
        const r = banner?.getBoundingClientRect();
        if (r) confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2, count: out === 'won' ? 36 : 18, chips: true });
      }
      holdTotals = false;
      screen.refreshBattle();
    }

    const me = {
      hand: n,
      timeUp() { if (screen.phase === 'deciding') screen.timeoutNow(); },
      clockUrgent() { if (!review) screen.returnNow(); },
      update(prev, next) {
        if (review) return;
        const L = next.live;
        const pL = prev?.live;
        // somebody answered / pressed Ready: a soft sound, their pick lands
        if (pL && L && L.answered && pL.answered && L.answered.length > pL.answered.length && L.phase !== 'review') sound.oppAnswered();
        if (pL && L && L.phase === 'review' && pL.phase === 'decide') sound.oppAnswered();
        if (pL && L && L.ready.length > pL.ready.length && L.ready.some((x) => x !== next.you.id && !pL.ready.includes(x))) sound.readyPing();
        for (const [oi, o] of (next.hands[n]?.opps || []).entries()) {
          for (const c of o.choices || []) {
            const key = `${oi}:${c.index}`;
            if (!hv.seenPicks.has(key)) { hv.seenPicks.add(key); hv.fresh.add(key); setTimeout(() => hv.fresh.delete(key), 1500); }
          }
        }
        const sig = sigOf(next);
        const changed = sig !== hv.sig;
        hv.sig = sig;
        // follow the cursor
        const ph = screen.phase, di = screen.decisionIndex;
        if (L && L.hand === n) {
          if ((L.phase === 'decide' || L.phase === 'review') && ph === 'deciding' && di !== null && (myAnsweredAt(di) || L.index > di || L.phase === 'review')) {
            screen.timeoutNow(); // the server recorded my time-out
          } else if (L.phase === 'decide' && ph === 'feedback' && di !== null && L.index > di) {
            screen.advance(); // everybody pressed Continue: the next decision for all
          } else if ((L.phase === 'handEnd' || L.phase === 'done') && ph === 'feedback') {
            holdTotals = true; barTotals = barTotals || { me: prev.me.total, opps: prev.opps.map((o) => o.total) };
            screen.advance(); // the hand plays out to its end for everybody
          } else if ((L.phase === 'handEnd' || L.phase === 'done') && ph === 'deciding') {
            screen.timeoutNow();
          }
        }
        screen.refreshBattle({ changed });
      },
      destroy() { screen.destroy(); },
    };
    return me;
  }

  // ---------- the result ----------
  function finalView() {
    document.body.dataset.screen = 'battle';
    const el = h('section.bfinal');
    clear(root).append(el);
    let lastSig = null, drawn = false;
    // The rematch buttons send an invitation, so they are never the default action: not focused,
    // Enter does not press them, and they only arm once the result has landed. R and a click work after that.
    let armAt = 0, armTimer = null;
    const ARM_MS = () => (reducedMotion() ? 700 : 2600);
    function armSoon(ms) {
      armAt = Date.now() + ms;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => el.querySelectorAll('.bf-rematch').forEach((b) => { b.disabled = false; b.classList.add('armed', 'just-armed'); }), ms);
    }
    function rematchButton(label, onClick, extra = null) {
      const armed = Date.now() >= armAt;
      return h(`button.btn.btn-primary.bf-rematch${armed ? '.armed' : ''}`, {
        type: 'button', disabled: !armed,
        on: { click: onClick, keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); } },
      }, label, extra);
    }
    const players = () => [{ id: st.you.id, name: st.you.name, who: 'me', total: st.me.total }, ...st.opps.map((o) => ({ id: o.id, name: o.name, who: oc(o), total: o.total }))];

    function decisionsOf(pi) {
      return st.hands.flatMap((hd, n) => ((pi === 0 ? hd.me.choices : hd.opps[pi - 1]?.choices) || []).map((c) => ({ ...c, hand: n })));
    }
    function pickExtremes(list) {
      if (!list.length) return null;
      const SO = { preflop: 0, flop: 1, turn: 2, river: 3 };
      let best = list[0], worst = list[0];
      for (const c of list) {
        if (c.points > best.points || (c.points === best.points && (SO[c.street] ?? 0) > (SO[best.street] ?? 0))) best = c;
        if (c.points < worst.points) worst = c;
      }
      return { best, worst };
    }
    function extremeLine(kind, c) {
      return h(`li.bf-ex.${kind}`,
        h('span.bf-ex-k', kind === 'best' ? 'Best' : 'Worst'),
        h('span.bf-ex-what', `Hand ${c.hand + 1} · ${STREETS[c.street] || ''} · `, h('b', c.timeout ? 'ran out of time' : c.label)),
        gradeBadge(c.grade, { small: true }), h('b.num.bf-ex-pts', Math.round(c.points)));
    }
    function playerCard(p, pi) {
      const ex = pickExtremes(decisionsOf(pi));
      return h(`div.bf-player.bf-${p.who}`,
        h('p.bf-p-head', avatar(p.name, p.who), h('b', pi === 0 ? 'You' : p.name)),
        ex ? h('ul.bf-exl', extremeLine('best', ex.best), ex.worst.points < ex.best.points ? extremeLine('worst', ex.worst) : null) : h('p.muted.small', 'No decisions.'));
    }

    function rematchBlock() {
      const r = st.rematch;
      if (r && r.invitedYou && !r.joined && r.status === 'open') {
        return h('div.bf-invite',
          h('p', avatar(r.by, 'o1'), h('b.opp-name', r.by), ' wants a rematch!'),
          h('div.bf-invite-row',
            rematchButton('Accept the rematch', async (e) => { e.currentTarget.disabled = true; try { await API.joinBattle(r.id); location.hash = `#/battle/${r.id}`; } catch (ex) { toast(ex.message, 'error'); poll(); } }, h('kbd', 'R')),
            h('button.btn.btn-ghost', { type: 'button', on: { click: async (e) => { e.currentTarget.disabled = true; try { await API.cancelBattle(r.id); toast('Rematch declined.'); poll(); } catch (ex) { toast(ex.message, 'error'); } } } }, 'Decline')));
      }
      if (r && (r.status === 'open' || r.status === 'active')) {
        return h('a.btn.btn-primary.bf-rematch.armed', { href: `#/battle/${r.id}` }, r.status === 'open' ? 'Rematch sent · open the waiting room' : 'Go to the rematch');
      }
      return rematchButton('Rematch', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try { const x = await API.rematch(id); location.hash = `#/battle/${x.battle.id}`; } catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
      }, h('kbd', 'R'));
    }

    function roundsTable() {
      const ps = players();
      return h('ol.bf-rounds', st.hands.map((hd, n) => {
        const r = roundOf(st, n);
        const ok = hd.me.done && hd.puzzle?.available !== false;
        const scores = [hd.me.score, ...hd.opps.map((o) => o.score)];
        const top = Math.max(...scores.filter((x) => x !== null));
        const inner = [
          h('span.bf-rn', n + 1),
          h('span.bf-rt', h('span.bf-title', hd.puzzle?.title || `Hand ${n + 1}`), h('span.bf-meta', `${LEVEL[hd.level] || ''}${hd.puzzle ? ` · #${hd.puzzle.number}` : ''}`)),
          scores.map((sc, i) => h(`b.bf-sc.${ps[i].who}.num${sc !== null && sc === top ? '.win' : ''}`, sc ?? '–')),
        ];
        return h(`li.bf-round.r-${r}.c${ps.length}${drawn ? '' : '.bf-anim'}`, { style: { '--i': String(n) } },
          ok ? h('button.bf-rbtn', { type: 'button', title: 'Review this hand', on: { click: () => go('review', { hand: n }) } }, inner, h('span.bf-go', { 'aria-hidden': 'true' }, '›')) : h('div.bf-rbtn', inner));
      }));
    }

    function podium() {
      const ps = players();
      if (ps.length < 3) return scoreLine(st, { big: true });
      const placed = st.standings.map((x) => ({ ...x, who: ps.find((p) => p.id === x.id)?.who || 'o1' }));
      const order = [placed[1], placed[0], placed[2]].filter(Boolean); // 2nd, 1st, 3rd on the stand
      return h('div.bpodium', order.map((p) => h(`div.bp-step.p${p.place}.${p.who}`,
        avatar(p.name, p.who, { big: true }),
        h('span.bp-name', p.id === st.you.id ? 'You' : p.name),
        h('b.bp-total.num', p.total),
        h('span.bp-block', h('span.bp-place', ordinal(p.place))))));
    }

    function render({ celebrate = false } = {}) {
      const s = st;
      const finished = s.status === 'finished';
      const ps = players();
      lastSig = JSON.stringify([s.status, s.rematch, s.standings]);
      const word = { win: 'Victory', loss: 'Defeat', draw: 'Draw', shared: 'Shared 1st', place: `${ordinal(s.place || 2)} place` }[s.outcome] || 'Battle over';
      document.title = `${word} · PokerPuzzles`;
      const tone = s.outcome === 'win' || s.outcome === 'shared' ? 'win' : s.outcome === 'draw' ? 'draw' : s.outcome === 'place' && s.place === 2 ? 'second' : 'loss';
      const won = s.hands.filter((x) => x.outcome === 'won').length;
      let sub;
      if (s.outcome === 'win') sub = ps.length > 2 ? `You win the three-way, ${s.me.total} points.` : `You beat ${s.opps[0].name}${won ? `, ${won} hand${won === 1 ? '' : 's'} to ${s.hands.filter((x) => x.outcome === 'lost').length}` : ''}.`;
      else if (s.outcome === 'shared') sub = `You share 1st place with ${names(s.standings.filter((x) => x.place === 1 && x.id !== s.you.id).map((x) => x.name))} on ${s.me.total}.`;
      else if (s.outcome === 'draw') sub = `Dead level: everybody on ${s.me.total} after ${s.handCount} hands.`;
      else if (s.outcome === 'loss') sub = `${s.opps[0].name} wins this one, ${s.opps[0].total} to ${s.me.total}. Every hand is open below to see where it went.`;
      else {
        const ahead = s.standings.filter((x) => x.total > s.me.total);
        const sharedWith = s.standings.filter((x) => x.total === s.me.total && x.id !== s.you.id);
        sub = `${sharedWith.length ? `Shared ${ordinal(s.place)} place with ${names(sharedWith.map((x) => x.name))}. ` : ''}${names(ahead.map((x) => x.name))} finished ahead of you${ahead.length === 1 ? `, ${ahead[0].total - s.me.total} points` : ''}. Every hand is open below.`;
      }
      const hero = h(`div.bf-hero.o-${tone}${celebrate ? '.play' : ''}`,
        h('p.bf-kicker', 'Battle over'),
        h('h1.bf-word', { 'aria-label': word }, word.split('').map((ch, i) => h('span', { style: { '--i': String(i) }, 'aria-hidden': 'true' }, ch === ' ' ? ' ' : ch))),
        podium(),
        h('p.bf-sub', sub));
      const scoreNums = ps.length < 3 ? hero.querySelectorAll('.bs-num') : hero.querySelectorAll('.bp-total');
      clear(el).append(
        hero,
        h('div.bf-grid',
          h('section.bf-card', { 'aria-labelledby': 'bf-r' },
            h(`div.bf-cols.c${ps.length}`, h('h2#bf-r', 'Hands'), ps.map((p) => h('span.bf-colh', { title: p.who === 'me' ? 'You' : p.name, 'aria-label': p.who === 'me' ? 'You' : p.name }, avatar(p.name, p.who))), h('span')),
            roundsTable(),
            h('p.muted.small', 'Open a hand to replay every decision with everybody\'s picks, the ranges and the why.')),
          h('section.bf-card.bf-players', { 'aria-label': 'Best and worst decisions' }, ps.map((p, i) => playerCard(p, i)))),
        h('div.bf-actions', finished ? rematchBlock() : null, h('a.btn.btn-ghost', { href: '#/battle' }, 'Back to battles')));
      drawn = true;
      if (celebrate) {
        const finals = ps.length < 3 ? [st.me.total, st.opps[0].total] : [...scoreNums].map((x) => Number(x.textContent));
        [...scoreNums].forEach((elx, i) => countTo(elx, 0, finals[i], 1300));
        setTimeout(() => {
          if (destroyed || !el.isConnected) return;
          if (tone === 'win') {
            sound.finalWin();
            const w = el.querySelector('.bf-word')?.getBoundingClientRect();
            confetti({ x: w ? w.left + w.width / 2 : undefined, y: w ? w.top + w.height / 2 : undefined, count: s.outcome === 'shared' ? 80 : 140 });
            if (s.outcome === 'win') {
              setTimeout(() => confetti({ x: window.innerWidth * 0.2, y: window.innerHeight * 0.25, count: 50 }), 450);
              setTimeout(() => confetti({ x: window.innerWidth * 0.8, y: window.innerHeight * 0.25, count: 50 }), 800);
            }
          } else if (tone === 'loss') sound.finalLoss();
          else sound.finalDraw();
        }, reducedMotion() ? 0 : 900);
        markCelebrated(id);
      }
    }
    const onKey = (e) => {
      if (e.key !== 'r' && e.key !== 'R') return;
      if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea/i.test(e.target.tagName)) return;
      const b = el.querySelector('.bf-actions button.bf-rematch');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    };
    document.addEventListener('keydown', onKey);
    const celebrateNow = st.status === 'finished' && !celebrated(id);
    armSoon(celebrateNow ? ARM_MS() : 700);
    render({ celebrate: celebrateNow });
    // Focus the result itself, not a button: Enter right after the last hand must do nothing here.
    el.querySelector('.bf-hero')?.setAttribute('tabindex', '-1');
    el.querySelector('.bf-hero')?.focus({ preventScroll: true });
    return {
      update(prev, next) {
        if (next.rematch?.id && !prev?.rematch?.id && !next.rematch.byYou) { sound.oppAnswered(); toast(`${next.rematch.by} wants a rematch!`); }
        const sig = JSON.stringify([next.status, next.rematch, next.standings]);
        if (sig !== lastSig) render();
      },
      destroy() { document.removeEventListener('keydown', onKey); clearTimeout(armTimer); },
    };
  }

  // ---------- load ----------
  (async () => {
    root.append(h('p.muted.pad', 'Loading the battle…'));
    try {
      const r = await timed(() => API.battle(id));
      if (destroyed) return;
      barTotals = r.battle.outsider ? null : { me: r.battle.me.total, opps: r.battle.opps.map((o) => o.total) };
      apply(r.battle);
      schedule();
    } catch (e) {
      if (!destroyed) showError(e.message);
    }
  })();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      clearInterval(ticker);
      document.removeEventListener('visibilitychange', onVis);
      sub?.destroy?.();
      document.querySelectorAll('.vs-intro, .fx-layer').forEach((x) => x.remove());
    },
  };
}
