#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Cut clips into one finished piece: set size and frame rate, crossfades or hard cuts, titles, a closing card, a music bed.

  python3 cut_reel.py OUT --clip a.mp4@0-5 --clip b.mp4@2-7.5 --clip c.mp4 --clip d.mp4@1-6
                      [--size 1280x720] [--fps 30] [--fade 0.4] [--total 25]
                      [--music bed.wav] [--lufs -16] [--music-fade-in 1] [--music-fade-out 1.5]
                      [--title "Hollis Creek Canoe Rental"] [--title-at 0.4] [--title-secs 3]
                      [--card "Open May to October - Rt 122, Hollis NH"] [--card-secs 3]
                      [--text "Any other line@6-9"]

--clip PATH[@IN-OUT]   a clip with in and out points in seconds (whole clip if left out). Order is the order of the cut.
--fade SECONDS         crossfade between shots; 0 is a hard cut (default 0.4)
--total SECONDS        exact length. Longer than the clips give: every clip is held to what is needed, never stretched.
                       Shorter: each clip loses an equal share from its end (no clip below 1 s).
--card TEXT            a closing card (dark blue, never black) after the last shot; --card-secs is its length (default 3)
--title TEXT           lower-third title over the first shot, from --title-at for --title-secs
--text "TEXT@A-B"      more titles, A and B in seconds on the finished timeline
Pictures that do not match the frame (a vertical phone clip in a 16:9 piece) are fitted whole over a blurred copy of
themselves, never stretched or cropped. Sound in the clips is dropped; the music bed is cut to length, faded and loudnormed
in two passes (default -16 LUFS). Output is H.264 and AAC, yuv420p, with the moov atom first.
Needs only Python 3, ffmpeg and ffprobe on PATH. Run check_video.py on the result.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
CARD_COLOR = "0x16324f"


def ff(*a):
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-y", *a], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-2000:])


