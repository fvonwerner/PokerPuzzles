// Battles: two or three players play the same five hands, live and in
// lockstep. Each hand is scored exactly like a puzzle (mean of the decision
// points, 0-100); a player's battle total is the sum of their hand scores;
// highest total wins (three players are ranked, ties share a place).
//
// The server is the single clock. A running battle has one shared cursor,
// `live`, that every player follows:
//
//   ready      ready check before the first hand (Ready can be taken back)
//   countdown  everybody ready: hand `hand` starts at `startsAt` for everyone
//              (3-2-1 before the first hand, a short lead-in between hands)
//   decide     decision `index` of hand `hand` is open for everybody. No clock
//              until somebody answers; from the first answer every other
//              player has clockMs (graceMs network allowance), then it is a
//              time-out: 0 points, the hand goes on along the main line.
//   review     everybody has answered: all picks are visible. Each player
//              presses Continue; once the first has, the others are
//              continued automatically after autoMs.
//   handEnd    the hand is over for everybody (the reveal). "Next hand" is a
//              ready button, with the same automatic continue.
//   done       the result screen (status 'finished').
//
// Nothing advances while nobody acts: a battle where nobody answers rests.
// Transitions are worked out lazily (advance()) on every request, at the
// moment they were due, so it does not matter who asks or when.
//
// What a player sees of the others: progress (who has answered, who is
// ready) always; another player's pick for a decision once they have answered
// (or run out of time on) that decision themselves; hand scores and round
// results when the hand is over for everybody. stateFor() is the only place
// that builds what leaves the server about a battle.
//
// Stored battle: { id, code, status: open|active|finished|cancelled, size,
//   createdBy, players, invites, declined, inviteOnly, createdAt, joinedAt,
//   finishedAt, cancelledAt, cancelReason, hands, live, result, rematchOf,
//   rematchId }. Records from before three-player and live battles
//   ({ players: [a, null|b], inviteId }, no `live`) are read through norm();
//   an old running battle gets a ready check and resumes at the earliest
//   decision somebody still has to answer.
import { randomInt } from 'node:crypto';
import { newId } from './auth.mjs';
import { HttpError, requirePlayer, playView, recordedReveal, recapOf } from './handlers.mjs';
import { reveal, endStep, publicSteps } from './view.mjs';
import { puzzleScore } from './grading.mjs';

export const BATTLE = Object.freeze({
  hands: 5,
  sizes: [2, 3],
  levels: ['easy', 'easy', 'medium', 'medium', 'hard'], // target spread, played easiest first
  codeAlphabet: 'ACDEFGHJKMNPRTUVWXY',                  // no look-alikes: B 8, I L 1, O Q 0, S 5, Z 2
  codeLength: 4,
  onlineMs: 6000,       // "online" = this player asked about the battle within this time
  clockMs: 20000,       // decision clock, from the first answer
  graceMs: 1500,        // late answers accepted within this (network delay)
  autoMs: 30000,        // after the first Continue / Next hand, the others are continued after this
  countdownMs: 4000,    // everybody ready -> first hand: 3, 2, 1, go
  leadMs: 3000,         // between hands: the versus lead-in
});

const ok = (body, status = 200) => ({ status, body });
const LEVEL_POS = { easy: 0, medium: 1, hard: 2 };

// Presence is kept in memory only (a live signal; it resets on restart).
const presence = new Map(); // `${battleId}:${playerId}` -> ms
const touch = (ctx, b, playerId) => presence.set(`${b.id}:${playerId}`, ctx.now());

// ---------- the stored record ----------
/** A battle record in the current format (older records are converted on the fly; `live` is added by advance()). */
export function norm(raw) {
  if (!raw) return raw;
  const b = { ...raw };
  b.players = (b.players || []).filter(Boolean);
  b.invites = Array.isArray(b.invites) ? b.invites : b.inviteId ? (b.players.includes(b.inviteId) ? [] : [b.inviteId]) : [];
  b.declined = Array.isArray(b.declined) ? b.declined : [];
  b.inviteOnly = b.inviteOnly ?? !!raw.inviteId;
  b.size = BATTLE.sizes.includes(b.size) ? b.size : 2;
  delete b.inviteId;
  return b;
}
const getB = async (ctx, id) => norm(await ctx.storage.getBattle(id));
const listB = async (ctx, q) => (await ctx.storage.listBattles(q)).map(norm);

// ---------- small helpers ----------
const isMember = (b, id) => b.players.includes(id);
const currentHand = (bp) => { const i = bp.hands.findIndex((x) => !x.completedAt); return i < 0 ? bp.hands.length : i; };
const handTotal = (bp) => bp.hands.reduce((a, x) => a + (x.completedAt ? x.score : 0), 0);
const pubChoice = (c) => ({ index: c.index, optionId: c.optionId, label: c.label, street: c.street, grade: c.grade, points: c.points, ...(c.timeout ? { timeout: true } : {}) });
/** 1 + how many have a strictly higher score (ties share a place). */
const placeOf = (score, all) => 1 + all.filter((x) => x > score).length;
const choiceAt = (bp, n, i) => bp?.hands[n]?.choices.find((c) => c.index === i) || null;

async function loadBattle(ctx, id) {
  const b = await getB(ctx, String(id || ''));
  if (!b) throw new HttpError(404, 'No such battle.');
  return b;
}
async function playsOf(ctx, b) {
  const plays = new Map();
  for (const id of b.players) plays.set(id, await ctx.storage.getBattlePlay(b.id, id));
  return plays;
}

