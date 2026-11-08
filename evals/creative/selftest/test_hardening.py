# SPDX-License-Identifier: AGPL-3.0-only
"""Checks on the eval's own safety and bookkeeping: python3 evals/creative/selftest/test_hardening.py
No model is called: respond.sh runs against a fake `claude`, and the judge's `ask` is replaced. Needs the inputs from make_audio.py.

  F1  responder scripts run sandboxed: no write to the real home or outside the task folder, no network, no new privileges
  F2  a finished run is reused only while the skills it used are unchanged
  F3  skill loads are found when the path ends in `;` or the command is chained
  F4  a responder that dies leaves meta.json with the error and no `done`
  F5  model HTML renders with a throwaway profile and HOME, and its requests to anything but Google Fonts go nowhere
  F8  a quota message halts the dispatch of every later job
  F9  the judge works in a fresh folder outside the eval tree holding only A.* and B.*, and a leak scan guards it
  F10 a run with no `done` (the responder timed out or died) is never scored or judged; it is an automatic loss
  F12 a verdict is reused only while both runs it judged are unchanged: a run made again is judged again
  F13 --judge-only refuses runs made with other skills than the arm's skills now, or with no recorded hash
  F14 the eval folder (clean references, inputs, other runs) is not readable from the sandbox, wherever EVAL_DIR is; without bubblewrap the scorer refuses
  F11 skill paths, skill names and reference file names in a deliverable are redacted in both arms, and the leak scan fails on one that is left"""
import json, os, shutil, socket, stat, subprocess, sys, tempfile, threading
HERE = os.path.dirname(os.path.abspath(__file__))
CR = os.path.dirname(HERE)
sys.path.insert(0, CR)
import score_audio as sa
import sandbox
import score
import skillhash
import judge

fails = []


def check(name, cond, detail=''):
    print(('ok   ' if cond else 'FAIL ') + name, str(detail)[:300] if not cond else '')
    if not cond:
        fails.append(name)


class Listener:
    """A TCP listener on 127.0.0.1 that counts connections."""
    def __init__(self):
        self.s = socket.socket()
        self.s.bind(('127.0.0.1', 0))
        self.s.listen(8)
        self.port = self.s.getsockname()[1]
        self.hits = 0
        self.t = threading.Thread(target=self.loop, daemon=True)
        self.t.start()

    def loop(self):
        while True:
            try:
                c, _ = self.s.accept()
            except OSError:
                return
            self.hits += 1
            c.close()


def script(path, text):
    open(path, 'w').write('#!/bin/bash\n' + text)
    os.chmod(path, 0o755)
    return path


# ---- F1: sandboxed scripts -------------------------------------------------------------------------------------------
tid = 'a1-podcast-clean'
home = os.path.expanduser('~')
tag = f'hg-selftest-{os.getpid()}'
mark_home, mark_var = os.path.join(home, f'.{tag}'), f'/var/tmp/{tag}'
lst = Listener()
with tempfile.TemporaryDirectory() as d:
    evil = script(os.path.join(d, 'evil.sh'), f'''
inp=$(ls *.wav | head -1)
{{ touch {mark_home} 2>/dev/null && echo home=WROTE || echo home=blocked; }} > report.txt
{{ echo x > {mark_var} 2>/dev/null && echo outside=WROTE || echo outside=blocked; }} >> report.txt
{{ echo x > /usr/{tag} 2>/dev/null && echo usr=WROTE || echo usr=blocked; }} >> report.txt
{{ exec 3<>/dev/tcp/127.0.0.1/{lst.port} 2>/dev/null && echo net=CONNECTED || echo net=blocked; }} >> report.txt
grep -q 'NoNewPrivs:.1' /proc/self/status && echo nnp=1 >> report.txt || echo nnp=0 >> report.txt
echo "pid=$$" >> report.txt
ls /home/*/.ssh >/dev/null 2>&1 && echo ssh=VISIBLE >> report.txt
ffmpeg -v error -y -i "$inp" -t 1 out.wav
''')
    try:
        ok, secs, tmp, log, code = sa.run_script(tid, evil, 'out.wav')
        rep = dict(l.split('=', 1) for l in open(os.path.join(tmp, 'report.txt')).read().split())
        check('F1 the real home is untouched (a write there lands on a throwaway tmpfs)', not os.path.exists(mark_home), rep)
        check('F1 a write outside the task folder fails', not os.path.exists(mark_var) and rep.get('outside') == 'blocked' and rep.get('usr') == 'blocked', rep)
        check('F1 a connection to the host is refused', lst.hits == 0 and rep.get('net') == 'blocked', rep)
        check('F1 no new privileges', rep.get('nnp') == '1', rep)
        check('F1 the real ~/.ssh is not visible', 'ssh' not in rep, rep)
        if os.environ.get('EVAL_SANDBOX') != 'fallback' and shutil.which('bwrap'):
            check('F1 a new PID namespace', int(rep.get('pid', '9999')) < 20, rep)
        good = script(os.path.join(d, 'good.sh'), 'f=$(ls *.wav | head -1)\nffmpeg -v error -y -i "$f" -af loudnorm=I=-16:TP=-1.5 out.wav\n')
        ok2, *_ = sa.run_script(tid, good, 'out.wav')
        check('F1 a normal ffmpeg script still runs and writes out.wav', ok2)
        shutil.rmtree(tmp, ignore_errors=True)
    finally:
        for p in (mark_home, mark_var, f'/usr/{tag}'):
            if os.path.exists(p):
                os.remove(p)
        lst.s.close()

