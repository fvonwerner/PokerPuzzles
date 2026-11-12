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
  leaderboard: () => api('GET', '/api/leaderboard'),
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
};