/** True when a hand's puzzle file is gone or changed since the battle began. */
export function handsChanged(ctx, b) {
  return b.hands.some((hd) => {
    const p = ctx.puzzles.get(hd.puzzleId);
    return !p || p.fingerprint !== hd.fingerprint;
  });
}

async function newCode(ctx) {
  const taken = new Set((await ctx.storage.listBattles()).filter((b) => b.status === 'open' || b.status === 'active').map((b) => b.code));
  const A = BATTLE.codeAlphabet;
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < BATTLE.codeLength; i++) c += A[randomInt(A.length)];
    if (!taken.has(c)) return c;
  }
  throw new HttpError(503, 'Could not find a free battle code. Try again.');
}

function newBattle(ctx, me, code, extra = {}) {
  return {
    id: newId(), code, status: 'open', size: 2, createdBy: me.id, players: [me.id], invites: [], declined: [], inviteOnly: false,
    createdAt: ctx.now(), joinedAt: null, finishedAt: null, cancelledAt: null, cancelReason: null,
    hands: [], live: null, result: null, rematchOf: null, rematchId: null, ...extra,
  };
}
const newBattlePlay = (b, playerId) => ({
  battleId: b.id, playerId, hands: b.hands.map(() => ({ choices: [], credited: null, completedAt: null, score: null })), finishedAt: null,
});
const freshLive = () => ({ phase: 'ready', hand: 0, index: 0, ready: {}, firstReadyAt: null, startsAt: null, kind: null, decideAt: null, firstAnswerAt: null, started: false });

// ---------- hand selection ----------
/**
 * Up to BATTLE.hands puzzles for the given players. Freshness first (nobody
 * has completed or started it, not in another running battle of theirs,
 * then fewest earlier battle appearances), then the easy/easy/medium/medium/
 * hard spread; ties are random. Returned easiest first.
 */
