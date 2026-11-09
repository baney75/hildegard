# SPDX-License-Identifier: AGPL-3.0-only
"""Score hildegard-photo-edit's scripts with the creative eval's own photo scorer, on private dev photos and the tuned photo tasks.

  python3 photo_dev.py [--set dev|tuned|both] [--arm tools|naive] [--only id,id] [--json out.json]

Needs the media eval (score_media.py, make_media.py, imglib.py, tasks-media.json) in this folder. It never reads heldout-media.json
and refuses any task file with `heldout` in its name: the held-out photos stay unseen.

  dev     photo-dev-tasks.json: 8 public-domain or CC0 photos (photo-dev-sources.json, pinned by SHA-256) that are not in the eval's
          tuned or held-out sets, degraded with the eval's own code (imglib.degrade_photo) at a fixed seed. This is what the skill's
          scripts are tuned on.
  tuned   the three photo-edit tasks of tasks-media.json (p1 to p3), built the same way the eval builds them.
  arm     tools = the skill's scripts/fix.py, given only what the brief says (the size, the byte cap, the subject box, a horizon or a
          vertical line family); naive = a centre crop and resize with no repair, to show what the degradation breaks.

State: $EVAL_DIR (default ~/.cache/hildegard-photo-dev/eval) and the dev photos in $DEV_PHOTOS (default ~/.cache/hildegard-photo-dev/photos).
Each result is checked by the same photoedit() function the eval runs, so its checks are the eval's checks."""
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
os.environ.setdefault('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-photo-dev/eval'))
DEV_PHOTOS = os.environ.get('DEV_PHOTOS', os.path.expanduser('~/.cache/hildegard-photo-dev/photos'))
UA = {'User-Agent': 'hildegard-creative-eval/1.0 (https://github.com/baney75/hildegard)'}
sys.path.insert(0, HERE)
import imglib, make_media, sandbox, score_media  # noqa: E402

E = score_media.E
SCRIPTS = os.path.join(ROOT, 'skills', 'hildegard-photo-edit', 'scripts')


def dev_photo(key):
    """A dev photo, downloaded once and refused when it does not match its SHA-256."""
    src = json.load(open(os.path.join(HERE, 'photo-dev-sources.json')))[key]
    path = os.path.join(DEV_PHOTOS, key + '.jpg')
    os.makedirs(DEV_PHOTOS, exist_ok=True)
    if not os.path.exists(path):
        data = urllib.request.urlopen(urllib.request.Request(src['url'], headers=UA), timeout=120).read()
        open(path + '.part', 'wb').write(data)
        os.replace(path + '.part', path)
    h = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if h != src['sha256']:
        raise SystemExit(f'{path}: SHA-256 {h} is not the pinned {src["sha256"]}; delete it and re-run')
    return imglib.load_rgb(path)


_eval_photo = make_media.photo


def photo(key):
    return dev_photo(key) if key in json.load(open(os.path.join(HERE, 'photo-dev-sources.json'))) else _eval_photo(key)


make_media.photo = photo


def load_tasks(which):
    tasks = []
    if which in ('dev', 'both'):
        tasks += json.load(open(os.path.join(HERE, 'photo-dev-tasks.json')))
    if which in ('tuned', 'both'):
        tasks += [t for t in json.load(open(os.path.join(HERE, 'tasks-media.json'))) if t['domain'] == 'photoedit']
    return tasks


def command(task, arm, scripts):
    sc = task['score']
    w, h = sc['size']
    if arm == 'naive':
        code = ('from PIL import Image\nim = Image.open("photo.jpg").convert("RGB")\nW, H = %d, %d\nr = W / H\n'
                'cw = min(im.width, int(im.height * r)); ch = int(cw / r)\nx, y = (im.width - cw) // 2, (im.height - ch) // 2\n'
                'im.crop((x, y, x + cw, y + ch)).resize((W, H), Image.LANCZOS).save("out.jpg", quality=90)\n') % (w, h)
        return [sys.executable, '-c', code]
    box = ','.join(str(v) for v in sc['subject'])
    cmd = [sys.executable, os.path.join(scripts, 'fix.py'), 'photo.jpg', 'out.jpg', '--size', f'{w}x{h}', '--max-bytes', str(sc['max_bytes']), '--subject', box]
    if sc.get('tilt_family') in ('h', 'v'):
        cmd += ['--family', sc['tilt_family']]
    return cmd


def make_runner(arm, scripts):
    def run_script(task_id, work, names, out_name, timeout=300):
        task = CURRENT['task']
        tmp = tempfile.mkdtemp(prefix=f'photodev-{task_id}-', dir=os.environ.get('TMPDIR'))
        shutil.copy(os.path.join(E, 'inputs', task_id, 'photo.jpg'), tmp)
        t0 = time.time()
        r = subprocess.run(command(task, arm, scripts), cwd=tmp, capture_output=True, text=True, timeout=timeout)
        ok = sandbox.regular_file(os.path.join(tmp, 'out.jpg'), 500)
        return ok, round(time.time() - t0, 1), tmp, (r.stdout + r.stderr)[-1500:], r.returncode, 'process.py'
    return run_script


CURRENT = {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='both', choices=['dev', 'tuned', 'both'])
    ap.add_argument('--arm', default='tools', choices=['tools', 'naive'])
    ap.add_argument('--only')
    ap.add_argument('--scripts', default=SCRIPTS)
    ap.add_argument('--json')
    ap.add_argument('--keep', help='folder to keep each out.jpg in')
    a = ap.parse_args()
    score_media.run_script = make_runner(a.arm, a.scripts)
    only = set(a.only.split(',')) if a.only else None
    results = {}
    for task in load_tasks(a.set):
        if only and task['id'] not in only:
            continue
        make_media.build(task)
        CURRENT['task'] = task
        run = tempfile.mkdtemp(prefix='photodev-run-', dir=os.environ.get('TMPDIR'))
        res = score_media.photoedit(task, run, run)
        if a.keep and os.path.exists(os.path.join(run, 'out.jpg')):
            os.makedirs(a.keep, exist_ok=True)
            shutil.copy(os.path.join(run, 'out.jpg'), os.path.join(a.keep, task['id'] + '.jpg'))
        shutil.rmtree(run, ignore_errors=True)
        results[task['id']] = res
        bad = [k for k, v in res['checks'].items() if not v]
        keys = ('tilt_in_deg', 'tilt_out_deg', 'wb_err_in', 'wb_err_out', 'luma_err_in', 'luma_err_out', 'noise_in', 'noise_out', 'noise_ref', 'detail_ratio', 'ssim_out', 'subject_inside')
        print(f'{task["id"]:18} {res["passed"]:>2}/{res["total"]:<2} fail: {",".join(bad) or "-":48}', ' '.join(f'{k}={res[k]}' for k in keys if k in res))
        if res.get('log_tail') and (bad or res.get('exit_code')):
            print('    log:', res['log_tail'].strip().replace('\n', ' | ')[:300])
    tot = sum(r['passed'] for r in results.values()), sum(r['total'] for r in results.values())
    print(f'checks passed: {tot[0]}/{tot[1]}; tasks with every check: {sum(r["passed"] == r["total"] for r in results.values())}/{len(results)}')
    if a.json:
        json.dump(results, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
