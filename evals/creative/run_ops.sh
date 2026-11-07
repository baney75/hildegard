#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# The ops (managing Hildegard) eval: responses, scores, report. Resumable: each stage skips what already exists.
#
#   evals/creative/run_ops.sh <label> [--set tuned|heldout|both] [--base none] [--cand main] [--models "haiku luna"] [--only id,id] [--jobs 3]
#
# --cand new compares this checkout's skills/ (or $NEW_SKILLS) against --base. Each response runs in a fake world of its own
# (ops_world.py: servers on free ports in 7450-7499) and is scored from the world's real end state (score_ops.py); no judge model.
# Writes evals/creative/results-<label>.json. State lives in $EVAL_DIR (default ~/.cache/hildegard-creative-eval), outside git.
# Subscriptions only: ANTHROPIC_API_KEY and OPENAI_API_KEY are unset, and a quota or billing message stops the run.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=${1:?label}; shift
SET=tuned; BASE=none; CAND=main; MODELS="haiku luna"; ONLY=""; JOBS=3
while [ $# -gt 0 ]; do case $1 in
  --set) SET=$2; shift 2;; --base) BASE=$2; shift 2;; --cand) CAND=$2; shift 2;;
  --models) MODELS=$2; shift 2;; --only) ONLY=$2; shift 2;; --jobs) JOBS=$2; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
export EVAL_DIR=${EVAL_DIR:-$HOME/.cache/hildegard-creative-eval}
unset ANTHROPIC_API_KEY OPENAI_API_KEY
case $SET in tuned) FILES=(tasks.json);; heldout) FILES=(heldout.json);; both) FILES=(tasks.json heldout.json);; *) echo "--set tuned|heldout|both" >&2; exit 2;; esac
cd "$HERE" || exit 1
git -C "$HERE" fetch -q origin 2>/dev/null
IDS=$(ONLY_IDS="$ONLY" python3 - "${FILES[@]}" <<'PY'
import json, os, sys
only = [x for x in os.environ.get('ONLY_IDS', '').split(',') if x]
for f in sys.argv[1:]:
    for t in json.load(open(f)):
        if t['domain'] == 'ops' and (not only or t['id'] in only):
            print(t['id'])
PY
)

echo "== 1/3 responses"
for m in $MODELS; do for a in $BASE $CAND; do for t in $IDS; do echo "$a $m $t"; done; done; done \
  | xargs -P "$JOBS" -L 1 sh -c './respond.sh "$0" "$1" "$2" || { [ $? -eq 99 ] && echo STOP >&2; }'
if find "$EVAL_DIR/runs" -name STOP | grep -q .; then echo "a quota or billing message came back; stopping. Nothing was topped up." >&2; exit 99; fi

echo "== 2/3 scores"
for a in $BASE $CAND; do for m in $MODELS; do for t in $IDS; do
  R=$EVAL_DIR/runs/$a/$m/$t
  [ -f "$R/final.json" ] || continue
  python3 runmeta.py "$m" "$R" 2>/dev/null
  python3 score_ops.py "$t" "$R" --model "$m" --tasks "${FILES[@]}" > "$R/score.json" || echo "score failed for $a $m $t" >&2
done; done; done

echo "== 3/3 report"
python3 report_ops.py "$LABEL" --base "$BASE" --cand "$CAND" --models $MODELS --tasks "${FILES[@]}"
