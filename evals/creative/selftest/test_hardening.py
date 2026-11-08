# SPDX-License-Identifier: AGPL-3.0-only
"""Checks on the eval's own safety and bookkeeping: python3 evals/creative/selftest/test_hardening.py
No model is called: respond.sh runs against a fake `claude`, and the judge's `ask` is replaced. Needs the inputs from make_audio.py.

  F1  responder scripts run sandboxed: no write to the real home or outside the task folder, no network, no new privileges
  F2  a finished run is reused only while the skills it used are unchanged, and a Haiku run only when meta.json says it ran confined
  F3  skill loads are found when the path ends in `;` or the command is chained
  F4  a responder that dies leaves meta.json with the error and no `done`
  F5  model HTML renders with a throwaway profile and HOME, and its requests to anything but Google Fonts go nowhere
  F8  a quota message halts the dispatch of every later job
  F9  the judge works in a fresh folder outside the eval tree holding only A.* and B.*, and a leak scan guards it
  F10 a run with no `done` (the responder timed out or died) is never scored or judged; it is an automatic loss
  F11 skill paths, skill names and reference file names in a deliverable are redacted in both arms, and the leak scan fails on one that is left
  F12 Haiku's session runs confined (sandbox.responder): a stand-in for claude cannot delete or write a file in its home, outside
      its work folder or in another run, cannot see other runs, can write in its work folder; with no bubblewrap the run is refused;
      with neither CLAUDE_CODE_OAUTH_TOKEN nor HILDEGARD_EVAL_ALLOW_CREDENTIALS=1 the run is refused (exit 5) and calls no model;
      under the opt-in the owner's credentials file is bound read-only (writing or replacing it fails, the host file is unchanged); the
      claude binary is bound as that one file, and an override that is a folder or a file directly in the home folder is refused;
      Chromium's folder is bound only when it holds nothing else of the owner's; with CLAUDE_CODE_OAUTH_TOKEN set the box gets the token
      (never in argv) and no credentials file; a sign-in failure exits 99 and leaves STOP; a link left in work/, one hidden by
      `chmod 0111 .` or in a 0311 folder, and a FIFO each fail the run with no `done`
  F13 --judge-only refuses runs made with other skills than the arm's skills now, or with no recorded hash
  F14 the eval folder (clean references, inputs, other runs) is not readable from the sandbox, wherever EVAL_DIR is; without bubblewrap the scorer refuses
  F15 a verdict is reused only while both runs it judged are unchanged: a run made again is judged again"""
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
# respond.sh runs it inside the responder box (sandbox.responder), which clears the environment and hides the owner's home and
# the eval folder, so the fake picks its mode from its task folder and counts each call over a localhost connection.
calls_lst = Listener()
with tempfile.TemporaryDirectory() as root:
    bindir, ev = os.path.join(root, 'bin'), os.path.join(root, 'eval')
    skills = os.path.join(root, 'newsk', 'skills')
    os.makedirs(bindir)
    os.makedirs(os.path.join(skills, 'hildegard'))
    open(os.path.join(skills, 'hildegard', 'SKILL.md'), 'w').write('one\n')
    t1, t2, t3, t4 = 'd1-fall-festival', 'd2-bluegrass-cover', 'd3-hardware-anniversary', 'w1-congregation-email'
    # F12's stand-in: a scratch home with a file in it, a folder outside both, and another run's files in the eval folder
    shome, outside = os.path.join(root, 'home'), os.path.join(root, 'outside')
    other = os.path.join(ev, 'runs', 'none', 'haiku', t1)
    for p in (shome, outside, os.path.join(other, 'work')):
        os.makedirs(p)
    for p in (os.path.join(shome, 'keep.txt'), os.path.join(outside, 'keep.txt'), os.path.join(other, 'work', 'draft.md')):
        open(p, 'w').write('original\n')
    # a stand-in for the owner's credentials file, in the CLAUDE_CONFIG_DIR the box reads it from
    cfg = os.path.join(root, 'cfg')
    creds = os.path.join(cfg, '.credentials.json')
    os.makedirs(cfg)
    open(creds, 'w').write('{"selftest": "original"}\n')
    fake = os.path.join(bindir, 'claude')
    open(fake, 'w').write(f'''#!/bin/bash
exec 3<>/dev/tcp/127.0.0.1/{calls_lst.port} && read -t 5 -u 3 _; exec 3<&-
cat > /dev/null
case $PWD in
  */{t2}/work) echo "Segmentation fault" >&2; exit 139 ;;
  */{t3}/work) echo '{{"type":"result","result":"You have hit your usage limit","is_error":true}}'; exit 0 ;;
  */w3-5k-page/work) {{ [ "${{CLAUDE_CODE_OAUTH_TOKEN:-}}" = selftest-token ] && echo token=yes || echo token=no
                       [ -e "$CLAUDE_CONFIG_DIR/.credentials.json" ] && echo creds=BOUND || echo creds=none; }} > report.txt ;;
  */w4-cabinetmaker-bio/work) echo '{{"type":"result","result":"Failed to authenticate. API Error: 401 authentication_error: OAuth token has expired.","is_error":true}}'; exit 1 ;;
  */w5-greenhouse-email/work) ln -s "$HOME/keep.txt" draft.md ;;
  */v6-memorial-film/work) ln -s "$HOME/keep.txt" draft.md; chmod 0111 . ;;
  */v7-ramen-winter/work) mkdir sub && ln -s "$HOME/keep.txt" sub/draft.md && chmod 0311 sub ;;
  */v8-pool-lifeguards/work) mkfifo draft.md ;;
  */{t4}/work)
    {{ [ -e "$HOME/keep.txt" ] && rm -f "$HOME/keep.txt" 2>/dev/null && [ ! -e "$HOME/keep.txt" ] && echo home_rm=DELETED || echo home_rm=blocked
       echo bad > "$HOME/keep.txt" 2>/dev/null; echo bad > "$HOME/new.txt" 2>/dev/null
       rm -f {outside}/keep.txt 2>/dev/null; echo bad > {outside}/new.txt 2>/dev/null
       echo bad > {ev}/planted 2>/dev/null; echo bad > /var/tmp/{tag} 2>/dev/null
       rm -rf {other} 2>/dev/null; echo bad > {other}/work/draft.md 2>/dev/null
       cat {other}/work/draft.md >/dev/null 2>&1 && echo other_run=READ || echo other_run=hidden
       echo "runs=$(ls {ev}/runs/*/* 2>/dev/null | tr '\\n' ,)"
       echo made > made.txt && echo work=wrote || echo work=blocked
       ls /home/*/.ssh >/dev/null 2>&1 && echo ssh=VISIBLE
       env | grep -q ANTHROPIC_API_KEY && echo key=PRESENT
       c="$CLAUDE_CONFIG_DIR/.credentials.json"
       grep -q original "$c" 2>/dev/null && echo creds_read=yes || echo creds_read=no
       echo bad > "$c" 2>/dev/null && echo creds_write=WROTE || echo creds_write=blocked
       : > "$c" 2>/dev/null && echo creds_truncate=WROTE || echo creds_truncate=blocked
       echo '{{}}' > /tmp/c.json && mv -f /tmp/c.json "$c" 2>/dev/null && echo creds_mv=REPLACED || echo creds_mv=blocked
       rm -f "$c" 2>/dev/null; [ -e "$c" ] && echo creds_rm=blocked || echo creds_rm=DELETED
    }} > report.txt ;;
esac
echo '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"made it"}}]}}}}'
echo '{{"type":"result","result":"made it","is_error":false}}'
''')
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    env = {**os.environ, 'PATH': bindir + ':' + os.environ['PATH'], 'EVAL_DIR': ev, 'NEW_SKILLS': skills, 'HILDEGARD_EVAL_CLAUDE': fake,
           'CLAUDE_CONFIG_DIR': cfg, 'HILDEGARD_EVAL_ALLOW_CREDENTIALS': '1'}
    env.pop('ANTHROPIC_API_KEY', None)
    env.pop('CLAUDE_CODE_OAUTH_TOKEN', None)

    def respond(task, **over):
        return subprocess.run(['bash', os.path.join(CR, 'respond.sh'), 'new', 'haiku', task], env={**env, **over}, capture_output=True, text=True, timeout=120)

    def calls():
        return calls_lst.hits

    run = lambda task: os.path.join(ev, 'runs', 'new', 'haiku', task)

    def text(p):
        try:
            return open(p).read()
        except OSError:
            return None

    # F12: the stand-in deletes and writes outside its work folder and looks for other runs
    r = respond(t4, HOME=shome, ANTHROPIC_API_KEY='sk-ant-selftest')
    rp = os.path.join(run(t4), 'work', 'report.txt')
    rep = dict(l.split('=', 1) for l in open(rp).read().split()) if os.path.exists(rp) else {}
    check('F12 the stand-in responder ran and finished', r.returncode == 0 and calls() == 1 and os.path.exists(os.path.join(run(t4), 'done')), (r.returncode, r.stderr, rep))
    check('F12 deleting or overwriting a file in the home folder fails', text(os.path.join(shome, 'keep.txt')) == 'original\n' and rep.get('home_rm') == 'blocked', rep)
    check('F12 a new file in the home folder never lands', not os.path.exists(os.path.join(shome, 'new.txt')))
    check('F12 deleting or writing a file outside home and work fails', text(os.path.join(outside, 'keep.txt')) == 'original\n'
          and not os.path.exists(os.path.join(outside, 'new.txt')) and not os.path.exists(f'/var/tmp/{tag}'))
    if os.path.exists(f'/var/tmp/{tag}'):
        os.remove(f'/var/tmp/{tag}')
    check('F12 another run in the eval folder is hidden and untouched', rep.get('other_run') == 'hidden' and rep.get('runs', '').strip(',') in ('', t4), rep)
    check('F12 another run\'s files are still there, and nothing was planted in the eval folder',
          text(os.path.join(other, 'work', 'draft.md')) == 'original\n' and not os.path.exists(os.path.join(ev, 'planted')))
    check('F12 writing in the work folder works', rep.get('work') == 'wrote' and text(os.path.join(run(t4), 'work', 'made.txt')) == 'made\n', rep)
    check('F12 the real ~/.ssh is not visible and the API key is not passed in', 'ssh' not in rep and 'key' not in rep, rep)
    check('F12 under HILDEGARD_EVAL_ALLOW_CREDENTIALS=1 the credentials file can be read in the box', rep.get('creds_read') == 'yes', rep)
    check('F12 writing, truncating, replacing or deleting the credentials file fails in the box',
          all(rep.get(k) == 'blocked' for k in ('creds_write', 'creds_truncate', 'creds_mv', 'creds_rm')), rep)
    check('F12 the owner\'s credentials file is unchanged', text(creds) == '{"selftest": "original"}\n', text(creds))
    # without a working bubblewrap the session is refused, and no model is called
    nobw = os.path.join(root, 'nobwrap')
    os.makedirs(nobw)
    script(os.path.join(nobw, 'bwrap'), 'exit 1\n')
    before = calls()
    r = respond(t1, PATH=nobw + ':' + env['PATH'])
    check('F12 with no usable bubblewrap a Haiku run is refused (exit 5) and calls no model', r.returncode == 5 and calls() == before and 'bubblewrap' in r.stderr
          and not os.path.exists(os.path.join(run(t1), 'done')), (r.returncode, calls(), before, r.stderr))
    # with no CLAUDE_CODE_OAUTH_TOKEN and no opt-in a refresh in the box could sign the owner out, so the run is refused before any model call
    r = respond(t1, HILDEGARD_EVAL_ALLOW_CREDENTIALS='')
    check('F12 with no CLAUDE_CODE_OAUTH_TOKEN and no HILDEGARD_EVAL_ALLOW_CREDENTIALS=1 a Haiku run is refused (exit 5), calls no model and names claude setup-token',
          r.returncode == 5 and calls() == before and 'claude setup-token' in r.stderr and 'CLAUDE_CODE_OAUTH_TOKEN' in r.stderr
          and not os.path.exists(os.path.join(run(t1), 'transcript.jsonl')) and not os.path.exists(os.path.join(run(t1), 'done')), (r.returncode, calls(), before, r.stderr))
    # an override that would bind more than the binary file is refused, and no model is called
    shutil.copy(fake, os.path.join(shome, 'claude'))
    r = respond(t1, HOME=shome, HILDEGARD_EVAL_CLAUDE=os.path.join(shome, 'claude'))
    check('F12 HILDEGARD_EVAL_CLAUDE directly in the home folder is refused (exit 5) and calls no model', r.returncode == 5 and calls() == before
          and 'home folder' in r.stderr and not os.path.exists(os.path.join(run(t1), 'done')), (r.returncode, r.stderr))
    r = respond(t1, HILDEGARD_EVAL_CLAUDE=bindir)
    check('F12 HILDEGARD_EVAL_CLAUDE naming a folder is refused (exit 5) and calls no model', r.returncode == 5 and calls() == before
          and 'not a file' in r.stderr, (r.returncode, r.stderr))
    os.remove(os.path.join(shome, 'claude'))
    # a native claude found on PATH directly in the home folder: only that file is bound, nothing else of the home is visible
    eh = os.path.join(root, 'elfhome')
    erun = os.path.join(ev, 'runs', 'none', 'haiku', 'w2-groomer-blog')
    os.makedirs(os.path.join(erun, 'work'))
    os.makedirs(os.path.join(eh, '.ssh'))
    open(os.path.join(eh, 'keep.txt'), 'w').write('original\n')
    shutil.copy(shutil.which('ls'), os.path.join(eh, 'claude'))
    eenv = {k: v for k, v in env.items() if k not in ('HILDEGARD_EVAL_CLAUDE', 'HILDEGARD_EVAL_CHROMIUM', 'CLAUDE_CONFIG_DIR')}
    eenv.update(HOME=eh, PATH=eh + ':/usr/bin:/bin')

    def box(**over):
        b = subprocess.run([sys.executable, os.path.join(CR, 'sandbox.py'), 'responder', erun, ev], env={**eenv, **over}, capture_output=True, text=True, timeout=60)
        return b, [x for x in b.stdout.split('\0') if x]

    b, argv = box()
    srcs = [argv[i + 1] for i, x in enumerate(argv) if x in ('--bind', '--ro-bind')]
    check('F12 a native claude at $HOME/claude binds that one file and nothing else in the home folder',
          b.returncode == 0 and [p for p in srcs if p.startswith(eh)] == [os.path.join(eh, 'claude')], (b.returncode, b.stderr, srcs))
    seen = subprocess.run(argv + ['-A', eh], capture_output=True, text=True, timeout=60) if b.returncode == 0 else None
    check('F12 inside the box the home folder shows only the claude binary', seen is not None and seen.stdout.split() == ['claude'],
          (seen.returncode, seen.stdout, seen.stderr) if seen else b.stderr)
    # Chromium: a binary directly in the home folder is refused; a Playwright browser folder is bound, and only that folder
    shutil.copy(shutil.which('ls'), os.path.join(eh, 'chrome'))
    b, _ = box(HILDEGARD_EVAL_CHROMIUM=os.path.join(eh, 'chrome'))
    check('F12 a Chromium directly in the home folder is refused', b.returncode != 0 and 'Chromium' in b.stderr, (b.returncode, b.stderr))
    cdir = os.path.join(eh, '.cache', 'ms-playwright', 'chromium-1', 'chrome-linux64')
    os.makedirs(cdir)
    shutil.copy(shutil.which('ls'), os.path.join(cdir, 'chrome'))
    b, argv = box()
    srcs = [argv[i + 1] for i, x in enumerate(argv) if x in ('--bind', '--ro-bind')]
    check('F12 Playwright\'s Chromium binds its own folder and nothing else in the home folder',
          b.returncode == 0 and sorted(p for p in srcs if p.startswith(eh)) == sorted([os.path.join(eh, 'claude'), cdir]), (b.returncode, b.stderr, srcs))
    # a long-lived CLAUDE_CODE_OAUTH_TOKEN goes into the box through a pipe, and the credentials file is not bound
    sb = lambda **o: [x for x in subprocess.run([sys.executable, os.path.join(CR, 'sandbox.py'), 'responder', run('w3-5k-page'), ev], env={**env, **o},
                                                capture_output=True, text=True, timeout=60).stdout.split('\0') if x]
    plain, withtok = sb(), sb(CLAUDE_CODE_OAUTH_TOKEN='selftest-token')
    ci = [i for i, x in enumerate(plain) if x == creds]
    check('F12 HILDEGARD_EVAL_ALLOW_CREDENTIALS=1 binds the credentials file read-only', len(ci) == 1 and plain[ci[0] - 1] == '--ro-bind'
          and plain[ci[0] + 1].endswith('/.credentials.json'), plain)
    check('F12 sandbox.py prints no box with neither the token nor the opt-in', sb(HILDEGARD_EVAL_ALLOW_CREDENTIALS='') == [])
    check('F12 with CLAUDE_CODE_OAUTH_TOKEN set no credentials file is bound and the token is not in the argv',
          any(creds in x for x in plain) and withtok and not any('.credentials.json' in x or 'selftest-token' in x for x in withtok), withtok)
    r = respond('w3-5k-page', HOME=shome, CLAUDE_CODE_OAUTH_TOKEN='selftest-token')
    rp = os.path.join(run('w3-5k-page'), 'work', 'report.txt')
    rep = dict(l.split('=', 1) for l in open(rp).read().split()) if os.path.exists(rp) else {}
    check('F12 with CLAUDE_CODE_OAUTH_TOKEN set the box gets the token and no credentials file', r.returncode == 0 and rep == {'token': 'yes', 'creds': 'none'},
          (r.returncode, r.stderr, rep))
    # a sign-in or token-refresh failure stops the batch like a quota message
    r = respond('w4-cabinetmaker-bio')
    stop = os.path.join(run('w4-cabinetmaker-bio'), 'STOP')
    check('F12 a sign-in failure in the session exits 99 and leaves STOP', r.returncode == 99 and os.path.exists(stop) and '/login' in r.stderr, (r.returncode, r.stderr))
    if os.path.exists(stop):
        os.remove(stop)
    # a link the model leaves in work/ is never followed on the host: no `done`, the error in meta.json
    r = respond('w5-greenhouse-email', HOME=shome)
    lr = run('w5-greenhouse-email')
    m = json.load(open(os.path.join(lr, 'meta.json'))) if os.path.exists(os.path.join(lr, 'meta.json')) else {}
    check('F12 a symbolic link left in work/ fails the run with no done and the error in meta.json', r.returncode == 6 and not os.path.exists(os.path.join(lr, 'done'))
          and 'symbolic links' in (m.get('error') or '') and 'original' not in json.dumps(m) + (text(os.path.join(lr, 'final.txt')) or ''), (r.returncode, r.stderr, m))
    # the model owns work/, so it can hide a link from the scan by making a folder unreadable, or leave a FIFO that hangs whatever opens it
    for task, what, name in (('v6-memorial-film', 'a link hidden behind `chmod 0111 .`', './draft.md'),
                             ('v7-ramen-winter', 'a link in a 0311 subfolder', './sub/draft.md'),
                             ('v8-pool-lifeguards', 'a FIFO named draft.md', './draft.md')):
        r = respond(task, HOME=shome)
        lr = run(task)
        m = json.load(open(os.path.join(lr, 'meta.json'))) if os.path.exists(os.path.join(lr, 'meta.json')) else {}
        check(f'F12 {what} in work/ fails the run (exit 6) with no done, names it in meta.json, and nothing on the host read it',
              r.returncode == 6 and not os.path.exists(os.path.join(lr, 'done')) and name in (m.get('error') or '')
              and 'original' not in json.dumps(m) + r.stderr + (text(os.path.join(lr, 'final.txt')) or ''), (r.returncode, r.stderr, m))
    calls_lst.hits = 0

    # F2: a fresh eval folder still gets main's skills (mktemp needs the folder to exist)
    fresh = os.path.join(root, 'fresh')
    fr = os.path.join(fresh, 'runs', 'main', 'haiku', t1)
    r = subprocess.run(['bash', os.path.join(CR, 'respond.sh'), 'main', 'haiku', t1], env={**env, 'EVAL_DIR': fresh}, capture_output=True, text=True, timeout=120)
    empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    check('F2 the main arm in a fresh eval folder runs with main\'s skills', r.returncode == 0 and os.path.isfile(os.path.join(fr, 'plug', 'skills', 'hildegard', 'SKILL.md'))
          and (text(os.path.join(fr, 'skills.sha')) or empty).strip() != empty, (r.returncode, r.stderr))
    calls_lst.hits = 0

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
    # a Haiku run made before the box (no `confined` in meta.json) is made again, never reused
    check('F2 a Haiku run made in the box says confined: true in meta.json', meta2.get('confined') is True, meta2)
    old = {k: v for k, v in meta2.items() if k != 'confined'}
    json.dump(old, open(os.path.join(run(t1), 'meta.json'), 'w'))
    before = calls()
    r = respond(t1)
    meta3 = json.load(open(os.path.join(run(t1), 'meta.json')))
    check('F2 a finished Haiku run without the confined marker is made again, in the box', r.returncode == 0 and calls() == before + 1
          and meta3.get('confined') is True, (calls(), before, meta3.get('confined')))
    json.dump({**meta3, 'confined': False}, open(os.path.join(run(t1), 'meta.json'), 'w'))
    respond(t1)
    check('F2 a run marked confined: false is made again too', calls() == before + 2, (calls(), before))
    respond(t1)
    check('F2 a confined run with the same skills is still reused', calls() == before + 2, (calls(), before))

    # F4
    r = respond(t2)
    mp = os.path.join(run(t2), 'meta.json')
    m = json.load(open(mp)) if os.path.exists(mp) else {}
    check('F4 a responder that dies is not marked done and exits non-zero', r.returncode != 0 and r.returncode != 99 and not os.path.exists(os.path.join(run(t2), 'done')), (r.returncode, r.stderr))
    check('F4 meta.json is written with the error', m.get('is_error') is True and bool(m.get('error')), m)

    # F8
    before = calls()
    r = respond(t3)
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
calls_lst.s.close()

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

    # F15: the main arm's run is made again with other skills; the old verdict must not come back
    judge.ask = spy
    shutil.rmtree(os.path.join(ev, 'judge'), ignore_errors=True)
    seen.clear()
    rdm = os.path.join(ev, 'runs', 'main', 'haiku', task['id'])
    open(os.path.join(rdm, 'work', 'draft.md'), 'w').write('The bake sale is on Saturday at nine, in the church hall, and every pie is five dollars, come early.')
    open(os.path.join(rdm, 'skills.sha'), 'w').write('aaa\n')
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F15 an unchanged pair is judged once', len(seen) == 1, len(seen))
    open(os.path.join(rdm, 'skills.sha'), 'w').write('bbb\n')
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F15 the same answer from other skills is judged again', len(seen) == 2, len(seen))
    open(os.path.join(rdm, 'work', 'draft.md'), 'w').write('Pies are five dollars at the church hall on Saturday at nine, and the bake sale runs until noon, come early.')
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F15 a different answer from the same skills is judged again', len(seen) == 3, len(seen))
    old = os.path.join(ev, 'judge', 'lbl6', 'haiku', task['id'], 'order0.json')
    rec = json.load(open(old))
    rec.pop('fingerprint')
    json.dump(rec, open(old, 'w'))
    judge.judge(('lbl6', 'haiku', task, 0, 'none', 'main'))
    check('F15 a verdict saved without a fingerprint is judged again', len(seen) == 4, len(seen))

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
