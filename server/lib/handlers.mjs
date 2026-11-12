// API handlers: plain async functions of (request, ctx) -> { status, body }.
//   request = { params, body, token }
//   ctx     = { storage, puzzles: Map, usingFixtures, now() }
// No HTTP in here, so the same logic can run behind another host or storage.
import { AUTH, validateName, validatePin, hashPin, checkPin, newId, newToken } from './auth.mjs';
import { header, publicSteps, reveal, endStep, timeoutReveal } from './view.mjs';
import { puzzleScore, GRADE_ORDER, GRADE_LABELS } from './grading.mjs';
import { battleHolds } from './battles.mjs';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const ok = (body, status = 200) => ({ status, body });
const publicPlayer = (p) => ({ id: p.id, name: p.name });

export async function requirePlayer(req, ctx) {
  if (!req.token) throw new HttpError(401, 'Not signed in.');
  const s = await ctx.storage.getSession(req.token);
  if (!s || s.expiresAt < ctx.now()) throw new HttpError(401, 'Session expired. Please sign in again.');
  const player = await ctx.storage.getPlayer(s.playerId);
  if (!player) throw new HttpError(401, 'Unknown player.');
  return player;
}
function requirePuzzle(req, ctx) {
  const p = ctx.puzzles.get(req.params.id);
  if (!p) throw new HttpError(404, 'No such puzzle.');
  return p;
}
const isDone = (play) => !!(play && play.completedAt);

