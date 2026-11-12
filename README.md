# PokerPuzzles

A GTO puzzle trainer for a group of friends: everyone plays the same solver-graded
hands and compares scores. The data contract is `docs/SPEC.md`.

## Run it

Needs Node 18+ and nothing else (no npm install, no build step).

```sh
node server/index.mjs            # http://localhost:4455
```

Environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | `4455` | |
| `SOLUTIONS_DIR` | `data/solutions` | one `<id>.json` per puzzle (SPEC section 3) |
| `EXPLANATIONS_DIR` | `data/explanations` | optional `<id>.json` (SPEC section 2.3) |
| `DB_FILE` | `server/data/db.json` | players, sessions, plays |
| `RESCAN_MS` | `3000` | how often (at most) the puzzle folders are re-checked on API requests |

If `SOLUTIONS_DIR` is not set and `data/solutions` holds no puzzle files, the
server falls back to the fake fixture puzzles in `data/solutions-fixture` (and
`data/explanations-fixture`) and says so in the startup log and in the lobby.
New or changed files in the solutions and explanations folders are picked up
without a restart (checked on API requests, at most every `RESCAN_MS`). A file
that fails to parse or validate, e.g. one still being written, is skipped and
logged once and retried when it changes; a puzzle that was already loaded keeps
its last good version meanwhile. Stored scores never change when a puzzle file
changes; an unfinished play of a changed puzzle starts again from decision 0.

Remove a test player and their plays (and battles): `node server/tools/reset-player.mjs <name>`
(`--list` lists players). Safe while the server runs (it reloads the db file).

## Battles

Two or three players play the same 5 hands, live and in lockstep (`#/battle`).
Each hand is scored like a puzzle (0–100); a player's total is the sum (max 500),
highest total wins; with three players there is a ranking (ties share a place).

- **Joining.** A battle is open until it is full (or the creator presses "Start
  with 2" in a three-way, or every rematch invitation has been answered); then
  the hands are chosen: hands nobody has completed or started first (a `partial`
  play counts as played), not in another running battle of theirs, then fewest
  earlier battle appearances, aiming for 2 easy, 2 medium, 1 hard, easiest first.
- **Ready check.** Everybody presses Ready (it can be taken back); then the
  server fixes a start moment 4 s ahead and every screen counts 3-2-1 to it.
- **Decisions.** Each decision opens for everybody at once. No clock until the
  first answer; from then everybody else has 20 s (server-judged, 1.5 s network
  allowance). A time-out scores 0 ("ran out of time") and the hand goes on along
  the main line. Nobody sees the next decision until everybody has answered or
  run out of time; then all picks are visible and each player presses Continue,
  everybody moves on together once all have (or 30 s after the first did).
- **Between hands** the same: "Next hand" is a ready button (30 s after the first),
  then a 3 s versus lead-in. The result screen appears for everybody together.
- **Away players** time out decision by decision and are continued automatically,
  so the others can always finish; they rejoin at the current moment. If nobody
  answers, nothing runs: the battle rests. The constants are `BATTLE` in
  `server/lib/battles.mjs` (`clockMs`, `graceMs`, `autoMs`, `countdownMs`, `leadMs`).
- A battle hand counts as the player's normal first play of the puzzle if they
  had not played it (same choices, same score, time-outs as 0); a puzzle they had
  completed keeps its stored score. While a battle runs its hands cannot be
  played on their own (`/start` and `/act` answer 409 with the battle id, the
  puzzle list marks them with `battle`, `nextId` skips them). If a hand's puzzle
  file changes or disappears while the battle is unfinished, it ends as
  cancelled (`hands_updated`).
- Battles stored before three-player and live battles (`players: [a, null]`,
  `inviteId`) are read as they are; a running one gets a ready check and resumes
  at the earliest decision somebody still has to answer.

Test opponents, for trying it alone or for a demo (several bots in one process):

```sh
node server/tools/battle-bot.mjs --watch --from <your name>                      # one bot joins your next challenge
node server/tools/battle-bot.mjs --watch --from <your name> --names Mia,Kai \
     --delay 2000,6000 --slow 0,1 --silent-after 0,5 --silent-for 60000         # two bots for a three-way: one quick, one slow that drops out for a minute
node server/tools/battle-bot.mjs --create --size 3 --names A,B,C                 # three bots play each other
node server/tools/battle-bot.mjs --help                                          # all options
```

Bots sign in as "Botty" (PIN 4242), or the `--names` / `--pins` given, on `--url`
(default `http://localhost:4455`). They are real players: on the live site their
credited hands show on the leaderboard; remove them with `reset-player.mjs`. To
know the solver's top option they read the solution files (`--solutions`,
default `$SOLUTIONS_DIR` or `data/solutions`) and ignore a file whose hand does
not match the one they are dealt.

