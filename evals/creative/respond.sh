#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# One response: respond.sh <arm> <model> <task id>
#   arm    none  no Hildegard skills; main  skills from `git archive origin/main skills`; new  skills from $NEW_SKILLS
#          (default: this checkout's skills/)
#   model  haiku  Claude Haiku 5.5 through `claude -p`; luna  GPT-6 Luna at low effort through `codex exec`
# Subscriptions only: ANTHROPIC_API_KEY and OPENAI_API_KEY are unset. If a quota or billing message comes back, this
# writes STOP in the run folder and exits 99 (dispatch.sh then halts every later job; a STOP file also stops this script before it
# calls a model). Skips a run that finished (its `done` file) with the same skills hash (skills.sha). Exits 4, with no `done`, when
# the responder dies before a finished transcript.
#
# Layout: $EVAL_DIR/runs/<arm>/<model>/<task>/{work/, plug/ (haiku), prompt.txt, transcript.jsonl, err.txt, final.txt, meta.json, skills.sha, done}
set -u
ARM=$1; MODEL=$2; TASK=$3
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel)
E=${EVAL_DIR:-$HOME/.cache/hildegard-creative-eval}
RUN=$E/runs/$ARM/$MODEL/$TASK; WORK=$RUN/work

case $ARM in
  none) SK="" ;;
  main) # keyed by the skills tree on origin/main, so a moved main is archived again and never mixed with the old one
        TREE=$(git -C "$REPO" rev-parse origin/main:skills) || { echo "no origin/main:skills" >&2; exit 2; }
        SK=$E/skills-main-${TREE:0:12}
        if [ ! -d "$SK/skills" ]; then
          T=$(mktemp -d "$SK.XXXXXX") && git -C "$REPO" archive origin/main skills | tar -x -C "$T" && { mv -T "$T" "$SK" 2>/dev/null || rm -rf "$T"; }
        fi ;;
  new)  SK=$(dirname "${NEW_SKILLS:-$REPO/skills}"); [ "$(basename "${NEW_SKILLS:-$REPO/skills}")" = skills ] || { echo "NEW_SKILLS must end in /skills" >&2; exit 2; } ;;
  *) echo "arm: none|main|new" >&2; exit 2 ;;
esac
# A finished run is reused only while the skills it was made with are unchanged (a run from before this check has no skills.sha
# and is made again). The hash goes into meta.json, and the report prints it.
if [ -n "$SK" ]; then HASH=$(python3 "$HERE/skillhash.py" "$SK/skills") || exit 2; else HASH=none; fi
[ -f "$RUN/done" ] && { [ "$ARM" = none ] || [ "$(cat "$RUN/skills.sha" 2>/dev/null)" = "$HASH" ]; } && exit 0
# One quota or billing message anywhere halts every later response until its STOP file is removed.
if find "$E/runs" -name STOP 2>/dev/null | grep -q .; then echo "a STOP file is present under $E/runs; not calling a model" >&2; exit 99; fi
rm -rf "$RUN"; mkdir -p "$WORK"; printf '%s\n' "$HASH" > "$RUN/skills.sha"

