#!/usr/bin/env python3
"""Publish re-solved hands from data/v2 to the live folders.

A hand goes live when it has a solution and summary in data/v2/solutions, it
passes the quality gate (tools/puzzle-quality.py), it has an explanation in
data/v2/explanations, and that explanation passes tools/check-explanations.py
against the hand's fact sheet. Hands already live are left alone. Safe to run
repeatedly and while the server runs.

    python3 tools/publish-v2.py            # publish what is ready
    python3 tools/publish-v2.py --dry-run  # only report
"""
import importlib.util, json, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V2_SOL = os.path.join(ROOT, 'data', 'v2', 'solutions')
V2_EXP = os.path.join(ROOT, 'data', 'v2', 'explanations')
V2_FACTS = os.path.join(ROOT, 'data', 'v2', 'facts')
SOL = os.path.join(ROOT, 'data', 'solutions')
EXP = os.path.join(ROOT, 'data', 'explanations')
dry = '--dry-run' in sys.argv


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), os.path.join(ROOT, 'tools', name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def copy(src, dst):
    tmp = dst + '.tmp'
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


quality = load_tool('puzzle-quality').quality
check_one = load_tool('check-explanations').check_one
subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'hand-facts.py'), V2_SOL, '--out', V2_FACTS],
               check=True, stdout=subprocess.DEVNULL)

published, waiting, rejected, refreshed = [], [], [], []
for name in sorted(os.listdir(V2_SOL)):
    if not name.endswith('.json'):
        continue
    pid = name[:-5]
    if os.path.exists(os.path.join(SOL, name)):
        # already live: pick up a rewritten explanation if it passes the check
        expl, live = os.path.join(V2_EXP, name), os.path.join(EXP, name)
        if os.path.exists(expl) and (not os.path.exists(live) or open(expl).read() != open(live).read()):
            if check_one(pid, os.path.join(V2_FACTS, pid + '.facts.txt'), expl):
                rejected.append((pid, 'rewritten explanation fails the check'))
            else:
                if not dry:
                    copy(expl, live)
                refreshed.append(pid)
        continue
    summary = os.path.join(V2_SOL, pid + '.summary.txt')
    try:
        q = quality(os.path.join(V2_SOL, name))
    except Exception:
        waiting.append(pid)          # still being written
        continue
    if not os.path.exists(summary):
        waiting.append(pid)
        continue
    if not q['eligible']:
        rejected.append((pid, 'does not pass the quality gate'))
        continue
    expl = os.path.join(V2_EXP, name)
    if not os.path.exists(expl):
        waiting.append(pid)
        continue
    problems = check_one(pid, os.path.join(V2_FACTS, pid + '.facts.txt'), expl)
    if problems:
        rejected.append((pid, f'explanation fails the check ({len(problems)} problem(s))'))
        continue
    if not dry:
        copy(expl, os.path.join(EXP, name))
        copy(summary, os.path.join(SOL, pid + '.summary.txt'))
        copy(os.path.join(V2_SOL, name), os.path.join(SOL, name))  # solution last: it makes the puzzle visible
    published.append(pid)

print(('would publish' if dry else 'published'), len(published), ' '.join(published))
if refreshed:
    print('explanations refreshed:', len(refreshed), ' '.join(refreshed))
if waiting:
    print('waiting for an explanation:', len(waiting), ' '.join(waiting))
if rejected:
    print('not published:', '; '.join(f'{p} ({why})' for p, why in rejected))
