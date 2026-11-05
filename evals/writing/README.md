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

One draft per brief and variant, judged in both orders, so each brief gives two verdicts.

**Held out.** `heldout.json` holds four briefs written after tuning was done (a 4-H newsletter, a real estate
agent's about page, a fishing guide's packing list, a dental office's move notice). Produced by the committed
`draft.sh` and `judge.py` (`BRIEFS=evals/writing/heldout.json`); verdicts in `results-heldout.json`.

| Brief | Verdicts (both orders) | Invented facts, main | Invented facts, branch |
| --- | --- | --- | --- |
| 4-H newsletter | branch, branch (both clear) | 4, 4 | 0, 0 |
| About page | main, branch (both clear) | 4, 7 | 1, 0 |
| Packing list | main (clear), branch (slight) | 3, 5 | 2, 2 |
| Move notice | branch, branch (clear, slight) | 4, 3 | 1, 1 |

The branch wins 6 of 8 verdicts, and the judge finds 0.9 unsupported facts a post in its drafts against 4.3 in
main's. Two briefs split by order, which is the judge's position bias showing, so read this as 2 briefs won
outright and 2 tied, not as 75%.

**Tuning set.** `briefs.json` is what `blog.md` was revised against, so it is not evidence on its own. Round 1
(first version) won 6 of 8 with 1.9 invented facts a post against main's 5.6; round 2 (after revising from the
judge's notes) won 6 of 8, all clear, with 1.5 against 6.2. Those two files came from an earlier copy of the same
scripts, before they took variant names as arguments: in them the branch is `new` (round 1) and `new2` (round 2),
and the invented-fact keys are `invented_old` and `invented_new`.

No draft on either side failed the prose lint. The branch still reads plain when a brief carries no voice
material, which is what the interview in `blog.md` is for; the judge preferred main's livelier voice on the short
parish notice both times.
