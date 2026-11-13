#!/usr/bin/env python3
"""Choose the fixed Tournament quiz questions from the solved push/fold spots.

Input:  data/tournament/spots/*.json  (pushfold solutions, see docs/TOURNAMENT.md)
Output: data/tournament/quiz.json     (5 sets of 10 questions, the same for everyone)

A question is (spot, decision, hand class) plus two concrete cards to show.
The answer and every number shown later are read from the spot file by the
server; this file only fixes which questions are asked.

Rules for a question (so that the answer is a solver fact, not noise):
  - the decision is a first-in jam or faces exactly one all-in, and is reached
    in at least 2% of hands (heads-up and first-in: any);
  - the solution plays the hand pure (frequency >= 0.999 or <= 0.001);
  - the EV difference between the two actions is at least 5 standard errors
    and at least LO, and at most HI (clear, but not a hand everybody knows);
    LO and HI are 0.08 and 0.50 bb; for league-points spots the same in points,
    converted at (first place - last place) / (big blinds on the table).
Selection is deterministic (fixed seed) and spreads the questions over table
sizes, stacks, seats, hand types and answers (5 all-in, 5 fold per set), with
no hand class used twice in the whole quiz.

Run:  python3 tools/make-tournament-quiz.py [--print]
"""
import json
import os
import random
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SPOTS = os.path.join(ROOT, "data", "tournament", "spots")
OUT = os.path.join(ROOT, "data", "tournament", "quiz.json")
SEED = 20261112
LO, HI = 0.08, 0.50
MIN_SE_MULT = 5.0
MIN_REACH = 0.02
SUITS = "shdc"

SETS = [
    ("hu", "Heads-up", "Two players left. Small blind: jam or fold. Big blind: call or fold. Chip EV, exact.",
     dict(model="chips", players=[2], kinds=["open", "call"], per_n={2: 10})),
    ("open-chips", "First in", "Nobody has entered the pot. Jam or fold, 3 to 6 players, chip EV.",
     dict(model="chips", players=[3, 4, 5, 6], kinds=["open"], per_n={3: 2, 4: 2, 5: 3, 6: 3})),
    ("call-chips", "Facing an all-in", "One player has gone all-in before you. Call or fold, 3 to 6 players, chip EV.",
     dict(model="chips", players=[3, 4, 5, 6], kinds=["call"], per_n={3: 2, 4: 2, 5: 3, 6: 3})),
    ("open-points", "League points: first in", "Late in the game with uneven stacks. Jam or fold, valued in league points (ICM).",
     dict(model="points", players=[2, 3, 4, 5, 6], kinds=["open"], per_n={2: 1, 3: 2, 4: 2, 5: 2, 6: 3})),
    ("call-points", "League points: facing an all-in", "One player has gone all-in before you. Call or fold, valued in league points (ICM).",
     dict(model="points", players=[2, 3, 4, 5, 6], kinds=["call"], per_n={2: 1, 3: 2, 4: 2, 5: 2, 6: 3})),
]


def category(c):
    if len(c) == 2:
        return "pair"
    hi, lo, s = c[0], c[1], c[2]
    if s == "s":
        if hi == "A":
            return "suited ace"
        if hi in "KQ":
            return "suited king or queen"
        return "suited other"
    if hi == "A":
        return "offsuit ace"
    if hi in "KQ":
        return "offsuit king or queen"
    return "offsuit other"


def cards_for(c, rng):
    if len(c) == 2:
        a, b = rng.sample(SUITS, 2)
        return [c[0] + a, c[1] + b]
    if c[2] == "s":
        a = rng.choice(SUITS)
        return [c[0] + a, c[1] + a]
    a, b = rng.sample(SUITS, 2)
    return [c[0] + a, c[1] + b]