export async function chooseHands(ctx, playerIds, { excludeBattleId = null } = {}) {
  const puzzles = [...ctx.puzzles.values()];
  if (!puzzles.length) return [];
  const ids = new Set(playerIds);
  const plays = (await ctx.storage.listPlays()).filter((pl) => ids.has(pl.playerId));
  const playOf = new Map(plays.map((pl) => [`${pl.playerId}:${pl.puzzleId}`, pl]));
  const battles = (await listB(ctx)).filter((x) => x.id !== excludeBattleId && x.players.some((p) => ids.has(p)));
  const busy = new Set(), seen = new Map();
  for (const x of battles) for (const hd of x.hands) {
    if (x.status === 'active') busy.add(hd.puzzleId);
    seen.set(hd.puzzleId, (seen.get(hd.puzzleId) || 0) + 1);
  }
  const state = (pid, puzzleId) => {
    const pl = playOf.get(`${pid}:${puzzleId}`);
    if (!pl) return 'none';
    if (pl.completedAt) return 'done';
    return pl.choices.length ? 'started' : 'none'; // opened but never answered: nothing was revealed
  };
  const cands = puzzles.map((p) => {
    const id = p.solution.id;
    const states = playerIds.map((pid) => state(pid, id));
    const doneN = states.filter((x) => x === 'done').length;
    let tier;
    if (busy.has(id)) tier = 9;
    else if (states.every((x) => x === 'none')) tier = 0;
    else if (doneN === 0) tier = 1;
    else tier = 1 + doneN; // 2: one has completed it, 3: two have, ...
    return { p, tier, seen: seen.get(id) || 0, rnd: Math.random() };
  });
  const n = Math.min(BATTLE.hands, cands.length);
  const chosen = [];
  for (const level of BATTLE.levels.slice(0, n)) {
    let best = null, bestKey = null;
    for (const c of cands) {
      if (chosen.includes(c)) continue;
      const key = [c.tier, Math.abs(LEVEL_POS[c.p.level] - LEVEL_POS[level]), c.seen, c.rnd];
      if (!best || cmp(key, bestKey) < 0) { best = c; bestKey = key; }
    }
    if (best) chosen.push(best);
  }
  return chosen.map((c) => c.p).sort((x, y) => x.rank - y.rank).map((p) => ({
    puzzleId: p.solution.id, fingerprint: p.fingerprint, title: p.solution.title, number: p.number,
    level: p.level, rank: p.rank, decisionCount: p.decisionCount,
  }));
}
function cmp(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// ---------- the shared cursor ----------
/**
 * Record one answer (or a time-out) of a player: the hand score when it was
 * the hand's last decision, and the mirrored first play.
 */
async function recordAnswer(ctx, b, bp, n, p, choice) {
  const hd = b.hands[n], h = bp.hands[n];
  // First answer of the hand: does it count as the player's normal first play of the puzzle?
  if (h.credited === null || h.credited === undefined) {
    const pl = await ctx.storage.getPlay(bp.playerId, hd.puzzleId);
    h.credited = !pl || (!pl.completedAt && (pl.choices.length === 0 || (pl.fingerprint && pl.fingerprint !== p.fingerprint)));
  }
  h.choices.push(choice);
  h.choices.sort((x, y) => x.index - y.index);
  const last = h.choices.length === p.decisionCount;
  if (last) {
    h.completedAt = Math.max(ctx.now(), choice.at);
    h.score = puzzleScore(h.choices.map((c) => c.points));
    if (bp.hands.every((x) => x.completedAt)) bp.finishedAt = h.completedAt;
  }
  await ctx.storage.putBattlePlay(bp);
  if (h.credited) {
    // Mirror the battle hand into the normal play record: same choices, same score (a time-out is a 0 there too).
    const prev = await ctx.storage.getPlay(bp.playerId, hd.puzzleId);
    if (!prev || !prev.completedAt) {
      await ctx.storage.putPlay({
        playerId: bp.playerId, puzzleId: hd.puzzleId, fingerprint: p.fingerprint, battleId: b.id,
        choices: h.choices.map((c) => ({ ...c })),
        startedAt: prev && prev.fingerprint === p.fingerprint ? prev.startedAt : h.choices[0].at,
        completedAt: last ? h.completedAt : null, score: last ? h.score : null,
      });
    }
  }
}

/** A running battle from before live battles: a ready check, then on from the earliest open decision. */
function convertLive(b, plays) {
  const L = freshLive();
  let best = null;
  for (const id of b.players) {
    const bp = plays.get(id);
    const n = bp ? currentHand(bp) : 0;
    const i = bp && n < b.hands.length ? bp.hands[n].choices.length : 0;
    if (!best || n < best[0] || (n === best[0] && i < best[1])) best = [n, i];
  }
  [L.hand, L.index] = best || [0, 0];
  L.started = b.players.some((id) => plays.get(id)?.hands.some((x) => x.choices.length));
  return L;
}

function finishBattle(ctx, b, plays, at) {
  b.status = 'finished';
  b.finishedAt = at;
  const totals = Object.fromEntries(b.players.map((id) => [id, handTotal(plays.get(id))]));
  const all = Object.values(totals);
  const top = Math.max(...all);
  const winners = Object.keys(totals).filter((id) => totals[id] === top);
  b.result = { totals, places: Object.fromEntries(Object.entries(totals).map(([id, t]) => [id, placeOf(t, all)])), winnerId: winners.length === 1 ? winners[0] : null };
}

/** When the decision clock started: the first answer, but never before the decision opened. */
function firstAnswer(b, plays) {
  const L = b.live;
  let first = null, by = null;
  for (const id of b.players) {
    const c = choiceAt(plays.get(id), L.hand, L.index);
    if (c && !c.timeout) {
      const at = Math.max(c.at, L.decideAt || 0);
      if (first === null || at < first) { first = at; by = id; }
    }
  }
  return { first, by };
}

/**
 * Bring a battle up to date (writes; called from serialized handlers): a
 * running battle whose puzzle files changed ends as cancelled; the cursor
 * moves through every transition that was due by now.
 */
async function advance(ctx, b) {
  if (b.status === 'active' && handsChanged(ctx, b)) {
    b.status = 'cancelled';
    b.cancelReason = 'hands_updated';
    b.cancelledAt = ctx.now();
    await ctx.storage.putBattle(b);
    return b;
  }
  if (b.status !== 'active' && b.status !== 'finished') return b;
  if (b.status === 'finished' && (!b.live || b.live.phase === 'done')) return b;
  const plays = await playsOf(ctx, b);
  let changed = false;
  if (!b.live) { b.live = convertLive(b, plays); changed = true; }
  const L = b.live;
  const now = ctx.now();
  const everyone = (set) => b.players.every((id) => set[id]);
  for (let guard = 0; guard < 50; guard++) {
    let moved = false;
    if (L.phase === 'countdown' && now >= L.startsAt) {
      Object.assign(L, { phase: 'decide', decideAt: L.startsAt, firstAnswerAt: null, ready: {}, firstReadyAt: null });
      moved = true;
    } else if (L.phase === 'decide') {
      const p = ctx.puzzles.get(b.hands[L.hand].puzzleId);
      const { first } = firstAnswer(b, plays);
      if (first !== null && L.firstAnswerAt !== first) { L.firstAnswerAt = first; changed = true; }
      const deadline = first !== null ? first + BATTLE.clockMs : null;
      if (deadline !== null && now > deadline + BATTLE.graceMs) {
        const d = p.solution.steps[p.decisionPositions[L.index]];
        for (const id of b.players) {
          if (choiceAt(plays.get(id), L.hand, L.index)) continue;
          await recordAnswer(ctx, b, plays.get(id), L.hand, p, {
            index: L.index, optionId: null, label: 'No answer', street: d.street, grade: 'timeout', points: 0, at: deadline, timeout: true,
          });
          moved = true;
        }
      }
      if (b.players.every((id) => choiceAt(plays.get(id), L.hand, L.index))) {
        Object.assign(L, { phase: 'review', ready: {}, firstReadyAt: null });
        moved = true;
      }
    } else if (L.phase === 'review' || L.phase === 'handEnd') {
      const allReady = everyone(L.ready);
      const autoAt = L.firstReadyAt !== null && L.firstReadyAt !== undefined ? L.firstReadyAt + BATTLE.autoMs : null;
      if (allReady || (autoAt !== null && now >= autoAt)) {
        const t = allReady ? (L.lastReadyAt || now) : autoAt;
        if (L.phase === 'review') {
          if (L.index + 1 < b.hands[L.hand].decisionCount) {
            Object.assign(L, { phase: 'decide', index: L.index + 1, decideAt: t, firstAnswerAt: null, ready: {}, firstReadyAt: null });
          } else {
            Object.assign(L, { phase: 'handEnd', ready: {}, firstReadyAt: null });
            if (L.hand === b.hands.length - 1) finishBattle(ctx, b, plays, t);
          }
        } else if (L.hand + 1 < b.hands.length) {
          Object.assign(L, { phase: 'countdown', kind: 'lead', hand: L.hand + 1, index: 0, startsAt: t + BATTLE.leadMs, ready: {}, firstReadyAt: null });
        } else {
          Object.assign(L, { phase: 'done', ready: {}, firstReadyAt: null });
        }
        moved = true;
      }
    }
    if (!moved) break;
    changed = true;
  }
  if (changed) await ctx.storage.putBattle(b);
  return b;
}

// ---------- what a player sees ----------
async function namesOf(ctx, ids) {
  const out = [];
  for (const id of ids) { const p = await ctx.storage.getPlayer(id); if (p) out.push({ id: p.id, name: p.name }); }
  return out;
}

async function stateFor(ctx, b, me, { compact = false } = {}) {
  const started = b.status !== 'open' && b.hands.length > 0;
  const others = b.players.filter((id) => id !== me.id);
  const people = await namesOf(ctx, b.players);
  const nameOf = (id) => people.find((x) => x.id === id)?.name || '?';
  const plays = started ? await playsOf(ctx, b) : new Map();
  const mine = plays.get(me.id) || null;
  const L = b.live || (b.status === 'finished' ? { phase: 'done', hand: b.hands.length - 1, index: 0, ready: {} } : null);
  const over = b.status !== 'active' || !L;
  const cursorHand = L ? L.hand : 0;

  const hands = b.hands.map((hd, n) => {
    const mh = mine?.hands[n];
    const myAnswered = mh ? mh.choices.length : 0;
    // A hand is over for everybody once the cursor is past it (or at its end).
    const handOver = over || n < cursorHand || (n === cursorHand && (L.phase === 'handEnd' || L.phase === 'done'));
    const opps = others.map((id) => {
      const oh = plays.get(id)?.hands[n];
      // Progress never past the open decision: an opponent having finished the hand would tell that it was the last one.
      const answered = oh ? (handOver ? oh.choices.length : Math.min(oh.choices.length, n === cursorHand ? L.index + 1 : 0)) : 0;
      const o = { id, answered, done: handOver && !!oh?.completedAt, score: handOver && oh?.completedAt ? oh.score : null };
      if (!compact) o.choices = (oh?.choices || []).filter((c) => c.index < myAnswered).map(pubChoice);
      return o;
    });
    const row = {
      n, level: hd.level,
      // how many decisions the hand has: only once it is over for you
      ...(handOver || mh?.completedAt ? { decisionCount: hd.decisionCount } : {}),
      // Which puzzle a hand is: only once it has started (or the battle is over).
      puzzle: over || n < cursorHand || (n === cursorHand && L.phase !== 'ready' && L.phase !== 'countdown')
        ? { id: hd.puzzleId, number: hd.number, title: hd.title, available: !!ctx.puzzles.get(hd.puzzleId) } : null,
      me: { answered: myAnswered, done: !!mh?.completedAt, score: mh?.completedAt && handOver ? mh.score : null },
      opps, outcome: null, winners: null, place: null,
    };
    if (!compact) row.me.choices = (mh?.choices || []).map(pubChoice);
    if (handOver && mh?.completedAt && opps.every((o) => o.score !== null)) {
      const scores = [mh.score, ...opps.map((o) => o.score)];
      const top = Math.max(...scores);
      row.winners = [me.id, ...others].filter((id, i) => scores[i] === top);
      row.outcome = !row.winners.includes(me.id) ? 'lost' : row.winners.length === 1 ? 'won' : 'tied';
      row.place = placeOf(mh.score, scores);
    }
    row.opp = opps[0] || null; // first opponent (duels; older clients)
    return row;
  });

  const now = ctx.now();
  const lastSeenOf = (id) => {
    const seenMem = presence.get(`${b.id}:${id}`) || 0;
    const bp = plays.get(id);
    const lastAnswer = bp ? Math.max(0, ...bp.hands.flatMap((x) => x.choices.filter((c) => !c.timeout).map((c) => c.at || 0))) : 0;
    return { online: !!(seenMem && now - seenMem < BATTLE.onlineMs), last: Math.max(seenMem, lastAnswer) || null };
  };
  const oppsSummary = others.map((id, i) => {
    const bp = plays.get(id);
    const ls = lastSeenOf(id);
    return {
      id, name: nameOf(id), color: i + 1, online: ls.online, lastSeenAgo: ls.last ? Math.max(0, now - ls.last) : null,
      hand: L ? L.hand : 0, done: b.status === 'finished' && !!bp?.finishedAt, // the shared cursor, not their own position
      total: hands.reduce((a, x) => a + (x.opps[i].score ?? 0), 0),
    };
  });
  const myTotal = hands.reduce((a, x) => a + (x.me.score ?? 0), 0);

  // The shared cursor, as everybody sees it (absolute server times plus serverNow, so clients can sync).
  let live = null;
  if (L && b.status !== 'open') {
    const atCursor = L.phase === 'decide' || L.phase === 'review';
    const answered = atCursor ? b.players.filter((id) => choiceAt(plays.get(id), L.hand, L.index)) : [];
    const timedOut = atCursor ? b.players.filter((id) => choiceAt(plays.get(id), L.hand, L.index)?.timeout) : [];
    const fa = L.phase === 'decide' ? firstAnswer(b, plays) : { first: null, by: null };
    live = {
      phase: L.phase, hand: L.hand, index: L.index, kind: L.kind || null,
      startsAt: L.phase === 'countdown' ? L.startsAt : null,
      decideAt: L.decideAt || null,
      deadline: fa.first !== null ? fa.first + BATTLE.clockMs : null,
      firstBy: fa.by ? nameOf(fa.by) : null,
      answered, timedOut,
      ready: Object.keys(L.ready || {}).filter((id) => L.ready[id]),
      autoAt: L.firstReadyAt !== null && L.firstReadyAt !== undefined && (L.phase === 'review' || L.phase === 'handEnd') ? L.firstReadyAt + BATTLE.autoMs : null,
      started: !!L.started,
    };
  }

  let standings = null, outcome = null, place = null, shared = false;
  if (b.status === 'finished') {
    const totals = b.players.map((id) => handTotal(plays.get(id)));
    standings = b.players.map((id, i) => ({ id, name: nameOf(id), total: totals[i], place: placeOf(totals[i], totals) }))
      .sort((x, y) => x.place - y.place || (x.id === me.id ? -1 : y.id === me.id ? 1 : 0));
    const mineTotal = handTotal(plays.get(me.id));
    place = placeOf(mineTotal, totals);
    shared = totals.filter((t) => t === mineTotal).length > 1;
    if (totals.every((t) => t === mineTotal)) outcome = 'draw';
    else if (place === 1) outcome = shared ? 'shared' : 'win';
    else outcome = b.players.length === 2 ? 'loss' : 'place';
  }

  let rematch = null;
  if (b.rematchId) {
    const r = await getB(ctx, b.rematchId);
    if (r) {
      rematch = {
        id: r.id, status: r.status, byYou: r.createdBy === me.id, by: (await namesOf(ctx, [r.createdBy]))[0]?.name || '?',
        invitedYou: r.invites.includes(me.id), joined: r.players.includes(me.id),
      };
    }
  }
  const invited = b.status === 'open' ? await namesOf(ctx, b.invites) : [];
  const declined = b.status === 'open' || b.status === 'cancelled' ? await namesOf(ctx, b.declined) : [];
  const first = oppsSummary[0];
  return {
    id: b.id, status: b.status, code: b.status === 'open' ? b.code : null, size: b.size,
    createdAt: b.createdAt, joinedAt: b.joinedAt, finishedAt: b.finishedAt, cancelledAt: b.cancelledAt, cancelReason: b.cancelReason,
    handCount: b.hands.length || BATTLE.hands,
    serverNow: now,
    timing: { clockMs: BATTLE.clockMs, graceMs: BATTLE.graceMs, autoMs: BATTLE.autoMs, countdownMs: BATTLE.countdownMs, leadMs: BATTLE.leadMs },
    you: { id: me.id, name: me.name },
    youCreated: b.createdBy === me.id,
    creator: { id: b.createdBy, name: nameOf(b.createdBy) },
    players: people, invited, declined, inviteOnly: !!b.inviteOnly,
    canStart: b.status === 'open' && b.createdBy === me.id && b.players.length >= 2,
    canCancel: b.createdBy === me.id && (b.status === 'open' || (b.status === 'active' && L?.phase === 'ready' && !L.started)),
    invite: b.invites.length ? (b.invites.includes(me.id) ? 'you' : 'them') : null,
    live,
    me: { hand: L ? L.hand : 0, done: b.status === 'finished' && !!mine?.finishedAt, total: myTotal },
    opps: oppsSummary,
    // First opponent, flat (duels; older clients):
    opponent: first ? { id: first.id, name: first.name } : (b.invites[0] && b.createdBy === me.id ? (await namesOf(ctx, [b.invites[0]]))[0] || null : null),
    opp: first ? { hand: first.hand, done: first.done, total: first.total } : { hand: 0, done: false, total: 0 },
    online: first ? first.online : false,
    lastSeenAgo: first ? first.lastSeenAgo : null,
    outcome, place, shared, standings,
    hands,
    rematchOf: b.rematchOf || null,
    rematch,
  };
}

/** What someone who is not a player of a battle may see. */
async function outsiderState(ctx, b, me) {
  const joinable = b.status === 'open' && b.players.length < b.size && (!b.inviteOnly || b.invites.includes(me.id));
  const people = await namesOf(ctx, b.players);
  const creator = people.find((x) => x.id === b.createdBy);
  return {
    id: b.id, status: b.status, outsider: true, joinable, size: b.size,
    code: joinable ? b.code : null,
    creator: creator ? { name: creator.name } : null,
    joined: people.map((x) => ({ name: x.name })),
    invite: b.invites.includes(me.id) ? 'you' : b.inviteOnly ? 'them' : null,
    others: b.inviteOnly ? (await namesOf(ctx, b.invites.filter((x) => x !== me.id))).map((x) => ({ name: x.name })) : [],
    cancelReason: b.cancelReason, handCount: BATTLE.hands, createdAt: b.createdAt, rematchOf: b.rematchOf || null,
  };
}

async function viewFor(ctx, b, me) {
  if (isMember(b, me.id)) return stateFor(ctx, b, me);
  return outsiderState(ctx, b, me);
}

// ---------- endpoints: battles ----------
/** GET /api/battles */
export async function listBattles(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const all = await listB(ctx);
  for (const b of all) if ((b.status === 'active' || b.status === 'finished') && isMember(b, me.id)) await advance(ctx, b);
  const mine = [], open = [];
  for (const b of all) {
    if (isMember(b, me.id)) mine.push(await stateFor(ctx, b, me, { compact: true }));
    else if (b.status === 'open' && b.players.length < b.size && (!b.inviteOnly || b.invites.includes(me.id))) open.push(await outsiderState(ctx, b, me));
  }
  const recent = (x) => Math.max(x.finishedAt || 0, x.cancelledAt || 0, x.joinedAt || 0, x.createdAt || 0);
  mine.sort((a, b) => recent(b) - recent(a));
  open.sort((a, b) => (b.invite === 'you') - (a.invite === 'you') || b.createdAt - a.createdAt);

  // Head-to-head per friend over finished battles: in a three-way every pair counts (who finished higher).
  const rec = new Map();
  for (const s of mine) {
    if (s.status !== 'finished') continue;
    for (const o of s.opps) {
      const r = rec.get(o.id) || { opponent: { id: o.id, name: o.name }, wins: 0, losses: 0, draws: 0, last: null, lastAt: 0, for: 0, against: 0 };
      const res = s.me.total > o.total ? 'win' : s.me.total < o.total ? 'loss' : 'draw';
      if (res === 'win') r.wins++; else if (res === 'loss') r.losses++; else r.draws++;
      r.for += s.me.total; r.against += o.total;
      if (s.finishedAt > r.lastAt) { r.lastAt = s.finishedAt; r.last = res; }
      rec.set(o.id, r);
    }
  }
  const record = [...rec.values()].sort((a, b) => (b.wins + b.losses + b.draws) - (a.wins + a.losses + a.draws) || b.lastAt - a.lastAt);
  return ok({ battles: mine, open, record, handCount: BATTLE.hands });
}

/** POST /api/battles {size} : a new open challenge (your existing open one of that size if you have one). */
export async function createBattle(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const size = req.body?.size === undefined || req.body?.size === null ? 2 : Number(req.body.size);
  if (!BATTLE.sizes.includes(size)) throw new HttpError(400, 'A battle is for 2 or 3 players.');
  if (!ctx.puzzles.size) throw new HttpError(409, 'There are no puzzles to battle on yet.');
  const existing = (await listB(ctx, { playerId: me.id, status: 'open' }))
    .filter((b) => b.createdBy === me.id && !b.inviteOnly && b.size === size).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (existing) return ok({ battle: await stateFor(ctx, existing, me), existing: true });
  const b = newBattle(ctx, me, await newCode(ctx), { size });
  await ctx.storage.putBattle(b);
  touch(ctx, b, me.id);
  return ok({ battle: await stateFor(ctx, b, me), existing: false }, 201);
}

/** GET /api/battles/:id */
export async function getBattle(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const b = await advance(ctx, await loadBattle(ctx, req.params.id));
  if (isMember(b, me.id)) touch(ctx, b, me.id);
  return ok({ battle: await viewFor(ctx, b, me) });
}

function normCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== BATTLE.codeLength) throw new HttpError(400, `A battle code is ${BATTLE.codeLength} letters.`);
  return code;
}

