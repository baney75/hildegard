# Writing

Hildegard makes pictures, films and sound, but a piece also needs words: a blog post, an email, a page, a caption, a
script. This page is about checking those words. For the whole idea of slop, read [craft.md](craft.md).

## The prose lint

The prose lint reads words a person will read and finds the habits that make them sound machine-made. It points at
each one by line and column, says why it reads that way, and says what to do instead. It checks prose, not image or
video prompts: `review_prompt` does those. Code blocks, inline code, link targets and HTML are skipped, and so are
words in quotation marks, since a list of banned words should not fail for naming them.

It looks for 28 kinds of tell. The rule ids are in the output, and a few examples are:

- Stock words and empty openers: "delve", "tapestry", "let's dive in", "as an AI".
- Contrasts of the form "it's not X, it's Y", a trailing "-ing" clause that claims meaning, a colon followed by a reveal.
- Template habits: bullets that each open on a bold label, a heading every few lines, bold sprinkled through a paragraph.
- Placeholder text left in, such as "TODO", "lorem ipsum", "[your name]" or "[this week's produce]".
- Stock warmth in pairs ("we're grateful to", "thank you for being part of", "it truly makes a difference").
- Several small tells of different kinds in one piece, which is how a generated draft reads even when each tell is common.

Every finding is either a fail or a warn. A fail is a tell that is almost never on purpose, or several small ones
together, so the text does not pass until you fix it. A warn is a judgment call: fix it unless it is the writer's own
voice, such as a poet's deliberate fragments. A text passes when nothing fails, and is clean when nothing is found at all.
Some rules stay quiet until they find a few: one office word is a habit, three read as a press release.

For an agent, whether Claude Code, Codex or Cursor, the rule is the same each time. Lint every piece of prose before
showing it to anyone. For everyday prose (a post, an email, a page, an announcement), fix every fail, fix each warn
that is not the writer's voice, and lint again until it passes. For poems, fiction, scripts, prayers, speeches and
academic papers, every finding is a warning: keep what the voice, form or field needs, and say which you kept.

## Four ways to run it

All four use the same rules, kept in `packages/craft/src/prose-rules.json`, so they agree on the same text.

| Where | How | Needs |
| --- | --- | --- |
| Studio and the API | `POST /api/writing/lint` with `{ "text": "…" }` (and `"strict": true` for the strict profile), up to 200,000 characters. Any signed-in person may use it. | A running Hildegard |
| MCP tool | `lint_writing` with `text`, or `path` for a file on the computer the MCP server runs on, `max` places to show for each finding, and `strict: true` for the strict profile. | A linked AI app |
| Command line | `hildegard lint post.md`, or `hildegard lint -` for standard input. `--json` prints the lint itself. `--max N` (1 or more) sets the places shown for each finding. `--strict` is the strict profile. The exit status is 1 when any file fails, and 2 for bad usage or a file it can't read. | Hildegard installed, but no server running |
| The skill's script | `python3 skills/hildegard/scripts/prose_lint.py post.md`, with the same `--json`, `--max`, `--strict` and exit statuses (0 passes, 1 fails, 2 bad usage or an unreadable file). | Only Python 3 |

The script is for an agent that has the Hildegard skill but not Hildegard itself, such as one that Claude or ChatGPT runs in a sandbox on a web page.
It reads `prose_rules.json` from its own folder. A test runs it against the package on shared cases and on every page
at the top of `docs/`, so the two cannot drift apart without the tests failing.

## How well it works

The rules were set by measurement, not by taste. The bench in `packages/craft/bench` runs the lint over 220 pieces
people wrote and 176 drafts AI models wrote, and counts how often each rule fires on each. A rule that fires on people as
often as on machines is noise, so it either warns only or is gone.

- **People** (220 pieces, all published before 2021): blog posts, newsletters, announcements and web pages from 18F,
  Digital.gov, NASA, Creative Commons and Global Voices (public domain, CC0, CC BY); Stack Exchange answers on
  gardening, cooking, repairs, music, pets, parenting and money (CC BY-SA); sermons and letters from Project Gutenberg.
  Each piece has its source, author, license and a SHA-256 in `corpus/human/manifest.json`.
- **AI drafts** (176): 22 briefs (a bakery post, a parish newsletter item, a congregation email, a plumber's About page,
  a sermon, a Little League newsletter) drafted by Claude Haiku, Sonnet and Opus and GPT-6 Luna with no skill, once
  with the writer's facts and once from the topic alone.
- **Splits.** `dev` pieces (98 human, 72 AI) were read to design rules. `test` pieces (49, 56) were read only as totals, apart from four noted in the bench README.
  A `holdout` (73, 48) was set aside and not measured until the rules were final.

