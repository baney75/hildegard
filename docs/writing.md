# Writing

Hildegard makes pictures, films and sound, but a piece also needs words: a blog post, an email, a page, a caption, a
script. This page is about checking those words. For the whole idea of slop, read [craft.md](craft.md).

## The prose lint

The prose lint reads words a person will read and finds the habits that make them sound machine-made. It points at
each one by line and column, says why it reads that way, and says what to do instead. It checks prose, not image or
video prompts: `review_prompt` does those. Code blocks, inline code, link targets and HTML are skipped, and so are
words in quotation marks, since a list of banned words should not fail for naming them.

It looks for 24 kinds of tell. The rule ids are in the output, and a few examples are:

- Stock words and empty openers: "delve", "tapestry", "it's worth noting", "in today's fast-paced world".
- Dashes used for rhythm, and contrasts of the form "it's not X, it's Y".
- A trailing "-ing" clause that claims meaning, and a colon followed by a reveal.
- Stacked fragments, even sentence lengths, and lists of three on every other line.
- Bold labels opening most paragraphs, emoji as headings, and a last paragraph that sums up the rest.
- Placeholder text left in, such as "TODO", "lorem ipsum" or "[your name]".

Every finding is either a fail or a warn. A fail is a tell that is almost never on purpose, so the text does not pass
until you fix it. A warn is a judgment call: fix it unless it is the writer's own voice, such as a poet's
deliberate fragments. A text passes when nothing fails, and is clean when nothing is found at all. Short pieces get
stricter treatment than long ones: one dash fails a 100-word email and only warns in a 2,000-word essay.

For an agent, whether Claude Code, Codex or Cursor, the rule is the same each time. Lint every piece of prose before showing it to anyone, fix every fail,
fix each warn that is not the writer's voice, and lint again until it passes.

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