# ---- F3: skill-load detection ----------------------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as d:
    cmds = ["sed -n '1,200p' .agents/skills/hildegard/SKILL.md; echo done",
            "cat .agents/skills/hildegard-art/SKILL.md&&cat .agents/skills/hildegard-art/references/color.md|head -5",
            'bash -lc "cat .agents/skills/hildegard-web/SKILL.md"',
            "(cat .agents/skills/hildegard-sound/SKILL.md) 2>&1"]
    with open(os.path.join(d, 'transcript.jsonl'), 'w') as f:
        for c in cmds:
            f.write(json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'command': c}}) + '\n')
        f.write(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'ok'}}) + '\n')
        f.write(json.dumps({'type': 'turn.completed'}) + '\n')
    subprocess.run([sys.executable, os.path.join(CR, 'runmeta.py'), 'luna', d], check=True)
    m = json.load(open(os.path.join(d, 'meta.json')))
    check('F3 skills named in `;`, `&&`, quoted and parenthesized commands are all counted',
          m['skills_loaded'] == ['hildegard', 'hildegard-art', 'hildegard-sound', 'hildegard-web'], m['skills_loaded'])
    check('F3 a reference path loses its pipe', m['references_read'] == ['hildegard-art/references/color.md'], m['references_read'])

# ---- fake claude for respond.sh --------------------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as root:
    bindir, ev = os.path.join(root, 'bin'), os.path.join(root, 'eval')
    skills = os.path.join(root, 'newsk', 'skills')
    os.makedirs(bindir)
    os.makedirs(os.path.join(skills, 'hildegard'))
    open(os.path.join(skills, 'hildegard', 'SKILL.md'), 'w').write('one\n')
    count = os.path.join(root, 'calls')
    open(count, 'w').write('')
    fake = os.path.join(bindir, 'claude')
    open(fake, 'w').write(f'''#!/bin/bash
echo x >> {count}
cat > /dev/null
case ${{FAKE_MODE:-ok}} in
  ok) echo '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"made it"}}]}}}}'
      echo '{{"type":"result","result":"made it","is_error":false}}' ;;
  quota) echo '{{"type":"result","result":"You have hit your usage limit","is_error":true}}' ;;
  crash) echo "Segmentation fault" >&2; exit 139 ;;
esac
''')
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    # CLAUDE_BIN too: respond.sh resolves claude through mise before PATH, since a mise shim fails under the responder's empty HOME.
    env = {**os.environ, 'PATH': bindir + ':' + os.environ['PATH'], 'CLAUDE_BIN': fake, 'EVAL_DIR': ev, 'NEW_SKILLS': skills}
    env.pop('ANTHROPIC_API_KEY', None)

    def respond(task, mode='ok'):
        return subprocess.run(['bash', os.path.join(CR, 'respond.sh'), 'new', 'haiku', task], env={**env, 'FAKE_MODE': mode}, capture_output=True, text=True, timeout=120)

    def calls():
        return len(open(count).read().split())

    run = lambda task: os.path.join(ev, 'runs', 'new', 'haiku', task)
    t1, t2, t3 = 'd1-fall-festival', 'd2-bluegrass-cover', 'd3-hardware-anniversary'

    # F2
    r = respond(t1)
    meta1 = json.load(open(os.path.join(run(t1), 'meta.json'))) if os.path.exists(os.path.join(run(t1), 'meta.json')) else {}
    check('F2 a first run is made and marked done', r.returncode == 0 and calls() == 1 and os.path.exists(os.path.join(run(t1), 'done')), r.stderr)
    respond(t1)
    check('F2 the same skills reuse the run', calls() == 1, calls())
    open(os.path.join(skills, 'hildegard', 'SKILL.md'), 'w').write('two\n')
    respond(t1)
    meta2 = json.load(open(os.path.join(run(t1), 'meta.json')))
    check('F2 one changed skill file redoes the run', calls() == 2, calls())
    check('F2 meta.json names the skills hash, and it changed', bool(meta2.get('skills_hash')) and meta2.get('skills_hash') != meta1.get('skills_hash'), (meta1.get('skills_hash'), meta2.get('skills_hash')))

    # F4
    r = respond(t2, 'crash')
    mp = os.path.join(run(t2), 'meta.json')
    m = json.load(open(mp)) if os.path.exists(mp) else {}
    check('F4 a responder that dies is not marked done and exits non-zero', r.returncode != 0 and r.returncode != 99 and not os.path.exists(os.path.join(run(t2), 'done')), (r.returncode, r.stderr))
    check('F4 meta.json is written with the error', m.get('is_error') is True and bool(m.get('error')), m)

    # F8
    before = calls()
    r = respond(t3, 'quota')
    check('F8 a quota message exits 99 and leaves STOP', r.returncode == 99 and os.path.exists(os.path.join(run(t3), 'STOP')), (r.returncode, r.stderr))
    mid = calls()
    r = respond('d6-fire-pancakes')
    check('F8 with STOP present the next job calls no model', r.returncode == 99 and calls() == mid, (r.returncode, calls(), mid))
    jobs = os.path.join(root, 'jobs')
    fake_respond = script(os.path.join(root, 'fake_respond.sh'), f'echo "$@" >> {jobs}\nexit 99\n')
    r = subprocess.run(['bash', os.path.join(CR, 'dispatch.sh'), '1'], input='\n'.join(f'new haiku t{i}' for i in range(6)) + '\n', env={**env, 'RESPOND': fake_respond},
                       capture_output=True, text=True, timeout=60)
    started = len(open(jobs).read().splitlines()) if os.path.exists(jobs) else -1
    check('F8 dispatch starts no job after one exits 99', started == 1 and r.returncode != 0, (started, r.returncode, r.stderr))

