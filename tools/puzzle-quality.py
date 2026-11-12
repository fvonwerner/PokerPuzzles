#!/usr/bin/env python3
"""How good a puzzle is each solved hand? Reads solution files, prints a table.

A postflop decision is
  D decisive: one action is played >= 70% and at least one other option is a
              real mistake (played < 3.5% and losing >= 1.5% of the pot)
  c clear:    one action is played >= 70%, the others cost little
  l lean:     the top action is played 60-70%
  M mixed:    no action is played 60%: there is no single right answer
(p = preflop chart decision.) Hands with several decisive decisions and no
mixed ones make the best puzzles.

    python3 tools/puzzle-quality.py data/solutions            # table, best first
    python3 tools/puzzle-quality.py data/solutions --eligible # ids that pass the gate, one per line
    python3 tools/puzzle-quality.py data/solutions --json     # machine-readable

Gate (--eligible): no solver warnings, at least 2 decisive decisions, at most
1 mixed decision, and the hero's preflop line is what the chart does most
(or at least 40% of the time).
"""
import glob, json, os, sys


def decision_kind(d):
    f = d['hand']['freq']
    ev = d['hand'].get('ev')
    mx = max(f)
    if d['source'] == 'chart' or not ev:
        k = d['options'].index(next(o for o in d['options'] if o['id'] == d['mainLine']))
        return dict(kind='p', mx=mx, main=f[k])
    pot = d['state']['pot']
    best = max(ev)
    loss = [100 * (best - e) / pot if pot > 0 else 0 for e in ev]
    mistakes = [k for k in range(len(f)) if f[k] < 0.035 and loss[k] >= 1.5]
    second = sorted(loss)[1] if len(loss) > 1 else 0
    if mx >= 0.70 and mistakes:
        kind = 'D'
    elif mx >= 0.70:
        kind = 'c'
    elif mx < 0.60:
        kind = 'M'
    else:
        kind = 'l'
    return dict(kind=kind, mx=mx, mistakes=len(mistakes), big=sum(1 for k in mistakes if loss[k] >= 6),
                only_one_right=bool(mx >= 0.70 and second >= 1.5))


def quality(path):
    s = json.load(open(path))
    ds = [st for st in s['steps'] if st['type'] == 'decision']
    st = [decision_kind(d) for d in ds]
    post = [x for x in st if x['kind'] != 'p']
    n = {k: sum(1 for x in post if x['kind'] == k) for k in 'DclM'}
    streets = len({d['street'] for d in ds if d['source'] != 'chart'})
    pre_ok = all(x['main'] >= 0.4 or x['main'] >= x['mx'] - 0.05 for x in st if x['kind'] == 'p')
    pre_mixed = sum(1 for x in st if x['kind'] == 'p' and x['main'] < 0.6)
    score = (1.0 * n['D'] + 0.5 * sum(1 for x in post if x.get('only_one_right')) + 0.25 * n['c'] - 0.2 * n['l'] - 0.8 * n['M']
             + 0.3 * (streets - 1) + 0.2 * sum(1 for x in post if x.get('big')) - 0.4 * pre_mixed)
    warn = len(s.get('warnings') or [])
    return dict(id=s['id'], score=round(score, 2), kinds=''.join(x['kind'] for x in st), n=n, streets=streets,
                scenario=s['scenario']['key'], position=s['hero']['position'], hand=''.join(s['hero']['hand']),
                title=s['title'], warnings=warn, preflopOk=pre_ok, exploitability=s['solver']['exploitabilityPctPot'],
                eligible=bool(warn == 0 and n['D'] >= 2 and n['M'] <= 1 and pre_ok))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        sys.exit(__doc__)
    rows = [quality(p) for p in sorted(glob.glob(os.path.join(args[0], '*.json'))) if not p.endswith('.facts.json')]
    rows.sort(key=lambda r: (-r['score'], r['id']))
    if '--json' in sys.argv:
        print(json.dumps(rows, indent=1))
    elif '--eligible' in sys.argv:
        print('\n'.join(r['id'] for r in rows if r['eligible']))
    else:
        for r in rows:
            print(f"{r['id']} {r['score']:5.2f} {'ok ' if r['eligible'] else 'no '} {r['kinds']:8s} {r['scenario']:11s} {r['position']:3s} "
                  f"{r['hand']} expl {r['exploitability']:.2f}%  {r['title']}")
        print(f"{sum(1 for r in rows if r['eligible'])} of {len(rows)} pass the gate")


if __name__ == '__main__':
    main()
