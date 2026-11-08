# Video editing

An agent (or a person with a text editor) edits footage by writing an **edit list**, `edl.json`. One script renders it and a
gate reads the **finished file** and fails unless it proves the list. The skill that teaches this is
[`skills/hildegard-video-edit`](../skills/hildegard-video-edit/SKILL.md); this page is for people changing the code.

```
transcribe ──▶ plan ──▶ (edit_write) ──▶ check ──▶ render ──▶ contact sheet ──▶ verify
 word times     cuts       any model       the        groups,     look at it     exit non-zero
                           writes the      schema     audio,                     unless the output
                           list                       mux                        proves the list
```

## Where things are

| Path | What it is |
| --- | --- |
| `tools/edit_video.py` | The command: `check`, `schema`, `transcript-text`, `plan`, `bake`, `render`, `verify`, `sheet`, `extract-audio`, `probe`, `selftest`. `--json` prints JSON lines for the server |
| `tools/hgedit/edl.schema.json` | The contract. `additionalProperties: false` everywhere: an unknown field is an error with the nearest allowed name |
| `tools/hgedit/plan.py` | Resolves a list to frames: keep minus cuts, pauses, frame-grid snapping, geometry, reframe track, blur and caption times on the output clock. The renderer and the gate both call it, so they can't disagree about the list |
| `tools/hgedit/signals.py` | Speech energy, keystrokes, pauses, motion, the subject's place |
| `tools/hgedit/transcript.py`, `planner.py` | Words in a text file, fillers, false starts, captions, trimming to a length |
| `tools/hgedit/render.py`, `encoders.py` | Grouped parallel encode, hardware encoder probing, audio, dts-interleaved mux |
| `tools/hgedit/verify.py`, `selftest.py` | The gate, and the planted-key proof that it works |
| `apps/server/src/edit.ts`, `edit-routes.ts` | `/api/edits`: per-person edits, jobs, references instead of paths |
| `mcp/src/edit-tools.ts` | `edit_plan`, `edit_write`, `edit_status`, `edit_render`, `edit_verify` |
| `skills/hildegard-video-edit/scripts/` | A byte-for-byte copy of the tools, so the skill works alone: `node scripts/sync-skill-shared.mjs` (listed in `skills/SHARED.json`) |

Python needs PyAV, numpy and Pillow (what `hildegard install` already sets up). Nothing needs an `ffmpeg` on PATH, except
writing chapter marks into the MP4 (chapters.txt is always written). `tesseract` is optional and lets the gate read the output.

## Decisions worth knowing

- **Pauses are found from speech energy, not a silence level.** Speech is energy in 150 to 3500 Hz well above the recording's own
  noise floor (10th percentile per 20 s) that lasts 120 ms or more. A keystroke is loud and short, a fan is steady and low, so
  neither is speech and a fan can't hide a pause (a fixed silence level fails both ways). A pause is *dead air* only when it has
  no typing or clicking in it; a pause with two or more clicks is kept, since something is happening on screen
  (`pauses.activity: "cut"` turns that off).
- **Every group is encoded on its own with no B-frames**, so its packets can be joined by time stamp alone and each file is
  reusable on a restart (its name holds a hash of everything that went into it).
- **Redaction happens on the source pixels, before the crop,** so a reframe or scale can't undo it. Blur averages the region down
  to cells before blurring; `solid` is the one to use for a secret.
- **The gate re-resolves the list** instead of trusting what the renderer wrote, and measures the file: that it is the render
  of this very list (the renderer leaves the list's hash and the file's beside it, so a video from an older list fails),
  frames, durations of every audio track, loudness and true peak through ebur128 (streamed; silence or a meter that can't run
  fails when the list masters the sound), black and frozen runs, overlay boxes, and (with tesseract) OCR: declared secrets
  through the whole video, and API keys, e-mail addresses, IPs and host names at 4 fps in and around every hidden stretch. OCR
  reads at most 900 frames, one at a time, no wider than 1920 pixels. Without tesseract that check is **skipped and reported
  as unproven**, or fails with `verify.require_ocr`; a tesseract that fails is unproven too, never an empty read.
- **The server takes turns at the script**: one run per person and two at once overall, a short line of waiting requests
  per person (past it, a 429 with `code: "queue"`), and at most 4 render processes, whatever a request asks.
- **Music ducking is the sound skill's recipe** (`hildegard-sound/scripts/duck_mix.py`): 16 dB down, starting 0.3 s before speech
  and returning over 0.5 s after it, gaps under 0.6 s held down, the bed 8 dB under the voice. The speech stretches come from the
  energy gate above.
- **Reframe** uses a face when OpenCV 4 is installed (`pip install "opencv-python-headless<5"`; 5.0 dropped the Haar cascade it uses, and the code then falls back to motion), else the centre of what moves, else
  the middle; the path is median-filtered and moves at most a third of the frame a second.

## The API

`/api/edits` is owned per person like films and recordings: a director sees only their own, the owner and this computer see all,
and an edit that isn't yours is a 404. Footage is named `recording:<id>`, `export:<id>` or `edit:<id>`; a path is accepted only
from this computer. Rendering and the gate are jobs on the edit (`job.status`, `job.stage`, `job.done` of `job.total`); poll
`GET /api/edits/:id`. The shapes are in `packages/presets/src/edit.ts`.

## Not done yet (and honest limits)

- Hardware encoders are probed on real frames and fall back to libx264, but only libx264 is run in CI. `h264_vaapi` is tried
  like the others; PyAV needs hardware frames for it, so expect the probe to fall back on most Linux builds.
- Planning drops sentences by "least said per second", a heuristic; it says so, and lists every cut.
- Platform length limits (Shorts, Reels, TikTok, X) are warnings from defaults, not a promise.
- The Studio has no editor yet. The API above is what it should be built on.
