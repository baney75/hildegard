# SPDX-License-Identifier: AGPL-3.0-only
"""Lint every file named on the command line with the skill's script, in one process; print the lints as a JSON list."""
import importlib.util
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("prose_lint", os.path.join(here, "../../../skills/hildegard/scripts/prose_lint.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = []
strict = "--strict" in sys.argv
for f in sys.argv[1:]:
    if f == "--strict":
        continue
    with open(f, "rb") as fh:
        out.append(mod.lint_prose(fh.read().decode("utf-8", errors="replace"), strict))
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps(out, ensure_ascii=False))