## Adding puzzles

1. Add an entry to `data/puzzles.json` (format in `docs/SPEC.md` section 2.2):
   a new id, a title, one of the scenarios in `data/ranges.json`, the hero's
   position and hand, and the board. The hand must be in the hero's preflop range.
2. Solve it into `data/v2/solutions`, to 0.15% of the pot. Rust's `cargo` lives
   in `~/.cargo/bin` and is not on the PATH, so use the built binary (rebuild
   with `~/.cargo/bin/cargo build --release` in `solver/` only if the solver
   code changes):

   ```sh
   ./solver/target/release/puzzle-solver estimate --ranges data/ranges.json --puzzles data/puzzles.json --only p051
   ./solver/target/release/puzzle-solver solve --ranges data/ranges.json --puzzles data/puzzles.json --out data/v2/solutions --target 0.15 --only p051
   ```

   `estimate` prints the memory the solve needs (seconds, writes nothing). A
   solve takes minutes and up to about 4 GB of RAM. It writes
   `data/v2/solutions/p051.json` and a readable `p051.summary.txt`.
3. Check it is a good puzzle: `python3 tools/puzzle-quality.py data/v2/solutions`.
   The gate (`--eligible`) needs no solver warnings, at least 2 decisive
   decisions (one action played 70% or more and another a real mistake), at
   most 1 mixed decision (no action at 60%), and a preflop line the chart
   plays most (or at least 40%). If it fails, change the board, the hand or
   the `villain` / `heroLine` tokens and solve again.
4. Build the fact sheet: `python3 tools/hand-facts.py data/v2/solutions --out data/v2/facts`.
5. Write `data/v2/explanations/p051.json` from `data/v2/facts/p051.facts.txt`,
   following `docs/EXPLANATIONS.md` (SPEC section 2.3 for the format).
6. Check it: `python3 tools/check-explanations.py data/v2/facts data/v2/explanations`
   must print 0 problems.
7. Publish: `python3 tools/publish-v2.py` (`--dry-run` to only report). It
   rebuilds the fact sheets, then copies each hand that passes the gate and
   the check (explanation, summary, and the solution last, which makes it
   visible) into `data/solutions` and `data/explanations`. Hands already live
   are left alone, except that a changed explanation in `data/v2/explanations`
   replaces the live one when it passes the check.

The running server picks the new files up by itself. Changing a live
solution file in any way (even only its title) changes its fingerprint, and
every running battle that contains the hand is cancelled.

Preflop ranges: the charts in `data/ranges.json` come from a published
preflop solver solution (6-max, 100 bb, 2.5x opens, NL500 rake), kept in
`data/preflop-source/` (see its `README.md`). `python3 tools/import-preflop.py`
rewrites the charts from those files (`--check` only prints the summary).
Re-solve every hand after changing them: postflop ranges follow the charts.

## Fixtures and tests

```sh
node server/tools/make-fixture.mjs   # writes 3 fake, SPEC-conformant puzzles (fx01-fx03)
node server/tools/smoke.mjs          # starts a server on a spare port with a temp db and plays through the API
```

## Layout

```
server/index.mjs          HTTP server: static web/, JSON API, serialized writes
server/lib/grading.mjs    SPEC section 4 (constants object GRADING)
server/lib/view.mjs       solution file -> public view (nothing secret before it is answered), reveals, explanations
server/lib/handlers.mjs   API handlers as plain functions of (request, ctx)
server/lib/battles.mjs    battles: the shared cursor and clocks, hand selection, what each player may see of the others
server/lib/storage.mjs    storage interface, JSON-file implementation (atomic temp-file + rename)
server/lib/auth.mjs       name/PIN rules, scrypt hashing, tokens
server/lib/puzzles.mjs    loading and validating solution and explanation files
server/tools/             make-fixture.mjs, smoke.mjs, reset-player.mjs, battle-bot.mjs
web/                      vanilla JS modules + CSS, no external resources
```

