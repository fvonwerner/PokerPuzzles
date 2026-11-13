// Tournament mode: the solved push/fold spots (TOURNAMENT_DIR, default
// data/tournament; docs/TOURNAMENT.md), the drill, the fixed quiz, its
// ranking and the profile block. The rules themselves (the verdict, the facts,
// the drill's sampling) live in web/js/pushfold.js, which the browser imports
// too, so the two can never disagree.
//
// What leaves the server before an answer: the table (seats, stacks, forced
// bets), the decision (who is all-in) and the hand. The solver's numbers for a
// drill or quiz question arrive only with the graded answer. The charts are
// open to every signed-in player (the quiz is on the honour system; the time
// each answer took is recorded).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as PFR from '../../web/js/pushfold.js';
import { HttpError, requirePlayer } from './handlers.mjs';

export const TOURNAMENT = Object.freeze({
  othersMax: 40,     // players listed under "Others on this question"
  dataVersion: 1,    // part of a spot's ETag: bump when the served shape changes
});

const ok = (body, status = 200) => ({ status, body });
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** A small deterministic generator (cards for a quiz question whose stored cards do not fit its class). */
function seeded(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
}

const spotOrder = (a, b) => (a.units === b.units ? 0 : a.units === 'bb' ? -1 : 1)
  || a.seats.length - b.seats.length
  || (a.units === 'bb' ? a.stacks[0] - b.stacks[0] : a.name.localeCompare(b.name));

/**
 * Load the spots and the quiz. The server starts without them (the tab then
 * says the data is not installed). Every quiz question is checked against the
 * spots; one that fails is logged and graded as close (both answers right),
 * one whose spot, decision or class is missing cannot be asked and is left out.
 *   { installed, dir, spots: Map<name, spot>, list: [spot], sets: [{id, title, blurb, questions}], questions: Map<id, question>, warnings: [text] }
 */
export function loadTournament({ root, env = process.env, log = console.log }) {
  const dir = resolve(root, env.TOURNAMENT_DIR || 'data/tournament');
  const state = { installed: false, dir, spots: new Map(), list: [], sets: [], questions: new Map(), warnings: [] };
  const spotsDir = join(dir, 'spots');
  if (!existsSync(spotsDir)) {
    log(`Tournament data not installed (${spotsDir} does not exist): the Tournament tab says so.`);
    return state;
  }
  for (const f of readdirSync(spotsDir).filter((x) => x.endsWith('.json') && !x.startsWith('.')).sort()) {
    try {
      const text = readFileSync(join(spotsDir, f), 'utf8');
      const spot = PFR.normalizeSpot(JSON.parse(text));
      if (!spot.name || !/^[\w-]+$/.test(spot.name)) throw new Error('missing or odd spec.name');
      if (spot.decisions.some((d) => d.freq.length !== 169)) throw new Error('a decision without 169 classes');
      spot.fingerprint = createHash('sha1').update(text).digest('hex').slice(0, 16);
      state.spots.set(spot.name, spot);
    } catch (e) { state.warnings.push(`spot ${f}: ${e.message} (skipped)`); }
  }
  state.list = [...state.spots.values()].sort(spotOrder);
  state.installed = state.spots.size > 0;

  const qf = join(dir, 'quiz.json');
  if (existsSync(qf)) {
    try {
      const raw = JSON.parse(readFileSync(qf, 'utf8'));
      for (const set of raw.sets || []) {
        const questions = [];
        for (const q of set.questions || []) {
          const chk = PFR.checkQuizQuestion((name) => state.spots.get(name), q);
          const where = `quiz question ${q.id} (${q.spot} ${q.decision} ${q.class})`;
          if (chk.fatal) { state.warnings.push(`${where}: ${chk.problems.join('; ')}. It cannot be asked and is left out of set ${set.id}.`); continue; }
          if (!chk.ok) state.warnings.push(`${where}: ${chk.problems.join('; ')}. It is graded as close: both answers count as right.`);
          const cards = PFR.classOfCards(q.cards) === q.class ? q.cards.slice() : PFR.cardsForClass(q.class, seeded(q.id));
          const entry = { id: q.id, setId: set.id, index: questions.length, spot: chk.spot, decision: chk.decision, c: chk.c, cards, invalid: !chk.ok, problems: chk.problems };
          questions.push(entry);
          state.questions.set(q.id, entry);
        }
        state.sets.push({ id: set.id, title: set.title, blurb: set.blurb || '', questions });
      }
    } catch (e) { state.warnings.push(`quiz.json: ${e.message} (no quiz)`); }
  } else state.warnings.push(`no quiz.json in ${dir} (no quiz)`);

  for (const w of state.warnings) log(`WARNING tournament: ${w}`);
  log(`Tournament: ${state.spots.size} spots, quiz ${state.sets.length} sets with ${state.questions.size} questions (${dir})${state.warnings.length ? `, ${state.warnings.length} warning(s)` : ''}.`);
  return state;
}

