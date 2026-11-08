#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# One response: respond.sh <arm> <model> <task id>
#   arm    none  no Hildegard skills; main  skills from `git archive origin/main skills`; new  skills from $NEW_SKILLS
#          (default: this checkout's skills/)
#   model  haiku  Claude Haiku 5.5 through `claude -p`; luna  GPT-6 Luna at low effort through `codex exec`
# Subscriptions only: ANTHROPIC_API_KEY and OPENAI_API_KEY are unset. If a quota or billing message comes back, this
# writes STOP in the run folder and exits 99 (dispatch.sh then halts every later job; a STOP file also stops this script before it
# calls a model). A sign-in or token-refresh failure in Haiku's session does the same, since with HILDEGARD_EVAL_ALLOW_CREDENTIALS=1 a
# refresh in the box can strand the owner's other sessions (README: Responder confinement). Skips a run that finished (its `done` file) with the same skills hash (skills.sha), and for Haiku only one whose
# meta.json says `confined: true` (made in the box, so never one from before it). Exits 4, with no `done`, when
# the responder dies before a finished transcript, 5 when Haiku's session cannot be confined (no bubblewrap) or has no
# CLAUDE_CODE_OAUTH_TOKEN (and no HILDEGARD_EVAL_ALLOW_CREDENTIALS=1) or when Luna is asked for without HILDEGARD_EVAL_ALLOW_UNCONFINED_LUNA=1, and 6 when the session left anything in work/ but regular files
# and folders, a symbolic link or a FIFO say (nothing on the host reads work/ then, so a link to the owner's files is never followed).
#
# Layout: $EVAL_DIR/runs/<arm>/<model>/<task>/{work/, plug/ (haiku), prompt.txt, transcript.jsonl, err.txt, final.txt, meta.json, skills.sha, done}
set -u
ARM=$1; MODEL=$2; TASK=$3
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel)
E=${EVAL_DIR:-$HOME/.cache/hildegard-creative-eval}
RUN=$E/runs/$ARM/$MODEL/$TASK; WORK=$RUN/work
# Luna runs in JAIL (an env wrapper), not in the bubblewrap box, so it could read the owner's files by absolute path. Refused (exit 5, before
# anything is written or any model called, so no `done` and never scored) unless the owner opts in on a machine with nothing private on it.
if [ "$MODEL" = luna ] && [ "${HILDEGARD_EVAL_ALLOW_UNCONFINED_LUNA:-}" != 1 ]; then
  echo "Luna runs outside the bubblewrap box and could read the owner's files; refused. Set HILDEGARD_EVAL_ALLOW_UNCONFINED_LUNA=1 to run it anyway, on a machine with nothing private on it." >&2
  echo "not running $ARM/$MODEL/$TASK" >&2; exit 5
fi

case $ARM in
  none) SK="" ;;
  main) # keyed by the skills tree on origin/main, so a moved main is archived again and never mixed with the old one
        TREE=$(git -C "$REPO" rev-parse origin/main:skills) || { echo "no origin/main:skills" >&2; exit 2; }
        SK=$E/skills-main-${TREE:0:12}
        if [ ! -d "$SK/skills" ]; then
          mkdir -p "$E" && T=$(mktemp -d "$SK.XXXXXX") && git -C "$REPO" archive origin/main skills | tar -x -C "$T" && { mv -T "$T" "$SK" 2>/dev/null || rm -rf "$T"; }
        fi
        [ -d "$SK/skills" ] || { echo "could not archive origin/main skills into $SK" >&2; exit 2; } ;;
  new)  SK=$(dirname "${NEW_SKILLS:-$REPO/skills}"); [ "$(basename "${NEW_SKILLS:-$REPO/skills}")" = skills ] || { echo "NEW_SKILLS must end in /skills" >&2; exit 2; } ;;
  *) if [ -d "$E/arms/$ARM/skills" ]; then SK=$E/arms/$ARM; else echo "arm: none|main|new, or a folder made by arms.py in $E/arms" >&2; exit 2; fi ;;
esac
# A finished run is reused only while the skills it was made with are unchanged (a run from before this check has no skills.sha
# and is made again). The hash goes into meta.json, and the report prints it. A Haiku run is reused only when meta.json says it was
# made confined, so a run from before the box is made again and an arm never mixes runs from both.
if [ -n "$SK" ]; then HASH=$(python3 "$HERE/skillhash.py" "$SK/skills") || exit 2; else HASH=none; fi
confined() { [ "$MODEL" != haiku ] || python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("confined") is True else 1)' "$RUN/meta.json" 2>/dev/null; }
[ -f "$RUN/done" ] && { [ "$ARM" = none ] || [ "$(cat "$RUN/skills.sha" 2>/dev/null)" = "$HASH" ]; } && confined && exit 0
# One quota or billing message anywhere halts every later response until its STOP file is removed.
if find "$E/runs" -name STOP 2>/dev/null | grep -q .; then echo "a STOP file is present under $E/runs; not calling a model" >&2; exit 99; fi
# Haiku's session runs in bubblewrap (sandbox.py responder): the filesystem read-only, the owner's home, /tmp and the eval folder
# hidden, only this run's work/ writable. Without bubblewrap it is refused (exit 5), never run unconfined.
CONFINED=()
if [ "$MODEL" = haiku ]; then
  BOXF=$(mktemp "${TMPDIR:-/tmp}/hg-box.XXXXXX") || exit 2
  python3 "$HERE/sandbox.py" responder "$RUN" "$E" > "$BOXF" || { rm -f "$BOXF"; echo "not running $ARM/$MODEL/$TASK" >&2; exit 5; }
  mapfile -d '' BOX < "$BOXF"; rm -f "$BOXF"; CONFINED=(--confined)