/** The players are set: hands for everybody, a play record each, then the ready check. */
async function begin(ctx, b) {
  const hands = await chooseHands(ctx, b.players, { excludeBattleId: b.id });
  if (!hands.length) throw new HttpError(409, 'There are no puzzles to battle on yet.');
  b.status = 'active';
  b.joinedAt = ctx.now();
  b.hands = hands;
  b.invites = []; // whoever has not answered an invitation by now is out
  b.live = freshLive();
  for (const id of b.players) await ctx.storage.putBattlePlay(newBattlePlay(b, id));
  await ctx.storage.putBattle(b);
}

async function join(ctx, b, me) {
  if (isMember(b, me.id)) { touch(ctx, b, me.id); return ok({ battle: await stateFor(ctx, b, me) }); } // your own, or already joined
  if (b.status === 'cancelled') throw new HttpError(409, 'This battle was cancelled.');
  if (b.status !== 'open' || b.players.length >= b.size) throw new HttpError(409, 'This battle is already full.');
  if (b.inviteOnly && !b.invites.includes(me.id)) throw new HttpError(403, 'This rematch is for someone else.');
  b.players.push(me.id);
  b.invites = b.invites.filter((x) => x !== me.id);
  // Full, or every invitation answered: on to the ready check.
  if (b.players.length >= b.size || (b.inviteOnly && !b.invites.length && b.players.length >= 2)) await begin(ctx, b);
  else await ctx.storage.putBattle(b);
  touch(ctx, b, me.id);
  return ok({ battle: await stateFor(ctx, b, me), joined: true });
}