| | Before | After |
| --- | --- | --- |
| AI drafts that fail (recall) | 11.4% (20 of 176) | 30.7% (54 of 176) |
| People's pieces that fail | 32.3% (71 of 220) | 0.0% (0 of 220) |
| People's pieces with any warn | 45.9% | 50.9% (112 of 220, the em dash warns on 78) |
| AI drafts with any finding | 61.4% | 86.9% |
| Recall by model (Haiku, Sonnet, Opus, Luna) | 11, 2, 14, 18% | 39, 23, 43, 18% |
| Holdout: AI recall, people failing | 12.5%, 26.0% | 31.3%, 0.0% |
| **Strict profile** (see below): AI recall, people failing | | 80.7% (142 of 176), 46.4% (102 of 220) |
| 100,000 characters, TypeScript | 28 ms | 12 ms (2.4 times faster) |
| 100,000 characters, Python script | 590 ms | 100 ms (6 times faster) |

The speeds are medians on a busy laptop, so read them as ratios. Read the recall with care. Models in 2026 write cleaner prose than the lint was first built for: in this corpus no draft
used "delve" or "tapestry", and 21 percent used a dash, against 40 percent of the people's pieces. So most of the
catch now comes from structure and filler, not from banned words, and a plain short draft with none of them passes.
Two things were looked at after the holdout was measured: it showed 3 people's pieces failing (4.1 percent), and the lint
was changed so that bold in different forms counts as one kind of tell and "Ultimately" opening a last paragraph only
warns. The table's holdout row is after that change, so it is no longer an untouched test. The corpus has no small-business
pages, because no site of that kind carries a license that allows copies; web pages by a government team stand in
for them. The bench's README says how to rebuild all of it.

### What each rule does

Hits are the share of the people's pieces and of the AI drafts the rule fired on. A rule with no hits in either stays
for older models that wrote "delve" and "it's worth noting".

| Rule | Tier | Catches | People | AI |
| --- | --- | --- | --- | --- |
| `stacked-tells` | fail | Two or more different kinds of weak tell in one piece | 0% | 17.0% |
| `unfinished` | fail | TODO, lorem ipsum, `[your name]`, `[this week's produce]` | 0% | 14.8% |
| `stock-words` | fail | "delve", "tapestry", "testament to", "multifaceted", "bustling", "nestled" | 0% | 0% |
| `empty-phrases` | fail | "let's dive in", "as an AI", "I hope this helps", "look no further", "in today's fast-paced world" | 0% | 0% |
| `throat-clearing`, `faux-insight`, `puffery`, `chatbot` | fail | "here's the thing", "most people skip", "stands as a testament", "great question" | 0% | 1.1% |
| `negative-list`, `ing-tail`, `emoji-heading` | fail | "Not a X. Not a Y.", ", highlighting", emoji as headings | 0% | 0% |
| `em-dash` | warn (fail when strict) | An em dash, or a spaced double hyphen used as one. Not a hyphen, an en dash or a number range | 35.5% | 21.0% |
| `not-but` | warn, fail past one | "It's not X, it's Y", "more than a X. It was Y" | 3.6% | 2.3% |
| `summary-ending` | fail for "In conclusion", warn for "Overall" | A last paragraph that recaps | 0.5% | 0% |
| `headings` | warn | Three or more headings and one for every 125 words or fewer | 9.1% | 40.3% |
| `bold-list-leads` | warn | Bullets that each open on a bold label | 3.6% | 31.8% |
| `warm-boilerplate` | warn, two or more | "we're grateful to", "thank you for being part of", "feel free to reach out" | 0% | 12.5% |
| `uniform-paragraphs` | warn | Six or more paragraphs, nearly all under 46 words, none over 60 | 4.1% | 15.3% |
| `bold`, `bold-leads` | warn | Bold through a paragraph, or opening most paragraphs | 4.1%, 0.9% | 16.5%, 7.4% |
| `triads`, `colon-reveal` | warn | Lists of three on every other line, a colon then a reveal | 4.1%, 0% | 11.9%, 1.7% |
| `metadiscourse`, `weasel` | warn | "as you can see", "to be honest", "experts agree" | 0.5%, 0% | 11.9%, 0% |
| `corporate-words`, `cliches`, `loaded-words`, `summary-openers`, `filler-adverbs` | warn, only when several | "leverage", "when it comes to", "crucial", "in summary", "actually" | 0.5% to 0.9% | 0% |

Stacking counts kinds, not hits: `bold`, `bold-leads` and `bold-list-leads` are one habit, so a piece with all three and
nothing else does not fail. `headings` and `uniform-paragraphs` warn but do not stack, because a web page has both.

Stacked fragments, even sentence lengths and low counts of names and numbers were rules before. Each fired on people as
often as on machines or more, so they are gone.

### The em dash: a warning, never a fail

