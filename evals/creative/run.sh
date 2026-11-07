#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# The whole eval: inputs, responses, scores, judge, report. Resumable: each stage skips what already exists.
#
#   evals/creative/run.sh <label> [--set tuned|heldout|heldout2|both] [--base none] [--cand main] [--models "haiku luna"] [--only id,id] [--jobs 4] [--judge-only]
#
# --judge-only judges and reports the responses already on disk (inputs, responses and scores are not touched, no responder runs).
# --cand new compares this checkout's skills/ (or $NEW_SKILLS) against --base (default none; use --base main for a change).
# Writes evals/creative/results-<label>.json and prints the summary. State lives in $EVAL_DIR (default
# ~/.cache/hildegard-creative-eval), outside git. Needs: claude and codex signed in with a subscription, ffmpeg, numpy, Pillow,
# Playwright's Chromium (~/.cache/ms-playwright). Never uses an API key.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=${1:?label}; shift
SET=tuned; BASE=none; CAND=main; MODELS="haiku luna"; ONLY=""; JOBS=4; JUDGE_ONLY=0
while [ $# -gt 0 ]; do case $1 in
  --set) SET=$2; shift 2;; --base) BASE=$2; shift 2;; --cand) CAND=$2; shift 2;;
  --models) MODELS=$2; shift 2;; --only) ONLY=$2; shift 2;; --jobs) JOBS=$2; shift 2;; --judge-only) JUDGE_ONLY=1; shift;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
export EVAL_DIR=${EVAL_DIR:-$HOME/.cache/hildegard-creative-eval}
unset ANTHROPIC_API_KEY OPENAI_API_KEY
case $SET in tuned) FILES=(tasks.json);; heldout) FILES=(heldout.json);; both) FILES=(tasks.json heldout.json);; heldout2) FILES=(heldout2.json);; *) echo "--set tuned|heldout|heldout2|both" >&2; exit 2;; esac
cd "$HERE" || exit 1
git -C "$HERE" fetch -q origin 2>/dev/null

echo "== 1/5 inputs"; [ $JUDGE_ONLY = 1 ] || python3 make_audio.py "${FILES[@]}" || exit 1
IDS=$(ONLY_IDS="$ONLY" python3 - "${FILES[@]}" <<'PY'
import json, os, sys
only = [x for x in os.environ.get('ONLY_IDS', '').split(',') if x]
for f in sys.argv[1:]:
    for t in json.load(open(f)):
        if not only or t['id'] in only:
            print(t['id'])
PY
)

if [ $JUDGE_ONLY = 0 ]; then
echo "== 2/5 responses"
for m in $MODELS; do for a in $BASE $CAND; do for t in $IDS; do echo "$a $m $t"; done; done; done \
  | ./dispatch.sh "$JOBS"
if find "$EVAL_DIR/runs" -name STOP | grep -q .; then echo "a quota or billing message came back; stopping. Nothing was topped up." >&2; exit 99; fi

echo "== 3/5 scores"
for d in "$EVAL_DIR"/runs/*/*/*/; do [ -f "$d/transcript.jsonl" ] && python3 runmeta.py "$(basename "$(dirname "$d")")" "${d%/}" 2>/dev/null; done
for a in $BASE $CAND; do for m in $MODELS; do for t in $IDS; do
  R=$EVAL_DIR/runs/$a/$m/$t
  [ -f "$R/score.json" ] || [ ! -f "$R/done" ] || echo "$t $R"
done; done; done | xargs -P "$JOBS" -L 1 sh -c 'python3 score.py "$0" "$1" --tasks '"${FILES[*]}"' || echo "score failed for $0 $1" >&2'

fi

echo "== 4/5 judge"
python3 judge.py "$LABEL" --base "$BASE" --cand "$CAND" --models $MODELS --tasks "${FILES[@]}" ${ONLY:+--only "$ONLY"} >/dev/null || exit 1

echo "== 5/5 report"
python3 report.py "$LABEL" --base "$BASE" --cand "$CAND" --models $MODELS --tasks "${FILES[@]}"
