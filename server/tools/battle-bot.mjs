#!/usr/bin/env node
// Test opponents for battles: sign in as one or more players over the HTTP
// API and play live, in lockstep: press Ready, answer each decision with a
// configurable pace and skill, press Continue / Next hand after reading.
// Use it to try battles alone (a duel or a three-way), or as a demo.
//
//   node server/tools/battle-bot.mjs --watch --from YourName                join your next challenge (or rematch invite)
//   node server/tools/battle-bot.mjs --watch --from YourName --names Mia,Kai --delay 2000,9000
//                                                                            two bots join your three-way: one fast, one slow
//   node server/tools/battle-bot.mjs --join ABCD                              join by code
//   node server/tools/battle-bot.mjs --create [--size 3]                      start a battle (the other bots of --names join it)
//
// Options (a comma list gives each bot its own value, in the order of --names):
//   --url URL            server (default http://localhost:4455, or $BOT_URL)
//   --names A,B          bot player names (default "Botty"); --pins 4242,4243 (default 4242, 4243, ...). Created on first sign-in.
//   --delay MS           thinking time once a decision is open, +-40% (default 2500)
//   --read MS            reading time before Ready / Continue / Next hand (default 2500)
//   --skill P            chance to pick the solver's top option (default 0.7); otherwise another option
//   --slow 0|1           1: wait until somebody has answered, then use most of the 20 s clock
//   --silent-after N     after N answers go silent (no requests at all: time-outs, automatic continue, "offline")
//   --silent-for MS      come back after this long (default: stay silent)
//   --again              after a battle, wait for a rematch invite (or a new challenge) and play that too
//   --rematch            after a battle, ask for a rematch (the first bot only)
//   --from NAME          with --watch / --again: only join challenges started by this player
//   --solutions DIR      solution files used to know the top option (default $SOLUTIONS_DIR or data/solutions);
//                        a file whose hand does not match is ignored (then the pick is random)
//   --quiet              less output
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
if (flag('help') || flag('h')) {
  const ls = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(ls.slice(0, ls.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const BASE = (opt('url', process.env.BOT_URL || 'http://localhost:4455')).replace(/\/$/, '');
const NAMES = String(opt('names', opt('name', 'Botty'))).split(',').map((x) => x.trim()).filter(Boolean);
const list = (k, d) => { const v = String(opt(k, d)).split(','); return (i) => v[Math.min(i, v.length - 1)]; };
const PIN = list('pins', NAMES.map((_, i) => String(4242 + i)).join(','));
const DELAY = list('delay', '2500'), READ = list('read', '2500'), SKILL = list('skill', '0.7'), SLOW = list('slow', '0');
const SILENT_AFTER = list('silent-after', '0'), SILENT_FOR = Number(opt('silent-for', '0'));
const QUIET = flag('quiet');
const FROM = String(opt('from', '')).toLowerCase();
const solDirs = [opt('solutions', ''), process.env.SOLUTIONS_DIR || '', join(ROOT, 'data', 'solutions'), join(ROOT, '..', 'data', 'solutions')].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.6 + Math.random() * 0.8));

function solution(id) {
  for (const d of solDirs) {
    const f = join(d, `${id}.json`);
    if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* next */ } }
  }
  return null;
}

