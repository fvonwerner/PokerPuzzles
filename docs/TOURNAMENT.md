# Tournament mode: the push/fold engine

`pushfold/` is the calculation base of the Tournament mode: a Rust program that
computes the Nash equilibrium of the push/fold game for short-stacked spots of
the league's sit-and-go, 2 to 6 players, in chip EV or in league points (ICM).
Every number in `data/tournament/spots/` is a solver result produced by this
engine, with its error stated next to it. This document says exactly which game
is solved, how, how accurate the numbers are, and how that was checked.

Contents: 1 the game · 2 the algorithm · 3 accuracy · 4 validation ·
5 output format · 6 running it · 7 the first batch · 8 limits and caveats.

## 1. The game

**Table.** N players, N = 2..6, seated in action order as the last N of
UTG, HJ, CO, BTN, SB, BB (heads-up: SB, BB; the SB is the button and acts first).

**Forced bets** (all amounts in big blinds, stacks given before posting):

| mode | what is posted |
|---|---|
| `per_player` (default) | every player posts an ante of 0.1 bb, then SB 0.5 and BB 1 |
| `bb_ante` | SB 0.5, BB 1, then the BB posts one ante of 1 bb for the table (none heads-up) |
| `none` | blinds only (used for the published heads-up comparison) |

A player who cannot cover his forced bets posts what he has, in the order
ante then blind (per-player antes) or blind then ante (big blind ante, as in
the TDA rule), and is then all-in without a decision.

**Actions.** Starting left of the big blind each player acts once: fold or go
all-in. Going all-in is a first-in jam, or a call / over-call of earlier
all-ins; it always commits the player's whole stack, so a covering caller
isolates against players still to act (the standard push/fold convention).
If everybody folds to the big blind he wins the pot; a big blind facing only
players who are all-in by posting checks.

**Decision points.** A player's decision is identified by the set of earlier
players who went all-in voluntarily: player p (0-based in action order) has
2^p decision points, the big blind one fewer (no decision in an unopened pot).
That is 2, 6, 14, 30 and 62 decision points for N = 2..6. Each has a strategy
for each of the 169 hand classes.

**Side pots** are exact for any stacks. Every player's contribution is his
whole stack if he is all-in, otherwise what he posted. Pot levels are the
distinct contributions of the players still in the hand; each level is won by
the best hand among the players who reached it (ties split equally), money
nobody can win is returned (uncalled). Per-player antes are counted in the
levels: every player posts the same ante, so this equals treating them as dead
money, and it is the correct rule for a player whose stack is smaller than the
ante. The big blind ante is dead money in the main pot (a short BB's live stack
is his stack minus that ante).

**Payoffs.**

- `chips`: the change of the player's stack over the hand, in bb, measured from
  his stack before posting (so folding UTG is worth exactly -0.1).
- `points`: league points by ICM (Malmuth-Harville). With N players left the
  open places are 1..N with the first N of 15 / 8 / 5 / 3 / 2 / 1 points.
  After the hand, players with no chips take the lowest open places; several
  players busting in the same hand are ordered by their stack before the hand
  (bigger = better place), equal stacks split those places' points; the
  survivors share the remaining places by Malmuth-Harville on their new stacks.
  EVs are expected points after the hand.

**Equilibrium.** A strategy (all-in probability) for every player, decision
point and hand class such that no player can gain by changing his own strategy.
All card removal is part of the game: the hero's cards, every other player's
cards (also of players who fold) and the board all come from one deck.

## 2. The algorithm

### Heads-up: exact

All-in equities are exact. For every pair of hand classes the engine counts,
over every 5-card board and every pair of disjoint combos of the two classes,
the boards each side wins and ties. The boards are enumerated as the 134,459
suit-isomorphism classes of the 2,598,960 boards, weighted by their size; the
counts are integers, and the run checks that win + tie + loss equals
(combo pairs) x C(48,5) for all 28,561 class pairs. That is exact equity with
exact card removal between the two hands (8.5 s on this Mac, once per run).

The equilibrium is computed with CFR+ (regret matching+, linear averaging) on
the 2 x 169 decisions. Exploitability is an exact best-response computation;
the solver stops at 1e-6 bb per hand or below.

### Three to six players: Monte Carlo over complete deals

With more players exact enumeration of all hole cards is out of reach, and the
usual shortcut is not accurate. Treating the other players' ranges as
independent ignores that the cards of players who folded are not random:
folding ranges hold few aces and big cards, so after several folds the
remaining players hold them more often, and the board is dealt from a deck that
is richer in them. Measured in section 4.6, ignoring the folded players' cards
moves the SB's and the BB's EV differences in a 6-handed 10 bb spot by about
0.17 bb on average and up to about 0.38 bb, a hundred times the 0.002 bb
target. So the engine samples the real thing:

1. **A deal** is a complete deal from one shuffled deck: the board and every
   player's two cards.
2. **Hero enumeration.** For each deal and each player ("hero"), the hero's own
   two cards are replaced by every pair of cards nobody else holds (666 pairs
   6-handed, 903 3-handed). For each pair the engine knows the hand class and
   the rank of the hand on the board, so it computes the exact value of folding
   and of going all-in at the hero's decision, given everybody else's cards:
   earlier players' actions are weighted by their strategy for their actual
   hands, later players' responses are summed over their strategies, and every
   all-in (two-way or multi-way, any side pots) is settled on the deal's board.
   This makes every deal an exact average over the hero's possible hands, and
   all card removal is automatically correct.
3. **Phase 1**: CFR+ on a fixed sample of 100,000 deals until the sample's
   exploitability is below the target (at most 400 iterations).
4. **Phase 2**: 150 more CFR+ iterations, each on a fresh sample of 100,000
   deals; the final strategy is the average of these iterations. Averaging
   over fresh samples removes the over-fitting to one sample: on the 3-handed
   10 bb test spot the independent exploitability fell from 0.0022 bb (fixed
   sample only) to 0.00017 bb at the same compute.
5. **Evaluation** on an independent sample of 4,000,000 deals (a different
   seed), in 32 batches: for every decision point and class the EV of folding
   and of going all-in with standard errors (ratio estimator, batch
   linearisation), each player's best-response gain (exploitability), and each
   player's EV per hand. Every deal also checks that the payoffs of all players
   add up to 0 bb (chips) or to the total points on offer (points).

Results are reproducible from the spec: each deal's random numbers come from a
generator seeded by (seed, deal number). From engine version 0.1.1 the
per-thread sums are also added in a fixed order, so a rerun is bit-identical
whatever the number of threads. The first batch was computed with 0.1.0, which
added them in scheduling order; that can only change the last binary digits:
re-solving `chips-n3-4bb` with 0.1.1 reproduced every stored frequency and EV
of the batch file exactly.

The 7-card evaluator (bit operations on the four suit masks) is checked against
all 133,784,560 seven-card hands (category counts and the 4,824 distinct values)
and against an independent best-of-21 evaluator.

## 3. Accuracy: what the numbers mean

