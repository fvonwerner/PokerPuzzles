#!/usr/bin/env node
// End-to-end API test. Starts the server on a spare port with a temporary db
// and the fixture puzzles, plays through the API as two players and asserts
// the rules. No dependencies.
//
//   node server/tools/make-fixture.mjs && node server/tools/smoke.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, cpSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The fixtures live in data/ next to server/ (or one level up when run from a dev copy).
const DATA = existsSync(join(ROOT, 'data', 'solutions-fixture')) ? join(ROOT, 'data') : join(ROOT, '..', 'data');
const FIX = join(DATA, 'solutions-fixture');
if (!existsSync(join(FIX, 'fx01.json'))) { console.error('Run node server/tools/make-fixture.mjs first.'); process.exit(1); }

let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else { failed++; console.log(`  FAIL ${msg}`); }
}
const near = (a, b, eps = 0.011) => typeof a === 'number' && Math.abs(a - b) <= eps;

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = mkdtempSync(join(tmpdir(), 'pokerpuzzles-smoke-'));
// Copies of the fixtures, so the test can add and change puzzle files while the server runs.
const SOL = join(tmp, 'solutions'), EXP = join(tmp, 'explanations');
cpSync(FIX, SOL, { recursive: true });
cpSync(join(DATA, 'explanations-fixture'), EXP, { recursive: true });
const RESCAN_MS = 150;
// The real tournament spots and quiz (read only).
const TDIR = join(DATA, 'tournament');
const env = {
  ...process.env, PORT: String(port), DB_FILE: join(tmp, 'db.json'),
  SOLUTIONS_DIR: SOL, EXPLANATIONS_DIR: EXP, RESCAN_MS: String(RESCAN_MS), TEST_CLOCK: '1', TOURNAMENT_DIR: TDIR,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += d; });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start:\n' + srvOut)), 8000);
  const iv = setInterval(() => { if (srvOut.includes('listening')) { clearInterval(iv); clearTimeout(t); res(); } }, 50);
});
const BASE = `http://127.0.0.1:${port}`;

