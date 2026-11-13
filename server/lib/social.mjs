// Friends, finding players, profiles, the leaderboard (with its ranking rule)
// and "what the others did" on a hand.
//
// What leaves the server about another player's hand follows one rule: before
// the viewer has finished a hand, nothing may tell the solver's answer, anybody
// else's choices in it or how many decisions it has. For a hand the viewer has
// not finished, another player's result shows only that they played it, when,
// and their score. Unfinished plays are never shown to others. Plays marked
// `partial` (played in a cancelled battle, never scored) are never shown to
// others and never counted in anybody's statistics; on your own profile they
// appear as "not scored".
import { HttpError, requirePlayer } from './handlers.mjs';
import { GRADE_ORDER } from './grading.mjs';
import { battleHolds } from './battles.mjs';
import { tournamentProfile } from './tournament.mjs';

export const FRIENDS = Object.freeze({
  maxPending: 50,   // requests you sent that wait for an answer
  maxFriends: 200,
  searchMin: 2,     // letters before a name search runs
  searchMax: 10,    // results of a name search
  battled: 8,       // "people you have battled" suggestions
});
/**
 * The leaderboard's default order, also the rank shown on profiles: a player
 * is ranked from `minHands` finished, scored hands on. Ranked players are
 * ordered by average score (exact, not the rounded one shown), ties by more
 * hands; equal average and equal hands share a place (1, 2, 2, 4). Players
 * below the minimum are listed after them (by average, then hands) without a
 * rank, so one lucky hand never leads the table.
 */
export const RANKING = Object.freeze({ minHands: 5 });
export const OTHERS = Object.freeze({ max: 20 }); // players listed under "Others on this hand"
export const PROFILE = Object.freeze({ page: 25 }); // hands per page of a profile's hand list

const ok = (body, status = 200) => ({ status, body });
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const pub = (p) => ({ id: p.id, name: p.name });

function requirePuzzle(req, ctx) {
  const p = ctx.puzzles.get(req.params.id);
  if (!p) throw new HttpError(404, 'No such puzzle.');
  return p;
}
async function playerById(ctx, id) {
  const p = await ctx.storage.getPlayer(String(id ?? ''));
  if (!p) throw new HttpError(404, 'No such player.');
  return p;
}

// ---------- relations ----------
/** Map<otherId, 'friend' | 'sent' | 'received'> for one player. */
async function relationsOf(ctx, meId) {
  const map = new Map();
  for (const l of await ctx.storage.listFriendLinks({ playerId: meId })) {
    const other = l.from === meId ? l.to : l.from;
    map.set(other, l.status === 'friends' ? 'friend' : l.from === meId ? 'sent' : 'received');
  }
  return map;
}
const relationTo = (rels, meId, id) => (id === meId ? 'you' : rels.get(id) || 'none');
const countOf = (rels, kind) => [...rels.values()].filter((r) => r === kind).length;

// ---------- statistics ----------
/** What every statistic counts: finished, scored first plays of puzzles in the current set. */
const counted = (ctx, pl) => !!pl.completedAt && !pl.partial && ctx.puzzles.has(pl.puzzleId);

function emptyStats() {
  return {
    played: 0, totalPoints: 0, average: null, decisions: 0,
    grades: Object.fromEntries(GRADE_ORDER.map((g) => [g, 0])),
    streets: Object.fromEntries(STREETS.map((s) => [s, { decisions: 0, points: 0, average: null }])),
    lastPlayedAt: 0,
  };
}
function addPlay(st, pl) {
  st.played++;
  st.totalPoints += pl.score;
  for (const c of pl.choices) {
    st.grades[c.grade] = (st.grades[c.grade] || 0) + 1; // a battle time-out counts as `timeout`
    st.decisions++;
    const s = st.streets[c.street];
    if (s) { s.decisions++; s.points += c.points || 0; }
  }
  st.lastPlayedAt = Math.max(st.lastPlayedAt, pl.completedAt || 0);
}
function finishStats(st) {
  st.average = st.played ? Math.round((10 * st.totalPoints) / st.played) / 10 : null;
  for (const s of Object.values(st.streets)) {
    s.average = s.decisions ? Math.round((10 * s.points) / s.decisions) / 10 : null;
    s.points = Math.round(s.points * 100) / 100;
  }
  return st;
}
/** Map<playerId, stats> over every counted play. */
async function statsByPlayer(ctx) {
  const map = new Map();
  for (const pl of await ctx.storage.listPlays()) {
    if (!counted(ctx, pl)) continue;
    let st = map.get(pl.playerId);
    if (!st) map.set(pl.playerId, (st = emptyStats()));
    addPlay(st, pl);
  }
  for (const st of map.values()) finishStats(st);
  return map;
}
const statsOf = (stats, id) => stats.get(id) || finishStats(emptyStats());