- **Exploitability** (`exploitability` in each output): how much one player
  could gain per hand, on average over all hands, by switching to his best
  response while everybody else keeps the solution. Units: bb per hand (chips)
  or points per hand (points). Target: 0.002 bb; for points the same 0.002 bb
  converted at the value of a big blind between first and last place,
  0.002 x (P1 - PN) / (bb on the table). Reported three ways for Monte Carlo
  spots: on the solving sample, on the independent evaluation sample with the
  best response chosen and valued there (plug-in; biased upward by noise), and
  cross-fitted (best response chosen on one half of the evaluation sample and
  valued on the other; the noise bias is removed, it can come out slightly
  below zero). The evaluation-sample values are the ones that measure the
  solution. The solving-sample value is the phase 1 stopping criterion; after
  phase 2 the final strategy is no longer fitted to that sample, so the value
  also carries the sample's own noise and can be above the target while the
  independent values are far below it. Heads-up values are exact.
- **EV of each action** (`ev_fold`, `ev_allin`, `ev_diff` per class): the
  expected payoff of the action given that the player is at this decision with
  this hand class, everybody playing the solution. These EVs are exact for the
  strategies in the file up to `ev_diff_se`, the standard error from Monte
  Carlo sampling (0 heads-up); a quiz grading a mistake by its cost against
  these opponents should quote that error. The residual exploitability is a
  separate, aggregate statement: no player can gain more than that amount per
  hand by deviating, summed over all his hands and decisions. It is not a
  per-class bound, and in games with three or more players the equilibrium
  need not be unique, so a different equilibrium could value a close hand
  differently.
- `samples` is the reach-weighted number of deals behind a class's EVs. Rare
  decision points (facing two or more all-ins) have few samples and larger
  errors; see the table in section 7.

## 4. Validation

All validation inputs and outputs are in `data/tournament/validation/`.

### 4.1 Heads-up against the published chart (HoldemResources HUNE)

**Reference.** HoldemResources.net, *Heads-Up Push/Fold Nash Equilibrium*
(<https://www.holdemresources.net/hune>), read on 2026-11-12: two 13 x 13 charts
(SB push, BB call) per variant, "No Ante" and "Ante 10%". A cell is the highest
effective stack in bb (before blinds) at which the hand is played; "20+" means at
every stack up to 20 bb. The page says its charts are simplified: hands that are
mixed at some stacks are shown as pure. The cells were read one by one through a
text extraction tool; the values used are recorded in
`hune-reference-no-ante.json` and `hune-reference-ante10.json`.

**Ours.** The exact heads-up engine solved at every 0.05 bb from 1 to 20 bb
(381 stacks per variant; exploitability at most 1e-7 bb per hand at every
stack; 29 s per sweep): `hu-sweep-no-ante.json`, `hu-sweep-ante10.json`. A
hand's threshold is the top of the highest stack interval where it is played
with frequency at least 0.5. `tools/compare-hune.py` writes
`hune-comparison.json`.

**No Ante: 130 cells compared (63 SB push, 67 BB call, spread over the whole
chart), 130 agree within the 0.05 bb grid step**: 68 identical (including every
"20+"), 62 exactly 0.05 bb higher on our side, which is what the published
chart's truncation to 0.1 bb produces (e.g. K2o: we push up to 11.65 bb, the
chart prints 11.6). The three hands the chart marks as having gaps agree too:

| hand | HUNE (push) | ours: stacks where the SB pushes (freq >= 0.5) |
|---|---|---|
| 63s | up to 2.3 and 5.1 - 7.1 | 1 - 2.35 and 5.1 - 7.15 (mixed between 5.2 and 6.05) |
| 53s | up to 2.4 and 3.8 - 12.9 | 1 - 2.4 and 3.75 - 12.9 (mixed 3.8 - 4.1) |
| 43s | up to 2.2 and 4.9 - 10.0 | 1 - 2.2 and 4.85 - 10.0 (mixed 7.85 - 10.0) |

A sample of the 130 cells (all in the JSON):

| hand | SB push: HUNE | SB push: ours | BB call: HUNE | BB call: ours |
|---|---|---|---|---|
| K2o | 11.6 | 11.65 | 8.1 | 8.15 |
| K5o | 14.2 | 14.25 | 10.2 | 10.2 |
| K8o | 18.0 | 18.0 | 13.8 | 13.85 |
| K2s | 19.3 | 19.3 | 10.7 | 10.75 |
| Q2o | 7.0 | 7.05 | 5.6 | 5.6 |
| Q5o | 8.9 | 8.95 | 6.8 | 6.8 |
| Q8o | 13.0 | 13.0 | 9.7 | 9.75 |
| Q2s | 12.7 | 12.7 | 7.2 | 7.25 |
| J2o | 4.6 | 4.6 | 4.2 | 4.2 |
| J5o | 6.0 | 6.05 | 5.1 | 5.1 |
| J8o | 13.3 | 13.3 | 7.6 | 7.6 |
| J2s | 8.5 | 8.55 | 5.6 | 5.65 |
| J5s | 14.7 | 14.75 | - | - |
| T2o | 2.9 | 2.95 | 3.5 | 3.5 |
| T5o | 4.1 | 4.15 | - | - |
| T8o | 17.5 | 17.5 | - | - |
| T2s | 6.5 | 6.5 | 4.5 | 4.55 |
| T3s | 7.7 | 7.7 | - | - |
| 92o | 2.2 | 2.25 | 3.0 | 3.05 |
| 95o | 3.5 | 3.55 | - | - |
| 92s | 3.7 | 3.75 | 3.9 | 3.9 |
| 95s | 14.4 | 14.45 | - | - |
| 87o | 14.7 | 14.7 | 4.7 | 4.75 |
| 85s | 18.8 | 18.85 | - | - |
| 76o | 10.7 | 10.75 | 4.0 | 4.05 |
| 74s | 13.9 | 13.95 | - | - |
| 64s | 16.3 | 16.35 | - | - |
| 65o | 2.4 | 2.45 | 3.7 | 3.7 |
| 54o | 2.1 | 2.1 | 3.5 | 3.5 |
| 32o | 1.4 | 1.4 | 2.6 | 2.65 |
| 32s | 1.7 | 1.75 | 3.3 | 3.3 |
| 22 | 20+ | 20+ | 15.0 | 15.05 |
| A2o | 20+ | 20+ | 15.8 | 15.85 |
| K5s | 20+ | 20+ | 13.2 | 13.25 |
| QTo | - | - | 15.3 | 15.3 |
| Q5s | 20+ | 20+ | 8.9 | 8.95 |
| Q9s | 20+ | 20+ | 16.1 | 16.15 |
| JTo | - | - | 12.7 | 12.75 |
| J6s | - | - | 7.0 | 7.05 |
| J9s | - | - | 13.4 | 13.4 |
| T9o | - | - | 8.4 | 8.4 |
| T9s | - | - | 11.5 | 11.5 |
| 98o | 20+ | 20+ | 6.0 | 6.05 |
| 98s | 20+ | 20+ | 8.2 | 8.25 |
| 76s | 20+ | 20+ | 5.4 | 5.45 |
| 65s | 20+ | 20+ | 4.9 | 4.95 |
| 54s | 20+ | 20+ | 4.6 | 4.6 |
| 43s | - | - | 3.8 | 3.85 |

