# SPDX-License-Identifier: AGPL-3.0-only
"""Blind pairwise judge: judge.py <label> [--base none] [--cand main] [--models haiku luna] [--tasks tasks.json ...]

For every (model, task) Claude Opus compares the two arms' deliverables in both orders without knowing which arm made
which: files are copied to a fresh folder as A.* and B.*, arm names never appear, and front matter is stripped from prose.
Design: the judge looks at the two rendered PNGs. Video: the plan text. Writing: the draft. Audio and video edit: the
objective metrics table, the script, and (video edit) a contact sheet of frames. Each verdict is cached as JSON, so a re-run
only judges what is missing.

A missing deliverable never goes to the judge: if only one arm produced one it wins automatically (auto: true), and if neither
did the verdict is a tie. "Produced one" means the responder finished (a `done` file and a meta.json with no error; a run that timed
out or died leaves partial files that are never scored or judged) and, for audio and video edit, the script ran and wrote its file.
Text deliverables have any skill path, skill name or reference file name replaced by "[reference]" in both arms before the judge sees them."""
import concurrent.futures as cf, glob, json, os, re, shutil, subprocess, sys, tempfile
import judge_media

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
FRONT = re.compile(r'\A﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\Z)')

RUBRIC = {
    'design': """You are a working graphic designer picking which design the client would be prouder to put out. Look at both images at the stated size and again as they would appear on a phone. Weigh, in this order:
1. Facts: every fact in the brief that a viewer needs is present and correct, and nothing is invented (a phone number, a price, a sponsor, a tagline claiming something). Invented facts and misspellings are serious faults.
2. Hierarchy and legibility: one clear thing to read first, the rest in order; type large enough and with enough contrast to read at thumbnail size; nothing clipped, overlapping or running off the canvas.
3. Typography, color and layout: a deliberate type pairing, a palette with a point of view, real composition with intent and space, not a centered stack of text on a gradient.
4. Fit to the client and occasion, and craft: does it feel made for this client (a Lutheran church, a hardware store, a bluegrass band) and not like a template or generic AI output (stock gradients, glossy blobs, clip-art, filler icons).""",
    'video': """You are a film director and an editor who works with text- and image-to-video models, choosing the plan you would rather shoot (generate) tomorrow. Weigh, in this order:
1. Completeness and arithmetic: concept, shot list with per-shot duration, camera and lens, full generation prompt and transition, an edit decision list whose timecodes add up to the stated length, and a sound plan. Missing parts or a total that does not add up are serious faults.
2. Prompt quality for the model: each shot prompt is self-contained (repeats the subject, setting, light), shows one clear action a model can render in about 5 seconds, is concrete and visual (not 'cinematic, stunning'), avoids things such models do badly (legible text, many hands, fast complex action, exact counts), and keeps the subject, palette and light consistent from shot to shot.
3. Cinematic specificity and pacing: real lens, camera and light choices with a reason, a shape (a beginning, a turn, an end with the ask), cuts that match motion, shots that vary in size.
4. Sound plan and fit to the client: music and sound with intent, a voice-over or on-screen text that carries the brief's facts correctly, honest to the brief. Invented facts (prices, awards, claims) are serious faults. Generic template plans lose.""",
    'audio': """You are a mix engineer reviewing two ffmpeg scripts and their measured results, choosing which you would rather ship. The objective table is measured from the script's actual output and is reliable; weigh it heavily, but also read the scripts: sensible filter choices for the problem, over-processing (pumping, underwater sound, gated words), fragility (hard-coded values that only fit one file, no error handling), and whether every part of the brief was done. A script that failed to produce a file loses to one that did.""",
    'writing': """You are the person who asked for this text, choosing which draft you would rather publish under your own name. Weigh, in this order:
1. Facts: anything stated that the brief does not support (an invented number, quote, claim, event, date, promise or detail) is a serious fault; so is leaving out a fact the reader needs or getting one wrong.
2. Does it read like a specific person wrote it to specific readers, or like generic AI content: stock phrases, filler openings and closings, dashes as a rhythm crutch, lists of three, hollow enthusiasm, a lecture tone.
3. Does it do the job the brief asks (the right length, the ask, the tone the writer wanted) using the brief's specifics well.
4. Line-level craft: plain, varied sentences, nothing that makes a reader's eyes slide.""",
    'videoedit': """You are an editor reviewing two ffmpeg scripts that cut the same four clips and their measured results, choosing which finished video you would rather put on the client's website. The objective table is measured from the script's actual output and is reliable; weigh it, then look at each contact sheet (twelve frames across the finished piece, the last near the end) for the title and closing card (legible, correctly spelled, placed well), whether the vertical clip is handled properly (not stretched), shot variety and pacing, and read each script for sensible structure. A script that failed to produce a video loses to one that did.""",
}
RUBRIC.update(judge_media.RUBRIC)
FILES = {'design': ('png',), 'video': ('md',), 'writing': ('md',), 'audio': ('sh',), 'videoedit': ('sh', 'png')}


