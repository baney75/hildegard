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

- **Human** (`corpus/human`, 220 pieces, `manifest.json`). Everyday writing by real people, 190 pieces dated 2020 or
  earlier in their sources and 30 18F site pages that carry no date (`undated` in the manifest; their repository first
  holds them in June 2024 and changes them through January 2025, so they are not claimed to predate language models):
  18F and Digital.gov blog posts, announcements, guides and site pages (CC0, US public domain), NASA posts (US government
  work), Creative Commons staff posts (CC BY 4.0), Global Voices articles (CC BY 3.0), Stack Exchange answers on
  gardening, cooking, repairs, music, pets, parenting and money (CC BY-SA 3.0 and 4.0), and Project Gutenberg (public
  domain): D. L. Moody and C. H. Spurgeon sermons, and the letters of a woman homesteader and of a Chicago packer to his
  son. Each piece records its source URL, author, license and the SHA-256 of the text as saved. Every license allows
  copies, so the pieces are committed; `fetch-human.mjs` rebuilds them from the sources and `--check` fails if one has
  changed. It skips any page with a date of 2021 or later and any page of filler text (`test/corpus.test.ts` fails on a
  later date). The NASA pages come from the site's current HTML, so `htmlToMd` cuts the site's own chrome (the share bullets, the details box, "Explore More" cards with their relative times, "Related links" and the "archived project" note) at the first such block; `nasa-04`, `-09`, `-10`, `-14` and `-15` carried it and were rebuilt, and all five kept 184 to 332 words of a project's own prose. **What it does not cover:** small-business pages. No site of that kind carries a license that allows copies,
  so the 18F and Digital.gov pages (a team describing itself and its services) stand in for them.
- **AI** (`corpus/ai`, 176 pieces). Twenty-two briefs (a bakery post, a parish newsletter item, a congregation email, a
  plumber's About page, a sermon, a 4-H newsletter and so on) drafted by Claude Haiku, Sonnet and Opus (`claude -p`) and
  GPT-6 Luna (`codex exec`), with no skill, no settings and no instructions file. The Claude runs also get no tools, an empty working folder and a
  neutral system prompt, because Claude Code puts the signed-in account's email in the model's context and an earlier
  run signed seven drafts with the owner's name; `gen-ai.mjs` drafts a leaking piece again, and `test/corpus.test.ts`
  fails if any file in `corpus/` holds the owner's name. Each brief is drafted twice: with the
  writer's facts (`<id>.md`) and with the topic alone (`<id>-generic.md`), the way most people prompt.
- **Cached** (`--cached`, not in git): the no-skill writing drafts in `~/.cache/hildegard-creative-eval/runs`, reported
  with the AI drafts, and the drafts made with the skill there and in `~/.cache/hildegard-writing-eval`, reported
  apart (they are tuned against the lint, so they say nothing about recall).

Every piece has a `split`:

- `dev` pieces are read one at a time to design rules (`quality.ts --show <rule>` prints only those).
- `test` pieces, about a third, are read only as totals, so they say whether a change generalizes. Three were looked at:
  `stackexchange-30` when the first test run showed a false fail, and `18f-pages-08` and `18f-pages-15` when web pages
  were added late and failed. (A fourth, an old `digitalgov-guides-01`, left the corpus when pages dated 2021 or
  later were dropped; the guides were renumbered.)
- `holdout` pieces (73 human, 48 AI, drafted from six briefs no rule was built on) were set aside for that reason and
  not measured until the rules were final. It then showed 3 human pieces failing (4.1 percent) and 33.3 percent recall,
  so two things were changed (bold in different forms counts as one kind of tell, and "Ultimately" opening a last
  paragraph only warns), after which the holdout is no longer untouched: 0.0 percent and 31.3 percent. Review then asked for a tighter placeholder rule and a corpus with no 2021-or-later pages and no draft that knew the owner's name; with both, the holdout reads 0.0 percent and 33.3 percent.

## What it reports

- **Recall**: AI drafts that fail the lint. **False fail**: human pieces that fail it. A text fails when any finding
  has severity `fail`. Both are also given for each split, and recall for each model.
- **Per rule**: the share of human pieces and of AI drafts the rule fires on, and how often it fires as a fail. A rule
  that fires on people as often as on machines is noise.
- **Speed**: median milliseconds for realistic prose at 1k, 10k, 100k and 1M characters and for the adversarial
  inputs in `test/prose-fixtures.json`, both engines. The Python script runs in one process. `--profile` shows where
  the time goes, `--before <ref>` times the engines at a git ref beside this tree's.

Every report is given in two profiles. The **default** profile is the one that must never fail a person: its human
false-fail count is held at 0, and `humanWarns` (human pieces with any warn, the em dash included) is recorded, not
limited. The **strict** profile (`lintProse(text, { strict: true })`, `--strict` on the CLI and the script) fails the
em dash and the other warns in `strict.fail` too, so it fails about half of the human pieces on purpose; the ratchet
holds its AI recall and that it fails at least what the default fails, not its human count.

`baseline.json` holds the counts the tests compare against (the default profile's, and the strict profile's under
`strict`); `quality.ts --ratchet` raises them. `results/before-quality.txt`
is the lint as it stood before the changes in the pull request that added this bench (`quality.ts --ref origin/main`),
`results/after-quality.txt` is the lint after, and `results/speed.txt` is `speed.ts --before origin/main --profile`.
The machine was busy while the speed numbers were taken (load average 40 to 58 on 32 cores), so read them as ratios: over the 100,000 and 1,000,000 character inputs the lint is 2.1 times faster in TypeScript and 3.2 times in Python.
