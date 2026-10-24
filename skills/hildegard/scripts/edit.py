#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Render an edit decision list (EDL) to a finished MP4: trims, cuts, dissolves, dips, speed,
per-clip gain, a music bed with ducking under dialogue, and two-pass loudness normalization.

  python3 edit.py edl.json

edl.json:
{
  "out": "cut.mp4", "fps": 30, "size": [1920, 1080], "loudness": -14, "true_peak": -1.5,
  "clips": [
    {"src": "a.mp4", "in": 2.0, "out": 6.5},
    {"src": "b.mp4", "in": 0.0, "out": 3.0, "transition": {"type": "dissolve", "dur": 0.5}},
    {"src": "still.png", "dur": 2.5, "transition": {"type": "fadeblack", "dur": 0.6}, "zoom": [1.0, 1.06]},
    {"src": "c.mov", "in": 10, "out": 14, "speed": 0.5, "gain_db": -3, "mute": false}
  ],
  "music": {"src": "song.wav", "start": 0.0, "gain_db": -8, "duck": true, "fade_out": 2.0}
}
transition.type: cut (default) or any ffmpeg xfade name: dissolve, fade, fadeblack, fadewhite, wipeleft,
slideleft, circleopen, smoothleft, ... The transition belongs to the clip it leads INTO.
Each clip is first conformed (scale and pad to size, fps, 48 kHz stereo, silence added if it has no
audio), so mixed sources never break the graph. Prints the timeline with record in/out per clip.
"""
import json, os, re, subprocess, sys, tempfile

def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)

def has_audio(src):
    out = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src]).stdout
    return bool(out.strip())

def conform(c, i, W, H, fps, tmp, base):
    src = os.path.join(base, c["src"]); out = os.path.join(tmp, f"c{i:03d}.mp4")
    is_img = src.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"))
    speed = float(c.get("speed", 1.0))
    vf = [f"scale={W}:{H}:force_original_aspect_ratio=decrease", f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black", "setsar=1"]
    if is_img:
        dur = float(c["dur"])
        z0, z1 = c.get("zoom", [1.0, 1.0]); n = max(1, round(dur * fps))
        vf = [f"scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase", f"crop={W * 2}:{H * 2}",
              f"zoompan=z='{z0}+({z1}-{z0})*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s={W}x{H}:fps={fps}", "setsar=1"]
        cmd = ["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", f"{dur}", "-i", src,
               "-f", "lavfi", "-t", f"{dur}", "-i", "anullsrc=r=48000:cl=stereo",
               "-vf", ",".join(vf), "-map", "0:v", "-map", "1:a", "-shortest"]
    else:
        t0, t1 = float(c.get("in", 0)), float(c["out"]); dur = (t1 - t0) / speed
        vf = [f"setpts=(PTS-STARTPTS)/{speed}"] + vf + [f"fps={fps}"]
        cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{t0}", "-to", f"{t1}", "-i", src]
        if has_audio(src) and not c.get("mute"):
            af = [f"atempo={speed}" if 0.5 <= speed <= 2 else "anull", f"volume={c.get('gain_db', 0)}dB",
                  "aresample=48000", "aformat=channel_layouts=stereo"]
            cmd += ["-vf", ",".join(vf), "-af", ",".join(af), "-map", "0:v:0", "-map", "0:a:0"]
        else:
            cmd += ["-f", "lavfi", "-t", f"{dur}", "-i", "anullsrc=r=48000:cl=stereo", "-vf", ",".join(vf), "-map", "0:v:0", "-map", "1:a", "-shortest"]
    cmd += ["-r", str(fps), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le" if False else "aac", "-b:a", "256k", "-t", f"{dur}", out]
    run(cmd)
    real = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).stdout)
    return out, real

def main():
    edl = json.load(open(sys.argv[1])); base = os.path.dirname(os.path.abspath(sys.argv[1]))
    W, H = edl.get("size", [1920, 1080]); fps = int(edl.get("fps", 30))
    tmp = tempfile.mkdtemp()
    parts = [conform(c, i, W, H, fps, tmp, base) for i, c in enumerate(edl["clips"])]
    inputs, graph = [], []
    for p, _ in parts:
        inputs += ["-i", p]
    v, a, L = "[0:v]", "[0:a]", parts[0][1]
    timeline = [(0.0, L)]
    for i in range(1, len(parts)):
        tr = edl["clips"][i].get("transition", {"type": "cut"}); d = float(tr.get("dur", 0)); dur = parts[i][1]
        nv, na = f"[v{i}]", f"[a{i}]"
        if tr.get("type", "cut") == "cut" or d <= 0:
            graph.append(f"{v}{a}[{i}:v][{i}:a]concat=n=2:v=1:a=1{nv}{na}")
            start = L; L += dur
        else:
            d = min(d, L - 0.05, dur - 0.05)
            graph.append(f"{v}[{i}:v]xfade=transition={tr['type']}:duration={d:.3f}:offset={L - d:.3f}{nv}")
            graph.append(f"{a}[{i}:a]acrossfade=d={d:.3f}{na}")
            start = L - d; L += dur - d
        timeline.append((start, start + dur)); v, a = nv, na
    mus = edl.get("music")
    if mus:
        k = len(parts); inputs += ["-ss", str(mus.get("start", 0)), "-i", os.path.join(base, mus["src"])]
        fo = float(mus.get("fade_out", 2.0))
        graph.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={mus.get('gain_db', -8)}dB,"
                     f"atrim=0:{L:.3f},afade=t=out:st={max(0, L - fo):.3f}:d={fo}[mus]")
        if mus.get("duck", True):
            graph.append(f"{a}asplit=2[prog][key]")
            graph.append("[mus][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]")
            graph.append("[prog][ducked]amix=inputs=2:normalize=0[mix]")
        else:
            graph.append(f"{a}[mus]amix=inputs=2:normalize=0[mix]")
        a = "[mix]"
    pre = os.path.join(tmp, "pre.mp4")
    run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(graph) if graph else "anull",
         "-map", v, "-map", a, "-t", f"{L:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
         "-c:a", "pcm_s16le", "-f", "matroska", pre.replace(".mp4", ".mkv")])
    pre = pre.replace(".mp4", ".mkv")
    I, TP = edl.get("loudness", -14), edl.get("true_peak", -1.5)
    meas = run(["ffmpeg", "-hide_banner", "-i", pre, "-af", f"loudnorm=I={I}:TP={TP}:LRA=11:print_format=json", "-f", "null", "-"]).stderr
    m = json.loads(meas[meas.rfind("{"):meas.rfind("}") + 1])
    ln = (f"loudnorm=I={I}:TP={TP}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
          f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    out = os.path.join(base, edl.get("out", "cut.mp4"))
    run(["ffmpeg", "-y", "-v", "error", "-i", pre, "-c:v", "copy", "-af", f"{ln},aresample=48000,alimiter=limit={10 ** (TP / 20):.3f}:level=false",
         "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", out])
    print(f"wrote {out}: {L:.2f}s, {len(parts)} clips, loudness target {I} LUFS / {TP} dBTP")
    for i, ((s, e), c) in enumerate(zip(timeline, edl["clips"])):
        print(f"  {i + 1:>3}  rec {s:7.2f} - {e:7.2f}   {os.path.basename(c['src'])}  {c.get('transition', {}).get('type', 'cut')}")

if __name__ == "__main__":
    main()
