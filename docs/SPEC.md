# PokerPuzzles — data contract

A GTO puzzle trainer for a group of friends. Each puzzle is one fixed hand of
6-max no-limit hold'em (100bb, no rake) that every player plays through.
At each of the hero's decisions the player picks an action, is graded against
a solver solution, sees both ranges and a short explanation, and the hand then
continues along the puzzle's **main line** whatever they picked. That keeps
every player's decisions identical, so scores are comparable.

Three parts share this contract:

| Part | Folder | Job |
|---|---|---|
| Solver exporter (Rust) | `solver/` | Reads `data/ranges.json` + `data/puzzles.json`, solves each puzzle with `postflop-solver`, writes `data/solutions/<id>.json` |
| Server (Node, zero deps) | `server/` | Serves the site, hides answers until a decision is made, grades, stores scores |
| Web app (vanilla JS) | `web/` | The table, the action buttons, the feedback and range views, the leaderboard |

Authored inputs (do not change their format without asking): `data/ranges.json`,
`data/puzzles.json`, `data/explanations/<id>.json`.

## 1. Conventions

- All money in JSON output is in **big blinds**, as numbers rounded to 2 decimals.
  The solver works in integer chips; `chipsPerBb` (10) is in `ranges.json`.
- Cards are two-character strings, rank then suit: `"Ah"`, `"Td"`, `"2c"`.
  Ranks `AKQJT98765432`, suits `shdc`.
- Seats: `UTG, HJ, CO, BTN, SB, BB`. Positions postflop: `ip` / `oop`.
- **Grid order.** Every 13×13 range grid is a flat array of 169 entries.
  With `R = "AKQJT98765432"`, entry `13*i + j` is:
  `i == j` the pair `R[i]R[i]`; `i < j` the suited class `R[i]R[j]s`;
  `i > j` the offsuit class `R[j]R[i]o`. (Row A, column K is AKs; row K, column A is AKo.)
- Frequencies and weights are numbers in `[0, 1]` rounded to 3 decimals.

## 2. Authored inputs

### 2.1 `data/ranges.json`

- `charts.<key>`: one preflop decision. `options` lists the actions in display
  order; `ranges.<optionId>` is a range string giving how often each hand class
  takes that action. `fold` is always the remainder.
- `scenarios.<key>`: a heads-up postflop situation. `ip` / `oop` name the seat
  and which chart action defines that player's postflop range
  (`charts[chart].ranges[action]`). `potBb`, `stackBb` are the pot and the
  effective stack behind at the start of the flop. `preflop` is the ordered
  preflop action list; entries with a `chart` are real decisions.
- `trees.<key>`: bet and raise sizes per street and player, in `postflop-solver`
  bet-size syntax. An empty `oopBet` on the flop means OOP may not lead.
  Turn and river donk sizes use the solver default (same as the bet sizes).
- `treeDefaults`: all-in thresholds, merging threshold, rake.

### 2.2 `data/puzzles.json`

Array of:

```json
{
  "id": "p002",
  "title": "Defending the big blind with a flush draw",
  "scenario": "BTN_BB_SRP",
  "hero": "oop",
  "hand": "9h8h",
  "flop": "Kh7h3c", "turn": "2s", "river": "Jd",
  "tags": ["draw"],
  "villain": ["bet", "auto"],
  "heroLine": ["auto", "raise"]
}
```

`villain` and `heroLine` are optional. They steer the main line, one token per
**postflop** decision of that player, in order:

| Token | Meaning |
|---|---|
| `auto` (or missing) | Villain: the highest-frequency non-fold action of villain's range at that node. Hero: the highest-frequency action of the hero's hand. |
| `check`, `call`, `fold`, `raise`, `allin` | That action kind |
| `bet` | The highest-frequency bet size |
| `bet_small` / `bet_big` | The smallest / largest non-all-in bet size |

If a villain token's action has a range frequency under 0.10 at that node, or a
hero token's action has a hand frequency under 0.15, the exporter falls back to
`auto` for villain, keeps the token for hero, and records a warning either way.

The hand ends when the main line reaches a fold, an all-in call, or the end of
the river.

### 2.3 `data/explanations/<id>.json`

```json
{ "decisions": { "0": "Two or three sentences.", "1": "..." }, "takeaway": "One sentence." }
```

Keys are decision indices. A missing file or key is not an error.

## 3. Solution file — `data/solutions/<id>.json`

