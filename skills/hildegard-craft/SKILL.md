---
name: hildegard-craft
description: Quality gates against slop for anything made with Hildegard (video, film, photos, art, music, voice, captions). Use before and after every generation or edit to brief, lint the prompt, review the result against the rubric, and decide whether to deliver. Other hildegard-* skills build on it.
---

# Craft, not slop

Hildegard exists to make work its owner is proud of, on their own machines. This skill is the bar every
`hildegard-*` skill holds itself to. Read it once per session before you generate or edit anything.

## What slop is

Slop is generated work whose choices were left to the model's defaults: nobody decided what it is for, what is in
the frame, or what to cut, and nobody looked hard at it before it shipped. You can see it in three ways:

1. **The average look.** Glossy, oversaturated, teal-and-orange, glowing rim light, everything centred, waxy skin,
   "epic" for no reason. It comes from prompts full of quality words ("8k", "masterpiece", "cinematic",
   "hyperrealistic"), which pull every result toward the same average image.
2. **Mistakes nobody fixed.** Melting hands, extra fingers, garbled lettering, faces that change between shots,
   flicker, frozen frames, blown highlights, sound that clips or jumps in level.
3. **Filler.** More takes, more shots, more words and more music than the idea needs; transitions and effects that
   hide the lack of an idea.

The full catalogue, with what to do about each, is in [references/slop.md](references/slop.md).

## The four gates

Every piece of work goes through these, in order. Never skip one to save time; skip the work instead.

### Gate 1: the brief (before anything renders)

Write three to six lines and show them to your user when the ask is bigger than one shot:

- **For:** who sees it, where (phone, cinema, print), and what it should make them feel or do.
- **Is:** one sentence of what it is. If you can't write it, ask your user one question.
- **Specifics:** at least three concrete details nobody would guess (a chipped blue mug, sodium street light, a
  tailor's chalk mark). Specifics are the opposite of slop.
- **Constraints:** length, aspect, sound or not, deadline, what must not appear.
- **References:** qualities, not names. "Low, hard winter sun; muted greens; locked camera" rather than "like
  <famous director>".

### Gate 2: the prompt (before anything renders)

Write prompts as plain sentences in the order things happen: who, doing what, where, in what light, with one specific
detail. Then call `review_prompt` (or `hildegard review`-style lint if your agent has no MCP). Fix every `FIX`.
Treat every `consider` as a choice you make on purpose. See [references/prompting.md](references/prompting.md).

### Gate 3: the review (after every render)

1. Call `review_take` on every finished take. It runs the technical checks and returns a contact sheet of nine frames.
2. **Look at the contact sheet.** If your model can't see images, say so to your user and ask them to look; never
   describe a picture you haven't seen.
3. Answer every rubric question it gives you, one line each, as `id: yes|no, the frame or time that shows it`.
4. Any technical `FAIL` or rubric `no` means change one thing (the prompt, a preset, the seed, the length) and render
   again. Change one thing per round so you learn what helped.
5. At most **three rounds** per shot. After that, stop and tell your user plainly what still fails and what you would
   try next. A good shot with a known flaw, honestly reported, beats a fourth blind retry.

Media from outside Hildegard (your user's own footage or photos, an exported film): `hildegard review <file>` gives the
same checks, with `--sheet sheet.jpg` for a contact sheet, `--final` for the delivery bar and `--film` for cuts.

### Gate 4: delivery

- Re-render the chosen take at `quality: "final"` with the same seed, review it again, then deliver.
- Say what you made, which take and why, and anything still imperfect. Plain words: no "stunning", no
  "breathtaking", no "I hope you love it". Let the work speak.
- Never call a draft final. Never claim a check passed that you didn't run.

## Rules that are never bent

- **No deepfakes.** Never put a real, identifiable person into a scene they didn't agree to, and never imitate a real
  person's voice without their consent. Refuse, and say why in one line.
- **No imitation of a working artist by name.** Describe qualities instead.
- **Label it.** Hildegard marks its exports as AI-generated. Don't strip that, and say so when your user publishes.
- **The owner's machines, the owner's licenses.** Never accept a model license for your user; show it and ask.

## Budget

Rendering is free on the owner's GPU but not instant. Default plan for one shot: one prompt lint, two draft takes,
review both, at most two more rounds, one final. For a sequence of N shots: a brief, a shot list, drafts of all
shots, review, then finals only of the chosen takes, then `export_film` and one review of the whole film with `--film`.
