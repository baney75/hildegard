# Creative eval: do the skills make weak models produce excellent design, video and audio work?

A blind, repeatable head-to-head for the Hildegard skills in design, video, audio and everyday writing. The owner's bar is
that even a weak model, given the skills, should turn out amazing designs, video designs, audio work and prose. This eval
measures that: a cheap model answers a real client brief with no skills (`none`) and with the skills (`main`, or `new` for a
branch), and Claude Opus, who is not told which is which, picks the better piece. Audio and video-edit scripts are also scored
by measurement. Run it before and after any change to `skills/` and keep a change only if it wins.

## What it measures

| Domain | Tasks (tuned + held-out) | Deliverable | Scored by |
| --- | --- | --- | --- |
| design | 3 + 2: church flyer 1080x1350, album cover 1400x1400, hardware-store social square 1080x1080; 4-H sale poster 1200x1800, podcast cover | one self-contained `design.html`, rendered to PNG with Playwright's Chromium | Opus looks at both PNGs |
| video | 3 + 2: a detailer's 9:16 reel, a church Christmas Eve invitation, a woodshop film; a robotics trailer, a CSA farm ad | `plan.md`: shot list with generation prompts, camera, lens, duration, transitions, an edit decision list, a sound plan | Opus, by rubric (nothing is rendered) |
| audio | 3 + 2: clean a podcast voice, a ducked church announcement, a 15-second radio spot; clean a sermon recording, a farm voice-over | `process.sh`: ffmpeg (and sox) only, writes `out.wav` | measurement (below), then Opus reads the metrics table and both scripts |
| writing | 3 + 2: an email to a congregation, a price-change blog post, an event page; a short bio, a customer email | `draft.md` | `prose_lint.py` fails and warns; Opus picks, and lists invented facts |
| video edit | 1 (tuned only): cut four mismatched clips into a 22 to 28 second piece with titles and a music bed | `edit.sh`: ffmpeg only, writes `out.mp4` | measurement (below), then Opus reads the metrics, the script and a contact sheet of the result |

`tasks.json` is the tuned set (13 tasks). `heldout.json` holds 8 more, written now and never used for tuning: read it as
evidence, and read `tasks.json` results as the set you tune against. Every brief carries the client's facts and says "don't
ask me questions", so the eval measures making the work, not the interview.

## Method

