// Thin fetch wrapper. The session token lives in localStorage.
const KEY = 'pokerpuzzles.session';

export function session() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
export function setSession(s) {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(status, message, data = null) { super(message); this.status = status; this.data = data; }
}

export async function api(method, path, body) {
  const s = session();
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(s?.token ? { Authorization: `Bearer ${s.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && path !== '/api/login') {
      setSession(null);
      window.dispatchEvent(new CustomEvent('pp:signedout'));
    }
    throw new ApiError(r.status, data?.error || `Request failed (${r.status}).`, data);
  }
  return data;
}

export const API = {
  login: (name, pin) => api('POST', '/api/login', { name, pin }),
  logout: () => api('POST', '/api/logout'),
  me: () => api('GET', '/api/me'),
  puzzles: () => api('GET', '/api/puzzles'),
  start: (id, mode) => api('POST', `/api/puzzles/${encodeURIComponent(id)}/start`, { mode }),
  act: (id, decisionIndex, optionId, mode) => api('POST', `/api/puzzles/${encodeURIComponent(id)}/act`, { decisionIndex, optionId, mode }),
  review: (id) => api('GET', `/api/puzzles/${encodeURIComponent(id)}/review`),
  others: (id) => api('GET', `/api/puzzles/${encodeURIComponent(id)}/others`),
  leaderboard: (scope = 'everyone') => api('GET', `/api/leaderboard${scope === 'friends' ? '?scope=friends' : ''}`),
  // friends, finding players, profiles
  friends: () => api('GET', '/api/friends'),
  friendRequest: (target) => api('POST', '/api/friends/request', target), // { id } or { name }
  friendAction: (id, what) => api('POST', `/api/friends/${encodeURIComponent(id)}/${what}`), // accept | decline | cancel | remove
  searchPlayers: (q) => api('GET', `/api/players?q=${encodeURIComponent(q)}`),
  player: (id) => api('GET', `/api/players/${encodeURIComponent(id)}`),
  playerHands: (id, before) => api('GET', `/api/players/${encodeURIComponent(id)}/hands?before=${encodeURIComponent(before)}`),
  battles: () => api('GET', '/api/battles'),
  createBattle: (size = 2) => api('POST', '/api/battles', { size }),
  joinBattleCode: (code) => api('POST', '/api/battles/join', { code }),
  battle: (id) => api('GET', `/api/battles/${encodeURIComponent(id)}`),
  joinBattle: (id) => api('POST', `/api/battles/${encodeURIComponent(id)}/join`),
  cancelBattle: (id) => api('POST', `/api/battles/${encodeURIComponent(id)}/cancel`),
  rematch: (id) => api('POST', `/api/battles/${encodeURIComponent(id)}/rematch`),
  beginBattle: (id) => api('POST', `/api/battles/${encodeURIComponent(id)}/begin`),
  battleReady: (id, ready = true) => api('POST', `/api/battles/${encodeURIComponent(id)}/ready`, { ready }),
  battleStart: (id, hand) => api('POST', `/api/battles/${encodeURIComponent(id)}/start`, { hand }),
  battleAct: (id, hand, decisionIndex, optionId) => api('POST', `/api/battles/${encodeURIComponent(id)}/act`, optionId === null ? { hand, decisionIndex, timeout: true } : { hand, decisionIndex, optionId }),
  // Tournament (push/fold)
  tournament: () => api('GET', '/api/tournament'),
  tournamentSpot: (name) => api('GET', `/api/tournament/spots/${encodeURIComponent(name)}`),
  drillNext: (prefs, avoid) => api('GET', `/api/tournament/drill/next?${new URLSearchParams({ ...prefs, ...(avoid ? { avoid } : {}) })}`),
  drillAnswer: (q, action) => api('POST', '/api/tournament/drill/answer', { spot: q.spot.name, decision: q.decision.id, class: q.hand.class, cards: q.hand.cards, action }),
  quizNext: (set) => api('POST', `/api/tournament/quiz/${encodeURIComponent(set)}/next`),
  quizAnswer: (set, question, action) => api('POST', `/api/tournament/quiz/${encodeURIComponent(set)}/answer`, { question, action }),
  quizSummary: (set) => api('GET', `/api/tournament/quiz/${encodeURIComponent(set)}/summary`),
  quizOthers: (question) => api('GET', `/api/tournament/quiz/questions/${encodeURIComponent(question)}/others`),
  quizRanking: (scope = 'everyone') => api('GET', `/api/tournament/quiz/ranking${scope === 'friends' ? '?scope=friends' : ''}`),
};
