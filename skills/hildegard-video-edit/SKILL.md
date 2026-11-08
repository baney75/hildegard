---
name: hildegard-video-edit
description: Cut clips into a reel with titles and music, edit or trim video, crossfades, grade, captions, reframe for vertical, mix sound and loudness with FFmpeg, checked with hildegard review.
---

# Editing video

## Fast path

This skill is all you need to cut clips into a finished piece with titles, a closing card and a music bed, and to check it. Don't write the filter graph by hand. Run `scripts/cut_reel.py` (Python 3, FFmpeg only), or, if you can deliver only one script, paste **Recipe D** and edit its first lines.

1. **Clean a voice recording:** `python3 scripts/clean_voice.py in.wav out.wav --lufs -16` (the same script as in the **hildegard-sound** skill, whose SKILL.md also has it as a paste-in Recipe A).
2. **Music under speech:** `python3 scripts/duck_mix.py voice.wav music.wav out.wav` (hildegard-sound's Recipe B is the paste-in version). With `--total` shorter than the voice it stops and says how many seconds over; it never cuts the voice. Raise `--total`, or add `--allow-overrun`.
3. **A radio spot:** `python3 scripts/spot.py out.wav --music music.wav --sting sting.wav --lines a.wav b.wav c.wav --total 15` (hildegard-sound's Recipe C is the paste-in version). If the lines cannot fit `--total` it stops and says how many seconds over; it never cuts a line. Shorten the lines, raise `--total`, or add `--allow-overrun`.
4. **Cut clips into a reel with titles and music:**

```sh
python3 scripts/cut_reel.py out.mp4 --size 1280x720 --fps 30 --fade 0.4 --total 25 \
  --clip clip_a.mp4@0.5-3.9 --clip clip_b.mp4@0.5-3.9 --clip clip_c.mp4@0.5-3.9 --clip clip_d.mp4@0.5-3.9 \
  --clip clip_a.mp4@6-9.4 --clip clip_b.mp4@5-8.4 --clip clip_c.mp4@3.5-6.9 --clip clip_d.mp4@4-7.4 \
  --music music.wav --lufs -16 --title "Hollis Creek Canoe Rental" --card "Open May to October - Rt 122, Hollis NH"
```

   `--clip FILE@IN-OUT` in seconds, in the order of the cut. Use every clip, and cut each one into two or more shots when the brief wants many cuts: a cut is a change of shot, so four clips used once make three. `--fade 0` gives hard cuts. A vertical clip sits whole over a blurred copy of itself, never stretched. `--total` trims the shots equally to an exact length. The title is a lower third near the start; the card is dark blue, never black.

### Check before you deliver

```sh
python3 scripts/check_video.py out.mp4 --min 22 --max 28 --size 1280x720 --fps 30 --lufs -16 --cuts 5
```

Use the numbers from the brief. Every line must say `OK`: length in range, size and frame rate, H.264 and AAC, loudness within 1 LU of the target, true peak under -1 dBTP (`--peak` changes it), no black stretch over half a second, enough cuts (counted from the picture: crossfades count, motion inside one shot does not). Any `FIX` line says what to change; change it and run again. Then look at the picture: `python3 scripts/contact_sheet.py sheet.png --video out.mp4 --every 2` (or, with Hildegard installed, `hildegard review out.mp4 --sheet sheet.jpg`), and read the titles on the sheet. With no Python, Recipe D prints the same checks at its end.

## Recipe D: cut clips into one piece (paste and edit)

Edit the lines up to `TMP=`: names, size, the `SHOTS` list (`"file in out"`), title, card text, music, target. Length = the sum of (out - in) + `CARDSECS` - `FADE` x the number of shots. Pick the points so it comes to the length you were asked for. It needs `ffmpeg`, `ffprobe`, `awk` and `sed`; the font comes from `fc-match`.

```bash
#!/usr/bin/env bash
# Cut clips into one piece: crossfades, a title, a closing card, a music bed at a loudness target. Edit the lines below, then run: bash edit.sh
# Length = sum of (out - in) + CARDSECS - FADE x (number of shots). Pick the in and out points so it comes to the length you were asked for.
set -euo pipefail
OUT=${OUT:-out.mp4}; W=1280; H=720; FPS=30; FADE=0.4; MUSIC=music.wav; TARGET=-16; PEAK=-1.5
TITLE="Hollis Creek Canoe Rental"; TITLE_AT=0.4; TITLE_SECS=3
CARD="Open May to October - Rt 122, Hollis NH"; CARDSECS=3      # a dark blue closing card, never black
SHOTS=("clip_a.mp4 0.5 3.9" "clip_b.mp4 0.5 3.9" "clip_c.mp4 0.5 3.9" "clip_d.mp4 0.5 3.9" "clip_a.mp4 6 9.4" "clip_b.mp4 5 8.4" "clip_c.mp4 3.5 6.9" "clip_d.mp4 4 7.4")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FONT=$(fc-match -f '%{file}' sans:bold 2>/dev/null || true)
for f in "$FONT" /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf "/System/Library/Fonts/Supplemental/Arial Bold.ttf" /Library/Fonts/Arial.ttf; do [ -f "$f" ] && { FONT=$f; break; }; done
N=${#SHOTS[@]}; IN=(); FC=""; DUR=()
# 1) every shot fitted to the frame (a clip of another shape sits whole over a blurred copy of itself, never stretched), same fps, joined with xfade
for i in $(seq 0 $((N-1))); do read -r F A B <<< "${SHOTS[$i]}"; D=$(awk -v a="$A" -v b="$B" 'BEGIN{print b-a}'); DUR+=("$D")
  IN+=(-ss "$A" -t "$D" -i "$F")
  FC="$FC[$i:v]fps=$FPS,split[b$i][f$i];[b$i]scale=$W:$H:force_original_aspect_ratio=increase,crop=$W:$H,boxblur=24:3[bg$i];[f$i]scale=$W:$H:force_original_aspect_ratio=decrease[fg$i];[bg$i][fg$i]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v$i];"
done
IN+=(-f lavfi -t "$CARDSECS" -i "color=c=0x16324f:s=${W}x${H}:r=$FPS"); FC="$FC[$N:v]format=yuv420p,setsar=1[v$N];"; DUR+=("$CARDSECS")
LAST=v0; ACC=${DUR[0]}
for i in $(seq 1 $N); do
  OFF=$(awk -v a="$ACC" -v f="$FADE" 'BEGIN{print a-f}')
  FC="$FC[$LAST][v$i]xfade=transition=fade:duration=$FADE:offset=$OFF[x$i];"; LAST="x$i"; ACC=$(awk -v o="$OFF" -v d="${DUR[$i]}" 'BEGIN{print o+d}')
done
LEN=$ACC
# 2) the title and the closing card text, burned in (text goes through files, so quotes and colons in it are safe)
printf '%s' "$TITLE" > "$TMP/t1.txt"; printf '%s' "$CARD" > "$TMP/t2.txt"
DT() { echo "drawtext=fontfile='$FONT':textfile='$1':fontcolor=white:fontsize=$2:x=(w-text_w)/2:y=$3:box=1:boxcolor=black@0.45:boxborderw=14:shadowcolor=black@0.6:shadowx=2:shadowy=2:enable='between(t,$4,$5)':alpha='min(1,(t-$4)/0.4)*min(1,($5-t)/0.4)'"; }
CS=$(awk -v l="$LEN" -v c="$CARDSECS" -v f="$FADE" 'BEGIN{print l-c+f+0.3}')
FC="$FC[$LAST]trim=duration=$LEN,setpts=PTS-STARTPTS,$(DT "$TMP/t1.txt" 54 'h*0.78' "$TITLE_AT" "$(awk -v a=$TITLE_AT -v s=$TITLE_SECS 'BEGIN{print a+s}')"),$(DT "$TMP/t2.txt" 40 '(h-text_h)/2' "$CS" "$(awk -v l=$LEN 'BEGIN{print l-0.2}')")[vout]"
ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -filter_complex "$FC" -map "[vout]" -r "$FPS" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -an "$TMP/silent.mp4"
# 3) the music bed: looped if short, cut to length, faded in and out, loudnorm in two passes
ffmpeg -hide_banner -loglevel error -y -stream_loop -1 -i "$MUSIC" -t "$LEN" -af "aformat=channel_layouts=stereo,afade=t=in:d=1,afade=t=out:st=$(awk -v l=$LEN 'BEGIN{print l-1.5}'):d=1.5" -ar 48000 -c:a pcm_f32le "$TMP/raw.wav"
M=$(ffmpeg -hide_banner -i "$TMP/raw.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
v() { printf '%s' "$M" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }
ffmpeg -hide_banner -loglevel error -y -i "$TMP/raw.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:measured_I=$(v input_i):measured_TP=$(v input_tp):measured_LRA=$(v input_lra):measured_thresh=$(v input_thresh):offset=$(v target_offset):linear=true" -ar 48000 -c:a pcm_s16le "$TMP/bed.wav"
ffmpeg -hide_banner -loglevel error -y -i "$TMP/silent.mp4" -i "$TMP/bed.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -t "$LEN" -movflags +faststart "$OUT"
# 4) check: length, black frames over half a second, loudness. Fix and run again if any is off.
echo "length $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s"
ffmpeg -hide_banner -nostats -i "$OUT" -an -vf blackdetect=d=0.5:pix_th=0.1:pic_th=0.98 -f null - 2>&1 | grep black_start || echo "no black frames over half a second"
ffmpeg -hide_banner -nostats -i "$OUT" -vn -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | tail -2
```

If you have **hildegard-craft**, read it first (`references/slop.md` here is its slop catalogue). Editing is where
most slop is either made (transitions, filler, loud music) or removed. Your job is to make it shorter, clearer and
cleaner.

Work on copies. Never overwrite your user's originals; write to a new folder such as `edit/`. Every command below is
plain FFmpeg (any build from 5.0 up). Check a recipe's output and look at the sheet before moving on. With Hildegard
installed, that is `hildegard review <file> --sheet sheet.jpg`. Without Hildegard, it is
`python3 scripts/contact_sheet.py sheet.png --video <file> --every 2` for the sheet, and for the technical checks
(exposure, frozen frames, flicker, colour, black frames, sound clipping; install the packages once with `python3 -m pip install pillow numpy av`; `check_video.py` and the sound scripts need none)
`echo '{"path": "<file>", "sheet": "sheet.jpg", "final": false, "film": true, "audio": true}' > spec.json` then
`python3 scripts/review_media.py spec.json`.

## 0. Look first

```sh
ffprobe -v error -show_entries stream=codec_type,width,height,r_frame_rate,duration -of compact input.mp4
hildegard review input.mp4 --sheet input-sheet.jpg     # or: python3 scripts/contact_sheet.py input-sheet.png --video input.mp4
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
sheets side by side. The review's `colour` check failing means you pushed too far.

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
words against the audio; a wrong caption is worse than none. With Hildegard linked, `transcribe` gives the words with
timings. Without Hildegard, if you can't transcribe the audio, ask your user for the script.

## 7. Sound

- **Fades at every audio cut** (5 to 20 ms) so nothing clicks: `afade=t=in:d=0.01,afade=t=out:st=<END-0.01>:d=0.01`.
- **Music under speech:** don't hand-write a sidechain graph. Use `scripts/duck_mix.py` (or Recipe B of the hildegard-sound skill). It
  drops the music 16 dB while the voice speaks and brings it back in pauses. (If you do write `sidechaincompress` yourself, split the
  voice with `asplit` first: a label can feed only one filter.)

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
hildegard review final.mp4 --final --film --audio --sheet final-sheet.jpg   # Hildegard installed
python3 scripts/check_video.py final.mp4 --lufs -14 --size 1920x1080         # without Hildegard; then the sheet and spec.json checks above, with "final": true
```

Look at the sheet and listen through once. Then tell your user the path, the length, what you cut and why, and
anything you couldn't fix. Keep Hildegard's "made with" label in the file's metadata when the footage is generated.
