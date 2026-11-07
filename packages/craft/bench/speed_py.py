# SPDX-License-Identifier: AGPL-3.0-only
"""Time the Python prose lint in one process: python3 speed_py.py INPUT.json  (the shape speed.ts writes).
Prints {name: {"ms": [..]}} as JSON. --engine=PATH times another copy of the script. With --profile, prints the top functions by own time to stderr as well."""
import cProfile
import importlib.util
import json
import os
import pstats
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
engine = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--engine=")), None)
spec = importlib.util.spec_from_file_location(
    "prose_lint", engine or os.path.join(here, "../../../skills/hildegard/scripts/prose_lint.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

profile = "--profile" in sys.argv
inputs = json.load(open([a for a in sys.argv[1:] if not a.startswith("--")][0], encoding="utf-8"))
out = {}
for case in inputs:
    ms = []
    for _ in range(case["runs"]):
        t0 = time.perf_counter()
        mod.lint_prose(case["text"])
        ms.append((time.perf_counter() - t0) * 1000)
    out[case["name"]] = {"ms": ms}
if profile:
    big = max(inputs, key=lambda c: len(c["text"]) if c.get("profile") else 0)
    pr = cProfile.Profile()
    pr.enable()
    mod.lint_prose(big["text"])
    pr.disable()
    pstats.Stats(pr, stream=sys.stderr).sort_stats("tottime").print_stats(12)
print(json.dumps(out))