// ---------- auth ----------
export async function login(req, ctx) {
  const n = validateName(req.body?.name);
  if (n.error) throw new HttpError(400, n.error);
  const pv = validatePin(req.body?.pin);
  if (pv.error) throw new HttpError(400, pv.error);
  const now = ctx.now();
  let player = await ctx.storage.getPlayerByName(n.name);
  let created = false;
  if (!player) {
    const { salt, hash } = await hashPin(pv.pin);
    player = { id: newId(), name: n.name, nameKey: n.name.toLowerCase(), pinSalt: salt, pinHash: hash, failures: 0, lockedUntil: 0, createdAt: now };
    await ctx.storage.putPlayer(player);
    created = true;
  } else {
    if (player.lockedUntil && player.lockedUntil > now) {
      const mins = Math.ceil((player.lockedUntil - now) / 60000);
      throw new HttpError(429, `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    const good = await checkPin(pv.pin, player.pinSalt, player.pinHash);
    // re-read after the slow hash so concurrent attempts both count
    player = await ctx.storage.getPlayer(player.id);
    if (!good) {
      player.failures = (player.failures || 0) + 1;
      let msg = 'Wrong PIN for this name. (New here? Pick a name nobody uses yet.)';
      if (player.failures >= AUTH.maxFailures) {
        player.failures = 0;
        player.lockedUntil = now + AUTH.lockMs;
        msg = `Too many wrong PINs. This name is locked for ${AUTH.lockMs / 60000} minutes.`;
      }
      await ctx.storage.putPlayer(player);
      throw new HttpError(401, msg);
    }
    if (player.failures || player.lockedUntil) { player.failures = 0; player.lockedUntil = 0; await ctx.storage.putPlayer(player); }
  }
  const token = newToken();
  await ctx.storage.putSession({ token, playerId: player.id, createdAt: now, expiresAt: now + AUTH.sessionMs });
  return ok({ token, player: publicPlayer(player), created });
}

export async function logout(req, ctx) {
  if (req.token) await ctx.storage.deleteSession(req.token);
  return ok({ ok: true });
}

export async function me(req, ctx) {
  const player = await requirePlayer(req, ctx);
  return ok({ player: publicPlayer(player), usingFixtures: ctx.usingFixtures });
}

// ---------- puzzles ----------
export async function listPuzzles(req, ctx) {
  const player = await requirePlayer(req, ctx);
  const plays = await ctx.storage.listPlays({ playerId: player.id });
  const byPuzzle = new Map(plays.map((pl) => [pl.puzzleId, pl]));
  const holds = await battleHolds(ctx, player.id);
  const puzzles = [...ctx.puzzles.values()].map((p) => {
    const s = p.solution, play = byPuzzle.get(s.id);
    const done = isDone(play);
    const row = {
      id: s.id, number: p.number, title: s.title,
      scenario: s.scenario, hero: { seat: s.hero.seat, position: s.hero.position },
      villain: { seat: s.villain.seat, position: s.villain.position },
      ...(done ? { decisionCount: p.decisionCount } : {}), // the count only once the hand is done
      rank: p.rank, level: p.level, // difficulty; the raw ease number is not sent
      status: !play ? 'new' : done ? 'done' : 'in_progress',
      answered: play ? play.choices.length : 0,
      // A partial play (finished by hand from an unfinished battle) counts as played but is never scored.
      score: done && !play.partial ? play.score : null,
      ...(done && play.partial ? { scored: false } : {}),
    };
    if (done) row.tags = s.tags || []; // tags can spoil the answer: only after completion
    else if (holds.has(s.id)) row.battle = holds.get(s.id); // to be played inside that battle
    return row;
  });
  return ok({ puzzles, nextId: nextPuzzleId(puzzles), usingFixtures: ctx.usingFixtures });
}

/** The puzzle to play next: an unfinished scored play first, else the easiest unplayed, else null. Hands waiting in a battle are skipped. */
export function nextPuzzleId(rows) {
  const byRank = rows.filter((r) => !r.battle).sort((a, b) => a.rank - b.rank);
  return (byRank.find((r) => r.status === 'in_progress') || byRank.find((r) => r.status === 'new'))?.id ?? null;
}

async function othersScores(ctx, puzzleId, playerId) {
  const plays = (await ctx.storage.listPlays({ puzzleId })).filter((pl) => pl.completedAt && !pl.partial && pl.playerId !== playerId);
  const out = [];
  for (const pl of plays) {
    const pp = await ctx.storage.getPlayer(pl.playerId);
    if (pp) out.push({ name: pp.name, score: pl.score, completedAt: pl.completedAt });
  }
  return out.sort((a, b) => b.score - a.score || a.completedAt - b.completedAt);
}

/**
 * Reveal for a recorded first-play choice. If the puzzle file changed since
 * the play (different fingerprint), the stored grade and points are kept, and
 * a choice that no longer exists is shown against the current main line.
 */
export function recordedReveal(p, play, c) {
  if (c.index >= p.decisionCount) return null;
  if (c.timeout) return timeoutReveal(p, c.index); // a battle decision that ran out of time: 0 points
  const stale = !!play.fingerprint && play.fingerprint !== p.fingerprint;
  let r;
  try {
    r = reveal(p, c.index, c.optionId);
  } catch {
    const d = p.solution.steps[p.decisionPositions[c.index]];
    r = { ...reveal(p, c.index, d.mainLine), choice: c.optionId, choiceLabel: `${c.optionId} (no longer an option)`, offMainLine: true, continuesWith: null };
  }
  if (stale) Object.assign(r, { grade: c.grade, label: GRADE_LABELS[c.grade], points: c.points, stale: true });
  return r;
}
const recordedReveals = (p, play) => play.choices.map((c) => recordedReveal(p, play, c)).filter(Boolean);

// Recap of the first play: stored grades and points are authoritative (they made the score).
export function recapOf(p, play) {
  return play.choices.map((c) => {
    const r = recordedReveal(p, play, c);
    return { index: c.index, street: r?.decision.street || c.street || null, choice: c.optionId, choiceLabel: r?.choiceLabel || c.label || c.optionId, grade: c.grade, label: GRADE_LABELS[c.grade], points: c.points };
  });
}

async function endInfo(p, ctx, player, play) {
  const end = endStep(p);
  return {
    step: end,
    heroNet: end.heroNet,
    score: play && !play.partial ? play.score : null,
    partial: !!play?.partial,
    takeaway: p.explanations?.takeaway || null,
    tags: p.solution.tags || [],
    others: await othersScores(ctx, p.solution.id, player.id),
    recap: play ? recapOf(p, play) : null,
  };
}

export function playView(p, answered, extra = {}, { tags = false } = {}) {
  return {
    puzzle: header(p, { tags, count: answered >= p.decisionCount }),
    steps: publicSteps(p, answered),
    next: answered < p.decisionCount ? answered : null,
    ...extra,
  };
}

/** A hand of a running battle is played there, not on its own (until the battle is over or the hand is done). */
async function refuseIfInBattle(ctx, player, p, play) {
  if (isDone(play)) return;
  const battleId = (await battleHolds(ctx, player.id)).get(p.solution.id);
  if (battleId) throw new HttpError(409, 'This hand is part of a battle you are playing. Play it there.', { battle: battleId });
}

const newPlay = (player, p, ctx) => ({ playerId: player.id, puzzleId: p.solution.id, fingerprint: p.fingerprint, choices: [], startedAt: ctx.now(), completedAt: null, score: null });

export async function startPuzzle(req, ctx) {
  const player = await requirePlayer(req, ctx);
  const p = requirePuzzle(req, ctx);
  const mode = req.body?.mode === 'practice' ? 'practice' : 'scored';
  let play = await ctx.storage.getPlay(player.id, p.solution.id);
  if (mode === 'practice') {
    if (!isDone(play)) throw new HttpError(409, 'Finish your scored play of this puzzle before practising it.');
    return ok(playView(p, 0, { mode, answers: [], end: null }, { tags: true }));
  }
  await refuseIfInBattle(ctx, player, p, play);
  let restarted = false;
  if (play && !isDone(play) && play.fingerprint && play.fingerprint !== p.fingerprint && play.choices.length) {
    // The puzzle file changed under an unfinished play: its recorded choices may no longer fit.
    play = newPlay(player, p, ctx);
    await ctx.storage.putPlay(play);
    restarted = true;
  }
  if (!play) {
    play = newPlay(player, p, ctx);
    await ctx.storage.putPlay(play);
  }
  const done = isDone(play);
  const answers = recordedReveals(p, play);
  if (done) {
    return ok(playView(p, p.decisionCount, { mode, completed: true, answers, end: await endInfo(p, ctx, player, play) }, { tags: true }));
  }
  return ok(playView(p, play.choices.length, { mode, completed: false, restarted, answers, end: null }));
}

export async function act(req, ctx) {
  const player = await requirePlayer(req, ctx);
  const p = requirePuzzle(req, ctx);
  const mode = req.body?.mode === 'practice' ? 'practice' : 'scored';
  const index = Number(req.body?.decisionIndex);
  const optionId = String(req.body?.optionId ?? '');
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'Bad decisionIndex.');
  let play = await ctx.storage.getPlay(player.id, p.solution.id);
  // Past the last decision: the same answer as skipping ahead, so the count cannot be probed.
  if (index >= p.decisionCount) throw new HttpError(isDone(play) && mode !== 'practice' ? 400 : 409, isDone(play) ? 'Bad decisionIndex.' : `Answer decision ${play ? play.choices.length : 0} first.`);
  const d = p.solution.steps[p.decisionPositions[index]];
  if (!d.options.some((o) => o.id === optionId)) throw new HttpError(400, 'Bad optionId.');

  if (mode === 'practice') {
    if (!isDone(play)) throw new HttpError(409, 'Practice mode opens after your scored play.');
    const r = reveal(p, index, optionId);
    const last = index === p.decisionCount - 1;
    return ok({ mode, reveal: r, ...playView(p, index + 1, {}, { tags: true }), end: last ? await endInfo(p, ctx, player, null) : null });
  }

  if (!play) throw new HttpError(409, 'Start the puzzle first.');
  await refuseIfInBattle(ctx, player, p, play);
  if (isDone(play) || index < play.choices.length) {
    // Already answered (double submit, a second tab, or a finished puzzle): return what was recorded.
    const rec = play.choices[Math.min(index, play.choices.length - 1)];
    const r = recordedReveal(p, play, rec);
    const done = isDone(play);
    const end = done ? await endInfo(p, ctx, player, play) : null;
    return ok({ mode, reveal: r, alreadyAnswered: true, ...playView(p, done ? p.decisionCount : play.choices.length, {}, { tags: done }), end });
  }
  if (play.fingerprint && play.fingerprint !== p.fingerprint) {
    throw new HttpError(409, 'This puzzle was updated while you were playing it. Reload to start it again.', { reload: true });
  }
  if (index > play.choices.length) throw new HttpError(409, `Answer decision ${play.choices.length} first.`);

  const r = reveal(p, index, optionId);
  play.choices.push({ index, optionId, label: r.choiceLabel, street: d.street, grade: r.grade, points: r.points, at: ctx.now() });
  const last = play.choices.length === p.decisionCount;
  if (last) {
    play.completedAt = ctx.now();
    play.score = puzzleScore(play.choices.map((c) => c.points));
  }
  await ctx.storage.putPlay(play);
  const end = last ? await endInfo(p, ctx, player, play) : null;
  return ok({ mode, reveal: r, ...playView(p, play.choices.length, {}, { tags: last }), end });
}

export async function review(req, ctx) {
  const player = await requirePlayer(req, ctx);
  const p = requirePuzzle(req, ctx);
  const play = await ctx.storage.getPlay(player.id, p.solution.id);
  if (!isDone(play)) throw new HttpError(403, 'Review opens after you have completed the puzzle.');
  return ok({
    puzzle: header(p, { full: true }),
    steps: p.solution.steps,
    answers: recordedReveals(p, play),
    end: await endInfo(p, ctx, player, play),
  });
}

export async function leaderboard(req, ctx) {
  const me_ = await requirePlayer(req, ctx);
  const players = await ctx.storage.listPlayers();
  const plays = (await ctx.storage.listPlays()).filter((pl) => pl.completedAt && !pl.partial && ctx.puzzles.has(pl.puzzleId)); // partial plays are never scored
  const rows = players.map((pl) => {
    const mine = plays.filter((x) => x.playerId === pl.id);
    const grades = Object.fromEntries(GRADE_ORDER.map((g) => [g, 0]));
    for (const x of mine) for (const c of x.choices) grades[c.grade] = (grades[c.grade] || 0) + 1;
    const total = mine.reduce((a, x) => a + x.score, 0);
    return {
      id: pl.id, name: pl.name, played: mine.length, totalPoints: total,
      average: mine.length ? Math.round((10 * total) / mine.length) / 10 : null,
      decisions: Object.values(grades).reduce((a, b) => a + b, 0), grades,
    };
  });
  rows.sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || b.played - a.played || a.name.localeCompare(b.name));
  return ok({ players: rows, you: me_.id, puzzleCount: ctx.puzzles.size });
}