**Second pass over the whole chart** (2026-11-12, separate from the 130 cells
above): both No Ante charts were read again from the page as a whole and every
cell except the three footnoted ones was compared with `hu-sweep-no-ante.json`,
335 cells (166 push, 169 call). 224 are identical, 109 are exactly 0.05 bb
higher on our side (the chart's truncation), and K7o's call is 0.05 lower
(12.35 against 12.4). One hand has more to say: Q4o is pushed up to 7.9 bb in
both, and our exact solution also pushes it at frequency 0.5 or more in a
narrow mixed stretch at 8.25 - 8.3 bb, which a chart of pure cells leaves out.
So all 335 cells agree to within the 0.05 bb grid.

**Ante 10%** (each player antes 0.1 bb, the league structure heads-up):
30 cells (15 hands x 2) and the three gap footnotes. 22 cells agree within
0.05 bb. The other 8 (J5o, T6o, 76o, 65o, J8o push; K5s, Q9o, J8o call) differ
by 0.1 to 0.7 bb, and every one of them lies where the exact solution plays the
hand mixed, which the published chart does not show: e.g. J5o is pushed at
frequency 0.20 - 0.28 at 7.10 - 7.15 bb (chart: 7.1, ours at >= 0.5: 7.0); the
Q9o call falls from 0.85 to 0.09 between 13.15 and 13.5 bb (chart: 13.5, ours:
13.3); 65o is a pure push up to 3.05 bb (chart: 3.0) and then mixed at
scattered stacks up to 8.05 bb. The gap footnotes agree up to such mixed
stretches (63s: chart up to 2.8 and 4.7 - 8.9, ours up to 2.85 and 4.65 - 8.9,
plus mixed play at about 4.2 and 9.5 - 10.1; 53s: chart 2.9 and 3.8 - 15.2,
ours 2.9 and 3.75 - 15.2; 43s: chart 2.6 and 4.7 - 11.5, ours 2.6 and
4.6 - 11.45, plus mixed play at 11.8).

Overall equilibrium figures at 10 bb without ante: the SB jams 58.3% of hands,
the BB calls 36.6%; the SB loses 0.0454 bb per hand.

### 4.2 Known equities

Exact equities over every board, from three implementations: the engine's
evaluator, the independent best-of-21 evaluator in the same crate, and
`tools/equity-check.py`, pure Python with its own evaluator and no shared code.
Win and tie board counts are identical in all three for every matchup
(`equity-checks.json`):

| matchup | boards | equity (win + tie share) | ties |
|---|---|---|---|
| AhAs vs KdKc | 1,712,304 | 81.2555% / 18.7445% | 0.3818% |
| AhKh vs QcQd (AKs vs QQ) | 1,712,304 | 46.2145% / 53.7855% | 0.3932% |
| 7c2d vs 3h2s (72o vs 32o) | 1,712,304 | 64.9480% / 35.0520% | 18.1544% |
| AhAs vs KdKc vs QhQc | 1,370,754 | 66.8679% / 18.5152% / 14.6169% | 0.3975% |
| AsKs vs QhQd vs JcTc | 1,370,754 | 40.2092% / 41.0545% / 18.7363% | 0.2285% |

Outright wins in the first line: AA 81.06%, KK 18.55%. The class-level table
used heads-up (e.g. AA vs KK over all 36 suit combinations) is checked against
direct enumeration of each combo pair in the unit tests.

### 4.3 Conservation of chips and points

Checked at three levels:

1. Every entry of every payoff table (unit test `payoffs_conserve_chips_and_points`):
   for 3 and 6 players, all three ante modes, chips and points, every possible
   end of the hand and every ordering of the hands at showdown, the payoffs add
   up to 0 bb or to the points on offer (15 + 8 + ... for the open places)
   within 1e-9.
2. Every deal of every Monte Carlo solve (the actual deal valued with all
   players' strategies, every iteration and every evaluation sample): over the
   60 Monte Carlo spots of the first batch, 240 million evaluation deals
   alone, the largest deviation of the sum of all players' payoffs from 0 bb /
   the total points is 4.3e-14 (floating-point rounding).
3. The independent re-check (own side-pot and ICM code, section 4.4): largest
   per-deal deviation 1.5e-13.


### 4.4 Independent re-check by a second method

`pushfold verify` re-computes a solved spot by a second method written
separately from the solver: a plain simulation with its own random generator
(PCG32) and dealing, its own posting, side-pot settlement (pots peeled off the
smallest all-in) and ICM (explicit sum over every finishing order instead of
the solver's subset recursion), the independent best-of-21 hand evaluator, and
hand classes looked up by name in the solution's class list. For every deal it
plays the hand with actions drawn from the strategies, and for every player at
the decision he reached it values both of his actions exactly over the later
players' mixed strategies. Per decision and class this gives a plain
best-response computation against the final strategies, independent of the
solver's hero enumeration and payoff tables.

It compares, for every decision point and class reached in at least 200 deals,
the EV difference (all-in minus fold) with the solver's, as z = difference /
combined standard error; it compares every player's EV per hand; and it
computes each player's best-response gain, both plug-in (biased upward by its
own sampling noise) and cross-fitted (action chosen on one half of the deals,
valued on the other).

| spot | deals | time | cells compared | z mean | z sd | share \|z\| > 3 | weighted mean EV-diff difference (bb or points) | player EVs: largest \|z\| | best-response gain, max over seats: plug-in / cross-fit | solver: exploitability (eval) |
|---|---|---|---|---|---|---|---|---|---|---|
| `chips-n3-10bb` | 10M | 175 s | 1014 | +0.040 | 1.035 | 0.30% | +0.0024 ± 0.0016 | 1.49 | 0.00064 / -0.00003 | 0.00007 |
| `chips-n6-10bb` | 10M | 343 s | 6827 | -0.013 | 0.994 | 0.29% | -0.0004 ± 0.0012 | 1.48 | 0.00474 / -0.00029 | 0.00043 |
| `points-n3-btn10-sb8-bb12` | 10M | 178 s | 1014 | +0.058 | 1.005 | 0.10% | +0.0006 ± 0.0005 | 2.18 | 0.00016 / -0.00011 | 0.00003 |
| `points-n6-utg12-hj8-co10-btn6-sb14-bb10` | 10M | 392 s | 6732 | +0.002 | 1.004 | 0.36% | +0.0001 ± 0.0003 | 0.47 | 0.00029 / -0.00004 | 0.00004 |
| `points-n6-utg12-hj8-co10-btn6-sb14-bb10`, second run (new seed) | 30M | 322 s | 6790 | +0.014 | 0.978 | 0.25% | +0.0001 ± 0.0002 | 0.83 | 0.00008 / -0.00005 | 0.00004 |

Reading: the z-scores are distributed as sampling noise predicts (mean near 0,
standard deviation near 1, about 0.3% beyond 3; one cell beyond 4 in the five
runs, re-tested below), so the
solver's EV differences per decision and class agree with the second method
within the stated errors, for chips and for ICM points, 3 and 6 players; the
weighted mean difference (weights: share of hands reaching the cell) shows no
offset, and the players' EVs agree. The plain best response is limited by its
own noise: without hero enumeration its per-class EVs carry errors of several
hundredths of a big blind, more at rare decisions, so its plug-in gain is
inflated (most for the 6-handed big blind with his 31 decision points) and its
cross-fitted gain scatters below zero. It finds no gain beyond that noise; the
tight exploitability figures come from the solver's own evaluation, whose EVs
the per-class comparison confirms.

One cell of the first 6-handed points run fell outside 4 standard errors: CO
facing UTG's jam and HJ's call with 52o (a fold), verifier -2.957 points from
1,055 deals against the solver's -2.516 +- 0.015, z = -4.35. With about 6,800
cells per run, a value that extreme is expected roughly once in ten runs, so it
was re-tested rather than accepted or dismissed: the solver's EVs on a fresh
sample of 8 million deals give -2.531 +- 0.011, and the verifier with another
seed and 30 million deals gives -2.625 +- 0.063 (3,100 deals in that cell),
z = -1.7, with no cell beyond 4 in that run (the last row of the table).
Reports: `data/tournament/validation/verify-*.json`.


### 4.5 The Monte Carlo engine against the exact heads-up engine

Heads-up is solved exactly, so it measures the Monte Carlo engine directly:

- **Same strategies, both engines.** The exact 10 bb (no ante) equilibrium,
  valued by the Monte Carlo engine on 1,000,000 deals: over the 2 x 169 EV
  differences, z against the exact values has mean +0.016 (SB) / +0.006 (BB),
  largest |z| 2.76; the SB's EV per hand -0.0486 ± 0.0035 bb
  against the exact -0.0454 bb (`mc-vs-exact-hu10.json`).
- **Standard errors are calibrated.** 20 independent evaluations of that
  equilibrium (256,000 deals each): the spread of the 20 estimates of each EV
  difference divided by the reported standard error has median 1.01 (SB) and
  0.97 (BB) (about 0.98 expected for 20 samples);
  z against the exact values: root mean square 1.05 / 1.04, beyond 2: 6.0% / 6.0%
  (4.6% expected), beyond 3: 0.53% / 0.53% (0.27% expected). So the
  reported standard errors are right to within about 5%, with slightly heavier
  tails than a normal distribution: read 2 standard errors as roughly a 94%
  interval rather than 95%. The mean z (+0.12 / +0.21) is not significant
  (t = 1.1 and 1.6 across the 20 seeds): no detectable bias.
  SB EV per hand: mean of the 20 estimates -0.0431 (exact -0.0454),
  their spread 0.0107 against a reported standard error of 0.0090
  (`mc-se-calibration.json`).
- **ICM and unequal stacks.** A unit test values the exact equilibrium of a
  points spot with stacks 7 and 13 bb and antes with the Monte Carlo engine and
  requires agreement within the standard errors.
- **Solving, not just valuing.** Solving heads-up 10 bb with the Monte Carlo
  engine alone (no exact equities; 100,000 deals, 40 iterations, no refinement
  phase) gives an SB jam range of 58.4% and a BB call range of 36.6% against
  the exact 58.3% and 36.6%.


### 4.6 Why complete deals: the size of the folded players' card removal

`pushfold bunching` takes a solved spot and recomputes two decisions, the SB's
first-in jam and the BB's call of it after everybody else folded, in the model
that ignores the folded players' cards: exact heads-up equities from a deck
without them, the BB's hand uniform given the SB's, the same strategies and
payoffs. It reports how far that model's EV difference (all-in minus fold) is
from the solver's full-deal value, per class (combo-weighted mean and maximum),
and for how many classes the better action flips (only counting classes whose
full-deal EV difference is more than two standard errors from zero). The
heads-up row is the control: with nobody folded the two models are the same
game and agree within the Monte Carlo error.

| spot | folded players | SB jam: mean / max shift of EV difference | SB classes whose better action flips | BB call: mean / max shift | BB classes whose better action flips |
|---|---|---|---|---|---|
| heads-up 10 bb, no ante (control) | 0 | 0.004 / 0.014 bb | 0 | 0.008 / 0.025 | 0 |
| `chips-n3-10bb` | 1 | 0.051 / 0.090 bb | 7 | 0.054 / 0.106 | 0 |
| `chips-n4-10bb` | 2 | 0.092 / 0.165 bb | 16 | 0.110 / 0.221 | 3 |
| `chips-n5-10bb` | 3 | 0.136 / 0.247 bb | 22 | 0.158 / 0.323 | 3 |
| `chips-n6-10bb` | 4 | 0.176 / 0.311 bb | 26 | 0.195 / 0.385 | 3 |
| `chips-n6-6bb` | 4 | 0.157 / 0.286 bb | 22 | 0.148 / 0.283 | 10 |
| `points-n6-utg12-hj8-co10-btn6-sb14-bb10` | 4 | 0.056 / 0.085 points | 8 | 0.074 / 0.151 | 1 |

The effect grows with the number of folded players and is far above the
accuracy target, which is why the engine works with complete deals rather
than independent ranges. Reports: `data/tournament/validation/bunching-*.json`.


### 4.7 Unit tests

`cargo test --release --manifest-path pushfold/Cargo.toml` (20 tests, about 10 s):

| area | tests |
|---|---|
| hand classes | grid order and names match `web/js/poker.js` (AA, AKs, AKo, A2s, A2o, 32s, 32o at the right indices); 1,326 combos split 6/4/12 into the 169 classes; RNG determinism and uniformity |
| evaluator | hand-picked categories (wheel, three pairs, two trips, ...); agreement in ordering with the independent best-of-21 evaluator on 300,000 random boards with two hands each; all 133,784,560 seven-card hands: category counts equal the published ones and exactly 4,824 distinct values |
| ICM | heads-up is linear in chips; a three-player case checked by hand (50/30/20 with 15/8/5); equal stacks split evenly; players busting in the same hand ranked by starting stack, ties sharing places, a lone survivor winning |
| posting | per-player antes (all fold: BB wins five antes and the SB), big blind ante (blind first, then ante; none heads-up), stacks shorter than their forced bets (all-in by posting, no decision) |
| seat order | seat names and the number of decision points for every N = 2..6 (2, 6, 14, 30, 62) |
| side pots | three-way all-in with unequal stacks under four hand orderings including a split main pot; antes plus an uncalled excess; the big blind ante as dead money; payoffs sum to 0 bb (chips) or to the points on offer for every end of the hand and every hand ordering, for 3 and 6 players, all ante modes, chips and points |
| heads-up tables | 134,459 board classes covering all 2,598,960 boards; class-pair equities equal direct enumeration (AA vs KK over its 36 suit combinations) |
| Monte Carlo engine | values the exact heads-up equilibrium of an ICM spot (7 vs 13 bb, antes) within its own standard errors (rms z < 1.5, max \|z\| < 5, player EVs within 4 SE) |



## 5. Output format

One JSON file per spot (`data/tournament/spots/<name>.json`):

| field | meaning |
|---|---|
| `engine` | name and version |
| `spec` | the input spec, with defaults filled in |
| `seats`, `stacks` | action order and stacks (bb, before posting) |
| `posted` | per seat: `live` and `dead` forced bets, `allin_by_posting` |
| `units`, `ev_definition` | `bb` or `points`, and what an EV is |
| `class_order`, `classes` | the 169 classes in the project's grid order: index 13*i+j with R = "AKQJT98765432": i == j the pair, i < j suited R[i]R[j]s, i > j offsuit R[j]R[i]o (as in `data/ranges.json` and `web/js/poker.js`; `classes` lists the names) |
| `player_ev`, `player_ev_se` | each seat's EV per hand under the solution |
| `decisions[]` | one entry per decision point, see below |
| `exploitability` | `solved_game_per_seat`/`_max`, `eval_per_seat`/`_max`, `eval_se_per_seat`, `eval_crossfit_per_seat`/`_max`, `target`, `units` |
| `accuracy` | `method`, `equity_method`, `max_ev_diff_se` (largest SE of an EV difference for classes that reach a decision at least 1% of the time, at decisions reached in at least 1% of hands), sample sizes, seed, batches, `max_conservation_error`, phase iterations, `convergence` history |
| `iterations`, `seconds` | CFR iterations and wall time |

Each `decisions[]` entry:

| field | meaning |
|---|---|
| `id` | `SB_open` (unopened), `BB_vs_CO_SB` (facing all-ins from CO and SB) |
| `seat`, `position`, `facing` | who decides, his index in action order, the earlier all-ins |
| `allin_action` | `jam` (unopened) or `call` |
| `reach` | probability per hand that this decision is reached |
| `allin_pct` | percentage of the hands reaching this decision that go all-in (classes weighted by combos x `class_reach`) |
| `freq[169]` | probability of going all-in, per class |
| `ev_fold[169]`, `ev_allin[169]`, `ev_diff[169]` | EV of each action and the difference (all-in minus fold) |
| `ev_diff_se[169]` | standard error of `ev_diff` |
| `class_reach[169]` | probability that the decision is reached when holding the class |
| `samples[169]` | reach-weighted number of deals behind the class's EVs (Monte Carlo; `null` heads-up, where EVs are exact) |

A class that never reaches a decision has `null` EVs.

**Using the numbers in a quiz.** For a decision point and a hand class, the
better action is the one with the higher EV (`ev_diff` > 0: go all-in). A
mistake costs |`ev_diff`| (bb or points) against these opponents. Its
uncertainty is `ev_diff_se`, so quote 2 x `ev_diff_se` with it. When the
solution plays the class mixed (0 < `freq` < 1), or |`ev_diff`| is within
about two standard errors of zero, both actions are fine. Monte Carlo numbers
are most precise at decisions that are reached often (`reach`, and `samples`
for the class): unopened pots and single all-ins are good quiz material; the
decisions facing two or more all-ins have errors of several hundredths of a
big blind, up to about 0.1 bb for rarely reached classes.

## 6. Running it

```sh
cargo build --release --manifest-path pushfold/Cargo.toml     # cargo is ~/.cargo/bin/cargo
B=pushfold/target/release/pushfold
$B solve --spec spot.json --out out.json [--threads 6]
$B batch --specs data/tournament/specs --out-dir data/tournament/spots --summary data/tournament/batch-summary.json
$B evaluate --spec spot.json --strategy out.json --out eval.json   # value a given strategy on a fresh sample
$B verify --solution out.json --deals 10000000 --out report.json    # independent re-check (section 4.4)
$B hu-sweep --from 1 --to 20 --step 0.05 --ante 0 --out sweep.json # heads-up chart (section 4.1)
$B equity AhAs KdKc [QhQc ...] [--naive]                           # exact all-in equity
$B bunching --solution out.json --out report.json                  # folded-card effect (section 4.6)
$B reformat file.json ...                                          # rewrite JSON with one-line number arrays
cargo test --release --manifest-path pushfold/Cargo.toml           # unit tests
python3 tools/make-tournament-specs.py                             # writes the batch specs
python3 tools/compare-hune.py                                      # heads-up comparison
python3 tools/equity-check.py                                      # independent equities
python3 tools/tournament-batch-table.py                             # the table of section 7
```

`--verbose` on `batch` prints the convergence of each spot; `verify` also
takes `--seed` and `--dump-cells FILE` (every decision/class cell it
estimated).

A spec:

```json
{
 "name": "points-n4-co25-btn9-sb6-bb10",
 "players": 4,
 "stacks": [25, 9, 6, 10],
 "ante": {"mode": "per_player", "amount": 0.1},
 "payoff": {"model": "points", "payouts": [15, 8, 5, 3]},
 "accuracy": {"solve_deals": 100000, "max_iterations": 400, "refine_iterations": 150,
              "refine_deals": 100000, "eval_deals": 4000000, "seed": 1}
}
```

`ante` is `{"mode": "per_player", "amount": 0.1}`, `{"mode": "bb_ante",
"amount": 1}` or `{"mode": "none"}`; `blinds` defaults to `{"sb": 0.5, "bb": 1}`;
`payoff` is `{"model": "chips"}` or `{"model": "points", "payouts": [...]}`;
`accuracy` also takes `target_exploitability` and `method` (`auto`, `exact`
heads-up only, `mc`). Heavy runs on this Mac: `caffeinate -i nice -n 10 ...`.

## 7. The first batch

75 spots, all with blinds 0.5 / 1 and the league's 0.1 bb ante per player.
Specs in `data/tournament/specs/` (written by `tools/make-tournament-specs.py`),
solutions in `data/tournament/spots/`, a summary in
`data/tournament/batch-summary.json`.

- **Chip EV, equal stacks** (40 spots): N = 2..6 players x 4, 5, 6, 7, 8, 9,
  10, 12 bb. File `chips-n<N>-<S>bb.json`, e.g. `chips-n6-10bb.json`.
- **League points (ICM)** (35 spots): seven unequal-stack late-game situations
  per N, 30 to 90 bb on the table (12,000 chips, so a big blind of 133 to 400
  chips), every stack at most 15 bb except at most one chip leader (up to
  40 bb). The file name lists seat and stack in action order:
  `points-n4-co25-btn9-sb6-bb10.json` is CO 25, BTN 9, SB 6, BB 10 bb. Each
  spec's `note` gives the chip counts.

Heads-up spots are exact. The others use the settings of section 2: 100,000
deals and up to 400 iterations for phase 1, 150 iterations of 100,000 fresh
deals for phase 2, 4,000,000 deals for the evaluation.

**Run time** on this Mac (Apple M3, 4 performance and 4 efficiency cores),
6 threads at `nice 10` with the live site running alongside:

| spot | iterations | seconds | exploitability max over seats (plug-in / cross-fit) | target | EV-diff SE: first-in median / max; any decision max | first-in all-in % by seat |
|---|---|---|---|---|---|---|
| `chips-n2-10bb` | 2000 | 8 | 1.0e-06 (exact) | 0.00200 | exact | SB 62 |
| `chips-n2-12bb` | 2100 | 0 | 1.0e-06 (exact) | 0.00200 | exact | SB 57 |
| `chips-n2-4bb` | 1200 | 0 | 1.0e-06 (exact) | 0.00200 | exact | SB 77 |
| `chips-n2-5bb` | 1800 | 0 | 1.0e-06 (exact) | 0.00200 | exact | SB 74 |
| `chips-n2-6bb` | 1400 | 0 | 1.0e-06 (exact) | 0.00200 | exact | SB 72 |
| `chips-n2-7bb` | 1700 | 0 | 1.0e-06 (exact) | 0.00200 | exact | SB 69 |
| `chips-n2-8bb` | 1800 | 0 | 1.0e-06 (exact) | 0.00200 | exact | SB 67 |
| `chips-n2-9bb` | 1700 | 0 | 1.0e-06 (exact) | 0.00200 | exact | SB 63 |
| `chips-n3-10bb` | 210 | 78 | 0.00007 / 0.00007 | 0.00200 | 0.004 / 0.006; 0.035 | BTN 36 / SB 63 |
| `chips-n3-12bb` | 220 | 87 | 0.00005 / 0.00005 | 0.00200 | 0.004 / 0.006; 0.048 | BTN 33 / SB 58 |
| `chips-n3-4bb` | 190 | 73 | 0.00004 / 0.00003 | 0.00200 | 0.002 / 0.004; 0.009 | BTN 47 / SB 78 |
| `chips-n3-5bb` | 190 | 77 | 0.00004 / 0.00003 | 0.00200 | 0.003 / 0.004; 0.013 | BTN 44 / SB 75 |
| `chips-n3-6bb` | 190 | 69 | 0.00003 / 0.00001 | 0.00200 | 0.003 / 0.004; 0.015 | BTN 43 / SB 73 |
| `chips-n3-7bb` | 200 | 73 | 0.00002 / 0.00002 | 0.00200 | 0.003 / 0.005; 0.019 | BTN 41 / SB 70 |
| `chips-n3-8bb` | 200 | 72 | 0.00004 / 0.00002 | 0.00200 | 0.003 / 0.005; 0.023 | BTN 39 / SB 68 |
| `chips-n3-9bb` | 210 | 83 | 0.00004 / 0.00004 | 0.00200 | 0.004 / 0.006; 0.030 | BTN 37 / SB 64 |
| `chips-n4-10bb` | 230 | 104 | 0.00015 / 0.00008 | 0.00200 | 0.004 / 0.007; 0.057 | CO 30 / BTN 36 / SB 64 |
| `chips-n4-12bb` | 240 | 98 | 0.00016 / 0.00012 | 0.00200 | 0.005 / 0.007; 0.074 | CO 27 / BTN 34 / SB 59 |
| `chips-n4-4bb` | 190 | 86 | 0.00009 / 0.00005 | 0.00200 | 0.003 / 0.005; 0.030 | CO 40 / BTN 48 / SB 78 |
| `chips-n4-5bb` | 200 | 83 | 0.00010 / 0.00006 | 0.00200 | 0.003 / 0.006; 0.046 | CO 37 / BTN 46 / SB 76 |
| `chips-n4-6bb` | 200 | 89 | 0.00010 / 0.00006 | 0.00200 | 0.003 / 0.006; 0.065 | CO 34 / BTN 44 / SB 74 |
| `chips-n4-7bb` | 210 | 89 | 0.00010 / 0.00008 | 0.00200 | 0.004 / 0.007; 0.034 | CO 34 / BTN 42 / SB 71 |
| `chips-n4-8bb` | 220 | 89 | 0.00012 / 0.00006 | 0.00200 | 0.004 / 0.007; 0.043 | CO 32 / BTN 39 / SB 68 |
| `chips-n4-9bb` | 220 | 88 | 0.00011 / 0.00008 | 0.00200 | 0.004 / 0.007; 0.050 | CO 32 / BTN 37 / SB 65 |
| `chips-n5-10bb` | 240 | 109 | 0.00022 / 0.00017 | 0.00200 | 0.005 / 0.008; 0.070 | HJ 25 / CO 31 / BTN 37 / SB 65 |
| `chips-n5-12bb` | 260 | 118 | 0.00022 / 0.00015 | 0.00200 | 0.005 / 0.008; 0.098 | HJ 21 / CO 29 / BTN 35 / SB 60 |
| `chips-n5-4bb` | 200 | 101 | 0.00025 / 0.00007 | 0.00200 | 0.003 / 0.006; 0.045 | HJ 35 / CO 40 / BTN 50 / SB 80 |
| `chips-n5-5bb` | 210 | 109 | 0.00026 / 0.00008 | 0.00200 | 0.003 / 0.006; 0.068 | HJ 32 / CO 38 / BTN 47 / SB 76 |
| `chips-n5-6bb` | 210 | 106 | 0.00025 / 0.00017 | 0.00200 | 0.004 / 0.007; 0.034 | HJ 32 / CO 35 / BTN 45 / SB 74 |
| `chips-n5-7bb` | 220 | 112 | 0.00028 / 0.00017 | 0.00200 | 0.004 / 0.007; 0.043 | HJ 30 / CO 34 / BTN 43 / SB 72 |
| `chips-n5-8bb` | 230 | 117 | 0.00027 / 0.00016 | 0.00200 | 0.004 / 0.007; 0.054 | HJ 28 / CO 33 / BTN 40 / SB 70 |
| `chips-n5-9bb` | 240 | 122 | 0.00022 / 0.00016 | 0.00200 | 0.004 / 0.008; 0.059 | HJ 26 / CO 32 / BTN 38 / SB 66 |
| `chips-n6-10bb` | 260 | 145 | 0.00043 / 0.00030 | 0.00200 | 0.005 / 0.011; 0.086 | UTG 20 / HJ 25 / CO 31 / BTN 37 / SB 65 |
| `chips-n6-12bb` | 270 | 152 | 0.00043 / 0.00030 | 0.00200 | 0.005 / 0.011; 0.118 | UTG 18 / HJ 22 / CO 30 / BTN 36 / SB 62 |
| `chips-n6-4bb` | 200 | 117 | 0.00059 / 0.00031 | 0.00200 | 0.004 / 0.008; 0.052 | UTG 32 / HJ 36 / CO 41 / BTN 50 / SB 80 |
| `chips-n6-5bb` | 210 | 123 | 0.00063 / 0.00039 | 0.00200 | 0.004 / 0.008; 0.048 | UTG 29 / HJ 33 / CO 38 / BTN 48 / SB 77 |
| `chips-n6-6bb` | 220 | 121 | 0.00055 / 0.00033 | 0.00200 | 0.004 / 0.008; 0.042 | UTG 28 / HJ 32 / CO 36 / BTN 45 / SB 75 |
| `chips-n6-7bb` | 240 | 128 | 0.00049 / 0.00027 | 0.00200 | 0.005 / 0.008; 0.058 | UTG 25 / HJ 31 / CO 35 / BTN 43 / SB 72 |
| `chips-n6-8bb` | 240 | 128 | 0.00046 / 0.00029 | 0.00200 | 0.005 / 0.009; 0.063 | UTG 24 / HJ 29 / CO 33 / BTN 41 / SB 70 |
| `chips-n6-9bb` | 250 | 133 | 0.00039 / 0.00022 | 0.00200 | 0.005 / 0.010; 0.074 | UTG 22 / HJ 27 / CO 32 / BTN 39 / SB 67 |
| `points-n2-sb10-bb40` | 800 | 0 | 1.0e-06 (exact) | 0.00028 | exact | SB 62 |
| `points-n2-sb12-bb18` | 1000 | 0 | 1.0e-06 (exact) | 0.00047 | exact | SB 57 |
| `points-n2-sb18-bb12` | 1000 | 0 | 1.0e-06 (exact) | 0.00047 | exact | SB 57 |
| `points-n2-sb27-bb8` | 900 | 0 | 1.0e-06 (exact) | 0.00040 | exact | SB 67 |
| `points-n2-sb35-bb5` | 800 | 0 | 1.0e-06 (exact) | 0.00035 | exact | SB 74 |
| `points-n2-sb5-bb35` | 800 | 0 | 1.0e-06 (exact) | 0.00035 | exact | SB 74 |
| `points-n2-sb8-bb27` | 900 | 0 | 1.0e-06 (exact) | 0.00040 | exact | SB 67 |
| `points-n3-btn10-sb8-bb12` | 210 | 76 | 0.00003 / 0.00002 | 0.00067 | 0.001 / 0.002; 0.011 | BTN 35 / SB 60 |
| `points-n3-btn12-sb9-bb24` | 210 | 82 | 0.00002 / 0.00002 | 0.00044 | 0.001 / 0.001; 0.010 | BTN 28 / SB 51 |
| `points-n3-btn15-sb5-bb10` | 200 | 80 | 0.00001 / 0.00000 | 0.00067 | 0.001 / 0.002; 0.006 | BTN 57 / SB 71 |
| `points-n3-btn22-sb8-bb6` | 210 | 79 | 0.00001 / 0.00001 | 0.00056 | 0.001 / 0.002; 0.009 | BTN 59 / SB 73 |
| `points-n3-btn4-sb14-bb30` | 210 | 75 | 0.00001 / 0.00001 | 0.00042 | 0.001 / 0.001; 0.005 | BTN 35 / SB 32 |
| `points-n3-btn6-sb12-bb14` | 230 | 82 | 0.00003 / 0.00001 | 0.00063 | 0.001 / 0.002; 0.010 | BTN 31 / SB 56 |
| `points-n3-btn7-sb25-bb8` | 210 | 77 | 0.00001 / 0.00001 | 0.00050 | 0.001 / 0.001; 0.009 | BTN 24 / SB 100 |
| `points-n4-co10-btn10-sb8-bb12` | 230 | 94 | 0.00003 / 0.00003 | 0.00060 | 0.001 / 0.002; 0.028 | CO 29 / BTN 40 / SB 63 |
| `points-n4-co12-btn9-sb30-bb9` | 220 | 90 | 0.00002 / 0.00001 | 0.00040 | 0.001 / 0.001; 0.016 | CO 20 / BTN 28 / SB 100 |
| `points-n4-co14-btn13-sb12-bb11` | 240 | 98 | 0.00004 / 0.00003 | 0.00048 | 0.001 / 0.002; 0.036 | CO 26 / BTN 39 / SB 70 |
| `points-n4-co15-btn5-sb12-bb8` | 210 | 87 | 0.00003 / 0.00001 | 0.00060 | 0.001 / 0.002; 0.018 | CO 45 / BTN 31 / SB 89 |
| `points-n4-co25-btn9-sb6-bb10` | 220 | 90 | 0.00003 / 0.00002 | 0.00048 | 0.001 / 0.003; 0.015 | CO 64 / BTN 41 / SB 66 |
| `points-n4-co7-btn26-sb11-bb6` | 220 | 90 | 0.00002 / 0.00002 | 0.00048 | 0.001 / 0.002; 0.017 | CO 22 / BTN 69 / SB 83 |
| `points-n4-co8-btn14-sb3-bb35` | 230 | 93 | 0.00002 / 0.00001 | 0.00040 | 0.001 / 0.001; 0.013 | CO 18 / BTN 22 / SB 64 |
| `points-n5-hj10-co8-btn12-sb6-bb14` | 240 | 111 | 0.00004 / 0.00003 | 0.00052 | 0.001 / 0.002; 0.024 | HJ 24 / CO 29 / BTN 47 / SB 63 |
| `points-n5-hj12-co11-btn9-sb15-bb13` | 240 | 111 | 0.00003 / 0.00002 | 0.00043 | 0.001 / 0.002; 0.031 | HJ 21 / CO 26 / BTN 35 / SB 82 |
| `points-n5-hj15-co12-btn5-sb10-bb8` | 230 | 106 | 0.00002 / 0.00001 | 0.00052 | 0.001 / 0.003; 0.026 | HJ 34 / CO 41 / BTN 35 / SB 81 |
| `points-n5-hj28-co10-btn12-sb6-bb4` | 220 | 102 | 0.00002 / 0.00001 | 0.00043 | 0.001 / 0.003; 0.021 | HJ 45 / CO 30 / BTN 50 / SB 79 |
| `points-n5-hj3-co15-btn13-sb14-bb15` | 240 | 111 | 0.00005 / 0.00004 | 0.00043 | 0.001 / 0.002; 0.025 | HJ 27 / CO 29 / BTN 33 / SB 67 |
| `points-n5-hj6-co12-btn14-sb9-bb34` | 270 | 123 | 0.00004 / 0.00003 | 0.00035 | 0.001 / 0.002; 0.019 | HJ 22 / CO 21 / BTN 30 / SB 43 |
| `points-n5-hj9-co30-btn7-sb12-bb12` | 240 | 111 | 0.00004 / 0.00003 | 0.00037 | 0.001 / 0.003; 0.024 | HJ 19 / CO 60 / BTN 34 / SB 74 |
| `points-n6-utg12-hj8-co10-btn6-sb14-bb10` | 250 | 134 | 0.00004 / 0.00003 | 0.00047 | 0.001 / 0.003; 0.026 | UTG 24 / HJ 25 / CO 34 / BTN 34 / SB 91 |
| `points-n6-utg15-hj12-co5-btn10-sb8-bb10` | 250 | 162 | 0.00003 / 0.00003 | 0.00047 | 0.002 / 0.004; 0.028 | UTG 31 / HJ 34 / CO 31 / BTN 50 / SB 67 |
| `points-n6-utg15-hj13-co11-btn9-sb7-bb5` | 260 | 153 | 0.00002 / 0.00002 | 0.00047 | 0.001 / 0.003; 0.028 | UTG 27 / HJ 31 / CO 37 / BTN 46 / SB 82 |
| `points-n6-utg30-hj10-co12-btn6-sb8-bb14` | 240 | 137 | 0.00002 / 0.00002 | 0.00035 | 0.001 / 0.003; 0.025 | UTG 44 / HJ 25 / CO 40 / BTN 36 / SB 60 |
| `points-n6-utg5-hj7-co9-btn11-sb13-bb15` | 290 | 156 | 0.00004 / 0.00003 | 0.00047 | 0.001 / 0.003; 0.028 | UTG 21 / HJ 21 / CO 25 / BTN 34 / SB 70 |
| `points-n6-utg6-hj10-co14-btn12-sb8-bb40` | 290 | 155 | 0.00004 / 0.00003 | 0.00031 | 0.001 / 0.002; 0.022 | UTG 18 / HJ 19 / CO 23 / BTN 30 / SB 46 |
| `points-n6-utg8-hj14-co9-btn32-sb11-bb6` | 260 | 139 | 0.00002 / 0.00002 | 0.00035 | 0.001 / 0.003; 0.029 | UTG 17 / HJ 21 / CO 26 / BTN 68 / SB 85 |

spots: 75, total solver time 6290 s (104.8 min); worst Monte Carlo plug-in exploitability 0.00063, worst cross-fit 0.00039; max per-deal conservation error 4.3e-14
Every spot is inside its target: the largest plug-in exploitability relative
to its target is 32% (`chips-n6-5bb`: 0.00063 bb per hand, cross-fit
0.00039 bb); the points spots are all below 13% of theirs (at most 0.00005
points per hand).

| players | spots | mean seconds per spot | total minutes |
|---|---|---|---|
| 2 | 15 | 1 | 0.1 |
| 3 | 15 | 77 | 19.4 |
| 4 | 15 | 91 | 22.8 |
| 5 | 15 | 111 | 27.8 |
| 6 | 15 | 139 | 34.7 |

Columns: exploitability is the largest over the seats, per hand, on the
independent evaluation sample, plug-in and cross-fitted (section 3), in bb for
`chips` spots and points for `points` spots; the target column is in the same
units. The standard-error column gives the standard error of `ev_diff` in the
same units: median and maximum over the classes at the first-in decisions,
then the maximum over all decisions reached in at least 1% of hands (classes
reaching them at least 1% of the time). First-in all-in % is the share of hands
each seat jams when everybody before him has folded.


### The quiz questions

`data/tournament/quiz.json` fixes the 50 questions of the site's Tournament
quiz: five sets of ten (heads-up; first in and facing an all-in in chip EV;
the same two in league points). `tools/make-tournament-quiz.py` chooses them
from the solved spots with a fixed seed. A question is a spot, a decision and
a hand class; the answer and all numbers shown are read from the spot file.
A hand qualifies only if the decision is a first-in jam or faces exactly one
all-in (reached in at least 2% of hands), the solution plays the hand pure, and
the EV difference between the two actions is at least five standard errors and
between 0.08 and 0.50 bb (for points spots the same converted at first place
minus last place over the big blinds on the table): clear, but not a hand
everybody knows. Each set has five all-in and five fold answers, and no hand
class appears twice in the quiz. Re-run the tool after re-solving spots.

## 8. Limits and caveats

1. **Push/fold is a model.** The numbers are exact, within the stated errors,
   for the game in which every player may only fold or go all-in. Real
   no-limit hold'em also allows limps and smaller raises, which this engine does
   not model, so how well the push/fold equilibrium approximates real play
   depends on the stack depth, and this engine cannot measure that by itself.
   The established result is heads-up: Miltersen and Sørensen (AAMAS 2007,
   "A near-optimal strategy for a heads-up no-limit Texas Hold'em poker
   tournament") computed the optimal jam/fold strategy for the heads-up endgame
   of a sit-and-go with blinds 300/600 and 8,000 chips in play (effective stacks
   up to about 6.7 bb) and showed it is near-optimal in the unrestricted game;
   Ganzfried and Sandholm (AAMAS 2008) extended the jam/fold approach to three
   players. Beyond that, common practice (not something this engine measured)
   uses push/fold charts up to about 10 bb, while between about 10 and 15 bb
   small raises and limps take over part of the range, more so from early
   positions and the small blind. So: sound as a model of real play up to
   about 8 - 10 bb effective, a simplification at 10 - 12 bb (the top of the
   Tournament mode's scope and the 12 bb column of the batch, still exact for
   the push/fold game), not recommended deeper. What matters is the effective
   stack: what a player can win or lose, his stack capped by the biggest stack
   that can still call him. A chip leader's decisions in the points spots are
   push/fold decisions at the depth of the biggest stack behind him, not of his
   own stack.
2. **Calls are all-in.** Calling commits the caller's whole stack, also when
   players are still to act behind him (isolation); he cannot flat-call a
   smaller all-in to keep chips back. This is the usual push/fold convention.
3. **ICM is a model of tournament equity.** Points are valued by
   Malmuth-Harville on the stacks right after the hand. It ignores future
   blinds, position and skill differences. Busted players are placed exactly by
   the league rule.
4. **Monte Carlo precision (3 to 6 players).** Every EV difference has a
   standard error. Measured over the chip-EV spots of the first batch, for
   classes that reach the decision at least 1% of the time: first-in decisions
   median 0.003 - 0.005 bb (3 to 6 players), largest 0.011 bb; facing one
   all-in median 0.006 - 0.010 bb, largest 0.025 bb; facing two or more
   all-ins (decisions reached in 1 - 3% of 6-handed hands) median
   0.014 - 0.029 bb, largest 0.12 bb. Every class has EVs at every decision in
   this batch (no `null`). Read the per-class `ev_diff_se` and `samples`; a
   quiz should treat a decision as close when |`ev_diff`| is within about two
   standard errors, and use the rare multi-way decision points with care.
   Heads-up values are exact.
5. **Equilibrium selection.** With three or more players an equilibrium need
   not be unique. The engine finds one (CFR+ from a uniform start, then
   averaging) and certifies it by the measured exploitability: no single player
   can gain more than that by deviating. Another equilibrium could play close
   hands differently. Collusion between players is not modelled.
6. **Mixed hands.** Near the boundary of a range a hand is often played mixed.
   Its EV difference is then about zero, so either action costs almost nothing;
   the frequency itself is not meaningful to more than about one decimal and can
   change with a small change in stacks. Published simplified charts show such
   hands as pure.
7. **Strategies per class.** All combos of a class play the same strategy. This
   is no restriction: when everybody plays by class, all combos of a class have
   the same EVs by suit symmetry.
8. **Chips are continuous.** Pots split exactly; there is no odd-chip rule.
   Stacks are in big blinds; with 12,000 chips in play the conversion is in each
   points spot's `note`.
9. **Not in the first batch:** the big blind ante variant (supported and
   tested; one example is in `data/tournament/validation/`), and spots with a
   player all-in by posting (supported and tested, none in the batch).


## 9. Files

| path | content |
|---|---|
| `pushfold/src/cards.rs` | cards, combos, the 169 classes in grid order, seeded RNG |
| `pushfold/src/eval.rs` | fast 7-card evaluator, independent best-of-21 reference evaluator, exhaustive tests |
| `pushfold/src/game.rs` | spec, seats, posting, decision points, side pots, payoff tables |
| `pushfold/src/icm.rs` | Malmuth-Harville and the league's bust rule |
| `pushfold/src/hu.rs` | exact heads-up equities (class pairs over all boards) and the exact heads-up solver |
| `pushfold/src/mc.rs` | Monte Carlo over complete deals with hero enumeration |
| `pushfold/src/solve.rs` | CFR+ phases, evaluation, exploitability, standard errors |
| `pushfold/src/solution.rs` | the output JSON |
| `pushfold/src/verify.rs` | the independent re-check (second method) |
| `pushfold/src/validate.rs` | exact equities, heads-up sweep, folded-card measurement |
| `data/tournament/specs/` | the 75 specs of the first batch (`tools/make-tournament-specs.py`) |
| `data/tournament/spots/` | the 75 solutions |
| `data/tournament/batch-summary.json` | per spot: time, iterations, exploitability, largest standard error |
| `data/tournament/validation/` | everything in section 4, and the big blind ante example |
| `tools/compare-hune.py`, `tools/equity-check.py`, `tools/tournament-batch-table.py` | validation and reporting scripts |
| `tools/make-tournament-quiz.py`, `data/tournament/quiz.json` | the 50 fixed quiz questions and the tool that chooses them |
