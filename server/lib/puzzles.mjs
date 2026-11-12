// Loads solution files (SPEC section 3) and explanation files (section 2.3),
// and keeps them current: `refresh()` re-scans the folders (throttled) and
// re-reads only files whose size or mtime changed. A file that fails to parse
// or validate (for example one that is still being written) is skipped and
// logged once; it is retried when it changes. If a puzzle that was loaded
// becomes unreadable, its last good version stays in service.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gradeDecision } from './grading.mjs';

function jsonFiles(dir) {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  } catch { return []; }
}

export function validate(sol) {
  const problems = [];
  if (!sol || typeof sol !== 'object') return ['not an object'];
  for (const k of ['id', 'title', 'scenario', 'hero', 'villain', 'steps']) if (!(k in sol)) problems.push(`missing ${k}`);
  if (!Array.isArray(sol.steps)) return problems.concat('steps is not an array');
  const decisions = sol.steps.filter((s) => s && s.type === 'decision');
  decisions.forEach((d, i) => {
    if (d.index !== i) problems.push(`decision ${i} has index ${d.index}`);
    if (!Array.isArray(d.options) || !d.hand || !Array.isArray(d.hand.freq) || d.hand.freq.length !== d.options.length) {
      problems.push(`decision ${i}: options / hand.freq mismatch`);
    }
    if (d.source !== 'chart' && (!Array.isArray(d.hand?.ev) || d.hand.ev.length !== d.options?.length)) {
      problems.push(`decision ${i}: solver decision without hand.ev`);
    }
    if (!d.options?.some((o) => o.id === d.mainLine)) problems.push(`decision ${i}: mainLine not among options`);
  });
  if (!decisions.length) problems.push('no decisions');
  if (sol.steps.at(-1)?.type !== 'end') problems.push('last step is not "end"');
  if (typeof sol.decisionCount === 'number' && sol.decisionCount !== decisions.length) {
    problems.push(`decisionCount ${sol.decisionCount} but ${decisions.length} decision steps`);
  }
  return problems;
}

/**
 * createPuzzleRegistry({ root, env, rescanMs, log })
 *   .puzzles        Map<id, { solution, explanations, number, decisionPositions, decisionCount, fingerprint }>
 *   .usingFixtures  boolean
 *   .refresh(force) re-scan if more than rescanMs passed (or force)
 */