def err(*a):
    return subprocess.run([FFMPEG, "-hide_banner", "-nostats", *a], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr


def duration(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        return float(r.stdout.strip())
    except ValueError:
        sys.exit(f"{path}: ffprobe could not read it")


def find_font():
    """A bold sans font that exists on this computer: fontconfig first, then the usual places on Linux, macOS and Windows."""
    if shutil.which("fc-match"):
        r = subprocess.run(["fc-match", "-f", "%{file}", "sans:bold"], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0 and os.path.exists(r.stdout.strip()):
            return r.stdout.strip()
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
              "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/System/Library/Fonts/Helvetica.ttc", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"):
        if os.path.exists(f):
            return f
    return None


def esc(path):
    """A path inside a drawtext option: forward slashes, colons escaped, wrapped in quotes."""
    return "'" + path.replace("\\", "/").replace(":", "\\:") + "'"


def drawtext(font, textfile, w, h, text, start, end, y):
    size = max(18, min(h // 13, int(w * 0.9 / (max(8, len(text)) * 0.56))))
    fade = min(0.4, (end - start) / 3)
    return (f"drawtext=fontfile={esc(font)}:textfile={esc(textfile)}:fontcolor=white:fontsize={size}:x=(w-text_w)/2:y={y}"
            f":box=1:boxcolor=black@0.45:boxborderw={size // 3}:shadowcolor=black@0.6:shadowx=2:shadowy=2"
            f":enable='between(t,{start:.3f},{end:.3f})':alpha='min(1,(t-{start:.3f})/{fade:.3f})*min(1,({end:.3f}-t)/{fade:.3f})'")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("output")
    ap.add_argument("--clip", action="append", required=True)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--fade", type=float, default=0.4)
    ap.add_argument("--total", type=float, default=None)
    ap.add_argument("--music", default=None)
    ap.add_argument("--lufs", type=float, default=-16.0)
    ap.add_argument("--peak", type=float, default=-1.5)
    ap.add_argument("--music-fade-in", type=float, default=1.0)
    ap.add_argument("--music-fade-out", type=float, default=1.5)
    ap.add_argument("--title", default=None)
    ap.add_argument("--title-at", type=float, default=0.4)
    ap.add_argument("--title-secs", type=float, default=3.0)
    ap.add_argument("--card", default=None)
    ap.add_argument("--card-secs", type=float, default=3.0)
    ap.add_argument("--text", action="append", default=[])
    a = ap.parse_args()
    if not (FFMPEG and FFPROBE):
        sys.exit("ffmpeg and ffprobe must be on PATH")
    W, H = (int(x) for x in a.size.lower().split("x"))
    D = max(0.0, a.fade)

    clips = []
    for spec in a.clip:
        path, _, rng = spec.rpartition("@") if re.search(r"@[\d.]+-[\d.]+$", spec) else (spec, "", "")
        full = duration(path)
        i, o = (float(x) for x in rng.split("-")) if rng else (0.0, full)
        o = min(o, full)
        if o - i < 0.5:
            sys.exit(f"{spec}: needs at least 0.5 s between in and out")
        clips.append({"path": path, "in": i, "dur": o - i})
    n = len(clips)
    card = a.card_secs if a.card else 0.0
    segs = n + (1 if a.card else 0)
    total_clips = sum(c["dur"] for c in clips)
    length = total_clips + card - (segs - 1) * D
    if a.total is not None and length > a.total + 0.05:
        # take the excess off the end of every clip, equally, never below 1 s
        excess = length - a.total
        room = sum(max(0.0, c["dur"] - 1.0) for c in clips)
        if room < excess:
            sys.exit(f"cannot reach {a.total} s: the clips cannot be cut shorter than {length - room:.1f} s")
        for c in clips:
            c["dur"] -= excess * max(0.0, c["dur"] - 1.0) / room
        length = a.total
    elif a.total is not None and length < a.total - 0.05:
        print(f"note: the cut is {length:.1f} s, shorter than --total {a.total}; add clips or widen the in/out points", file=sys.stderr)
    for k in range(n):
        clips[k]["dur"] = round(clips[k]["dur"], 3)

    font = find_font()
    tmp = tempfile.mkdtemp(prefix="cut-reel-")
    try:
        # video: each clip fitted to the frame, joined with xfade or concat, titles burned in
        fc, ins = [], []
        for k, c in enumerate(clips):
            ins += ["-ss", f"{c['in']:.3f}", "-t", f"{c['dur']:.3f}", "-i", c["path"]]
            fc.append(f"[{k}:v]fps={a.fps},split[b{k}][f{k}];"
                      f"[b{k}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=24:3[bg{k}];"
                      f"[f{k}]scale={W}:{H}:force_original_aspect_ratio=decrease[fg{k}];"
                      f"[bg{k}][fg{k}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v{k}]")
        labels = [f"v{k}" for k in range(n)]
        durs = [c["dur"] for c in clips]
        if a.card:
            ins += ["-f", "lavfi", "-t", f"{card:.3f}", "-i", f"color=c={CARD_COLOR}:s={W}x{H}:r={a.fps}"]
            labels.append(f"v{n}")
            fc.append(f"[{n}:v]format=yuv420p,setsar=1[v{n}]")
            durs.append(card)
        if D > 0 and len(labels) > 1:
            cur, acc = labels[0], durs[0]
            for k in range(1, len(labels)):
                off = acc - D
                fc.append(f"[{cur}][{labels[k]}]xfade=transition=fade:duration={D}:offset={off:.3f}[x{k}]")
                cur, acc = f"x{k}", off + durs[k]
            last = cur
        else:
            fc.append("".join(f"[{l}]" for l in labels) + f"concat=n={len(labels)}:v=1:a=0[xc]")
            last = "xc"
        # titles
        texts = []
        if a.title:
            texts.append((a.title, a.title_at, a.title_at + a.title_secs, "h*0.78"))
        if a.card:
            cs = length - card + D + 0.3
            texts.append((a.card, cs, length - 0.2, "(h-text_h)/2"))
        for t in a.text:
            m = re.match(r"(.*)@([\d.]+)-([\d.]+)$", t)
            if not m:
                sys.exit(f"--text needs TEXT@START-END, got: {t}")
            texts.append((m.group(1), float(m.group(2)), float(m.group(3)), "h*0.78"))
        if texts and not font:
            print("warning: no font found, titles skipped; pass a system with fontconfig or install DejaVu Sans", file=sys.stderr)
            texts = []
        chain = ""
        for k, (text, s, e, y) in enumerate(texts):
            tf = os.path.join(tmp, f"t{k}.txt")
            with open(tf, "w", encoding="utf-8") as fh:
                fh.write(text)
            chain += "," + drawtext(font, tf, W, H, text, s, e, y)
        fc.append(f"[{last}]trim=duration={length:.3f},setpts=PTS-STARTPTS{chain}[vout]")
        silent = os.path.join(tmp, "silent.mp4")
        ff(*ins, "-filter_complex", ";".join(fc), "-map", "[vout]", "-r", str(a.fps), "-c:v", "libx264", "-crf", "18",
           "-preset", "medium", "-pix_fmt", "yuv420p", "-an", silent)
        # audio: the music bed cut to length, faded, loudnormed in two passes; or silence
        bed = os.path.join(tmp, "bed.wav")
        if a.music:
            fo = max(0.0, length - a.music_fade_out)
            ff("-stream_loop", "-1", "-i", a.music, "-t", f"{length:.3f}", "-af",
               f"aformat=channel_layouts=stereo,afade=t=in:d={a.music_fade_in},afade=t=out:st={fo:.3f}:d={a.music_fade_out}",
               "-ar", "48000", "-c:a", "pcm_f32le", os.path.join(tmp, "raw.wav"))
            base = f"loudnorm=I={a.lufs}:TP={a.peak}:LRA=11"
            t = err("-i", os.path.join(tmp, "raw.wav"), "-af", base + ":print_format=json", "-f", "null", "-")
            m = json.loads(t[t.rfind("{"):t.rfind("}") + 1])
            ff("-i", os.path.join(tmp, "raw.wav"), "-af",
               f"{base}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
               f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true", "-ar", "48000", "-c:a", "pcm_s16le", bed)
        else:
            ff("-f", "lavfi", "-t", f"{length:.3f}", "-i", "anullsrc=r=48000:cl=stereo", "-c:a", "pcm_s16le", bed)
        ff("-i", silent, "-i", bed, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{length:.3f}",
           "-movflags", "+faststart", a.output)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"wrote {a.output}: {length:.2f} s, {W}x{H} at {a.fps} fps, {len(labels)} shots{', closing card' if a.card else ''}"
          f"{', music at ' + str(a.lufs) + ' LUFS' if a.music else ''}")
    print("next: python3 check_video.py " + a.output)


if __name__ == "__main__":
    main()
