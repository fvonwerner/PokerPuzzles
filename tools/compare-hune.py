#!/usr/bin/env python3
"""Compare the exact heads-up push/fold solution (pushfold hu-sweep) with the
published HoldemResources HUNE chart values.

Inputs (data/tournament/validation/):
  hune-reference-no-ante.json, hune-reference-ante10.json   published cells
  hu-sweep-no-ante.json, hu-sweep-ante10.json                our sweep, 0.05 bb grid
Output: hune-comparison.json

A published cell is the highest stack at which the hand is played. Ours is the
top of the highest stack interval where the hand is played with frequency >= 0.5.
Verdicts: "match" (equal, or within the 0.05 bb grid step), "inside mixing"
(the published value lies in a stack range where our exact solution plays the
hand mixed, 0.05 < freq < 0.95, or is the top of our pure region with only mixed
play above it; the published charts omit mixing by design), "mismatch" otherwise.
"""
import json
import os

D = os.path.join(os.path.dirname(__file__), "..", "data", "tournament", "validation")


def load(name):
    with open(os.path.join(D, name)) as f:
        return json.load(f)


def ours(iv):
    if not iv:
        return 0.0
    return "20+" if iv[-1][1] >= 20.0 else iv[-1][1]


def mixed_ranges(mixed, hand, step=0.05):
    pts = sorted(s for s, h, f in mixed if h == hand)
    ranges = []
    for s in pts:
        if ranges and s - ranges[-1][1] <= step * 1.5:
            ranges[-1][1] = s
        else:
            ranges.append([s, s])
    return ranges


def compare(tag, ref, sw):
    rows = []
    for side, key, mkey in [("pusher", "sb_jam_intervals", "sb_mixed"), ("caller", "bb_call_intervals", "bb_mixed")]:
        for hand, v in ref[side].items():
            o = ours(sw[key][hand])
            if v == "20+" or o == "20+":
                verdict = "match" if v == o else "mismatch"
                diff = None
            else:
                diff = round(o - v, 3)
                if abs(diff) <= 0.051:
                    verdict = "match"
                else:
                    verdict = "mismatch"
                    mr = mixed_ranges(sw[mkey], hand)
                    for lo, hi in mr:
                        if lo - 0.051 <= v <= hi + 0.051:
                            verdict = "inside mixing"
                    # published value = top of our pure region, with only mixed
                    # play (no pure play) above it
                    iv = sw[key][hand]
                    if verdict == "mismatch" and iv and abs(iv[0][1] - v) <= 0.051 and mr and mr[0][0] > iv[0][1]:
                        verdict = "inside mixing"
            rows.append({"side": side, "hand": hand, "published": v, "ours": o, "diff": diff,
                         "verdict": verdict,
                         "our_intervals": sw[key][hand],
                         "our_mixed_ranges": mixed_ranges(sw[mkey], hand)})
    gaps = []
    for hand, text in ref.get("pusher_gaps", {}).items():
        gaps.append({"hand": hand, "published": text, "our_intervals": sw["sb_jam_intervals"][hand],
                     "our_mixed_ranges": mixed_ranges(sw["sb_mixed"], hand)})
    counts = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    return {"tab": tag, "cells_compared": len(rows), "verdicts": counts,
            "max_abs_diff_of_matches": max([abs(r["diff"]) for r in rows if r["verdict"] == "match" and r["diff"] is not None] or [0]),
            "our_max_exploitability_bb_per_hand": sw["max_exploitability_bb_per_hand"],
            "rows": rows, "gapped_hands": gaps}


def main():
    out = {"note": __doc__.strip().splitlines()[0],
           "no_ante": compare("No Ante", load("hune-reference-no-ante.json"), load("hu-sweep-no-ante.json")),
           "ante_10pct": compare("Ante 10%", load("hune-reference-ante10.json"), load("hu-sweep-ante10.json"))}
    with open(os.path.join(D, "hune-comparison.json"), "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    for k in ("no_ante", "ante_10pct"):
        c = out[k]
        print(c["tab"], c["cells_compared"], "cells:", c["verdicts"], "max |diff| of matches", c["max_abs_diff_of_matches"])
        for r in c["rows"]:
            if r["verdict"] != "match":
                print("   ", r["side"], r["hand"], "published", r["published"], "ours", r["ours"], r["verdict"], r["our_mixed_ranges"])
        for g in c["gapped_hands"]:
            print("    gap", g["hand"], g["published"], "ours", g["our_intervals"])


if __name__ == "__main__":
    main()