export function createPuzzleRegistry({ root, env = process.env, rescanMs = Number(env.RESCAN_MS || 3000), log = console.log }) {
  const defaultSolutions = resolve(root, env.SOLUTIONS_DIR || 'data/solutions');
  const defaultExplanations = resolve(root, env.EXPLANATIONS_DIR || 'data/explanations');
  const fixtureSolutions = resolve(root, 'data/solutions-fixture');
  const fixtureExplanations = resolve(root, 'data/explanations-fixture');

  // path -> { key: "size:mtime", ok, value, fingerprint } ; also remembers what was logged
  const cache = new Map();
  const lastGood = new Map(); // solution path -> last valid entry
  let lastScan = 0;
  let lastSignature = '';
  const state = { puzzles: new Map(), usingFixtures: false, solutionsDir: defaultSolutions, explanationsDir: defaultExplanations };

  function readCached(path, parse) {
    let st;
    try { st = statSync(path); } catch { cache.delete(path); return null; }
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = cache.get(path);
    if (hit && hit.key === key) return hit;
    let entry;
    try {
      const text = readFileSync(path, 'utf8');
      const value = parse(JSON.parse(text));
      entry = { key, ok: true, value, fingerprint: createHash('sha1').update(text).digest('hex').slice(0, 16) };
    } catch (e) {
      entry = { key, ok: false, error: e.message };
      log(`skip ${path}: ${e.message} (will retry when the file changes)`);
    }
    cache.set(path, entry);
    return entry;
  }

  function scan() {
    let solutionsDir = defaultSolutions, explanationsDir = defaultExplanations, usingFixtures = false;
    if (!env.SOLUTIONS_DIR && jsonFiles(defaultSolutions).length === 0) {
      usingFixtures = true;
      solutionsDir = fixtureSolutions;
      if (!env.EXPLANATIONS_DIR) explanationsDir = fixtureExplanations;
    }
    const sFiles = jsonFiles(solutionsDir);
    const eFiles = jsonFiles(explanationsDir);
    // Cheap signature: names + sizes + mtimes of both folders.
    const sig = [solutionsDir, ...sFiles.map((f) => statSig(join(solutionsDir, f))), explanationsDir, ...eFiles.map((f) => statSig(join(explanationsDir, f)))].join('|');
    if (sig === lastSignature) return false;
    lastSignature = sig;
    if (usingFixtures !== state.usingFixtures || solutionsDir !== state.solutionsDir || !state.puzzles.size) {
      if (usingFixtures) log(`No puzzle files in ${defaultSolutions}; serving the FIXTURE puzzles (fake numbers) from ${solutionsDir}.`);
      else log(`Serving puzzles from ${solutionsDir} (explanations: ${explanationsDir}).`);
    }

    const list = [];
    const seen = new Set();
    for (const f of sFiles) {
      const path = join(solutionsDir, f);
      const entry = readCached(path, (sol) => {
        const problems = validate(sol);
        if (problems.length) throw new Error(problems.join('; '));
        return sol;
      });
      let use = entry && entry.ok ? entry : null;
      if (use) lastGood.set(path, use);
      else use = lastGood.get(path) || null; // keep serving the last good version
      if (!use) continue;
      const sol = use.value;
      if (seen.has(sol.id)) { log(`skip ${path}: duplicate puzzle id ${sol.id}`); continue; }
      seen.add(sol.id);
      let explanations = { decisions: {}, takeaway: null };
      const ef = join(explanationsDir, `${sol.id}.json`);
      if (existsSync(ef)) {
        const e = readCached(ef, (x) => ({ decisions: x.decisions || {}, takeaway: x.takeaway || null }));
        if (e && e.ok) explanations = e.value;
      }
      list.push({ solution: sol, explanations, fingerprint: use.fingerprint });
    }
    for (const path of [...lastGood.keys()]) if (!path.startsWith(solutionsDir) || !sFiles.includes(path.slice(solutionsDir.length + 1))) lastGood.delete(path);

    list.sort((a, b) => a.solution.id.localeCompare(b.solution.id));
    const puzzles = new Map();
    list.forEach((p, i) => {
      p.number = i + 1;
      p.decisionPositions = p.solution.steps.map((s, k) => (s.type === 'decision' ? k : -1)).filter((k) => k >= 0);
      p.decisionCount = p.decisionPositions.length;
      puzzles.set(p.solution.id, p);
    });
    assignDifficulty(puzzles);
    const before = state.puzzles.size;
    Object.assign(state, { puzzles, usingFixtures, solutionsDir, explanationsDir });
    if (puzzles.size !== before || lastScan === 0) log(`Loaded ${puzzles.size} puzzle(s).`);
    return true;
  }

  function statSig(path) {
    try { const st = statSync(path); return `${path}:${st.size}:${st.mtimeMs}`; } catch { return `${path}:gone`; }
  }

  const registry = {
    get puzzles() { return state.puzzles; },
    get usingFixtures() { return state.usingFixtures; },
    get solutionsDir() { return state.solutionsDir; },
    refresh(force = false) {
      const now = Date.now();
      if (!force && now - lastScan < rescanMs) return false;
      const changed = scan();
      lastScan = now;
      return changed;
    },
  };
  registry.refresh(true);
  return registry;
}

/**
 * ease = mean over decisions of the mean points over that decision's options:
 * the score a player clicking at random would expect. Higher = easier.
 * Sets p.ease, p.rank (1 = easiest; ties by id) and p.level (thirds of the rank order).
 */
export function easeOf(p) {
  const per = p.decisionPositions.map((pos) => {
    const d = p.solution.steps[pos];
    const pts = d.options.map((o) => gradeDecision(d, o.id).points);
    return pts.reduce((a, b) => a + b, 0) / pts.length;
  });
  return per.length ? per.reduce((a, b) => a + b, 0) / per.length : 0;
}
export function assignDifficulty(puzzles) {
  const list = [...puzzles.values()];
  for (const p of list) {
    try { p.ease = easeOf(p); } catch { p.ease = 0; }
  }
  list.sort((a, b) => b.ease - a.ease || a.solution.id.localeCompare(b.solution.id));
  const n = list.length;
  list.forEach((p, i) => {
    p.rank = i + 1;
    p.level = p.rank <= Math.ceil(n / 3) ? 'easy' : p.rank <= Math.ceil((2 * n) / 3) ? 'medium' : 'hard';
  });
}
