# Writing eval: does the skill write posts people would publish?

A blind head-to-head for the hildegard skill's everyday writing. Run it before and after any change to
`skills/hildegard/references/blog.md`, the writing parts of `SKILL.md`, or the prose lint, and keep a change only if
it wins.

## Method

- Four briefs in `briefs.json`: a bakery owner, a parish newsletter, a small engine shop and a homeschooling father.
  Each brief already holds the writer's facts and says "don't ask me questions", so the eval measures drafting, not
  the interview.
- `draft.sh` drafts each brief with Claude Sonnet under a copy of the skills (one folder for the baseline, one for
  the change), with no user settings and no MCP.
- `judge.py <baseline> <candidate>` has Claude Opus read each brief's two drafts in both orders, without knowing which
  is which, pick the one the writer would rather publish, and list every fact the brief doesn't support.
- Every draft also goes through `skills/hildegard/scripts/prose_lint.py`.

```sh
export EVAL_DIR=~/.cache/hildegard-writing-eval
mkdir -p $EVAL_DIR/old $EVAL_DIR/new
git archive origin/main skills/hildegard | tar -x -C $EVAL_DIR/old
cp -r skills $EVAL_DIR/new/
python3 -c "import json,subprocess; [subprocess.run(['evals/writing/draft.sh',v,b['id'],b['brief']]) for b in json.load(open('evals/writing/briefs.json')) for v in ('old','new')]"
python3 evals/writing/judge.py old new
```

## Results, 2026-11-05 (main at 729e41b against this branch)

| Round | Candidate wins | Invented facts per post, baseline | Invented facts per post, candidate | Lint fails |
| --- | --- | --- | --- | --- |
| 1: blog.md, lint step | 6 of 8 (five clear, one slight) | 0 to 9 (5.6) | 0 to 5 (1.9) | none either side |
| 2: no advice the writer didn't give, headings only past 600 words, warm close in their words | 6 of 8, all six clear | 0 to 10 (6.2) | 0 to 3 (1.5) | none either side |

The baseline won the short parish notice both times, slightly, for a livelier voice. The candidate still reads plain
when the brief carries no voice material, which is what the interview in `blog.md` is for. Raw verdicts:
`results-r1.json`, `results-r2.json`.