/** POST /api/battles/join {code} */
export async function joinByCode(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const code = normCode(req.body?.code);
  const b = norm(await ctx.storage.getBattleByCode(code));
  if (!b || (b.status !== 'open' && !isMember(b, me.id))) throw new HttpError(404, 'No open battle with that code.');
  return join(ctx, await advance(ctx, b), me);
}

/** POST /api/battles/:id/join */
export async function joinById(req, ctx) {
  const me = await requirePlayer(req, ctx);
  return join(ctx, await advance(ctx, await loadBattle(ctx, req.params.id)), me);
}

/** POST /api/battles/:id/begin : the creator goes on with the players who are there (at least 2). */
export async function beginBattle(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const b = await loadBattle(ctx, req.params.id);
  if (b.createdBy !== me.id) throw new HttpError(403, 'Only the player who started this battle can start it early.');
  if (b.status === 'active') return ok({ battle: await stateFor(ctx, b, me) });
  if (b.status !== 'open') throw new HttpError(409, 'This battle is over.');
  if (b.players.length < 2) throw new HttpError(409, 'Wait until at least one other player has joined.');
  await begin(ctx, b);
  return ok({ battle: await stateFor(ctx, b, me) });
}

/**
 * POST /api/battles/:id/cancel : the creator withdraws before the first hand
 * (for everybody), or an invited player declines a rematch.
 */
