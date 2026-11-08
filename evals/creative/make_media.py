# SPDX-License-Identifier: AGPL-3.0-only
"""Make the inputs for the photo-editing and slideshow tasks, reproducibly.

  python3 make_media.py tasks-media.json [heldout-media.json ...]

Photos are public-domain or CC0 pictures from Wikimedia Commons (media-sources.json lists the page, license and author of each),
downloaded once to $PHOTOS_DIR (default ~/.cache/hildegard-creative-eval/photos, shared by every EVAL_DIR), never into git, and pinned by SHA-256: a file
that does not match is refused. A task with `media.photo` is degraded with the operations in `media.ops` (imglib.degrade_photo,
fixed seed): the responder gets $EVAL_DIR/inputs/<id>/photo.jpg; the clean window it was cut from is kept as
$EVAL_DIR/ref/<id>/reference.png with a meta.json, and is never shown to a responder. A task with `media.images` gets those
photos, resized to 1280 px wide, as the files it names. Re-running skips what exists."""
import hashlib, json, os, sys, urllib.request
from PIL import Image
import imglib

E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
HERE = os.path.dirname(os.path.abspath(__file__))
PHOTOS = os.environ.get('PHOTOS_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval/photos'))  # shared by every EVAL_DIR: the files are pinned
UA = {'User-Agent': 'hildegard-creative-eval/1.0 (https://github.com/baney75/hildegard)'}


def photo(key):
    src = json.load(open(os.path.join(HERE, 'media-sources.json')))[key]
    path = os.path.join(PHOTOS, key + '.jpg')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        data = urllib.request.urlopen(urllib.request.Request(src['url'], headers=UA), timeout=120).read()
        open(path + '.part', 'wb').write(data)
        os.replace(path + '.part', path)
    h = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if h != src['sha256']:
        raise SystemExit(f'{path}: SHA-256 {h} is not the pinned {src["sha256"]}; delete it and re-run')
    return imglib.load_rgb(path)


def build(task):
    m = task.get('media')
    if not m:
        return
    tid = task['id']
    inp, ref = os.path.join(E, 'inputs', tid), os.path.join(E, 'ref', tid)
    if os.path.exists(os.path.join(ref, 'meta.json')):
        return
    os.makedirs(inp, exist_ok=True)
    os.makedirs(ref, exist_ok=True)
    meta = {'task': tid}
    if 'photo' in m:
        im = photo(m['photo'])
        if m.get('precrop'):
            a, b, c, d = m['precrop']
            im = im.crop((int(a * im.width), int(b * im.height), int(c * im.width), int(d * im.height)))
        deg, clean, size = imglib.degrade_photo(im, m['ops'], m.get('seed', 1))
        deg.save(os.path.join(inp, 'photo.jpg'), quality=90, subsampling=0)
        clean.save(os.path.join(ref, 'reference.png'))
        meta.update(size=list(size), ops=m['ops'])
    for name, key in (m.get('images') or {}).items():
        im = imglib.resize_w(photo(key), 1280)
        im.save(os.path.join(inp, name), quality=92)
    json.dump(meta, open(os.path.join(ref, 'meta.json'), 'w'), indent=1)
    print('made', tid)


if __name__ == '__main__':
    for p in sys.argv[1:]:
        for t in json.load(open(p)):
            build(t)