# The task's inputs, and the prompt.
[ -d "$E/inputs/$TASK" ] && cp "$E/inputs/$TASK"/* "$WORK"/
# An ops task (managing Hildegard) runs in a fake world of its own: servers on free ports, a PATH with a world-bound `hildegard`,
# HOME inside the world for Hildegard itself. ops_world.py builds it before the model starts, captures its real end state when the
# model stops, and takes it down on any exit.
DOMAIN=$(python3 -c "
import json, sys
for f in ('tasks.json', 'heldout.json'):
    for t in json.load(open('$HERE/' + f)):
        if t['id'] == '$TASK':
            print(t['domain'])
")
OPSENV=(); OPSADD=(); NNP=(); RUNW=(timeout 1200)
if [ "$DOMAIN" = ops ]; then
  trap 'python3 "$HERE/ops_world.py" down "$RUN" >/dev/null 2>&1' EXIT
  if ! python3 "$HERE/ops_world.py" up "$TASK" "$RUN" --tasks "$HERE/tasks.json" "$HERE/heldout.json" > "$RUN/world-up.log" 2>&1; then
    cat "$RUN/world-up.log" >&2; echo "world for $TASK did not start" >&2; exit 98
  fi
  mapfile -t OPSENV < "$RUN/world.env"
  WORK=$(cat "$RUN/world.work")   # the working folder lives in the world; ops_world.py copies it back to $RUN/work on the way out
  OPSENV+=("CLAUDE_CONFIG_DIR=$HOME/.claude" "CODEX_HOME=${CODEX_HOME:-$HOME/.codex}")
  for d in $(cat "$RUN/world.adddirs"); do OPSADD+=(--add-dir "$d"); done
  CLAUDE_BIN=$(mise which claude 2>/dev/null || command -v claude); CODEX_BIN=$(command -v codex)
  # Ten minutes, not twenty: a model that starts a model download and then waits for it is waiting on a stub that never finishes.
  APP=$(python3 -c "import json; print(json.load(open('$RUN/world.json'))['app'])")
  RUNW=("$APP/ops_run.sh" "$RUN" 600)
  # No new privileges for the model and everything it runs (this computer has passwordless sudo, which fails under this flag), and
  # a user and PID namespace of its own, so `ps` and /proc show only what the model started: not the real Hildegard service, not other worlds.
  NNP=(setpriv --no-new-privs)
  if unshare -rpf --mount-proc true 2>/dev/null; then NNP=(unshare -rpf --mount-proc setpriv --no-new-privs); fi
else
  CLAUDE_BIN=claude; CODEX_BIN=codex
fi
PROMPT=$(OPS_RUN="$RUN" python3 - "$HERE" "$TASK" "$ARM" "$MODEL" <<'PY'
import json, sys, os
here, tid, arm, model = sys.argv[1:]
t = next(t for f in ('tasks.json', 'heldout.json', 'heldout2.json') for t in json.load(open(os.path.join(here, f))) if t['id'] == tid)
chrome = os.environ.get('HILDEGARD_EVAL_CHROMIUM') or ''
if not chrome:
    import glob
    c = sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome')))
    chrome = c[-1] if c else 'chromium'
d = t['domain']
inputs = ', '.join(t.get('inputs', [])) or ('clip_a.mp4, clip_b.mp4, clip_c.mp4, clip_d.mp4, music.wav' if d == 'videoedit' else '')
if d == 'design':
    w, h = t['size']
    tail = (f"Deliver exactly one self-contained HTML file named design.html in the current folder: inline CSS and inline SVG only, Google Fonts through a <link> are allowed, no other network resources, no JavaScript needed. "
            f"The design is exactly {w} x {h} px: html and body margin 0, body width {w}px and height {h}px, overflow hidden. It will be rendered to a PNG with Chromium at that size. "
            f"You can render it yourself to check your work: `{chrome} --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size={w},{h} --virtual-time-budget=12000 --screenshot=check.png file://$PWD/design.html`, then look at check.png. Print only a one-line note when you are done.")
elif d == 'video':
    tail = ("Save the production plan as plan.md in the current folder. The piece will be generated shot by shot with a text- or image-to-video model such as LTX-Video or Wan 2.x "
            "(clips of up to about 5 seconds each; the model cannot render legible text, so on-screen text is added in the edit). The plan must contain: a one-paragraph concept; a shot list giving, for every shot, its number, "
            "duration in seconds, camera and lens, the complete generation prompt, and the transition into the next shot; an edit decision list with timecodes that totals the stated length; and a sound plan (music, voice-over lines, sound effects, loudness). "
            "Print only a one-line note when you are done.")
elif d == 'audio':
    tail = (f"Files in the current folder: {inputs}. Deliver one bash script named process.sh in the current folder that uses only ffmpeg and ffprobe (sox is also installed) and ordinary shell tools: no Python, no network. "
            "It will be run later as `bash process.sh` in a folder that holds only the input files above, and it must write out.wav in that folder in under 120 seconds. Test it yourself on the files here before you finish. Print only a one-line note when you are done.")
elif d == 'writing':
    tail = "Save the final text as draft.md in the current folder, and print only the final text."
elif d == 'videoedit':
    tail = (f"Files in the current folder: {inputs}. Deliver one bash script named edit.sh in the current folder that uses only ffmpeg and ffprobe and ordinary shell tools: no network. "
            "It will be run later as `bash edit.sh` in a folder that holds only the files above, and it must write out.mp4 in that folder in under 180 seconds. Test it yourself on the files here before you finish. Print only a one-line note when you are done.")
pre = ''
if arm != 'none':
    if model == 'haiku':
        pre = "The Hildegard skills are installed in this session. Before you start, load the one that fits this job (and read the reference files it points to for this kind of work), then follow it.\n\n"
    else:
        pre = "Hildegard's creative skills are installed in .agents/skills/ in the current folder (hildegard, hildegard-art, hildegard-web, and others). Before you start, read the SKILL.md that fits this job and the reference files it points to, then follow it.\n\n"
if d == 'ops':
    w = json.load(open(os.path.join(os.environ['OPS_RUN'], 'world.json')))
    brief = t['brief']
    for sid in w['order']:
        brief = (brief.replace('{url:%s}' % sid, 'http://127.0.0.1:%d' % w['port'][sid]).replace('{data:%s}' % sid, w['data'][sid])
                 .replace('{models:%s}' % sid, w['data'][sid] + '/comfyui/models'))
    tools = t['world'].get('tools', [])
    tail = ("You are at a shell on the owner's computer, the one the request calls \"this computer\" (or \"this laptop\", \"this desktop\"). Do the job by running commands. "
            "Hildegard's command is `hildegard` (every command takes --json). ")
    if 'make-take' in tools:
        tail += ("Hildegard's command line has no render command of its own (an AI app would use Hildegard's MCP shot tool), so `make-take \"<what the shot shows>\"` stands in for it here: "
                 "it queues one test take on this computer and waits up to 90 seconds for it, then prints the take's status. ")
    if 'ssh' in tools:
        tail += "`ssh <device> <command>` runs a command on the owner's other computer that is switched on. "
    tail += ("When you are finished, print a short reply to the owner in plain words: what you did, what is true now, and anything only they can do. Do not ask them questions.")
    print(pre + brief + '\n\n' + tail)
else:
    print(pre + t['brief'] + '\n\n' + tail)
PY
)
printf '%s' "$PROMPT" > "$RUN/prompt.txt"

T0=$(date +%s)
if [ "$MODEL" = haiku ]; then
  ARGS=(-p --model haiku --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence
        --tools "Read,Write,Bash,Skill" --allowedTools "Read,Write,Bash,Skill" --max-turns 60 --output-format stream-json --verbose)
  if [ -n "$SK" ]; then
    mkdir -p "$RUN/plug/.claude-plugin" && cp -r "$SK/skills" "$RUN/plug/skills"
    printf '{"name":"hildegard","version":"0.0.0","description":"eval copy of the skills"}' > "$RUN/plug/.claude-plugin/plugin.json"
    ARGS+=(--plugin-dir "$RUN/plug")
  fi
  (cd "$WORK" && printf '%s' "$PROMPT" | env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY "${OPSENV[@]}" "${NNP[@]}" "${RUNW[@]}" "$CLAUDE_BIN" "${ARGS[@]}" > "$RUN/transcript.jsonl" 2> "$RUN/err.txt")
elif [ "$MODEL" = luna ]; then
  [ -n "$SK" ] && { mkdir -p "$WORK/.agents" && cp -r "$SK/skills" "$WORK/.agents/skills"; }
  # Codex also reads the owner's global skills (~/.agents/skills, ~/.codex/skills); switch each off by path so both arms see
  # only the bundled system skills plus the arm's own. (The owner's ~/.codex/AGENTS.md still loads; it is the same in every arm.)
  CFG=$(python3 - <<'PY'
import glob, os
ps = [p for r in ('~/.agents/skills', '~/.codex/skills') for p in glob.glob(os.path.expanduser(r) + '/**/SKILL.md', recursive=True)]
print('skills.config=[' + ','.join('{path="%s",enabled=false}' % p for p in ps) + ']')
PY
)
  # An ops task needs the loopback network and the world's own folders; nothing else outside the work folder is writable.
  XTRA=(); [ "$DOMAIN" = ops ] && XTRA=(-c sandbox_workspace_write.network_access=true "${OPSADD[@]}")
  (printf '%s' "$PROMPT" | env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY "${OPSENV[@]}" "${NNP[@]}" "${RUNW[@]}" "$CODEX_BIN" exec -m gpt-6-luna -c model_reasoning_effort=low -c "$CFG" \
      --skip-git-repo-check --ignore-user-config --ephemeral -s workspace-write "${XTRA[@]}" -C "$WORK" --json - > "$RUN/transcript.jsonl" 2> "$RUN/err.txt")