async function api(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

// The current version of a puzzle (the test changes some files while the server runs).
const solution = (id) => JSON.parse(readFileSync(join(SOL, `${id}.json`), 'utf8'));
const hasTags = (obj) => findKeys(obj, ['tags']).length > 0;
const SECRET_DECISION_KEYS = ['hand', 'mainLine', 'stateAfter', 'range', 'villainRange'];
const SECRET_VILLAIN_KEYS = ['freq', 'options', 'range'];
const SECRET_ANYWHERE = ['mainLine', 'stateAfter', 'villainRange', 'ev', 'equity', 'explanation', 'showdown', 'heroNet', 'villainHand', 'takeaway', 'w', 'f', 'combos', 'optionGrades'];
/** A reveal's per-option grades ("try another answer") as { optionId: [grade, points] }. */
const gradesOf = (rv) => Object.fromEntries((rv?.optionGrades || []).map((g) => [g.id, [g.grade, g.points]]));
/** The per-option grades line up with the decision's options and agree with the reveal for the chosen option. */
function optionGradesOk(rv) {
  const og = rv?.optionGrades;
  if (!Array.isArray(og) || og.length !== rv.decision.options.length) return false;
  if (!og.every((g, k) => g.id === rv.decision.options[k].id && typeof g.points === 'number' && g.label && 'loss' in g && 'lossPct' in g && g.freq === rv.decision.hand.freq[k])) return false;
  if (rv.timeout) return true;
  const mine = og.find((g) => g.id === rv.choice);
  return !!mine && mine.grade === rv.grade && mine.points === rv.points && mine.loss === rv.loss && mine.lossPct === rv.lossPct;
}

function findKeys(obj, keys, path = '$', out = []) {
  if (Array.isArray(obj)) obj.forEach((x, i) => findKeys(x, keys, `${path}[${i}]`, out));
  else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (keys.includes(k)) out.push(`${path}.${k}`);
      findKeys(obj[k], keys, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Assert that a play payload leaks nothing about decisions >= answered. */
function assertNoLeak(label, payload, id, answered) {
  const sol = solution(id);
  const decPos = sol.steps.map((s, i) => (s.type === 'decision' ? i : -1)).filter((i) => i >= 0);
  const steps = payload.steps;
  const lastAnsweredPos = answered > 0 ? decPos[answered - 1] : -1;
  const problems = [];
  // 1. The public part (header + steps that are not answered yet) carries no secret keys.
  const publicPart = { puzzle: payload.puzzle, steps: [] };
  steps.forEach((s, i) => {
    if (s.type === 'decision' && s.index >= answered) {
      const bad = SECRET_DECISION_KEYS.filter((k) => k in s);
      if (bad.length) problems.push(`decision ${s.index} has ${bad}`);
      publicPart.steps.push(s);
    } else if (s.type === 'villain' && i > lastAnsweredPos) {
      const bad = SECRET_VILLAIN_KEYS.filter((k) => k in s);
      if (bad.length) problems.push(`villain step ${i} has ${bad}`);
      publicPart.steps.push(s);
    } else if (s.type === 'decision' || s.type === 'villain') {
      // answered: fine
    } else publicPart.steps.push(s);
  });
  const leaked = findKeys(publicPart, SECRET_ANYWHERE);
  if (answered < sol.decisionCount && leaked.length) problems.push(`secret keys: ${leaked.slice(0, 5)}`);
  // 2. Nothing beyond the first unanswered decision.
  if (answered < sol.decisionCount) {
    const upto = decPos[answered];
    if (steps.length !== upto + 1) problems.push(`expected ${upto + 1} steps, got ${steps.length}`);
    if (payload.end) problems.push('end info before the end');
    // 3. Board cards of streets not yet dealt appear nowhere in the payload.
    const dealt = new Set(sol.steps.slice(0, upto + 1).filter((s) => s.type === 'deal').map((s) => s.street));
    const json = JSON.stringify(payload);
    for (const [street, cards] of [['flop', sol.board.flop], ['turn', [sol.board.turn]], ['river', [sol.board.river]]]) {
      if (!dealt.has(street)) for (const c of cards) if (json.includes(`"${c}"`)) problems.push(`undealt ${street} card ${c} present`);
    }
    if (payload.puzzle.board) problems.push('header has board');
    if ('decisionCount' in payload.puzzle) problems.push('header tells the number of decisions');
  }
  check(problems.length === 0, `${label}: no leak (${problems.join('; ') || 'clean'})`);
}

try {
  console.log(`server on ${BASE}, db ${env.DB_FILE}`);

  console.log('\n# players');
  const a = await api('POST', '/api/login', { name: 'Alice', pin: '1234' });
  check(a.status === 200 && a.body.token && a.body.created, 'Alice is created on first login');
  const A = a.body.token;
  const b = await api('POST', '/api/login', { name: 'Bob', pin: '5678' });
  const B = b.body.token;
  check(b.status === 200, 'Bob is created');
  const a2 = await api('POST', '/api/login', { name: 'aLiCe', pin: '1234' });
  check(a2.status === 200 && a2.body.player.id === a.body.player.id && !a2.body.created, 'names are case-insensitive');
  check((await api('POST', '/api/login', { name: 'Alice', pin: '9999' })).status === 401, 'wrong PIN is rejected');
  check((await api('POST', '/api/login', { name: 'X', pin: '1234' })).status === 400, 'one-letter name rejected');
  check((await api('POST', '/api/login', { name: 'Carol', pin: '12' })).status === 400, 'short PIN rejected');
  check((await api('GET', '/api/puzzles')).status === 401, 'puzzles need a session');
  check((await api('GET', '/api/puzzles', null, 'nonsense')).status === 401, 'bad token rejected');
  const raw = await fetch(`${BASE}/data/solutions-fixture/fx01.json`);
  check(raw.status === 404, 'raw solution files are not served');
  const trav = await fetch(`${BASE}/..%2fdata%2fsolutions-fixture%2ffx01.json`);
  check(trav.status === 403 || trav.status === 404, 'path traversal blocked');
  const idx = await fetch(`${BASE}/`);
  check(idx.status === 200 && (await idx.text()).includes('PokerPuzzles'), 'web app is served');

  console.log('\n# lobby');
  const list = await api('GET', '/api/puzzles', null, A);
  check(list.status === 200 && list.body.puzzles.length === 3, 'three fixture puzzles listed');
  check(list.body.puzzles.every((p) => p.status === 'new' && p.score === null), 'all new for Alice');
  check(findKeys(list.body, ['steps', 'board', 'hand', 'mainLine']).length === 0, 'list carries no solution data');
  check(!hasTags(list.body), 'no tags in the list before a puzzle is completed');
  check(list.body.puzzles.every((p) => !('decisionCount' in p)), 'the list does not tell how many decisions an unfinished hand has');
  const ranks = list.body.puzzles.map((p) => p.rank).sort((x, y) => x - y);
  check(ranks.join() === '1,2,3', `rank is a permutation of 1..n (${ranks})`);
  check(list.body.puzzles.every((p) => ['easy', 'medium', 'hard'].includes(p.level)) && findKeys(list.body, ['ease']).length === 0, 'level is easy/medium/hard, raw ease not sent');
  // fixture ease (mean points over options, mean over decisions): fx02 67.1 > fx01 61.9 > fx03 54.1
  const rk = Object.fromEntries(list.body.puzzles.map((p) => [p.id, p.rank]));
  check(rk.fx02 === 1 && rk.fx01 === 2 && rk.fx03 === 3, 'ranked by ease: fx02, fx01, fx03');
  check(list.body.nextId === 'fx02', `fresh player: nextId is the easiest puzzle (${list.body.nextId})`);
  check((await api('GET', '/api/puzzles/fx01/review', null, A)).status === 403, 'review locked before completion');
  check((await api('POST', '/api/puzzles/fx01/start', { mode: 'practice' }, A)).status === 409, 'practice locked before completion');

  console.log('\n# Alice plays fx01 (scored)');
  let r = await api('POST', '/api/puzzles/fx01/start', { mode: 'scored' }, A);
  check(r.status === 200 && r.body.next === 0, 'start returns decision 0');
  assertNoLeak('start', r.body, 'fx01', 0);
  check(findKeys(r.body, ['optionGrades', 'grade', 'points']).length === 0, 'no per-option grades (or any grade) before the first answer');
  check((await api('GET', '/api/puzzles', null, A)).body.nextId === 'fx01', 'an in-progress play wins nextId');
  check(!hasTags(r.body), 'no tags in the start payload of an unplayed puzzle');
  check((await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 1, optionId: 'check', mode: 'scored' }, A)).status === 409, 'cannot skip ahead');

  r = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 0, optionId: 'raise_25', mode: 'scored' }, A);
  check(r.body.reveal.grade === 'best' && r.body.reveal.points === 100, 'chart decision, raise AQo: Best 100');
  check(r.body.reveal.loss === null && r.body.reveal.decision.hand.freq.length === 2, 'chart reveal has no EV loss but full decision');
  check(r.body.reveal.explanation.text.length > 10 && !r.body.reveal.explanation.generated, 'authored explanation included');
  check(optionGradesOk(r.body.reveal), 'the reveal grades every option (chart decision), in option order, agreeing with the answer');
  let og = gradesOf(r.body.reveal);
  check(og.raise_25?.[0] === 'best' && og.raise_25?.[1] === 100 && og.fold?.[0] === 'wrong' && og.fold?.[1] === 15 && r.body.reveal.optionGrades.every((g) => g.loss === null), `chart options: raise Best 100, fold Wrong 15, no EV loss (got ${JSON.stringify(og)})`);
  assertNoLeak('after decision 0', r.body, 'fx01', 1);
  check(findKeys(r.body.steps, ['optionGrades']).length === 0, 'per-option grades travel only in the reveal, never in the steps');

  r = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 1, optionId: 'check', mode: 'scored' }, A);
  // hand-computed: freq 0.22, maxFreq 0.71 -> 60 + 40 * 0.22 / 0.71 = 72.394
  check(r.body.reveal.grade === 'correct' && near(r.body.reveal.points, 72.39), `flop check: Correct 72.39 (got ${r.body.reveal.grade} ${r.body.reveal.points})`);
  check(near(r.body.reveal.loss, 0.08) && near(r.body.reveal.lossPct, 1.45), `EV loss 0.08 bb = 1.45% pot (got ${r.body.reveal.loss}, ${r.body.reveal.lossPct})`);
  check(r.body.reveal.offMainLine && r.body.reveal.continuesWith === 'The hand continues with Bet 1.8 (33%).', 'off main line message');
  check(optionGradesOk(r.body.reveal), 'solver decision: every option graded, the chosen one as the reveal');
  og = gradesOf(r.body.reveal);
  // Bob answers bet_18 at this decision below: Best 100.
  check(og.check?.[0] === 'correct' && near(og.check?.[1], 72.39) && og.bet_18?.[0] === 'best' && og.bet_18?.[1] === 100, `flop options: check Correct 72.39, bet 1.8 Best 100 (got ${JSON.stringify(og)})`);
  assertNoLeak('after decision 1', r.body, 'fx01', 2);
  const vilBefore = r.body.steps.filter((s) => s.type === 'villain');
  check(vilBefore.length === 2 && vilBefore.every((s) => !('range' in s) && !('freq' in s)), 'villain flop call and turn check stay hidden until decision 2 is answered');

  console.log('\n# resume');
  r = await api('POST', '/api/puzzles/fx01/start', { mode: 'scored' }, A);
  check(r.body.next === 2 && r.body.answers.length === 2 && r.body.answers[1].choice === 'check', 'resume at decision 2 with recorded choices');
  check(r.body.answers.every(optionGradesOk), 'resumed reveals carry the per-option grades too');
  assertNoLeak('resume', r.body, 'fx01', 2);
  const mid = await api('GET', '/api/puzzles', null, A);
  check(mid.body.puzzles.find((p) => p.id === 'fx01').status === 'in_progress', 'status in_progress');

  r = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 2, optionId: 'bet_114', mode: 'scored' }, A);
  // freq 0.02 < 0.035; loss 5.1 - 4.98 = 0.12, pot 9.1 -> 1.32% < 1.5
  check(r.body.reveal.grade === 'inaccuracy' && r.body.reveal.points === 40 && near(r.body.reveal.lossPct, 1.32), `turn overbet: Inaccuracy 40 at 1.32% (got ${r.body.reveal.grade} ${r.body.reveal.lossPct})`);
  og = gradesOf(r.body.reveal);
  // Bob answers bet_60 here below: Correct 60 + 40 * 0.32 / 0.66.
  check(optionGradesOk(r.body.reveal) && og.bet_60?.[0] === 'correct' && near(og.bet_60?.[1], 79.39), `turn options: bet 6 Correct 79.39 (got ${JSON.stringify(og.bet_60)})`);
  assertNoLeak('after decision 2', r.body, 'fx01', 3);
  check(!hasTags(r.body), 'no tags in act payloads before completion');
  const dup = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 1, optionId: 'bet_18', mode: 'scored' }, A);
  check(dup.status === 200 && dup.body.alreadyAnswered && dup.body.reveal.choice === 'check', 'answered decision cannot be changed');

  r = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 3, optionId: 'raise_138', mode: 'scored' }, A);
  // freq 0.02; loss 3.9 - 3.5 = 0.4, pot 13.7 -> 2.92% < 6
  check(r.body.reveal.grade === 'wrong' && r.body.reveal.points === 15, `river raise: Wrong 15 (got ${r.body.reveal.grade})`);
  og = gradesOf(r.body.reveal);
  const foldG = r.body.reveal.optionGrades.find((g) => g.id === 'fold');
  check(optionGradesOk(r.body.reveal) && og.fold?.[0] === 'blunder' && og.fold?.[1] === 0 && near(foldG?.loss, 3.9) && near(foldG?.lossPct, 28.47), `river options: fold Blunder 0, loses 3.9 bb = 28.47% (got ${JSON.stringify(foldG)})`);
  const scoreA = Math.round((100 + 72.39 + 40 + 15) / 4);
  check(r.body.end && r.body.end.score === scoreA, `puzzle score ${scoreA} (got ${r.body.end?.score})`);
  check(r.body.end.step.reason === 'showdown' && r.body.end.step.showdown.villainHand.length === 2, 'showdown end step');
  check(r.body.end.takeaway && r.body.end.recap.length === 4 && r.body.end.others.length === 0, 'takeaway, recap, no others yet');
  check(r.body.steps.at(-1).type === 'end' && r.body.next === null, 'all steps sent at the end');
  check(Array.isArray(r.body.end.tags) && r.body.end.tags.includes('value') && r.body.puzzle.tags, 'tags arrive with the end of the hand');
  const listDone = await api('GET', '/api/puzzles', null, A);
  check(listDone.body.nextId === 'fx02', `after finishing fx01, nextId moves on (${listDone.body.nextId})`);
  check(listDone.body.puzzles.find((p) => p.id === 'fx01').decisionCount === 4 && !('decisionCount' in listDone.body.puzzles.find((p) => p.id === 'fx02')), 'finished hands show their decision count, unfinished ones do not');
  check(listDone.body.puzzles.find((p) => p.id === 'fx01').tags?.includes('value') && !('tags' in listDone.body.puzzles.find((p) => p.id === 'fx02')), 'list shows tags for the done puzzle only');

  console.log('\n# replay does not change the score');
  r = await api('POST', '/api/puzzles/fx01/start', { mode: 'scored' }, A);
  check(r.body.completed && r.body.end.score === scoreA, 'scored start after completion shows the stored result');
  r = await api('POST', '/api/puzzles/fx01/start', { mode: 'practice' }, A);
  check(r.status === 200 && r.body.next === 0 && r.body.answers.length === 0, 'practice starts fresh');
  assertNoLeak('practice start', r.body, 'fx01', 0);
  r = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 3, optionId: 'fold', mode: 'practice' }, A);
  // fold: freq 0, loss 3.9, 3.9 / 13.7 = 28.5% -> Blunder
  check(r.body.reveal.grade === 'blunder' && r.body.reveal.points === 0, `practice river fold: Blunder 0 (got ${r.body.reveal.grade})`);
  r = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 3, optionId: 'call', mode: 'scored' }, A);
  check(r.body.alreadyAnswered && r.body.reveal.choice === 'raise_138', 'scored act after completion returns the recorded choice');
  const after = await api('GET', '/api/puzzles', null, A);
  check(after.body.puzzles.find((p) => p.id === 'fx01').score === scoreA, 'score unchanged after replay');

  console.log('\n# review');
  r = await api('GET', '/api/puzzles/fx01/review', null, A);
  check(r.status === 200 && r.body.steps.length === solution('fx01').steps.length && r.body.answers.map((x) => x.choice).join() === 'raise_25,check,bet_114,raise_138', 'review has all steps and first-play choices');
  check((await api('GET', '/api/puzzles/fx01/review', null, B)).status === 403, 'Bob cannot review before playing');
  check(r.body.puzzle.tags?.includes('value'), 'review has tags');

  console.log('\n# Bob plays fx01 and fx02');
  await api('POST', '/api/puzzles/fx01/start', { mode: 'scored' }, B);
  const bobFx01 = [['raise_25', null], ['bet_18', null], ['bet_60', null], ['fold', null]];
  bobFx01[0][0] = 'fold';
  const exp1 = [['wrong', 15], ['best', 100], ['correct', 60 + (40 * 0.32) / 0.66], ['blunder', 0]];
  let end;
  for (let i = 0; i < 4; i++) {
    r = await api('POST', '/api/puzzles/fx01/act', { decisionIndex: i, optionId: bobFx01[i][0], mode: 'scored' }, B);
    check(r.body.reveal.grade === exp1[i][0] && near(r.body.reveal.points, exp1[i][1]), `fx01 d${i} ${bobFx01[i][0]}: ${exp1[i][0]} ${exp1[i][1].toFixed(2)} (got ${r.body.reveal.grade} ${r.body.reveal.points})`);
    if (i < 3) assertNoLeak(`Bob fx01 after d${i}`, r.body, 'fx01', i + 1);
    end = r.body.end;
  }
  const scoreB1 = Math.round((15 + 100 + 79.39 + 0) / 4);
  check(end.score === scoreB1, `Bob fx01 score ${scoreB1} (got ${end.score})`);
  check(end.others.length === 1 && end.others[0].name === 'Alice' && end.others[0].score === scoreA, "Alice's score shown to Bob");

  r = await api('POST', '/api/puzzles/fx02/start', { mode: 'scored' }, B);
  assertNoLeak('fx02 start', r.body, 'fx02', 0);
  const exp2 = [['call', 'best', 100], ['raise_54', 'best', 100], ['bet_114', 'correct', 60 + (40 * 0.07) / 0.81], ['fold', 'correct', 60 + (40 * 0.36) / 0.52]];
  for (let i = 0; i < 4; i++) {
    r = await api('POST', '/api/puzzles/fx02/act', { decisionIndex: i, optionId: exp2[i][0], mode: 'scored' }, B);
    check(r.body.reveal.grade === exp2[i][1] && near(r.body.reveal.points, exp2[i][2]), `fx02 d${i} ${exp2[i][0]}: ${exp2[i][1]} ${exp2[i][2].toFixed(2)} (got ${r.body.reveal.grade} ${r.body.reveal.points})`);
    if (i === 1) check(r.body.reveal.continuesWith === 'The hand continues with Call 1.8.', 'Best but off the main line still continues with the main line');
    if (i === 2) check(r.body.reveal.explanation.generated && /solver prefers Check/.test(r.body.reveal.explanation.text), `generated explanation: "${r.body.reveal.explanation.text}"`);
    if (i < 3) assertNoLeak(`fx02 after d${i}`, r.body, 'fx02', i + 1);
    if (i === 0) check(r.body.steps.some((s) => s.type === 'action' && s.street === 'flop' && s.seat === 'BB' && s.kind === 'check'), 'forced hero flop check passed through as an action step');
    end = r.body.end;
  }
  const scoreB2 = Math.round((100 + 100 + 63.46 + 87.69) / 4);
  check(end.score === scoreB2 && end.step.reason === 'hero_fold' && end.step.showdown === null, `fx02 hero fold, score ${scoreB2} (got ${end.score})`);

  check((await api('GET', '/api/puzzles', null, B)).body.nextId === 'fx03', 'Bob, fx01 and fx02 done: nextId is fx03');
  console.log('\n# 3-bet pot leak checks (Alice, fx03)');
  r = await api('POST', '/api/puzzles/fx03/start', { mode: 'scored' }, A);
  assertNoLeak('fx03 start', r.body, 'fx03', 0);
  r = await api('POST', '/api/puzzles/fx03/act', { decisionIndex: 0, optionId: 'raise_25', mode: 'scored' }, A);
  check(r.body.next === 1 && r.body.steps.at(-1).street === 'preflop', 'second preflop hero decision follows');
  assertNoLeak('fx03 after d0', r.body, 'fx03', 1);
  r = await api('POST', '/api/puzzles/fx03/act', { decisionIndex: 1, optionId: 'raise_240', mode: 'scored' }, A);
  check(r.body.reveal.grade === 'wrong' && r.body.reveal.points === 15, 'chart action with freq 0: Wrong 15');
  assertNoLeak('fx03 after d1', r.body, 'fx03', 2);
  const v = r.body.steps.find((s) => s.type === 'villain');
  check(v && !('freq' in v) && !('range' in v) && !('options' in v), 'villain c-bet hidden before the hero answers');
  r = await api('POST', '/api/puzzles/fx03/act', { decisionIndex: 2, optionId: 'raise_140', mode: 'scored' }, A);
  check(r.body.end && r.body.end.step.reason === 'villain_fold' && r.body.steps.filter((s) => s.type === 'villain').every((s) => 'range' in s), 'villain fold end, all villain steps revealed');
  const scoreA3 = r.body.end.score;

  console.log('\n# leaderboard');
  r = await api('GET', '/api/leaderboard', null, B);
  const rows = Object.fromEntries(r.body.players.map((p) => [p.name, p]));
  check(rows.Alice.played === 2 && rows.Alice.totalPoints === scoreA + scoreA3, `Alice: 2 played, total ${scoreA + scoreA3}`);
  check(rows.Bob.played === 2 && rows.Bob.totalPoints === scoreB1 + scoreB2 && rows.Bob.average === Math.round(10 * (scoreB1 + scoreB2) / 2) / 10, `Bob: 2 played, total ${scoreB1 + scoreB2}, average ${(scoreB1 + scoreB2) / 2}`);
  // 3 best, 3 correct, 1 wrong, 1 blunder of 8: 37.5 / 37.5 / 0 / 12.5 / 12.5 -> whole percent adding up to 100
  const sB = rows.Bob.shares;
  check(sB && sB.best === 38 && sB.correct === 38 && sB.inaccuracy === 0 && sB.wrong === 12 && sB.blunder === 12, `Bob's own row: his answers as whole percent adding up to 100, 38/38/0/12/12 (got ${JSON.stringify(sB)})`);
  check(rows.Alice.shares === null, 'Alice\'s row (2 hands) shows Bob no split: another player\'s is shown from 5 hands');
  check(findKeys(r.body, ['grades', 'decisions', 'decisionCount', 'points']).length === 0, 'the leaderboard carries no grade counts and no decision totals');
  check(r.body.players[0].name === 'Bob', 'ranked by average');

  console.log('\n# puzzle files change while the server runs');
  const fx03 = readFileSync(join(SOL, 'fx03.json'), 'utf8').replace(/"fx03"/g, '"fx99"').replace('Raising a c-bet in a 3-bet pot', 'Added later');
  writeFileSync(join(SOL, 'fx99.json'), fx03.slice(0, 700)); // half-written
  await sleep(RESCAN_MS * 3);
  let l = await api('GET', '/api/puzzles', null, A);
  check(l.status === 200 && l.body.puzzles.length === 3 && !l.body.puzzles.some((p) => p.id === 'fx99'), 'half-written file is skipped and the server keeps serving');
  writeFileSync(join(SOL, 'fx99.json'), fx03);
  await sleep(RESCAN_MS * 3);
  l = await api('GET', '/api/puzzles', null, A);
  const fx99 = l.body.puzzles.find((p) => p.id === 'fx99');
  check(l.body.puzzles.length === 4 && fx99 && fx99.title === 'Added later' && fx99.number === 4, 'completed file is picked up without a restart');
  check(l.body.puzzles.map((p) => p.rank).sort().join() === '1,2,3,4', 'ranks recomputed for the new puzzle set');
  check((await api('POST', '/api/puzzles/fx99/start', { mode: 'scored' }, B)).status === 200, 'new puzzle is playable');
  check(srvOut.split('fx99.json').length - 1 === 1, 'the bad file was logged once');

  // Bob is mid-way through fx99 when it changes: his unfinished play restarts.
  await api('POST', '/api/puzzles/fx99/act', { decisionIndex: 0, optionId: 'raise_25', mode: 'scored' }, B);
  const fx01Before = (await api('GET', '/api/puzzles', null, A)).body.puzzles.find((p) => p.id === 'fx01').score;
  const sol1 = JSON.parse(readFileSync(join(SOL, 'fx01.json'), 'utf8'));
  sol1.title = 'Top pair, re-solved';
  const d1 = sol1.steps.find((x) => x.type === 'decision' && x.index === 1);
  d1.hand.freq = [0.9, 0.05, 0.05]; // check is now Best: Alice's stored Correct must stay
  writeFileSync(join(SOL, 'fx01.json'), JSON.stringify(sol1));
  writeFileSync(join(SOL, 'fx99.json'), fx03.replace('Added later', 'Added later, v2'));
  writeFileSync(join(EXP, 'fx03.json'), JSON.stringify({ decisions: { '2': 'Freshly written explanation.' }, takeaway: 'New takeaway.' }));
  await sleep(RESCAN_MS * 3);
  l = await api('GET', '/api/puzzles', null, A);
  const fx01Now = l.body.puzzles.find((p) => p.id === 'fx01');
  check(fx01Now.title === 'Top pair, re-solved' && fx01Now.score === fx01Before, `changed puzzle keeps the stored score (${fx01Now.score})`);
  r = await api('GET', '/api/puzzles/fx01/review', null, A);
  check(r.status === 200 && r.body.answers[1].grade === 'correct' && r.body.answers[1].stale && r.body.end.score === fx01Before, 'review of a changed puzzle shows the stored grades');
  check(gradesOf(r.body.answers[1]).check?.[0] === 'best', 'its per-option grades follow the current solution (check is now Best)');
  r = await api('GET', '/api/leaderboard', null, A);
  check(r.body.players.find((p) => p.name === 'Alice').totalPoints === scoreA + scoreA3, 'leaderboard unchanged by the re-solve');
  r = await api('GET', '/api/puzzles/fx03/review', null, A);
  check(r.body.answers[2].explanation.text === 'Freshly written explanation.' && r.body.end.takeaway === 'New takeaway.', 'new explanation file picked up');
  r = await api('POST', '/api/puzzles/fx99/start', { mode: 'scored' }, B);
  check(r.body.restarted === true && r.body.answers.length === 0 && r.body.next === 0, 'unfinished play of a changed puzzle restarts at decision 0');


  // ===================================================================
  // Battles are live and in lockstep: one shared cursor on the server. The
  // server's clock is moved forward with POST /api/test/clock (TEST_CLOCK=1).
  console.log('\n# battles: setup (more puzzles, more players)');
  // Five more puzzles: copies of the fixtures under new ids (fx04..fx08), 9 in all -> 3 easy, 3 medium, 3 hard.
  for (const [src, id] of [['fx01', 'fx04'], ['fx02', 'fx05'], ['fx03', 'fx06'], ['fx02', 'fx07'], ['fx01', 'fx08']]) {
    const txt = readFileSync(join(FIX, `${src}.json`), 'utf8').replace(new RegExp(`"${src}"`, 'g'), `"${id}"`);
    writeFileSync(join(SOL, `${id}.json`), txt);
  }
  await sleep(RESCAN_MS * 3);
  const all9 = (await api('GET', '/api/puzzles', null, A)).body.puzzles;
  check(all9.length === 9, `nine puzzles for the battle tests (${all9.length})`);
  const rankOf = Object.fromEntries(all9.map((p) => [p.id, p.rank]));
  const login = async (name, pin) => (await api('POST', '/api/login', { name, pin })).body.token;
  const C = await login('Carol', '1111'), D = await login('Dave', '2222'), E = await login('Erin', '3333'), F = await login('Frank', '4444');
  const A2 = (await api('POST', '/api/login', { name: 'Alice', pin: '1234' })).body.token;
  const B2 = B; // Bob's session from before the PIN lock test
  // Best option of a decision (highest hand frequency) and the first listed one.
  const bestOpt = (id, i) => { const d = solution(id).steps.filter((x) => x.type === 'decision')[i]; let k = 0; d.hand.freq.forEach((f, j) => { if (f > d.hand.freq[k]) k = j; }); return d.options[k].id; };
  const firstOpt = (id, i) => solution(id).steps.filter((x) => x.type === 'decision')[i].options[0].id;
  const decCount = (id) => solution(id).steps.filter((x) => x.type === 'decision').length;
  const decPos = (id, i) => solution(id).steps.findIndex((x) => x.type === 'decision' && x.index === i);
  const ALPHA = /^[ACDEFGHJKMNPRTUVWXY]{4}$/;
  const T = { clock: 20000, grace: 1500, auto: 30000, countdown: 4000, lead: 3000 };
  const adv = async (ms) => (await api('POST', '/api/test/clock', { advanceMs: ms })).body;
  const stateOf = async (tok, bid) => (await api('GET', `/api/battles/${bid}`, null, tok)).body.battle;
  const ready = (tok, bid, on = true) => api('POST', `/api/battles/${bid}/ready`, { ready: on }, tok);
  const answer = (tok, bid, hand, i, opt) => api('POST', `/api/battles/${bid}/act`, { hand, decisionIndex: i, optionId: opt }, tok);
  const readyAll = async (bid, toks) => { for (const t of toks) await ready(t, bid); };
  /**
   * Play from the current cursor to the end in lockstep. picks[k] is a pick
   * function for toks[k], or null for a player who stays silent (time-outs,
   * automatic continue).
   */
  async function playLive(bid, toks, picks, { fromReady = false } = {}) {
    const awake = toks.filter((t, k) => picks[k]);
    if (fromReady) { await readyAll(bid, toks); await adv(T.countdown + 50); }
    for (let guard = 0; guard < 200; guard++) {
      const s = await stateOf(awake[0], bid);
      const L = s.live;
      if (!L || s.status !== 'active' && L.phase === 'done') return s;
      if (L.phase === 'done') return s;
      if (L.phase === 'countdown') { await adv(Math.max(0, L.startsAt - s.serverNow) + 50); continue; }
      if (L.phase === 'decide') {
        const pid = s.hands[L.hand].puzzle.id;
        for (let k = 0; k < toks.length; k++) if (picks[k]) await answer(toks[k], bid, L.hand, L.index, picks[k](pid, L.index));
        if (awake.length < toks.length) await adv(T.clock + T.grace + 100);
        continue;
      }
      if (L.phase === 'review' || L.phase === 'handEnd') {
        await readyAll(bid, awake);
        if (awake.length < toks.length) await adv(T.auto + 100);
        continue;
      }
      return s;
    }
    return null;
  }
  const finalOf = async (tok, bid) => { const s = await stateOf(tok, bid); return s; };

  console.log('\n# battles: create, codes, join, ready check');
  let bc = await api('POST', '/api/battles', {}, C);
  check(bc.status === 201 && bc.body.battle.status === 'open' && ALPHA.test(bc.body.battle.code) && bc.body.battle.size === 2, `create: open duel with a 4-letter code (${bc.body.battle?.code})`);
  const cb1 = bc.body.battle;
  const again = await api('POST', '/api/battles', {}, C);
  check(again.status === 200 && again.body.existing && again.body.battle.id === cb1.id, 'starting again returns your open challenge');
  check((await api('POST', `/api/battles/${cb1.id}/join`, {}, C)).body.battle.status === 'open', 'the creator opening their own link just sees it waiting');
  let lst = await api('GET', '/api/battles', null, D);
  check(lst.status === 200 && lst.body.open.some((o) => o.id === cb1.id && o.creator.name === 'Carol' && o.joinable && o.size === 2), 'Dave sees Carol\'s open challenge');
  check(findKeys(lst.body.open, ['hands']).length === 0, 'open challenges carry no hands');
  check((await api('POST', '/api/battles/join', { code: 'AB' }, D)).status === 400, 'a malformed code is rejected');
  const unused = ['ACDE', 'FGHJ', 'KMNP'].find((c) => c !== cb1.code);
  check((await api('POST', '/api/battles/join', { code: unused }, D)).status === 404, 'an unknown code is not found');
  check((await api('GET', '/api/battles/nonexistent00', null, D)).status === 404, 'unknown battle id: 404');
  const outside = await api('GET', `/api/battles/${cb1.id}`, null, D);
  check(outside.status === 200 && outside.body.battle.outsider && outside.body.battle.joinable && !('hands' in outside.body.battle), 'a non-member sees only who is challenging');
  let jn = await api('POST', '/api/battles/join', { code: ` ${cb1.code.toLowerCase().slice(0, 2)} ${cb1.code.toLowerCase().slice(2)} ` }, D);
  check(jn.status === 200 && jn.body.battle.status === 'active' && jn.body.battle.live.phase === 'ready' && jn.body.battle.hands.length === 5, 'Dave joins by code (lower case, spaces ignored): the ready check, 5 hands');
  const cdState = await stateOf(C, cb1.id);
  check(cdState.hands.every((x) => x.puzzle === null), 'no hand names its puzzle before the battle starts');
  check(cdState.hands.map((x) => x.level).join() === 'easy,easy,medium,medium,hard', `fresh players get 2 easy, 2 medium, 1 hard (${cdState.hands.map((x) => x.level)})`);
  check((await api('POST', '/api/battles/join', { code: cb1.code }, E)).status === 404 && (await api('POST', `/api/battles/${cb1.id}/join`, {}, E)).status === 409, 'a third player cannot join a full duel');
  check((await api('POST', `/api/battles/${cb1.id}/start`, { hand: 0 }, C)).status === 409, 'no hand before everybody is ready');
  await ready(C, cb1.id);
  let rs = await ready(C, cb1.id, false);
  check(rs.status === 200 && rs.body.battle.live.ready.length === 0, 'Ready can be taken back');
  await ready(D, cb1.id);
  rs = await stateOf(C, cb1.id);
  check(rs.live.phase === 'ready' && rs.live.ready.length === 1, 'one of two ready: still the ready check');
  rs = (await ready(C, cb1.id)).body.battle;
  const ds = await stateOf(D, cb1.id);
  check(rs.live.phase === 'countdown' && rs.live.startsAt === ds.live.startsAt && rs.live.startsAt - rs.serverNow > 3500 && rs.live.kind === 'start', 'everybody ready: one shared start moment ~4 s ahead');
  check((await ready(C, cb1.id, false)).status === 409, 'no taking back once the countdown runs');
  check((await api('POST', `/api/battles/${cb1.id}/start`, { hand: 0 }, D)).status === 409 && rs.hands[0].puzzle === null, 'before the start moment the hand is not delivered');
  await adv(T.countdown + 50);
  const c0 = await api('POST', `/api/battles/${cb1.id}/start`, { hand: 0 }, D);
  check(c0.status === 200 && c0.body.next === 0, 'at the start moment hand 1 opens for everybody');
  check((await api('POST', `/api/battles/${cb1.id}/cancel`, {}, C)).status === 409, 'a started battle cannot be cancelled');

  console.log('\n# battles: hand selection prefers hands neither player has played');
  const ab = (await api('POST', '/api/battles', {}, A2)).body.battle;
  jn = await api('POST', `/api/battles/${ab.id}/join`, {}, B2);
  check(jn.status === 200 && jn.body.battle.live.phase === 'ready', 'Bob joins Alice by id');
  await readyAll(ab.id, [A2, B2]); await adv(T.countdown + 50);
  const abFull = async (tok) => stateOf(tok, ab.id);
  const abHand0 = (await abFull(A2)).hands[0].puzzle.id;
  check(!['fx01', 'fx02', 'fx03'].includes(abHand0), `hand 1 is one neither has played (${abHand0})`);

  console.log('\n# battles: a hand in a battle is played there');
  let pl = await api('GET', '/api/puzzles', null, A2);
  check(pl.body.puzzles.find((p) => p.id === abHand0).battle === ab.id, 'the puzzle list marks the battle hand');
  check(pl.body.nextId !== abHand0 && !pl.body.puzzles.filter((p) => p.battle).some((p) => p.id === pl.body.nextId), `nextId skips battle hands (${pl.body.nextId})`);
  const held = await api('POST', `/api/puzzles/${abHand0}/start`, { mode: 'scored' }, A2);
  check(held.status === 409 && held.body.battle === ab.id, 'starting a battle hand on its own is refused with the battle id');

  console.log('\n# battles: lockstep, visibility and the clock');
  let s0 = await api('POST', `/api/battles/${ab.id}/start`, { hand: 0 }, A2);
  check(s0.status === 200 && s0.body.next === 0 && s0.body.mode === 'battle', 'Alice gets hand 1');
  assertNoLeak('battle start', s0.body, abHand0, 0);
  check((await answer(A2, ab.id, 0, 1, firstOpt(abHand0, 1))).status === 409, 'cannot answer a decision that is not open');
  check((await answer(A2, ab.id, 0, 0, 'nonsense')).status === 400, 'bad option rejected');
  check((await answer(A2, ab.id, 7, 0, 'fold')).status === 400, 'bad hand rejected');
  let ar = await answer(A2, ab.id, 0, 0, bestOpt(abHand0, 0));
  check(ar.status === 200 && ar.body.reveal.grade === 'best' && ar.body.battle.live.phase === 'decide', 'Alice answers decision 1 (Best); the hand waits for Bob');
  check(optionGradesOk(ar.body.reveal) && findKeys(ar.body.battle, ['optionGrades']).length === 0, 'her battle reveal grades every option; the shared battle state carries no per-option grades');
  check(ar.body.steps.length === decPos(abHand0, 0) + 1, 'nobody is shown anything beyond the open decision');
  check(!('decisionCount' in ar.body.puzzle) && !('decisionCount' in ar.body.battle.hands[0]) && ar.body.next === 1, 'neither the act answer nor the battle state tells the number of decisions');
  check((await answer(A2, ab.id, 0, 1, bestOpt(abHand0, 1))).status === 409, 'Alice cannot go on alone');
  let bs = await abFull(B2);
  check(bs.live.answered.length === 1 && bs.live.deadline - bs.serverNow > 19000 && bs.live.deadline - bs.serverNow <= 20000 && bs.live.firstBy === 'Alice', 'Bob sees that Alice answered, and his 20 s clock from that answer');
  check(bs.hands[0].opps[0].choices.length === 0 && !JSON.stringify(bs).includes('"grade"') && !JSON.stringify(bs).includes('optionGrades'), 'Bob gets none of Alice\'s answer before answering himself');
  const bobPeek = await api('POST', `/api/battles/${ab.id}/start`, { hand: 0 }, B2);
  check(bobPeek.status === 200 && findKeys(bobPeek.body, ['optionGrades', 'grade']).length === 0, 'nor any grade in his view of the open decision');
  await adv(19000);
  let br = await answer(B2, ab.id, 0, 0, firstOpt(abHand0, 0));
  check(br.status === 200 && !br.body.timedOut && br.body.battle.live.phase === 'review', 'Bob answers after 19 s: counts; all answered -> review');
  check(br.body.battle.hands[0].opps[0].choices[0].optionId === bestOpt(abHand0, 0), 'now Bob sees Alice\'s pick');
  check((await abFull(A2)).hands[0].opps[0].choices.length === 1, 'and Alice sees Bob\'s');
  await ready(A2, ab.id);
  bs = await abFull(B2);
  check(bs.live.phase === 'review' && bs.live.ready.length === 1 && bs.live.autoAt - bs.serverNow > 29000, 'Alice pressed Continue: Bob sees she is ready, auto-continue in 30 s');
  await ready(B2, ab.id);
  bs = await abFull(B2);
  check(bs.live.phase === 'decide' && bs.live.index === 1 && bs.live.deadline === null, 'both pressed Continue: decision 2 opens for both, no clock yet');
  const rd = await api('POST', `/api/battles/${ab.id}/start`, { hand: 0 }, B2);
  assertNoLeak('battle decision 2', rd.body, abHand0, 1);
  // Decision 2: Alice runs out of time.
  await answer(B2, ab.id, 0, 1, bestOpt(abHand0, 1));
  await adv(T.clock + 1000);
  const late1 = await answer(A2, ab.id, 0, 1, bestOpt(abHand0, 1));
  check(late1.status === 200 && !late1.body.timedOut && late1.body.reveal.points === 100, 'an answer 1 s after the deadline is still accepted (network allowance)');
  await readyAll(ab.id, [A2, B2]);
  await answer(B2, ab.id, 0, 2, bestOpt(abHand0, 2));
  await adv(T.clock + T.grace + 500);
  let as = await abFull(B2);
  check(as.live.phase === 'review' && as.hands[0].opps[0].choices.find((c) => c.index === 2)?.timeout, 'Bob\'s poll records Alice\'s time-out: "ran out of time", the hand goes on');
  ar = await answer(A2, ab.id, 0, 2, bestOpt(abHand0, 2));
  check(ar.body.timedOut && ar.body.reveal.grade === 'timeout' && ar.body.reveal.points === 0 && ar.body.reveal.decision.hand && ar.body.reveal.explanation.text, 'Alice\'s late answer gets the time-out: 0 points, with the full analysis');
  check(optionGradesOk(ar.body.reveal) && ar.body.reveal.optionGrades.some((g) => g.grade === 'best'), 'the time-out reveal also grades every option (what each answer would have scored)');
  // Automatic continue.
  await ready(B2, ab.id);
  await adv(T.auto - 1000);
  check((await abFull(A2)).live.phase === 'review', 'Alice still reading 29 s later');
  await adv(1100);
  check((await abFull(A2)).live.phase === 'decide', 'after 30 s she is continued automatically');
  // Last decision of hand 1, then the hand end and the lead-in.
  await answer(A2, ab.id, 0, 3, bestOpt(abHand0, 3));
  const lastPeek = await abFull(B2);
  check(!lastPeek.hands[0].opps[0].done && lastPeek.hands[0].opps[0].answered === 4 && !('decisionCount' in lastPeek.hands[0]) && lastPeek.opp.hand === 0,
    'Alice has answered the last decision: Bob\'s state does not tell him the hand is over for her');
  await answer(B2, ab.id, 0, 3, firstOpt(abHand0, 3));
  await readyAll(ab.id, [A2, B2]);
  as = await abFull(A2);
  check(as.live.phase === 'handEnd' && as.hands[0].me.score !== null && as.hands[0].opps[0].score !== null && as.hands[0].outcome, 'hand over for both: scores and the round result');
  const aliceH0 = as.hands[0].me.score;
  check(aliceH0 === Math.round((100 + 100 + 0 + 100) / 4), `the time-out counts as 0 in Alice's hand score (${aliceH0})`);
  const lst2 = (await api('GET', '/api/puzzles', null, A2)).body.puzzles.find((p) => p.id === abHand0);
  check(lst2.status === 'done' && lst2.score === aliceH0 && !lst2.battle, 'a fresh battle hand counts as Alice\'s first play, time-out included');
  check(((await api('GET', `/api/puzzles/${abHand0}/review`, null, A2)).body.answers || []).some((x) => x.grade === 'timeout'), 'its review shows the time-out');
  await ready(A2, ab.id);
  await adv(T.auto + 100);
  as = await abFull(A2);
  check(as.live.phase === 'countdown' && as.live.kind === 'lead' && as.live.hand === 1, 'Next hand: Bob did not press, continued after 30 s; a lead-in to hand 2');
  await adv(T.lead + 50);
  // Hand 2: Bob is away for the whole hand.
  const h1 = (await abFull(A2)).hands[1].puzzle.id;
  for (let i = 0; i < decCount(h1); i++) {
    await answer(A2, ab.id, 1, i, bestOpt(h1, i));
    await adv(T.clock + T.grace + 100);
    await stateOf(A2, ab.id);
    await ready(A2, ab.id);
    await adv(T.auto + 100);
  }
  as = await abFull(A2);
  check(as.live.phase === 'handEnd' && as.hands[1].opps[0].score === 0 && as.hands[1].opps[0].choices.every((c) => c.timeout), 'an absent player times out decision by decision; the hand still ends');
  await ready(A2, ab.id); await adv(T.auto + 100); await adv(T.lead + 50);
  // Hand 3: Bob comes back in the middle of a decision and joins the shared clock.
  const h2 = (await abFull(A2)).hands[2].puzzle.id;
  await answer(A2, ab.id, 2, 0, bestOpt(h2, 0));
  await adv(8000);
  const back = await api('POST', `/api/battles/${ab.id}/start`, { hand: 2 }, B2);
  check(back.status === 200 && back.body.next === 0 && back.body.battle.live.deadline - back.body.battle.serverNow <= 12000, 'Bob reconnects mid-decision: he joins the running clock (12 s left)');
  const back2 = await answer(B2, ab.id, 2, 0, bestOpt(h2, 0));
  check(back2.status === 200 && !back2.body.timedOut && back2.body.reveal.points === 100, 'and can still answer');
  await readyAll(ab.id, [A2, B2]);
  await adv(10 * 60 * 1000);
  as = await abFull(A2);
  check(as.live.phase === 'decide' && as.live.index === 1 && !as.hands[2].opps[0].choices.some((c) => c.index === 1) && as.hands[2].me.answered === 1, 'nobody answers for 10 minutes: the battle simply rests');
  as = await playLive(ab.id, [A2, B2], [bestOpt, firstOpt]);
  const bfin = await stateOf(B2, ab.id);
  check(as.status === 'finished' && as.live.phase === 'done' && bfin.status === 'finished', 'played to the end: finished for both');
  check(as.me.total === bfin.opps[0].total && bfin.me.total === as.opps[0].total && as.me.total === as.hands.reduce((x, h) => x + h.me.score, 0), `totals add up: Alice ${as.me.total}, Bob ${bfin.me.total}`);
  check(as.outcome === (as.me.total > bfin.me.total ? 'win' : as.me.total < bfin.me.total ? 'loss' : 'draw'), `outcome ${as.outcome}`);
  check(bfin.hands.every((x) => x.opps[0].choices.length === x.decisionCount), 'at the end every pick of the opponent is visible');
  const rev = await api('POST', `/api/battles/${ab.id}/start`, { hand: 2 }, B2);
  check(rev.status === 200 && rev.body.completed && rev.body.steps.at(-1).type === 'end', 'a finished hand can be reopened for review');
  const recAB = (await api('GET', '/api/battles', null, A2)).body.record.find((r) => r.opponent.name === 'Bob');
  check(recAB && recAB.wins + recAB.losses + recAB.draws === 1, 'head-to-head record for Alice vs Bob');

  console.log('\n# battles: already-completed hands keep their first-play score; a draw');
  const erinScores = {};
  for (const p of all9) {
    let r0 = await api('POST', `/api/puzzles/${p.id}/start`, { mode: 'scored' }, E);
    for (let i = r0.body.next; i !== null && i < decCount(p.id); i++) r0 = await api('POST', `/api/puzzles/${p.id}/act`, { decisionIndex: i, optionId: firstOpt(p.id, i), mode: 'scored' }, E);
    erinScores[p.id] = r0.body.end.score;
  }
  const ef = (await api('POST', '/api/battles', {}, E)).body.battle;
  await api('POST', `/api/battles/${ef.id}/join`, {}, F);
  const efEnd = await playLive(ef.id, [E, F], [bestOpt, bestOpt], { fromReady: true });
  const efIds = efEnd.hands.map((x) => x.puzzle.id);
  const erinList = (await api('GET', '/api/puzzles', null, E)).body.puzzles;
  check(efIds.every((id) => erinList.find((p) => p.id === id).score === erinScores[id]), 'Erin\'s stored first-play scores are unchanged by the battle');
  check(efEnd.hands.every((x) => x.me.score === 100), 'her battle hands still scored on their own (all 100)');
  const frankList = (await api('GET', '/api/puzzles', null, F)).body.puzzles;
  check(efIds.every((id) => frankList.find((p) => p.id === id).status === 'done' && frankList.find((p) => p.id === id).score === 100), 'Frank\'s fresh hands count as his first plays');
  check(efEnd.status === 'finished' && efEnd.outcome === 'draw', `equal totals are a draw (${efEnd.me.total} - ${efEnd.opps[0].total})`);
  check((await api('GET', '/api/battles', null, F)).body.record.find((r) => r.opponent.name === 'Erin')?.draws === 1, 'the draw is in the head-to-head record');

  console.log('\n# battles: cancel');
  const cc = (await api('POST', '/api/battles', {}, C)).body.battle;
  check((await api('POST', `/api/battles/${cc.id}/cancel`, {}, D)).status === 403, 'only the creator can cancel');
  const cnl = await api('POST', `/api/battles/${cc.id}/cancel`, {}, C);
  check(cnl.status === 200 && cnl.body.battle.status === 'cancelled' && cnl.body.battle.cancelReason === 'creator', 'the creator cancels while nobody has joined');
  check((await api('POST', `/api/battles/${cc.id}/join`, {}, D)).status === 409, 'a cancelled battle cannot be joined');
  check(!(await api('GET', '/api/battles', null, D)).body.open.some((o) => o.id === cc.id), 'and is gone from the open list');
  const cr = (await api('POST', '/api/battles', {}, C)).body.battle;
  await api('POST', `/api/battles/${cr.id}/join`, {}, F);
  check((await api('POST', `/api/battles/${cr.id}/cancel`, {}, C)).body.battle?.status === 'cancelled', 'the creator can still cancel in the ready check, before the first hand');

  console.log('\n# battles: rematch');
  const rm = await api('POST', `/api/battles/${ab.id}/rematch`, {}, A2);
  check(rm.status === 201 && rm.body.battle.status === 'open' && rm.body.battle.invite === 'them' && rm.body.battle.opponent?.name === 'Bob', 'Alice asks Bob for a rematch');
  const rm2 = await api('POST', `/api/battles/${ab.id}/rematch`, {}, B2);
  check(rm2.status === 200 && rm2.body.battle.id === rm.body.battle.id, 'Bob pressing rematch too gets the same battle');
  const old = await abFull(B2);
  check(old.rematch && old.rematch.id === rm.body.battle.id && !old.rematch.byYou && old.rematch.invitedYou, 'Bob\'s final screen shows the invitation');
  check((await api('GET', '/api/battles', null, B2)).body.open.some((o) => o.id === rm.body.battle.id && o.invite === 'you'), 'and his battle list');
  check(!(await api('GET', '/api/battles', null, C)).body.open.some((o) => o.id === rm.body.battle.id), 'nobody else sees it');
  check((await api('POST', `/api/battles/${rm.body.battle.id}/join`, {}, C)).status === 403, 'nobody else can join it');
  const rmj = await api('POST', `/api/battles/${rm.body.battle.id}/join`, {}, B2);
  check(rmj.status === 200 && rmj.body.battle.status === 'active' && rmj.body.battle.live.phase === 'ready', 'Bob accepts: the rematch goes to its ready check');
  await readyAll(rmj.body.battle.id, [A2, B2]); await adv(T.countdown + 50);
  const rmHand0 = (await stateOf(A2, rmj.body.battle.id)).hands[0].puzzle.id;
  check(rmHand0 !== abHand0, 'the rematch deals other hands');

  console.log('\n# battles: a puzzle changes mid-battle');
  await answer(A2, rmj.body.battle.id, 0, 0, bestOpt(rmHand0, 0));
  check((await api('GET', '/api/puzzles', null, A2)).body.puzzles.find((p) => p.id === rmHand0).battle === rmj.body.battle.id, 'hand held by the rematch');
  const chg = solution(rmHand0); chg.title = `${chg.title} (re-solved)`;
  writeFileSync(join(SOL, `${rmHand0}.json`), JSON.stringify(chg));
  await sleep(RESCAN_MS * 3);
  const cx = await api('GET', `/api/battles/${rmj.body.battle.id}`, null, B2);
  check(cx.status === 200 && cx.body.battle.status === 'cancelled' && cx.body.battle.cancelReason === 'hands_updated', 'the battle ends as cancelled: the hands were updated');
  check((await answer(B2, rmj.body.battle.id, 0, 0, bestOpt(rmHand0, 0))).status === 409, 'no more answers after that');
  check(!(await api('GET', '/api/puzzles', null, A2)).body.puzzles.find((p) => p.id === rmHand0).battle, 'its hands are free again');
  const rst = await api('POST', `/api/puzzles/${rmHand0}/start`, { mode: 'scored' }, A2);
  check(rst.status === 200 && rst.body.restarted && rst.body.next === 0, 'the half-played credited play restarts like any changed puzzle');
  const rmAgain = await api('POST', `/api/battles/${rmj.body.battle.id}/rematch`, {}, B2);
  check(rmAgain.status === 201 && rmAgain.body.battle.invite === 'them', 'a new battle can be started from the cancelled one');
  check((await api('POST', `/api/battles/${rmAgain.body.battle.id}/cancel`, {}, A2)).body.battle?.cancelReason === 'declined', 'the invited player can decline');
  const after2 = await api('GET', `/api/battles/${ab.id}`, null, A2);
  check(after2.status === 200 && after2.body.battle.status === 'finished' && after2.body.battle.me.total === as.me.total, 'finished battles keep their result when puzzles change');
  rmSync(join(SOL, `${abHand0}.json`));
  await sleep(RESCAN_MS * 3);
  const gone = await api('GET', `/api/battles/${ab.id}`, null, A2);
  check(gone.status === 200 && gone.body.battle.hands[0].puzzle.available === false && gone.body.battle.me.total === as.me.total, 'and when a puzzle disappears');
  check((await api('POST', `/api/battles/${ab.id}/start`, { hand: 0 }, A2)).status === 410, 'a vanished hand cannot be reopened (410)');

  console.log('\n# three-way battles');
  const G = await login('Gus', '1201'), Hh = await login('Hal', '1202'), I = await login('Ivy', '1203'), J = await login('Jo', '1204'), K = await login('Kim', '1205'), L3 = await login('Lee', '1206');
  check((await api('POST', '/api/battles', { size: 4 }, G)).status === 400, 'size 4 is rejected');
  const t1c = await api('POST', '/api/battles', { size: 3 }, G);
  check(t1c.status === 201 && t1c.body.battle.size === 3 && t1c.body.battle.players.length === 1, 'Gus opens a three-way');
  const duelAgain = await api('POST', '/api/battles', {}, G);
  check(duelAgain.status === 201 && duelAgain.body.battle.size === 2 && duelAgain.body.battle.id !== t1c.body.battle.id, 'a duel is still the default size, separate from his open three-way');
  await api('POST', `/api/battles/${duelAgain.body.battle.id}/cancel`, {}, G);
  const T1 = t1c.body.battle.id;
  let tj = await api('POST', '/api/battles/join', { code: t1c.body.battle.code }, Hh);
  check(tj.status === 200 && tj.body.battle.status === 'open' && tj.body.battle.players.length === 2, 'Hal joins: 2 of 3, still waiting');
  check((await api('GET', '/api/battles', null, I)).body.open.some((o) => o.id === T1 && o.size === 3 && o.joined.length === 2), 'Ivy sees the three-way with 2 of 3 joined');
  check((await api('POST', `/api/battles/${T1}/begin`, {}, Hh)).status === 403, 'only the creator can start early');
  check((await stateOf(G, T1)).canStart === true, 'the creator may start with 2');
  tj = await api('POST', `/api/battles/${T1}/join`, {}, I);
  check(tj.status === 200 && tj.body.battle.status === 'active' && tj.body.battle.live.phase === 'ready' && tj.body.battle.opps.length === 2, 'Ivy joins: full, on to the ready check');
  check((await api('POST', `/api/battles/${T1}/join`, {}, L3)).status === 409, 'a fourth player cannot join');
  await ready(G, T1); await ready(Hh, T1);
  check((await stateOf(I, T1)).live.ready.length === 2, 'Ivy sees two players ready');
  await ready(I, T1); await adv(T.countdown + 50);
  let gs = await stateOf(G, T1);
  const pid0 = gs.hands[0].puzzle.id;
  await answer(G, T1, 0, 0, bestOpt(pid0, 0));
  let is = await stateOf(I, T1), hs = await stateOf(Hh, T1);
  check(is.live.deadline === hs.live.deadline && is.live.deadline !== null && is.live.firstBy === 'Gus', 'Gus answers: the same clock for Hal and Ivy');
  check(is.hands[0].opps.every((o) => o.choices.length === 0), 'Ivy (not answered) sees no picks');
  await answer(Hh, T1, 0, 0, bestOpt(pid0, 0));
  hs = await stateOf(Hh, T1);
  check(hs.hands[0].opps.find((o) => o.id === gs.you.id) ? true : hs.hands[0].opps.some((o) => o.choices.length === 1), 'Hal (answered) sees Gus\'s pick');
  check(hs.live.phase === 'decide' && hs.live.answered.length === 2, 'two of three answered: the hand waits for Ivy');
  await adv(5000);
  await answer(I, T1, 0, 0, firstOpt(pid0, 0));
  is = await stateOf(I, T1);
  check(is.live.phase === 'review' && is.hands[0].opps.every((o) => o.choices.length === 1), 'Ivy answers: review, all picks visible to all');
  gs = await playLive(T1, [G, Hh, I], [bestOpt, bestOpt, firstOpt]);
  const ivs = await stateOf(I, T1);
  check(gs.status === 'finished' && gs.outcome === 'shared' && gs.place === 1 && gs.shared, `Gus and Hal tie for 1st: "shared" (${gs.outcome})`);
  check(ivs.outcome === 'place' && ivs.place === 3 && ivs.standings.map((x) => x.place).join() === '1,1,3', `Ivy is 3rd, places 1,1,3 (${ivs.standings.map((x) => x.place)})`);
  check(gs.hands[0].winners.length >= 2 && gs.hands[0].outcome === 'tied', 'round results: the 100s share hand 1');
  const recG = (await api('GET', '/api/battles', null, G)).body.record;
  check(recG.find((r) => r.opponent.name === 'Hal')?.draws === 1 && recG.find((r) => r.opponent.name === 'Ivy')?.wins === 1, 'head-to-head counts each pair: a draw with Hal, a win over Ivy');
  // Silent third player: the two others can always finish.
  const t2c = (await api('POST', '/api/battles', { size: 3 }, G)).body.battle;
  await api('POST', `/api/battles/${t2c.id}/join`, {}, Hh); await api('POST', `/api/battles/${t2c.id}/join`, {}, I);
  const t2e = await playLive(t2c.id, [G, Hh, I], [bestOpt, firstOpt, null], { fromReady: true });
  const ivy2 = await stateOf(I, t2c.id);
  check(t2e.status === 'finished' && ivy2.me.total === 0 && ivy2.place === 3, 'Ivy silent through a whole three-way: all time-outs, the others finish, she is 3rd with 0');

  console.log('\n# three-way: start with 2, rematches');
  const jk = (await api('POST', '/api/battles', { size: 3 }, J)).body.battle;
  await api('POST', `/api/battles/${jk.id}/join`, {}, K);
  const jb = await api('POST', `/api/battles/${jk.id}/begin`, {}, J);
  check(jb.status === 200 && jb.body.battle.status === 'active' && jb.body.battle.live.phase === 'ready' && jb.body.battle.players.length === 2 && jb.body.battle.size === 3, '"Start with 2" goes to the ready check with two players');
  check((await api('POST', `/api/battles/${jk.id}/join`, {}, L3)).status === 409, 'nobody can join after that');
  const r1 = await api('POST', `/api/battles/${T1}/rematch`, {}, G);
  check(r1.status === 201 && r1.body.battle.invited.length === 2 && r1.body.battle.size === 3, 'Gus asks both for a rematch');
  check((await stateOf(Hh, T1)).rematch?.invitedYou && (await stateOf(I, T1)).rematch?.invitedYou, 'both see the invitation on their final screen');
  check((await api('POST', `/api/battles/${r1.body.battle.id}/join`, {}, L3)).status === 403, 'a stranger cannot take the seat');
  const rj = await api('POST', `/api/battles/${r1.body.battle.id}/join`, {}, Hh);
  check(rj.body.battle.status === 'open' && rj.body.battle.players.length === 2 && rj.body.battle.invited.length === 1, 'Hal accepts: waiting for Ivy');
  await api('POST', `/api/battles/${r1.body.battle.id}/cancel`, {}, I);
  const r1s = await stateOf(G, r1.body.battle.id);
  check(r1s.status === 'active' && r1s.live.phase === 'ready' && r1s.players.map((x) => x.name).sort().join() === 'Gus,Hal', 'Ivy declines: everyone has answered, it goes on with Gus and Hal');
  const r2 = (await api('POST', `/api/battles/${t2c.id}/rematch`, {}, G)).body.battle;
  await api('POST', `/api/battles/${r2.id}/join`, {}, Hh);
  check((await stateOf(G, r2.id)).canStart, 'with one acceptance the inviter may start');
  const r2b = await api('POST', `/api/battles/${r2.id}/begin`, {}, G);
  check(r2b.body.battle.status === 'active' && r2b.body.battle.players.length === 2, 'Gus starts the rematch with Hal while Ivy has not answered');
  check((await api('POST', `/api/battles/${r2.id}/join`, {}, I)).status === 409, 'Ivy is too late');

  console.log('\n# hand selection treats a partial play as played');
  {
    const { chooseHands } = await import(join(ROOT, 'server', 'lib', 'battles.mjs'));
    const lv = ['easy', 'easy', 'medium', 'medium', 'hard', 'hard'];
    const puzzles = new Map(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map((id, i) => [id, { solution: { id, title: id }, fingerprint: id, number: i + 1, level: lv[i], rank: i + 1, decisionCount: 4 }]));
    const ctxU = {
      puzzles,
      storage: {
        listPlays: async () => [{ playerId: 'x', puzzleId: 'q1', choices: [{ index: 0 }], completedAt: 1, score: 100, partial: true }],
        listBattles: async () => [],
      },
    };
    let picked = new Set();
    for (let k = 0; k < 10; k++) (await chooseHands(ctxU, ['x', 'y'])).forEach((hd) => picked.add(hd.puzzleId));
    check(!picked.has('q1') && picked.size === 5, `a partially played puzzle is avoided like a played one (${[...picked].sort()})`);
  }

  console.log('\n# battles stored before three-way and live battles still work');
  {
    const port2 = await new Promise((res) => { const s2 = net.createServer(); s2.listen(0, () => { const p = s2.address().port; s2.close(() => res(p)); }); });
    const db2 = join(tmp, 'old-db.json');
    const ids = readdirSync(SOL).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).slice(0, 5);
    const fp = (id) => createHash('sha1').update(readFileSync(join(SOL, `${id}.json`), 'utf8')).digest('hex').slice(0, 16);
    const decs = (id) => solution(id).steps.filter((x) => x.type === 'decision');
    const hands = ids.map((id, i) => ({ puzzleId: id, fingerprint: fp(id), title: solution(id).title, number: i + 1, level: 'easy', rank: i + 1, decisionCount: decs(id).length }));
    const T0 = Date.now() - 86400000;
    const pidP = readdirSync(SOL).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).find((x) => !ids.includes(x));
    const done = (pts) => ({ hands: hands.map((hd) => ({ choices: decs(hd.puzzleId).map((d) => ({ index: d.index, optionId: d.mainLine, label: d.mainLine, street: d.street, grade: 'best', points: pts, at: T0 })), credited: false, completedAt: T0, score: pts })), finishedAt: T0 });
    const oldDb = {
      version: 1,
      players: {
        olga: { id: 'olga', name: 'Olga', nameKey: 'olga', pinSalt: 'x', pinHash: 'y', failures: 0, lockedUntil: 0, createdAt: T0 },
        pete: { id: 'pete', name: 'Pete', nameKey: 'pete', pinSalt: 'x', pinHash: 'y', failures: 0, lockedUntil: 0, createdAt: T0 },
      },
      sessions: { 'tok-olga': { token: 'tok-olga', playerId: 'olga', createdAt: T0, expiresAt: Date.now() + 1e9 }, 'tok-pete': { token: 'tok-pete', playerId: 'pete', createdAt: T0, expiresAt: Date.now() + 1e9 } },
      plays: {
        // A hand finished by hand from an unfinished battle: counts as played, never scored.
        [`olga:${pidP}`]: { playerId: 'olga', puzzleId: pidP, fingerprint: fp(pidP), choices: [{ index: 0, optionId: decs(pidP)[0].mainLine, label: 'x', street: 'preflop', grade: 'best', points: 100, at: T0 }], startedAt: T0, completedAt: T0, score: 100, partial: true },
        [`pete:${pidP}`]: { playerId: 'pete', puzzleId: pidP, fingerprint: fp(pidP), choices: decs(pidP).map((d) => ({ index: d.index, optionId: d.mainLine, label: 'x', street: d.street, grade: 'correct', points: 80, at: T0 })), startedAt: T0, completedAt: T0, score: 80 },
      },
      battles: {
        ob1: { id: 'ob1', code: 'ACDE', status: 'finished', createdBy: 'olga', players: ['olga', 'pete'], inviteId: null, createdAt: T0, joinedAt: T0, finishedAt: T0, cancelledAt: null, cancelReason: null, hands, result: { totals: { olga: 400, pete: 350 }, winnerId: 'olga' }, rematchOf: null, rematchId: 'ob3' },
        ob2: { id: 'ob2', code: 'FGHJ', status: 'active', createdBy: 'pete', players: ['pete', 'olga'], inviteId: null, createdAt: T0, joinedAt: T0, finishedAt: null, cancelledAt: null, cancelReason: null, hands, result: null, rematchOf: null, rematchId: null },
        ob3: { id: 'ob3', code: 'KMNP', status: 'open', createdBy: 'olga', players: ['olga', null], inviteId: 'pete', createdAt: T0, joinedAt: null, finishedAt: null, cancelledAt: null, cancelReason: null, hands: [], result: null, rematchOf: 'ob1', rematchId: null },
        ob4: { id: 'ob4', code: 'RTUV', status: 'open', createdBy: 'pete', players: ['pete', null], inviteId: null, createdAt: T0, joinedAt: null, finishedAt: null, cancelledAt: null, cancelReason: null, hands: [], result: null, rematchOf: null, rematchId: null },
      },
      battlePlays: {
        'ob1:olga': { battleId: 'ob1', playerId: 'olga', ...done(80) },
        'ob1:pete': { battleId: 'ob1', playerId: 'pete', ...done(70) },
        'ob2:pete': { battleId: 'ob2', playerId: 'pete', hands: hands.map(() => ({ choices: [], credited: null, completedAt: null, score: null })), finishedAt: null },
        'ob2:olga': { battleId: 'ob2', playerId: 'olga', hands: hands.map((hd, i) => ({ choices: i === 0 ? [{ index: 0, optionId: decs(hd.puzzleId)[0].mainLine, label: 'x', street: 'preflop', grade: 'best', points: 100, at: T0 }] : [], credited: false, completedAt: null, score: null })), finishedAt: null },
      },
    };
    writeFileSync(db2, JSON.stringify(oldDb));
    const srv2 = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], { env: { ...env, PORT: String(port2), DB_FILE: db2, TEST_CLOCK: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out2 = ''; srv2.stdout.on('data', (d) => { out2 += d; }); srv2.stderr.on('data', (d) => { out2 += d; });
    await new Promise((res) => { const iv = setInterval(() => { if (out2.includes('listening')) { clearInterval(iv); res(); } }, 50); });
    const api2 = async (method, path, body, token) => {
      const r = await fetch(`http://127.0.0.1:${port2}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    try {
      const o1 = await api2('GET', '/api/battles/ob1', null, 'tok-olga');
      check(o1.status === 200 && o1.body.battle.size === 2 && o1.body.battle.outcome === 'win' && o1.body.battle.me.total === 400 && o1.body.battle.opps[0].total === 350 && o1.body.battle.live.phase === 'done', 'an old finished duel reads as before: win 400-350');
      check(o1.body.battle.rematch?.id === 'ob3' && o1.body.battle.rematch.byYou, 'with its pending rematch');
      const lp = (await api2('GET', '/api/battles', null, 'tok-pete')).body;
      check(lp.open.some((o) => o.id === 'ob3' && o.invite === 'you') && !lp.open.some((o) => o.id === 'ob4'), 'Pete sees the old rematch invitation (and not his own challenge as one to join)');
      check(lp.record.find((r) => r.opponent.name === 'Olga')?.losses === 1, 'the old result is in the head-to-head');
      // A partial play: played, not scored.
      const ol = (await api2('GET', '/api/puzzles', null, 'tok-olga')).body;
      const prow = ol.puzzles.find((x) => x.id === pidP);
      check(prow.status === 'done' && prow.score === null && prow.scored === false && ol.nextId !== pidP, 'a partial play shows as done, score null, scored: false; nextId skips it');
      const lbP = (await api2('GET', '/api/leaderboard', null, 'tok-olga')).body.players;
      check(lbP.find((x) => x.name === 'Olga').played === 0 && lbP.find((x) => x.name === 'Olga').shares === null && lbP.find((x) => x.name === 'Pete').played === 1, 'the leaderboard leaves it out (played, totals, grades)');
      const pst = (await api2('POST', `/api/puzzles/${pidP}/start`, { mode: 'scored' }, 'tok-pete')).body;
      check(pst.completed && pst.end.others.length === 0, 'and so does "others\' scores" on the puzzle');
      const orv = (await api2('GET', `/api/puzzles/${pidP}/review`, null, 'tok-olga')).body;
      check(orv.end.partial === true && orv.end.score === null && orv.answers.length === 1, 'its review says partial, no score, the one answered decision');
      check((await api2('POST', `/api/puzzles/${pidP}/start`, { mode: 'scored' }, 'tok-olga')).body.completed === true, 'it is not playable as a first play again');
      const pj = await api2('POST', '/api/battles/ob3/join', {}, 'tok-pete');
      check(pj.status === 200 && pj.body.battle.status === 'active' && pj.body.battle.live.phase === 'ready', 'Pete accepts the old invitation: ready check');
      const o2 = await api2('GET', '/api/battles/ob2', null, 'tok-pete');
      check(o2.body.battle.live.phase === 'ready' && o2.body.battle.live.hand === 0 && o2.body.battle.live.index === 0, 'an old running duel gets a ready check, at the earliest open decision');
      await api2('POST', '/api/battles/ob2/ready', {}, 'tok-pete');
      const o2r = (await api2('POST', '/api/battles/ob2/ready', {}, 'tok-olga')).body.battle;
      check(o2r.live.phase === 'countdown' && o2r.live.kind === 'resume', 'both ready: it resumes with a countdown');
      await sleep(o2r.live.startsAt - o2r.serverNow + 100);
      const ps = await api2('POST', '/api/battles/ob2/start', { hand: 0 }, 'tok-pete');
      check(ps.status === 200 && ps.body.next === 0 && ps.body.battle.live.deadline - ps.body.battle.serverNow > 18000, 'Olga\'s old answer starts Pete\'s clock only from the resume moment');
      const pa = await api2('POST', '/api/battles/ob2/act', { hand: 0, decisionIndex: 0, optionId: decs(ids[0])[0].mainLine }, 'tok-pete');
      check(pa.status === 200 && pa.body.battle.live.phase === 'review' && pa.body.battle.hands[0].opps[0].choices.length === 1, 'Pete answers: review, he sees Olga\'s pick');
      const oj = await api2('POST', '/api/battles/ob4/join', {}, 'tok-olga');
      check(oj.status === 200 && oj.body.battle.status === 'active', 'an old open challenge can be joined');

      // Profiles and "others" with a partial play and hands finished only in a battle.
      const pOlga = (await api2('GET', '/api/players/olga', null, 'tok-pete')).body;
      check(pOlga.handsTotal === 0 && pOlga.hands.length === 0 && pOlga.stats.played === 0 && pOlga.stats.detail === false && findKeys(pOlga.stats, ['grades', 'decisions', 'shares']).length === 0, 'Pete sees no hands on Olga\'s profile: her partial play is never shown to others or counted');
      const pOwn = (await api2('GET', '/api/players/olga', null, 'tok-olga')).body;
      check(pOwn.you && pOwn.hands.length === 1 && pOwn.hands[0].partial === true && pOwn.hands[0].score === null && pOwn.stats.played === 0, 'on her own profile it is listed as not scored, and still not counted');
      const pPete = (await api2('GET', '/api/players/pete', null, 'tok-olga')).body;
      check(pPete.hands.length === 1 && pPete.hands[0].finished === true && pPete.hands[0].mine?.partial === true && pPete.hands[0].choices.length === decs(pidP).length, 'Olga, who has seen the whole hand, sees Pete\'s decisions on it next to her partial play');
      const othP = (await api2('GET', `/api/puzzles/${pidP}/others`, null, 'tok-pete')).body;
      check(othP.total === 0 && othP.others.length === 0 && othP.you.score === 80, '"Others on this hand" leaves the partial play out');
      const othO = await api2('GET', `/api/puzzles/${pidP}/others`, null, 'tok-olga');
      check(othO.status === 200 && othO.body.others.length === 1 && othO.body.others[0].player.name === 'Pete' && othO.body.you.partial === true, 'Olga (partial, but finished) sees Pete there');
      const othB = await api2('GET', `/api/puzzles/${ids[0]}/others`, null, 'tok-olga');
      check(othB.status === 200 && othB.body.you.battle === true && othB.body.you.choices.length === decs(ids[0]).length, 'a hand finished only in a battle counts as finished: "others" opens, with her battle choices as hers');
      check((await api2('GET', '/api/friends', null, 'tok-olga')).body.friends.length === 0, 'a db from before friends existed: no friends, no error');
      const ofr = await api2('POST', '/api/friends/request', { name: 'pete' }, 'tok-olga');
      check(ofr.status === 201 && ofr.body.relation === 'sent', 'and a request can be sent');
      await sleep(300);
      const saved = JSON.parse(readFileSync(db2, 'utf8'));
      check(!('inviteId' in saved.battles.ob3) && !saved.battles.ob4.players.includes(null) && saved.battles.ob4.size === 2, 'records written back are in the new format');
      check(saved.battles.ob1.players.join() === 'olga,pete' && !saved.battles.ob1.live, 'untouched records stay as they were');
      check(Object.values(saved.friends || {}).length === 1 && Object.values(saved.friends)[0].from === 'olga', 'the friends collection is added to the file when first used');
    } finally { srv2.kill('SIGTERM'); }
  }

  // ===================================================================
  // Friends, profiles, "others on this hand", ranking.
  console.log('\n# friends: requests');
  const aliceId = a.body.player.id, bobId = b.body.player.id;
  const meOf = async (tok) => (await api('GET', '/api/me', null, tok)).body;
  const friendsOf = async (tok) => (await api('GET', '/api/friends', null, tok)).body;
  const askF = (tok, body) => api('POST', '/api/friends/request', body, tok);
  const fAct = (tok, id, what) => api('POST', `/api/friends/${id}/${what}`, {}, tok);
  const names = (list) => list.map((x) => x.name).sort().join();
  const carolId = (await meOf(C)).player.id, daveId = (await meOf(D)).player.id, erinId = (await meOf(E)).player.id;
  check((await meOf(A2)).friendRequests === 0 && (await friendsOf(A2)).friends.length === 0, 'nobody has friends yet; /api/me counts no requests');
  let fr = await askF(A2, { name: 'bob' });
  check(fr.status === 201 && fr.body.relation === 'sent' && fr.body.player.id === bobId, 'Alice asks Bob by name (any case)');
  check((await meOf(B2)).friendRequests === 1, "Bob's /api/me counts one request (the badge)");
  let fb = await friendsOf(B2);
  check(names(fb.incoming) === 'Alice' && !fb.friends.length && !fb.outgoing.length && fb.incoming[0].at > 0, 'Bob sees it under incoming');
  check(names((await friendsOf(A2)).outgoing) === 'Bob', 'Alice sees it under sent');
  fr = await askF(A2, { name: '  BOB ' });
  check(fr.status === 200 && fr.body.existing && (await friendsOf(A2)).outgoing.length === 1, 'asking again is no duplicate');
  check((await askF(A2, { name: 'alice' })).status === 400, 'no request to yourself');
  check((await askF(A2, { id: aliceId })).status === 400, 'not by id either');
  check((await askF(A2, { name: 'Nobody Here' })).status === 404, 'an unknown name: 404');
  check((await askF(A2, { name: '  ' })).status === 400 && (await askF(A2, { id: 'nonexistent00' })).status === 404, 'an empty name: 400, an unknown id: 404');
  fr = await askF(B2, { id: aliceId });
  check(fr.status === 200 && fr.body.relation === 'friend' && fr.body.mutual, 'Bob asks Alice back: friends at once');
  fb = await friendsOf(B2);
  const fa = await friendsOf(A2);
  check(names(fb.friends) === 'Alice' && names(fa.friends) === 'Bob' && !fb.incoming.length && !fa.outgoing.length && (await meOf(B2)).friendRequests === 0, 'both lists show the friendship, no requests left');
  check(['played', 'average', 'lastActive', 'since'].every((k) => k in fa.friends[0]) && fa.friends[0].lastActive > 0, 'a friend row has hands played, average, last active, since');
  check((await askF(A2, { name: 'Bob' })).status === 409, 'asking a friend again: 409');
  check((await fAct(A2, bobId, 'accept')).body.existing === true && (await fAct(A2, bobId, 'cancel')).status === 409, 'accepting a friend is a no-op; cancelling a friendship as a request: 409');
  // decline
  await askF(C, { name: 'Alice' });
  check((await meOf(A2)).friendRequests === 1, 'Carol asks Alice');
  fr = await fAct(A2, carolId, 'decline');
  check(fr.status === 200 && fr.body.relation === 'none' && !(await friendsOf(C)).outgoing.length && !(await friendsOf(A2)).incoming.length, 'Alice declines: gone on both sides');
  check((await fAct(A2, carolId, 'decline')).status === 404 && (await fAct(A2, carolId, 'accept')).status === 404, 'nothing left to decline or accept');
  // cancel
  await askF(D, { name: 'Alice' });
  fr = await fAct(D, aliceId, 'cancel');
  check(fr.status === 200 && !(await friendsOf(A2)).incoming.length, 'Dave asks Alice and takes it back');
  check((await fAct(A2, daveId, 'accept')).status === 404 && (await fAct(D, aliceId, 'cancel')).status === 404, 'a cancelled request cannot be accepted, or cancelled twice');
  check((await fAct(A2, carolId, 'cancel')).status === 404, 'cancelling a request that was never sent: 404');
  // accept, remove
  await askF(E, { name: 'Alice' });
  fr = await fAct(A2, erinId, 'accept');
  check(fr.status === 200 && fr.body.relation === 'friend' && names((await friendsOf(E)).friends) === 'Alice', 'Erin asks, Alice accepts');
  check(names((await friendsOf(A2)).friends) === 'Bob,Erin', 'Alice has two friends');
  fr = await fAct(A2, erinId, 'remove');
  check(fr.status === 200 && names((await friendsOf(A2)).friends) === 'Bob' && !(await friendsOf(E)).friends.length, 'Alice removes Erin: gone for both');
  check((await fAct(A2, erinId, 'remove')).status === 404, 'removing again: 404');
  check((await api('GET', '/api/friends')).status === 401 && (await api('GET', '/api/friends/request', null, A2)).status === 405, 'friends need a session; wrong method: 405');

  console.log('\n# finding players');
  check((await api('GET', '/api/players?q=a', null, A2)).status === 400, 'a search needs at least 2 letters');
  let sr = await api('GET', '/api/players?q=al', null, B2);
  check(sr.status === 200 && sr.body.players.some((x) => x.name === 'Alice' && x.relation === 'friend') && sr.body.players.every((x) => x.name.toLowerCase().startsWith('al')), 'prefix search ("al"): Alice, shown to Bob as a friend');
  sr = await api('GET', '/api/players?q=ALI', null, A2);
  check(sr.body.players[0]?.relation === 'you', 'yourself as "you" (case ignored)');
  await askF(C, { name: 'Bob' });
  check((await api('GET', '/api/players?q=bo', null, C)).body.players.find((x) => x.name === 'Bob')?.relation === 'sent', 'Carol sees "request sent" next to Bob');
  check((await api('GET', '/api/players?q=ca', null, B2)).body.players.find((x) => x.name === 'Carol')?.relation === 'received', 'Bob sees Carol as "wants to be your friend"');
  check((await api('GET', '/api/players?q=da', null, B2)).body.players.find((x) => x.name === 'Dave')?.relation === 'none', 'and Dave as nobody yet');
  check(findKeys((await api('GET', '/api/players?q=al', null, B2)).body, ['pinHash', 'pinSalt', 'nameKey', 'lastSeenAt']).length === 0, 'search results carry no private fields');
  const battledF = (await friendsOf(F)).battled;
  check(battledF.some((x) => x.name === 'Erin' && x.battles >= 1 && x.relation === 'none') && battledF.some((x) => x.name === 'Carol'), `"people you have battled" for Frank: Erin and Carol (${names(battledF)})`);
  check(!(await friendsOf(B2)).battled.some((x) => x.name === 'Alice'), 'friends are not suggested again');

  console.log('\n# profiles and "others on this hand"');
  const S_MIN = (await import(join(ROOT, 'server', 'lib', 'social.mjs'))).RANKING.minHands;
  const doneOf = async (tok) => (await api('GET', '/api/puzzles', null, tok)).body.puzzles.filter((x) => x.status === 'done');
  const aliceDone = await doneOf(A2), bobDone0 = await doneOf(B2);
  const both = aliceDone.filter((x) => bobDone0.some((y) => y.id === x.id)).map((x) => x.id);
  const aliceOnly = aliceDone.filter((x) => x.score !== null && !bobDone0.some((y) => y.id === x.id)).map((x) => x.id);
  check(both.includes('fx01') && aliceOnly.length > 0, `Alice and Bob both finished ${both}; only Alice ${aliceOnly}`);
  const X = aliceOnly[0];
  const SECRET_ROW = ['choices', 'mine', 'marks', 'optionId', 'grade', 'label', 'decisionCount', 'points', 'stale'];
  let pa = await api('GET', `/api/players/${aliceId}`, null, B2);
  check(pa.status === 200 && pa.body.player.name === 'Alice' && pa.body.player.since > 0 && pa.body.relation === 'friend' && pa.body.you === false, 'Bob opens Alice\'s profile: name, member since, "friend"');
  const lbE = (await api('GET', '/api/leaderboard', null, B2)).body;
  const aRow = lbE.players.find((x) => x.id === aliceId);
  const ps = pa.body.stats;
  /** Shares in whole percent: the five grades (and `timeout` if any), integers adding up to exactly 100. */
  const sharesOk = (sh) => !!sh && ['best', 'correct', 'inaccuracy', 'wrong', 'blunder'].every((g) => Number.isInteger(sh[g])) && Object.values(sh).every(Number.isInteger) && Object.values(sh).reduce((x, y) => x + y, 0) === 100;
  const COUNT_KEYS = ['grades', 'decisions', 'decisionCount', 'points'];
  check(ps.played === aRow.played && ps.average === aRow.average && ps.totalPoints === aRow.totalPoints && JSON.stringify(ps.shares) === JSON.stringify(aRow.shares), `her statistics match the leaderboard (${ps.played} hands, average ${ps.average}, shares ${JSON.stringify(ps.shares)})`);
  check(ps.detail === true && sharesOk(ps.shares), 'from 5 hands (she has 6) her answers by grade come as whole percent adding up to 100');
  check(['preflop', 'flop', 'turn', 'river'].every((s) => s in ps.streets && Object.keys(ps.streets[s]).join() === 'average') && ps.streets.preflop.average >= 0, 'by street only the average points per decision');
  // Bob has finished only part of Alice's hands: nothing may let him count the decisions of the others.
  check(findKeys(pa.body.stats, COUNT_KEYS).length === 0, `her profile (Bob has finished only part of her hands) carries no grade counts and no decision totals, per street or overall (${findKeys(pa.body.stats, COUNT_KEYS)})`);
  check(findKeys(pa.body.hands, ['grades', 'decisions', 'decisionCount']).length === 0, 'nor does her hand list');
  const lbF0 = (await api('GET', '/api/leaderboard?scope=friends', null, B2)).body;
  check([lbE, lbF0].every((lb) => findKeys(lb, COUNT_KEYS).length === 0 && lb.players.every((x) => x.shares === null || sharesOk(x.shares))), 'nor the leaderboard, in either scope: shares only, adding up to 100');
  check(lbE.players.filter((x) => x.id !== bobId).every((x) => (x.shares !== null) === (x.played >= S_MIN)), `the leaderboard shows another player's split from ${S_MIN} hands on, below that none`);
  const pgA = (await api('GET', `/api/players/${aliceId}/hands?limit=2`, null, B2)).body;
  check(findKeys(pgA, ['grades', 'decisions', 'decisionCount']).length === 0 && pgA.hands.filter((x) => !x.finished).every((x) => !('choices' in x)), 'nor a page of her hands: decisions only for hands Bob has finished');
  check(ps.battles.played >= 1 && ps.battles.won <= ps.battles.played, `battles played and won (${ps.battles.won} of ${ps.battles.played})`);
  const rowsA = pa.body.hands;
  check(rowsA.length === pa.body.handsTotal && rowsA.every((r, i) => i === 0 || rowsA[i - 1].completedAt >= r.completedAt), 'her hands, newest first');
  check(rowsA.every((r) => r.puzzle?.title && r.completedAt && typeof r.score === 'number'), 'each with the hand, the date and her score');
  const rowX = rowsA.find((r) => r.puzzle.id === X);
  check(rowX && rowX.finished === false && findKeys(rowX, SECRET_ROW).length === 0, `a hand Bob has not finished (${X}): her score and date only, no decisions, marks or count`);
  const row1 = rowsA.find((r) => r.puzzle.id === 'fx01');
  check(row1.finished === true && row1.choices.length === 4 && row1.mine?.choices.length === 4 && typeof row1.mine.score === 'number', 'fx01, which both finished: her decisions and Bob\'s own score and decisions');
  check(rowsA.filter((r) => !r.finished).every((r) => findKeys(r, SECRET_ROW).length === 0) && rowsA.filter((r) => !r.finished).every((r) => !both.includes(r.puzzle.id)), 'no row of a hand Bob has not finished says anything about its decisions');
  check(rowsA.filter((r) => both.includes(r.puzzle.id)).every((r) => r.finished), 'every hand both finished is open');
  let ox = await api('GET', `/api/puzzles/${X}/others`, null, B2);
  check(ox.status === 403 && /finish/i.test(ox.body.error) && findKeys(ox.body, ['others', 'choices', 'decisionCount', 'you']).length === 0, 'Bob asks what the others did on a hand he has not finished: 403, nothing in it');
  check((await api('GET', '/api/puzzles/nonexistent/others', null, B2)).status === 404 && (await api('GET', `/api/puzzles/${X}/others`)).status === 401, 'unknown puzzle 404, no session 401');
  // Bob plays X to the end; Mona only starts fx01.
  const playThrough = async (tok, pid, pick = bestOpt) => {
    let r0 = await api('POST', `/api/puzzles/${pid}/start`, { mode: 'scored' }, tok);
    for (let i = r0.body.next; i !== null && i !== undefined && i < decCount(pid); i++) r0 = await api('POST', `/api/puzzles/${pid}/act`, { decisionIndex: i, optionId: pick(pid, i), mode: 'scored' }, tok);
    return r0;
  };
  const endX = await playThrough(B2, X, firstOpt);
  check(endX.body.end?.score !== undefined, `Bob finishes ${X}`);
  const M = await login('Mona', '7070');
  const monaId = (await meOf(M)).player.id;
  await api('POST', '/api/puzzles/fx01/start', { mode: 'scored' }, M);
  await api('POST', '/api/puzzles/fx01/act', { decisionIndex: 0, optionId: firstOpt('fx01', 0), mode: 'scored' }, M);
  ox = await api('GET', `/api/puzzles/${X}/others`, null, B2);
  const oA = ox.body.others?.find((o) => o.player.id === aliceId);
  check(ox.status === 200 && oA && oA.friend === true && ox.body.others[0].player.id === aliceId, 'after finishing: Alice is listed, first, marked as a friend');
  check(oA.choices.length === decCount(X) && oA.choices.every((c) => c.label && c.grade && typeof c.points === 'number' && c.street) && ox.body.decisionCount === decCount(X), 'with every decision: street, choice, grade, points');
  check(ox.body.you.choices.length === decCount(X) && ox.body.you.choices.every((c, i) => c.optionId === firstOpt(X, i)) && !ox.body.others.some((o) => o.player.id === bobId), 'Bob\'s own choices come as "you", not among the others');
  pa = await api('GET', `/api/players/${aliceId}`, null, B2);
  check(pa.body.hands.find((r) => r.puzzle.id === X)?.finished === true, 'now that hand opens on her profile too');
  const o1 = (await api('GET', '/api/puzzles/fx01/others', null, B2)).body;
  check(o1.others[0].player.id === aliceId && o1.others.slice(1).every((o, i, arr) => !o.friend && (i === 0 || arr[i - 1].completedAt >= o.completedAt)), 'friends first, then the rest, most recent first');
  check(o1.others.length <= 20 && o1.total >= o1.others.length && !o1.others.some((o) => o.player.id === monaId), 'at most 20; Mona\'s unfinished play is not among them');
  const sol1now = solution('fx01').steps.filter((x) => x.type === 'decision');
  const a1 = o1.others[0];
  check(a1.stale === true && a1.choices[1].optionId === 'check' && a1.choices[1].grade === 'correct' && near(a1.choices[1].points, 72.39) && a1.choices[1].label === sol1now[1].options.find((o) => o.id === 'check').label, 'a play of the re-solved fx01 keeps its stored grade (Correct 72.39) as the review does, labels follow the current file');
  check(o1.you.stale === true && o1.you.choices[0].optionId === 'fold', 'and so does Bob\'s own');
  check((await api('GET', '/api/puzzles/fx01/others', null, M)).status === 403, 'Mona, half-way through, gets 403');
  const pm = (await api('GET', `/api/players/${monaId}`, null, A2)).body;
  check(pm.handsTotal === 0 && pm.stats.played === 0 && findKeys(pm, ['choices']).length === 0, 'Mona\'s profile shows nothing of her unfinished hand');
  check((await api('GET', `/api/players/${monaId}`, null, M)).body.hands.length === 0, 'not even to her');
  check((await api('GET', '/api/players/nonexistent00', null, A2)).status === 404, 'unknown player: 404');
  // A profile's own view and its pages.
  const pe = (await api('GET', `/api/players/${erinId}`, null, E)).body;
  check(pe.you === true && pe.relation === 'you' && pe.hands.every((r) => r.finished && r.choices.length) && !pe.hands.some((r) => r.mine), 'your own profile: every hand open, your decisions');
  const pes = pe.stats;
  check(pes.decisions > 0 && Object.values(pes.grades).reduce((x, y) => x + y, 0) === pes.decisions && Object.values(pes.streets).reduce((x, s) => x + s.decisions, 0) === pes.decisions && sharesOk(pes.shares), 'your own profile keeps the exact counts: by grade, by street and in all (with the shares beside them)');
  const pg1 = (await api('GET', `/api/players/${erinId}/hands?limit=3`, null, A2)).body;
  check(pe.handsTotal > 3 && pg1.hands.length === 3 && pg1.next && pg1.handsTotal === pe.handsTotal, `a page of 3 of Erin's ${pe.handsTotal} hands, with a cursor`);
  let pageAll = [], cur = null, pages = 0;
  for (let k = 0; k < 20; k++) {
    const pgx = (await api('GET', `/api/players/${erinId}/hands?limit=3${cur ? `&before=${cur}` : ''}`, null, A2)).body;
    pageAll = pageAll.concat(pgx.hands);
    pages++;
    cur = pgx.next;
    if (!cur) break;
  }
  check(pages === Math.ceil(pe.handsTotal / 3) && pageAll.length === pe.handsTotal && pageAll.map((r) => r.puzzle.id).join() === pe.hands.map((r) => r.puzzle.id).join(), `paging through them gives every hand once, in order (${pages} pages)`);
  check((await api('GET', `/api/players/${erinId}/hands?before=garbage`, null, A2)).status === 400, 'a bad cursor: 400');

  console.log('\n# ranking: everyone and friends');
  const S_ = await import(join(ROOT, 'server', 'lib', 'social.mjs'));
  const MIN = S_.RANKING.minHands;
  const rr = S_.rankRows([
    { id: 'a', name: 'A', played: 10, totalPoints: 800 }, { id: 'b', name: 'B', played: MIN, totalPoints: 80 * MIN },
    { id: 'c', name: 'C', played: 1, totalPoints: 100 }, { id: 'd', name: 'D', played: 10, totalPoints: 800 },
    { id: 'e', name: 'E', played: 6, totalPoints: 540 }, { id: 'f', name: 'F', played: 0, totalPoints: 0 },
  ]);
  check(rr.map((x) => `${x.id}${x.rank ?? '-'}`).join() === 'e1,a2,d2,b4,c-,f-', `rule: average first, more hands break ties, equal ones share, one lucky hand is not ranked (${rr.map((x) => `${x.id}${x.rank ?? '-'}`)})`);
  const sh = (g) => JSON.stringify(S_.sharesOf({ best: 0, correct: 0, inaccuracy: 0, wrong: 0, blunder: 0, ...g }));
  check(sh({ best: 1, correct: 1, inaccuracy: 1 }) === '{"best":34,"correct":33,"inaccuracy":33,"wrong":0,"blunder":0}'
    && sh({ best: 2, timeout: 1 }) === '{"best":67,"correct":0,"inaccuracy":0,"wrong":0,"blunder":0,"timeout":33}'
    && sh({ best: 1, wrong: 6 }) === '{"best":14,"correct":0,"inaccuracy":0,"wrong":86,"blunder":0}'
    && S_.sharesOf({ best: 0, correct: 0, inaccuracy: 0, wrong: 0, blunder: 0 }) === null,
  `shares are whole percent adding up to 100 (largest remainder), time-outs a share of their own, none without answers (${sh({ best: 1, correct: 1, inaccuracy: 1 })})`);
  const orderOk = (rows) => {
    let unranked = false;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if ((r.played >= MIN) !== (r.rank !== null)) return false;
      if (r.rank === null) { unranked = true; continue; }
      if (unranked) return false;
      if (i === 0) { if (r.rank !== 1) return false; continue; }
      const p = rows[i - 1], c = p.totalPoints * r.played - r.totalPoints * p.played;
      if (c < 0 || (c === 0 && p.played < r.played)) return false;
      if (c === 0 && p.played === r.played ? r.rank !== p.rank : r.rank !== i + 1) return false;
    }
    return true;
  };
  const SO = await login('Solo', '6060');
  await playThrough(SO, 'fx02', bestOpt);
  const lbAll = (await api('GET', '/api/leaderboard', null, A2)).body;
  const solo = lbAll.players.find((x) => x.name === 'Solo');
  check(lbAll.scope === 'everyone' && lbAll.minHands === MIN && orderOk(lbAll.players), `the leaderboard follows the rule (ranked from ${MIN} hands)`);
  check(solo.average >= 90 && solo.rank === null && lbAll.players[0].rank === 1 && lbAll.players[0].name !== 'Solo', `a player with one hand of ${solo.average} does not lead it`);
  // Solo's one hand (fx02): its answers by grade and street would describe that hand to anyone who has not played it.
  const aliceHasFx02 = (await doneOf(A2)).some((x) => x.id === 'fx02');
  const soloId = (await meOf(SO)).player.id;
  const psA = (await api('GET', `/api/players/${soloId}`, null, aliceHasFx02 ? M : A2)).body;
  check(psA.stats.detail === false && findKeys(psA.stats, ['grades', 'streets', 'decisions', 'shares']).length === 0 && psA.stats.played === 1 && psA.stats.average === solo.average, 'a one-hand profile seen by someone who has not played that hand: hands, average and total only, no answers by grade or street');
  const psB = (await api('GET', `/api/players/${soloId}`, null, B2)).body;
  check(psB.stats.detail === false && findKeys(psB.stats, ['grades', 'streets', 'decisions', 'shares']).length === 0, `nor to Bob, who has played it: another player's split is shown from ${S_MIN} hands`);
  check(lbAll.players.find((x) => x.name === 'Solo').shares === null && (await api('GET', '/api/leaderboard', null, SO)).body.players.find((x) => x.name === 'Solo').shares?.best === 100, 'on the leaderboard his row has no split for others, his own view of it does (100% Best)');
  const psS = (await api('GET', `/api/players/${soloId}`, null, SO)).body.stats;
  check(psS.detail === true && psS.decisions === decCount('fx02') && psS.grades.best === decCount('fx02') && psS.shares.best === 100, 'Solo\'s own profile: the exact counts');
  check(pa.body.stats.detail === true, 'Alice\'s profile (6 hands) has the shares for Bob');
  const lbFr = (await api('GET', '/api/leaderboard?scope=friends', null, A2)).body;
  check(lbFr.scope === 'friends' && names(lbFr.players) === 'Alice,Bob' && orderOk(lbFr.players) && lbFr.players.find((x) => x.name === 'Bob').friend === true, 'friends scope: Alice and her friend Bob, ranked among themselves');
  check(names((await api('GET', '/api/leaderboard?scope=friends', null, SO)).body.players) === 'Solo', 'with no friends it is just you');
  const pb = (await api('GET', `/api/players/${bobId}`, null, A2)).body;
  check(pb.rank.everyone.rank === lbAll.players.find((x) => x.id === bobId).rank && pb.rank.everyone.of === lbAll.players.filter((x) => x.rank !== null).length, 'the rank on Bob\'s profile is his leaderboard rank');
  check(pb.rank.friends && pb.rank.friends.rank === lbFr.players.find((x) => x.id === bobId).rank && pb.rank.friends.size === 2, 'and among Alice and her friends, as her friends leaderboard shows it');
  const rankedOne = lbAll.players.find((x) => x.rank !== null);
  const pr = (await api('GET', `/api/players/${rankedOne.id}`, null, SO)).body;
  check(pr.rank.everyone.rank === rankedOne.rank && pr.rank.friends === null, `a ranked player (${rankedOne.name}, #${rankedOne.rank}) seen by a stranger: the overall rank, no friends rank`);

  console.log('\n# friends: limits (handlers on a temporary db)');
  {
    const { createJsonFileStorage } = await import(join(ROOT, 'server', 'lib', 'storage.mjs'));
    const st = createJsonFileStorage(join(tmp, 'limits.json'));
    const ctxL = { storage: st, puzzles: new Map(), usingFixtures: false, now: () => Date.now() };
    const pad = (i) => String(i).padStart(3, '0');
    const N = S_.FRIENDS.maxPending + 2;
    for (let i = 0; i <= N; i++) {
      await st.putPlayer({ id: `pl${pad(i)}`, name: `Pl${pad(i)}`, nameKey: `pl${pad(i)}`, createdAt: 1 });
      await st.putSession({ token: `t${i}`, playerId: `pl${pad(i)}`, createdAt: 1, expiresAt: Date.now() + 1e9 });
    }
    const call = async (fn, req) => { try { return await fn({ params: {}, body: {}, query: {}, ...req }, ctxL); } catch (e) { return { status: e.status || 500, body: { error: e.message } }; } };
    let okN = 0;
    for (let i = 1; i <= S_.FRIENDS.maxPending; i++) if ((await call(S_.requestFriend, { token: 't0', body: { id: `pl${pad(i)}` } })).status === 201) okN++;
    const over = await call(S_.requestFriend, { token: 't0', body: { id: `pl${pad(S_.FRIENDS.maxPending + 1)}` } });
    check(okN === S_.FRIENDS.maxPending && over.status === 409, `${S_.FRIENDS.maxPending} requests waiting is the most: the next one is refused (409)`);
    await call(S_.requestFriend, { token: `t${N}`, body: { id: 'pl000' } });
    const mut = await call(S_.requestFriend, { token: 't0', body: { id: `pl${pad(N)}` } });
    check(mut.status === 200 && mut.body.relation === 'friend', 'answering a request with one of your own still works at the limit');
    const sx = await call(S_.searchPlayers, { token: 't0', query: { q: 'pl' } });
    check(sx.body.players.length === S_.FRIENDS.searchMax && sx.body.players[0].relation === 'you', `a search lists at most ${S_.FRIENDS.searchMax}`);
    await st.putPlayer({ id: 'cap', name: 'Cap', nameKey: 'cap', createdAt: 1 });
    await st.putSession({ token: 'tcap', playerId: 'cap', createdAt: 1, expiresAt: Date.now() + 1e9 });
    for (let k = 0; k < S_.FRIENDS.maxFriends; k++) await st.putFriendLink({ from: 'cap', to: `zz${k}`, status: 'friends', createdAt: 1, acceptedAt: 1 });
    const capIn = await call(S_.requestFriend, { token: 't1', body: { id: 'cap' } });
    const capOut = await call(S_.requestFriend, { token: 'tcap', body: { id: 'pl002' } });
    check(capIn.status === 409 && capOut.status === 409, `${S_.FRIENDS.maxFriends} friends is the most, both ways`);
    await st.close();
  }

  console.log('\n# reset-player removes friendships and requests');
  {
    const Z = await login('Zed', '9090');
    const zedId = (await meOf(Z)).player.id;
    await askF(Z, { name: 'Alice' }); await fAct(A2, zedId, 'accept');
    await askF(Z, { name: 'Bob' });
    await askF(C, { name: 'Zed' });
    check(names((await friendsOf(A2)).friends).includes('Zed') && names((await friendsOf(B2)).incoming).includes('Zed') && names((await friendsOf(C)).outgoing).includes('Zed'), 'Zed: a friend of Alice, a request to Bob, one from Carol');
    const out = execFileSync(process.execPath, [join(ROOT, 'server', 'tools', 'reset-player.mjs'), 'Zed'], { env: { ...process.env, DB_FILE: env.DB_FILE } }).toString();
    check(/1 friendship\(s\), 2 friend request\(s\)/.test(out), `the tool reports them (${out.trim()})`);
    check(!names((await friendsOf(A2)).friends).includes('Zed') && !names((await friendsOf(B2)).incoming).includes('Zed') && !names((await friendsOf(C)).outgoing).includes('Zed'), 'gone from every list');
    const dbNow = JSON.parse(readFileSync(env.DB_FILE, 'utf8'));
    check(!Object.values(dbNow.friends || {}).some((l) => l.from === zedId || l.to === zedId) && !dbNow.players[zedId], 'and from the db file');
    check((await api('GET', '/api/me', null, Z)).status === 401, 'Zed\'s session is gone');
  }

  // ===================================================================
  // Tournament: push/fold drill, quiz, charts (server/lib/tournament.mjs, web/js/pushfold.js).
  console.log('\n# tournament: sign-in, menu, spot data');
  {
    const P = await import(join(ROOT, 'web', 'js', 'pushfold.js'));
    const spotFile = (name) => P.normalizeSpot(JSON.parse(readFileSync(join(TDIR, 'spots', `${name}.json`), 'utf8')));
    const quizFile = JSON.parse(readFileSync(join(TDIR, 'quiz.json'), 'utf8'));
    const SECRET = ['freq', 'ev_fold', 'ev_allin', 'ev_diff', 'ev_diff_se', 'class_reach', 'allin_pct', 'reach', 'verdict', 'facts', 'jammer'];
    const secretKeys = (obj) => findKeys(obj, SECRET);
    async function raw(path, token, headers = {}) {
      const r = await fetch(BASE + path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
      return { status: r.status, headers: r.headers, text: await r.text() };
    }
    for (const [m, p] of [['GET', '/api/tournament'], ['GET', '/api/tournament/spots/chips-n6-10bb'], ['GET', '/api/tournament/drill/next'], ['POST', '/api/tournament/drill/answer'],
      ['POST', '/api/tournament/quiz/hu/next'], ['POST', '/api/tournament/quiz/hu/answer'], ['GET', '/api/tournament/quiz/hu/summary'], ['GET', '/api/tournament/quiz/questions/tq01/others'], ['GET', '/api/tournament/quiz/ranking']]) {
      check((await api(m, p, m === 'POST' ? {} : null)).status === 401, `${m} ${p} needs a session`);
    }
    const tlogin = async (name, pin) => { const r = await api('POST', '/api/login', { name, pin }); return { token: r.body.token, id: r.body.player.id }; };
    const tina = await tlogin('Tina', '7101'), tom = await tlogin('Tom', '7102'), tara = await tlogin('Tara', '7103');
    await api('POST', '/api/friends/request', { name: 'Tom' }, tina.token);
    await api('POST', `/api/friends/${tina.id}/accept`, {}, tom.token);

    const menu = await api('GET', '/api/tournament', null, tina.token);
    check(menu.status === 200 && menu.body.installed === true && menu.body.spots.length === 75, `menu: installed, 75 spots (${menu.body.spots?.length})`);
    check(secretKeys(menu.body.spots).length === 0 && menu.body.spots.every((s) => s.seats && s.stacks && s.posted && s.units && typeof s.scale === 'number' && s.asked), 'menu spots: seats, stacks, forced bets, units, scale; no solver output');
    check(menu.body.quiz.length === 5 && menu.body.quiz.every((s) => s.count === 10 && s.answered === 0 && s.finished === false && s.right === null), 'menu: five quiz sets of 10, none started');
    check(menu.body.drill.hands === 0 && menu.body.drill.right === 0, 'menu: drill totals start at 0');
    const mg = await raw('/api/tournament', tina.token, { 'Accept-Encoding': 'gzip' });
    check(mg.status === 200 && mg.headers.get('content-encoding') === 'gzip', 'menu is gzipped when the client accepts it');

    const sd = await raw('/api/tournament/spots/chips-n6-10bb', tina.token, { 'Accept-Encoding': 'gzip' });
    const etag = sd.headers.get('etag');
    const sj = JSON.parse(sd.text);
    check(sd.status === 200 && sd.headers.get('content-encoding') === 'gzip' && !!etag && /no-cache/.test(sd.headers.get('cache-control') || ''), `spot data: gzip, an ETag (${etag}), revalidated`);
    const dec3 = (x) => x === null || Math.round(x * 1000) / 1000 === x, dec4 = (x) => x === null || Math.round(x * 10000) / 10000 === x;
    check(sj.decisions.length === 62 && sj.decisions.every((d) => ['freq', 'ev_fold', 'ev_allin', 'ev_diff', 'ev_diff_se'].every((k) => d[k].length === 169) && d.freq.every(dec3) && d.ev_fold.every(dec4) && d.ev_allin.every(dec4) && d.ev_diff.every(dec4) && d.ev_diff_se.every(dec4) && typeof d.askable === 'boolean'), 'spot data: 62 decisions, 169 classes each, frequencies 3 decimals, EVs 4');
    check(!('samples' in sj.decisions[0]) && !('class_reach' in sj.decisions[0]), 'spot data: no samples or class_reach (not needed by the charts)');
    const s304 = await raw('/api/tournament/spots/chips-n6-10bb', tina.token, { 'If-None-Match': etag });
    check(s304.status === 304 && s304.text === '', 'spot data: 304 with the same ETag');
    check((await raw('/api/tournament/spots/chips-n6-10bb', null, { 'If-None-Match': etag })).status === 401, 'spot data: no 304 without a session');
    check((await api('GET', '/api/tournament/spots/nope', null, tina.token)).status === 404, 'unknown spot: 404');
    const ref = spotFile('chips-n6-10bb');
    const bbco = sj.decisions.find((d) => d.id === 'BB_vs_CO'), refd = P.decisionById(ref, 'BB_vs_CO');
    check(JSON.stringify(bbco.ev_diff) === JSON.stringify(refd.ev_diff) && JSON.stringify(bbco.freq) === JSON.stringify(refd.freq), 'spot data: the numbers of the file');

    console.log('\n# tournament: the drill');
    const q1 = await api('GET', '/api/tournament/drill/next?value=chips&players=6&stack=10&seat=BB&kind=call&hands=close', null, tina.token);
    check(q1.status === 200 && q1.body.question.spot.name === 'chips-n6-10bb' && q1.body.question.decision.seat === 'BB' && q1.body.question.decision.facing.length === 1, 'drill next: a BB call at 6 players, 10 bb');
    check(secretKeys(q1.body).length === 0, `drill question: nothing the solver says (${secretKeys(q1.body)})`);
    const qd = P.decisionById(ref, q1.body.question.decision.id), qc = P.classIndex(q1.body.question.hand.class);
    check(Math.abs(qd.ev_diff[qc]) <= 0.5 + 1e-9 && P.classOfCards(q1.body.question.hand.cards) === q1.body.question.hand.class, 'drill question: a close hand, cards of its class');
    let last = q1.body.question.hand.class, repeated = 0;
    for (let i = 0; i < 25; i++) {
      const q = await api('GET', `/api/tournament/drill/next?value=chips&players=2&stack=4&hands=close&avoid=${last}`, null, tina.token);
      if (q.body.question.hand.class === last) repeated++;
      last = q.body.question.hand.class;
    }
    check(repeated === 0, 'drill next: never the class just dealt (avoid)');
    check((await api('GET', '/api/tournament/drill/next?kind=open&seat=BB', null, tina.token)).status === 404, 'drill next: no hands for these choices: 404');
    const wrongAction = qd.ev_diff[qc] > 0 ? 'fold' : 'allin';
    const a1 = await api('POST', '/api/tournament/drill/answer', { spot: 'chips-n6-10bb', decision: qd.id, class: P.CLASSES[qc], cards: q1.body.question.hand.cards, action: wrongAction }, tina.token);
    const want = P.verdict(ref, qd, qc, wrongAction);
    check(a1.status === 200 && a1.body.feedback.verdict.grade === want.grade && a1.body.feedback.verdict.right === want.right && a1.body.feedback.verdict.cost === want.cost, `drill answer: graded by the server's data like the shared rules (${want.grade})`);
    check(JSON.stringify(a1.body.feedback.facts) === JSON.stringify(P.facts(ref, qd, qc).map(({ key, text }) => ({ key, text }))) && a1.body.feedback.jammer?.seat === qd.facing[0] && a1.body.feedback.decision.freq.length === 169, 'drill answer: the facts, this decision and the jammer\'s range');
    check(a1.body.totals.hands === 1 && a1.body.totals.right === (want.right ? 1 : 0) && a1.body.totals.kinds.call.hands === 1 && a1.body.totals.values.chips.hands === 1, 'drill totals: one hand, by kind and by value');
    const pq = P.sampleQuestion([spotFile('points-n4-co25-btn9-sb6-bb10')], { value: 'points', players: 4 }, () => 0.37, null);
    const a2 = await api('POST', '/api/tournament/drill/answer', { spot: pq.spot.name, decision: pq.decision.id, class: P.CLASSES[pq.c], cards: pq.cards, action: 'allin' }, tina.token);
    const wantP = P.verdict(pq.spot, pq.decision, pq.c, 'allin');
    check(a2.status === 200 && a2.body.totals.hands === 2 && a2.body.totals.values.points.hands === 1 && Math.abs(a2.body.totals.values.points.cost - wantP.cost) < 1e-9 && a2.body.feedback.facts.some((f) => f.key === 'units'), 'drill: a points hand counts under points, its cost in points');
    check((await api('POST', '/api/tournament/drill/answer', { spot: 'chips-n6-10bb', decision: 'BB_vs_CO_BTN', class: 'AA', action: 'allin' }, tina.token)).status === 400, 'drill answer: a multi-way decision is refused (400)');
    check((await api('POST', '/api/tournament/drill/answer', { spot: 'chips-n6-10bb', decision: 'BB_vs_CO', class: 'XX', action: 'allin' }, tina.token)).status === 400, 'drill answer: bad class (400)');
    check((await api('POST', '/api/tournament/drill/answer', { spot: 'chips-n6-10bb', decision: 'BB_vs_CO', class: 'AA', action: 'raise' }, tina.token)).status === 400, 'drill answer: bad action (400)');
    check((await api('GET', '/api/tournament', null, tina.token)).body.drill.hands === 2, 'drill totals kept on the server');
    const dbNow = JSON.parse(readFileSync(env.DB_FILE, 'utf8'));
    check(dbNow.tournamentDrill[tina.id]?.hands === 2 && !JSON.stringify(dbNow.tournamentDrill).includes('BB_vs_CO'), 'the db keeps only totals per player (no single answers)');

    console.log('\n# tournament: the quiz');
    const hu = quizFile.sets.find((s) => s.id === 'hu');
    const spots = new Map();
    const expected = hu.questions.map((q) => {
      if (!spots.has(q.spot)) spots.set(q.spot, spotFile(q.spot));
      const r = P.checkQuizQuestion((n) => spots.get(n), q);
      return r.best;
    });
    const n0 = await api('POST', '/api/tournament/quiz/hu/next', {}, tina.token);
    check(n0.status === 200 && n0.body.index === 0 && n0.body.question.id === 'tq01' && n0.body.count === 10 && typeof n0.body.shownAt === 'number', 'quiz next: question 1 of 10, stamped when shown');
    check(secretKeys(n0.body).length === 0, `quiz question: nothing about the answer before it is answered (${secretKeys(n0.body)})`);
    check(P.classOfCards(n0.body.question.hand.cards) === hu.questions[0].class && n0.body.question.hand.cards.join() === hu.questions[0].cards.join(), 'quiz question: the cards of quiz.json');
    await sleep(30);
    const n0b = await api('POST', '/api/tournament/quiz/hu/next', {}, tina.token);
    check(n0b.body.question.id === 'tq01' && n0b.body.shownAt === n0.body.shownAt, 'asking again gives the same question, first shown stays');
    check((await api('POST', '/api/tournament/quiz/hu/answer', { question: 'tq02', action: 'fold' }, tina.token)).status === 409, 'only the next unanswered question can be answered (409)');
    check((await api('POST', '/api/tournament/quiz/hu/answer', { question: 'tq99', action: 'fold' }, tina.token)).status === 404, 'unknown question: 404');
    check((await api('POST', '/api/tournament/quiz/nope/next', {}, tina.token)).status === 404, 'unknown set: 404');
    check((await api('GET', '/api/tournament/quiz/questions/tq01/others', null, tina.token)).status === 403, 'others: 403 before you have answered');
    const wrong0 = expected[0] === 'allin' ? 'fold' : 'allin';
    const ans0 = await api('POST', '/api/tournament/quiz/hu/answer', { question: 'tq01', action: wrong0 }, tina.token);
    check(ans0.status === 200 && ans0.body.feedback.verdict.right === false && ans0.body.index === 0 && ans0.body.done === false, 'a wrong answer is graded wrong');
    check(ans0.body.feedback.decision.ev_diff.length === 169 && ans0.body.feedback.facts.length > 0 && ans0.body.others.total === 0, 'the answer brings the feedback; nobody else has answered yet');
    const again = await api('POST', '/api/tournament/quiz/hu/answer', { question: 'tq01', action: expected[0] }, tina.token);
    check(again.status === 200 && again.body.alreadyAnswered && again.body.feedback.action === wrong0 && again.body.feedback.verdict.right === false, 'the first answer counts and cannot be changed');
    const n1 = await api('POST', '/api/tournament/quiz/hu/next', {}, tina.token);
    check(n1.body.index === 1 && n1.body.question.id === 'tq02' && secretKeys(n1.body).length === 0, 'next: question 2, nothing about its answer');
    for (let i = 1; i < 10; i++) {
      const r = await api('POST', '/api/tournament/quiz/hu/answer', { question: hu.questions[i].id, action: expected[i] }, tina.token);
      if (!(r.status === 200 && r.body.feedback.verdict.right === true && r.body.done === (i === 9))) check(false, `question ${i + 1} answered right (${r.status} ${JSON.stringify(r.body).slice(0, 120)})`);
      else passed++;
      if (i < 9) await api('POST', '/api/tournament/quiz/hu/next', {}, tina.token);
    }
    const done = await api('POST', '/api/tournament/quiz/hu/next', {}, tina.token);
    check(done.body.done === true && done.body.question === null, 'after the 10th: done');
    const sum = await api('GET', '/api/tournament/quiz/hu/summary', null, tina.token);
    check(sum.status === 200 && sum.body.finished && sum.body.answers.length === 10 && sum.body.right === 9 && sum.body.answers[0].right === false && sum.body.answers.every((a) => a.feedback && a.timeMs >= 0) && sum.body.timeMs >= 0, `summary: 9 of 10 right, every question reviewable (${sum.body.right})`);
    check(sum.body.answers[0].timeMs >= 25, `the time from first shown to the answer is recorded (${sum.body.answers[0].timeMs} ms)`);
    const m2 = await api('GET', '/api/tournament', null, tina.token);
    check(m2.body.quiz.find((s) => s.id === 'hu').right === 9 && m2.body.quiz.find((s) => s.id === 'hu').finished, 'menu: the set shows 9 of 10 right');

    // Tom (Tina's friend) and Tara answer question 1
    await api('POST', '/api/tournament/quiz/hu/next', {}, tom.token);
    const tomA = await api('POST', '/api/tournament/quiz/hu/answer', { question: 'tq01', action: expected[0] }, tom.token);
    check(tomA.body.others.total === 1 && tomA.body.others.others[0].player.name === 'Tina' && tomA.body.others.others[0].right === false && tomA.body.others.others[0].friend === true, 'Tom sees Tina (a friend) got question 1 wrong');
    await api('POST', '/api/tournament/quiz/hu/next', {}, tara.token);
    const taraA = await api('POST', '/api/tournament/quiz/hu/answer', { question: 'tq01', action: expected[0] }, tara.token);
    check(taraA.body.others.total === 2 && taraA.body.others.right === 1 && taraA.body.others.others.every((o) => o.friend === false), 'Tara sees both, nobody her friend');
    const othT = await api('GET', '/api/tournament/quiz/questions/tq01/others', null, tina.token);
    check(othT.status === 200 && othT.body.others[0].player.name === 'Tom' && othT.body.others[0].friend && othT.body.total === 2, 'Tina: friends first (Tom), then the others');
    check((await api('GET', '/api/tournament/quiz/questions/tq02/others', null, tom.token)).status === 403, 'Tom has not answered question 2: 403');
    check(secretKeys(othT.body.others).length === 0 && !JSON.stringify(othT.body).includes('"action"'), 'others: a tick or a cross, not more');

    console.log('\n# tournament: ranking and profiles');
    let rk = await api('GET', '/api/tournament/quiz/ranking', null, tom.token);
    check(rk.status === 200 && rk.body.players.length === 1 && rk.body.players[0].name === 'Tina' && rk.body.players[0].rank === 1 && rk.body.players[0].right === 9 && rk.body.players[0].sets === 1 && rk.body.ranked === false, 'ranking: only players with a finished set (Tina 9, set 1); Tom not ranked yet');
    for (let i = 1; i < 10; i++) {
      await api('POST', '/api/tournament/quiz/hu/next', {}, tom.token);
      await api('POST', '/api/tournament/quiz/hu/answer', { question: hu.questions[i].id, action: i === 4 ? (expected[i] === 'allin' ? 'fold' : 'allin') : expected[i] }, tom.token);
    }
    rk = await api('GET', '/api/tournament/quiz/ranking', null, tara.token);
    check(rk.body.players.length === 2 && rk.body.players.every((p) => p.rank === 1 && p.right === 9), 'equal right answers share a place (1, 1)');
    const rkF = await api('GET', '/api/tournament/quiz/ranking?scope=friends', null, tara.token);
    check(rkF.body.scope === 'friends' && rkF.body.players.length === 0, 'friends scope: Tara has no friends who finished a set');
    const rkTF = await api('GET', '/api/tournament/quiz/ranking?scope=friends', null, tina.token);
    check(rkTF.body.players.length === 2 && rkTF.body.ranked === true, 'friends scope: Tina and her friend Tom');
    const pOwn = await api('GET', `/api/players/${tina.id}`, null, tina.token);
    check(pOwn.body.tournament && pOwn.body.tournament.sets.length === 1 && pOwn.body.tournament.sets[0].right === 9 && pOwn.body.tournament.drill?.hands === 2, 'own profile: the finished set and the drill totals');
    const pOther = await api('GET', `/api/players/${tina.id}`, null, tara.token);
    check(pOther.body.tournament && pOther.body.tournament.sets.length === 1 && !('drill' in pOther.body.tournament), "another player's profile: finished sets only, no drill totals");
    const pTara = await api('GET', `/api/players/${tara.id}`, null, tina.token);
    check(pTara.body.tournament.sets.length === 0, 'a set in progress is not shown to others');
    check((await api('GET', `/api/players/${tara.id}`, null, tara.token)).body.tournament.sets.some((s) => !s.finished && s.answered === 1), 'your own set in progress is on your own profile');

    console.log('\n# tournament: reset-player removes tournament data');
    const zz = await tlogin('Zora', '7104');
    await api('POST', '/api/tournament/drill/answer', { spot: 'chips-n6-10bb', decision: 'BB_vs_CO', class: 'AA', action: 'allin' }, zz.token);
    await api('POST', '/api/tournament/quiz/hu/next', {}, zz.token);
    await api('POST', '/api/tournament/quiz/hu/answer', { question: 'tq01', action: 'fold' }, zz.token);
    const outZ = execFileSync(process.execPath, [join(ROOT, 'server', 'tools', 'reset-player.mjs'), 'Zora'], { env: { ...process.env, DB_FILE: env.DB_FILE } }).toString();
    const dbZ = JSON.parse(readFileSync(env.DB_FILE, 'utf8'));
    check(/1 drill hand\(s\), 1 quiz set\(s\)/.test(outZ) && !dbZ.tournamentDrill[zz.id] && !Object.values(dbZ.tournamentQuiz).some((q) => q.playerId === zz.id), `reset-player removes the drill totals and the quiz answers (${outZ.trim()})`);
    check((await api('GET', '/api/tournament/quiz/questions/tq01/others', null, tina.token)).body.total === 2, 'and they are gone from "others"');
  }

  console.log('\n# tournament: without the data directory');
  {
    const port3 = await new Promise((res) => { const s3 = net.createServer(); s3.listen(0, () => { const p = s3.address().port; s3.close(() => res(p)); }); });
    const srv3 = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], { env: { ...env, PORT: String(port3), DB_FILE: join(tmp, 'db-notour.json'), TOURNAMENT_DIR: join(tmp, 'no-such-dir') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out3 = '';
    srv3.stdout.on('data', (d) => { out3 += d; });
    srv3.stderr.on('data', (d) => { out3 += d; });
    try {
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('server without tournament data did not start:\n' + out3)), 8000);
        const iv = setInterval(() => { if (out3.includes('listening')) { clearInterval(iv); clearTimeout(t); res(); } }, 50);
      });
      check(/Tournament data not installed/.test(out3), 'the server starts and says the data is not installed');
      const call3 = async (method, path, body, token) => {
        const r = await fetch(`http://127.0.0.1:${port3}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      const tk = (await call3('POST', '/api/login', { name: 'Nadia', pin: '7201' })).body.token;
      const m3 = await call3('GET', '/api/tournament', null, tk);
      check(m3.status === 200 && m3.body.installed === false, 'menu: installed false');
      check((await call3('GET', '/api/tournament/spots/chips-n6-10bb', null, tk)).status === 503 && (await call3('GET', '/api/tournament/drill/next', null, tk)).status === 503 && (await call3('POST', '/api/tournament/quiz/hu/next', {}, tk)).status === 503, 'the other endpoints: 503');
      check((await call3('GET', '/api/puzzles', null, tk)).status === 200, 'the rest of the site works');
      const me3 = (await call3('GET', '/api/me', null, tk)).body.player.id;
      check((await call3('GET', `/api/players/${me3}`, null, tk)).body.tournament === null, 'profile: no tournament block');
    } finally { srv3.kill('SIGTERM'); }
  }

  console.log('\n# tournament: the start-up check of quiz.json');
  {
    // Copies of the heads-up spots with a quiz.json whose question 1 is a close hand and question 2 names no spot
    // (the questions of the other sets have no spots here either: they are left out with a warning).
    const P = await import(join(ROOT, 'web', 'js', 'pushfold.js'));
    const qdir = join(tmp, 'tournament-badquiz');
    mkdirSync(join(qdir, 'spots'), { recursive: true });
    for (const f of readdirSync(join(TDIR, 'spots')).filter((x) => x.startsWith('chips-n2-'))) cpSync(join(TDIR, 'spots', f), join(qdir, 'spots', f));
    const quiz = JSON.parse(readFileSync(join(TDIR, 'quiz.json'), 'utf8'));
    const s9 = P.normalizeSpot(JSON.parse(readFileSync(join(TDIR, 'spots', 'chips-n2-9bb.json'), 'utf8')));
    const open9 = P.decisionById(s9, 'SB_open');
    const closeC = P.CLASSES.findIndex((_, c) => P.verdict(s9, open9, c, 'fold').close);
    quiz.sets[0].questions[0] = { ...quiz.sets[0].questions[0], class: P.CLASSES[closeC], cards: P.cardsForClass(P.CLASSES[closeC], () => 0.3) };
    quiz.sets[0].questions[1] = { ...quiz.sets[0].questions[1], spot: 'no-such-spot' };
    writeFileSync(join(qdir, 'quiz.json'), JSON.stringify(quiz));
    const port4 = await new Promise((res) => { const s4 = net.createServer(); s4.listen(0, () => { const p = s4.address().port; s4.close(() => res(p)); }); });
    const srv4 = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], { env: { ...env, PORT: String(port4), DB_FILE: join(tmp, 'db-badquiz.json'), TOURNAMENT_DIR: qdir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out4 = '';
    srv4.stdout.on('data', (d) => { out4 += d; });
    srv4.stderr.on('data', (d) => { out4 += d; });
    try {
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('server with a bad quiz did not start:\n' + out4)), 8000);
        const iv = setInterval(() => { if (out4.includes('listening')) { clearInterval(iv); clearTimeout(t); res(); } }, 50);
      });
      check(/WARNING tournament: quiz question tq01 \(chips-n2-9bb SB_open \w+\): .*too close to call.*graded as close/.test(out4), 'a close question is logged with a clear warning: graded as close');
      check(/WARNING tournament: quiz question tq02 \(no-such-spot .*\): .*not loaded.*left out/.test(out4), 'a question without its spot is logged and left out');
      const call4 = async (method, path, body, token) => {
        const r = await fetch(`http://127.0.0.1:${port4}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      const t1 = (await call4('POST', '/api/login', { name: 'Quinn', pin: '7301' })).body.token;
      const t2 = (await call4('POST', '/api/login', { name: 'Quill', pin: '7302' })).body.token;
      const m4 = await call4('GET', '/api/tournament', null, t1);
      check(m4.body.quiz.find((s) => s.id === 'hu').count === 9, 'the set has 9 questions left');
      await call4('POST', '/api/tournament/quiz/hu/next', {}, t1); await call4('POST', '/api/tournament/quiz/hu/next', {}, t2);
      const f1 = await call4('POST', '/api/tournament/quiz/hu/answer', { question: 'tq01', action: 'fold' }, t1);
      const f2 = await call4('POST', '/api/tournament/quiz/hu/answer', { question: 'tq01', action: 'allin' }, t2);
      check(f1.body.feedback.verdict.right && f2.body.feedback.verdict.right && f1.body.feedback.verdict.grade === 'correct' && f2.body.feedback.verdict.grade === 'correct', 'both answers count as right (Correct)');
      check((await call4('POST', '/api/tournament/quiz/hu/next', {}, t1)).body.question.id === 'tq03', 'the next question is the one after the dropped one');
    } finally { srv4.kill('SIGTERM'); }
  }

  console.log('\n# PIN lock');
  for (let i = 0; i < 4; i++) await api('POST', '/api/login', { name: 'Bob', pin: '0000' });
  const locked = await api('POST', '/api/login', { name: 'Bob', pin: '0000' });
  const lockedGood = await api('POST', '/api/login', { name: 'Bob', pin: '5678' });
  check(locked.status === 401 && lockedGood.status === 429, 'five wrong PINs lock the name, even the right PIN waits');
  check((await api('GET', '/api/puzzles', null, B)).status === 200, 'existing session still works');
} catch (e) {
  failed++;
  console.error(e);
} finally {
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