```json
{
  "version": 1,
  "id": "p002",
  "title": "Defending the big blind with a flush draw",
  "tags": ["draw"],
  "scenario": { "key": "BTN_BB_SRP", "name": "BTN opens, BB calls", "potType": "SRP" },
  "hero":    { "seat": "BB",  "position": "oop", "hand": ["9h", "8h"], "handClass": "98s" },
  "villain": { "seat": "BTN", "position": "ip" },
  "startingStackBb": 100,
  "board": { "flop": ["Kh", "7h", "3c"], "turn": "2s", "river": "Jd" },
  "solver": { "exploitabilityPctPot": 0.27, "iterations": 420, "memoryMb": 2100, "seconds": 74 },
  "warnings": [],
  "decisionCount": 4,
  "steps": [ ... ]
}
```

`steps` is the hand's timeline, in order. Every step that changes the money
carries `state`, the situation **after** that step:

```json
{ "pot": 5.5, "heroStack": 97.5, "villainStack": 97.5, "heroBet": 0, "villainBet": 0 }
```

`pot` is everything in the middle including the current street's bets;
`heroBet` / `villainBet` are the amounts put in on the current street (already
counted in `pot`); stacks are what is left behind. At the start of the hand the
blinds are posted (SB 0.5, BB 1).

### 3.1 Step types

**`action`** — an action that is not a decision: any preflop action that is not
a hero decision, and any **forced** postflop action (a node where the player
has exactly one legal option, such as the OOP check on the flop when leading is
disabled). A forced action is never a `decision` or `villain` step, gets no
decision index, and consumes no `villain` / `heroLine` token.

```json
{ "type": "action", "street": "preflop", "seat": "UTG", "kind": "fold" }
{ "type": "action", "street": "preflop", "seat": "BTN", "kind": "raise", "amount": 2.5, "state": { ... } }
{ "type": "action", "street": "flop", "seat": "BB", "kind": "check", "state": { ... } }
```

**`deal`** — a street is dealt. Street bets reset to 0.

```json
{ "type": "deal", "street": "flop", "cards": ["Kh", "7h", "3c"], "state": { ... } }
```

**`villain`** — a postflop action by the opponent.

```json
{
  "type": "villain", "street": "flop", "seat": "BTN",
  "action": { "id": "bet_18", "kind": "bet", "amount": 1.8, "pctPot": 33, "label": "Bet 1.8 (33%)" },
  "freq": 0.61,
  "options": [ { "id": "check", ... }, { "id": "bet_18", ... }, { "id": "bet_41", ... } ],
  "range": { "w": [169 numbers], "f": [169 arrays, one frequency per option], "freq": [overall frequency per option], "combos": 412.5 },
  "state": { ... }
}
```

`freq` is how often villain's whole range takes the chosen action. `range` is
villain's range **arriving at** this node and how it splits over the options.

**`decision`** — a hero decision. This is the puzzle.

```json
{
  "type": "decision", "index": 2, "street": "flop", "source": "solver",
  "state": { ... },
  "toCall": 1.8,
  "options": [
    { "id": "fold",     "kind": "fold",  "label": "Fold" },
    { "id": "call",     "kind": "call",  "amount": 1.8, "label": "Call 1.8" },
    { "id": "raise_54", "kind": "raise", "amount": 5.4, "label": "Raise to 5.4" }
  ],
  "hand": { "freq": [0, 0.42, 0.58], "ev": [0, 1.31, 1.33], "equity": 0.47 },
  "mainLine": "raise_54",
  "stateAfter": { ... },
  "range": { "w": [169], "f": [169 × options], "freq": [per option], "equity": 0.44, "combos": 388.1 },
  "villainRange": { "w": [169], "equity": 0.56, "combos": 301.7 }
}
```

- `state` is the situation **before** the hero acts; `stateAfter` is after the
  main-line action.
- `source` is `"solver"` (postflop) or `"chart"` (preflop). For `"chart"`,
  `hand.ev` and `hand.equity` are `null`, `villainRange` is `null`, and
  `range.w` is 1 for every class that can face this decision (for a first-in
  chart, all 169; for a facing-3-bet chart, the opener's raise weights).
- `hand.ev[k]` is the hero hand's expected value in bb for option `k`, all on
  the same baseline, so that `max(ev) - ev[k]` is the EV loss of option `k`.
  Use the solver's per-action EV for the hand (`expected_values_detail` or the
  equivalent in the pinned version; check the source).
- `hand.equity` is the hero hand's equity against villain's range at the node.
- Option ids: `fold`, `check`, `call`, `bet_<chips>`, `raise_<chips>`, `allin`.
  `amount` is the bet size, or for raises the raise-**to** total on this street,
  or for calls the amount to add. `pctPot` (bets only) is the bet as a
  percentage of the pot before it, rounded.

Range grids at a node:

- `w[c]` is the share of class `c`'s combos still in the range: the sum of the
  combos' reach weights divided by the class's combo count (6 / 4 / 12).
  Combos that hit the board count as 0. Do not remove the other player's hole cards.
- `f[c][k]` is the reach-weighted average frequency of option `k` over the
  class's live combos (all 0 when `w[c]` is 0).
- `combos` is the total reach weight of the range.

**`end`** — the hand is over.

```json
{
  "type": "end", "reason": "showdown",
  "state": { ... },
  "showdown": { "villainHand": ["Ad", "Kc"], "winner": "villain", "heroHandName": "Flush", "villainHandName": "Pair of kings" },
  "heroNet": -12.4
}
```

`reason` is `showdown`, `hero_fold` or `villain_fold`. At showdown the villain
hand is one deterministic sample from villain's range at the final node
(weighted by reach, excluding the board and the hero's cards, seeded by the
puzzle id). `heroNet` is the hero's win or loss for the whole hand in bb.
`showdown` is `null` unless `reason` is `showdown`. Hand names are optional.

Pinned details:

- In preflop `action` steps, `amount` is the seat's **total** put in preflop
  after the action (raise-to or call-to), as in `ranges.json`.
- `toCall` is always what the hero must add to call (1 for a first-in open
  from UTG–BTN, 0.5 from the SB, 0 when checking is possible).
- For chart decisions `range.equity` is `null` as well.

### 3.2 Order of steps

Preflop: the scenario's `preflop` list in order. An entry for the hero's seat
that has a `chart` becomes a `decision` (`source: "chart"`, `mainLine` = the
entry's action); every other entry becomes an `action`. Then `deal` flop,
postflop steps, `deal` turn, and so on, then `end`. Decision `index` counts
from 0 across the whole hand.

## 4. Grading

One module in `server/` owns this; the web app only displays the result.
`freq` = the chosen option's `hand.freq`, `maxFreq` = the largest `hand.freq`,
`loss` = `max(ev) - ev[chosen]` in bb, `lossPct` = `100 * loss / state.pot`.

| Grade | Rule | Points |
|---|---|---|
| Best | `freq >= maxFreq - 0.05` | 100 |
| Correct | `freq >= 0.035` · solver only: or `lossPct <= 0.2` | `60 + 40 * freq / maxFreq` |
| Inaccuracy | solver: `lossPct < 1.5` · chart: `freq > 0` | 40 |
| Wrong | solver: `lossPct < 6` · chart: `freq == 0` | 15 |
| Blunder | solver only: everything else | 0 |

Rules are tried top to bottom. The `lossPct <= 0.2` part of Correct is the
solver's accuracy (hands are solved to about 0.15% of the pot): an option that
costs no more than that is never graded below Correct, even if the solver
rarely or never plays it (60 points when its `freq` is 0). Chart decisions
have no EV and do not use it. A puzzle's score is the mean of its decisions'
points, rounded to an integer (0–100). Only a player's **first** play of a
puzzle counts; later plays are practice.

The thresholds live in one constants object so they are easy to tune.

### 4.1 Grades of every option (in a reveal only)

When a decision is answered (or, in a battle, runs out of time) the server's
reveal of it carries `optionGrades`: one entry per option, in the order of
`decision.options`, graded by the same rules as an answer:

```json
"optionGrades": [
  { "id": "fold",     "grade": "blunder", "label": "Blunder", "points": 0,  "freq": 0,    "loss": 5.21, "lossPct": 71.37 },
  { "id": "call",     "grade": "best",    "label": "Best",    "points": 100, "freq": 0.954, "loss": 0,    "lossPct": 0 },
  { "id": "raise_54", "grade": "correct", "label": "Correct", "points": 61.93, "freq": 0.046, "loss": 0, "lossPct": 0 }
]
```

`loss` / `lossPct` are `null` for chart decisions. The entry of the chosen
option equals the reveal's own `grade`, `points`, `loss` and `lossPct`, except
for a recorded play of a puzzle file that has changed since (`stale`): the
reveal keeps the stored grade and points, `optionGrades` follow the current
file. The web app uses them for "try another answer" on an answered decision
(nothing is sent back and nothing is stored). They are part of the reveal only:
never in `steps`, never before the decision is answered, never in what a battle
shows about the other players.

## 5. Players, friends and what others see

The server's database (`DB_FILE`, see the README) keeps players, sessions, plays and battles.
Package B adds, both optional in an older file (read as empty):

- `players[id].lastSeenAt`: when the player last used the site (ms), written at most every 5
  minutes. It is the "last active" of the friends list (before it exists: their last finished
  hand, else when they joined).
- `friends`: one record per pair of players, keyed by the two ids in sorted order (`"a:b"`):

  ```json
  { "from": "<id who asked>", "to": "<id asked>", "status": "pending", "createdAt": 1731400000000, "acceptedAt": null }
  ```

  `pending` is a request from `from` to `to`; accepting turns it into `"friends"` (with
  `acceptedAt`). Declining, cancelling and removing delete the record, so either player may ask
  again later. A request to a player who has already asked you accepts theirs.

### 5.1 Another player's plays

What the server sends about another player's play of a hand depends on whether the **viewer**
has finished that hand (their own play of it is completed, a `partial` one included, or they
finished it in a battle):

| | Viewer has not finished it | Viewer has finished it |
|---|---|---|
| that they played it, when, their score | yes | yes |
| their choices, grades, points, one mark per decision | no | yes |
| how many decisions the hand has | no | yes |

Plays that are not completed are never shown to anybody else; `partial` plays (from a cancelled
battle, never scored) are never shown to others and never counted in anybody's statistics (on
your own profile they are listed as not scored).