def vals(a, k):
    """The words after option k up to the next option."""
    if k not in a:
        return []
    out = []
    for x in a[a.index(k) + 1:]:
        if x.startswith('--'):
            break
        out.append(x)
    return out


def run_dir(arm, model, task):
    return os.path.join(E, 'runs', arm, model, task['id'])


def load_score(arm, model, task):
    p = os.path.join(run_dir(arm, model, task), 'score.json')
    return json.load(open(p)) if os.path.exists(p) else {}


def finished(arm, model, task):
    rd = run_dir(arm, model, task)
    try:
        meta = json.load(open(os.path.join(rd, 'meta.json')))
    except (OSError, ValueError):
        return False
    return os.path.exists(os.path.join(rd, 'done')) and not meta.get('error') and not meta.get('is_error')


def available(arm, model, task):
    if not finished(arm, model, task):
        return False
    s, d = load_score(arm, model, task), task['domain']
    if d in judge_media.DOMAINS:
        return judge_media.available(s, d)
    if d == 'design':
        return bool(s.get('rendered')) and not s.get('blank')
    if d == 'video':
        return s.get('words', 0) >= 80
    if d == 'writing':
        return s.get('words', 0) >= 20
    return bool(s.get('ran')) and not s.get('score_error')


def body(path):
    return FRONT.sub('', open(path, encoding='utf-8', errors='replace').read()).strip()


def metrics_table(sa, sb, domain):
    keys = ['ran', 'dur', 'channels', 'lufs', 'tp', 'clip_count', 'lufs_err', 'len_diff_s', 'speech_out_db', 'pause_gap_in_db', 'pause_gap_out_db',
            'hum_prom_in_db', 'hum_prom_out_db', 'rumble_rel_in_db', 'rumble_rel_out_db', 'dip_gap_in_db', 'dip_gap_out_db', 'pop_rel_in_db',
            'pop_rel_out_db', 'fidelity_in', 'fidelity_out', 'voice_at', 'duck_db', 'vmr_db', 'voice_fidelity', 'end_peak_db', 'sting_at', 'order_ok',
            'size', 'fps', 'vcodec', 'acodec', 'scene_changes', 'black_segments', 'clips_used_estimate', 'seconds']
    rows = ['| metric | A | B |', '| --- | --- | --- |']
    for k in keys:
        if k in sa or k in sb:
            rows.append(f'| {k} | {sa.get(k, "-")} | {sb.get(k, "-")} |')
    for k in sorted(set(sa.get('checks', {})) | set(sb.get('checks', {}))):
        f = lambda s: ('pass' if s['checks'][k] else 'FAIL') if k in s.get('checks', {}) else '-'
        rows.append(f'| check: {k} | {f(sa)} | {f(sb)} |')
    rows.append(f"| checks passed | {sa.get('passed', 0)}/{sa.get('total', 0)} | {sb.get('passed', 0)}/{sb.get('total', 0)} |")
    return '\n'.join(rows)


