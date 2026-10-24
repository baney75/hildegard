---
name: hildegard-loop
description: Iterate any piece with Hildegard's loop - generate, render, critique, refine - until it passes or the rounds run out, by hand in any AI app or as a coding-agent run (Codex, Claude Code, OMP) the owner starts. Use when a piece needs several rounds to get right, for a 3D model, an image, a video or a sound, or when asked to keep improving something on its own.
---

# The loop: generate, render, critique, refine

Most generated work fails because nobody looked at it before the next attempt. The loop makes looking the price of
the next attempt: Hildegard takes round two only after round one has been critiqued, and every answer must point at
the view, frame or check that shows it. Read **hildegard-craft** first; for 3D, **hildegard-3d**.

## The four tools

| Step | Tool | What happens |
| --- | --- | --- |
| Start | `loop_start` | The brief (for, what, specifics) and the targets: `kind` model, image, video or audio; for a model `print`, `size_mm`, `bed_mm`, `max_triangles`; for media `final`, `seconds`, `audio`. Returns the questions you'll answer each round |
| Render | `loop_submit` | Send a version: `file_path` (an agent on the same computer), `text` or `data` (any app), `take_id` (a take Hildegard rendered) or `still_id` (a still it drew). Hildegard measures it and draws it, and returns the checks and the sheet |
| Critique | `loop_critique` | Every question, `yes` or `no`, each with its evidence, and the one change for the next round. The answer is `ready`, `revise` (with the fixes) or `stop` (no rounds left) |
| Deliver | `loop_finish` | The round to deliver (the best, not always the last) and an honest note |

`loop_status` shows a loop's rounds, critiques and changes. Rounds: 6 for a model, 3 otherwise (`max_rounds` up to
12). Every round stays in Hildegard, so your user can go back to an earlier one.

## How to critique

- **Look first.** Open the sheet (it comes back as an image) and go view by view, frame by frame. Never answer about
  something you didn't see; a yes you can't point at is a no.
- **Be the harshest honest critic you can.** Name the view and the place: "back-left view: the neck merges into the
  body". Praise isn't evidence.
- **Fresh eyes when you can.** If your app can start a separate agent (a subagent, a second session), give it only
  the brief, the sheet and the questions, without your notes, and use its answers. It doesn't know what you meant,
  only what's there.
- **One change per round.** The one that fixes the worst "no". Several changes at once and you won't know which one
  worked, or which one broke something.
- **Failing checks come first.** A model that isn't watertight, a take with blown highlights, a sound that clips:
  fix the measured failure before the matters of taste.

## Iterating media Hildegard renders

For a shot or a still, the loop wraps the renders you already make:

1. `loop_start` with `kind` video (or image), and `final`, `seconds`, `audio` as the shot asks.
2. Render with `direct_shot` (or `make_character_stills`), wait for it, then `loop_submit` with its `take_id` (or
   `still_id`) and a note on the prompt and settings.
3. Critique; change one thing in the prompt or the settings; render again with the same seed unless the seed is the
   change.

## A coding agent that loops on its own

Your user can hand a whole loop to a coding agent on their computer. Hildegard starts it with its MCP tools and these
skills in a workspace of its own, within each provider's terms (`docs/agent-terms.md`):

```sh
hildegard loop run codex "a standing heron finial, 120 mm, for an FDM print" --kind model --print --size 40x40x120
hildegard loop run claude-code "a lithophane of the attached photo" --kind model --print --add-dir ~/Pictures/heron
hildegard loop run omp "a low-poly fox for a web game, under 3,000 triangles" --kind model --use local --model ollama/qwen3-coder
```

- With a Claude or ChatGPT plan, only your user starts a run, and it's paced like a person working; `--use key`
  (their API key, from the keychain) is the way to run on a schedule or for longer.
- The agent builds in its workspace (Blender, OpenSCAD, Python, whatever is installed), sends each round by path,
  critiques it, and finishes with the best round. `hildegard loop show <id>` shows where it got to; the result's
  `loop` field names it.
- Never start a run your user didn't ask for, and never put a key on a command line.

## Beyond 3D

The loop is a renderer and a rubric per kind, and each kind's checks are the measurable half of the quality bar:

| Kind | Hildegard measures | The sheet |
| --- | --- | --- |
| model | watertight, manifold, winding, volume, bodies, debris, size; for prints units, bed, base, overhang, balance | eight views, a top or bottom view, silhouettes |
| image | size, highlights, shadows, contrast, colour | the image |
| video | size, length, highlights, colour, black frames, frozen, flicker, sound clipping and loudness | nine frames, start to end |
| audio | clipping and loudness | none: you can't hear it, so say what was measured and ask your user to listen |

When a piece isn't one of these (a poster as SVG, a page, a song's lyrics), loop by hand the same way: render it
(a PNG of the SVG, a screenshot of the page), send the render as an image round, and critique that.