export async function cancelBattle(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const b = await loadBattle(ctx, req.params.id);
  const invited = b.invites.includes(me.id);
  if (b.createdBy !== me.id && !invited) throw new HttpError(403, 'Only the player who started this battle can cancel it.');
  if (b.status === 'cancelled') return ok({ battle: await viewFor(ctx, b, me) });
  const notStarted = b.status === 'open' || (b.status === 'active' && b.live?.phase === 'ready' && !b.live.started);
  if (!notStarted) throw new HttpError(409, 'The battle has started; it can no longer be cancelled.');
  if (b.createdBy === me.id) {
    b.status = 'cancelled';
    b.cancelReason = 'creator';
    b.cancelledAt = ctx.now();
  } else {
    b.invites = b.invites.filter((x) => x !== me.id);
    b.declined.push(me.id);
    if (!b.invites.length) {
      if (b.players.length >= 2) { await begin(ctx, b); return ok({ battle: await viewFor(ctx, b, me) }); } // the others are all in
      b.status = 'cancelled'; b.cancelReason = 'declined'; b.cancelledAt = ctx.now();
    }
  }
  await ctx.storage.putBattle(b);
  return ok({ battle: await viewFor(ctx, b, me) });
}

/** POST /api/battles/:id/rematch : a new battle for the same players (each other one accepts by joining). */
export async function rematch(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const b = await advance(ctx, await loadBattle(ctx, req.params.id));
  if (!isMember(b, me.id) || b.players.length < 2) throw new HttpError(403, 'Not your battle.');
  if (b.status !== 'finished' && !(b.status === 'cancelled' && b.joinedAt)) throw new HttpError(409, 'Finish this battle first.');
  if (b.rematchId) {
    const r = await getB(ctx, b.rematchId);
    if (r && (r.status === 'open' || r.status === 'active' || r.status === 'finished')) return ok({ battle: await viewFor(ctx, r, me), existing: true });
  }
  const r = newBattle(ctx, me, await newCode(ctx), {
    size: b.players.length, invites: b.players.filter((x) => x !== me.id), inviteOnly: true, rematchOf: b.id,
  });
  await ctx.storage.putBattle(r);
  b.rematchId = r.id;
  await ctx.storage.putBattle(b);
  touch(ctx, r, me.id);
  return ok({ battle: await stateFor(ctx, r, me), existing: false }, 201);
}

