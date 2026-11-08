# SPDX-License-Identifier: AGPL-3.0-only
"""skillhash.py <skills dir>: print a SHA-256 over every file's relative path and bytes (sorted; .git and __pycache__ left out).
A run made with these skills is reused only while this value is unchanged."""
import hashlib, os, sys


def tree_hash(root):
    h = hashlib.sha256()
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if d not in ('.git', '__pycache__'))
        for f in sorted(fn):
            p = os.path.join(dp, f)
            h.update(os.path.relpath(p, root).encode() + b'\0')
            h.update(hashlib.sha256(open(p, 'rb').read()).digest())
    return h.hexdigest()


if __name__ == '__main__':
    print(tree_hash(sys.argv[1]))
