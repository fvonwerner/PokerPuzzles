#!/usr/bin/env python3
"""Fill the range blocks in web/learn/content.json from data/ranges.json.

Every `range` block that carries a `source` is recomputed, so the Learn
charts always match the charts the puzzles use. Sources:

  {"chart": "BTN_RFI"}                      the whole chart, one option per action
  {"chart": "UTG_RFI", "action": "raise"}   one action's weights only (heat grid)
  {"chart": "CO_RFI", "action": "raise",
   "minus": {"chart": "UTG_RFI", "action": "raise"}}
                                            what the first range adds to the second

Grid order and meaning follow docs/SPEC.md (sections 1 and 3).
Range strings may use the '+' shorthand or plain `class:weight` lists.
For a "facing a 3-bet" chart (key ending in _3bet) the frequencies are given
that the hand opened, so `w` is the opener's raise weight, as in SPEC 3.1.

Run from anywhere:  python3 tools/build-learn-charts.py [--check] [content.json]
With --check it only reports blocks that are out of date (exit code 1).
The file is written atomically (temp file + rename), so the live site never
sees a half-written file. Also prints each chart's size (for 3-bet charts:
combos after the open) so numbers quoted in the lessons can be checked.
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RANGES = ROOT / "data" / "ranges.json"
CONTENT = ROOT / "web" / "learn" / "content.json"
R = "AKQJT98765432"


def classes():
    out = []
    for i in range(13):
        for j in range(13):
            if i == j:
                out.append(R[i] * 2)
            elif i < j:
                out.append(R[i] + R[j] + "s")
            else:
                out.append(R[j] + R[i] + "o")
    return out


CLS = classes()
COMBOS = [6 if len(c) == 2 else (4 if c[2] == "s" else 12) for c in CLS]


def expand(token):
    m = re.fullmatch(r"([AKQJT98765432])([AKQJT98765432])([so]?)(\+?)", token)
    if not m:
        raise ValueError(f"cannot parse range token {token!r}")
    a, b, kind, plus = m.groups()
    if a == b:
        if kind:
            raise ValueError(f"pair with suit letter: {token!r}")
        return [R[k] * 2 for k in range(R.index(a) + 1)] if plus else [a + a]
    hi, lo = R.index(a), R.index(b)
    if hi >= lo:
        raise ValueError(f"higher card must come first: {token!r}")
    kinds = [kind] if kind else ["s", "o"]
    lows = range(hi + 1, lo + 1) if plus else [lo]
    return [a + R[l] + k for l in lows for k in kinds]


def parse(text):
    """postflop-solver range syntax -> {class: weight}"""
    w = {c: 0.0 for c in CLS}
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        tok, _, wt = part.partition(":")
        for c in expand(tok.strip()):
            w[c] = float(wt) if wt else 1.0
    return w


def r3(x):
    return round(float(x) + 0.0, 3)


def opener_weights(key, charts):
    """Facing-3-bet charts only exist for hands that opened: the opener's raise weights."""
    if not key.endswith("_3bet"):
        return None
    rfi = charts.get(key.split("_vs_")[0] + "_RFI")
    return parse(rfi["ranges"]["raise"]) if rfi else None


def weights(charts, ref):
    chart = charts[ref["chart"]]
    return parse(chart["ranges"].get(ref["action"], ""))


def build(source, charts):
    chart = charts[source["chart"]]
    if "action" not in source:
        opts = [{"id": o["id"], "kind": o["kind"], "label": o["label"]} for o in chart["options"]]
        parsed = {o["id"]: parse(chart["ranges"][o["id"]]) for o in chart["options"] if o["id"] in chart["ranges"]}
        f = []
        for c in CLS:
            row = [parsed[o["id"]][c] if o["id"] in parsed else 0.0 for o in opts]
            rest = 1 - sum(row)
            if rest < -1e-9:
                raise ValueError(f"{source['chart']} {c}: actions add up to more than 1")
            row = [max(0.0, rest) if o["id"] == "fold" and o["id"] not in parsed else x for o, x in zip(opts, row)]
            f.append([r3(x) for x in row])
        opener = opener_weights(source["chart"], charts)
        w = [r3(opener[c]) for c in CLS] if opener else [1] * 169
        return opts, {"w": w, "f": f}
    w = weights(charts, source)
    if "minus" in source:
        other = weights(charts, source["minus"])
        w = {c: max(0.0, w[c] - other[c]) for c in CLS}
    act = next(o for o in chart["options"] if o["id"] == source["action"])
    opts = [{"id": act["id"], "kind": act["kind"], "label": act["label"]}]
    ws = [r3(w[c]) for c in CLS]
    return opts, {"w": ws, "f": [[1] if x > 0 else [0] for x in ws]}


def walk(node):
    if isinstance(node, dict):
        if node.get("type") == "range" and "source" in node:
            yield node
        for v in node.values():
            yield from walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v)


def main():
    check = "--check" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = Path(args[0]).resolve() if args else CONTENT
    charts = json.loads(RANGES.read_text())["charts"]
    content = json.loads(path.read_text())
    stale = 0
    for b in walk(content):
        opts, rng = build(b["source"], charts)
        if b.get("options") != opts or b.get("range") != rng:
            stale += 1
            if not check:
                b["options"], b["range"] = opts, rng
    print("Chart sizes (combos of 1,326):")
    for key, chart in charts.items():
        opener = opener_weights(key, charts)
        for action, text in chart["ranges"].items():
            w = parse(text)
            n = sum(w[c] * k * (opener[c] if opener else 1) for c, k in zip(CLS, COMBOS))
            print(f"  {key:16s} {action:6s} {n:7.1f}  {100 * n / 1326:5.1f}%")
    if check:
        print(f"{stale} range block(s) out of date")
        sys.exit(1 if stale else 0)
    fd, tmp = tempfile.mkstemp(prefix=".content-", suffix=".json", dir=path.parent)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(content, indent=1, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    print(f"updated {stale} range block(s) in {path}")


if __name__ == "__main__":
    main()
