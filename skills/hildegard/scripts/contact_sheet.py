#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Contact sheets for drafts, variants, storyboard panels and films.

  Images:  python3 contact_sheet.py out.png img1.png img2.png ... [--cols 4] [--cell 360] [--title "Thumbnails v1"]
  Folder:  python3 contact_sheet.py out.png drafts/*.png --title "Color comps"
  Video:   python3 contact_sheet.py out.png --video film.mp4 [--every 2] [--scenes 0.3] [--cols 6]

Every cell is labeled (file name, or time and shot number for video) so the user can answer
"B3" instead of describing a picture. Video mode samples every N seconds AND every detected
shot boundary (ffmpeg scene score > threshold), sorted by time.
"""
import argparse, glob, os, re, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf",
              "/System/Library/Fonts/Supplemental/Arial.ttf", "C:/Windows/Fonts/arial.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()

def video_frames(path, every, scene, tmp):
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                               capture_output=True, text=True, check=True).stdout.strip())
    times = set(round(t * every, 3) for t in range(int(dur // every) + 1))
    if scene > 0:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-vf", f"select='gt(scene,{scene})',showinfo", "-f", "null", "-"],
                             capture_output=True, text=True).stderr
        cuts = [float(m) for m in re.findall(r"pts_time:([0-9.]+)", out)]
        times |= set(round(c + 0.05, 3) for c in cuts)
    else:
        cuts = []
    frames = []
    for i, t in enumerate(sorted(x for x in times if x < dur)):
        f = os.path.join(tmp, f"f{i:04d}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t}", "-i", path, "-frames:v", "1", f], check=True)
        if os.path.exists(f):
            shot = 1 + sum(1 for c in cuts if c < t)
            frames.append((f, f"{int(t // 60):02d}:{t % 60:05.2f}  shot {shot}" + ("  CUT" if any(abs(t - c - 0.05) < 1e-3 for c in cuts) else "")))
    return frames

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("images", nargs="*")
    ap.add_argument("--video"); ap.add_argument("--every", type=float, default=2.0); ap.add_argument("--scenes", type=float, default=0.3)
    ap.add_argument("--cols", type=int, default=0); ap.add_argument("--cell", type=int, default=360); ap.add_argument("--title", default="")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp()
    if a.video:
        items = video_frames(a.video, a.every, a.scenes, tmp)
    else:
        paths = [p for g in a.images for p in sorted(glob.glob(g))] or a.images
        items = [(p, os.path.splitext(os.path.basename(p))[0]) for p in paths]
    if not items:
        sys.exit("no images")
    n = len(items); cols = a.cols or min(6, max(2, round(n ** 0.5 + 0.5)))
    rows = (n + cols - 1) // cols
    ims = [Image.open(p).convert("RGB") for p, _ in items]
    ar = sum(i.height / i.width for i in ims) / n
    cw = a.cell; ch = int(cw * ar); pad = 14; lab = 26; top = 56 if a.title else pad
    sheet = Image.new("RGB", (cols * (cw + pad) + pad, top + rows * (ch + lab + pad)), (24, 24, 26))
    d = ImageDraw.Draw(sheet); f = font(17); ft = font(28)
    if a.title:
        d.text((pad, 14), a.title, fill=(235, 235, 235), font=ft)
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for k, (im, (_, label)) in enumerate(zip(ims, items)):
        r, c = divmod(k, cols)
        x = pad + c * (cw + pad); y = top + r * (ch + lab + pad)
        t = im.copy(); t.thumbnail((cw, ch))
        sheet.paste(t, (x + (cw - t.width) // 2, y + (ch - t.height) // 2))
        code = f"{letters[r % 26]}{c + 1}"
        d.text((x, y + ch + 4), f"{code}  {label}"[:48], fill=(210, 210, 210), font=f)
    sheet.save(a.out)
    print(f"wrote {a.out}: {n} cells, {cols}x{rows}; cells are labeled row-letter + column (A1, B3...)")

if __name__ == "__main__":
    main()
