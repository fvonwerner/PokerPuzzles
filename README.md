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
| `TOURNAMENT_DIR` | `data/tournament` | the solved push/fold spots (`spots/*.json`) and `quiz.json` of the Tournament tab (docs/TOURNAMENT.md); read at start-up, restart after changing them. Missing: the server starts and the tab says the data is not installed |

A working copy in `dev/` (server and web only) runs beside the live site with its own database and
the repository's data:

```sh
cd dev && PORT=4466 DB_FILE=server/data/db.json SOLUTIONS_DIR=../data/solutions \
  EXPLANATIONS_DIR=../data/explanations TOURNAMENT_DIR=../data/tournament node server/index.mjs
```

If `SOLUTIONS_DIR` is not set and `data/solutions` holds no puzzle files, the
server falls back to the fake fixture puzzles in `data/solutions-fixture` (and
`data/explanations-fixture`) and says so in the startup log and in the lobby.
New or changed files in the solutions and explanations folders are picked up
without a restart (checked on API requests, at most every `RESCAN_MS`). A file
that fails to parse or validate, e.g. one still being written, is skipped and
logged once and retried when it changes; a puzzle that was already loaded keeps
its last good version meanwhile. Stored scores never change when a puzzle file
changes; an unfinished play of a changed puzzle starts again from decision 0.

Remove a test player and their plays (and battles, friendships and friend requests, tournament
drill totals and quiz answers): `node server/tools/reset-player.mjs <name>` (`--list` lists
players). Safe while the server runs (it reloads the db file).

## Tournament

Short-stack practice for the league's sit-and-go (`#/tournament`): 2 to 6 players with 4 to 12 big
blinds, an ante of 0.1 bb from every player, all-in or fold, on top of the solved spots in
`data/tournament` (how they were solved and how accurate they are: `docs/TOURNAMENT.md`; the rules
of the tab: `docs/SPEC.md` section 6).

