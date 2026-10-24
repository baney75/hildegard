#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Animatic: storyboard panels timed to the song or soundtrack, rendered as an MP4.

  python3 animatic.py board.json out.mp4

board.json:
{
  "fps": 24, "size": [1280, 720], "audio": "song.wav",          # audio optional
  "panels": [
    {"image": "p01.png", "start": 0.0, "end": 3.2, "label": "1  WIDE  intro",
     "move": {"zoom": [1.0, 1.08], "pan": [[0, 0], [0.03, -0.01]]}},   # optional camera move
    {"image": "p02.png", "start": 3.2, "end": 5.0, "label": "2  CU  'who do you say'"}
  ]
}
Times are absolute seconds from the song map; frames are placed with round(t * fps), so nothing
drifts. Each frame carries the panel label and a timecode bar so notes can cite "panel 7 at 01:12".
Gaps between panels render black; overlapping panels are an error.
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "C:/Windows/Fonts/arial.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()

def main():
    board, out = json.load(open(sys.argv[1])), sys.argv[2]
    base = os.path.dirname(os.path.abspath(sys.argv[1]))
    fps = int(board.get("fps", 24)); W, H = board.get("size", [1280, 720])
    panels = sorted(board["panels"], key=lambda p: p["start"])
    for a, b in zip(panels, panels[1:]):
        if b["start"] < a["end"] - 1e-6:
            sys.exit(f"overlap: panel ending {a['end']} vs panel starting {b['start']}")
    end = max(p["end"] for p in panels)
    nframes = round(end * fps)
    f_lab, f_tc = font(max(16, H // 30)), font(max(14, H // 40))
    cache = {}
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-"]
    if board.get("audio"):
        cmd += ["-i", os.path.join(base, board["audio"]), "-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    idx = 0
    for fr in range(nframes):
        t = fr / fps
        while idx < len(panels) - 1 and round(panels[idx]["end"] * fps) <= fr:
            idx += 1
        p = panels[idx]
        frame = Image.new("RGB", (W, H), (0, 0, 0))
        if round(p["start"] * fps) <= fr < round(p["end"] * fps):
            path = os.path.join(base, p["image"])
            if path not in cache:
                im = Image.open(path).convert("RGB"); s = max(W / im.width, H / im.height)
                cache[path] = im.resize((int(im.width * s * 1.25 + 1), int(im.height * s * 1.25 + 1)), Image.LANCZOS)
            src = cache[path]
            u = (t - p["start"]) / max(1e-6, p["end"] - p["start"])
            mv = p.get("move", {}); z0, z1 = mv.get("zoom", [1.0, 1.0]); (px0, py0), (px1, py1) = mv.get("pan", [[0, 0], [0, 0]])
            z = z0 + (z1 - z0) * u; px = px0 + (px1 - px0) * u; py = py0 + (py1 - py0) * u
            cw, ch = src.width / 1.25 / z, src.height / 1.25 / z
            cx, cy = src.width / 2 + px * src.width, src.height / 2 + py * src.height
            crop = src.crop((int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2))).resize((W, H), Image.BILINEAR)
            frame.paste(crop)
            d = ImageDraw.Draw(frame)
            d.rectangle([0, H - H // 14, W, H], fill=(0, 0, 0))
            d.text((12, H - H // 14 + 6), p.get("label", os.path.basename(p["image"])), fill=(240, 240, 240), font=f_lab)
        d = ImageDraw.Draw(frame)
        tc = f"{int(t // 60):02d}:{int(t % 60):02d}:{fr % fps:02d}"
        d.text((W - 12 - d.textlength(tc, font=f_tc), 10), tc, fill=(255, 220, 120), font=f_tc)
        proc.stdin.write(frame.tobytes())
    proc.stdin.close(); proc.wait()
    print(f"wrote {out}: {nframes} frames at {fps} fps, {len(panels)} panels, {end:.2f}s")

if __name__ == "__main__":
    main()