def load_candidates():
    cands = []
    for f in sorted(os.listdir(SPOTS)):
        d = json.load(open(os.path.join(SPOTS, f)))
        name = d["spec"]["name"]
        model = d["spec"]["payoff"]["model"]
        n = len(d["seats"])
        if model == "points":
            pay = d["spec"]["payoff"]["payouts"][:n]
            scale = (pay[0] - pay[-1]) / sum(d["stacks"])
        else:
            scale = 1.0
        for dec in d["decisions"]:
            nf = len(dec["facing"])
            if nf > 1:
                continue
            kind = "open" if nf == 0 else "call"
            if n > 2 and kind == "call" and dec["reach"] < MIN_REACH:
                continue
            for i, c in enumerate(d["classes"]):
                diff = dec["ev_diff"][i]
                if diff is None:
                    continue
                se = dec["ev_diff_se"][i] or 0.0
                fr = dec["freq"][i]
                if not (fr >= 0.999 or fr <= 0.001):
                    continue
                if (fr >= 0.999) != (diff > 0):
                    continue
                m = abs(diff)
                if m < max(MIN_SE_MULT * se, LO * scale) or m > HI * scale:
                    continue
                cands.append(dict(spot=name, model=model, n=n, kind=kind, decision=dec["id"],
                                  seat=dec["seat"], facing=dec["facing"], cls=c,
                                  answer="allin" if diff > 0 else "fold",
                                  margin=m, margin_bb=m / scale, se=se,
                                  stack=d["stacks"][dec["position"]], stacks=d["stacks"]))
    return cands


def pick(cands):
    rng = random.Random(SEED)
    used_classes = set()
    sets = []
    for sid, title, blurb, rule in SETS:
        pool = [c for c in cands if c["model"] == rule["model"] and c["kind"] in rule["kinds"]]
        rng.shuffle(pool)
        chosen = []
        slots = []
        for n, k in rule["per_n"].items():
            slots += [n] * k
        answers = ["allin", "fold"] * 5
        rng.shuffle(answers)
        # heads-up set: half small blind, half big blind
        kinds = (["open", "call"] * 5) if len(rule["kinds"]) == 2 else [rule["kinds"][0]] * 10
        for slot, (n, ans, kind) in enumerate(zip(slots, answers, kinds)):
            best = None
            for relax in range(4):
                for c in pool:
                    if c["n"] != n or c["answer"] != ans or c["kind"] != kind:
                        continue
                    if c["cls"] in used_classes:
                        continue
                    if any(x["spot"] == c["spot"] and x["decision"] == c["decision"] for x in chosen):
                        continue
                    spot_uses = sum(x["spot"] == c["spot"] for x in chosen)
                    seat_uses = sum(x["seat"] == c["seat"] for x in chosen)
                    cat_uses = sum(category(x["cls"]) == category(c["cls"]) for x in chosen)
                    stack_uses = sum(round(x["stack"]) == round(c["stack"]) for x in chosen)
                    if relax < 3 and spot_uses >= 1 + relax:
                        continue
                    if relax < 2 and (cat_uses >= 2 + relax or stack_uses >= 2 + relax):
                        continue
                    if relax < 1 and n > 2 and seat_uses >= 3:
                        continue
                    best = c
                    break
                if best:
                    break
            if not best:
                raise SystemExit(f"no candidate for set {sid} slot {slot} (n={n}, {ans}, {kind})")
            chosen.append(best)
            used_classes.add(best["cls"])
        rng.shuffle(chosen)
        sets.append((sid, title, blurb, chosen))
    return sets, rng


def main():
    cands = load_candidates()
    sets, rng = pick(cands)
    out = {"version": 1,
           "made_by": "tools/make-tournament-quiz.py",
           "rules": {"min_margin_bb": LO, "max_margin_bb": HI, "min_standard_errors": MIN_SE_MULT,
                     "min_reach": MIN_REACH, "seed": SEED},
           "sets": []}
    k = 0
    for sid, title, blurb, chosen in sets:
        qs = []
        for c in chosen:
            k += 1
            qs.append({"id": f"tq{k:02d}", "spot": c["spot"], "decision": c["decision"],
                       "class": c["cls"], "cards": cards_for(c["cls"], rng)})
        out["sets"].append({"id": sid, "title": title, "blurb": blurb, "questions": qs})
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(f"candidates {len(cands)}; wrote {os.path.relpath(OUT, ROOT)} with {k} questions")
    if "--print" in sys.argv:
        for sid, title, blurb, chosen in sets:
            print(f"\n== {title} ==")
            for c in chosen:
                unit = "bb" if c["model"] == "chips" else "pts"
                print(f"  {c['spot']:44s} {c['decision']:12s} {c['cls']:4s} {c['answer']:5s} "
                      f"margin {c['margin']:.3f} {unit} (= {c['margin_bb']:.2f} bb, {c['margin'] / max(c['se'], 1e-9):.0f} SE)"
                      if c["se"] else
                      f"  {c['spot']:44s} {c['decision']:12s} {c['cls']:4s} {c['answer']:5s} "
                      f"margin {c['margin']:.3f} {unit} (= {c['margin_bb']:.2f} bb, exact)")


if __name__ == "__main__":
    main()
