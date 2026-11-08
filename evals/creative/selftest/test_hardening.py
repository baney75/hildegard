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
  F11 skill paths, skill names and reference file names in a deliverable are redacted in both arms, and the leak scan fails on one that is left"""
import json, os, shutil, socket, stat, subprocess, sys, tempfile, threading
HERE = os.path.dirname(os.path.abspath(__file__))
CR = os.path.dirname(HERE)
sys.path.insert(0, CR)
import score_audio as sa
import score
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
    env = {**os.environ, 'PATH': bindir + ':' + os.environ['PATH'], 'EVAL_DIR': ev, 'NEW_SKILLS': skills}
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
    # the media domains stage other file names; the scan lets them through and still catches a skill path in an arm's script
    left = tempfile.mkdtemp()
    for n in ('A.jpg', 'B.jpg', 'before.jpg', 'reference.jpg', 'A-script.txt', 'B-source.txt', 'A-spectrogram.png', 'B-frames.png'):
        open(os.path.join(left, n), 'w').write('x = 1\n')
    try:
        judge.scan(left, ('none', 'main'))
        check('F11 the leak scan accepts the files a media task stages', True)
    except SystemExit as e:
        check('F11 the leak scan accepts the files a media task stages', False, e)
    open(os.path.join(left, 'A-script.txt'), 'w').write('# read skills/hildegard-art/SKILL.md')
    try:
        judge.scan(left, ('none', 'main'))
        check('F11 the leak scan fails on a skill path in a media script', False)
    except SystemExit as e:
        check('F11 the leak scan fails on a skill path in a media script', 'leak' in str(e), e)
    check('F11 a media script has its skill path redacted', '[reference]' in judge.redact('# read skills/hildegard-art/SKILL.md'))
    shutil.rmtree(left)
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

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
