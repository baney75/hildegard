---
name: hildegard-council
description: Use to review a logo, brand, app screen, page, poster, image or film before revising it, or to pick between variants - six critics judge it blind, each with a rubric.
---

# The design council

A designer can't see their own work fresh. The council is six critics who each see only the brief and the render,
score it against their own rubric, and never read each other's notes. The designer then fixes what the council agrees
on. Use it when your user asks for a review, a critique or a choice between directions, for work from any skill
(**hildegard-brand**, **hildegard-app**, **hildegard-web**, **hildegard-art**, the film and video skills).

It is not a default step in those skills. In a blind test on 2026-11-07 (Claude Haiku and GPT-6 Luna, logos, brand
guides and app screens), the same skills with a required council won 12 of 24 held-out verdicts against the skills
without it: no better. Haiku gained on logos (4 of 4) and lost on brand guides (0 of 4); Luna rarely ran it.

`scripts/council.py` does the paperwork (the prompts, the shuffle, the tally) with the standard library only.
`references/rubrics.md` holds the six rubrics. Without the script, follow the same steps by hand: copy the role's
section of `rubrics.md` into each critic's prompt and add up the reviews as step 5 says.

| Role | Asks |
| --- | --- |
| `art-director` | Is there one idea, from the subject, with a clear first, second, third? |
| `typographer` | Are the letters right: face, spacing, scale, weight at size, spelling? |
| `brand-strategist` | Does it fit the audience, stand apart from competitors, and claim only what the brief says? |
| `legibility` | Does it read at a thumbnail, at 16 px, in low vision and color blindness? |
| `customer` | Would I stop, understand, act, and trust it? |
| `production` | Does it survive one color, reversed, small, embroidered, engraved, handed to a developer? |

## 1. Get the render ready

The critics judge a picture, not your description of it. Before the council:

1. Render the work and look at it yourself: the logo sheet (hildegard-brand's `logo_check.py`), the guide PNG
   (`brand_guide.py`), the screen and its states (hildegard-app `screen_check.py`), the page at its widths, the image,
   or a contact sheet of the film's frames.
2. Write `brief.md`: the client's brief word for word, then the copy deck (every word that should appear). Add
   nothing about your intentions; the critics judge what they see.

Done when every file a critic needs is a PNG or SVG on disk and `brief.md` exists.

## 2. Choose the medium

`logo`, `brand`, `screen`, `page`, `image` or `motion`. All six roles sit on every council; the medium picks the
lines of each rubric that apply.

## 3. Run the critics, each one fresh and blind

For each role, print its prompt:

```sh
python3 scripts/council.py brief --role art-director --medium logo --brief brief.md --render out/sheet.png
```

Then run that critic in the strongest isolation your host allows:

- **You can start subagents** (Claude Code's Agent tool, Codex subagents, or Hildegard's `agents run` within each
  provider's terms): start one fresh agent per role, in parallel, and give it exactly the printed prompt and nothing
  else: not your notes, not the other prompts, not your opinion of the work. Each writes `council/r1/<role>.json`.
- **You can't**: play the roles one at a time. Read only that role's prompt, look at the render again, write the
  review to its file in full, and only then print the next role's prompt. Never reread an earlier review before the
  tally, and never revise a review after writing the next one. Commit to each role's point of view, the customer's
  above all: write as that person.

Done when `council/r1/` holds one JSON file per role.

## 4. Compare variants blind

To choose between two directions, shuffle them first, so no critic knows which is newer or which you prefer:

```sh
python3 scripts/council.py shuffle direction-1.png direction-2.png --dir council/variants
```

Give critics `council/variants/A.png` and `B.png` with `--render` twice, and add to the brief: "Score A and B
separately, then say which you would ship." Unblind only after the tally: `council.py unblind --dir council/variants`.

## 5. Tally and fix

```sh
python3 scripts/council.py tally --round 1
```

It checks each review's shape and writes `council/r1/tally.md`. The rule:

1. **Fix every hard fail.** Illegible text, invented copy, a mark broken at small size, a misspelling, hairlines, a
   cliche mark: whatever one critic calls with a reason. First check it against the brief and the render: critics
   misread too. A hard fail that quotes the brief wrongly (calls a fact invented when the brief gives it) is void;
   say so in the report and keep the fact.
2. **Fix every area two or more critics flagged.** Agreement between critics who never talked is the strongest signal
   a council gives.
3. **One critic alone is your call.** Take it when it is cheap and clearly right; otherwise leave it and say so.

Make the changes, render again, and run your own checks again (the checker scripts). A fix that breaks a check is not
a fix.

## 6. A second round, at most

`tally.md` says whether round 2 is due: a hard fail or any overall score of 2 or less in round 1. Round 2 is the same
protocol with fresh critics (`--round 2`), on the new render. There is no round 3: after round 2, fix what you can and
deliver.

## 7. Report the scores

In the delivery, give the council's overall scores per role for each round, the must-fix list and what you changed
for each item, and anything you chose not to change and why. Never report a council you didn't run, and never edit a
critic's scores.