- **Responders** (subscriptions only; `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are unset, and a quota or billing message stops the run):
  - `haiku`: Claude Haiku 5.5, `claude -p --model haiku --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'`, tools
    Read, Write, Bash and Skill. The arm's skills reach it as a plugin (`--plugin-dir` on a temp copy of `skills/`), the way the
    installed plugin gives them; the init event lists them as `hildegard:hildegard`, `hildegard:hildegard-art`, and so on.
    `--setting-sources ""` keeps the owner's CLAUDE.md, user skills and settings out. The `none` arm has no plugin.
  - `luna`: GPT-6 Luna, `codex exec -m gpt-6-luna -c model_reasoning_effort=low --skip-git-repo-check --ignore-user-config -s workspace-write`,
    skills in the work folder's `.agents/skills/`, which Codex reads per project. Codex also loads the owner's global skills, so
    `respond.sh` switches each off by path (`skills.config`); both arms then see only Codex's four bundled system skills plus
    the arm's own. One leak remains and is the same in every arm: `~/.codex/AGENTS.md` still loads, because Codex has no switch for it.
    The real `CODEX_HOME` is used; no auth file is read or copied.
  - The skill arms get one added sentence in the prompt telling the model to load the fitting skill and its references first. Without it
    a weak model rarely reaches for an installed skill unprompted (field note: haiku-never-loads-skills-in-claude-p-trigger-evals). `runmeta.py`
    records from each transcript whether a skill was actually loaded, and the report prints that rate. Design briefs also tell every arm
    where Chromium is, so a model can render its own work and look at it.
- **Inputs** (`make_audio.py`, reproducible): speech is a public-domain LibriVox reading of the Declaration of Independence from
  archive.org, downloaded once to `~/.cache/hildegard-creative-eval/` and pinned by SHA-256
  (`03f70357a1562ba643576d9fc846b9156c79c2af720fe3ac7721a7b275c02f85`). Segments are cut at pauses. Degradations are numpy with a fixed seed:
  60 Hz hum and four harmonics, high-passed hiss, an air-handler rumble (sermon task), level dips, room echo (an exponential
  impulse response with a hard early reflection), and loud plosive thumps clipped at full scale. The music beds, a bell sting and the
  four test clips (`ffmpeg` lavfi sources at 1280x720/30, 1920x1080/24, a 720x1280 portrait clip and 1280x720/25) are synthesized with no
  network. The clean source for each cleaning task is kept in `ref/` and never shown to a responder.
- **Audio scoring** (`score_audio.py`). The responder's script is re-run here, not trusted: in a temp folder holding only the inputs, under
  `sandbox.py` and a 120 s timeout: bubblewrap with the filesystem read-only, a tmpfs over the owner's home, `/tmp` and `/run`,
  only that folder writable, no network, new PID, IPC and UTS namespaces, no capabilities and no new privileges, and a tmpfs over `$EVAL_DIR` wherever it is (the clean references, the inputs
  and the other arm's runs live there, so a script that names their path finds nothing). Scoring a script therefore needs bubblewrap: the `unshare` fallback and `EVAL_SANDBOX=none` cannot hide that folder, so the scorer refuses in those modes;
  with neither it refuses too. The output is measured: integrated loudness and true peak (ffmpeg `ebur128`) against
  the brief's targets; clipped samples; for cleaning tasks the hum prominence at 60/120/180 Hz in the pauses, speech minus pause level, rumble,
  how much the quiet stretches were evened out, how far the pop was tamed, and a STOI-like fidelity against the clean reference (band-envelope
  correlation in 1/3-octave bands; documented in `stoi_like`; it ranks, it is not the standardized STOI). For mix tasks the voice and music
  files are found in the output by cross-correlation and fitted window by window, which gives the ducking depth (music gain in gaps minus
  under speech), the voice-to-music ratio while speaking, whether the lines are in order, where the sting lands, and whether the ending is a
  hard cut. Each metric becomes a pass/fail check, and the full table goes to the judge.
- **Design rendering** (`score.py`): model HTML is untrusted. Chromium gets a throwaway profile and `HOME` in a temp folder (removed afterwards), its own
  sandbox on (`--no-sandbox` only if this machine cannot run it; `chromium_sandbox` in score.json says which), and a dead proxy for every request except
  Google Fonts, loopback and IP addresses included. Limit: Chromium runs outside the bubblewrap sandbox, so a page opened from `file://` can still
  show other local files by path (an image or a frame), the eval folder included; scripts (audio and video edit) run under bubblewrap, which hides it.
- **Video-edit scoring** (`score.py`): ran, edit.sh under the same sandbox, length in range, 1280x720, 30 fps, H.264 and AAC, scene changes (ffmpeg scene score above 0.12), loudness
  within 2 LU, `blackdetect` for black stretches over half a second, and an estimate of which of the four clips appear (colour-histogram match).
- **Writing scoring** (`score.py`): `skills/hildegard/scripts/prose_lint.py --json` on the draft with front matter removed (the repo's `lint` command
  needs a built workspace; the Python lint reproduces it rule for rule). Note that the skill arms know about this lint and the `none` arm does not.
- **Judge** (`judge.py`): Opus (`claude -p --model opus`, no MCP, Read limited to its working folder with `Read(./**)`; a bare `Read` reads anywhere the owner can) sees each task's two deliverables in both orders as `A` and `B`, with
  file names neutralized, front matter stripped and no arm names, against a domain rubric (in the file). Each call runs in a fresh temp folder outside the eval tree that holds only those files (`A.*`, `B.*`); the verdicts, which
  name the arms, are written elsewhere, and a scan refuses to call the judge if the folder holds anything else, a file name names an arm, or a file points into the eval tree. Design: the two rendered PNGs. Video:
  the two plans. Audio and video edit: the measured table, the scripts and, for video edit, a frame contact sheet. It returns the winner, the
  margin (slight or clear), the reasons, and the invented facts it found. If one arm has no usable deliverable, it wins automatically and the verdict is
  flagged `auto`; the report prints how many verdicts were automatic. A run counts only if the responder finished (a `done` file and a `meta.json` with no error): one that timed out or died
  after writing part of its deliverable is never scored or judged, loses automatically, and the report says how many verdicts had such an arm. Before the files are copied, any skill path
  (`.agents/skills/...`, `skills/hildegard-...`, `SKILL.md`), skill name or reference file name in a text deliverable becomes `[reference]`, the same way in both arms, and the scan fails the judgment if one is left.
  A skill-arm plan can still mention a Hildegard tool by name, which is a small leak.
- **Selftest**: `python3 evals/creative/selftest/test_scorers.py` runs a passthrough control and a competent reference script through the scorers;
  the controls must fail the checks they should, and the references must pass. `python3 evals/creative/selftest/test_hardening.py` checks the
  sandbox (a script that writes to the real home or outside its folder, connects out or sees `~/.ssh` fails, a normal ffmpeg script passes), the render
  isolation, run reuse keyed by the skills hash and the `confined` marker, skill-load parsing, a responder that dies, a quota message halting dispatch,
  the judge's folder, and the responder box (F12: a stand-in for `claude` run through `respond.sh` cannot delete or write a file in its home, outside
  its work folder or in another run, cannot see other runs, can write in `work/`, can read but not write, truncate, replace or delete the
  credentials file under `HILDEGARD_EVAL_ALLOW_CREDENTIALS=1`; a native binary at `$HOME/claude` is the only thing of that home visible in the
  box; an override that is a folder or a file directly in the home is refused; with `CLAUDE_CODE_OAUTH_TOKEN` set the box gets the token, never
  in argv, and no credentials file; with neither the token nor the opt-in the run is refused (exit 5) and no model is called; a sign-in
  failure exits 99 and leaves `STOP`; a link, a FIFO, or a link hidden in a folder made unreadable with `chmod 0111` or `0311`, fails the run
  with no `done`; and with no usable bubblewrap the run is refused and no model is called).
- **Responder confinement**: Haiku's whole session, and so its Bash tool, runs in bubblewrap (`sandbox.responder`, used by `respond.sh`). The
  filesystem is read-only. A tmpfs covers the owner's home, `/tmp`, `/run` and the eval folder, so the model sees no `~/.ssh`, no tokens under
  `~/.config`, no agent or D-Bus socket paths and no other run; this run's folder is bound back read-only and only its `work/` is writable.
  Nothing under the home folder comes back except three things, all read-only: the claude binary as that one file (a launcher script on
  PATH, such as a mise one, is skipped for the native binary), the folder of the Chromium the prompt names (a Playwright browser folder under
  `~/.cache/ms-playwright`, or one outside the home), and, only under the opt-in below, the owner's credentials file. `HILDEGARD_EVAL_CLAUDE` overrides the binary; it must
  name a file in a folder of its own, and a folder or a file directly in the home folder is refused. A `HILDEGARD_EVAL_CHROMIUM` whose folder
  is or holds the home folder, sits in or above the eval folder, or is any other folder in the home is refused too. Claude writes its state
  (`.claude.json`, `projects/`, `sessions/`, `backups/`) to a fresh `CLAUDE_CONFIG_DIR` on the tmpfs. **A Haiku run needs a token:** make a
  long-lived one yourself with `claude setup-token` and export it as `CLAUDE_CODE_OAUTH_TOKEN` in the shell that runs `run.sh`. Without it,
  `respond.sh` refuses every Haiku run with exit 5, calls no model, and says so. With it, no credentials file is bound and the box never
  refreshes; the token reaches bwrap through a pipe (`--args`), never argv or a file, and the harness never writes or stores it. The model
  in the box can read it. `HILDEGARD_EVAL_ALLOW_CREDENTIALS=1` is an opt-in that binds your credentials file into the box read-only
  instead, so nothing there can change, truncate or replace it. **What the opt-in risks:** when the access token in that file has expired,
  or expires during a batch, the session refreshes it in the box. The server rotates the refresh token, the new one can't be written back,
  and your file is left with a revoked one, which signs you out of your other Claude Code sessions on this computer. The session itself
  finishes normally. A sign-in or token-refresh failure in a later session (claude's own `OAuth token refresh failed`, `Please run /login`,
  `authentication_error`, `API Error: 401` and the like) then stops the batch the way a quota message does, with exit 99 and a `STOP`
  file, but that comes after the harm. Then run `claude` on this computer, sign in again with `/login`, and delete the `STOP` file. Use the
  token. After the session, before anything on the host reads `work/`, `respond.sh` makes every folder in it readable and searchable again
  (`chmod -R u+rwX`, which follows no link; the model owns `work/` and could `chmod 0111` a folder to hide what is in it), then fails the run
  if `work/` holds anything but regular files and folders: a symbolic link (say to `~/.ssh`), a FIFO (which would hang the scorer that
  opens it), a socket or a device. That, or either step failing, ends the run with exit 6, no `done` and the error in meta.json, so the
  unconfined scorers and judge never open it. The environment is cleared to a few variables, and the session gets new user, PID, IPC and
  UTS namespaces with no capabilities. Without a working bubblewrap (macOS, or Linux without `bwrap`) a Haiku run is refused with exit 5,
  never run unconfined. Codex runs Luna in its own `workspace-write` sandbox.

  What the box does not stop:
  - **The network.** The session shares the host's network, since the model needs it. Services on `127.0.0.1` and abstract Unix sockets
    (an X server's `@/tmp/.X11-unix/X0`, for one) stay reachable, so a local service that trusts any local process trusts this one too.
  - **DNS other than systemd-resolved.** Only `/run/systemd/resolve` is bound back under `/run`. Where `/etc/resolv.conf` points elsewhere
    in `/run` (NetworkManager's or resolvconf's file), names do not resolve in the box and every Haiku run fails without a `done`.
  - **Tools installed under the home folder.** PATH is the binary's folder, `/usr/local/bin`, `/usr/bin` and `/bin`, and the home is
    hidden, so pip `--user` packages, virtual environments and mise's python, node or ffmpeg are gone. The model has only what the system
    has installed.
- **Reuse**: a verdict is reused only while both runs it judged are unchanged (it records each run's skills hash and a hash of the deliverable and its score); a run made again is judged again.
  `--judge-only` refuses when a run's `skills.sha` differs from the arm's skills now or is missing (`--allow-stale` judges them anyway and warns). The committed blind results (`results-cand4-blind.json`,
  `results-heldout2-blind.json`) were made before that check and say `unrecorded`: they are not tied to a skills version.
  A response is reused only while the skills it was made with are unchanged. `skills.sha` in each run folder (and `skills_hash` in meta.json) is a SHA-256 over
  the arm's skills folder; `main` is archived from `origin/main` into `skills-main-<tree>` so a moved `main` is never mixed with an old one; the report prints the hashes
  each arm used. A run from before this check has no hash, and `run.sh` makes it again. A Haiku run is also reused only when its meta.json says `confined: true`, so a
  run made before the box is made again and an arm never mixes confined and unconfined responses.

## Run it

```sh
evals/creative/run.sh <label>                       # tuned set, none vs main, haiku and luna; resumable
evals/creative/run.sh <label> --set heldout         # the held-out set (--set heldout2: a second one, design and video)
evals/creative/run.sh <label> --cand new --base main --judge-only   # judge and report the responses already on disk; no responder runs
evals/creative/run.sh <label> --cand new --base main   # this checkout's skills/ (or $NEW_SKILLS) against main
evals/creative/run.sh <label> --only a1-podcast-clean,d1-fall-festival --models haiku
evals/creative/run.sh brand-ship --set brand-both --base none --cand nocouncil   # logos, guides, app screens (arms.py makes the arms)
```

State lives in `~/.cache/hildegard-creative-eval/` (`runs/<arm>/<model>/<task>/`, `judge/<label>/`); delete a run folder to redo it.
A quota or billing message stops the whole run: the response exits 99, `dispatch.sh` makes xargs stop starting jobs, and a `STOP` file under `runs/` keeps later
responses from calling a model until you delete it. A responder that dies before a finished transcript leaves a `meta.json` with the error and no `done`, so it is made again.
It writes `evals/creative/results-<label>.json` and prints the summary and a design contact sheet path. Needs `claude` and `codex` signed in
with a subscription, bubblewrap (`bwrap`, for Haiku), `ffmpeg`, `numpy`, `Pillow` and Playwright's Chromium. One response per task, arm and model is about 52 responses
and 52 Opus verdicts for the tuned set.

## Reading results

Verdicts are tasks times two orders. The rate counts a tie as half. A task counts as won only when both orders agree; when they split, that is
the judge's position bias, so read it as a tie. Win rates on 3 tasks per domain are coarse: treat a domain as won when it wins outright on most of its
tasks and loses none, and use the objective metrics to see why.

## Results


### Baseline, 2026-11-07: `main` skills against no skills, tuned set (`results-baseline.json`)

One response per task, arm and model; each task judged in both orders (52 responses, 52 verdicts). Skills loaded: the `main` arm loaded a
Hildegard skill in 13 of 13 runs for both models (they were told to; the `none` arm in 0 of 13). Claude Code's own built-in skills (`artifact-design`,
`design`) are visible to every Haiku run, including `none`, and Haiku loaded `artifact-design` on the design briefs without the plugin, so for Haiku design
the baseline is not skill-free.

| Domain | Haiku 5.5: main wins of verdicts (tasks won/lost outright) | GPT-6 Luna (low): main wins of verdicts (tasks won/lost outright) |
| --- | --- | --- |
| design (3 tasks) | 3 of 6 (1/1) | 1 of 6 (0/2) |
| video plans (3) | 4 of 6 (1/0) | 4 of 6 (2/1) |
| audio (3) | 2 of 6 (1/2) | 2 of 6 (1/2) |
| writing (3) | 6 of 6 (3/0) | 2 of 6 (1/2) |
| video edit (1) | 0 of 2 (0/1) | 2 of 2 (1/0) |
| all | 15 of 26 (0.58) | 11 of 26 (0.42) |

**Read it plainly: the skills do not yet make a weak model's work reliably better.** They clearly help in two places: Haiku's writing (3 tasks
won, none lost, 2.5 invented facts per draft against 4.0, 0 prose-lint hits on both sides) and video plans (both models win 4 of 6 verdicts;
Luna's plans carry 0.5 invented facts per plan against 1.5). In design, audio and the edit script they win about as often as they lose, and
Luna's design and writing get worse with the skills (design 1 of 6, writing 2 of 6). With 1 to 3 tasks per cell, one split task moves a cell a lot; the
split tasks are position bias in the judge, so the tuned set shows direction, not size. Do not tune against this table; confirm with `--set heldout`.

Audio, measured (checks passed of 10 to 13; each script re-run with no network):

| Task | Model | none | main | What decided it |
| --- | --- | --- | --- | --- |
| a1 podcast clean | Haiku | 7/10, hum 13.1 dB, pauses 9.1 dB | 9/10, hum 0.7 dB, pauses 20.2 dB | main notched the hum and kept speech (fidelity 0.87 against 0.71) |
| a1 podcast clean | Luna | 8/10, -15.7 LUFS | 7/10, -18.8 LUFS | main used one-pass `loudnorm`; hum still 38.5 dB, no notch |
| a2 church duck | Haiku | 12/12, ducks 19.7 dB | 12/12, ducks 9.4 dB | main's ducking was gentle: bed stays under the voice but audible |
| a2 church duck | Luna | 7/12, no ducking, voice lost | 12/12, ducks 10.3 dB | main won |
| a3 radio spot | Haiku | 12/13, ducks 10.4 dB | 10/13, ducks 5.5 dB | main ducked less and ended on a 0.1 s fade |
| a3 radio spot | Luna | 10/13 | 9/13 | main's voice track was damaged (fidelity 0.29) |

Video edit: Haiku none 9/9 (eight source switches, crossfades); Haiku main 8/9 (four switches, no scene changes, fewer than five cuts); Luna none 8/9;
Luna main 9/9. No black stretches in any of the four.

Five most common failures in the `main` arm's outputs:

1. **The cleaning script misses its delivery target and the hum.** Luna's `a1` ran `loudnorm` once and shipped -18.8 LUFS against a -16 target
   (every other main script, five of six, used a measured two-pass), and it never notched the 60 Hz hum (prominence 38.5 dB, with a comment that mentions
   notch filters it does not apply). Only Haiku's `a1` notched; it reached 0.7 dB.
2. **Ducking is timid or absent.** Haiku's spot script used `sidechaincompress=threshold=0.03:ratio=4` and ducked 5.5 dB (the `ducks` check wants 6 or more);
   its church announcement ducked 9.4 dB with a ratio-6 compressor where the no-skill script used a ratio-20 compressor and ducked 19.7 dB. Luna's `a3` main
   script fed one `[voice]` label into both the sidechain and the final mix without `asplit`, which wrecked the voice track (lines found at 0.0, 0.1 and 0.97 s).
3. **Design craft slips the skills don't catch.** Luna's hardware-store square has a ruler illustration over the offer, so the main line reads
   "ANY SINGLE REGULAR-PR"; Haiku's festival flyer headline reads "Fall & Festival" through a stray gold ampersand; Luna's bluegrass title runs into the hill shape.
   Haiku rendered `check.png` in all three main design runs and still shipped the ampersand; Luna rendered none (no `check.png` in any of its design folders, in either arm).
4. **Invented copy on designs.** Luna's main flyers add "A day of good food and fall fun", "A festival favorite for all ages", "3 DAYS ONLY" and
   "Thank you for 70 years · 1955-2025" (the brief's prohibition on inventions was explicit). 1.5 invented facts per design against 1.3 with no skill.
5. **Video plans break their own rules.** Luna's Christmas Eve plan says every clip is at most 5 seconds, then makes its last shot a single 10-second
   generation ("Shot 6, full 10 s"); Haiku's plan adds "falling snow" and "one lamp post glowing in a snowy back lot", and a communion cup and plate in silver,
   none in the brief. Haiku's detailing reel changes "about three cars a day" into the voice-over line "We take three cars a day". Plans also hold shots on a model that cannot do text.

What I would try first: put the two-pass `loudnorm` recipe, a hum notch recipe and a `sidechaincompress` template with `asplit` in
`skills/hildegard/references/sound-design.md`/`hildegard-sound` as copy-paste blocks; tell the design skills to render and read the PNG once and fix collisions before finishing
and to add no copy that is not in the brief; add a 5-second-per-shot rule and "no facts beyond the brief" to the video-plan references. Those are
changes for the session that owns `skills/`; this PR changes none.

### Logos, brand guides and app screens, 2026-11-07 (`results-brand-*.json`, in PR #158)

Fifteen tasks in `tasks-brand.json` (3 each of logo, brand guide, app screen) and `heldout-brand.json` (2 each), run with
`--set brand-both`. Deliverables: `mark.svg`, `logo.svg` and a logo sheet; `brand.json` and a one-page `guide.html`
(the client's logo given); each state the brief names as `<state>.html` at the device size. Three arms, one response
each per task and model: `none`; `nocouncil`, the skills as they ship; `council`, the same skills with a required
six-critic council (the text at commit 02d52da; `arms.py` builds both arms from one checkout by cutting the
`<!-- council:start -->` blocks and the council's files, and fails if any council text is left). Responders run in their
own process namespace with an empty HOME, no new privileges and only the CLIs they need on PATH, so they see neither
the owner's `hildegard` CLI nor the running service. Scored by the skills' own checkers from this checkout (the same for
every arm: `logo_check.py --plain`, the guide rendered at US letter and audited, `screen_check.py`), then judged blind by
Opus on the logo sheet, the guide PNG or the states side by side, in both orders. The results files are in their own
PR, #158, so this one stays small enough for one reviewer.

**The first brand-guide verdicts were not blind.** `brand_guide.py` printed "Made with Hildegard" in every guide's
footer: words no brief gave, on skill-arm guides only, so the judge could tell those guides from the rest, and 13 of
the 60 brand-guide verdicts cited the credit (as an off-brief fault). The credit is gone. The seven saved guides that
carried it were re-rendered from their own saved `brand.json` with the fixed script, keeping the responder's own edits
(a three-way merge of the saved page with the old and fixed script output; each result is the saved page with only the
credit removed), and every brand-guide verdict was judged again, judge only, with no new responses. No guide had to be
left out. Logo and app verdicts were not judged again: the credit was only on guides. Five of the 60 brand-guide
verdicts changed winner, about the judge's own noise (council against none, whose guides had almost no credit, changed
one of 20).

Blind verdicts won by the first arm, all three domains (rate counts a tie as half). First run, then after the fix; the
brand-guide verdicts within them in brackets:

| Comparison | Set | Haiku 5.5, first | Haiku 5.5, blind | GPT-6 Luna (low), first | GPT-6 Luna (low), blind |
| --- | --- | --- | --- | --- | --- |
| skills as shipped against none | tuned | 11 of 18 [2 of 6] | 11 of 18 [2 of 6] | 13 of 18 [4 of 6] | 13 of 18 [4 of 6] |
| skills as shipped against none | held-out | 8 of 12 [2 of 4] | 8 of 12 [2 of 4] | 6 of 12 [2 of 4] | 6 of 12 [2 of 4] |
| council against none | held-out | 7 of 12 [1 of 4] | 7 of 12 [1 of 4] | 8 of 12 [3 of 4] | 8 of 12 [3 of 4] |
| council against no council | tuned | 13 of 18 [6 of 6] | 12 of 18 [5 of 6] | 8 of 18 [5 of 6] | 7 of 18 [4 of 6] |
| council against no council | held-out | 7 of 12 [0 of 4] | 7 of 12 [0 of 4] | 5 of 12 [2 of 4] | 5 of 12 [2 of 4] |

Brand guides are where the skills help least: skills against none wins 10 of 20 guide verdicts across both sets and
models, the same as before.

Measured over all 15 tasks (checker fails; text under WCAG AA in guides and screens; tap targets under the platform's
size), rescored after review round 1 found that `screen_check.py` missed text pushed past the top or bottom of the
screen or cut off by a box around it, and that the brand scorer decided "one page" from `scrollHeight`, which reads
1056 on a page fixed at letter height while its last section is cut off. Both are fixed; app check fails and the new
clipped columns are before and after, the rest did not change:

| Arm | Model | logo check fails | live text in logos | app check fails | app texts clipped | text under AA | small targets | guides cut off |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | Haiku | 14 | 0 of 5 | 8, now 9 | 0, now 3 | 21 | 44 | 0 of 5 |
| shipped | Haiku | 0 | 0 of 5 | 0 | 0 | 0 | 0 | 0 of 5 |
| none | Luna | 22 | 5 of 5 | 20, now 21 | 0, now 4 | 184 | 6 | 0 of 5 |
| shipped | Luna | 2 | 0 of 5 | 13, now 16 | 0, now 23 | 32 | 4 | 0, now 1 of 5 |

The skills take Haiku's screens to no failures, and still do. They do not do that for Luna: its shipped-arm screens
now fail more than before (16), with 23 texts cut off, 14 of them on the bus tracker whose offline banner pushes the
next bus off the bottom; its Kettle River guide runs off the page mid-section. The checker now catches both, which it
did not when those screens were made.

Invented facts per judgment (the judge's count), skills as shipped against none: brand guides Haiku 0.2 against 1.7
(first run 0.4 against 1.6), Luna 0.1 against 0.8 (first run 0 against 0.8); app screens Haiku 0.2 against 2.3, Luna 2.2
against 5.6; logos 0 everywhere.

**The council stays out of the default steps, and the blind rejudge does not change that.** On the held-out set the
required council won 12 of 24 verdicts against the same skills without it, before and after: no better, so by the rule
set for this work it is not a default. On the tuned set it now wins 19 of 36 (21 of 36 before). It is kept as
`hildegard-council`, used when someone asks for a review or a choice between variants. Compliance was part of the
result: with the council written as a pointer to another skill, Haiku skipped it on 3 of 3 logos; written as required
commands with a tally in the delivery, Haiku ran it in 10 of 15 runs (67 critic subagents) and Luna in 3 of 15
(`report.py` prints this from `runmeta.py`'s `council_ran`). Where Haiku ran it, it helped logos (held-out 4 of 4) and
hurt brand guides (0 of 4). One critic called a fact the brief gives invented, so the council now checks every hard fail
against the brief before acting on it.

Bugs the run found, fixed before these numbers: a lockup's stroke widths were judged at 32 px wide instead of 40 px
tall; `wordmark.py` could not keep its font cache under Codex's workspace sandbox (it now uses `./.fonts`, and offline
lists installed fonts with a license warning; Luna's ten skill-arm logo runs were redone with the fix); the placeholder
check matched a type-scale step named "Title".

### Limits

- Three tasks per domain and one response each; the judge's position bias splits some tasks. Use the held-out set and repeat runs before believing a small gap.
- `~/.codex/AGENTS.md` loads for Luna in every arm (no switch for it). The skill arms' extra sentence is a treatment, and the none arm's Haiku sees Claude Code's built-in design skills.
- The audio decomposition assumes each source is placed once; a looped bed is scored on its first pass. `stoi_like` ranks and is not standardized STOI.
- Video-edit cut counting started as ffmpeg scene changes only, which missed crossfades; it now also counts source-clip switches. That edit to `score.py`
  came after the first scoring pass, so `e1-canoe-cut` was re-scored and re-judged and the rest were not affected.
- Plan judging cannot test whether a prompt renders well in LTX or Wan. It tests whether the plan is complete, consistent and feasible on paper.
