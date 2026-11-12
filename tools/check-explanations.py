#!/usr/bin/env python3
"""Check v2 puzzle explanations against their fact sheets.

Usage: tools/check-explanations.py <facts-dir> <explanations-dir>

For every <id>.json in the explanations dir, with <id>.facts.txt in the facts dir:
  - one key per decision ("0".."n-1") plus a "takeaway";
  - decision texts at most 480 chars, takeaway at most 160, plain ASCII, no markdown;
  - every number in a decision text (percent, bb or plain) equals, after rounding to
    the precision written, a number in that decision's sheet section, including the
    event lines that follow it (villain's reply to hero's action), or in the event
    lines just before it (percent tokens are matched only against sheet percents);
  - hand/draw terms (backdoor, flush draw, gutshot, top pair, set, ..., plural forms
    included) are checked per sentence: a term is allowed if the decision's Hero's hand
    / Draws / Outs / Board / New card lines contain it, or if the range lines (Hand types,
    Each option, Your hand type, Against your hand type, Blockers, villain hand types
    taking this action) contain it AND the sentence makes no claim about what you hold
    ("you have / hold / made / flopped ...", "your hand", "gives you", "you are left with").
Prints one line per problem; exits 1 if any problem was found.
Standard library only.
"""
import json
import os
import re
import sys

TERMS = [
    "backdoor", "flush draw", "straight draw", "gutshot", "open-ended",
    "top pair", "second pair", "bottom pair", "overpair", "underpair",
    "set", "trips", "two pair", "straight", "flush", "full house", "overcard",
]
FACT_LINE_PREFIXES = ("Hero's hand:", "Draws:", "Outs", "Board:", "New card")
# Range-level lines: a term found only here may be used in a sentence about the
# ranges, never in a sentence that says what hero holds (see HERO_CLAIM_RE).
RANGE_LINE_PREFIXES = ("Hand types", "Each option", "Your hand type", "Against your hand type",
                       "Blockers:", "villain hand types taking this action:", "villain hand types that would")
HERO_CLAIM_RE = re.compile(
    r"\b(you (now |still |also )?(have|hold|held|made|make|flopped|pick up|picked up)|your hand|gives you|you are left with)\b")

NUM_RE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)(\s*%|\s*bb\b)?")
SHEET_NUM_RE = re.compile(r"(?<![\w.])(-?\d+(?:\.\d+)?)(%)?")


