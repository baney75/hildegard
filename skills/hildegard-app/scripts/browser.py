#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""browser.py: find a headless Chromium and use it to screenshot a page or read values out of it.

Shared by the checkers in this folder (the same file sits in hildegard-brand and hildegard-app, so each skill works on
its own). Order of search: $HILDEGARD_CHROMIUM or $CHROMIUM, Playwright's own downloads, then chromium or Chrome on
PATH, but only a real binary: a wrapper script there may open someone's own browser profile. Standard library;
Pillow, when present, crops the screenshot to the exact size."""
import glob, html, json, os, re, shutil, subprocess, tempfile

try:
    from PIL import Image
except ImportError:
    Image = None


def _is_binary(p):
    """A real browser binary, not a wrapper script (a wrapper can open someone's own browser profile)."""
    try:
        with open(os.path.realpath(p), 'rb') as f:
            head = f.read(4)
        return head in (b'\x7fELF', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe') or head[:2] == b'MZ'
    except OSError:
        return False


def find_chromium():
    env = os.environ.get('HILDEGARD_CHROMIUM') or os.environ.get('CHROMIUM')
    if env:
        return env
    home = os.path.expanduser('~')
    roots = [os.path.join(home, '.cache', 'ms-playwright'), os.path.join(home, 'Library', 'Caches', 'ms-playwright'),
             os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ms-playwright')]
    pats = ['chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell*', 'chromium-*/chrome-linux*/chrome',
            'chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium',
            'chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            'chromium-*/chrome-win*/chrome.exe']
    for r in roots:
        for p in pats:
            c = sorted(glob.glob(os.path.join(r, p)))
            if c:
                return c[-1]
    for n in ('chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'microsoft-edge', 'msedge'):
        p = shutil.which(n)
        if p and _is_binary(p):
            return p
    for p in ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'):
        if os.path.exists(p):
            return p
    return None


def chromium_shot(page, png, w, h, chrome=None, extra=(), scale=1):
    """Screenshot an HTML file at exactly w x h CSS px. The page is put in an iframe of that size inside a window at
    least 520 px wide, because some headless builds won't make a window narrower than about 500 px."""
    chrome = chrome or find_chromium()
    if not chrome:
        return False
    d = tempfile.mkdtemp(prefix='shot-')
    wrap = os.path.join(d, 'wrap.html')
    src = 'file://' + os.path.abspath(page)
    open(wrap, 'w').write(f'<!doctype html><html><body style="margin:0;background:transparent">'
                          f'<iframe src="{html.escape(src)}" style="border:0;display:block;width:{w}px;height:{h}px;background:transparent"'
                          f' allowtransparency="true"></iframe></body></html>')
    ww = max(w, 520)
    args = [chrome, '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
            '--default-background-color=00000000', f'--force-device-scale-factor={scale}', f'--window-size={ww},{h}',
            '--virtual-time-budget=8000', f'--screenshot={os.path.abspath(png) + ".full.png"}', *extra, 'file://' + wrap]
    if 'headless-shell' not in os.path.basename(chrome):
        args.insert(1, '--headless=new')
    try:
        subprocess.run(args, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return False
    full = png + '.full.png'
    ok = os.path.exists(full)
    if ok and Image:
        with Image.open(full) as im:
            im.crop((0, 0, round(w * scale), round(h * scale))).save(png)
        os.remove(full)
    elif ok:
        os.replace(full, png)
    shutil.rmtree(d, ignore_errors=True)
    return os.path.exists(png)


def chromium_dom(page, w, h, js, chrome=None, scale=1):
    """Load page at w x h, run js (an expression giving a JSON-able value, may be a Promise) and return its value. Pass the
    scale a screenshot was taken at to measure the same layout: text wraps a little differently at each device scale."""
    chrome = chrome or find_chromium()
    if not chrome:
        return None
    d = tempfile.mkdtemp(prefix='dom-')
    wrap = os.path.join(d, 'wrap.html')
    src = 'file://' + os.path.abspath(page)
    open(wrap, 'w').write(
        f'<!doctype html><html><body style="margin:0"><iframe id="f" src="{html.escape(src)}" style="border:0;display:block;'
        f'width:{w}px;height:{h}px"></iframe><pre id="out"></pre><script>'
        'const f=document.getElementById("f");f.addEventListener("load",async()=>{const d=f.contentDocument,w=f.contentWindow;'
        'try{await d.fonts.ready}catch(e){}await new Promise(r=>setTimeout(r,300));let v;'
        f'try{{v=await (async()=>({js}))()}}catch(e){{v={{error:String(e)}}}}'
        'document.getElementById("out").textContent="@@"+JSON.stringify(v)+"@@";});</script></body></html>')
    args = [chrome, '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', f'--window-size={max(w, 520)},{h}',
            f'--force-device-scale-factor={scale}', '--virtual-time-budget=10000', '--dump-dom', 'file://' + wrap]
    if 'headless-shell' not in os.path.basename(chrome):
        args.insert(1, '--headless=new')
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=120).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        shutil.rmtree(d, ignore_errors=True)
    m = re.search(r'@@(.*?)@@', out, re.S)
    return json.loads(html.unescape(m.group(1))) if m else None