fi
rm -rf "$RUN"; mkdir -p "$WORK"; printf '%s\n' "$HASH" > "$RUN/skills.sha"

# The task's inputs, and the prompt.
[ -d "$E/inputs/$TASK" ] && cp "$E/inputs/$TASK"/* "$WORK"/
PROMPT=$(python3 - "$HERE" "$TASK" "$ARM" "$MODEL" <<'PY'
import json, sys, os
here, tid, arm, model = sys.argv[1:]
t = next(t for f in ('tasks.json', 'heldout.json', 'heldout2.json', 'tasks-brand.json', 'heldout-brand.json') for t in json.load(open(os.path.join(here, f))) if t['id'] == tid)
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
elif d == 'logo':
    tail = (f"Deliver in the current folder: mark.svg (the mark alone: the symbol or monogram that becomes the favicon), logo.svg (the main lockup: the mark and the name together, side by side), "
            f"and sheet.png, a logo sheet that shows the lockups, the mark at 16, 32 and 64 px, one-color and reversed versions, clear space and the minimum size. Each SVG must be self-contained (no external files or fonts). "
            f"Tools here: python3 with Pillow, rsvg-convert, and Chromium at {chrome} (for example `{chrome} --no-sandbox --hide-scrollbars --window-size=1200,1600 --screenshot=out.png file://$PWD/page.html`). The internet is available for Google Fonts. Print only a one-line note when you are done.")
elif d == 'brand':
    tail = (f"Files in the current folder: {inputs} (the client's logo). Deliver in the current folder: brand.json, the brand system as data (palette with each color's role and hex, the contrast of the text and background pairs, "
            f"the type pairing and scale, the voice in three lines with do and don't examples, imagery rules); and guide.html, a one-page brand guide built from it, exactly one US letter page: 816 x 1056 CSS px, html and body margin 0, nothing beyond that size. "
            f"Google Fonts through a <link> are allowed; images must be inline or files in this folder. It will be rendered with Chromium at 816 x 1056. You can render it yourself: `{chrome} --no-sandbox --hide-scrollbars --window-size=816,1056 --screenshot=check.png file://$PWD/guide.html`. Print only a one-line note when you are done.")
elif d == 'app':
    w, h = t['size']
    states = ' and '.join(f'{s}.html' for s in t['states'])
    tail = (f"Deliver in the current folder: {states}, each one self-contained HTML file (inline CSS and SVG; Google Fonts through a <link> are allowed; no JavaScript needed) showing the app screen at exactly {w} x {h} CSS px "
            f"on a {t['platform']} device, as the brief describes each state. They will be rendered with Chromium in a {w} x {h} viewport. You can render one yourself: `{chrome} --no-sandbox --hide-scrollbars --window-size={max(w, 520)},{h} --screenshot=check.png file://$PWD/screen.html` "
            f"(the window can't be narrower than about 500 px, so crop to {w} px wide). Print only a one-line note when you are done.")
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
print(pre + t['brief'] + '\n\n' + tail)
PY
)
printf '%s' "$PROMPT" > "$RUN/prompt.txt"

# Luna's session sees little of the host: an empty HOME (so no shell profile puts ~/.local/bin, the hildegard CLI or a
# browser launcher on PATH), only the CLIs it needs, its own process namespace (no view of the real Hildegard service)
# and no new privileges (no sudo). Its sign-in comes through CODEX_HOME. Haiku's session never runs in JAIL: it runs only in
# the bubblewrap box above (BOX), whose claude binary sandbox.py picks and binds (HILDEGARD_EVAL_CLAUDE is the self-test's hook).
BIN=$E/bin; mkdir -p "$BIN" "$RUN/home"
ln -sf "$(command -v node)" "$BIN/node"; ln -sf "$(readlink -f "$(command -v codex)")" "$BIN/codex"
CHROME=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | sort | tail -1)
JAIL=(env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR HOME="$RUN/home"
      CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" PATH="$BIN:/usr/bin:/bin" HILDEGARD_CHROMIUM="$CHROME"
      unshare -rpf --mount-proc setpriv --no-new-privs)
LIMIT=1200; case $TASK in l*|b*|p*) LIMIT=2700;; esac

T0=$(date +%s)
if [ "$MODEL" = haiku ]; then
  ARGS=(-p --model haiku --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence
        --tools "Read,Write,Bash,Skill,Agent" --allowedTools "Read,Write,Bash,Skill,Agent" --max-turns 120 --output-format stream-json --verbose)
  if [ -n "$SK" ]; then
    mkdir -p "$RUN/plug/.claude-plugin" && cp -r "$SK/skills" "$RUN/plug/skills"
    printf '{"name":"hildegard","version":"0.0.0","description":"eval copy of the skills"}' > "$RUN/plug/.claude-plugin/plugin.json"
    ARGS+=(--plugin-dir "$RUN/plug")
  fi
  # CLAUDE_CODE_OAUTH_TOKEN reaches the box through a pipe that bwrap reads as arguments (sandbox.py adds `--args 7`), never argv or a file.
  tok() { [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || printf '%s\0' --setenv CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN"; }
  (cd "$WORK" && printf '%s' "$PROMPT" | env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY timeout "$LIMIT" "${BOX[@]}" "${ARGS[@]}" > "$RUN/transcript.jsonl" 2> "$RUN/err.txt" 7< <(tok))
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
  (printf '%s' "$PROMPT" | timeout "$LIMIT" "${JAIL[@]}" codex exec -m gpt-6-luna -c model_reasoning_effort=low -c "$CFG" \
      --skip-git-repo-check --ignore-user-config --ephemeral -s workspace-write -C "$WORK" --json - > "$RUN/transcript.jsonl" 2> "$RUN/err.txt")
else
  echo "model: haiku|luna" >&2; exit 2
fi
echo $(( $(date +%s) - T0 )) > "$RUN/seconds"

# A link in work/ points the host at whatever the model chose (~/.ssh, say), a FIFO hangs whatever opens it, and everything after
# this runs unconfined. So before anything reads work/: make every folder in it readable and searchable again (the model owns them
# and may have run `chmod 0111 .` to hide a link from find; chmod -R follows no link), then fail the run if work/ holds anything
# but regular files and folders, or if either step fails.
LINKS=
if [ -L "$WORK" ] || [ ! -d "$WORK" ]; then LINKS='work/ itself'
elif ! chmod -R u+rwX "$WORK"; then LINKS='(work/ could not be made readable)'
else
  ODD=$(cd "$WORK" && find . ! -type f ! -type d) || ODD='(work/ could not be searched)'
  [ -z "$ODD" ] || LINKS=$(printf '%s\n' "$ODD" | head -5 | tr '\n' ' ')
fi
python3 "$HERE/runmeta.py" "$MODEL" "$RUN" "${CONFINED[@]}" ${LINKS:+--links "$LINKS"} || true
# Exit 99 on a quota or billing message, found in the final text, stderr or the end of the transcript whether or not meta.json exists:
# never top up, never switch to API billing. Exit 4 when the responder died before a finished transcript (no `done`, so it is made again).
python3 - "$RUN" "$MODEL" <<'PY'
import json, re, sys, os
run, model = sys.argv[1:3]
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
# claude's own words when its sign-in fails or a token refresh is refused (exit 98 here, STOP and 99 below)
auth = re.compile(r'OAuth token (refresh failed|revoked|has expired)|token refresh failed|login expired|please run /login|run /login to|'
                  r'not logged in|invalid api key|authentication_error|authentication_failed|invalid_grant|API Error: 401', re.I)
if model == 'haiku' and (auth.search(text) or auth.search(read('err.txt')) or (not meta.get('finished') and auth.search(read('transcript.jsonl')))):
    sys.exit(98)
if bad.search(text) or bad.search(read('err.txt').replace('rmcp::transport', '')) or (not meta.get('finished') and bad.search(read('transcript.jsonl'))):
    sys.exit(99)
sys.exit(0 if meta.get('finished') else 4)
PY
rc=$?
if [ $rc -eq 98 ]; then
  echo "Claude's sign-in failed in $RUN; stopping. Run claude on this computer and /login (or make a new CLAUDE_CODE_OAUTH_TOKEN), then delete $RUN/STOP" >&2
  echo 'sign-in failed: /login on the host, then delete this file' > "$RUN/STOP"; exit 99
fi
if [ $rc -eq 99 ]; then echo "quota or billing message in $RUN; stopping" >&2; : > "$RUN/STOP"; exit 99; fi
if [ -n "$LINKS" ]; then echo "the session left symbolic links or other special files in $RUN/work ($LINKS); the run fails and nothing reads them" >&2; exit 6; fi
if [ $rc -ne 0 ]; then echo "the responder died before a finished transcript in $RUN: $(head -c 300 "$RUN/err.txt" 2>/dev/null)" >&2; exit 4; fi
touch "$RUN/done"