def ask(prompt, cwd):
    # Read is limited to the judge's own folder (a bare `Read` reads anywhere the owner can, checked live), and --add-dir is not used.
    env = {k: v for k, v in os.environ.items() if k not in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY')}
    for _ in range(2):
        r = subprocess.run(['claude', '-p', '--model', 'opus', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                            '--no-session-persistence', '--tools', 'Read', '--allowedTools', 'Read(./**)'],
                           input=prompt, capture_output=True, text=True, cwd=cwd, env=env, timeout=900)
        out = r.stdout.strip()
        if re.search(r'usage limit|quota|billing|credit balance', out + r.stderr, re.I) and 'winner' not in out:
            raise SystemExit('quota or billing message from the judge; stopping')
        try:
            d, _ = json.JSONDecoder().raw_decode(out[out.find('{'):])
            if d.get('winner') in ('A', 'B'):
                return d
        except ValueError:
            pass
    raise SystemExit(f'the judge gave no verdict twice in {cwd}')


LEAKS = re.compile(r'hildegard-creative-eval|/runs/(?:none|main|new)\b|\border[01]\.json|\bskills-main\b|\.agents/skills|/plug/skills|\bskills/hildegard|SKILL\.md', re.I)
PATHREF = re.compile(r"[^\s'\"`()<>\[\]]*(?:\.agents/skills|/plug/skills|\bskills/hildegard|SKILL\.md|skills-main)[^\s'\"`()<>\[\]]*", re.I)


def skill_words():
    """One regex for the names of every skill folder (the hyphenated ones; bare "hildegard" is also a saint) and one for every
    reference file name, from this checkout, $NEW_SKILLS and each archived main."""
    names, files = set(), set()
    roots = [os.path.join(REPO, 'skills'), os.environ.get('NEW_SKILLS', '')] + sorted(glob.glob(os.path.join(E, 'skills-main-*', 'skills')))
    for root in filter(os.path.isdir, roots):
        for dp, dn, fn in os.walk(root):
            names.update(d for d in dn if d.startswith('hildegard-'))
            if os.sep + 'references' in dp:
                files.update(f for f in fn if re.search(r'[-_]', f))
    rx = lambda ws, pre='': re.compile(pre + '(?:' + '|'.join(re.escape(w) for w in sorted(ws, key=len, reverse=True)) + r')\b', re.I) if ws else None
    return rx(names, r'\b'), rx(files, r'(?<![\w-])')


def redact(text):
    """Replace anything that points at a skill with "[reference]": a path into the skills, a skill name, a reference file name."""
    text = PATHREF.sub('[reference]', text)
    for rx in skill_words():
        text = rx.sub('[reference]', text) if rx else text
    return text


def scan(w, arms):
    """Refuse to call the judge unless the folder holds only A and B files, no file name names an arm, and nothing in them points
    into the eval tree (the run, order and skills folders) or names a skill path, skill or reference file (redact() takes those out
    first, so this catches a gap in it). A bare word like "new" in prose is not a leak and is not checked."""
    for f in sorted(os.listdir(w)):
        if not re.fullmatch(r'[AB](-frames|-spectrogram|-script|-source)?\.(md|png|sh|jpg|txt)|(before|reference)\.jpg', f):
            raise SystemExit(f'leak: {f} does not belong in the judge folder')
        if any(a in f.lower() for a in arms):
            raise SystemExit(f'leak: file name {f} names an arm')
        if not f.endswith(('.png', '.jpg')):
            text = open(os.path.join(w, f), errors='replace').read()
            m = LEAKS.search(text) or next((m for m in (rx.search(text) for rx in skill_words() if rx) if m), None)
            if m:
                raise SystemExit(f'leak: {f} contains {m.group(0)!r}, which points into the eval tree or the skills')


def judge(job):
    label, model, task, order, base, cand = job
    out = os.path.join(E, 'judge', label, model, task['id'], f'order{order}.json')
    if os.path.exists(out):
        return json.load(open(out))
    a_arm, b_arm = (base, cand) if order == 0 else (cand, base)
    ok = {a: available(a, model, task) for a in (a_arm, b_arm)}
    rec = {'model': model, 'task': task['id'], 'domain': task['domain'], 'order': order, 'A': a_arm, 'B': b_arm}
    if not ok[a_arm] or not ok[b_arm]:
        win = a_arm if ok[a_arm] else b_arm if ok[b_arm] else 'tie'
        rec.update(winner=win, margin='clear' if win != 'tie' else '', auto=True, why='no usable deliverable from ' + ('either arm' if win == 'tie' else (b_arm if win == a_arm else a_arm)),
                   invented={}, unfinished=[a for a in (a_arm, b_arm) if not finished(a, model, task)])
    else:
        # A fresh folder outside the eval tree holding only the neutralized deliverables; the verdict is written elsewhere.
        w = tempfile.mkdtemp(prefix='creative-judge-')
        if os.path.abspath(w).startswith(os.path.abspath(E) + os.sep):
            raise SystemExit(f'the temp folder {w} is inside the eval tree; set TMPDIR elsewhere')
        d = task['domain']
        extra = ''
        if d in judge_media.DOMAINS:
            judge_media.stage_shared(w, task, E)
        for tag, arm in (('A', a_arm), ('B', b_arm)):
            rd = run_dir(arm, model, task)
            if d in judge_media.DOMAINS:
                judge_media.stage(w, tag, rd, task, E)
                for f in glob.glob(os.path.join(w, f'{tag}-s*.txt')):  # the arm's script or source: no skill path, name or reference file in it
                    open(f, 'w').write(redact(open(f, errors='replace').read()))
            elif d == 'design':
                shutil.copy(os.path.join(rd, 'design.png'), os.path.join(w, f'{tag}.png'))
            elif d in ('video', 'writing'):
                open(os.path.join(w, f'{tag}.md'), 'w').write(redact(body(os.path.join(rd, 'work', task.get('deliverable') or ('plan.md' if d == 'video' else 'draft.md')))))
            else:
                open(os.path.join(w, f'{tag}.sh'), 'w').write(redact(open(os.path.join(rd, 'work', task.get('deliverable') or ('edit.sh' if d == 'videoedit' else 'process.sh')), errors='replace').read()))
                if d == 'videoedit' and os.path.exists(os.path.join(rd, 'sheet.png')):
                    shutil.copy(os.path.join(rd, 'sheet.png'), os.path.join(w, f'{tag}-frames.png'))
        if d in judge_media.DOMAINS:
            extra = judge_media.extra(task, load_score(a_arm, model, task), load_score(b_arm, model, task))
        elif d == 'design':
            extra = f"Read the two images A.png and B.png in the current folder (both rendered at {task['size'][0]} x {task['size'][1]} px)."
        elif d in ('video', 'writing'):
            extra = f"Read A.md and B.md in the current folder."
        else:
            extra = 'Read A.sh and B.sh in the current folder' + (', and look at A-frames.png and B-frames.png' if d == 'videoedit' else '') + '.\n\nMEASURED RESULTS (each script was run on a fresh copy of the inputs with no network):\n' + metrics_table(load_score(a_arm, model, task), load_score(b_arm, model, task), d)
        inv = '' if d in ('audio', 'videoedit') or (d in judge_media.DOMAINS and d not in judge_media.INVENTS) else ', "invented_A": [strings], "invented_B": [strings]'
        prompt = f"""You are judging two deliverables made for the same client brief. You do not know how either was made, and the labels A and B carry no information.

CLIENT BRIEF:
{task['brief']}

{extra}

{RUBRIC[d]}

Reply with only JSON: {{"winner": "A" or "B", "margin": "slight" or "clear", "why": "two or three sentences naming the decisive differences"{inv}}}"""
        try:
            scan(w, (a_arm, b_arm))
            v = ask(prompt, w)
        finally:
            shutil.rmtree(w, ignore_errors=True)
        arm = {'A': a_arm, 'B': b_arm}
        rec.update(winner=arm[v['winner']], margin=v.get('margin', ''), auto=False, why=v.get('why', ''),
                   invented={a_arm: v.get('invented_A', []), b_arm: v.get('invented_B', [])})
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(rec, open(out, 'w'), indent=1)
    return rec


if __name__ == '__main__':
    a = sys.argv[1:]
    label = a[0]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    base, cand = opt('--base', 'none'), opt('--cand', 'main')
    models = vals(a, '--models') or ['haiku', 'luna']
    paths = vals(a, '--tasks') or [os.path.join(HERE, 'tasks.json')]
    only = opt('--only', None)
    tasks = [t for p in paths for t in json.load(open(p)) if not only or t['id'] in only.split(',')]
    jobs = [(label, m, t, o, base, cand) for m in models for t in tasks for o in (0, 1)]
    with cf.ThreadPoolExecutor(int(os.environ.get('JUDGE_WORKERS', '4'))) as ex:
        for r in ex.map(judge, jobs):
            print(r['model'], r['task'], 'order', r['order'], '->', r['winner'], r['margin'], '(auto)' if r['auto'] else '')
