# SPDX-License-Identifier: AGPL-3.0-only
"""Blind pairwise judge: judge.py <baseline> <candidate>. Opus reads each brief's two drafts in both orders, not
knowing which skill made which, and picks the one the writer would rather publish; it lists invented facts too."""
import json, os, subprocess, sys, concurrent.futures as cf
H = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-writing-eval'))
BASE, CAND = sys.argv[1], sys.argv[2]
BRIEFS = os.environ.get('BRIEFS', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'briefs.json'))
briefs = {b['id']: b['brief'] for b in json.load(open(BRIEFS))}
def judge(args):
    id_, order = args
    a, b = (BASE, CAND) if order == 0 else (CAND, BASE)
    A = open(f'{H}/{a}/{id_}.md').read(); B = open(f'{H}/{b}/{id_}.md').read()
    prompt = f"""You are judging two drafts written for the same person from the same brief. You do not know how either was made.

BRIEF:
{briefs[id_]}

<<<DRAFT A
{A}
DRAFT A>>>

<<<DRAFT B
{B}
DRAFT B>>>

Judge which draft the writer would rather publish under their own name. Weigh, in order: (1) facts: anything stated that the brief does not support (an invented number, quote, claim, event or medical/legal claim) is a serious fault; (2) does it read like this specific person wrote it, or like generic AI content; (3) does it use the brief's specifics well and serve the reader and the writer's ask; (4) line-level tells of machine prose.
Reply with only JSON: {{"winner": "A" or "B", "margin": "slight"|"clear"|"decisive", "invented_A": [strings], "invented_B": [strings], "why": "two sentences"}}"""
    for attempt in range(2):
      r = subprocess.run(['claude','-p','--model','opus','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--tools',''], input=prompt, capture_output=True, text=True, env={k:v for k,v in os.environ.items() if k!='ANTHROPIC_API_KEY'}, timeout=600)
      out = r.stdout.strip()
      try:
          d, _ = json.JSONDecoder().raw_decode(out[out.find('{'):])
          if d.get('winner') in ('A', 'B'):
              break
      except ValueError:
          d = {}
    if d.get('winner') not in ('A', 'B'):
        raise SystemExit(f'{id_} order {order}: the judge gave no verdict twice')
    win = a if d['winner']=='A' else b
    inv = {a: d.get('invented_A', []), b: d.get('invented_B', [])}
    return {'id': id_, 'order': order, 'winner': win, 'margin': d.get('margin', ''), 'invented_base': inv[BASE], 'invented_cand': inv[CAND], 'why': d.get('why', '')}
jobs = [(i, o) for i in briefs for o in (0, 1)]
with cf.ThreadPoolExecutor(8) as ex: res = list(ex.map(judge, jobs))
json.dump(res, open(os.path.join(H, f'judgments-{BASE}-{CAND}-{os.path.basename(BRIEFS)}'),'w'), indent=1)
for r in res: print(r['id'], r['order'], 'winner=', r['winner'], r['margin'], '| invented', BASE, len(r['invented_base']), CAND, len(r['invented_cand']))
print(CAND, 'wins', sum(r['winner']==CAND for r in res), 'of', len(res))
