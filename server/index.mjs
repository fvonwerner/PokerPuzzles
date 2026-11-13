#!/usr/bin/env node
// PokerPuzzles server: serves web/ and the JSON API. Zero dependencies.
//   PORT (4455)  SOLUTIONS_DIR (data/solutions)  EXPLANATIONS_DIR (data/explanations)
//   DB_FILE (server/data/db.json)  RESCAN_MS (3000: how often puzzle folders are re-checked)
//   TOURNAMENT_DIR (data/tournament: the solved push/fold spots and quiz.json, read at start-up)
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPuzzleRegistry } from './lib/puzzles.mjs';
import { createJsonFileStorage } from './lib/storage.mjs';
import * as H from './lib/handlers.mjs';
import * as B from './lib/battles.mjs';
import * as S from './lib/social.mjs';
import * as T from './lib/tournament.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 4455);
const DB_FILE = resolve(ROOT, process.env.DB_FILE || 'server/data/db.json');

const registry = createPuzzleRegistry({ root: ROOT });
const storage = createJsonFileStorage(DB_FILE);
const tournament = T.loadTournament({ root: ROOT });
// Handlers see the current puzzle set; the registry re-scans the folders at most every RESCAN_MS.
// TEST_CLOCK=1 (tests only) adds POST /api/test/clock {advanceMs} to move the server's clock forward.
let clockOffset = 0;
const ctx = {
  storage,
  tournament,
  get puzzles() { return registry.puzzles; },
  get usingFixtures() { return registry.usingFixtures; },
  now: () => Date.now() + clockOffset,
};

const routes = [
  ['POST', /^\/api\/login$/, H.login],
  ['POST', /^\/api\/logout$/, H.logout],
  ['GET', /^\/api\/me$/, H.me],
  ['GET', /^\/api\/puzzles$/, H.listPuzzles],
  ['POST', /^\/api\/puzzles\/([\w-]+)\/start$/, H.startPuzzle],
  ['POST', /^\/api\/puzzles\/([\w-]+)\/act$/, H.act],
  ['GET', /^\/api\/puzzles\/([\w-]+)\/review$/, H.review],
  ['GET', /^\/api\/puzzles\/([\w-]+)\/others$/, S.others],
  ['GET', /^\/api\/leaderboard$/, S.leaderboard],
  // Friends, finding players, profiles.
  ['GET', /^\/api\/players$/, S.searchPlayers],
  ['GET', /^\/api\/players\/([\w-]+)$/, S.profile],
  ['GET', /^\/api\/players\/([\w-]+)\/hands$/, S.profileHands],
  ['GET', /^\/api\/friends$/, S.friendsList],
  ['POST', /^\/api\/friends\/request$/, S.requestFriend],
  ['POST', /^\/api\/friends\/([\w-]+)\/accept$/, S.acceptFriend],
  ['POST', /^\/api\/friends\/([\w-]+)\/decline$/, S.declineFriend],
  ['POST', /^\/api\/friends\/([\w-]+)\/cancel$/, S.cancelFriend],
  ['POST', /^\/api\/friends\/([\w-]+)\/remove$/, S.removeFriend],
  // Battle reads may end a battle whose puzzle files changed, so they run serialized too.
  ['GET', /^\/api\/battles$/, B.listBattles, { serialized: true }],
  ['POST', /^\/api\/battles$/, B.createBattle],
  ['POST', /^\/api\/battles\/join$/, B.joinByCode],
  ['GET', /^\/api\/battles\/([\w-]+)$/, B.getBattle, { serialized: true }],
  ['POST', /^\/api\/battles\/([\w-]+)\/join$/, B.joinById],
  ['POST', /^\/api\/battles\/([\w-]+)\/cancel$/, B.cancelBattle],
  ['POST', /^\/api\/battles\/([\w-]+)\/rematch$/, B.rematch],
  ['POST', /^\/api\/battles\/([\w-]+)\/start$/, B.startHand],
  ['POST', /^\/api\/battles\/([\w-]+)\/act$/, B.actHand],
  ['POST', /^\/api\/battles\/([\w-]+)\/ready$/, B.readyBattle],
  ['POST', /^\/api\/battles\/([\w-]+)\/begin$/, B.beginBattle],
  // Tournament: push/fold drill, quiz, charts (server/lib/tournament.mjs, docs/SPEC.md section 6).
  ['GET', /^\/api\/tournament$/, T.menu],
  ['GET', /^\/api\/tournament\/spots\/([\w-]+)$/, T.spotData],
  ['GET', /^\/api\/tournament\/drill\/next$/, T.drillNext],
  ['POST', /^\/api\/tournament\/drill\/answer$/, T.drillAnswer],
  ['GET', /^\/api\/tournament\/quiz\/ranking$/, T.quizRanking],
  ['GET', /^\/api\/tournament\/quiz\/questions\/([\w-]+)\/others$/, T.quizOthers],
  ['POST', /^\/api\/tournament\/quiz\/([\w-]+)\/next$/, T.quizNext],
  ['POST', /^\/api\/tournament\/quiz\/([\w-]+)\/answer$/, T.quizAnswer],
  ['GET', /^\/api\/tournament\/quiz\/([\w-]+)\/summary$/, T.quizSummary],
];
if (process.env.TEST_CLOCK === '1') {
  routes.push(['POST', /^\/api\/test\/clock$/, async (req) => {
    clockOffset += Math.max(0, Number(req.body?.advanceMs) || 0);
    return { status: 200, body: { now: ctx.now(), offset: clockOffset } };
  }]);
}