else
  echo "model: haiku|luna" >&2; exit 2
fi
echo $(( $(date +%s) - T0 )) > "$RUN/seconds"
# The world's real end state, read before anything is stopped; the score reads this file, not the live servers. ops_run.sh already took
# it inside the responder's namespace; this is only for a run that ended without it.
[ "$DOMAIN" = ops ] && { [ -f "$RUN/final.json" ] || python3 "$HERE/ops_world.py" capture "$RUN" final; }

python3 "$HERE/runmeta.py" "$MODEL" "$RUN" || true
# Exit 99 on a quota or billing message, found in the final text, stderr or the end of the transcript whether or not meta.json exists:
# never top up, never switch to API billing. Exit 4 when the responder died before a finished transcript (no `done`, so it is made again).
python3 - "$RUN" <<'PY'
import json, re, sys, os
run = sys.argv[1]
def read(name, tail=4000):
    try:
        return open(os.path.join(run, name), errors='replace').read()[-tail:]
    except OSError:
        return ''
try:
    meta = json.load(open(os.path.join(run, 'meta.json')))
except (OSError, ValueError):
    meta = {}
bad = re.compile(r'usage limit|quota|billing|credit balance|rate.?limit|out of (extra )?usage|upgrade your plan|purchase', re.I)
text = read('final.txt') if meta.get('is_error') else ''
if bad.search(text) or bad.search(read('err.txt').replace('rmcp::transport', '')) or (not meta.get('finished') and bad.search(read('transcript.jsonl'))):
    sys.exit(99)
sys.exit(0 if meta.get('finished') else 4)
PY
rc=$?
if [ $rc -eq 99 ]; then echo "quota or billing message in $RUN; stopping" >&2; : > "$RUN/STOP"; exit 99; fi
if [ $rc -ne 0 ]; then echo "the responder died before a finished transcript in $RUN: $(head -c 300 "$RUN/err.txt" 2>/dev/null)" >&2; exit 4; fi
touch "$RUN/done"