/**
 * POST /api/battles/:id/ready {ready} : Ready in the ready check (can be taken
 * back until everybody is ready), Continue after a decision, Next hand / See
 * the result after a hand.
 */
export async function readyBattle(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const b = await advance(ctx, await loadBattle(ctx, req.params.id));
  if (!isMember(b, me.id)) throw new HttpError(403, 'Not your battle.');
  touch(ctx, b, me.id);
  const L = b.live;
  const want = req.body?.ready !== false;
  if (!L || !['ready', 'review', 'handEnd'].includes(L.phase)) throw new HttpError(409, 'There is nothing to be ready for right now.');
  if (L.phase !== 'ready' && !want) throw new HttpError(409, 'Continue cannot be taken back.');
  const now = ctx.now();
  if (want) {
    if (!L.ready[me.id]) {
      L.ready[me.id] = true;
      L.lastReadyAt = now;
      if (L.phase !== 'ready' && L.firstReadyAt === null) L.firstReadyAt = now;
    }
  } else delete L.ready[me.id];
  if (L.phase === 'ready' && b.players.every((id) => L.ready[id])) {
    // Everybody is ready: one shared start moment a few seconds ahead.
    Object.assign(L, { phase: 'countdown', kind: L.started ? 'resume' : 'start', startsAt: now + BATTLE.countdownMs, ready: {}, started: true });
  }
  await ctx.storage.putBattle(b);
  await advance(ctx, b);
  return ok({ battle: await stateFor(ctx, b, me) });
}

// ---------- endpoints: playing ----------
function handArg(b, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= b.hands.length) throw new HttpError(400, 'Bad hand.');
  return n;
}
function handPuzzle(ctx, hd) {
  const p = ctx.puzzles.get(hd.puzzleId);
  if (!p) throw new HttpError(410, 'This hand is no longer in the puzzle set.');
  return p;
}
async function memberPlay(ctx, b, me) {
  if (!isMember(b, me.id)) throw new HttpError(403, 'Not your battle.');
  if (!b.hands.length) throw new HttpError(409, 'This battle has not started yet.');
  const bp = await ctx.storage.getBattlePlay(b.id, me.id);
  if (!bp) throw new HttpError(409, 'This battle has not started yet.');
  return bp;
}
// A battle hand as a play record, for the shared reveal / recap helpers.
const asPlay = (hd, h) => ({ fingerprint: hd.fingerprint, choices: h.choices });
function handEnd(p, hd, h) {
  const end = endStep(p);
  return {
    step: end, heroNet: end.heroNet, score: h.score,
    takeaway: p.explanations?.takeaway || null, tags: p.solution.tags || [],
    others: [], recap: recapOf(p, asPlay(hd, h)),
  };
}

