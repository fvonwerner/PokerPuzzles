#!/usr/bin/env python3
"""Write the first batch of tournament push/fold spot specs to data/tournament/specs/.

Chip EV: N = 2..6 players, equal stacks of 4, 5, 6, 7, 8, 9, 10, 12 bb.
Points (ICM, league payouts 15/8/5/3/2/1, first N places open): seven unequal-stack
late-game situations per N. Total chips at the table are 12,000; the late levels
have about 30 to 90 big blinds on the table, so 1 bb = 12000 / total_bb chips.
All stacks are at most 15 bb except at most one chip leader.
Every spot: blinds 0.5/1, every player posts a 0.1 bb ante.

Usage: python3 tools/make-tournament-specs.py   (from the repository root)
"""
import json
import os

SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "tournament", "specs")

# Monte Carlo accuracy settings for 3+ players (heads-up is solved exactly).
ACCURACY = {
    "solve_deals": 100000,      # fixed sample for the first CFR+ phase
    "max_iterations": 400,      # cap on that phase
    "refine_iterations": 150,   # then 150 iterations on fresh samples, averaged
    "refine_deals": 100000,
    "eval_deals": 4000000,      # independent sample for EVs, errors, exploitability
    "seed": 1,
}

POINTS = {
    2: [[12, 18], [18, 12], [8, 27], [27, 8], [5, 35], [35, 5], [10, 40]],
    3: [[10, 8, 12], [15, 5, 10], [6, 12, 14], [22, 8, 6], [7, 25, 8], [12, 9, 24], [4, 14, 30]],
    4: [[10, 10, 8, 12], [15, 5, 12, 8], [25, 9, 6, 10], [7, 26, 11, 6], [12, 9, 30, 9],
        [8, 14, 3, 35], [14, 13, 12, 11]],
    5: [[10, 8, 12, 6, 14], [15, 12, 5, 10, 8], [28, 10, 12, 6, 4], [9, 30, 7, 12, 12],
        [12, 11, 9, 15, 13], [6, 12, 14, 9, 34], [3, 15, 13, 14, 15]],
    6: [[12, 8, 10, 6, 14, 10], [15, 12, 5, 10, 8, 10], [30, 10, 12, 6, 8, 14],
        [8, 14, 9, 32, 11, 6], [5, 7, 9, 11, 13, 15], [15, 13, 11, 9, 7, 5],
        [6, 10, 14, 12, 8, 40]],
}


def fmt(x):
    s = ("%g" % x).replace(".", "p")
    return s


def write(name, spec):
    with open(os.path.join(OUT, name + ".json"), "w") as f:
        json.dump(spec, f, indent=1)
        f.write("\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    n_written = 0
    for n in range(2, 7):
        for s in [4, 5, 6, 7, 8, 9, 10, 12]:
            name = "chips-n%d-%sbb" % (n, fmt(s))
            write(name, {"name": name, "players": n, "stacks": [s] * n,
                         "ante": {"mode": "per_player", "amount": 0.1},
                         "payoff": {"model": "chips"}, "accuracy": ACCURACY})
            n_written += 1
    for n, spots in POINTS.items():
        seats = SEATS[6 - n:]
        for stacks in spots:
            assert len(stacks) == n
            total = sum(stacks)
            assert 30 <= total <= 90, (n, stacks)
            assert sum(1 for x in stacks if x > 15) <= 1, (n, stacks)
            name = "points-n%d-" % n + "-".join("%s%s" % (seat.lower(), fmt(x)) for seat, x in zip(seats, stacks))
            chips = 12000 / total
            note = ("%d bb on the table: 12,000 chips, big blind %g chips; stacks in chips %s"
                    % (total, round(chips, 2), ", ".join("%s %d" % (seat, round(x * chips)) for seat, x in zip(seats, stacks))))
            write(name, {"name": name, "note": note, "players": n, "stacks": stacks,
                         "ante": {"mode": "per_player", "amount": 0.1},
                         "payoff": {"model": "points", "payouts": [15, 8, 5, 3, 2, 1][:n]},
                         "accuracy": ACCURACY})
            n_written += 1
    print("wrote %d specs to %s" % (n_written, os.path.normpath(OUT)))


if __name__ == "__main__":
    main()
