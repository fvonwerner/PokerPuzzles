#!/usr/bin/env python3
"""Replace the preflop charts in data/ranges.json with a real solver solution.

Source: the preflop ranges bundled with the open-source TexasSolver v0.2.0
release (github.com/bupticybee/TexasSolver), folder
`ranges/qb_ranges/100bb 2.5x 500rake`: a 6-max, 100 bb, 2.5x-open cash game
solution (NL500 rake). The files this script needs are kept in
`data/preflop-source/` (one `class:frequency` list per action).

The files hold, per hand class, how often the class takes that action out of
all the times it is dealt. For a "facing a 3-bet" node that includes having
opened first, so a chart frequency there is file / open frequency. The solver
multiplies the chain back together for the postflop range.

    python3 tools/import-preflop.py            # rewrite data/ranges.json
    python3 tools/import-preflop.py --check    # only print the summary
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'preflop-source')
RANGES = os.path.join(ROOT, 'data', 'ranges.json')

# chart -> (prior chart whose 'raise' is the open, {option id: source file}, {option id: amount})
CHARTS = {
    'UTG_RFI': (None, {'raise': 'UTG/UTG_2.5bb.txt'}, {'raise': 2.5}),
    'HJ_RFI': (None, {'raise': 'MP/MP_2.5bb.txt'}, {'raise': 2.5}),
    'CO_RFI': (None, {'raise': 'CO/CO_2.5bb.txt'}, {'raise': 2.5}),
    'BTN_RFI': (None, {'raise': 'BTN/BTN_2.5bb.txt'}, {'raise': 2.5}),
    'SB_RFI': (None, {'raise': 'SB/SB_3.0bb.txt'}, {'raise': 3}),
    'BB_vs_BTN': (None, {'call': 'BB/BTN_2.5bb_BB_Call.txt', 'raise': 'BB/BTN_2.5bb_BB_11.0bb.txt'}, {'call': 2.5, 'raise': 11}),
    'BB_vs_CO': (None, {'call': 'BB/CO_2.5bb_BB_Call.txt', 'raise': 'BB/CO_2.5bb_BB_11.0bb.txt'}, {'call': 2.5, 'raise': 11}),
    'BB_vs_HJ': (None, {'call': 'BB/MP_2.5bb_BB_Call.txt', 'raise': 'BB/MP_2.5bb_BB_11.0bb.txt'}, {'call': 2.5, 'raise': 11}),
    'BB_vs_UTG': (None, {'call': 'BB/UTG_2.5bb_BB_Call.txt', 'raise': 'BB/UTG_2.5bb_BB_11.0bb.txt'}, {'call': 2.5, 'raise': 11}),
    'BB_vs_SB': (None, {'call': 'BB/SB_3.0bb_BB_Call.txt', 'raise': 'BB/SB_3.0bb_BB_9.0bb.txt'}, {'call': 3, 'raise': 9}),
    'SB_vs_BTN': (None, {'raise': 'SB/BTN_2.5bb_SB_11.0bb.txt'}, {'raise': 11}),
    'BTN_vs_CO': (None, {'call': 'BTN/CO_2.5bb_BTN_Call.txt', 'raise': 'BTN/CO_2.5bb_BTN_8.5bb.txt'}, {'call': 2.5, 'raise': 8.5}),
    'BTN_vs_BB_3bet': ('BTN_RFI', {'call': 'BTN/vs_3bet/BTN_2.5bb_BB_11.0bb_BTN_Call.txt', 'raise': 'BTN/vs_3bet/BTN_2.5bb_BB_11.0bb_BTN_24.0bb.txt'}, {'call': 11, 'raise': 24}),
    'BTN_vs_SB_3bet': ('BTN_RFI', {'call': 'BTN/vs_3bet/BTN_2.5bb_SB_11.0bb_BTN_Call.txt', 'raise': 'BTN/vs_3bet/BTN_2.5bb_SB_11.0bb_BTN_24.0bb.txt'}, {'call': 11, 'raise': 24}),
    'CO_vs_BTN_3bet': ('CO_RFI', {'call': 'CO/vs_3bet/CO_2.5bb_BTN_8.5bb_CO_Call.txt', 'raise': 'CO/vs_3bet/CO_2.5bb_BTN_8.5bb_CO_22.0bb.txt'}, {'call': 8.5, 'raise': 22}),
    'SB_vs_BB_3bet': ('SB_RFI', {'call': 'SB/vs_3bet/SB_3.0bb_BB_9.0bb_SB_Call.txt', 'raise': 'SB/vs_3bet/SB_3.0bb_BB_9.0bb_SB_22.0bb.txt'}, {'call': 9, 'raise': 22}),
}
TITLES = {
    'BB_vs_SB': 'BB facing an SB open to 3',
    'BTN_vs_CO': 'BTN facing a CO open to 2.5',
    'CO_vs_BTN_3bet': 'CO facing a BTN 3-bet to 8.5',
    'SB_vs_BB_3bet': 'SB facing a BB 3-bet to 9',
}
# scenarios whose sizes changed with the solution's sizes: seat -> new amount, plus pot and stacks at the flop
SCENARIOS = {
    'CO_BTN_3BP': ({'BTN': 8.5, 'CO': 8.5}, 18.5, 91.5),   # 8.5 + 8.5 + blinds 1.5
    'SB_BB_3BP': ({'BB': 9, 'SB': 9}, 18, 91),              # 9 + 9
}
RANKS = '23456789TJQKA'


def combos(c):
    return 6 if len(c) == 2 else (4 if c[2] == 's' else 12)


def load(rel):
    out = {}
    with open(os.path.join(SRC, rel)) as f:
        for tok in f.read().strip().split(','):
            k, v = tok.split(':')
            out[k] = float(v)
    assert len(out) == 169, (rel, len(out))
    return out


def order(c):  # pairs, then suited, then offsuit, high cards first: a readable range string
    kind = 0 if len(c) == 2 else (1 if c[2] == 's' else 2)
    return (kind, -RANKS.index(c[0]), -RANKS.index(c[1]))


def fmt(w):
    s = f'{w:.4f}'.rstrip('0').rstrip('.')
    return s


def main():
    check = '--check' in sys.argv
    R = json.load(open(RANGES))
    files = {k: {o: load(f) for o, f in v[1].items()} for k, v in CHARTS.items()}
    report = []
    for key, (prior, srcs, amounts) in CHARTS.items():
        chart = R['charts'][key]
        opt_ids = [o['id'] for o in chart['options']]
        assert set(srcs) == set(opt_ids) - {'fold'}, (key, opt_ids)
        freq = {}
        for oid in srcs:
            d = {}
            for c, w in files[key][oid].items():
                if prior:
                    op = files[prior]['raise'][c]
                    w = min(1.0, w / op) if op > 0 else 0.0
                d[c] = w
            freq[oid] = d
        # rounding must never push a class above 1
        for c in list(freq[next(iter(freq))]):
            tot = sum(freq[o][c] for o in freq)
            if tot > 1:
                for o in freq:
                    freq[o][c] /= tot
        chart['ranges'] = {
            oid: ','.join(f'{c}:{fmt(w)}' if fmt(w) != '1' else c
                          for c, w in sorted(freq[oid].items(), key=lambda t: order(t[0])) if round(w, 4) > 0)
            for oid in opt_ids if oid != 'fold'
        }
        for o in chart['options']:
            if o['id'] in amounts:
                o['amount'] = amounts[o['id']]
                if o['kind'] == 'raise':
                    word = 'Raise' if key.endswith('_RFI') else ('4-bet' if key.endswith('_3bet') else '3-bet')
                    o['label'] = f"{word} to {fmt(amounts[o['id']])}"
        if key in TITLES:
            chart['title'] = TITLES[key]
        # share of all 1326 combos (for a chain: of the times the node is reached)
        base = files[prior]['raise'] if prior else None
        reach = sum(combos(c) * (base[c] if base else 1) for c in freq[next(iter(freq))])
        parts = []
        for oid in freq:
            n = sum(combos(c) * w * (base[c] if base else 1) for c, w in freq[oid].items())
            parts.append(f'{oid} {100 * n / reach:.1f}%')
        report.append(f'{key:16s} ' + ', '.join(parts))
    for sk, (amts, pot, stack) in SCENARIOS.items():
        sc = R['scenarios'][sk]
        for e in sc['preflop']:
            if e.get('chart') and e['seat'] in amts and e['kind'] in ('raise', 'call') and not e['chart'].endswith('_RFI'):
                e['amount'] = amts[e['seat']]
        sc['potBb'], sc['stackBb'] = pot, stack
    R['_comment'] = ('Preflop library for 6-max, 100bb. Charts are a real solver solution: the "100bb 2.5x 500rake" '
                     'ranges bundled with the open-source TexasSolver v0.2.0 release, imported by tools/import-preflop.py '
                     '(source files in data/preflop-source). Range strings use the postflop-solver syntax: '
                     "comma-separated classes with an optional ':weight'. In a chart, 'fold' is always the remainder. "
                     "A 'facing a 3-bet' chart holds frequencies given that the hand opened; the solver multiplies a "
                     "seat's chart actions together for its postflop range. Postflop is solved without rake.")
    print('\n'.join(report))
    if not check:
        with open(RANGES + '.tmp', 'w') as f:
            json.dump(R, f, indent=1)
            f.write('\n')
        os.replace(RANGES + '.tmp', RANGES)
        print('wrote', RANGES)


if __name__ == '__main__':
    main()
