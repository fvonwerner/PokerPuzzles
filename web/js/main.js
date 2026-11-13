// Router and app shell.
import { API, session, setSession } from './api.js';
import { loginScreen, lobbyScreen } from './lobby.js';
import { playScreen } from './play.js';
import { learnScreen } from './learn.js';
import { battleHome, battleScreen } from './battle.js';
import { friendsScreen } from './friends.js';
import { profileScreen } from './profile.js';
import { tournamentScreen } from './tournament.js';
import { h, toast } from './ui.js';
import { initialOf } from './social.js';
import { sound } from './sound.js';

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const who = document.getElementById('who');
let current = null;

// ---------- the friend request badge on "Friends" ----------
// Refreshed on every navigation, about every 30 s while the page is in view, and after a change.
const BADGE_MS = 30000;
let badgeBusy = false;
function paintBadge(n) {
  const badge = document.getElementById('friends-badge');
  const link = document.getElementById('nav-friends');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n || '');
  if (n) link.setAttribute('aria-label', `Friends, ${n} request${n === 1 ? '' : 's'} waiting`);
  else link.removeAttribute('aria-label');
}
async function refreshBadge() {
  if (!session()?.token || document.hidden || badgeBusy) return;
  badgeBusy = true;
  try { paintBadge((await API.me()).friendRequests || 0); } catch { /* signed out or offline: the next refresh tries again */ }
  finally { badgeBusy = false; }
}
setInterval(refreshBadge, BADGE_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadge(); });
window.addEventListener('pp:friends', refreshBadge);

/** Your name in the top bar: a link to your profile (an initial on phones). */
function paintWho(player) {
  who.href = player?.id ? `#/player/${player.id}` : '#/';
  who.title = 'Your profile';
  who.setAttribute('aria-label', `Your profile: ${player?.name || ''}`);
  who.replaceChildren(h('span.who-av', { 'aria-hidden': 'true' }, initialOf(player?.name)), h('span.who-name', player?.name || ''));
}

async function signOut() {
  try { await API.logout(); } catch { /* ignore */ }
  setSession(null);
  paintBadge(0);
  location.hash = '#/login';
  route();
}

const nav = {
  reload() { route(); },
  /** The id the server suggests next (unfinished play, else easiest unplayed), or null. */
  async nextId() {
    const { nextId } = await API.puzzles();
    return nextId;
  },
  async nextPuzzle() {
    try {
      const next = await nav.nextId();
      if (next) location.hash = `#/play/${next}`;
      else { toast('You have played every puzzle. Nice work.'); location.hash = '#/lobby'; }
    } catch (e) { toast(e.message, 'error'); }
  },
};

/** Signed in at the root: go straight to the next puzzle, or the lobby when all are done. */
let landing = 0;
async function land() {
  const my = ++landing;
  document.body.dataset.screen = 'play';
  main.replaceChildren();
  main.append(Object.assign(document.createElement('p'), { className: 'muted pad', textContent: 'Finding your next puzzle…' }));
  let next = null;
  try { next = await nav.nextId(); } catch { /* fall back to the lobby */ }
  if (my !== landing) return;
  history.replaceState(null, '', next ? `#/play/${next}` : '#/lobby');
  route();
}

