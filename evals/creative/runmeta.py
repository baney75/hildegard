# SPDX-License-Identifier: AGPL-3.0-only
"""runmeta.py <model> <run dir>: read a responder's transcript and write final.txt (its last message) and meta.json
(did it load a skill, which references it read, how many tool calls, whether the run errored)."""
import json, os, re, sys

model, run = sys.argv[1:3]
final, skills, reads, calls, is_error, cost = '', [], [], 0, False, None
agents, tallies, briefs = 0, 0, 0  # the design council: critic subagents started, council.py tally and brief runs
for line in open(os.path.join(run, 'transcript.jsonl'), errors='replace'):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if model == 'haiku':
        if d.get('type') == 'assistant':
            for c in d.get('message', {}).get('content', []):
                if c.get('type') == 'tool_use':
                    calls += 1
                    i = c.get('input', {})
                    blob = json.dumps(i)
                    tallies += len(re.findall(r'council\.py"?\s+tally', blob))
                    briefs += len(re.findall(r'council\.py"?\s+brief', blob))
                    if c['name'] in ('Agent', 'Task'):
                        agents += 1
                    if c['name'] == 'Skill':
                        skills.append(i.get('skill') or i.get('name') or '?')
                    elif c['name'] == 'Read' and re.search(r'/skills/', i.get('file_path', '')):
                        reads.append(i['file_path'])
        elif d.get('type') == 'result':
            final = d.get('result') or ''
            is_error = bool(d.get('is_error'))
            cost = d.get('total_cost_usd')
    else:
        it = d.get('item') or {}
        if d.get('type') == 'item.completed':
            if it.get('type') == 'agent_message':
                final = it.get('text', '')
            elif it.get('type') == 'command_execution':
                calls += 1
                tallies += len(re.findall(r'council\.py"?\s+tally', it.get('command', '')))
                briefs += len(re.findall(r'council\.py"?\s+brief', it.get('command', '')))
                m = re.findall(r'[^\s\'"]*\.agents/skills/[^\s\'"]*', it.get('command', ''))
                reads += m
            elif it.get('type') in ('file_change', 'mcp_tool_call'):
                calls += 1
            elif it.get('type') in ('collab_tool_call', 'subagent') or 'spawn' in it.get('type', ''):
                agents += 1
        if d.get('type') in ('error', 'turn.failed'):
            is_error = True
            final = final or json.dumps(d)[:500]
names = sorted({os.path.basename(os.path.dirname(r)) if r.endswith('SKILL.md') else r for r in reads if r.endswith('SKILL.md')} | set(skills))
# Claude Code ships built-in skills (design, artifact-design, dataviz...) that every arm can load; only Hildegard's count here.
loaded = [n for n in names if n.split(':')[-1].startswith('hildegard')]
other = [n for n in names if n not in loaded]
refs = sorted({r.split('/skills/')[-1] for r in reads if not r.endswith('SKILL.md')})
open(os.path.join(run, 'final.txt'), 'w').write(final)
json.dump({'model': model, 'skill_loaded': bool(loaded), 'skills_loaded': loaded, 'other_skills_loaded': other, 'references_read': refs, 'tool_calls': calls,
           'council_ran': tallies > 0, 'council_tallies': tallies, 'council_briefs': briefs, 'subagents': agents,
           'is_error': is_error, 'seconds': int(open(os.path.join(run, 'seconds')).read() or 0) if os.path.exists(os.path.join(run, 'seconds')) else None,
           'cost_usd_reported': cost}, open(os.path.join(run, 'meta.json'), 'w'), indent=1)
