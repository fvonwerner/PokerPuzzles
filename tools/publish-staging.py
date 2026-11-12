#!/usr/bin/env python3
"""Publish finished puzzles from data/staging to the live folders.

A staged puzzle is published when it has a solution, a summary and an
explanation, the solution has no warnings, and the explanation covers every
decision. Already published puzzles are left alone. Safe to run repeatedly
and while the server runs (it picks new files up by itself).

    python3 tools/publish-staging.py            # publish what is ready
    python3 tools/publish-staging.py --dry-run  # only report
"""
import json, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ST_SOL = os.path.join(ROOT, 'data', 'staging', 'solutions')
ST_EXP = os.path.join(ROOT, 'data', 'staging', 'explanations')
SOL = os.path.join(ROOT, 'data', 'solutions')
EXP = os.path.join(ROOT, 'data', 'explanations')
dry = '--dry-run' in sys.argv


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def copy(src, dst):
    tmp = dst + '.tmp'
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


published, waiting, rejected = [], [], []
for name in sorted(os.listdir(ST_SOL)) if os.path.isdir(ST_SOL) else []:
    if not name.endswith('.json'):
        continue
    pid = name[:-5]
    if os.path.exists(os.path.join(SOL, name)):
        continue
    sol = load(os.path.join(ST_SOL, name))
    summary = os.path.join(ST_SOL, pid + '.summary.txt')
    if sol is None or not os.path.exists(summary):
        waiting.append(pid)
        continue
    if sol.get('warnings'):
        rejected.append((pid, 'warnings'))
        continue
    exp = load(os.path.join(ST_EXP, name))
    if exp is None:
        waiting.append(pid)
        continue
    keys = sorted(exp.get('decisions', {}), key=lambda k: int(k) if k.isdigit() else -1)
    if keys != [str(i) for i in range(sol.get('decisionCount', -1))] or not exp.get('takeaway'):
        rejected.append((pid, 'explanation does not match the decisions'))
        continue
    if not dry:
        copy(os.path.join(ST_EXP, name), os.path.join(EXP, name))
        copy(summary, os.path.join(SOL, pid + '.summary.txt'))
        copy(os.path.join(ST_SOL, name), os.path.join(SOL, name))  # solution last: it makes the puzzle visible
    published.append(pid)

print(('would publish' if dry else 'published'), len(published), ' '.join(published))
if waiting:
    print('waiting for an explanation:', len(waiting))
if rejected:
    print('not published:', '; '.join(f'{p} ({why})' for p, why in rejected))
