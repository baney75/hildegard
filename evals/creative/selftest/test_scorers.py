# SPDX-License-Identifier: AGPL-3.0-only
"""Checks that the scorers tell good work from bad: python3 evals/creative/selftest/test_scorers.py
Runs the control and reference scripts in this folder through score_audio.py and score.py (needs the inputs from make_audio.py).
A passthrough must fail the checks it should fail; each reference must pass them."""
import json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
CR = os.path.dirname(HERE)
sys.path.insert(0, CR)
import numpy as np
import score_audio as sa
from audiolib import SR

tasks = [t for f in ('tasks.json', 'heldout.json') for t in json.load(open(os.path.join(CR, f)))]
fails = []


def check(name, cond, detail=''):
    print(('ok   ' if cond else 'FAIL ') + name, detail)
    if not cond:
        fails.append(name)


def run(tid, script):
    return sa.score(tid, os.path.join(HERE, script), tasks)


r = run('a1-podcast-clean', 'passthrough.sh')
check('a1 passthrough misses loudness, hum, peak and clipping', not r['checks']['loudness_within_1LU'] and not r['checks']['hum_gone'] and not r['checks']['true_peak_ok'] and not r['checks']['no_clipping'], r['checks'])
r = run('a1-podcast-clean', 'clean.sh')
c = r['checks']
check('a1 reference removes hum, evens levels, tames the pop, hits the target', c['hum_gone'] and c['levels_evened'] and c['pop_tamed'] and c['loudness_within_1LU'] and c['true_peak_ok'] and c['same_length'] and c['speech_kept'], c)
check('a1 reference keeps speech (STOI-like fidelity above 0.6)', (r['fidelity_out'] or 0) > 0.6, r['fidelity_out'])
r = run('a2-church-duck', 'passthrough.sh')
check('a2 passthrough: no ducked voice found', not r['checks']['voice_present'] and not r['checks']['ducks'], r['checks'])
r = run('a2-church-duck', 'duck.sh')
check('a2 reference passes every check', r['passed'] == r['total'], f"{r['passed']}/{r['total']} duck {r.get('duck_db')} vmr {r.get('vmr_db')}")
r = run('a3-radio-spot', 'spot.sh')
check('a3 reference passes every check', r['passed'] == r['total'], f"{r['passed']}/{r['total']} sting {r.get('sting_at')}")
r = run('a3-radio-spot', 'passthrough.sh')
check('a3 passthrough fails length, order, sting', not r['checks']['length'] and not r['checks']['sting_at_end'], r['checks'])

with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, 'work'))
    open(os.path.join(d, 'done'), 'w').close()
    subprocess.run(['cp', os.path.join(HERE, 'edit.sh'), os.path.join(d, 'work', 'edit.sh')], check=True)
    subprocess.run([sys.executable, os.path.join(CR, 'score.py'), 'e1-canoe-cut', d], check=True)
    s = json.load(open(os.path.join(d, 'score.json')))
    check('e1 reference passes every check', s['passed'] == s['total'], s['checks'])
    open(os.path.join(d, 'work', 'edit.sh'), 'w').write('#!/bin/bash\nexit 0\n')
    subprocess.run([sys.executable, os.path.join(CR, 'score.py'), 'e1-canoe-cut', d], check=True)
    s = json.load(open(os.path.join(d, 'score.json')))
    check('e1 empty script scores as not run', not s['ran'] and s['passed'] == 0, s['checks'])

rng = np.random.default_rng(0)
x = sa.read_audio(os.path.join(sa.E, 'ref', 'a1-podcast-clean', 'clean.wav'), sr=16000)
check('stoi_like of a signal with itself is about 1', sa.stoi_like(x, x) > 0.99)
noise = sa.stoi_like(x, rng.standard_normal(len(x)).astype(np.float32) * 0.1)
check('stoi_like: noise is far below speech with a little noise on it, and unrelated speech is lower still', noise < 0.5 and sa.stoi_like(x, np.roll(x, 16000 * 7)) < 0.3 and sa.stoi_like(x, x + rng.standard_normal(len(x)).astype(np.float32) * 0.02) > noise + 0.2)
check('stoi_like ignores level', abs(sa.stoi_like(x, x * 0.1) - sa.stoi_like(x, x)) < 0.01)
sys.exit(1 if fails else 0)