The first version of this rework removed the dash rule, because the data said a dash does not separate people from
machines. In pre-2021 writing, 35.5 percent of the people's pieces use an em dash against 21.0 percent of the AI drafts
(78 of 220 and 37 of 176), and the more dashes in a piece, the more likely a person wrote it. That has not changed, and it
is why `em-dash` **never fails** a piece by default and is not one of the weak tells that stack into `stacked-tells`.

It came back as a warning for two other reasons. In 2026 many readers take an em dash for a machine tell whatever the
data says, and the owner's house style does not use them. So the warning says so plainly: use a comma, a colon, parentheses
or two sentences, and keep the dash only where it is truly yours. A writer who keeps it says so, as with any other warn;
for poems, fiction, scripts and the other forms where every finding is a warning, nothing changes. The rule finds the em
dash character (U+2014) and a double hyphen with a space on each side, the way plain text types one. A hyphen, an en dash,
a number range such as 2020-2024 and a command flag such as `--max` are never found. It adds nothing to the lint's
running time: it is a plain text search, and a text with no dash is searched once.

### The strict profile

For writing that must carry no tells at all, ask for the strict profile. Every warn in `strict.fail` in
`prose-rules.json` then fails: the em dash, `corporate-words`, `cliches`, `metadiscourse`, `weasel`, `loaded-words`,
`summary-openers`, `filler-adverbs`, `warm-boilerplate`, `not-but`, `colon-reveal`, `summary-ending`, `triads`,
`bold-leads`, `bold-list-leads`, `bold` and `uniform-paragraphs`. `headings` stays a warning, because a page needs
headings. Nothing else changes: the same findings are reported in the same places, and only their severity and `ok` move.

| Profile | AI recall | People failing | People with any warn |
| --- | --- | --- | --- |
| Default | 30.7% (54 of 176) | 0.0% (0 of 220) | 50.9% (112 of 220) |
| Strict | 80.7% (142 of 176) | 46.4% (102 of 220) | 9.1% (20 of 220, `headings` only) |
| Strict, holdout | 79.2% (38 of 48) | 34.2% (25 of 73) | |

Strict is not for judging whether a person wrote something: it fails about half of the people's pieces on purpose. It is
for an owner who has decided a piece should carry none of these tells and will rewrite until it does. The default stays
the one that must never fail a person, and the ratchet holds it to 0.0 percent.

, and is clean when nothing is found at all.
Some rules stay quiet until they find a few: one office word is a habit, three read as a press release.

For an agent, whether Claude Code, Codex or Cursor, the rule is the same each time. Lint every piece of prose before
showing it to anyone. For everyday prose (a post, an email, a page, an announcement), fix every fail, fix each warn
that is not the writer's voice, and lint again until it passes. For poems, fiction, scripts, prayers, speeches and
academic papers, every finding is a warning: keep what the voice, form or field needs, and say which you kept.

## Four ways to run it

All four use the same rules, kept in `packages/craft/src/prose-rules.json`, so they agree on the same text.

| Where | How | Needs |
| --- | --- | --- |
| Studio and the API | `POST /api/writing/lint` with `{ "text": "…" }`, up to 200,000 characters. Any signed-in person may use it. | A running Hildegard |
| MCP tool | `lint_writing` with `text`, or `path` for a file on the computer the MCP server runs on, and `max` places to show for each finding. | A linked AI app |
| Command line | `hildegard lint post.md`, or `hildegard lint -` for standard input. `--json` prints the lint itself. `--max N` (1 or more) sets the places shown for each finding. The exit status is 1 when any file fails, and 2 for bad usage or a file it can't read. | Hildegard installed, but no server running |
| The skill's script | `python3 skills/hildegard/scripts/prose_lint.py post.md`, with the same `--json`, `--max` and exit statuses (0 passes, 1 fails, 2 bad usage or an unreadable file). | Only Python 3 |

The script is for an agent that has the Hildegard skill but not Hildegard itself, such as one that Claude or ChatGPT runs in a sandbox on a web page.
It reads `prose_rules.json` from its own folder. A test runs it against the package on shared cases and on every page
at the top of `docs/`, so the two cannot drift apart without the tests failing.

### Changing a rule

Run `node packages/craft/bench/quality.ts` before and after. `packages/craft/test/prose-quality.test.ts` fails when more
of the people's pieces fail, or fewer of the AI drafts do, than `packages/craft/bench/baseline.json` records, in total and
in each split; the file also holds the strict profile's counts under `strict`, which may only fail more AI drafts, never
fewer, and never fewer than the default fails. When a change earns better numbers, `node packages/craft/bench/quality.ts --ratchet` writes them (it
refuses if anything got worse). `node packages/craft/bench/speed.ts --before origin/main` times both engines against a
git ref, and `prose-speed.test.ts` keeps 100,000 characters under a generous ceiling on a slow machine.