# ---- F5: rendering untrusted HTML -------------------------------------------------------------------------------------
chrome = score.chromium()
os.environ['HILDEGARD_EVAL_CHROMIUM'] = chrome
lst = Listener()
with tempfile.TemporaryDirectory() as d:
    fake_home = os.path.join(d, 'home')
    os.makedirs(fake_home)
    page = os.path.join(d, 'p.html')
    p = lst.port
    open(page, 'w').write(f'''<!doctype html><meta charset=utf-8><body style="margin:0;background:#c33">
<img src="http://127.0.0.1:{p}/a.png"><img src="http://localhost:{p}/b.png"><link rel=stylesheet href="http://127.0.0.1:{p}/c.css">
<script>fetch("http://127.0.0.1:{p}/d").catch(()=>0);new Image().src="http://127.0.0.1:{p}/e.png";</script>
<h1 style="color:#fff">Hello</h1>''')
    old_home, os.environ['HOME'] = os.environ['HOME'], fake_home
    try:
        png = os.path.join(d, 'p.png')
        score.render(page, png, 400, 300)
    finally:
        os.environ['HOME'] = old_home
    check('F5 the page still renders', os.path.exists(png) and os.path.getsize(png) > 500)
    check('F5 requests to anything but Google Fonts go nowhere', lst.hits == 0, lst.hits)
    check('F5 Chromium writes nothing under the owner\'s home', not os.listdir(fake_home), os.listdir(fake_home))
lst.s.close()