- **Drill** (`#/tournament/drill`): endless hands. Choices (kept in the browser): chips or league
  points, players, stack (chips) or situation (points), seat, first in / facing an all-in / both,
  close hands (the two plays at most 0.5 bb apart, the default) or all hands. Each answer is graded
  by the server and shown with both EVs, the difference and its error, the solver's frequency, facts
  about the spot, the chart of the decision (and the jammer's range) and "Copy for Claude". The
  server keeps only totals per player; the session tally is kept in the browser tab.
- **Quiz** (`#/tournament/quiz`): the same 50 questions for everyone in 5 sets of 10. One question
  at a time, the first answer counts, the time is recorded; after each answer, how the others who
  answered it did; after the 10th the results, every question reviewable. A ranking (Everyone /
  Friends) by right answers over finished sets; finished sets show on profiles.
- **Charts** (`#/tournament/charts[/<spot>[/<decision>]]`): every decision of every spot as a 13x13
  chart, a click on a hand for its numbers, "Enlarge" for every number at once; the decisions facing
  two or more all-ins in their own group, with a note on their larger errors.

The verdict, the facts and the drill's sampling live in one pure module, `web/js/pushfold.js`, used
by the server and the browser alike.

## Friends, profiles, ranking

- **Friends** (`#/friends`): ask a player by name (exact, any case) or from a search (the first
  letters, at least 2; at most 10 results, each with your relation to them) or from the people
  you have battled. They accept or decline; you can take a request back; either can remove the
  friendship. If they had already asked you, asking them back makes you friends at once. At most
  50 of your requests can wait for an answer, and a player can have at most 200 friends
  (`FRIENDS` in `server/lib/social.mjs`). The "Friends" link in the header shows the requests
  waiting for you (refreshed on every page change and about every 30 s while the page is open).
- **Profiles** (`#/player/<id>`, yours from your name or initial in the header): member since,
  rank among everyone and among you and your friends, statistics (hands, average, total, the
  answers by grade, points per decision by street, battles), and every finished hand, newest
  first. A hand you have finished too opens to their decisions beside yours (and "Open the hand"
  goes to `#/review/<puzzle>/with/<player>`); one you have not shows only their score and when.
  Another player's answers by grade are shown as shares in whole percent (adding up to 100) and
  the streets as average points only, from 5 counted hands on; never as counts or decision
  totals, which would let you subtract the hands you know and count the decisions of one you have
  not played. Your own profile has the exact counts. On phones "Sign out" is on your own profile.
- **Others on this hand**: in the finished view (after a scored play, in review, after practice,
  and when a battle hand is reopened from the result; never in a live battle) everybody else who
  has finished the hand, friends first, then the most recent, at most 20: score and one mark per
  decision, ringed where they chose differently from you; a row opens their decisions beside
  yours, and picking one moves the table there. Each decision's detail says who chose what.
- **Ranking** (the leaderboard's default order and the rank on profiles): a player is ranked from
  5 finished, scored hands on (`RANKING.minHands`). Ranked players are ordered by average score
  (exact, not the rounded one shown), more hands breaking a tie; equal average and equal hands
  share a place (1, 2, 2, 4). Players below the minimum follow, without a rank. The leaderboard
  can show everyone or you and your friends; the rank is worked out within the scope shown.

Only finished plays count anywhere, and a `partial` play (from a cancelled battle) is never shown
to others or counted.

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
node server/tools/smoke.mjs          # starts a server on a spare port with a temp db and plays through the API (tournament: the real data, read only)
node server/tools/prompt-test.mjs    # the "Copy for Claude" prompt (web/js/prompt.js): complete, and never anything not yet revealed
node server/tools/tournament-test.mjs  # web/js/pushfold.js against the real spots: verdicts, facts, sampling, the quiz, the prompt
```

## Layout

```
server/index.mjs          HTTP server: static web/, JSON API, serialized writes
server/lib/grading.mjs    SPEC section 4 (constants object GRADING)
server/lib/view.mjs       solution file -> public view (nothing secret before it is answered), reveals, explanations
server/lib/handlers.mjs   API handlers as plain functions of (request, ctx)
server/lib/battles.mjs    battles: the shared cursor and clocks, hand selection, what each player may see of the others
server/lib/social.mjs     friends, player search, profiles, the leaderboard and its ranking rule, "others on this hand"
server/lib/tournament.mjs Tournament: loading the spots and the quiz (with the start-up check), drill, quiz, ranking, profile block
server/lib/storage.mjs    storage interface, JSON-file implementation (atomic temp-file + rename)
server/lib/auth.mjs       name/PIN rules, scrypt hashing, tokens
server/lib/puzzles.mjs    loading and validating solution and explanation files
server/tools/             make-fixture.mjs, smoke.mjs, prompt-test.mjs, tournament-test.mjs, reset-player.mjs, battle-bot.mjs
web/                      vanilla JS modules + CSS, no external resources
web/js/prompt.js          "Copy for Claude": the prompt for one answered decision or the whole hand (pure, also runs under node)
web/js/pushfold.js        Tournament rules shared with the server: verdict, facts, drill sampling, formats, its "Copy for Claude" (pure)
web/js/tournament.js      the Tournament tab: home, quiz page and ranking, a set's results, "How accurate is this?"
web/js/tquestion.js       the Tournament question screen (drill, quiz, review) and its feedback panel
web/js/tcharts.js         push/fold charts (the range grid with numbers) and the Charts page
web/js/social.js          shared: friend buttons, grade marks, "Others on this hand", "Others here", decisions side by side
web/js/friends.js         the Friends page
web/js/profile.js         profiles
```

## API

All bodies are JSON. Everything except login needs `Authorization: Bearer <token>`.
Signed-in requests also note when the player was last seen (at most one write every 5 minutes).

| Endpoint | |
|---|---|
| `POST /api/login {name, pin}` | → `{token, player, created}`. A new name creates the player. Names 2–20 chars, unique ignoring case; PIN 4–12 digits. 5 wrong PINs lock the name for 10 minutes. |
| `POST /api/logout` | ends the session |
| `GET /api/me` | → `{player, usingFixtures, friendRequests}` (`friendRequests`: requests waiting for your answer) |
| `GET /api/puzzles` | → `{puzzles: [{id, number, title, tags (done puzzles only), scenario {key,name,potType}, hero {seat,position}, villain {seat,position}, decisionCount (done puzzles only), rank, level, status: new/in_progress/done, answered, score (null for a `partial` play), scored: false (partial plays only), battle (id of a running battle that holds this hand, not done puzzles only)}], nextId, usingFixtures}`. `rank` 1 = easiest, `level` easy/medium/hard (thirds of the rank order); difficulty is the mean over decisions of the mean points over the options (what random clicking would score), the raw number is not sent. `nextId` = the player's unfinished scored play (lowest rank first), else the easiest unplayed puzzle, else null. Signing in (or opening `/`) goes straight to `#/play/<nextId>`; the lobby is `#/lobby`. |
| `POST /api/puzzles/:id/start {mode: "scored"\|"practice"}` | → `{puzzle, steps, next, mode, answers, completed, end}`. `steps` runs up to and including the first unanswered decision; `answers` are the reveals already recorded (resume). Practice needs a completed scored play and starts fresh. |
| `POST /api/puzzles/:id/act {decisionIndex, optionId, mode}` | → `{reveal, steps, next, end}`. `reveal` = `{index, choice, choiceLabel, grade, label, points, freq, maxFreq, loss, lossPct, decision (full), optionGrades [{id, grade, label, points, freq, loss, lossPct}] (what every option would have scored, SPEC 4.1), explanation {text, generated}, offMainLine, mainLine, continuesWith}`. Scored: the choice is stored at once; re-sending an answered decision returns the recorded choice (`alreadyAnswered`). `end` (after the last decision) = `{step, heroNet, score, takeaway, others [{name, score}], recap}`. Practice grades but stores nothing (`end.score` is null; the client averages the points). |
| `GET /api/puzzles/:id/review` | → `{puzzle (with board), steps (all), answers (first-play reveals), end}`; 403 until completed. For a `partial` play (a hand finished by hand from an unfinished battle: played, never scored) `end.partial` is true and `end.score` null. |
| `GET /api/puzzles/:id/others` | → `{puzzle {id, number, title}, decisionCount, you {score, choices, partial?, battle?, stale?}, others: [{player {id, name}, friend, score, completedAt, stale?, choices}], total, friends}`: everybody else who has finished the hand (never an unfinished or `partial` play), friends first, then the most recent, at most 20 (`total` counts them all). A choice is `{index, street, optionId, label, grade, points, timeout?}`; for a play of an older version of the puzzle file (`stale`) the stored grade and points stay and labels follow the current file, as in the review. 403 until you have finished the hand (your own play, a `partial` one too, or the hand in a battle); 404 unknown puzzle. |
| `GET /api/leaderboard?scope=everyone\|friends` | → `{players: [{id, name, played, totalPoints, average, shares {best,correct,inaccuracy,wrong,blunder,timeout?}\|null, rank, friend}], you, scope, minHands, friendCount, puzzleCount}` (completed first plays only). `friends` = you and your friends. `players` come in the ranking order; `rank` is null below `minHands` (see "Friends, profiles, ranking"). `shares`: the answers by grade in whole percent, adding up to 100 (`timeout`, battle time-outs, only when there are any); another player's only from `minHands` hands (else null), yours always. No grade counts or decision totals. |
| `GET /api/players?q=<prefix>` | → `{q, players: [{id, name, relation}]}`: names starting with `q` (any case, at least 2 letters; 400 otherwise), an exact match first, at most 10. `relation`: `you`, `friend`, `sent` (your request waits), `received` (theirs waits for you), `none`. |
| `GET /api/players/:id` | → `{player {id, name, since}, you, relation, rank {minHands, played, everyone {rank, of, size}, friends {rank, of, size}\|null}, stats {played, average, totalPoints, battles {played, won}, detail, shares, streets {preflop\|flop\|turn\|river: {average}}}, friendCount (yours only), hands, handsTotal, next}`. Ranks as the viewer's leaderboard shows them (`of` = ranked players in the scope; `friends` for you and your friends only). Statistics count finished, scored plays of current puzzles. Another player: `shares` as on the leaderboard and per street only the average points per decision, from `minHands` counted hands on (else `detail` false and neither); never grade counts or decision totals. Your own profile: also `decisions`, `grades` (counts) and per street `{decisions, points, average}`. `hands` (first page, newest first): `[{puzzle {id, number, title, level}, completedAt, score, partial? (yours only), finished}]`; when `finished` (you have finished that hand too) also `choices` (theirs), `stale?`, and `mine {score, partial?, choices}`; otherwise only `yours: new\|in_progress` and `battle` (the id of your battle that holds it). Others never see unfinished or `partial` plays. |
| `GET /api/players/:id/hands?before=<cursor>&limit=<1-50>` | → `{hands, handsTotal, next}`: the next page (`next` of the previous one; 25 by default). 400 for a bad cursor. |
| `GET /api/friends` | → `{friends: [{id, name, since, played, average, lastActive}], incoming: [{id, name, at}], outgoing: [{id, name, at}], battled: [{id, name, battles, lastAt, relation}], limits {maxPending, maxFriends}}`. `lastActive`: when they last used the site (to about 5 minutes), else their last finished hand. `battled`: people from your battles that got going, not yet friends, most recent first, at most 8. |
| `POST /api/friends/request {name}` or `{id}` | → `{relation: "sent", player}` (201), `{relation: "sent", existing: true}` when it is already waiting, `{relation: "friend", mutual: true}` when they had asked you. 400 yourself or no name, 404 unknown player, 409 already friends or a limit reached (50 waiting requests, 200 friends). |
| `POST /api/friends/:id/accept` · `/decline` · `/cancel` · `/remove` | → `{relation, player}`. Accept or decline their request (404 if there is none; accepting a friend again is `existing`), take back yours (404 none; 409 if they have accepted), remove a friend (404 if not friends). |
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
| `GET /api/tournament` | → `{installed, spots: [{name, units, n, seats, stacks, posted, ante, blinds, payouts, note, exact, scale, asked {open, call}}], quiz: [{id, title, blurb, count, answered, finished, right (finished sets), timeMs}], drill {hands, right, kinds, values, lastAt}}`; `{installed: false}` without the data. No solver output. Gzip when accepted. |
| `GET /api/tournament/spots/:name` | → one spot for the charts: the menu's fields plus `decisions: [{id, seat, position, facing, kind, reach, allin_pct, askable, freq[169], ev_fold[169], ev_allin[169], ev_diff[169], ev_diff_se[169]}]` (frequencies 3 decimals, EVs 4). Gzip when accepted; an `ETag` (304 for `If-None-Match`). 404 unknown spot. |
| `GET /api/tournament/drill/next?value&players&stack&situation&seat&kind&hands&avoid` | → `{prefs, question: {spot, decision {id, seat, position, facing, kind}, hand {class, cards}}}`: a drill question for the choices (SPEC 6.1), never the class `avoid`; nothing the solver says. 404 when no hand matches. |
| `POST /api/tournament/drill/answer {spot, decision, class, cards, action}` | → `{feedback, totals}`. `action` `allin` (a jam or a call) or `fold`; graded from the server's data and added to your totals. 400 for a decision the drill does not ask, a bad class or action. |
| `POST /api/tournament/quiz/:set/next` | → `{set, count, answered, done, index, question, shownAt}`: the next unanswered question only (stamped when first shown), `done` and `question: null` when all are answered. |
| `POST /api/tournament/quiz/:set/answer {question, action}` | → `{index, count, done, feedback, others}`. Only the next unanswered question (409 otherwise); the first answer counts: answering again returns it with `alreadyAnswered`. `others` = `{total, right, friends, others: [{player {id, name}, friend, right}]}` (friends first, at most 40). |
| `GET /api/tournament/quiz/:set/summary` | → `{set, count, answered, right, finished, startedAt, finishedAt, timeMs, answers: [{index, id, action, right, grade, cost, timeMs, feedback}]}`: your answers so far. |
| `GET /api/tournament/quiz/questions/:id/others` | → `{question, total, right, friends, others}`; 403 until you have answered that question. |
| `GET /api/tournament/quiz/ranking?scope=everyone\|friends` | → `{scope, you, ranked, players: [{id, name, right, answered, sets, rank, friend}], setCount, friendCount}`: players with a finished set, by right answers over finished sets; equal numbers share a place. |

The tournament endpoints need a session like the rest; without `TOURNAMENT_DIR` all but `GET /api/tournament` answer 503. A profile (`GET /api/players/:id`) also has `tournament`: `{setCount, sets: [{id, title, count, finished, right, finishedAt} | {id, title, count, finished: false, answered} (yours only)], drill (yours only)}` or `null` without the data.

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