A choice shown to another player is `{index, street, optionId, label, grade, points, timeout?}`.
As in a review (section 4.1), for a play of an older version of the puzzle file (`stale`, its
fingerprint differs) the stored grade and points stay, labels follow the current file (a choice
that is no longer an option says so), and decisions the current file no longer has are left out.

Statistics over many hands never carry counts about another player's decisions: no number of
decisions (overall or per street), no count per grade, no sum of points per street. A viewer could
subtract the hands they have finished (whose decisions they see) from such counts and learn how
many decisions, and which grades, a hand they have not played has. Another player's answers by
grade are sent only as **shares**: whole percent adding up to exactly 100 (largest remainder; ties
go to the grade with more answers, then the better grade; battle time-outs are a `timeout` share
of their own when there are any), and per street only the average points per decision. Both only
once the player has at least `minHands` (5) counted hands: over fewer hands even shares and
averages would describe a single hand. This holds on profiles and on the leaderboard, in both
scopes. The player's own profile has the exact counts; their own leaderboard row shows shares like
every other row.

### 5.2 Ranking

The leaderboard's default order and the ranks on profiles follow one rule (`RANKING` in
`server/lib/social.mjs`). Counted are finished, scored first plays of puzzles in the current set.

1. A player with at least `minHands` (5) counted hands is ranked; the others are listed after
   all ranked players, without a rank.
2. Ranked players are ordered by average score (total points / hands, exact), then by more hands.
3. Equal average and equal hands share a place: 1, 2, 2, 4.

The leaderboard can show everyone or the viewer and their friends; ranks are worked out within the
scope shown, and a profile shows the rank in both scopes as the viewer's leaderboard would.

## 6. Tournament (push/fold)

Short-stack practice for the league's sit-and-go on top of the solved push/fold spots
(`TOURNAMENT_DIR`, default `data/tournament`; the data contract is `docs/TOURNAMENT.md` section 5):
`spots/*.json` (75 solved table situations) and `quiz.json` (50 fixed questions, 5 sets of 10). The
server reads them at start-up (`server/lib/tournament.mjs`); without the folder it starts all the
same and the tab says the data is not installed (`GET /api/tournament` answers `{installed: false}`,
the other tournament endpoints 503).

### 6.1 One module for the rules

`web/js/pushfold.js` is pure (no DOM, no I/O, no imports). The server grades, states the facts and
samples the drill with it; the browser uses the same functions for the charts, the table, the
question line, the number formats and "Copy for Claude"; `server/tools/tournament-test.mjs` checks it
against the real files. Its numbers are the files' numbers as served: frequencies 3 decimals, EVs
and their standard errors 4 (`normalizeSpot`).

- **Scale.** 1 for chip spots; for league-points spots `(payouts[0] - payouts[N-1]) / (sum of
  stacks)`, the points a big blind is worth. Thresholds in bb below are multiplied by it.
- **Asked decisions.** First in (nobody all-in yet), and facing exactly one all-in with
  `reach >= 0.01` (heads-up: both decisions always). Decisions facing two or more all-ins are never
  asked; they appear only in the charts, with a notice about their larger errors.
- **Verdict** for (decision, class, action `allin` | `fold`), with d = `ev_diff`, se = `ev_diff_se`,
  f = `freq`: *close* when `|d| <= max(2.5 se, 0.02 scale)` or `0.05 <= f <= 0.95`: either answer is
  right, graded **Correct**, and the app says "Too close to call: both plays are fine here".
  Otherwise the better action is all-in when d > 0, fold when d < 0 (never decided by `freq`): the
  right answer is **Best**; a wrong one costs `|d|` and is an **Inaccuracy** below 0.10 scale, **Wrong**
  below 0.50 scale, else a **Blunder**. Costs are shown with their error, `0.31 bb (±0.02)` (± = 2 se),
  heads-up `(exact)`; bb with 2 decimals, points with 3, percentages whole.