/** The hand as this player may see it right now (start and act answers). */
async function handView(ctx, b, me, bp, n, extra = {}) {
  const hd = b.hands[n], h = bp.hands[n];
  const p = handPuzzle(ctx, hd);
  const L = b.live || { phase: 'done', hand: b.hands.length - 1 };
  const answers = h.choices.map((c) => recordedReveal(p, asPlay(hd, h), c)).filter(Boolean);
  const over = b.status !== 'active' || n < L.hand || (n === L.hand && (L.phase === 'handEnd' || L.phase === 'done'));
  if (over && h.completedAt) {
    return playView(p, p.decisionCount, { mode: 'battle', hand: n, completed: true, answers, end: handEnd(p, hd, h), ...extra, battle: await stateFor(ctx, b, me) }, { tags: true });
  }
  if (over || n !== L.hand || L.phase === 'ready' || L.phase === 'countdown') throw new HttpError(409, 'This hand has not started yet.', { reload: true });
  // Up to and including the open decision (or the one under review), never further.
  const answered = Math.min(h.choices.length, L.index + 1);
  const steps = publicSteps(p, answered).slice(0, p.decisionPositions[L.index] + 1);
  const next = L.phase === 'decide' && !choiceAt(bp, n, L.index) ? L.index : (L.index + 1 < p.decisionCount ? L.index + 1 : null);
  return { ...playView(p, answered, { steps }), next, mode: 'battle', hand: n, completed: false, answers, end: null, ...extra, battle: await stateFor(ctx, b, me) };
}

/** POST /api/battles/:id/start {hand} : the hand as /puzzles/:id/start returns it, at the shared cursor. */
export async function startHand(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const b = await advance(ctx, await loadBattle(ctx, req.params.id));
  const bp = await memberPlay(ctx, b, me);
  const n = handArg(b, req.body?.hand);
  touch(ctx, b, me.id);
  return ok(await handView(ctx, b, me, bp, n));
}

/** POST /api/battles/:id/act {hand, decisionIndex, optionId} or {hand, decisionIndex, timeout: true} */
export async function actHand(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const b = await advance(ctx, await loadBattle(ctx, req.params.id));
  let bp = await memberPlay(ctx, b, me);
  const n = handArg(b, req.body?.hand);
  const hd = b.hands[n];
  const index = Number(req.body?.decisionIndex);
  const wantTimeout = req.body?.timeout === true;
  const optionId = String(req.body?.optionId ?? '');
  touch(ctx, b, me.id);
  const p = handPuzzle(ctx, hd);
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'Bad decisionIndex.');
  // Past the last decision: the same answer as any decision that is not open (no probing the count).
  if (index >= p.decisionCount) throw new HttpError(409, 'That decision is not open right now.', { reload: true });
  const d = p.solution.steps[p.decisionPositions[index]];
  if (!wantTimeout && !d.options.some((o) => o.id === optionId)) throw new HttpError(400, 'Bad optionId.');

  const rec = choiceAt(bp, n, index);
  if (rec) {
    // Already answered (double submit, second tab), or the clock ran out first: what was recorded.
    return ok({ ...(await handView(ctx, b, me, bp, n)), reveal: recordedReveal(p, asPlay(hd, bp.hands[n]), rec), alreadyAnswered: true, timedOut: !!rec.timeout });
  }
  const L = b.live;
  if (b.status !== 'active' || !L) throw new HttpError(409, b.status === 'cancelled' ? 'This battle was cancelled.' : 'This battle is over.', { reload: true });
  if (L.phase !== 'decide' || n !== L.hand || index !== L.index) throw new HttpError(409, 'That decision is not open right now.', { reload: true });
  if (wantTimeout) {
    // The client's clock says time is up but the server's does not (yet).
    const { first } = firstAnswer(b, await playsOf(ctx, b));
    const retryInMs = first !== null ? Math.max(200, first + BATTLE.clockMs + BATTLE.graceMs - ctx.now() + 100) : null;
    throw new HttpError(409, 'There is still time on this decision.', { retryInMs });
  }
  const r = reveal(p, index, optionId);
  await recordAnswer(ctx, b, bp, n, p, { index, optionId, label: r.choiceLabel, street: d.street, grade: r.grade, points: r.points, at: ctx.now() });
  await advance(ctx, b);
  bp = await ctx.storage.getBattlePlay(b.id, me.id);
  const view = await handView(ctx, b, me, bp, n);
  return ok({ ...view, reveal: r, next: index + 1 < p.decisionCount ? index + 1 : null, end: null, completed: false });
}

// ---------- links into the normal puzzle flow ----------
/**
 * Puzzles a player must play inside a running battle rather than on their
 * own: hands of their active battles that they have not finished there.
 * Read-only (no advance): a battle whose files changed does not hold anything.
 * Returns Map<puzzleId, battleId>.
 */
export async function battleHolds(ctx, playerId) {
  const out = new Map();
  const active = await listB(ctx, { playerId, status: 'active' });
  for (const b of active) {
    if (!isMember(b, playerId) || handsChanged(ctx, b)) continue;
    const bp = await ctx.storage.getBattlePlay(b.id, playerId);
    b.hands.forEach((hd, n) => { if (!bp?.hands[n]?.completedAt) out.set(hd.puzzleId, b.id); });
  }
  return out;
}
