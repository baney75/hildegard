# Prose lint bench

Measures the prose lint (`packages/craft/src/prose.ts` and `skills/hildegard/scripts/prose_lint.py`) for speed and for
how well it tells machine writing from people's. Run these before and after any change to a rule.

```sh
node packages/craft/bench/quality.ts [--cached] [--py] [--json] [--show <rule>]
node packages/craft/bench/speed.ts [--profile] [--json]
node packages/craft/bench/fetch-human.mjs [--check]     # rebuild or verify the human corpus
node packages/craft/bench/gen-ai.mjs [--only haiku,sonnet,opus,luna]   # draft the AI corpus (subscriptions only)
```

## Corpora (`corpus/`)

- **Human** (`corpus/human`, 121 pieces, `manifest.json`). Everyday writing by real people, all published before 2021:
  18F and Digital.gov blog posts and announcements (CC0, US public domain), NASA posts (US government work), Creative
  Commons staff posts (CC BY 4.0), Global Voices articles (CC BY 3.0), Stack Exchange answers on gardening, cooking,
  repairs, music, pets, parenting and money (CC BY-SA 3.0 and 4.0), and Project Gutenberg (public domain): D. L. Moody
  and C. H. Spurgeon sermons, and the letters of a woman homesteader and of a Chicago packer to his son. Each
  piece records its source URL, author, license and the SHA-256 of the text as saved. Every license allows copies, so
  the pieces are committed; `fetch-human.mjs` rebuilds them from the sources and `--check` fails if one has changed.
  **What it does not cover:** small-business pages. No site of that kind carries a license that allows copies.
- **AI** (`corpus/ai`, 128 pieces). Sixteen briefs (a bakery post, a parish newsletter item, a congregation email, a
  plumber's About page, a sermon, a 4-H newsletter and so on) drafted by Claude Haiku, Sonnet and Opus (`claude -p`) and
  GPT-6 Luna (`codex exec`), with no skill, no settings and no instructions file. Each brief is drafted twice: with the
  writer's facts (`<id>.md`) and with the topic alone (`<id>-generic.md`), the way most people prompt.
- **Cached** (`--cached`, not in git): the no-skill writing drafts in `~/.cache/hildegard-creative-eval/runs`, reported
  with the AI drafts, and the drafts made with the skill there and in `~/.cache/hildegard-writing-eval`, reported
  apart (they are tuned against the lint, so they say nothing about recall).

Every piece has a `split`. `dev` pieces are read one at a time to design rules (`quality.ts --show <rule>` prints only
those). `test` pieces, about 40 percent, are read only as totals, so they say whether a change generalizes.

## What it reports

- **Recall**: AI drafts that fail the lint. **False fail**: human pieces that fail it. A text fails when any finding
  has severity `fail`. Both are also given for `test` alone, and for each model.
- **Per rule**: the share of human pieces and of AI drafts the rule fires on, and how often it fires as a fail. A rule
  that fires on people as often as on machines is noise.
- **Speed**: median milliseconds for realistic prose at 1k, 10k, 100k and 1M characters and for the adversarial
  inputs in `test/prose-fixtures.json`, both engines. The Python script runs in one process. `--profile` shows where
  the time goes.

`results/before-*` is the lint as it stood before the changes in the pull request that added this bench.