- **Facts** (each one exactly true, every number from the spot file or plain arithmetic on it):
  first in, who is behind and how often each calls (`allin_pct` of `<seat>_vs_<you>`, each when the
  players between fold) and what you pick up (the others' forced bets) against what you can lose
  (your stack capped by the biggest stack behind); facing one all-in, how wide the jammer jams when
  folded to (his first-in `allin_pct`); in chip spots where you close the action the price, by the
  identity `pot = 2 eff + dead`, `cost = eff - posted`, `needed = cost / pot`,
  `share = (ev_allin + eff) / pot` (it holds for every class of all 120 such decisions of the batch:
  `ev_fold = -posted`, `ev_diff = share x pot - cost`); with players behind, who can still call and
  how often (`allin_pct` of `<seat>_vs_<jammer>_<you>`); in points spots what going out means (only a
  player with at least your chips can put you out; out alone you take the lowest open place, N-th;
  another player with no more chips than you can share that hand, which changes it) and that the EVs
  are league points.
- **Drill sampling.** The spot uniformly among those that match the choices; first in and facing an
  all-in about equally often ("Both"); the decision by `reach`; the class by combos x `class_reach`;
  "Close hands" only classes with `|d| <= 0.5 scale`; never the class just dealt.

### 6.2 What leaves the server

A question (drill or quiz) carries the spot's table (seats, stacks before posting, forced bets, units,
payouts, chip note), the decision (`id`, `seat`, `position`, `facing`, `kind`) and the hand (class,
two cards). Nothing the solver says: no frequencies, EVs, reach, `allin_pct`, facts. The graded
answer brings the feedback: `{spot, decision (this decision's freq, ev_fold, ev_allin, ev_diff,
ev_diff_se, reach, allin_pct), jammer (facing an all-in: his first-in id, seat, allin_pct, freq),
hand, action, verdict, facts [{key, text}]}`. The charts (`/api/tournament/spots/<name>`) are open to
every signed-in player: the quiz is on the honour system and records the time each answer took.

### 6.3 Storage

Two optional collections in the db file (an older file reads them as empty):

```json
"tournamentDrill": { "<playerId>": { "playerId": "...", "hands": 40, "right": 31,
   "kinds":  { "open": { "hands": 22, "right": 18 }, "call": { "hands": 18, "right": 13 } },
   "values": { "chips": { "hands": 30, "right": 24, "cost": 1.2345 }, "points": { "hands": 10, "right": 7, "cost": 0.0412 } },
   "firstAt": 1731400000000, "lastAt": 1731400000000 } },
"tournamentQuiz": { "<playerId>:<setId>": { "playerId": "...", "setId": "hu", "startedAt": 1731400000000, "finishedAt": null,
   "shown": { "tq01": 1731400000000 },
   "answers": [ { "q": "tq01", "spot": "chips-n2-9bb", "decision": "SB_open", "class": "K2o", "cards": ["Kc", "2h"],
                  "action": "allin", "right": true, "grade": "best", "cost": 0, "close": false, "shownAt": 1731400000000, "at": 1731400004000 } ] } }
```

The drill keeps totals only (`cost`: the EV the answers gave up, bb for chips, points for points).
A quiz play holds the answers in order; `shown` stamps when each question was first handed out.

### 6.4 The quiz

- The server hands out only the next unanswered question of a set (stamping when it was first shown)
  and accepts an answer only for it; the first answer counts and cannot be changed (answering again
  returns the recorded one). The time of an answer is from first shown to the answer; a set's time is
  their sum.
- How the others did on a question (name, a tick or a cross, friends first) only for a viewer who has
  answered it.
- Ranking (Everyone / Friends): by right answers over all finished sets (a close hand counts as right);
  equal numbers share a place (1, 1, 3); players with no finished set are not ranked (and not listed).
- Profiles: finished sets with right answers out of 10 for everybody; your own profile also the sets
  you are in the middle of and your drill totals.
- At start-up every question is checked against the spots (the spot, the decision and the class
  exist, the decision is one the quiz asks, the cards are of the class, the hand is not close by the
  verdict rule). A question that fails is logged as a WARNING and graded as close (both answers right);
  one whose spot, decision or class is missing cannot be asked and is left out of its set.