# ---- F9: judge isolation ---------------------------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as ev:
    judge.E = ev
    task = {'id': 'w9-test', 'domain': 'writing', 'brief': 'Write one paragraph about a bake sale.'}
    for arm in ('none', 'main'):
        rd = os.path.join(ev, 'runs', arm, 'haiku', task['id'])
        os.makedirs(os.path.join(rd, 'work'))
        open(os.path.join(rd, 'work', 'draft.md'), 'w').write(f'---\nname: x\n---\nThe bake sale is on Saturday at nine, in the church hall, and every pie is five dollars ({arm} copy).')
        json.dump({'words': 30}, open(os.path.join(rd, 'score.json'), 'w'))
        json.dump({'finished': True, 'error': None, 'is_error': False}, open(os.path.join(rd, 'meta.json'), 'w'))
        open(os.path.join(rd, 'done'), 'w').close()
    seen = []

    def spy(prompt, cwd):
        near = [p for p in (os.path.join(cwd, '..'), cwd) if os.path.isdir(p)]
        seen.append({'cwd': cwd, 'files': sorted(os.listdir(cwd)), 'prompt': prompt,
                     'order_files_near': [f for p in near for f in os.listdir(p) if f in ('order0.json', 'order1.json')]})
        return {'winner': 'A', 'margin': 'slight', 'why': 'x', 'invented_A': [], 'invented_B': []}
    judge.ask = spy
    for o in (0, 1):
        judge.judge(('lbl', 'haiku', task, o, 'none', 'main'))
    check('F9 each judgment runs in a fresh folder outside the eval tree', all(not os.path.abspath(s['cwd']).startswith(os.path.abspath(ev)) for s in seen), [s['cwd'] for s in seen])
    check('F9 the folder holds only A and B', all(s['files'] == ['A.md', 'B.md'] for s in seen), [s['files'] for s in seen])
    check('F9 no order file sits next to it, even for the second order', all(not s['order_files_near'] for s in seen), [s['order_files_near'] for s in seen])
    check('F9 the prompt names no path and no arm', all(ev not in s['prompt'] and 'order0' not in s['prompt'] and s['cwd'] not in s['prompt'] for s in seen))
    check('F9 the folder is gone after the verdict', all(not os.path.exists(s['cwd']) for s in seen))
    # a deliverable that names the eval tree stops the run
    leaky = os.path.join(ev, 'runs', 'main', 'haiku', task['id'], 'work', 'draft.md')
    open(leaky, 'w').write('See /home/x/.cache/hildegard-creative-eval/runs/main/haiku/w9-test for the other one, at least twenty words long here now.')
    shutil.rmtree(os.path.join(ev, 'judge'))
    try:
        judge.judge(('lbl2', 'haiku', task, 0, 'none', 'main'))
        check('F9 a deliverable that names the eval tree is refused', False)
    except SystemExit as e:
        check('F9 a deliverable that names the eval tree is refused', 'leak' in str(e), e)

    # F10: the responder timed out after writing part of its draft: no done file, but a draft long enough to be judged
    judge.ask = spy
    seen.clear()
    part = os.path.join(ev, 'runs', 'main', 'haiku', task['id'])
    open(os.path.join(part, 'work', 'draft.md'), 'w').write('The bake sale is on Saturday at nine, in the church hall, and every pie is five dollars, come early for the apple.')
    os.remove(os.path.join(part, 'done'))
    shutil.rmtree(os.path.join(ev, 'judge'), ignore_errors=True)
    judge.E = ev
    json.dump([task], open(os.path.join(ev, 't.json'), 'w'))
    os.remove(os.path.join(part, 'score.json'))
    r = subprocess.run([sys.executable, os.path.join(CR, 'score.py'), task['id'], part, '--tasks', os.path.join(ev, 't.json')], capture_output=True, text=True, env={**os.environ, 'EVAL_DIR': ev})
    check('F10 score.py refuses a run with no done file and writes no score.json', r.returncode != 0 and not os.path.exists(os.path.join(part, 'score.json')), (r.returncode, r.stdout, r.stderr))
    json.dump({'words': 30}, open(os.path.join(part, 'score.json'), 'w'))  # even a stale score cannot get it judged
    v = judge.judge(('lbl3', 'haiku', task, 0, 'none', 'main'))
    check('F10 an unfinished run is an automatic loss and the judge is never called', not seen and v['auto'] and v['winner'] == 'none' and v['unfinished'] == ['main'], (v, seen))
    open(os.path.join(part, 'done'), 'w').close()
    json.dump({'finished': True, 'error': 'no finished transcript: died', 'is_error': True}, open(os.path.join(part, 'meta.json'), 'w'))
    check('F10 a done run whose meta.json carries an error is not available either', not judge.available('main', 'haiku', task))
    json.dump({'finished': True, 'error': None, 'is_error': False}, open(os.path.join(part, 'meta.json'), 'w'))
    check('F10 a finished run is available again', judge.available('main', 'haiku', task))

    # F11: a deliverable that cites the skills it read
    shutil.rmtree(os.path.join(ev, 'judge'), ignore_errors=True)
    seen.clear()
    cites = {'none': 'The bake sale is on Saturday at nine, in the church hall, and every pie is five dollars, see the apple pie.',
             'main': ('Per .agents/skills/hildegard-film/references/video-editing.md and skills/hildegard-art/SKILL.md, from the hildegard-web skill and the sheet '
                      'in prose-craft.md: the bake sale is on Saturday at nine, in the church hall, and every pie is five dollars.')}
    ref_dir = os.path.join(ev, 'skills-main-abc', 'skills', 'hildegard-art', 'references')
    os.makedirs(ref_dir)
    open(os.path.join(ref_dir, 'prose-craft.md'), 'w').write('x')
    for arm, text in cites.items():
        open(os.path.join(ev, 'runs', arm, 'haiku', task['id'], 'work', 'draft.md'), 'w').write(text)
    v = judge.judge(('lbl4', 'haiku', task, 0, 'none', 'main'))
    check('F11 a draft citing skill paths is still judged', not v['auto'] and len(seen) == 1, (v, len(seen)))
    texts = {}
    judge.ask = lambda prompt, cwd: (texts.update({f: open(os.path.join(cwd, f)).read() for f in os.listdir(cwd)}), spy(prompt, cwd))[1]
    shutil.rmtree(os.path.join(ev, 'judge'), ignore_errors=True)
    judge.judge(('lbl5', 'haiku', task, 0, 'none', 'main'))
    both = ' '.join(texts.values())
    check('F11 the paths, the skill names and the reference file name are replaced in the copy the judge reads',
          texts and not any(w in both for w in ('.agents', 'skills/', 'SKILL.md', 'hildegard-', 'video-editing.md', 'prose-craft.md')) and '[reference]' in texts['B.md'], texts)
    check('F11 the other arm is redacted the same way (nothing to redact there, text unchanged)', texts['A.md'] == cites['none'], texts.get('A.md'))
    left = tempfile.mkdtemp()
    open(os.path.join(left, 'A.md'), 'w').write('read prose-craft.md first')
    try:
        judge.scan(left, ('none', 'main'))
        check('F11 the leak scan fails on a reference file name that is left', False)
    except SystemExit as e:
        check('F11 the leak scan fails on a reference file name that is left', 'leak' in str(e), e)
    for t in ('see skills/hildegard-art', 'the hildegard-web skill', 'SKILL.md'):
        open(os.path.join(left, 'A.md'), 'w').write(t)
        try:
            judge.scan(left, ('none', 'main'))
            check(f'F11 the leak scan fails on {t!r}', False)
        except SystemExit as e:
            check(f'F11 the leak scan fails on {t!r}', 'leak' in str(e), e)
    shutil.rmtree(left)

    # F12: the main arm's run is made again with other skills; the old verdict must not come back
    judge.ask = spy
    shutil.rmtree(os.path.join(ev, 'judge'), ignore_errors=True)
    seen.clear()
    rdm = os.path.join(ev, 'runs', 'main', 'haiku', task['id'])
    open(os.path.join(rdm, 'work', 'draft.md'), 'w').write('The bake sale is on Saturday at nine, in the church hall, and every pie is five dollars, come early.')
    open(os.path.join(rdm, 'skills.sha'), 'w').write('aaa\n')
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F12 an unchanged pair is judged once', len(seen) == 1, len(seen))
    open(os.path.join(rdm, 'skills.sha'), 'w').write('bbb\n')
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F12 the same answer from other skills is judged again', len(seen) == 2, len(seen))
    open(os.path.join(rdm, 'work', 'draft.md'), 'w').write('Pies are five dollars at the church hall on Saturday at nine, and the bake sale runs until noon, come early.')
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F12 a different answer from the same skills is judged again', len(seen) == 3, len(seen))
    old = os.path.join(ev, 'judge', 'lbl6', 'haiku', task['id'], 'order0.json')
    rec = json.load(open(old))
    rec.pop('fingerprint')
    json.dump(rec, open(old, 'w'))
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F12 a verdict saved without a fingerprint is judged again', len(seen) == 4, len(seen))

    # F13
    with tempfile.TemporaryDirectory() as root:
        sk = os.path.join(root, 'skills')
        os.makedirs(os.path.join(sk, 'hildegard'))
        open(os.path.join(sk, 'hildegard', 'SKILL.md'), 'w').write('one\n')
        ev2, now = os.path.join(root, 'eval'), skillhash.tree_hash(sk)
        os.environ['NEW_SKILLS'] = sk
        r13 = os.path.join(ev2, 'runs', 'new', 'haiku', 'd1-fall-festival')
        os.makedirs(r13)
        stale = lambda: skillhash.stale(ev2, ['none', 'new'], ['haiku'], ['d1-fall-festival'])
        check('F13 a run with no recorded hash is stale', len(stale()) == 1 and 'no recorded hash' in stale()[0], stale())
        open(os.path.join(r13, 'skills.sha'), 'w').write('0123456789abcdef\n')
        check('F13 a run made with other skills is stale', len(stale()) == 1 and '0123456789ab' in stale()[0], stale())
        open(os.path.join(r13, 'skills.sha'), 'w').write(now + '\n')
        check('F13 a run made with the skills as they are is not', stale() == [], stale())
        open(os.path.join(sk, 'hildegard', 'SKILL.md'), 'w').write('two\n')
        check('F13 editing a skill after the run makes it stale', len(stale()) == 1, stale())
        r = subprocess.run(['bash', os.path.join(CR, 'run.sh'), 'f13', '--base', 'none', '--cand', 'new', '--models', 'haiku', '--only', 'd1-fall-festival', '--judge-only'],
                           env={**os.environ, 'EVAL_DIR': ev2}, capture_output=True, text=True, timeout=120)
        check('F13 run.sh --judge-only refuses (exit 3) and judges nothing', r.returncode == 3 and 'other skills' in r.stderr and not os.path.exists(os.path.join(ev2, 'judge')), (r.returncode, r.stderr))
        check('F13 the refusal carries skillhash\'s own line, so the check really ran', 'd1-fall-festival' in r.stderr, r.stderr)
        # A check that crashed is not a stale result: it stops the run even with --allow-stale.
        # (the main arm's skills come from `git archive origin/main`; a git folder that isn't there makes it fail)
        rc = subprocess.run(['bash', os.path.join(CR, 'run.sh'), 'f13', '--base', 'main', '--cand', 'new', '--models', 'haiku', '--only', 'd1-fall-festival', '--judge-only', '--allow-stale'],
                            env={**os.environ, 'EVAL_DIR': ev2, 'GIT_DIR': os.path.join(root, 'no-such-git')}, capture_output=True, text=True, timeout=120)
        check('F13 a crashed skills check stops the run (exit 4), --allow-stale or not', rc.returncode == 4 and 'check itself failed' in rc.stderr and not os.path.exists(os.path.join(ev2, 'judge')), (rc.returncode, rc.stderr))
        for leftover in ('results-f13.json', 'results-f13.md'):  # run.sh's report for the label, which a test must not leave
            if os.path.exists(os.path.join(CR, leftover)):
                os.remove(os.path.join(CR, leftover))
        os.environ.pop('NEW_SKILLS')
        # An arm arms.py made (council, nocouncil) is checked against its own folder, the one respond.sh hashed, not origin/main's.
        arm = os.path.join(ev2, 'arms', 'nocouncil', 'skills')
        shutil.copytree(sk, arm)
        ra = os.path.join(ev2, 'runs', 'nocouncil', 'haiku', 'b1-prairie-signal')
        os.makedirs(ra)
        open(os.path.join(ra, 'skills.sha'), 'w').write(skillhash.tree_hash(arm) + '\n')
        arm_stale = lambda: skillhash.stale(ev2, ['nocouncil'], ['haiku'], ['b1-prairie-signal'])
        check('F13 a run made with an arms.py arm as it is now is not stale', arm_stale() == [], arm_stale())
        open(os.path.join(arm, 'hildegard', 'SKILL.md'), 'w').write('three\n')
        check('F13 editing that arm after the run makes it stale', len(arm_stale()) == 1, arm_stale())
    # The sandbox hides the eval folder from every script, even when the caller names nothing to hide.
    if sandbox.mode() == 'bwrap':
        with tempfile.TemporaryDirectory() as ev3, tempfile.TemporaryDirectory() as rw:
            old = os.environ.get('EVAL_DIR')
            os.environ['EVAL_DIR'] = ev3
            argv = sandbox.wrap(['true'], rw)
            check('F3 wrap hides the eval folder by default', '--tmpfs' in argv and os.path.realpath(ev3) in argv, argv)
            if old is None:
                os.environ.pop('EVAL_DIR')
            else:
                os.environ['EVAL_DIR'] = old
    # the real ask: Read is scoped to the judge folder, and no other folder is added
    cmds = []
    real = subprocess.run
    judge.subprocess.run = lambda cmd, **kw: (cmds.append(cmd), subprocess.CompletedProcess(cmd, 0, '{"winner":"A","margin":"slight","why":"x"}', ''))[1]
    import importlib
    ask_real = importlib.reload(judge).ask
    judge.subprocess.run = lambda cmd, **kw: (cmds.append(cmd), subprocess.CompletedProcess(cmd, 0, '{"winner":"A","margin":"slight","why":"x"}', ''))[1]
    ask_real('p', '/x/y')
    judge.subprocess.run = real
    c = cmds[-1]
    allowed = c[c.index('--allowedTools') + 1]
    check('F9 Read is limited to the judge folder and --add-dir is not used', allowed != 'Read' and allowed.startswith('Read(') and '--add-dir' not in c, c)

