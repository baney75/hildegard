# Templates

Six finished specs. Each renders to a good result with no edits (`python3 scripts/motion.py templates/title-card.json out.mp4` from the skill's folder)
and passes `--check`. Copy one, change the words, colors and timings, and check again. They are 1920x1080 at 30 fps; add
`--scale 0.5` to draft quickly.

The photos are `sample:` placeholders drawn in code. Replace each `"file": "sample:..."` with the user's photo, for example
`"file": "photos/one.jpg"`, before you deliver.

| File | For | Scenes | Length |
|---|---|---|---|
| `title-card.json` | an opener, then a name and role over a photo | title, lower third | 9.4 s |
| `promo.json` | an event or product ad | hook, place, three reasons, call to action | 15 s |
| `quote-card.json` | a verse, a quote, a line of a poem | one card | 10 s |
| `data-reveal.json` | numbers made visible, with one takeaway | one chart | 10 s |
| `slideshow.json` | photos with slow camera moves and captions | title photo and three more | 16 s |
| `kinetic.json` | an announcement, a lyric, one phrase per beat | five phrases | 13.4 s |

## What you change in each

Change the `text` values, the colors (`color`, `fill`, `background`), and scene `duration` values. Then set the top-level
`duration` to what `--check` says the scenes add up to.

**title-card.** Scene 1: `text` of the title (keep it to about 4 words or 20 letters at size 13; if it is longer, lower
`size` to 10 and set `"box": 0.8`) and the line under it. Scene 2: the person's name and role, and the photo. The amber
`#f2b84b` is the accent; the navy `#0b1020` to `#231a4f` is the background.

**promo.json.** Scene 1 is the hook: one sentence, up to 8 words. Scene 2: the event or product name, one line under it, a
photo. Scene 3: exactly three short reasons (2 or 3 words each); to use two, delete one card and its text, and set the
others to `x` 0.33 and 0.67. Scene 4: the date, the place and the call to action. Never invent the date, place or web
address: use the brief's, or ask. Palette: deep green `#10231c`, cream `#f6efe0`, accent amber `#f2b84b`.

**quote-card.json.** Put the quote in the big `text`, with `\n` where the line should break (aim for two or three lines, 28
characters or fewer each), and the source in the small caps line. Keep the quote word for word and name its source. Past
three lines, lower `size` to 6.5 and lengthen the scene (about 0.4 s per word of reading plus 4 s).

**data-reveal.json.** Replace `data` with the user's labels and numbers: 3 to 7 bars. Do not round them. The tallest bar is
full height; mark the one that matters with its own `"color"`. The big counting number must come from the data (the
template's 81 is (203 - 112) / 112, rounded); recompute it, or delete the big number and its caption. Set the title to what
the numbers measure and the period.

**slideshow.json.** Replace each photo's `file`. Add or remove a scene to change the number of photos (each is 4.6 s; the
transition overlaps 0.8 s). Rewrite the caption `cues` and move their `start` and `end` so each sits inside its scene
(a scene starts at the sum of the earlier scenes' lengths minus 0.8 s for each transition). Keep captions under 8 words.
Vary the camera presets so two photos in a row do not move the same way. Delete the title layer if the reel needs none.

**kinetic.json.** One short phrase per scene, 1 to 3 words, in capitals. Use big sizes (16 to 34); the longer the phrase,
the smaller the `size`: 3 words at 22, 2 words at 26, 1 word at 34. Each scene is 3 s; keep them at 2.6 s or more. Vary
the background colors, and keep one entrance style across the scenes if the brief wants calm.

## Do not change

The layer order (the last layer is on top), the `fonts` block (every font here is pinned and checked), the entrance and
transition names unless a rule in SKILL.md says so, and the `x`, `y`, `anchor` and `box` values unless `--check` tells you to.
