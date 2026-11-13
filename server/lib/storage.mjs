// Persistence behind one small async interface. This implementation keeps the
// data in memory and mirrors it to a JSON file with atomic, serialized writes.
// Another backend (SQLite, a KV store, ...) only has to implement the same
// methods.
//
//   getPlayer(id)            getPlayerByName(name)     putPlayer(player)    listPlayers()
//   touchPlayer(id, at)      (sets only player.lastSeenAt: no read-modify-write of the rest of the record)
//   getSession(token)        putSession(session)       deleteSession(token)
//   getPlay(playerId, puzzleId)   putPlay(play)        listPlays({ puzzleId?, playerId? })
//   getBattle(id)            getBattleByCode(code)     putBattle(battle)    listBattles({ playerId?, status? })
//   getBattlePlay(battleId, playerId)   putBattlePlay(bp)   listBattlePlays({ battleId?, playerId? })
//   getFriendLink(a, b)      putFriendLink(link)       deleteFriendLink(a, b)   listFriendLinks({ playerId? })
//   getDrillTotals(playerId) putDrillTotals(rec)                                     (Tournament drill)
//   getQuizPlay(playerId, setId)  putQuizPlay(rec)     listQuizPlays({ playerId?, setId? })  (Tournament quiz)
//   close()
//
// A friend link is one record per pair of players (either order finds it):
//   { from, to, status: 'pending' | 'friends', createdAt, acceptedAt }
// `from` asked `to`; while pending it is a request, once accepted a friendship.
// Tournament (docs/SPEC.md section 6): one drill record per player (totals only,
// keyed by player id) and one quiz play per player and set ("<player>:<set>").
// Collections added later (friends, tournamentDrill, tournamentQuiz) are
// optional in an older db file.
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const clone = (x) => (x === undefined || x === null ? x : structuredClone(x));
const playKey = (playerId, puzzleId) => `${playerId}:${puzzleId}`;
const battlePlayKey = (battleId, playerId) => `${battleId}:${playerId}`;
const quizKey = (playerId, setId) => `${playerId}:${setId}`;
export const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function createJsonFileStorage(file) {
  const empty = () => ({ version: 1, players: {}, sessions: {}, plays: {}, battles: {}, battlePlays: {}, friends: {}, tournamentDrill: {}, tournamentQuiz: {} });
  let db = empty();
  let knownMtime = 0; // mtime of the file as we last read or wrote it
  const fileMtime = () => { try { return statSync(file).mtimeMs; } catch { return 0; } };
  function load() {
    const raw = readFileSync(file, 'utf8');
    db = raw.trim() ? { ...empty(), ...JSON.parse(raw) } : empty();
    knownMtime = fileMtime();
  }
  if (existsSync(file)) load();
  else mkdirSync(dirname(file), { recursive: true });

  // If another process (server/tools/reset-player.mjs) rewrote the file, pick
  // that version up before the next operation, unless one of our own writes
  // is still in flight.
  let inFlight = 0;
  function sync() {
    if (inFlight) return;
    const m = fileMtime();
    if (m && m !== knownMtime) {
      try { load(); } catch (e) { console.error(`db reload failed, keeping memory copy: ${e.message}`); knownMtime = m; }
    }
  }

  // Serialized writes: every save waits for the previous one; the newest
  // snapshot always wins, intermediate snapshots are coalesced.
  let chain = Promise.resolve();
  let pending = false;
  let counter = 0;
  function save() {
    pending = true;
    inFlight++;
    chain = chain.then(async () => {
      try {
        if (!pending) return;
        pending = false;
        const tmp = `${file}.${process.pid}.${++counter}.tmp`;
        await writeFile(tmp, JSON.stringify(db, null, 1));
        await rename(tmp, file);
        knownMtime = fileMtime();
      } finally { inFlight--; }
    });
    return chain;
  }

  return {
    async getPlayer(id) { sync(); return clone(db.players[id]) ?? null; },
    async getPlayerByName(name) { sync();
      const key = String(name).toLowerCase();
      return clone(Object.values(db.players).find((p) => p.nameKey === key)) ?? null;
    },
    async putPlayer(player) { sync(); db.players[player.id] = clone(player); await save(); },
    async listPlayers() { sync(); return Object.values(db.players).map(clone); },
    async touchPlayer(id, at) { sync();
      const p = db.players[id];
      if (!p) return;
      p.lastSeenAt = at;
      await save();
    },

    async getSession(token) { sync(); return clone(db.sessions[token]) ?? null; },
    async putSession(session) { sync(); db.sessions[session.token] = clone(session); await save(); },
    async deleteSession(token) { sync(); delete db.sessions[token]; await save(); },

    async getPlay(playerId, puzzleId) { sync(); return clone(db.plays[playKey(playerId, puzzleId)]) ?? null; },
    async putPlay(play) { sync(); db.plays[playKey(play.playerId, play.puzzleId)] = clone(play); await save(); },
    async listPlays({ puzzleId, playerId } = {}) { sync();
      return Object.values(db.plays)
        .filter((p) => (!puzzleId || p.puzzleId === puzzleId) && (!playerId || p.playerId === playerId))
        .map(clone);
    },

    async getBattle(id) { sync(); return clone(db.battles[id]) ?? null; },
    async getBattleByCode(code) { sync();
      const key = String(code).toUpperCase();
      // Codes are unique among battles that can still be joined; prefer the newest match.
      const hits = Object.values(db.battles).filter((b) => b.code === key).sort((a, b) => b.createdAt - a.createdAt);
      return clone(hits.find((b) => b.status === 'open') || hits[0]) ?? null;
    },
    async putBattle(battle) { sync(); db.battles[battle.id] = clone(battle); await save(); },
    async listBattles({ playerId, status } = {}) { sync();
      return Object.values(db.battles)
        .filter((b) => (!playerId || (b.players || []).includes(playerId) || b.inviteId === playerId || (b.invites || []).includes(playerId)) && (!status || b.status === status))
        .map(clone);
    },

    async getBattlePlay(battleId, playerId) { sync(); return clone(db.battlePlays[battlePlayKey(battleId, playerId)]) ?? null; },
    async putBattlePlay(bp) { sync(); db.battlePlays[battlePlayKey(bp.battleId, bp.playerId)] = clone(bp); await save(); },
    async listBattlePlays({ battleId, playerId } = {}) { sync();
      return Object.values(db.battlePlays)
        .filter((p) => (!battleId || p.battleId === battleId) && (!playerId || p.playerId === playerId))
        .map(clone);
    },

    async getFriendLink(a, b) { sync(); return clone((db.friends ||= {})[pairKey(a, b)]) ?? null; },
    async putFriendLink(link) { sync(); (db.friends ||= {})[pairKey(link.from, link.to)] = clone(link); await save(); },
    async deleteFriendLink(a, b) { sync(); delete (db.friends ||= {})[pairKey(a, b)]; await save(); },
    async listFriendLinks({ playerId } = {}) { sync();
      return Object.values(db.friends ||= {})
        .filter((l) => !playerId || l.from === playerId || l.to === playerId)
        .map(clone);
    },

    async getDrillTotals(playerId) { sync(); return clone((db.tournamentDrill ||= {})[playerId]) ?? null; },
    async putDrillTotals(rec) { sync(); (db.tournamentDrill ||= {})[rec.playerId] = clone(rec); await save(); },
    async getQuizPlay(playerId, setId) { sync(); return clone((db.tournamentQuiz ||= {})[quizKey(playerId, setId)]) ?? null; },
    async putQuizPlay(rec) { sync(); (db.tournamentQuiz ||= {})[quizKey(rec.playerId, rec.setId)] = clone(rec); await save(); },
    async listQuizPlays({ playerId, setId } = {}) { sync();
      return Object.values(db.tournamentQuiz ||= {})
        .filter((p) => (!playerId || p.playerId === playerId) && (!setId || p.setId === setId))
        .map(clone);
    },

    async close() { await chain; },
  };
}
