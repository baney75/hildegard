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

- **Human** (`corpus/human`, 220 pieces, `manifest.json`). Everyday writing by real people, all published before 2021:
  18F and Digital.gov blog posts, announcements, guides and site pages (CC0, US public domain), NASA posts (US government
  work), Creative Commons staff posts (CC BY 4.0), Global Voices articles (CC BY 3.0), Stack Exchange answers on
  gardening, cooking, repairs, music, pets, parenting and money (CC BY-SA 3.0 and 4.0), and Project Gutenberg (public
  domain): D. L. Moody and C. H. Spurgeon sermons, and the letters of a woman homesteader and of a Chicago packer to his
  son. Each piece records its source URL, author, license and the SHA-256 of the text as saved. Every license allows
  copies, so the pieces are committed; `fetch-human.mjs` rebuilds them from the sources and `--check` fails if one has
  changed. **What it does not cover:** small-business pages. No site of that kind carries a license that allows copies,
  so the 18F and Digital.gov pages (a team describing itself and its services) stand in for them.
- **AI** (`corpus/ai`, 176 pieces). Twenty-two briefs (a bakery post, a parish newsletter item, a congregation email, a
  plumber's About page, a sermon, a 4-H newsletter and so on) drafted by Claude Haiku, Sonnet and Opus (`claude -p`) and
  GPT-6 Luna (`codex exec`), with no skill, no settings and no instructions file. Each brief is drafted twice: with the
  writer's facts (`<id>.md`) and with the topic alone (`<id>-generic.md`), the way most people prompt.
- **Cached** (`--cached`, not in git): the no-skill writing drafts in `~/.cache/hildegard-creative-eval/runs`, reported
  with the AI drafts, and the drafts made with the skill there and in `~/.cache/hildegard-writing-eval`, reported
  apart (they are tuned against the lint, so they say nothing about recall).

Every piece has a `split`:

- `dev` pieces are read one at a time to design rules (`quality.ts --show <rule>` prints only those).
- `test` pieces, about a third, are read only as totals, so they say whether a change generalizes. Four were looked at:
  `stackexchange-30` when the first test run showed a false fail, and `18f-pages-08`, `18f-pages-15` and
  `digitalgov-guides-01` when web pages were added late and failed.
- `holdout` pieces (73 human, 48 AI, drafted from six briefs no rule was built on) were set aside for that reason and
  not measured until the rules were final. It then showed 3 human pieces failing (4.1 percent) and 33.3 percent recall,
  so two things were changed (bold in different forms counts as one kind of tell, and "Ultimately" opening a last
  paragraph only warns), after which the holdout is no longer untouched: 0.0 percent and 31.3 percent.

## What it reports

- **Recall**: AI drafts that fail the lint. **False fail**: human pieces that fail it. A text fails when any finding
  has severity `fail`. Both are also given for each split, and recall for each model.
- **Per rule**: the share of human pieces and of AI drafts the rule fires on, and how often it fires as a fail. A rule
  that fires on people as often as on machines is noise.
- **Speed**: median milliseconds for realistic prose at 1k, 10k, 100k and 1M characters and for the adversarial
  inputs in `test/prose-fixtures.json`, both engines. The Python script runs in one process. `--profile` shows where
  the time goes, `--before <ref>` times the engines at a git ref beside this tree's.

`baseline.json` holds the counts the tests compare against; `quality.ts --ratchet` raises them. `results/before-quality.txt`
is the lint as it stood before the changes in the pull request that added this bench (`quality.ts --ref origin/main`),
`results/after-quality.txt` is the lint after, and `results/speed.txt` is `speed.ts --before origin/main --profile`.
The machine was busy while the speed numbers were taken (load average about 30), so read them as ratios.