/** When a player last used the app (or, before that was recorded, their last finished hand). */
const lastActiveOf = (p, st) => Math.max(p.lastSeenAt || 0, st?.lastPlayedAt || 0) || p.createdAt || null;

/**
 * The answers by grade as whole percent adding up to exactly 100 (largest
 * remainder; ties go to the grade with more answers, then the better grade).
 * `timeout` (battle time-outs) is a share of its own when there are any.
 * null when there are no answers. This, never the counts, is what anybody but
 * the player sees: counts (and decision totals) would let a viewer subtract
 * the hands they know and learn how many decisions an unplayed hand has.
 */
export function sharesOf(grades) {
  const keys = GRADE_ORDER.concat(grades.timeout ? ['timeout'] : []);
  const total = keys.reduce((a, k) => a + (grades[k] || 0), 0);
  if (!total) return null;
  const parts = keys.map((k, i) => {
    const exact = (100 * (grades[k] || 0)) / total;
    return { k, i, n: grades[k] || 0, pct: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = 100 - parts.reduce((a, p) => a + p.pct, 0);
  for (const p of [...parts].sort((a, b) => b.frac - a.frac || b.n - a.n || a.i - b.i)) {
    if (left <= 0) break;
    if (p.frac > 0) { p.pct++; left--; }
  }
  return Object.fromEntries(parts.map((p) => [p.k, p.pct]));
}
/** Another player's answers by grade and by street are shown from RANKING.minHands counted hands on; your own always. */
const splitShown = (viewerId, ownerId, st) => viewerId === ownerId || st.played >= RANKING.minHands;
/** Per street only the average points per decision (no counts, no sums: sum / average would give the count). */
const streetAverages = (streets) => Object.fromEntries(Object.entries(streets).map(([k, s]) => [k, { average: s.average }]));

// ---------- ranking ----------
/**
 * RANKING's order. rows: [{ id, name, played, totalPoints, ... }] -> a sorted
 * copy, each with `rank` (null below the minimum).
 */
export function rankRows(rows, { minHands = RANKING.minHands } = {}) {
  const min = Math.max(1, minHands);
  const ranked = (r) => r.played >= min;
  // a.total / a.played vs b.total / b.played without floating point: cross-multiply
  const byAverage = (a, b) => {
    if (!a.played || !b.played) return (b.played ? 1 : 0) - (a.played ? 1 : 0);
    return b.totalPoints * a.played - a.totalPoints * b.played;
  };
  const sorted = rows.map((r) => ({ ...r }))
    .sort((a, b) => (ranked(b) - ranked(a)) || byAverage(a, b) || (b.played - a.played) || a.name.localeCompare(b.name));
  sorted.forEach((r, i) => {
    if (!ranked(r)) { r.rank = null; return; }
    const prev = sorted[i - 1];
    r.rank = prev && ranked(prev) && prev.played === r.played && prev.totalPoints === r.totalPoints ? prev.rank : i + 1;
  });
  return sorted;
}

/** A leaderboard row as `viewerId` sees it: hands, points, and the answers by grade as shares (from 5 hands; yours always). */
function boardRow(p, st, viewerId) {
  return {
    id: p.id, name: p.name, played: st.played, totalPoints: st.totalPoints, average: st.average,
    shares: splitShown(viewerId, p.id, st) ? sharesOf(st.grades) : null,
  };
}

/** GET /api/leaderboard?scope=everyone|friends (friends = you and your friends) */
export async function leaderboard(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const scope = req.query?.scope === 'friends' ? 'friends' : 'everyone';
  const stats = await statsByPlayer(ctx);
  const rels = await relationsOf(ctx, me.id);
  let rows = (await ctx.storage.listPlayers()).map((p) => boardRow(p, statsOf(stats, p.id), me.id));
  if (scope === 'friends') rows = rows.filter((r) => r.id === me.id || rels.get(r.id) === 'friend');
  const players = rankRows(rows).map((r) => ({ ...r, friend: rels.get(r.id) === 'friend' }));
  return ok({ players, you: me.id, scope, minHands: RANKING.minHands, friendCount: countOf(rels, 'friend'), puzzleCount: ctx.puzzles.size });
}

// ---------- a hand's decisions, for players who have finished it ----------
/**
 * A finished play's decisions as another player may see them once they have
 * finished the hand too. As the review does with a play of a puzzle file that
 * changed since (`stale`): the stored grades and points stay (they made the
 * score), labels follow the current file, a choice that is no longer an
 * option says so, decisions the current file no longer has are left out.
 */
export function choiceView(p, play) {
  return play.choices
    .filter((c) => c.index < p.decisionCount)
    .sort((a, b) => a.index - b.index)
    .map((c) => {
      const d = p.solution.steps[p.decisionPositions[c.index]];
      const o = c.timeout ? null : d.options.find((x) => x.id === c.optionId);
      return {
        index: c.index, street: d.street || c.street || null,
        optionId: c.timeout ? null : c.optionId,
        label: c.timeout ? 'No answer' : o ? o.label : `${c.optionId} (no longer an option)`,
        grade: c.grade, points: c.points,
        ...(c.timeout ? { timeout: true } : {}),
      };
    });
}
const isStale = (p, play) => !!play.fingerprint && play.fingerprint !== p.fingerprint;

/**
 * Hands a player has finished: Map<puzzleId, play>. Their own play when it is
 * completed (a `partial` one too: they have seen the whole hand), else a hand
 * they finished in a battle (as a play-like record, `fromBattle`).
 */
async function finishedPlays(ctx, playerId, onlyPuzzle = null) {
  const out = new Map();
  for (const pl of await ctx.storage.listPlays({ playerId, ...(onlyPuzzle ? { puzzleId: onlyPuzzle } : {}) })) if (pl.completedAt) out.set(pl.puzzleId, pl);
  for (const bp of await ctx.storage.listBattlePlays({ playerId })) {
    const b = await ctx.storage.getBattle(bp.battleId);
    (b?.hands || []).forEach((hd, n) => {
      const h = bp.hands?.[n];
      if (!h?.completedAt || out.has(hd.puzzleId) || (onlyPuzzle && hd.puzzleId !== onlyPuzzle)) return;
      out.set(hd.puzzleId, { playerId, puzzleId: hd.puzzleId, fingerprint: hd.fingerprint, choices: h.choices, score: h.score, completedAt: h.completedAt, fromBattle: true });
    });
  }
  return out;
}

/** GET /api/puzzles/:id/others : who else has finished this hand and what they chose (only once you have finished it). */
export async function others(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const p = requirePuzzle(req, ctx);
  const id = p.solution.id;
  const mine = (await finishedPlays(ctx, me.id, id)).get(id);
  if (!mine) throw new HttpError(403, 'Play this hand to the end first. What the others chose shows once you have finished it.');
  const rels = await relationsOf(ctx, me.id);
  const list = [];
  for (const pl of await ctx.storage.listPlays({ puzzleId: id })) {
    if (!pl.completedAt || pl.partial || pl.playerId === me.id) continue; // never unfinished or partial plays
    const pp = await ctx.storage.getPlayer(pl.playerId);
    if (pp) list.push({ pl, pp, friend: rels.get(pp.id) === 'friend' });
  }
  list.sort((a, b) => (b.friend - a.friend) || (b.pl.completedAt - a.pl.completedAt) || a.pp.name.localeCompare(b.pp.name));
  return ok({
    puzzle: { id, number: p.number, title: p.solution.title },
    decisionCount: p.decisionCount,
    you: {
      score: mine.partial ? null : mine.score ?? null, choices: choiceView(p, mine),
      ...(mine.partial ? { partial: true } : {}), ...(mine.fromBattle ? { battle: true } : {}), ...(isStale(p, mine) ? { stale: true } : {}),
    },
    others: list.slice(0, OTHERS.max).map(({ pl, pp, friend }) => ({
      player: pub(pp), friend, score: pl.score, completedAt: pl.completedAt,
      ...(isStale(p, pl) ? { stale: true } : {}),
      choices: choiceView(p, pl),
    })),
    total: list.length,
    friends: list.filter((x) => x.friend).length,
  });
}

// ---------- profiles ----------
async function battleRecord(ctx, playerId) {
  let played = 0, won = 0;
  for (const b of await ctx.storage.listBattles({ playerId })) {
    if (b.status !== 'finished' || !(b.players || []).includes(playerId)) continue;
    played++;
    if (b.result?.winnerId === playerId) won++;
  }
  return { played, won };
}

/**
 * One page of a player's finished hands, newest first, as `viewer` may see
 * them. Cursor `before` = "<completedAt>_<puzzleId>" of the last row shown.
 */
async function handsPage(ctx, viewer, owner, { before = null, limit = PROFILE.page, finished: known = null } = {}) {
  const own = viewer.id === owner.id;
  const plays = (await ctx.storage.listPlays({ playerId: owner.id }))
    .filter((pl) => pl.completedAt && ctx.puzzles.has(pl.puzzleId) && (own || !pl.partial))
    .sort((a, b) => b.completedAt - a.completedAt || a.puzzleId.localeCompare(b.puzzleId));
  let start = 0;
  if (before) {
    const m = /^(\d+)_([\w-]+)$/.exec(String(before));
    if (!m) throw new HttpError(400, 'Bad cursor.');
    const t = Number(m[1]), pid = m[2];
    start = plays.findIndex((pl) => pl.completedAt < t || (pl.completedAt === t && pl.puzzleId > pid));
    if (start < 0) start = plays.length;
  }
  const page = plays.slice(start, start + limit);
  const finished = own ? null : known || await finishedPlays(ctx, viewer.id);
  const viewerPlays = own ? null : new Map((await ctx.storage.listPlays({ playerId: viewer.id })).map((pl) => [pl.puzzleId, pl]));
  const holds = own ? null : await battleHolds(ctx, viewer.id);
  const hands = page.map((pl) => {
    const p = ctx.puzzles.get(pl.puzzleId);
    const row = {
      puzzle: { id: p.solution.id, number: p.number, title: p.solution.title, level: p.level },
      completedAt: pl.completedAt, score: pl.partial ? null : pl.score,
      ...(pl.partial ? { partial: true } : {}),
    };
    const mine = own ? pl : finished.get(pl.puzzleId);
    if (!mine) {
      // The viewer has not finished this hand: their score and when, nothing about the decisions.
      row.finished = false;
      const vp = viewerPlays.get(pl.puzzleId);
      row.yours = vp && vp.choices.length ? 'in_progress' : 'new';
      if (holds.has(pl.puzzleId)) row.battle = holds.get(pl.puzzleId);
      return row;
    }
    row.finished = true;
    row.choices = choiceView(p, pl);
    if (isStale(p, pl)) row.stale = true;
    if (!own) row.mine = { score: mine.partial ? null : mine.score ?? null, ...(mine.partial ? { partial: true } : {}), choices: choiceView(p, mine) };
    return row;
  });
  const last = page.at(-1);
  return { hands, total: plays.length, next: start + page.length < plays.length && last ? `${last.completedAt}_${last.puzzleId}` : null };
}

/** GET /api/players/:id : a player's profile as the viewer may see it. */
export async function profile(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const p = await playerById(ctx, req.params.id);
  const own = p.id === me.id;
  const stats = await statsByPlayer(ctx);
  const st = statsOf(stats, p.id);
  const rels = await relationsOf(ctx, me.id);
  const relation = relationTo(rels, me.id, p.id);
  // Ranks as the viewer's leaderboard shows them: everyone, and (for you and your friends) "you and your friends".
  const rows = (await ctx.storage.listPlayers()).map((x) => boardRow(x, statsOf(stats, x.id), me.id));
  const everyone = rankRows(rows);
  const scope = rankRows(rows.filter((r) => r.id === me.id || rels.get(r.id) === 'friend'));
  const rankIn = (list) => ({ rank: list.find((r) => r.id === p.id)?.rank ?? null, of: list.filter((r) => r.rank !== null).length, size: list.length });
  // Another player's answers: shares in whole percent and street averages, from RANKING.minHands
  // counted hands on; never counts or decision totals (subtracting the hands a viewer knows from
  // them would tell how many decisions, and which grades, a hand they have not played has).
  // Your own profile: the exact counts.
  const detail = splitShown(me.id, p.id, st);
  const finished = own ? null : await finishedPlays(ctx, me.id);
  const page = await handsPage(ctx, me, p, { finished });
  return ok({
    player: { id: p.id, name: p.name, since: p.createdAt || null },
    you: own,
    relation,
    rank: {
      minHands: RANKING.minHands, played: st.played,
      everyone: rankIn(everyone),
      friends: own || relation === 'friend' ? rankIn(scope) : null,
    },
    stats: {
      played: st.played, average: st.average, totalPoints: st.totalPoints, battles: await battleRecord(ctx, p.id),
      detail,
      ...(detail ? { shares: sharesOf(st.grades), streets: own ? st.streets : streetAverages(st.streets) } : {}),
      ...(own ? { decisions: st.decisions, grades: st.grades } : {}),
    },
    ...(own ? { friendCount: countOf(rels, 'friend') } : {}),
    // Tournament quiz: finished sets with right answers (yours also the unfinished ones and your drill totals); null without the data.
    tournament: await tournamentProfile(ctx, me.id, p.id),
    hands: page.hands, handsTotal: page.total, next: page.next,
  });
}

/** GET /api/players/:id/hands?before=<cursor>&limit=<1-50> : the next page of a profile's hand list. */
export async function profileHands(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const p = await playerById(ctx, req.params.id);
  const n = Number(req.query?.limit);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 50) : PROFILE.page;
  const page = await handsPage(ctx, me, p, { before: req.query?.before || null, limit });
  return ok({ hands: page.hands, handsTotal: page.total, next: page.next });
}

// ---------- finding people ----------
/** GET /api/players?q=<prefix> : players whose name starts with q (at least 2 letters), with your relation to each. */
export async function searchPlayers(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const q = String(req.query?.q ?? '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40);
  if (q.length < FRIENDS.searchMin) throw new HttpError(400, `Type at least ${FRIENDS.searchMin} letters of a name.`);
  const rels = await relationsOf(ctx, me.id);
  const key = (p) => p.nameKey || p.name.toLowerCase();
  const hits = (await ctx.storage.listPlayers())
    .filter((p) => key(p).startsWith(q))
    .sort((a, b) => ((key(b) === q) - (key(a) === q)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, FRIENDS.searchMax);
  return ok({ q, players: hits.map((p) => ({ ...pub(p), relation: relationTo(rels, me.id, p.id) })) });
}

// ---------- friends ----------
/** GET /api/friends : your friends, requests both ways, and people you have battled. */
export async function friendsList(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const people = new Map((await ctx.storage.listPlayers()).map((p) => [p.id, p]));
  const stats = await statsByPlayer(ctx);
  const friends = [], incoming = [], outgoing = [];
  const rels = new Map();
  for (const l of await ctx.storage.listFriendLinks({ playerId: me.id })) {
    const p = people.get(l.from === me.id ? l.to : l.from);
    if (!p) continue;
    if (l.status === 'friends') {
      const st = statsOf(stats, p.id);
      friends.push({ ...pub(p), since: l.acceptedAt || l.createdAt, played: st.played, average: st.average, lastActive: lastActiveOf(p, st) });
      rels.set(p.id, 'friend');
    } else if (l.to === me.id) { incoming.push({ ...pub(p), at: l.createdAt }); rels.set(p.id, 'received'); }
    else { outgoing.push({ ...pub(p), at: l.createdAt }); rels.set(p.id, 'sent'); }
  }
  friends.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  incoming.sort((a, b) => b.at - a.at);
  outgoing.sort((a, b) => b.at - a.at);

  // People you have battled (battles that got going), most recent first, not your friends yet.
  const met = new Map();
  for (const b of await ctx.storage.listBattles({ playerId: me.id })) {
    const players = (b.players || []).filter(Boolean);
    if (!players.includes(me.id) || !(b.hands || []).length) continue;
    const at = Math.max(b.finishedAt || 0, b.cancelledAt || 0, b.joinedAt || 0, b.createdAt || 0);
    for (const id of players) {
      if (id === me.id || rels.get(id) === 'friend' || !people.has(id)) continue;
      const e = met.get(id) || { ...pub(people.get(id)), battles: 0, lastAt: 0, relation: rels.get(id) || 'none' };
      e.battles++;
      e.lastAt = Math.max(e.lastAt, at);
      met.set(id, e);
    }
  }
  const battled = [...met.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, FRIENDS.battled);
  return ok({ friends, incoming, outgoing, battled, limits: { maxPending: FRIENDS.maxPending, maxFriends: FRIENDS.maxFriends } });
}

/** The player a request is for: `id`, or `name` (exact, ignoring case and extra spaces). */
async function requestTarget(ctx, body) {
  if (body?.id !== undefined && body?.id !== null && body.id !== '') return playerById(ctx, body.id);
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Type the name of the player.');
  const p = await ctx.storage.getPlayerByName(name);
  if (!p) throw new HttpError(404, `There is no player called "${name.slice(0, 40)}".`);
  return p;
}
async function friendCount(ctx, id) {
  return (await ctx.storage.listFriendLinks({ playerId: id })).filter((l) => l.status === 'friends').length;
}
async function checkFriendRoom(ctx, me, other) {
  if (await friendCount(ctx, me.id) >= FRIENDS.maxFriends) throw new HttpError(409, `You have ${FRIENDS.maxFriends} friends, the most there can be. Remove one first.`);
  if (await friendCount(ctx, other.id) >= FRIENDS.maxFriends) throw new HttpError(409, `${other.name} has ${FRIENDS.maxFriends} friends, the most there can be.`);
}
async function befriend(ctx, link) {
  link.status = 'friends';
  link.acceptedAt = ctx.now();
  await ctx.storage.putFriendLink(link);
}

/** POST /api/friends/request {name} or {id} : ask a player to be your friend (if they asked you already, you are friends at once). */
export async function requestFriend(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const other = await requestTarget(ctx, req.body);
  if (other.id === me.id) throw new HttpError(400, 'That is you. Pick somebody else.');
  const link = await ctx.storage.getFriendLink(me.id, other.id);
  if (link?.status === 'friends') throw new HttpError(409, `You and ${other.name} are friends already.`);
  if (link && link.from === me.id) return ok({ relation: 'sent', player: pub(other), existing: true });
  if (link) {
    // They asked you first: that is a yes both ways.
    await checkFriendRoom(ctx, me, other);
    await befriend(ctx, link);
    return ok({ relation: 'friend', player: pub(other), mutual: true });
  }
  const mine = await ctx.storage.listFriendLinks({ playerId: me.id });
  if (mine.filter((l) => l.status === 'pending' && l.from === me.id).length >= FRIENDS.maxPending) {
    throw new HttpError(409, `${FRIENDS.maxPending} of your requests are still waiting for an answer. Cancel some before you send more.`);
  }
  await checkFriendRoom(ctx, me, other);
  await ctx.storage.putFriendLink({ from: me.id, to: other.id, status: 'pending', createdAt: ctx.now(), acceptedAt: null });
  return ok({ relation: 'sent', player: pub(other) }, 201);
}

/** POST /api/friends/:id/accept : say yes to that player's request. */
export async function acceptFriend(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const other = await playerById(ctx, req.params.id);
  const link = await ctx.storage.getFriendLink(me.id, other.id);
  if (link?.status === 'friends') return ok({ relation: 'friend', player: pub(other), existing: true });
  if (!link || link.to !== me.id) throw new HttpError(404, `There is no request from ${other.name}.`);
  await checkFriendRoom(ctx, me, other);
  await befriend(ctx, link);
  return ok({ relation: 'friend', player: pub(other) });
}

/** POST /api/friends/:id/decline : say no to that player's request (they may ask again later). */
export async function declineFriend(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const other = await playerById(ctx, req.params.id);
  const link = await ctx.storage.getFriendLink(me.id, other.id);
  if (!link || link.status !== 'pending' || link.to !== me.id) throw new HttpError(404, `There is no request from ${other.name}.`);
  await ctx.storage.deleteFriendLink(me.id, other.id);
  return ok({ relation: 'none', player: pub(other) });
}

/** POST /api/friends/:id/cancel : take back a request you sent. */
export async function cancelFriend(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const other = await playerById(ctx, req.params.id);
  const link = await ctx.storage.getFriendLink(me.id, other.id);
  if (link?.status === 'friends') throw new HttpError(409, `${other.name} has accepted already: you are friends.`);
  if (!link || link.from !== me.id) throw new HttpError(404, `You have no request waiting with ${other.name}.`);
  await ctx.storage.deleteFriendLink(me.id, other.id);
  return ok({ relation: 'none', player: pub(other) });
}

/** POST /api/friends/:id/remove : end a friendship (for both). */
export async function removeFriend(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const other = await playerById(ctx, req.params.id);
  const link = await ctx.storage.getFriendLink(me.id, other.id);
  if (!link || link.status !== 'friends') throw new HttpError(404, `${other.name} is not on your friends list.`);
  await ctx.storage.deleteFriendLink(me.id, other.id);
  return ok({ relation: 'none', player: pub(other) });
}