class Bot {
  constructor(i) {
    this.i = i; this.name = NAMES[i]; this.pin = PIN(i);
    this.delay = Number(DELAY(i)); this.read = Number(READ(i)); this.skill = Math.max(0, Math.min(1, Number(SKILL(i))));
    this.slow = SLOW(i) === '1'; this.silentAfter = Number(SILENT_AFTER(i)) || 0;
    this.answers = 0; this.silentUntil = 0; this.token = null; this.plans = new Map();
  }
  log(...a) { console.log(new Date().toTimeString().slice(0, 8), `[${this.name}]`, ...a); }
  async api(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(BASE + path, {
          method, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; e.data = data; throw e; }
        return data;
      } catch (e) {
        if (e.status || attempt >= 5) throw e;
        await sleep(1000 * (attempt + 1)); // network hiccup: retry
      }
    }
  }
  async login() {
    const r = await this.api('POST', '/api/login', { name: this.name, pin: this.pin });
    this.token = r.token; this.id = r.player.id;
    this.log(`signed in${r.created ? ' (new player)' : ''}; skill ${this.skill}, thinks ~${this.delay} ms${this.slow ? ', slow' : ''}${this.silentAfter ? `, silent after ${this.silentAfter} answers` : ''}`);
  }
  get silent() { return this.silentUntil > Date.now(); }

  /** The pick: the solver's top option with probability skill (if the solution file matches the hand), else another. */
  pick(puzzle, step) {
    const sol = solution(puzzle.id);
    const ids = step.options.map((o) => o.id);
    let full = sol?.steps.find((s) => s.type === 'decision' && s.index === step.index);
    if (full && (sol.title !== puzzle.title || full.options.map((o) => o.id).join() !== ids.join())) full = null;
    if (!full) return { id: ids[Math.floor(Math.random() * ids.length)], how: 'random (no matching solution file)' };
    let k = 0;
    full.hand.freq.forEach((f, j) => { if (f > full.hand.freq[k]) k = j; });
    const best = full.options[k].id;
    if (Math.random() < this.skill || ids.length === 1) return { id: best, how: 'top option' };
    const others = ids.filter((x) => x !== best);
    return { id: others[Math.floor(Math.random() * others.length)], how: 'another option' };
  }

  /** Once at a time per moment: plan an action for `key` at `at` (local ms). Returns true when it is due. */
  due(key, at) {
    if (!this.plans.has(key)) this.plans.set(key, at);
    return Date.now() >= this.plans.get(key);
  }

  /** Play one battle in lockstep until its result (or cancellation). */
  async play(id) {
    let lastPhase = '';
    for (;;) {
      if (this.silent) { await sleep(500); continue; }
      let st;
      try { st = (await this.api('GET', `/api/battles/${id}`)).battle; } catch (e) { this.log(`poll failed: ${e.message}`); await sleep(1500); continue; }
      if (st.status === 'cancelled') { this.log(`battle cancelled (${st.cancelReason})`); return st; }
      const L = st.live;
      if (st.status === 'open' || !L) { await sleep(800); continue; }
      const skewNow = st.serverNow; // server time at this poll
      const tag = `${L.phase}:${L.hand}:${L.index}`;
      if (tag !== lastPhase && !QUIET && L.phase !== 'decide') this.log(`${L.phase}${L.phase === 'countdown' ? ` (hand ${L.hand + 1})` : ''}`);
      lastPhase = tag;
      if (L.phase === 'done') {
        this.log(`RESULT: ${String(st.outcome).toUpperCase()}${st.place ? ` (${st.place}${['', 'st', 'nd', 'rd'][st.place] || 'th'})` : ''}  you ${st.me.total} · ${st.opps.map((o) => `${o.name} ${o.total}`).join(' · ')}`);
        return st;
      }
      if (['ready', 'review', 'handEnd'].includes(L.phase) && !L.ready.includes(this.id)) {
        if (this.due(tag, Date.now() + jitter(this.read))) {
          try { await this.api('POST', `/api/battles/${id}/ready`, { ready: true }); } catch (e) { if (!QUIET) this.log(`ready: ${e.message}`); }
          if (L.phase === 'handEnd') {
            const hd = st.hands[L.hand];
            this.log(`hand ${L.hand + 1} over: ${hd.me.score}${hd.opps.map((o, k) => ` | ${st.opps[k].name} ${o.score}`).join('')}${hd.outcome ? ` (${hd.outcome})` : ''}`);
          }
        }
      } else if (L.phase === 'decide' && !st.hands[L.hand].me.choices?.some((c) => c.index === L.index)) {
        let at;
        if (this.slow) {
          // the slow one: wait for somebody else, then use most of the clock
          at = L.deadline ? Date.now() + Math.max(0, L.deadline - skewNow - 4000) : null;
        } else at = Date.now() + jitter(this.delay);
        if (at !== null && this.due(tag, at)) await this.answer(id, st, L);
      }
      await sleep(400);
    }
  }

  async answer(id, st, L) {
    const start = await this.api('POST', `/api/battles/${id}/start`, { hand: L.hand });
    const step = start.steps.find((s) => s.type === 'decision' && s.index === L.index && !('mainLine' in s));
    if (!step) return;
    const choice = this.pick(start.puzzle, step);
    let r;
    try { r = await this.api('POST', `/api/battles/${id}/act`, { hand: L.hand, decisionIndex: L.index, optionId: choice.id }); } catch (e) { this.log(`answer refused: ${e.message}`); return; }
    this.answers++;
    this.log(`hand ${L.hand + 1}, decision ${L.index + 1}: ${r.reveal.timeout ? 'TIME OUT' : `${r.reveal.choiceLabel} (${choice.how}) -> ${r.reveal.label} ${Math.round(r.reveal.points)}`}`);
    if (this.silentAfter && this.answers === this.silentAfter) {
      this.silentUntil = SILENT_FOR ? Date.now() + SILENT_FOR : Infinity;
      this.log(SILENT_FOR ? `going silent for ${Math.round(SILENT_FOR / 1000)} s` : 'going silent for good');
    }
  }

  async findChallenge() {
    this.log('waiting for an open challenge or a rematch invite…');
    for (;;) {
      const l = await this.api('GET', '/api/battles');
      const mine = l.open.filter((x) => !FROM || x.creator?.name.toLowerCase() === FROM);
      const o = mine.find((x) => x.invite === 'you') || mine[0];
      if (o) {
        try {
          await this.api('POST', `/api/battles/${o.id}/join`);
          this.log(`joined ${o.creator?.name}'s ${o.invite === 'you' ? 'rematch' : o.size === 3 ? 'three-way' : 'challenge'} ${o.code || ''}`);
          return o.id;
        } catch (e) { this.log(`could not join: ${e.message}`); }
      }
      await sleep(1500);
    }
  }
}