function requireData(ctx) {
  const t = ctx.tournament;
  if (!t?.installed) throw new HttpError(503, 'The tournament data is not installed on this server.');
  return t;
}
function requireSet(t, id) {
  const set = t.sets.find((s) => s.id === id);
  if (!set) throw new HttpError(404, 'No such quiz set.');
  return set;
}
async function friendIds(ctx, meId) {
  const out = new Set();
  for (const l of await ctx.storage.listFriendLinks({ playerId: meId })) if (l.status === 'friends') out.add(l.from === meId ? l.to : l.from);
  return out;
}

// ---------- the menu ----------
/** Seats that have a decision the drill asks, per kind (for the drill's choices). */
function askedSeats(spot) {
  const out = { open: [], call: [] };
  for (const d of spot.decisions) {
    if (!PFR.isAskable(spot, d)) continue;
    const k = PFR.kindOf(d);
    if (!out[k].includes(d.seat)) out[k].push(d.seat);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => PFR.SEATS.indexOf(a) - PFR.SEATS.indexOf(b));
  return out;
}
const setMeta = (set) => ({ id: set.id, title: set.title, blurb: set.blurb, count: set.questions.length });
function setProgress(set, play) {
  const answers = play?.answers || [];
  return {
    ...setMeta(set),
    answered: answers.length,
    finished: !!play?.finishedAt,
    right: play?.finishedAt ? answers.filter((a) => a.right).length : null, // right answers once the set is finished
    timeMs: play?.finishedAt ? answerTime(play) : null,
  };
}
/** Time spent answering: for each question, from when it was first shown to the answer. */
const answerTime = (play) => (play?.answers || []).reduce((a, x) => a + Math.max(0, (x.at || 0) - (x.shownAt || x.at || 0)), 0);

/** GET /api/tournament : the spots (no solver output), the quiz sets with your progress, your drill totals. */
export async function menu(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const t = ctx.tournament;
  if (!t?.installed) return ok({ installed: false });
  const plays = new Map((await ctx.storage.listQuizPlays({ playerId: me.id })).map((p) => [p.setId, p]));
  return {
    status: 200, compress: true,
    body: {
      installed: true,
      spots: t.list.map((s) => ({ ...PFR.spotMeta(s), asked: askedSeats(s) })),
      quiz: t.sets.map((s) => setProgress(s, plays.get(s.id))),
      drill: drillView(await ctx.storage.getDrillTotals(me.id)),
    },
  };
}

/**
 * GET /api/tournament/spots/:name : one spot's solution for the charts: the
 * spot and every decision with its per-class numbers (frequencies 3 decimals,
 * EVs and errors 4). Gzip when accepted, an ETag (304 when unchanged).
 */
export async function spotData(req, ctx) {
  await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const spot = t.spots.get(req.params.id);
  if (!spot) throw new HttpError(404, 'No such spot.');
  if (!spot.served) {
    const body = {
      ...PFR.spotMeta(spot),
      decisions: spot.decisions.map((d) => ({ ...PFR.decisionData(d), askable: PFR.isAskable(spot, d) })),
    };
    const raw = JSON.stringify(body);
    // weak: the same ETag for the gzipped and the plain body
    spot.served = { raw, gz: gzipSync(raw), etag: `W/"pf${TOURNAMENT.dataVersion}-${spot.fingerprint}"` };
  }
  return { status: 200, raw: spot.served.raw, gz: spot.served.gz, etag: spot.served.etag };
}

