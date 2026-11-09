# SPDX-License-Identifier: AGPL-3.0-only
"""A scored output must be a regular file the script itself wrote: python3 evals/creative/selftest/test_output_file.py
A symlink is followed by every later check, so an untrusted script could leave out.wav pointing at the hidden reference and have
the reference scored as its own work. No model is called, and the sandbox is bypassed so this runs without bubblewrap."""
import os, sys, tempfile
from unittest.mock import MagicMock
HERE = os.path.dirname(os.path.abspath(__file__))
CR = os.path.dirname(HERE)
sys.path.insert(0, CR)
EVAL = tempfile.mkdtemp(prefix='output-file-')
os.environ['EVAL_DIR'] = EVAL
import sandbox
import score_audio as sa

sandbox.wrap = lambda cmd, rw_dir, hide=(): list(cmd)
os.makedirs(os.path.join(EVAL, 'inputs', 't'))
os.makedirs(os.path.join(EVAL, 'ref', 't'))
open(os.path.join(EVAL, 'inputs', 't', 'photo.jpg'), 'wb').write(b'x')
REF = os.path.join(EVAL, 'ref', 't', 'clean.bin')
open(REF, 'wb').write(b'r' * 4000)
CASES = [
    ('a symlink to the hidden reference', f'ln -s {REF} OUT', False),
    ('a directory', 'mkdir OUT; for i in $(seq 300); do : > OUT/some-long-file-name-$i; done', False),
    ('a FIFO', 'mkfifo OUT', False),
    ('a regular file that is too small', 'head -c 10 /dev/zero > OUT', False),
    ('a regular file', 'head -c 4000 /dev/zero > OUT', True),
]
failed = 0


def report(where, name, got, want):
    global failed
    good = bool(got) == want
    failed += not good
    print(f"{'PASS' if good else 'FAIL'} {where}: {name}: scored={bool(got)} want={want}")


for name, body, want in CASES:
    script = os.path.join(EVAL, 'process.sh')
    open(script, 'w').write(body.replace('OUT', 'out.wav') + '\n')
    report('score_audio', name, sa.run_script('t', script, 'out.wav')[0], want)

# photo_dev.py needs the media eval's modules, which are stood in for: only its runner is under test.
sys.modules.update({m: MagicMock() for m in ('imglib', 'make_media', 'score_media')})
sys.modules['score_media'].E = EVAL
import photo_dev

photo_dev.CURRENT['task'] = {}
for name, body, want in CASES:
    photo_dev.command = lambda task, arm, scripts, body=body: ['bash', '-c', body.replace('OUT', 'out.jpg')]
    report('photo_dev', name, photo_dev.make_runner('tools', '')('t', None, None, 'out.jpg')[0], want)
print(f'{failed} failed')
sys.exit(1 if failed else 0)