## API

All bodies are JSON. Everything except login needs `Authorization: Bearer <token>`.

| Endpoint | |
|---|---|
| `POST /api/login {name, pin}` | → `{token, player, created}`. A new name creates the player. Names 2–20 chars, unique ignoring case; PIN 4–12 digits. 5 wrong PINs lock the name for 10 minutes. |
| `POST /api/logout` | ends the session |
| `GET /api/me` | → `{player, usingFixtures}` |
| `GET /api/puzzles` | → `{puzzles: [{id, number, title, tags (done puzzles only), scenario {key,name,potType}, hero {seat,position}, villain {seat,position}, decisionCount (done puzzles only), rank, level, status: new/in_progress/done, answered, score (null for a `partial` play), scored: false (partial plays only), battle (id of a running battle that holds this hand, not done puzzles only)}], nextId, usingFixtures}`. `rank` 1 = easiest, `level` easy/medium/hard (thirds of the rank order); difficulty is the mean over decisions of the mean points over the options (what random clicking would score), the raw number is not sent. `nextId` = the player's unfinished scored play (lowest rank first), else the easiest unplayed puzzle, else null. Signing in (or opening `/`) goes straight to `#/play/<nextId>`; the lobby is `#/lobby`. |
| `POST /api/puzzles/:id/start {mode: "scored"\|"practice"}` | → `{puzzle, steps, next, mode, answers, completed, end}`. `steps` runs up to and including the first unanswered decision; `answers` are the reveals already recorded (resume). Practice needs a completed scored play and starts fresh. |
| `POST /api/puzzles/:id/act {decisionIndex, optionId, mode}` | → `{reveal, steps, next, end}`. `reveal` = `{index, choice, choiceLabel, grade, label, points, freq, maxFreq, loss, lossPct, decision (full), explanation {text, generated}, offMainLine, mainLine, continuesWith}`. Scored: the choice is stored at once; re-sending an answered decision returns the recorded choice (`alreadyAnswered`). `end` (after the last decision) = `{step, heroNet, score, takeaway, others [{name, score}], recap}`. Practice grades but stores nothing (`end.score` is null; the client averages the points). |
| `GET /api/puzzles/:id/review` | → `{puzzle (with board), steps (all), answers (first-play reveals), end}`; 403 until completed. For a `partial` play (a hand finished by hand from an unfinished battle: played, never scored) `end.partial` is true and `end.score` null. |
| `GET /api/leaderboard` | → `{players: [{id, name, played, totalPoints, average, decisions, grades {best,correct,inaccuracy,wrong,blunder}}], you, puzzleCount}` (completed first plays only) |
| `GET /api/battles` | → `{battles: [battle], open: [{id, code, size, creator {name}, joined [{name}], invite: "you"\|"them"\|null, others [{name}], createdAt, rematchOf, joinable}], record: [{opponent {id,name}, wins, losses, draws, last, for, against}], handCount}`. `battles` are yours (newest first, without `choices`); `open` are battles you can join (public ones with a free seat and rematch invitations for you). `record` is per friend; in a three-way every pair counts (who finished higher). |
| `POST /api/battles {size}` | → `{battle, existing}` (201). `size` 2 (default) or 3. A new open battle with a 4-letter `code` (letters without look-alikes); returns your open battle of that size instead if you have one. |
| `POST /api/battles/join {code}` | → `{battle, joined}`. Join by code (case and spaces ignored). When the battle is full the hands are chosen and the ready check starts. 400 malformed, 404 no open battle with that code, 409 full or cancelled. |
| `POST /api/battles/:id/join` | → `{battle, joined}`. Join by id (the share link `#/battle/<id>`), or accept a rematch; 403 for a rematch meant for others. Joining your own battle just returns it. |
| `POST /api/battles/:id/begin` | → `{battle}`. The creator goes on with the players who are there (at least 2): "Start with 2" in a three-way, or a rematch somebody has not answered. |
| `GET /api/battles/:id` | → `{battle}`. Players get the full state; anyone else `{id, status, size, outsider: true, joinable, code (if joinable), creator {name}, joined, invite, others}`. Polled about once a second by the battle screen; moves the shared cursor on (time-outs, automatic continue) and marks you present for the others' online dots. |
| `POST /api/battles/:id/ready {ready}` | → `{battle}`. Ready in the ready check (`ready: false` takes it back until everybody is ready), Continue after a decision, Next hand / See the result after a hand. 409 when there is nothing to be ready for. |
| `POST /api/battles/:id/cancel` | → `{battle}`. The creator cancels before the first hand (reason `creator`), or an invited player declines a rematch (`declined`; when everybody else has accepted it goes on without them). |
| `POST /api/battles/:id/rematch` | → `{battle, existing}` (201 when new). A new battle for the same players, open with invitations for the others; it goes on when all have answered (or the inviter presses begin). Pressing it again gives the same battle. Finished battles, or cancelled ones that had started. |
| `POST /api/battles/:id/start {hand}` | → as `/puzzles/:id/start` (`puzzle, steps, next, answers, completed, end`) plus `mode: "battle"`, `hand`, `battle`: the hand at the shared cursor (steps up to the open decision only), or completed once the hand is over for everybody. 409 before the hand has started; 410 if its puzzle is gone. |
| `POST /api/battles/:id/act {hand, decisionIndex, optionId}` or `{hand, decisionIndex, timeout: true}` | → `reveal, steps, next, alreadyAnswered, timedOut, battle`. Only the open decision; the hand does not go on until everybody has answered. An answer after the clock (plus 1.5 s) gets the recorded time-out (`timedOut: true`, a reveal with `grade: "timeout"`, 0 points and the full analysis). `timeout: true` asks for that time-out (409 with `retryInMs` if the server's clock has not run out yet). 409 for any decision that is not open. |

`battle` (players): `{id, status: open/active/finished/cancelled, code (open only), size, createdAt, joinedAt, finishedAt, cancelledAt, cancelReason: creator/declined/hands_updated, handCount, serverNow, timing {clockMs, graceMs, autoMs, countdownMs, leadMs}, you {id,name}, youCreated, creator, players [{id,name}], invited, declined, inviteOnly, canStart, canCancel, invite: "you"/"them"/null, live, me {hand, done, total}, opps [{id, name, color 1|2, online, lastSeenAgo, hand, done, total}], outcome: win/loss/draw/shared/place (finished only), place, shared, standings [{id, name, total, place}], hands: [{n, level, decisionCount (only once the hand is over for you), puzzle {id, number, title, available}|null, me {answered, done, score, choices}, opps [{id, answered, done, score, choices}], outcome: won/lost/tied|null, winners, place}], rematchOf, rematch {id, status, byYou, by, invitedYou, joined}|null}` plus `opponent`, `opp`, `online`, `lastSeenAgo` and `hands[].opp` for the first opponent (duels, older clients).
`live` = `{phase: ready/countdown/decide/review/handEnd/done, hand, index, kind: start/resume/lead, startsAt, decideAt, deadline (server ms; the 20 s clock, from the first answer), firstBy, answered [ids], timedOut [ids], ready [ids], autoAt (server ms; the automatic continue), started}`; times are server times, `serverNow` lets clients correct for their own clock.
A choice is `{index, optionId, label, street, grade, points, timeout?}`. What you see of the others is enforced here: who has answered the open decision and who is ready; another player's pick for a decision only once you have answered (or run out of time on) it; hand scores, round results and the number of decisions once the hand is over; opponents' progress never past the open decision. `puzzle` is null for hands that have not started.

`tags` are sent only for puzzles the player has completed (list, end of hand, review, practice).
Until a hand is finished nothing tells how many decisions it has: `decisionCount` is left out of the puzzle header and the list, an out-of-range `decisionIndex` answers like any decision that is not open, and the feedback says "decision 2", never "2 of 4".
Before a decision is answered, the decision step carries only `type, index, street, source, state, toCall, options`,
and villain steps carry only `type, street, seat, action, state`; their `freq`, `options` and `range` arrive once the
next hero decision is answered (or the hand is over). Later streets are not sent at all. Raw solution files are never served.

## Licence

PokerPuzzles is free software under the GNU Affero General Public License,
version 3 or later; the full text is in `LICENSE`. The solver exporter in
`solver/` builds on [postflop-solver](https://github.com/b-inary/postflop-solver)
(AGPL-3.0-or-later). The preflop ranges in `data/preflop-source/` come unchanged
from the [TexasSolver](https://github.com/bupticybee/TexasSolver) v0.2.0 release
(AGPL-3.0).
