#!/usr/bin/env node
// End-to-end API test. Starts the server on a spare port with a temporary db
// and the fixture puzzles, plays through the API as two players and asserts
// the rules. No dependencies.
//
//   node server/tools/make-fixture.mjs && node server/tools/smoke.mjs
import { spawn } from 'node:child_process';
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
const env = {
  ...process.env, PORT: String(port), DB_FILE: join(tmp, 'db.json'),
  SOLUTIONS_DIR: SOL, EXPLANATIONS_DIR: EXP, RESCAN_MS: String(RESCAN_MS), TEST_CLOCK: '1',
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
  check(rows.Bob.grades.best === 3 && rows.Bob.grades.correct === 3 && rows.Bob.grades.wrong === 1 && rows.Bob.grades.blunder === 1 && rows.Bob.decisions === 8, 'Bob grade counts add up (3 best, 3 correct, 1 wrong, 1 blunder)');
  check(Object.values(rows.Alice.grades).reduce((x, y) => x + y, 0) === 7, 'Alice grade counts add up to 7 decisions');
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
      check(lbP.find((x) => x.name === 'Olga').played === 0 && lbP.find((x) => x.name === 'Olga').decisions === 0 && lbP.find((x) => x.name === 'Pete').played === 1, 'the leaderboard leaves it out (played, totals, grades)');
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
      await sleep(300);
      const saved = JSON.parse(readFileSync(db2, 'utf8'));
      check(!('inviteId' in saved.battles.ob3) && !saved.battles.ob4.players.includes(null) && saved.battles.ob4.size === 2, 'records written back are in the new format');
      check(saved.battles.ob1.players.join() === 'olga,pete' && !saved.battles.ob1.live, 'untouched records stay as they were');
    } finally { srv2.kill('SIGTERM'); }
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