// ---------- the drill ----------
function newDrill(playerId, now) {
  return {
    playerId, hands: 0, right: 0,
    kinds: { open: { hands: 0, right: 0 }, call: { hands: 0, right: 0 } },
    values: { chips: { hands: 0, right: 0, cost: 0 }, points: { hands: 0, right: 0, cost: 0 } },
    firstAt: now, lastAt: now,
  };
}
/** Drill totals as sent: hands, right; by kind; by value with the EV given up (chips in bb, points in points). */
function drillView(rec) {
  const r = rec || newDrill(null, null);
  return {
    hands: r.hands, right: r.right,
    kinds: { open: { ...r.kinds.open }, call: { ...r.kinds.call } },
    values: { chips: { ...r.values.chips }, points: { ...r.values.points } },
    lastAt: r.lastAt || null,
  };
}

/** GET /api/tournament/drill/next?value&players&stack&situation&seat&kind&hands&avoid : the next drill question (no solver output). */
export async function drillNext(req, ctx) {
  await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const prefs = PFR.normalizePrefs(req.query || {});
  const q = PFR.sampleQuestion(t.list, prefs, Math.random, typeof req.query?.avoid === 'string' ? req.query.avoid : null);
  if (!q) throw new HttpError(404, 'No hands match these choices. Change them and try again.');
  return ok({ prefs, question: PFR.questionPayload(q.spot, q.decision, q.c, q.cards) });
}

/** The question an answer is about, checked: a drill question has to be one the drill can ask. */
function drillQuestionOf(t, body) {
  const spot = t.spots.get(String(body?.spot ?? ''));
  if (!spot) throw new HttpError(404, 'No such spot.');
  const d = PFR.decisionById(spot, String(body?.decision ?? ''));
  if (!d || !PFR.isAskable(spot, d)) throw new HttpError(400, 'That decision is not one the drill asks.');
  const c = PFR.classIndex(String(body?.class ?? ''));
  if (c < 0 || d.ev_diff[c] === null || !(d.class_reach[c] > 0)) throw new HttpError(400, 'Bad hand class.');
  const action = body?.action;
  if (action !== 'fold' && action !== 'allin') throw new HttpError(400, 'Answer "fold" or "allin".');
  const cards = PFR.classOfCards(body?.cards) === PFR.CLASSES[c] ? body.cards.slice() : PFR.cardsForClass(PFR.CLASSES[c]);
  return { spot, d, c, action, cards };
}

/** POST /api/tournament/drill/answer {spot, decision, class, cards, action} : graded from the server's own data; adds to your totals. */
export async function drillAnswer(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const { spot, d, c, action, cards } = drillQuestionOf(t, req.body);
  const fb = PFR.buildFeedback(spot, d, c, action, cards);
  const now = ctx.now();
  const rec = (await ctx.storage.getDrillTotals(me.id)) || newDrill(me.id, now);
  const right = fb.verdict.right ? 1 : 0;
  const kind = PFR.kindOf(d);
  const value = spot.units === 'points' ? 'points' : 'chips';
  rec.hands++; rec.right += right;
  rec.kinds[kind].hands++; rec.kinds[kind].right += right;
  rec.values[value].hands++; rec.values[value].right += right;
  rec.values[value].cost = r4(rec.values[value].cost + fb.verdict.cost);
  rec.lastAt = now;
  await ctx.storage.putDrillTotals(rec);
  return ok({ feedback: fb, totals: drillView(rec) });
}

// ---------- the quiz ----------
const quizQuestion = (q) => ({ id: q.id, ...PFR.questionPayload(q.spot, q.decision, q.c, q.cards) });
const newQuizPlay = (playerId, setId) => ({ playerId, setId, startedAt: null, finishedAt: null, shown: {}, answers: [] });

/**
 * The feedback of a recorded answer, for the hand that was asked (also when
 * quiz.json has changed that question since). The stored result stays: it is
 * what counted. null when that hand is no longer in the data.
 */
function recordedFeedback(t, q, a) {
  let spot = q.spot, d = q.decision, c = q.c, forceClose = q.invalid;
  const same = a.spot === spot.name && a.decision === d.id && a.class === PFR.CLASSES[c];
  if (!same) {
    spot = t.spots.get(a.spot);
    d = spot ? PFR.decisionById(spot, a.decision) : null;
    c = PFR.classIndex(a.class);
    if (!d || c < 0) return null;
    forceClose = false;
  }
  const cards = PFR.classOfCards(a.cards) === PFR.CLASSES[c] ? a.cards : PFR.classOfCards(q.cards) === PFR.CLASSES[c] ? q.cards : PFR.cardsForClass(PFR.CLASSES[c], seeded(a.q));
  const fb = PFR.buildFeedback(spot, d, c, a.action, cards, { forceClose });
  if (!fb) return null;
  if (!same || fb.verdict.right !== a.right || fb.verdict.grade !== a.grade) {
    fb.stale = true;
    fb.verdict = { ...fb.verdict, right: a.right, grade: a.grade, label: PFR.GRADE_LABELS[a.grade] || a.grade, cost: a.cost };
  }
  return fb;
}