def parse_sheet(path):
    """Return list of decisions: dict(own=[lines], events_before=[lines])."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    heads = [i for i, l in enumerate(lines) if l.startswith("=== DECISION #")]
    sections = []
    for n, start in enumerate(heads):
        end = heads[n + 1] if n + 1 < len(heads) else len(lines)
        sections.append(lines[start:end])
    decisions = []
    prev_trailing = []
    for sec in sections:
        vi = next((i for i, l in enumerate(sec) if l.startswith("Villain's range")), None)
        if vi is None:
            own, trailing = sec, []
        else:
            own, trailing = sec[: vi + 1], sec[vi + 1:]
        decisions.append({"own": own, "events_before": prev_trailing, "events_after": trailing})
        prev_trailing = trailing
    return decisions


def sheet_numbers(lines):
    pct, alln = set(), set()
    for l in lines:
        for m in SHEET_NUM_RE.finditer(l):
            v = abs(float(m.group(1)))
            alln.add(v)
            if m.group(2):
                pct.add(v)
    return pct, alln


def matches(token, pool):
    dec = len(token.split(".")[1]) if "." in token else 0
    want = float(token)
    for v in pool:
        if abs(round(v + 1e-9, dec) - want) < 1e-9:
            return True
    return False


def term_hits(text, term):
    """Occurrences of term as a whole word/phrase, not part of a longer listed term."""
    low = text.lower()
    longer = [t for t in TERMS if t != term and term in t]
    count = 0
    for m in re.finditer(r"(?<![a-z-])" + re.escape(term) + r"(?:s|es)?(?![a-z])", low):
        s, e = m.span()
        inside = False
        for lt in longer:
            for lm in re.finditer(re.escape(lt), low):
                if lm.start() <= s and lm.end() >= e:
                    inside = True
        if not inside:
            count += 1
    return count


def check_text_basic(where, text, limit, problems):
    if not isinstance(text, str) or not text.strip():
        problems.append(f"{where}: empty or not a string")
        return False
    if len(text) > limit:
        problems.append(f"{where}: {len(text)} chars > {limit}")
    try:
        text.encode("ascii")
    except UnicodeEncodeError:
        bad = sorted({c for c in text if ord(c) > 127})
        problems.append(f"{where}: non-ASCII characters {bad!r}")
    if re.search(r"[*_#`]|\[[^\]]*\]\(", text):
        problems.append(f"{where}: looks like markdown")
    if "--" in text:
        problems.append(f"{where}: dash pair used as em dash")
    return True


def check_one(hid, facts_path, expl_path):
    problems = []
    decs = parse_sheet(facts_path)
    try:
        with open(expl_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        return [f"{hid}: cannot read explanation: {e}"]
    d = data.get("decisions")
    if not isinstance(d, dict):
        return [f"{hid}: no 'decisions' object"]
    want = {str(i) for i in range(len(decs))}
    if set(d.keys()) != want:
        problems.append(f"{hid}: decision keys {sorted(d.keys())} != sheet {sorted(want)}")
    extra = set(data.keys()) - {"decisions", "takeaway"}
    if extra:
        problems.append(f"{hid}: unexpected top-level keys {sorted(extra)}")
    tk = data.get("takeaway")
    check_text_basic(f"{hid} takeaway", tk, 160, problems)

    for i, dec in enumerate(decs):
        text = d.get(str(i))
        where = f"{hid} #{i}"
        if not check_text_basic(where, text, 480, problems):
            continue
        pool_lines = dec["own"] + dec["events_before"] + dec["events_after"]
        pct, alln = sheet_numbers(pool_lines)
        scrub = re.sub(r"\b\d-bet", "", text)
        for m in NUM_RE.finditer(scrub):
            tok, unit = m.group(1), (m.group(2) or "").strip()
            pool = pct if unit == "%" else alln
            if not matches(tok, pool):
                problems.append(f"{where}: number {tok}{unit and ' ' + unit if unit == 'bb' else unit} not on the sheet for this decision")
        fact_text = " ".join(l for l in dec["own"] if l.startswith(FACT_LINE_PREFIXES)).lower()
        range_text = " ".join(l.strip() for l in pool_lines
                              if l.strip().startswith(RANGE_LINE_PREFIXES)).lower()
        for sent in re.split(r"(?<=[.!?;])\s+", text):
            for term in TERMS:
                if not term_hits(sent, term) or term in fact_text:
                    continue
                if term in range_text and not HERO_CLAIM_RE.search(sent.lower()):
                    continue
                problems.append(f"{where}: term '{term}' not on the sheet's hero lines"
                                + (" (range lines have it, but the sentence is about your hand)" if term in range_text else "")
                                + f": \"{sent[:70]}\"")
    return problems


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[2])
        return 2
    facts_dir, expl_dir = sys.argv[1], sys.argv[2]
    problems = []
    files = sorted(f for f in os.listdir(expl_dir) if f.endswith(".json"))
    for fn in files:
        hid = fn[: -len(".json")]
        fp = os.path.join(facts_dir, hid + ".facts.txt")
        if not os.path.exists(fp):
            problems.append(f"{hid}: no fact sheet {fp}")
            continue
        problems.extend(check_one(hid, fp, os.path.join(expl_dir, fn)))
    for p in problems:
        print(p)
    print(f"checked {len(files)} explanation file(s): {len(problems)} problem(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
