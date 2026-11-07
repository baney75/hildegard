# SPDX-License-Identifier: AGPL-3.0-only
"""The delivery instructions respond.sh appends to a media brief (photo editing, a picture drawn in code, sound effects, music,
video drawn in code). One place, so the instructions every arm sees stay identical."""

DOMAINS = ('photoedit', 'photocreate', 'sfx', 'music', 'codevideo')

TOOLS = ("The machine has Python 3 with numpy and Pillow (no scipy, no OpenCV, no librosa), ImageMagick 7 (`magick`), ffmpeg and ffprobe, sox, tesseract, "
         "and a Chromium at {chrome}. There is no network, and no node. ")
RERUN = ("It will be run later, on a fresh copy of the input files, as `{cmd}` in an empty folder, with no network and `PATH=/usr/bin:/bin:/usr/local/bin`, "
         "under a {secs} second limit, so use absolute paths for anything outside those directories. Run it yourself first and check what it makes. ")


def tail(t, chrome):
    d = t['domain']
    inputs = ', '.join(t.get('inputs', []))
    tools = TOOLS.format(chrome=chrome)
    if d == 'photoedit':
        w, h = t['score']['size']
        return (f"The photo is {inputs} in the current folder. {tools}Deliver ONE script in the current folder: process.sh (bash, calling ImageMagick and/or an inline `python3` with Pillow) "
                f"or process.py (Python 3 with Pillow and numpy), that reads photo.jpg and writes out.jpg in the same folder: a JPEG of exactly {w} x {h} pixels under {t['score']['max_bytes'] // 1000} KB. "
                + RERUN.format(cmd='bash process.sh` or `python3 process.py', secs=120)
                + "Do not hard-code a guess you have not checked against the picture: look at photo.jpg and at your out.jpg (you can open images with Read). Print only a one-line note when you are done.")
    if d == 'photocreate':
        w, h = t['size']
        return (f"{tools}Deliver the picture as ONE of these in the current folder: art.svg (an SVG with width=\"{w}\" and height=\"{h}\" on the root element), art.html "
                f"(self-contained HTML and CSS, body margin 0, the page exactly {w} x {h} px, Google Fonts through a <link> allowed, no other network resources, no JavaScript needed), "
                f"or make.py (Python 3 with Pillow and numpy that writes art.png, {w} x {h}). It will be rendered to a PNG of exactly {w} x {h} px here with Chromium "
                f"(`{chrome} --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size={w},{h} --virtual-time-budget=12000 --screenshot=check.png file://$PWD/art.svg`, "
                "or art.html in place of art.svg); render it yourself and look at check.png (you can open images with Read) before you finish, and fix what looks wrong. Print only a one-line note when you are done.")
    if d in ('sfx', 'music'):
        return (f"{tools}Deliver ONE script in the current folder: make.py (Python 3 with numpy; write the WAV with the standard `wave` module) or make.sh (bash, using sox and/or ffmpeg), that writes out.wav "
                "in the same folder, 44.1 kHz 16-bit. " + RERUN.format(cmd='python3 make.py` or `bash make.sh', secs=180)
                + "You cannot hear it, so check it by measurement: `ffmpeg -i out.wav -af ebur128=peak=true -f null -` for loudness and true peak, and look at a spectrogram "
                "(for example `ffmpeg -i out.wav -lavfi showspectrumpic=s=1000x400 spec.png`, then Read spec.png). Print only a one-line note when you are done.")
    if d == 'codevideo':
        w, h = t['score']['size']
        inputs_s = f"The given images are in the current folder: {inputs}. " if inputs else ''
        return (f"{inputs_s}{tools}Deliver ONE script in the current folder: make.py (Python 3: draw frames with Pillow and numpy and pipe them to ffmpeg, or drive Chromium yourself) or make.sh (bash), "
                f"that writes out.mp4 in the same folder: H.264, yuv420p, {w} x {h}, 30 fps, within the length the brief gives. " + RERUN.format(cmd='python3 make.py` or `bash make.sh', secs=300)
                + "Render it, then look at a few frames (extract with ffmpeg, open with Read) and read the text in them before you finish. Print only a one-line note when you are done.")
    raise ValueError(d)
