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
- Placeholder text left in, such as "TODO", "TK", "lorem ipsum dolor", "[Business Name]", "{{name}}" or "<insert the date>".
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

- **People** (220 pieces): blog posts, newsletters, announcements and web pages from 18F, Digital.gov, NASA, Creative
  Commons and Global Voices (public domain, CC0, CC BY); Stack Exchange answers on gardening, cooking, repairs, music,
  pets, parenting and money (CC BY-SA); sermons and letters from Project Gutenberg. 190 are dated 2020 or earlier in
  their sources (a test fails on any later date). The other 30 are 18F site pages that carry no date: their repository
  first holds them in June 2024 and changes them through January 2025, so they are marked `undated`, and they stand in
  for small-business pages. Each piece has its source, author, license, date and a SHA-256 in
  `corpus/human/manifest.json`.
- **AI drafts** (176): 22 briefs (a bakery post, a parish newsletter item, a congregation email, a plumber's About page,
  a sermon, a Little League newsletter) drafted by Claude Haiku, Sonnet and Opus and GPT-6 Luna with no skill, once
  with the writer's facts and once from the topic alone. The Claude drafts run with no settings, no instructions file
  and no tools, from an empty folder and under a neutral system prompt; a test fails if the owner's name is in any
  piece.
- **Splits.** `dev` pieces (98 human, 72 AI) were read to design rules. `test` pieces (49, 56) were read only as totals, apart from four noted in the bench README.
  A `holdout` (73, 48) was set aside and not measured until the rules were final.

| | Before | After |
| --- | --- | --- |
| AI drafts that fail (recall) | 11.9% (21 of 176) | 29.5% (52 of 176) |
| People's pieces that fail | 33.6% (74 of 220) | 0.0% (0 of 220) |
| People's pieces with any warn | 44.1% | 49.5% (109 of 220, the em dash warns on 79) |
| AI drafts with any finding | 60.8% | 84.7% |
| Recall by model (Haiku, Sonnet, Opus, Luna) | 16, 5, 9, 18% | 36, 21, 48, 14% |
| Holdout: AI recall, people failing | 6.3%, 30.1% | 33.3%, 0.0% |
| **Strict profile** (see below): AI recall, people failing | | 79.0% (139 of 176), 46.4% (102 of 220) |
| 100,000 characters, TypeScript | 28 ms | 12 ms (2.4 times faster) |
| 100,000 characters, Python script | 456 ms | 117 ms (3.9 times faster) |

"Before" is the lint on `origin/main`, measured on the same corpus. Over the 100,000 and 1,000,000 character inputs,
`results/speed.txt` has the lint 2.1 times faster in TypeScript and 3.2 times faster in Python; the 100,000 character
rows are the two above. The machine was loaded while it ran (load average 40 to 58 on 32 cores), so read the speeds as
ratios, not as what an idle computer does. Read the recall with care. Models in 2026 write cleaner prose than the lint was first built for: in this corpus no draft
used "delve" or "tapestry", and 17.6 percent used a dash, against 35.9 percent of the people's pieces. So most of the
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
| `stacked-tells` | fail | Two or more different kinds of weak tell in one piece | 0% | 18.2% |
| `unfinished` | fail | TODO, TK, "lorem ipsum dolor", template slots such as `[Business Name]`, `[your name]`, `{{name}}`, `<insert the date>` and `XX/XX/XXXX`. Ordinary brackets, such as a link `[our contact page]` or `the [church] voted`, pass | 0% | 11.4% |
| `stock-words` | fail | "delve", "tapestry", "testament to", "multifaceted", "bustling", "nestled" | 0% | 0% |
| `empty-phrases` | fail | "let's dive in", "as an AI", "I hope this helps", "look no further", "in today's fast-paced world" | 0% | 0% |
| `throat-clearing`, `faux-insight`, `puffery`, `chatbot` | fail | "here's the thing", "most people skip", "stands as a testament", "great question" | 0% | 1.7% |
| `negative-list`, `ing-tail`, `emoji-heading` | fail | "Not a X. Not a Y.", ", highlighting", emoji as headings | 0% | 0.6% |
| `em-dash` | warn (fail when strict) | An em dash, or a spaced double hyphen used as one. Not a hyphen, an en dash or a number range | 35.9% | 17.6% |
| `not-but` | warn, fail past one | "It's not X, it's Y", "more than a X. It was Y" | 3.6% | 3.4% |
| `summary-ending` | fail for "In conclusion", warn for "Overall" | A last paragraph that recaps | 0.5% | 0% |
| `headings` | warn | Three or more headings and one for every 125 words or fewer | 6.8% | 42.6% |
| `bold-list-leads` | warn | Bullets that each open on a bold label | 3.2% | 30.1% |
| `warm-boilerplate` | warn, two or more | "we're grateful to", "thank you for being part of", "feel free to reach out" | 0% | 14.8% |
| `uniform-paragraphs` | warn | Six or more paragraphs, nearly all under 46 words, none over 60 | 4.5% | 16.5% |
| `bold`, `bold-leads` | warn | Bold through a paragraph, or opening most paragraphs | 4.1%, 0.9% | 15.9%, 4.0% |
| `triads`, `colon-reveal` | warn | Lists of three on every other line, a colon then a reveal | 4.1%, 0% | 14.2%, 1.7% |
| `metadiscourse`, `weasel` | warn | "as you can see", "to be honest", "experts agree" | 0.5%, 0% | 14.8%, 0% |
| `corporate-words`, `cliches`, `loaded-words`, `summary-openers`, `filler-adverbs` | warn, only when several | "leverage", "when it comes to", "crucial", "in summary", "actually" | 0.5% to 0.9% | 0% |