# ---- F14: the eval folder is out of the script's reach ----------------------------------------------------------------
ev = tempfile.mkdtemp(prefix=f'{tag}-', dir='/var/tmp')  # not under $HOME, and /tmp is a tmpfs inside the sandbox anyway
saved = sa.E, sandbox._mode
try:
    assert not os.path.realpath(ev).startswith(os.path.realpath(home) + os.sep)
    sa.E = ev
    for sub in ('inputs', 'ref', 'runs/new/haiku/x'):
        os.makedirs(os.path.join(ev, sub, tid) if sub in ('inputs', 'ref') else os.path.join(ev, sub))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', os.path.join(ev, 'inputs', tid, 'in.wav')], check=True)
    shutil.copy(os.path.join(ev, 'inputs', tid, 'in.wav'), os.path.join(ev, 'ref', tid, 'clean.wav'))
    steal = script(os.path.join(ev, 'steal.sh'), f'cp {ev}/ref/{tid}/clean.wav out.wav 2>/dev/null\nls {ev}/ref {ev}/runs {ev}/inputs > seen.txt 2>&1\ncat seen.txt >&2\n')
    sandbox._mode = None
    if shutil.which('bwrap') and sandbox.mode() == 'bwrap':
        ok, secs, tmp, log, code = sa.run_script(tid, steal, 'out.wav')
        check('F14 a script cannot copy the clean reference, with EVAL_DIR outside $HOME', not os.path.exists(os.path.join(tmp, 'out.wav')), log)
        check('F14 the eval folder looks empty from inside', 'a1-podcast-clean' not in open(os.path.join(tmp, 'seen.txt')).read(), log)
        good = script(os.path.join(ev, 'good.sh'), 'f=$(ls *.wav | head -1)\nffmpeg -v error -y -i "$f" out.wav\n')
        check('F14 the inputs copied into the script folder still work', sa.run_script(tid, good, 'out.wav')[0])
        shutil.rmtree(tmp, ignore_errors=True)
    for m in ('fallback', 'none'):
        sandbox._mode = m
        try:
            sa.run_script(tid, steal, 'out.wav')
            check(f'F14 mode {m} cannot hide the folder, so the scorer refuses', False)
        except SystemExit as e:
            check(f'F14 mode {m} cannot hide the folder, so the scorer refuses', 'bubblewrap' in str(e), e)
finally:
    sa.E, sandbox._mode = saved
    shutil.rmtree(ev, ignore_errors=True)

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
