#!/usr/bin/env python3
"""Independent exact all-in equities, pure Python, no code shared with pushfold.

Enumerates every board for a few matchups with a straightforward evaluator
(rank counts, flush suit, straight scan; hands compared as tuples) and prints
win / tie / equity per hand. Used to validate the Rust engine's equities
(docs/TOURNAMENT.md, validation 2).

Usage: python3 tools/equity-check.py [--out FILE]
"""
import itertools
import json
import sys
import time

RANKS = "23456789TJQKA"
SUITS = "shdc"
MATCHUPS = [["AhAs", "KdKc"], ["AhKh", "QcQd"], ["7c2d", "3h2s"], ["AhAs", "KdKc", "QhQc"], ["AsKs", "QhQd", "JcTc"]]


def card(s):
    return (RANKS.index(s[0]) + 2, SUITS.index(s[1]))


def straight_high(present):
    s = set(present)
    if 14 in s:
        s.add(1)
    for top in range(14, 4, -1):
        if all(top - i in s for i in range(5)):
            return top
    return 0


def evaluate(cards):
    counts = [0] * 15
    by_suit = [[], [], [], []]
    for r, s in cards:
        counts[r] += 1
        by_suit[s].append(r)
    for rs in by_suit:
        if len(rs) >= 5:
            rs = sorted(rs, reverse=True)
            sf = straight_high(rs)
            return (8, sf) if sf else (5,) + tuple(rs[:5])
    present = [r for r in range(14, 1, -1) if counts[r]]
    quads = [r for r in present if counts[r] == 4]
    trips = [r for r in present if counts[r] == 3]
    pairs = [r for r in present if counts[r] == 2]
    if quads:
        q = quads[0]
        return (7, q, max(r for r in present if r != q))
    if trips and (len(trips) >= 2 or pairs):
        t = trips[0]
        return (6, t, max(trips[1:] + pairs))
    st = straight_high(present)
    if st:
        return (4, st)
    if trips:
        t = trips[0]
        return (3, t) + tuple([r for r in present if r != t][:2])
    if len(pairs) >= 2:
        p1, p2 = pairs[0], pairs[1]
        return (2, p1, p2, max(r for r in present if r not in (p1, p2)))
    if pairs:
        p = pairs[0]
        return (1, p) + tuple([r for r in present if r != p][:3])
    return (0,) + tuple(present[:5])


def run(hands):
    hc = [[card(h[0:2]), card(h[2:4])] for h in hands]
    used = {c for h in hc for c in h}
    deck = [(r, s) for r in range(2, 15) for s in range(4) if (r, s) not in used]
    k = len(hands)
    win, tie, eq = [0] * k, [0] * k, [0.0] * k
    n = 0
    for board in itertools.combinations(deck, 5):
        b = list(board)
        vals = [evaluate(b + h) for h in hc]
        best = max(vals)
        w = [i for i in range(k) if vals[i] == best]
        for i in w:
            if len(w) == 1:
                win[i] += 1
            else:
                tie[i] += 1
            eq[i] += 1.0 / len(w)
        n += 1
    return {"hands": hands, "boards": n, "win": [x / n for x in win], "tie": [x / n for x in tie], "equity": [x / n for x in eq]}


def main():
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    res = []
    for m in MATCHUPS:
        t0 = time.time()
        r = run(m)
        r["seconds"] = round(time.time() - t0, 1)
        res.append(r)
        print(" vs ".join(m), r["boards"], "equity", [round(x, 6) for x in r["equity"]], "tie", [round(x, 6) for x in r["tie"]], flush=True)
    if out:
        with open(out, "w") as f:
            json.dump(res, f, indent=1)
            f.write("\n")


if __name__ == "__main__":
    main()