/**
 * POST /api/tournament/quiz/:set/next : the next unanswered question of the
 * set (only that one), stamped with when it was first shown; { done: true }
 * once all are answered.
 */
export async function quizNext(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const set = requireSet(t, req.params.id);
  const play = (await ctx.storage.getQuizPlay(me.id, set.id)) || newQuizPlay(me.id, set.id);
  const index = play.answers.length;
  const base = { set: setMeta(set), count: set.questions.length, answered: index };
  if (index >= set.questions.length) return ok({ ...base, done: true, index: null, question: null });
  const q = set.questions[index];
  const now = ctx.now();
  if (!play.shown[q.id]) {
    play.shown[q.id] = now;
    if (!play.startedAt) play.startedAt = now;
    await ctx.storage.putQuizPlay(play);
  }
  return ok({ ...base, done: false, index, question: quizQuestion(q), shownAt: play.shown[q.id] });
}

/**
 * POST /api/tournament/quiz/:set/answer {question, action} : only the next
 * unanswered question can be answered; the first answer counts and cannot be
 * changed (answering again returns the recorded one, alreadyAnswered).
 */
export async function quizAnswer(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const set = requireSet(t, req.params.id);
  const qid = String(req.body?.question ?? '');
  const action = req.body?.action;
  const q = set.questions.find((x) => x.id === qid);
  if (!q) throw new HttpError(404, 'No such question in this set.');
  if (action !== 'fold' && action !== 'allin') throw new HttpError(400, 'Answer "fold" or "allin".');
  const play = (await ctx.storage.getQuizPlay(me.id, set.id)) || newQuizPlay(me.id, set.id);
  const count = set.questions.length;
  const done = play.answers.findIndex((a) => a.q === qid);
  if (done >= 0) {
    const a = play.answers[done];
    return ok({ alreadyAnswered: true, index: done, count, done: !!play.finishedAt, feedback: recordedFeedback(t, q, a), others: await othersFor(ctx, me, set.id, qid) });
  }
  const index = play.answers.length;
  if (set.questions[index]?.id !== qid) throw new HttpError(409, `Answer question ${index + 1} first.`, { index });
  const now = ctx.now();
  const fb = PFR.buildFeedback(q.spot, q.decision, q.c, action, q.cards, { forceClose: q.invalid });
  const shownAt = play.shown[qid] || now;
  play.shown[qid] = shownAt;
  if (!play.startedAt) play.startedAt = shownAt;
  play.answers.push({
    q: qid, spot: q.spot.name, decision: q.decision.id, class: PFR.CLASSES[q.c], cards: q.cards.slice(), action,
    right: fb.verdict.right, grade: fb.verdict.grade, cost: fb.verdict.cost, close: fb.verdict.close, shownAt, at: now,
  });
  if (play.answers.length >= count) play.finishedAt = now;
  await ctx.storage.putQuizPlay(play);
  return ok({ index, count, done: !!play.finishedAt, feedback: fb, others: await othersFor(ctx, me, set.id, qid) });
}

/**
 * GET /api/tournament/quiz/:set/summary : your answers in this set so far
 * (each with its feedback), right answers, the time answering. Only answered
 * questions are in it.
 */
export async function quizSummary(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const set = requireSet(t, req.params.id);
  const play = await ctx.storage.getQuizPlay(me.id, set.id);
  const answers = [];
  for (const [i, a] of (play?.answers || []).entries()) {
    const q = t.questions.get(a.q);
    answers.push({
      index: i, id: a.q, action: a.action, right: a.right, grade: a.grade, cost: a.cost,
      timeMs: Math.max(0, (a.at || 0) - (a.shownAt || a.at || 0)),
      feedback: q ? recordedFeedback(t, q, a) : null,
    });
  }
  return {
    status: 200, compress: true,
    body: {
      set: setMeta(set), count: set.questions.length, answered: answers.length,
      right: answers.filter((a) => a.right).length, finished: !!play?.finishedAt,
      startedAt: play?.startedAt || null, finishedAt: play?.finishedAt || null, timeMs: answerTime(play),
      answers,
    },
  };
}

