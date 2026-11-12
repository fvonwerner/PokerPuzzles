#!/usr/bin/env node
// Remove a player (and their sessions, plays and battles) from the JSON db.
//
//   node server/tools/reset-player.mjs --list
//   node server/tools/reset-player.mjs <name>
//
// Uses DB_FILE (default server/data/db.json). Safe while the server runs: the
// file is replaced atomically and the server reloads it before its next
// database operation (servers started before this tool existed must be
// restarted, or they will write their in-memory copy back).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_FILE = resolve(ROOT, process.env.DB_FILE || 'server/data/db.json');
const arg = process.argv.slice(2).join(' ').trim();

if (!arg || arg === '--help' || arg === '-h') {
  console.log('usage: node server/tools/reset-player.mjs --list | <name>');
  process.exit(arg ? 0 : 1);
}
if (!existsSync(DB_FILE)) { console.error(`No db at ${DB_FILE}`); process.exit(1); }
const db = JSON.parse(readFileSync(DB_FILE, 'utf8') || '{}');
db.players ||= {}; db.sessions ||= {}; db.plays ||= {}; db.battles ||= {}; db.battlePlays ||= {};
const plays = Object.values(db.plays);

if (arg === '--list') {
  const rows = Object.values(db.players).sort((a, b) => a.name.localeCompare(b.name));
  if (!rows.length) console.log('(no players)');
  for (const p of rows) {
    const mine = plays.filter((x) => x.playerId === p.id);
    const done = mine.filter((x) => x.completedAt).length;
    console.log(`${p.name.padEnd(22)} ${String(done).padStart(3)} done  ${String(mine.length - done).padStart(3)} in progress`);
  }
  process.exit(0);
}

const key = arg.toLowerCase();
const player = Object.values(db.players).find((p) => p.nameKey === key || p.name.toLowerCase() === key);
if (!player) { console.error(`No player named "${arg}". Use --list.`); process.exit(1); }

let nPlays = 0, nSessions = 0;
for (const [k, pl] of Object.entries(db.plays)) if (pl.playerId === player.id) { delete db.plays[k]; nPlays++; }
for (const [k, s] of Object.entries(db.sessions)) if (s.playerId === player.id) { delete db.sessions[k]; nSessions++; }
// Battles they took part in (or were invited to) go too; the opponent's half
// of such a battle would make no sense alone.
let nBattles = 0;
for (const [k, b] of Object.entries(db.battles)) {
  if (!(b.players || []).includes(player.id) && b.inviteId !== player.id && !(b.invites || []).includes(player.id)) continue;
  delete db.battles[k]; nBattles++;
  for (const [pk, bp] of Object.entries(db.battlePlays)) if (bp.battleId === b.id) delete db.battlePlays[pk];
}
for (const b of Object.values(db.battles)) if (b.rematchId && !db.battles[b.rematchId]) b.rematchId = null;
delete db.players[player.id];

const tmp = join(dirname(DB_FILE), `.reset-player.${process.pid}.tmp`);
writeFileSync(tmp, JSON.stringify(db, null, 1));
renameSync(tmp, DB_FILE);
console.log(`Removed ${player.name}: ${nPlays} play(s), ${nSessions} session(s), ${nBattles} battle(s).`);