Stacking counts kinds, not hits: `bold`, `bold-leads` and `bold-list-leads` are one habit, so a piece with all three and
nothing else does not fail. `headings` and `uniform-paragraphs` warn but do not stack, because a web page has both.

Stacked fragments, even sentence lengths and low counts of names and numbers were rules before. Each fired on people as
often as on machines or more, so they are gone.

### The em dash: a warning, never a fail

The first version of this rework removed the dash rule, because the data said a dash does not separate people from
machines. In the people's pieces, 35.9 percent use an em dash against 17.6 percent of the AI drafts
(79 of 220 and 31 of 176), and the more dashes in a piece, the more likely a person wrote it. That has not changed, and it
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
| Default | 29.5% (52 of 176) | 0.0% (0 of 220) | 49.5% (109 of 220) |
| Strict | 79.0% (139 of 176) | 46.4% (102 of 220) | 6.8% (15 of 220, `headings` only) |
| Strict, holdout | 77.1% (37 of 48) | 35.6% (26 of 73) | |

Strict is not for judging whether a person wrote something: it fails about half of the people's pieces on purpose. It is
for an owner who has decided a piece should carry none of these tells and will rewrite until it does. The default stays
the one that must never fail a person, and the ratchet holds it to 0.0 percent.

### Changing a rule

Run `node packages/craft/bench/quality.ts` before and after. `packages/craft/test/prose-quality.test.ts` fails when more
of the people's pieces fail, or fewer of the AI drafts do, than `packages/craft/bench/baseline.json` records, in total and
in each split; the file also holds the strict profile's counts under `strict`, which may only fail more AI drafts, never
fewer, and never fewer than the default fails. When a change earns better numbers, `node packages/craft/bench/quality.ts --ratchet` writes them (it
refuses if anything got worse). `node packages/craft/bench/speed.ts --before origin/main` times both engines against a
git ref, and `prose-speed.test.ts` keeps 100,000 characters under a generous ceiling on a slow machine.

## Your own voice

An AI app writes better for you when it knows how you write. Hildegard keeps that for each person, apart from
everyone else's, in the data folder under `writing/<person>/`:

- `voice.md`: short rules in your own words. What to do, what never to do, and a phrase of yours for each. Every time
  it is replaced, the old version goes to `history/voice-<time>.md`, and the last 20 are kept.
- `samples/`: things you wrote, up to 50,000 characters each and 200 in all.
- `edits.jsonl`: one line each time you changed a draft an app wrote: the phrases you cut and the ones you added, the
  word counts, and how many fails and warnings the prose lint found in the draft and in your final text. The last
  2,000 lines are kept.

Folders are readable by you alone (0700) and files too (0600). On this computer the voice is the first owner's. From
another device it is the person who signed in. A director reaches only their own: asking for someone else's is
refused. An owner can name another person with `?person=<id>`, so a director's voice, samples and edits are visible to
the owners of that Hildegard and to no other director.

| Where | How |
| --- | --- |
| Studio | Settings › Writing: paste or choose `.md` and `.txt` samples, remove them, read and edit the voice notes, and see what you changed lately and the phrases you cut most. |
| API | `GET` and `PUT /api/writing/voice`, `GET` and `POST /api/writing/samples`, `GET` (with the text) and `DELETE /api/writing/samples/<id>`, `GET` and `POST /api/writing/edits` (body `{ draft, final, note? }`, each text up to 30,000 characters and 1,500 sentences; past that the answer is 413 and says how to split it). |
| MCP | `writing_voice` reads the notes, the sample titles and ids, the last 10 edits and the 30 phrases cut most. `writing_voice_samples` reads the sample text, newest first, up to 20,000 characters a call. `writing_voice_add_sample`, `writing_voice_record_edit` and `writing_voice_update` write. |

How an agent uses it: read `writing_voice` before writing anything in a person's name, and `writing_voice_samples` to learn from their own sentences. When they hand over something
they wrote, add it as a sample. When they change a draft, send both versions with `writing_voice_record_edit`. When
the same phrases keep going, write a rule for it with `writing_voice_update`, then lint the next draft as usual.

The server finds the phrases by comparing sentences in order, then the words inside any sentence that was rewritten,
so “delve into” turning into “look at” is recorded as that. Nothing is learned without a person: Hildegard never
changes `voice.md` by itself.
