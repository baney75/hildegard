---
name: hildegard-video-edit
description: Edit video with FFmpeg to a professional standard - cut, trim, assemble, colour-grade, stabilise, reframe for vertical, add captions, music and voice-over, and master loudness - on footage from Hildegard or from the user. Use when asked to edit, cut, trim, grade, caption, reframe, mix or finish a video. Checks every output with hildegard review.
---

# Editing video

Read **hildegard-craft** first. Editing is where most slop is either made (transitions, filler, loud music) or
removed. Your job is to make it shorter, clearer and cleaner.

Work on copies. Never overwrite your user's originals; write to a new folder such as `edit/`. Every command below is
plain FFmpeg (any build from 5.0 up). Check a recipe's output with `hildegard review <file> --sheet sheet.jpg` and look
at the sheet before moving on.

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
