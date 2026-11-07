---
name: hildegard-video-edit
description: Use when asked to edit, cut, tighten, caption, blur or reframe a video, or cut fillers, pauses or bad takes - an edit list rendered and proven on the output, plus FFmpeg recipes for the rest.
---

# Editing video

Read **hildegard-craft** first. Editing is where most slop is either made (transitions, filler, loud music) or removed. Your job is to make it shorter, clearer and cleaner, and to prove it on the finished file.

## Fast path: write an edit list, render it, prove it

Don't hand-write FFmpeg for a cut. Write (or generate) an **edit list**, `edl.json`: what to keep, what to hide, what to put on it, where it goes. One script renders it on the frame grid and a gate then reads the **output file** and fails unless it matches. Done means the gate passed, not that it rendered.

**With Hildegard linked** (its MCP tools):

1. `edit_plan` with `media_id` (a recording id from `record_link`) or `source_path`, a `target_seconds` and a `target` (`youtube`, `shorts`, `reels`, `tiktok`, `x`, `podcast`). It transcribes (word times, on the owner's GPU) and proposes the list: filler words, earlier takes of a line said again (the last take stays), long dead pauses. It returns every cut with its reason, the list, and the transcript as text.
2. Read the cuts. To cut exact words, delete them from the transcript text and call `edit_plan` again with `edited_text`. Never retype words: the sound can't change.
3. For anything else (hide a key, add a title, music, reframe), change the list with `edit_write`. It names each problem by field (`keep[2].end`) and refuses unknown fields; fix and call again.
4. `edit_render`. It returns a **contact sheet**: look at it. The bottom rows show every cut as a before-and-after pair; a cut mid-motion, a title over a face, or a region still readable is yours to fix.
5. `edit_verify`. If it fails, it says what: change the list, render, verify again. If it says OCR is **unproven**, tell your user the hidden text was not checked.

**Without Hildegard** (Python 3, `pip install av numpy pillow`; `tesseract` optional but needed to prove a blur):

```sh
python3 scripts/edit_video.py plan talk.mp4 -o edit/edl.json --transcript words.json --target-seconds 90 --target shorts
python3 scripts/edit_video.py check edit/edl.json              # every problem named by field
python3 scripts/edit_video.py render edit/edl.json edit/out.mp4
python3 scripts/edit_video.py sheet edit/out.mp4 --edl edit/edl.json -o edit/sheet.jpg   # look at it
python3 scripts/edit_video.py verify edit/out.mp4 edit/edl.json    # exit 0 only if the output proves the list
```

`words.json` is a transcript with word times: `{"segments":[{"words":[{"start":1.2,"end":1.6,"word":"Hello"}]}]}`, which Whisper (`--word_timestamps True`) and most transcribers give. No transcript? `plan --auto` (no `--transcript`) cuts where it is quiet and still, and you write the rest of the list by hand. To edit by words: `python3 scripts/edit_video.py transcript-text words.json -o words.txt`, delete words or lines in `words.txt`, then `plan ... --text words.txt`. `python3 scripts/edit_video.py schema` prints the JSON Schema of the list; `selftest` proves the gate on a planted fake key.

### The edit list, in one screen

```json
{
  "version": 1,
  "sources": { "a": { "path": "talk.mp4" } },
  "keep": [{ "start": 2.0, "end": 71.5 }],
  "cuts": [{ "start": 14.2, "end": 15.1, "why": "um" }],
  "pauses": { "max": 0.7, "keep": 0.3 },
  "blur": [{ "start": 30, "end": 41, "box": [0.05, 0.40, 0.90, 0.10], "style": "solid", "label": "api key" }],
  "boxes": [{ "start": 50, "end": 55, "box": [0.6, 0.3, 0.2, 0.1], "color": "#ffcc00" }],
  "titles": [{ "text": "Deploying in 60 seconds", "start": 0.3, "end": 3, "kind": "lower_third" }],
  "captions": { "transcript": "transcript.json" },
  "chapters": [{ "at": 0, "title": "Intro" }, { "at": 20, "title": "Setup" }, { "at": 45, "title": "Deploy" }],
  "music": { "path": "bed.wav", "duck_db": 16, "under_db": -8 },
  "reframe": { "aspect": "9:16", "mode": "auto" },
  "target": "shorts",
  "secrets": ["sk-live-the-key-that-is-on-screen"]
}
```

- Seconds are **source seconds**, except `titles` and `chapters` (output seconds). `keep` is the order of play; leave it out to keep everything. `cuts` are removed from whatever `keep` says. Everything snaps to the frame grid, so the output's frame count is known before it renders.
- A **box** is `[x, y, width, height]` as fractions of the frame, 0 to 1. Find it on a contact sheet. `box_px` takes pixels, `keys` makes a region that moves (`[{"t": 31, "box": [...]}, ...]`).
- **Hide secrets with `"style": "solid"`**, and give a window a second wider than the secret is on screen: blur and solid are applied to the source picture before any crop or zoom. List what must not be readable under `secrets` (a string as it appears, a `{"regex": ...}`, or `{"kind": "api_key" | "email" | "ip" | "hostname"}`); the gate OCRs the output around every hidden stretch for them and for those four kinds.
- `pauses` shortens dead air found from the energy of the speech, not a fixed silence level: fan noise doesn't hide a pause and typing doesn't count as one. A pause that has typing or clicking in it is **kept** (something is happening on screen); `"activity": "cut"` treats it like dead air.
- `captions` come from the transcript and are re-timed to the cut; words you cut never appear. `music` is cut to length, mixed 8 dB under the voice and ducked 16 dB while anyone speaks.
- `reframe` crops to 9:16, 1:1 or 4:5 around the subject: a face when OpenCV 4 is installed (`pip install "opencv-python-headless<5"`), else where the motion is, else the middle. It never stretches, and never scales up past the source.
- `target` sets the shape and loudness (-14 LUFS, -16 for `podcast`, true peak under -1). The sound is cleaned and mastered, and **the sound as it was is kept as a second audio track** (not for the vertical social targets).
- Two sources? Every range needs `"source": "a"`. Name footage in Hildegard as `recording:<id>`, never by path.

### What the gate checks, and what to do when it fails

| It says | Do this |
| --- | --- |
| `frames`: N frames, the list resolves to M | The file isn't this list's render. Render again. |
| `sync`: a track is longer or shorter than the picture | Render again; if it persists, the source's own sound is broken: `audio.mute` or another `audio_track`. |
| `loudness`: LUFS or peak off target | Render again; a source with no speech and no music can't be mastered: set `audio.master` to false only if the sound is on purpose. |
| `black` / `frozen` | A black or still stretch longer than allowed. Cut it, or raise `verify.max_black` / `verify.max_frozen` if it is on purpose. |
| `overlays`: outside the frame | Shorten the text, or give less to `captions.max_chars`. |
| `ocr`: readable text found | Add a blur over it, widen the window by a second, use `"style": "solid"`, render, verify. Don't remove the secret from `secrets`. |

Never say a video is fixed or finished from the render alone. The gate's report is the evidence.

## Recipes: plain FFmpeg, when you need one thing the edit list doesn't do

The rest of this page is plain FFmpeg for work outside the edit list (a grade, stabilizing, a one-off trim). Work on copies, never over your user's originals; write to a new folder such as `edit/`.

## 0. Look first

```sh
ffprobe -v error -show_entries stream=codec_type,width,height,r_frame_rate,duration -of compact input.mp4
hildegard review input.mp4 --sheet input-sheet.jpg
```

Note the frame rate and size: everything you join must match them.

## 1. Cut

Cut on action (a hand moves, a head turns) or on a look; never in the middle of a word. Find times from the contact
sheet and by checking frames:

```sh
ffmpeg -ss 00:00:03.20 -i input.mp4 -frames:v 1 -q:v 2 check.jpg   # the frame at 3.2 s
```

Frame-accurate trim (re-encodes; `-ss` after `-i` for accuracy):

```sh
ffmpeg -i input.mp4 -ss 3.20 -to 7.85 -c:v libx264 -crf 17 -preset slow -c:a aac -b:a 192k cut.mp4
```

## 2. Assemble

Same size, frame rate and audio on every clip first:

```sh
ffmpeg -i clip.mp4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1" \
  -c:v libx264 -crf 17 -preset slow -c:a aac -ar 48000 -ac 2 norm-1.mp4
```

(A clip without sound: add `-f lavfi -i anullsrc=r=48000:cl=stereo -shortest` as a second input.)

Join with straight cuts (the default; use it):

```sh
printf "file '%s'\n" norm-1.mp4 norm-2.mp4 norm-3.mp4 > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy assembly.mp4
```

A dissolve only where time passes; half a second is plenty:

```sh
ffmpeg -i a.mp4 -i b.mp4 -filter_complex \
 "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=<A_LENGTH_MINUS_0.5>[v];[0:a][1:a]acrossfade=d=0.5[a]" \
 -map "[v]" -map "[a]" -c:v libx264 -crf 17 -c:a aac dissolve.mp4
```

No spins, glitches, flashes, zooms or wipes between shots. They are filler.

## 3. Grade

Grade toward what the brief asks, and usually *down*: generated footage is often oversaturated.

```sh
# Calm saturation, a touch more contrast, slightly warmer:
ffmpeg -i in.mp4 -vf "eq=saturation=0.85:contrast=1.05,colortemperature=temperature=6000" -c:a copy -crf 17 graded.mp4
# Lift the blacks for a softer, filmic print:
ffmpeg -i in.mp4 -vf "curves=all='0/0.04 0.5/0.5 1/0.97'" -c:a copy -crf 17 lifted.mp4
# A LUT, if your user has one:
ffmpeg -i in.mp4 -vf "lut3d=look.cube" -c:a copy -crf 17 lut.mp4
```

Match shots to each other: grade the most important shot first, then bring the others to it. Look at the contact
sheets side by side. `hildegard review` failing `colour` means you pushed too far.

## 4. Steady, clean, sharp

```sh
# Stabilise handheld footage (two passes):
ffmpeg -i in.mp4 -vf vidstabdetect=shakiness=5:result=transforms.trf -f null -
ffmpeg -i in.mp4 -vf "vidstabtransform=input=transforms.trf:smoothing=20,unsharp=5:5:0.4" -c:a copy -crf 17 steady.mp4
# Flicker in generated footage (mild):
ffmpeg -i in.mp4 -vf deflicker=size=5 -c:a copy -crf 17 deflickered.mp4
# Noise, gently:
ffmpeg -i in.mp4 -vf hqdn3d=2:1:3:3 -c:a copy -crf 17 clean.mp4
```

Sharpen only a little (`cas=0.3` or `unsharp=5:5:0.4`). Halos are slop.

## 5. Reframe for vertical (9:16)

Don't squash; crop around the subject. Find where the subject is on the contact sheet (as a fraction of the width,
0 = left), then:

```sh
# Subject at about 40% across a 1920x1080 frame:
ffmpeg -i in.mp4 -vf "crop=ih*9/16:ih:(iw*0.40)-(ih*9/16)/2:0,scale=1080:1920" -c:a copy -crf 17 vertical.mp4
```

Clamp the x offset to between 0 and `iw-ih*9/16`. If the subject moves across the frame, cut it into parts with
different offsets rather than letting the subject leave the frame.

## 6. Captions

Write captions as SRT: at most two lines, about 42 characters a line, on screen at least 1 second, broken at natural
pauses. Then burn them in with a plain, readable style:

```sh
ffmpeg -i in.mp4 -vf "subtitles=captions.srt:force_style='FontName=Source Sans 3,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=1.2,Shadow=0,MarginV=36'" \
  -c:a copy -crf 17 captioned.mp4
```

For a vertical video, raise `MarginV` so captions clear the app's own buttons (about 300 at 1920 high). Check the
words against the audio; a wrong caption is worse than none. Hildegard's transcription isn't built yet: if your agent
can't transcribe, ask your user for the script.

## 7. Sound

- **Fades at every audio cut** (5 to 20 ms) so nothing clicks: `afade=t=in:d=0.01,afade=t=out:st=<END-0.01>:d=0.01`.
- **Music under speech:** duck it with the voice:

```sh
ffmpeg -i video.mp4 -i music.wav -filter_complex \
 "[1:a]volume=0.5[m];[m][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck];[0:a][duck]amix=inputs=2:normalize=0[a]" \
 -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k mixed.mp4
```

- **Master the loudness last**, two passes, to about -14 LUFS with peaks under -1 dB:

```sh
ffmpeg -i mixed.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2> loud.txt
# The JSON at the end of loud.txt has input_i, input_tp, input_lra, input_thresh and target_offset. Put them in:
ffmpeg -i mixed.mp4 -af "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=<input_i>:measured_TP=<input_tp>:measured_LRA=<input_lra>:measured_thresh=<input_thresh>:offset=<target_offset>:linear=true" \
  -c:v copy -c:a aac -b:a 192k -ar 48000 master.mp4
```

Use -16 LUFS for speech-only pieces and podcasts.

## 8. Deliver

```sh
ffmpeg -i master.mp4 -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k final.mp4
hildegard review final.mp4 --final --film --audio --sheet final-sheet.jpg
```

Look at the sheet and listen through once. Then tell your user the path, the length, what you cut and why, and
anything you couldn't fix. Keep Hildegard's "made with" label in the file's metadata when the footage is generated.
