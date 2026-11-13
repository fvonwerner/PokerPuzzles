#!/usr/bin/env python3
"""Markdown summary of the solved spots in data/tournament/spots/ (for docs/TOURNAMENT.md).

Per spot: method, iterations, wall time, exploitability (independent sample: plug-in
and cross-fitted; heads-up exact), the standard error of EV differences at
first-in decisions (median and max over classes) and at all decisions reached in
at least 1% of hands, and the first-in all-in percentages by seat.
"""
import glob
import json
import os
import statistics

D = os.path.join(os.path.dirname(__file__), "..", "data", "tournament", "spots")


def main():
    rows = []
    per_n = []
    tot_secs = 0.0
    worst = {"eval": 0.0, "cross": -1, "cons": 0.0}
    for p in sorted(glob.glob(os.path.join(D, "*.json"))):
        d = json.load(open(p))
        name = os.path.basename(p)[:-5]
        ex = d["exploitability"]
        acc = d["accuracy"]
        tot_secs += d["seconds"]
        per_n.append((d["spec"]["players"], d["seconds"]))
        exact = acc["method"] == "exact-hu"
        opens = [x for x in d["decisions"] if not x["facing"]]
        open_se = [s for x in opens for s, r in zip(x["ev_diff_se"], x["class_reach"]) if s is not None and r and r >= 0.01]
        common_se = [s for x in d["decisions"] if x["reach"] >= 0.01 for s, r in zip(x["ev_diff_se"], x["class_reach"]) if s is not None and r and r >= 0.01]
        opens_pct = " / ".join("%s %.0f" % (x["seat"], x["allin_pct"]) for x in opens)
        if exact:
            se_txt = "exact"
            ex_txt = "%.1e (exact)" % ex["eval_max"]
        else:
            se_txt = "%.3f / %.3f; %.3f" % (statistics.median(open_se), max(open_se), max(common_se))
            ex_txt = "%.5f / %.5f" % (ex["eval_max"], ex["eval_crossfit_max"])
            worst["eval"] = max(worst["eval"], ex["eval_max"])
            worst["cross"] = max(worst["cross"], ex["eval_crossfit_max"])
        worst["cons"] = max(worst["cons"], acc.get("max_conservation_error", 0.0) or 0.0)
        rows.append("| `%s` | %d | %.0f | %s | %s | %s | %s |" % (
            name, d["iterations"], d["seconds"], ex_txt, "%.5f" % ex["target"], se_txt, opens_pct))
    print("| spot | iterations | seconds | exploitability max over seats (plug-in / cross-fit) | target | EV-diff SE: first-in median / max; any decision max | first-in all-in % by seat |")
    print("|---|---|---|---|---|---|---|")
    for r in rows:
        print(r)
    print()
    print("spots: %d, total solver time %.0f s (%.1f min); worst Monte Carlo plug-in exploitability %.5f, worst cross-fit %.5f; max per-deal conservation error %.1e"
          % (len(rows), tot_secs, tot_secs / 60, worst["eval"], worst["cross"], worst["cons"]))
    print()
    print("| players | spots | mean seconds per spot | total minutes |")
    print("|---|---|---|---|")
    for n in range(2, 7):
        secs = [t for (k, t) in per_n if k == n]
        if secs:
            print("| %d | %d | %.0f | %.1f |" % (n, len(secs), sum(secs) / len(secs), sum(secs) / 60))


if __name__ == "__main__":
    main()
