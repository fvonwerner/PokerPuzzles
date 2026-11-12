// Router and app shell.
import { API, session, setSession } from './api.js';
import { loginScreen, lobbyScreen } from './lobby.js';
import { playScreen } from './play.js';
import { learnScreen } from './learn.js';
import { battleHome, battleScreen } from './battle.js';
import { toast } from './ui.js';
import { sound } from './sound.js';

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const who = document.getElementById('who');
let current = null;

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

/** Header navigation: mark the current section. */
function markNav(section) {
  for (const a of document.querySelectorAll('.mainnav a')) {
    const on = a.dataset.nav === section;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function route() {
  const s = session();
  const hash = location.hash;
  current?.destroy?.();
  current = null;
  window.scrollTo(0, 0);
  if (!s?.token) {
    topbar.hidden = true;
    document.body.dataset.screen = 'login';
    current = loginScreen(main, {
      // A fresh sign-in always starts with one puzzle, unless the link names a specific hand.
      onSignedIn: () => { if (!/^#\/((play|practice|review)\/|battle)/.test(location.hash)) history.replaceState(null, '', '#/'); route(); },
    });
    return;
  }
  topbar.hidden = false;
  who.textContent = s.player?.name || '';
  if (!hash || hash === '#' || hash === '#/' || hash.startsWith('#/login')) { markNav('play'); document.title = 'PokerPuzzles'; land(); return; }
  landing++;
  const m = hash.match(/^#\/(play|practice|review)\/([\w-]+)$/);
  const lm = hash.match(/^#\/learn(?:\/([a-z0-9-]+))?$/);
  const bm = hash.match(/^#\/battle(?:\/([\w-]+))?$/);
  if (bm) {
    document.body.dataset.screen = 'battle'; // a hand inside switches to the play layout itself
    markNav('battle');
    document.title = 'Battle · PokerPuzzles';
    current = bm[1] ? battleScreen(main, { id: bm[1], nav }) : battleHome(main, { player: s.player });
  } else if (m) {
    document.body.dataset.screen = 'play';
    markNav('play');
    document.title = 'PokerPuzzles';
    current = playScreen(main, { id: m[2], mode: m[1] === 'practice' ? 'practice' : 'scored', nav });
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

document.getElementById('logout').addEventListener('click', async () => {
  try { await API.logout(); } catch { /* ignore */ }
  setSession(null);
  location.hash = '#/login';
  route();
});
window.addEventListener('pp:signedout', () => { toast('Please sign in again.'); route(); });
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