// Mutating requests run one at a time so read-modify-write in handlers is safe.
let lock = Promise.resolve();
function serialized(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

const acceptsGzip = (req) => /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
/**
 * A handler's result. Besides { status, body } a handler may return `raw` (the
 * JSON text) with `gz` (its gzip), `compress: true` (gzip when the client
 * accepts it) and `etag` (304 when the client has it already; then the browser
 * keeps it but asks again each time).
 */
function sendOut(req, res, out) {
  const headers = {};
  if (out.etag) {
    Object.assign(headers, { ETag: out.etag, 'Cache-Control': 'private, no-cache', Vary: 'Accept-Encoding' });
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && inm.split(/\s*,\s*/).includes(out.etag)) {
      res.writeHead(304, { ...headers, 'X-Content-Type-Options': 'nosniff' });
      return res.end();
    }
  }
  const text = out.raw ?? JSON.stringify(out.body);
  if ((out.gz || out.compress) && acceptsGzip(req) && text.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    return send(res, out.status, out.gz || gzipSync(text), headers);
  }
  return send(res, out.status, text, headers);
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new H.HttpError(413, 'Body too large.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new H.HttpError(400, 'Invalid JSON.'); }
}

async function handleApi(req, res, url) {
  try { registry.refresh(); } catch (e) { console.error('puzzle re-scan failed:', e.message); }
  let pathMatched = false;
  for (const [method, re, fn, opts] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    pathMatched = true;
    if (req.method !== method) continue; // the same path may have a route for another method
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    const body = method === 'POST' ? await readBody(req) : {};
    const request = { params: { id: m[1] }, body, token, query: Object.fromEntries(url.searchParams) };
    const exec = () => fn(request, ctx);
    const out = method === 'GET' && !opts?.serialized ? await exec() : await serialized(exec);
    return sendOut(req, res, out);
  }
  if (pathMatched) return send(res, 405, { error: 'Method not allowed.' });
  send(res, 404, { error: 'Not found.' });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Bad path.' }); }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(WEB, '.' + path);
  if (file !== WEB && !file.startsWith(WEB + sep)) return send(res, 403, { error: 'Forbidden.' });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof H.HttpError) send(res, e.status, { error: e.message, ...e.extra });
    else { console.error(e); send(res, 500, { error: 'Server error.' }); }
  }
});

server.listen(PORT, () => {
  console.log(`PokerPuzzles listening on http://localhost:${PORT}  (db: ${DB_FILE})`);
  if (registry.usingFixtures) console.log('NOTE: serving fixture puzzles with fake numbers.');
});

async function shutdown() {
  server.close();
  await storage.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