/** Who else has answered a question, and whether they got it right (friends first). Only for a viewer who has answered it. */
async function othersFor(ctx, me, setId, qid) {
  const friends = await friendIds(ctx, me.id);
  const rows = [];
  for (const p of await ctx.storage.listQuizPlays({ setId })) {
    if (p.playerId === me.id) continue;
    const a = p.answers.find((x) => x.q === qid);
    if (!a) continue;
    const pl = await ctx.storage.getPlayer(p.playerId);
    if (pl) rows.push({ player: { id: pl.id, name: pl.name }, friend: friends.has(pl.id), right: !!a.right });
  }
  rows.sort((a, b) => (b.friend - a.friend) || a.player.name.localeCompare(b.player.name, undefined, { sensitivity: 'base' }));
  return { total: rows.length, right: rows.filter((r) => r.right).length, friends: rows.filter((r) => r.friend).length, others: rows.slice(0, TOURNAMENT.othersMax) };
}

/** GET /api/tournament/quiz/questions/:id/others : 403 until you have answered the question. */
export async function quizOthers(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const q = t.questions.get(req.params.id);
  if (!q) throw new HttpError(404, 'No such question.');
  const play = await ctx.storage.getQuizPlay(me.id, q.setId);
  if (!play?.answers.some((a) => a.q === q.id)) throw new HttpError(403, 'Answer this question first. How the others did shows once you have.');
  return ok({ question: q.id, ...(await othersFor(ctx, me, q.setId, q.id)) });
}

/**
 * GET /api/tournament/quiz/ranking?scope=everyone|friends : by right answers
 * over all finished sets (close hands count as right); equal numbers share a
 * place; players with no finished set are not ranked (and not listed).
 */
export async function quizRanking(req, ctx) {
  const me = await requirePlayer(req, ctx);
  const t = requireData(ctx);
  const scope = req.query?.scope === 'friends' ? 'friends' : 'everyone';
  const friends = await friendIds(ctx, me.id);
  const per = new Map();
  for (const p of await ctx.storage.listQuizPlays()) {
    if (!p.finishedAt || !t.sets.some((s) => s.id === p.setId)) continue;
    const e = per.get(p.playerId) || { right: 0, answered: 0, sets: 0 };
    e.sets++;
    e.right += p.answers.filter((a) => a.right).length;
    e.answered += p.answers.length;
    per.set(p.playerId, e);
  }
  let rows = [];
  for (const [id, e] of per) {
    const pl = await ctx.storage.getPlayer(id);
    if (pl) rows.push({ id, name: pl.name, right: e.right, answered: e.answered, sets: e.sets, friend: friends.has(id) });
  }
  if (scope === 'friends') rows = rows.filter((r) => r.id === me.id || r.friend);
  rows.sort((a, b) => (b.right - a.right) || (a.sets - b.sets) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].right === r.right ? rows[i - 1].rank : i + 1; });
  return ok({ scope, you: me.id, ranked: per.has(me.id), players: rows, setCount: t.sets.length, friendCount: friends.size });
}

/**
 * The "Tournament quiz" block of a profile: finished sets with right answers
 * (another player's: finished sets only); your own also the sets you are in
 * the middle of and your drill totals. null when the data is not installed.
 */
export async function tournamentProfile(ctx, viewerId, ownerId) {
  const t = ctx.tournament;
  if (!t?.installed) return null;
  const own = viewerId === ownerId;
  const plays = new Map((await ctx.storage.listQuizPlays({ playerId: ownerId })).map((p) => [p.setId, p]));
  const sets = [];
  for (const set of t.sets) {
    const p = plays.get(set.id);
    if (!p) continue;
    if (p.finishedAt) sets.push({ id: set.id, title: set.title, count: set.questions.length, finished: true, right: p.answers.filter((a) => a.right).length, finishedAt: p.finishedAt });
    else if (own && p.answers.length) sets.push({ id: set.id, title: set.title, count: set.questions.length, finished: false, answered: p.answers.length });
  }
  const out = { setCount: t.sets.length, sets };
  if (own) out.drill = drillView(await ctx.storage.getDrillTotals(ownerId));
  return out;
}