/** Header navigation: mark the current section ('me': your own profile, under your name). */
function markNav(section) {
  for (const a of document.querySelectorAll('.mainnav a')) {
    const on = a.dataset.nav === section;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  who.classList.toggle('on', section === 'me');
  if (section === 'me') who.setAttribute('aria-current', 'page'); else who.removeAttribute('aria-current');
  // On a narrow phone the links scroll sideways: keep the current one in view.
  const nav = document.querySelector('.mainnav');
  const cur = nav?.querySelector('a.on');
  if (nav && cur && nav.scrollWidth > nav.clientWidth + 1) {
    const nr = nav.getBoundingClientRect(), cr = cur.getBoundingClientRect();
    if (cr.right > nr.right - 20) nav.scrollLeft += cr.right - nr.right + 24;
    else if (cr.left < nr.left) nav.scrollLeft -= nr.left - cr.left + 4;
  }
  navMore();
}
/** A fade at either end of the links while more of them are hidden there (narrow phones). */
function navMore() {
  const nav = document.querySelector('.mainnav');
  if (!nav) return;
  nav.classList.toggle('more', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
  nav.classList.toggle('less', nav.scrollLeft > 2);
}
document.querySelector('.mainnav')?.addEventListener('scroll', navMore, { passive: true });
window.addEventListener('resize', navMore);

function route() {
  const s = session();
  const hash = location.hash;
  current?.destroy?.();
  current = null;
  window.scrollTo(0, 0);
  if (!s?.token) {
    topbar.hidden = true;
    document.body.dataset.screen = 'login';
    document.title = 'PokerPuzzles';
    current = loginScreen(main, {
      // A fresh sign-in always starts with one puzzle, unless the link names a specific hand, a battle, a player, the friends page or the Tournament tab.
      onSignedIn: () => { if (!/^#\/((play|practice|review|player)\/|battle|friends|tournament)/.test(location.hash)) history.replaceState(null, '', '#/'); route(); },
    });
    return;
  }
  topbar.hidden = false;
  paintWho(s.player);
  refreshBadge();
  if (!hash || hash === '#' || hash === '#/' || hash.startsWith('#/login')) { markNav('play'); document.title = 'PokerPuzzles'; land(); return; }
  landing++;
  // #/review/<puzzle>/with/<player>: the finished view with that player's decisions open under "Others on this hand"
  const m = hash.match(/^#\/(play|practice|review)\/([\w-]+)(?:\/with\/([\w-]+))?$/);
  const lm = hash.match(/^#\/learn(?:\/([a-z0-9-]+))?$/);
  const bm = hash.match(/^#\/battle(?:\/([\w-]+))?$/);
  const pm = hash.match(/^#\/player\/([\w-]+)$/);
  const tm = hash.match(/^#\/tournament((?:\/[\w%.-]+)*)\/?$/);
  if (tm) {
    // The Tournament tab sets body[data-screen] itself: 'play' for a question, 'tournament' for its pages.
    markNav('tournament');
    document.title = 'Tournament · PokerPuzzles';
    current = tournamentScreen(main, { path: tm[1] || '' });
  } else if (pm) {
    const own = pm[1] === s.player?.id;
    document.body.dataset.screen = 'profile';
    markNav(own ? 'me' : null);
    document.title = 'Player · PokerPuzzles';
    current = profileScreen(main, { id: pm[1], me: s.player, onSignOut: own ? signOut : null });
  } else if (hash === '#/friends') {
    document.body.dataset.screen = 'friends';
    markNav('friends');
    document.title = 'Friends · PokerPuzzles';
    current = friendsScreen(main, { player: s.player });
  } else if (bm) {
    document.body.dataset.screen = 'battle'; // a hand inside switches to the play layout itself
    markNav('battle');
    document.title = 'Battle · PokerPuzzles';
    current = bm[1] ? battleScreen(main, { id: bm[1], nav }) : battleHome(main, { player: s.player });
  } else if (m) {
    document.body.dataset.screen = 'play';
    markNav('play');
    document.title = 'PokerPuzzles';
    current = playScreen(main, { id: m[2], mode: m[1] === 'practice' ? 'practice' : 'scored', nav, othersFocus: m[3] || null });
  } else if (lm) {
    document.body.dataset.screen = 'learn';
    markNav('learn');
    document.title = 'Learn · PokerPuzzles';
    current = learnScreen(main, { topicId: lm[1] || null });
  } else {
    if (hash !== '#/lobby') { history.replaceState(null, '', '#/lobby'); }
    document.body.dataset.screen = 'lobby';
    markNav('lobby');
    document.title = 'All puzzles · PokerPuzzles';
    current = lobbyScreen(main, { player: s.player });
  }
  main.focus({ preventScroll: true });
}

document.getElementById('logout').addEventListener('click', signOut);
window.addEventListener('pp:signedout', () => { toast('Please sign in again.'); paintBadge(0); route(); });
window.addEventListener('hashchange', route);
route();

// Speaker toggle in the header (state kept by the sound module in localStorage).
const soundBtn = document.getElementById('sound');
function paintSound() {
  soundBtn.setAttribute('aria-pressed', String(sound.enabled));
  soundBtn.title = sound.enabled ? 'Sound on' : 'Sound off';
  soundBtn.classList.toggle('muted-on', !sound.enabled);
}
soundBtn.addEventListener('click', () => { sound.setEnabled(!sound.enabled); paintSound(); });
paintSound();
