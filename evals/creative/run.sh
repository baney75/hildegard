#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# The whole eval: inputs, responses, scores, judge, report. Resumable: each stage skips what already exists.
#
#   evals/creative/run.sh <label> [--set tuned|heldout|both|media|media-heldout|media-both] [--tasks-file a.json,b.json]
#                         [--base none] [--cand main] [--new-skills DIR] [--models "haiku luna"] [--only id,id] [--jobs 4]
#
# --tasks-file names the task files to run (comma separated, relative to this folder or absolute) and replaces --set.
# --cand new compares this checkout's skills/ (or --new-skills DIR, any folder of skill folders; same as $NEW_SKILLS) against --base
# (default none; use --base main for a change). The new arm's run folder is tied to the skills it was made with.
# Writes evals/creative/results-<label>.json and prints the summary. State lives in $EVAL_DIR (default
# ~/.cache/hildegard-creative-eval), outside git. Needs: claude and codex signed in with a subscription, ffmpeg, numpy, Pillow,
# Playwright's Chromium (~/.cache/ms-playwright). Never uses an API key.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=${1:?label}; shift
SET=tuned; TF=""; BASE=none; CAND=main; MODELS="haiku luna"; ONLY=""; JOBS=4
while [ $# -gt 0 ]; do case $1 in
  --set) SET=$2; shift 2;; --tasks-file) TF=$2; shift 2;; --new-skills) export NEW_SKILLS=$2; shift 2;; --base) BASE=$2; shift 2;; --cand) CAND=$2; shift 2;;
  --models) MODELS=$2; shift 2;; --only) ONLY=$2; shift 2;; --jobs) JOBS=$2; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
export EVAL_DIR=${EVAL_DIR:-$HOME/.cache/hildegard-creative-eval}
unset ANTHROPIC_API_KEY OPENAI_API_KEY
case $SET in tuned) FILES=(tasks.json);; heldout) FILES=(heldout.json);; both) FILES=(tasks.json heldout.json);;
  media) FILES=(tasks-media.json);; media-heldout) FILES=(heldout-media.json);; media-both) FILES=(tasks-media.json heldout-media.json);;
  *) echo "--set tuned|heldout|both|media|media-heldout|media-both" >&2; exit 2;; esac
if [ -n "$TF" ]; then IFS=, read -r -a FILES <<< "$TF"; fi
cd "$HERE" || exit 1
for i in "${!FILES[@]}"; do [ -f "${FILES[$i]}" ] || { echo "no task file ${FILES[$i]}" >&2; exit 2; }; FILES[$i]=$(cd "$(dirname "${FILES[$i]}")" && pwd)/$(basename "${FILES[$i]}"); done
export TASK_FILES="${FILES[*]}"
git -C "$HERE" fetch -q origin 2>/dev/null

echo "== 1/5 inputs"; python3 make_audio.py "${FILES[@]}" && python3 make_media.py "${FILES[@]}" || exit 1
IDS=$(ONLY_IDS="$ONLY" python3 - "${FILES[@]}" <<'PY'
import json, os, sys
only = [x for x in os.environ.get('ONLY_IDS', '').split(',') if x]
for f in sys.argv[1:]:
    for t in json.load(open(f)):
        if not only or t['id'] in only:
            print(t['id'])
PY
)

echo "== 2/5 responses"
for m in $MODELS; do for a in $BASE $CAND; do for t in $IDS; do echo "$a $m $t"; done; done; done \
  | xargs -P "$JOBS" -L 1 sh -c './respond.sh "$0" "$1" "$2" || { [ $? -eq 99 ] && echo STOP >&2; }'
if find "$EVAL_DIR/runs" -name STOP | grep -q .; then echo "a quota or billing message came back; stopping. Nothing was topped up." >&2; exit 99; fi

echo "== 3/5 scores"
for d in "$EVAL_DIR"/runs/*/*/*/; do [ -f "$d/transcript.jsonl" ] && python3 runmeta.py "$(basename "$(dirname "$d")")" "${d%/}" 2>/dev/null; done
for a in $BASE $CAND; do for m in $MODELS; do for t in $IDS; do
  R=$EVAL_DIR/runs/$a/$m/$t
  [ -f "$R/score.json" ] || [ ! -d "$R/work" ] || echo "$t $R"
done; done; done | xargs -P "$JOBS" -L 1 sh -c 'python3 score.py "$0" "$1" --tasks '"${FILES[*]}"' || echo "score failed for $0 $1" >&2'

echo "== 4/5 judge"
python3 judge.py "$LABEL" --base "$BASE" --cand "$CAND" --models $MODELS --tasks "${FILES[@]}" ${ONLY:+--only "$ONLY"} >/dev/null || exit 1

echo "== 5/5 report"
python3 report.py "$LABEL" --base "$BASE" --cand "$CAND" --models $MODELS --tasks "${FILES[@]}"
