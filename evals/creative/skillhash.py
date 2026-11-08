# SPDX-License-Identifier: AGPL-3.0-only
"""skillhash.py <skills dir>: print a SHA-256 over every file's relative path and bytes (sorted; .git and __pycache__ left out).
A run made with these skills is reused only while this value is unchanged.

skillhash.py --stale <eval dir> "<arms>" "<models>" "<task ids>": for each run on disk, compare its skills.sha with the hash of the
arm's skills as they are now (main: origin/main's skills folder; new: $NEW_SKILLS or this checkout's skills/; an arm arms.py made:
<eval dir>/arms/<arm>/skills, as respond.sh hashes it). Prints one line per run
that differs or has no hash, and exits 1 if there are any. --judge-only uses it, so it never judges a run the current skills did not make."""
import hashlib, os, subprocess, sys, tempfile


def tree_hash(root):
    h = hashlib.sha256()
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if d not in ('.git', '__pycache__'))
        for f in sorted(fn):
            p = os.path.join(dp, f)
            h.update(os.path.relpath(p, root).encode() + b'\0')
            h.update(hashlib.sha256(open(p, 'rb').read()).digest())
    return h.hexdigest()


def current(arm, eval_dir=None):
    """The hash of the arm's skills folder now; None for the arm with no skills."""
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if arm == 'none':
        return None
    made = os.path.join(eval_dir or '', 'arms', arm, 'skills')
    if arm not in ('main', 'new') and eval_dir and os.path.isdir(made):  # council, nocouncil: respond.sh uses these too
        return tree_hash(made)
    if arm == 'new':
        return tree_hash(os.environ.get('NEW_SKILLS') or os.path.join(repo, 'skills'))
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(f'git -C {repo} archive origin/main skills | tar -x -C {t}', shell=True, check=True)
        return tree_hash(os.path.join(t, 'skills'))


def stale(eval_dir, arms, models, ids):
    out = []
    for arm in arms:
        now = current(arm, eval_dir)
        for m in models:
            for t in ids:
                run = os.path.join(eval_dir, 'runs', arm, m, t)
                if now and os.path.isdir(run):
                    try:
                        had = open(os.path.join(run, 'skills.sha')).read().strip()
                    except OSError:
                        had = None
                    if had != now:
                        out.append(f'{arm} {m} {t}: made with {had[:12] if had else "no recorded hash"}, the skills are now {now[:12]}')
    return out


if __name__ == '__main__':
    if sys.argv[1] == '--stale':
        # Exit 1 means stale and nothing else: a crash (no origin/main, a bad argument) is a different code, so run.sh
        # never reads a check that didn't run as a check that found stale runs.
        try:
            lines = stale(sys.argv[2], *(a.split() for a in sys.argv[3:6]))
        except Exception as e:
            print(f'skillhash could not check the runs: {e}', file=sys.stderr)
            sys.exit(4)
        print('\n'.join(lines))
        sys.exit(1 if lines else 0)
    print(tree_hash(sys.argv[1]))