(async () => {
  const bots = NAMES.map((_, i) => new Bot(i));
  for (const b of bots) await b.login();
  const runOne = async (b, firstId) => {
    let id = firstId || await b.findChallenge();
    for (;;) {
      const st = await b.play(id);
      if (flag('rematch') && b.i === 0 && (st.status === 'finished' || st.status === 'cancelled')) {
        const r = (await b.api('POST', `/api/battles/${id}/rematch`)).battle;
        b.log(`rematch ${r.status === 'open' ? 'offered' : r.status}`);
        id = r.id;
        continue;
      }
      if (!flag('again')) return;
      id = await b.findChallenge();
    }
  };
  if (opt('join', '')) {
    const r = (await bots[0].api('POST', '/api/battles/join', { code: opt('join', '') })).battle;
    await Promise.all(bots.map(async (b, i) => { if (i) await b.api('POST', `/api/battles/${r.id}/join`).catch(() => {}); }));
    await Promise.all(bots.map((b) => runOne(b, r.id)));
  } else if (opt('join-id', '')) {
    const id = opt('join-id', '');
    await Promise.all(bots.map((b) => b.api('POST', `/api/battles/${id}/join`).catch(() => {})));
    await Promise.all(bots.map((b) => runOne(b, id)));
  } else if (flag('create')) {
    const size = Number(opt('size', '2'));
    const b = (await bots[0].api('POST', '/api/battles', { size })).battle;
    bots[0].log(`battle code ${b.code}   link ${BASE}/#/battle/${b.id}`);
    for (const x of bots.slice(1)) { await x.api('POST', `/api/battles/${b.id}/join`); x.log('joined'); }
    await Promise.all(bots.map((x) => runOne(x, b.id)));
  } else {
    await Promise.all(bots.map((b) => runOne(b, null)));
  }
  process.exit(0);
})().catch((e) => { console.error(`battle-bot: ${e.message}`); process.exit(1); });
