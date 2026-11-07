---
name: hildegard-sound
description: Clean up a voice recording, remove hum or hiss, podcast or sermon audio, loudness, music under a voice-over, radio spot, mix and master with FFmpeg, plus speech and sound design for Hildegard films.
---

# Sound

## Fast path

This skill is all you need to clean a voice, put music under it, build a spot and measure the result. Don't write a filter graph, a gain curve or a ducking envelope of your own: the recipes below are tested and yours won't be. Run a script from `scripts/` (Python 3, FFmpeg only), or, if you can deliver only one script, copy a recipe from below exactly and change only the file names and numbers on its first lines.

1. **Clean a voice recording** (hum, hiss, rumble, quiet passages, loudness): `python3 scripts/clean_voice.py voice_raw.wav out.wav --lufs -16 --peak -1.5`, or paste **Recipe A**.
2. **Music under speech** (announcement, sermon, voice-over): `python3 scripts/duck_mix.py voice.wav music.wav out.wav --voice-start 4 --fade-in 3 --tail 4 --fade-out 4`, or paste **Recipe B**. The music drops 16 dB under the voice and rises in pauses.
3. **A radio spot** (lines in order, a bed, a sting, an exact length): `python3 scripts/spot.py out.wav --music music.wav --sting sting.wav --lines line1.wav line2.wav line3.wav --total 15`, or paste **Recipe C**.
4. **Cut clips into a reel with titles and music**: the **hildegard-video-edit** skill, if you have it.

Pasting: copy the recipe into your one script, edit the first lines (file names, times, target), run it on the real files, then run the check below. Recipes A to C write a WAV; the file names in them are the ones the brief gave.

### Check before you deliver

Run `python3 scripts/measure.py out.wav --lufs -16 --peak -1` (use the targets from the brief). With no Python, read the last two lines each recipe prints.

- Loudness within 1 LU of the target, and true peak at or under the limit. If not, run the recipe again; never ship a miss.
- Length and timing as asked (a spot to the second, music up to the word you were told).
- `hum` lines say `clean`. If one says `HUM`, the notch step did not run; fix that and measure again.
- No `CLIPPING`.

Then listen to a few seconds of the quiet parts and the loudest part, and say what you changed and what the numbers are.

## Recipes to paste

Each one is tested on recordings with hum at 50 and 60 Hz, heavy rumble, heavy hiss, big level dips, pops and clipped peaks. They need only `ffmpeg`, `ffprobe`, `awk` and `sed`.

### Recipe A: clean a voice recording

Hum notches at 50 and 60 Hz and their harmonics, a steep rumble cut, hiss reduction, clicks and clipped peaks, near and far passages evened out, quieter pauses with a little room tone (pauses are never dead silent), gentle compression, then loudnorm in two passes. Mono or stereo; same length and sample rate.

```bash
#!/usr/bin/env bash
# Clean a voice recording and deliver it at a loudness target. Edit IN, OUT, TARGET and PEAK on the next lines, then run: bash process.sh
set -euo pipefail
IN=${IN:-voice_raw.wav}; OUT=${OUT:-out.wav}; TARGET=${TARGET:--16}; PEAK=${PEAK:--1.5}
SR=$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 "$IN")
CH=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$IN"); LAYOUT=mono; [ "$CH" -ge 2 ] && LAYOUT=stereo
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# Hum: narrow notches at 50 and 60 Hz and their harmonics (mains is one or the other; notching both costs nothing).
HUM=""; for f in 50 60 100 120 150 180 200 240 250 300; do HUM="$HUM,bandreject=f=$f:width_type=q:w=25"; done
# Rumble: nothing below 85 Hz. The FIR delays the sound 0.1 s and each denoiser 0.025 s, so trim that back (length and timing stay).
RUMBLE="firequalizer=gain_entry='entry(0,-100);entry(85,-100);entry(115,0);entry(24000,0)':delay=0.1:accuracy=1,atrim=start=0.1,asetpts=PTS-STARTPTS"
# 1) rumble, hum, hiss (low-pass and two denoise passes), clicks and clipped peaks; even out near and far; gentle compression.
ffmpeg -hide_banner -loglevel error -y -i "$IN" -af "${RUMBLE}${HUM},lowpass=f=10000,adeclick,adeclip,afftdn=nr=30:nf=-35:tn=1,afftdn=nr=30:nf=-45:tn=1,atrim=start=0.05,asetpts=PTS-STARTPTS,apad=whole_dur=$DUR,dynaudnorm=f=200:g=15:p=0.9:m=14:s=5,acompressor=threshold=-21dB:ratio=3:attack=8:release=160:makeup=2" -t "$DUR" -ar "$SR" -c:a pcm_f32le "$TMP/s1.wav"
# 2) quieter pauses: a gate whose threshold is measured from this file (between its floor and its speech level), then a little room tone.
LV=$(ffmpeg -hide_banner -nostats -i "$TMP/s1.wav" -af "asetnsamples=n=4410:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" -f null - 2>/dev/null | sed -n 's/.*RMS_level=//p' | grep -v inf | sort -n)
N=$(printf '%s\n' "$LV" | wc -l)
FLOOR=$(printf '%s\n' "$LV" | sed -n "$((N/10+1))p"); SPEECH=$(printf '%s\n' "$LV" | sed -n "$((N*9/10+1))p")
THR=$(awk -v f="$FLOOR" -v s="$SPEECH" 'BEGIN{t=f+(s-f)*0.3; if(t<f+4)t=f+4; if(t>s-15)t=s-15; if(t<f)t=f; t=10^(t/20); if(t<0.001)t=0.001; if(t>1)t=1; printf "%.4f", t}')
ffmpeg -hide_banner -loglevel error -y -i "$TMP/s1.wav" -f lavfi -i "anoisesrc=color=pink:amplitude=0.004:sample_rate=$SR:duration=$DUR" -filter_complex "[0:a]agate=threshold=$THR:ratio=4:range=0.03:attack=5:release=250:detection=rms[a];[1:a]aformat=channel_layouts=$LAYOUT[n];[a][n]amix=inputs=2:duration=first:normalize=0" -ar "$SR" -c:a pcm_f32le "$TMP/s2.wav"
# 3) loudness in two passes: measure, then apply with the measured values and linear=true, so it lands on the target.
M=$(ffmpeg -hide_banner -i "$TMP/s2.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
v() { printf '%s' "$M" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }
ffmpeg -hide_banner -loglevel error -y -i "$TMP/s2.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:measured_I=$(v input_i):measured_TP=$(v input_tp):measured_LRA=$(v input_lra):measured_thresh=$(v input_thresh):offset=$(v target_offset):linear=true" -ar "$SR" -c:a pcm_s16le "$OUT"
# 4) what you delivered: integrated loudness and true peak. Compare them with the target; if off, fix and run again.
ffmpeg -hide_banner -nostats -i "$OUT" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | tail -2
```

### Recipe B: music under a voice-over

Edit `START` (seconds of music before the voice), `FADEIN`, `FADEOUT`, `TAIL` (seconds after the last word) and the target. The music drops 16 dB while the voice speaks and comes back in pauses of 0.6 s or more. It is read from the voice with silencedetect, so it needs no sidechain graph.

```bash
#!/usr/bin/env bash
# Music under a voice-over: the music drops 16 dB while the voice speaks and comes back in pauses of 0.6 s or more. Edit the names and
# numbers on the next lines, then run: bash process.sh
set -euo pipefail
VOICE=${VOICE:-voice.wav}; MUSIC=${MUSIC:-music.wav}; OUT=${OUT:-out.wav}
START=${START:-4}; FADEIN=${FADEIN:-3}; FADEOUT=${FADEOUT:-4}; TAIL=${TAIL:-4}; DUCK=${DUCK:-16}; REL=${REL:--8}
TARGET=${TARGET:--16}; PEAK=${PEAK:--1.5}; TOTAL=${TOTAL:-}   # TOTAL empty = START + the voice's last word + TAIL
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# 1) where the voice speaks: silencedetect finds pauses of 0.6 s or more; speech is what lies between them.
VD=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VOICE")
MEAN=$(ffmpeg -hide_banner -i "$VOICE" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB.*/\1/p')
NOISE=$(awk -v m="$MEAN" 'BEGIN{n=m-16; if(n>-30)n=-30; if(n<-55)n=-55; print n}')
ffmpeg -hide_banner -i "$VOICE" -af "silencedetect=noise=${NOISE}dB:d=0.6" -f null - 2>&1 | grep -o 'silence_\(start\|end\): [0-9.]*' > "$TMP/sil.txt" || true
# The music gain curve: 1 = full, 10^(-DUCK/20) while the voice speaks, with ramps of 0.3 s before and 0.5 s after each stretch of speech.
SEG=$(awk -v vd="$VD" '/start/{s[++n]=$2} /end/{e[++m]=$2} END{a=0; for(i=1;i<=n;i++){ if(s[i]>a+0.05) print a, s[i]; a=(i<=m)?e[i]:vd } if(a<vd-0.05) print a, vd}' "$TMP/sil.txt")
EXPR=$(printf '%s\n' "$SEG" | awk -v st="$START" -v d="$DUCK" 'BEGIN{g=10^(-d/20)} {a=$1+st; b=$2+st; x=x (x?"+":"") sprintf("clip((t-%.3f)/0.3,0,1)*clip((%.3f-t)/0.5,0,1)", a-0.3, b+0.5)} END{printf "1-(1-%.5f)*min(1,%s)", g, x}')
LASTEND=$(printf '%s\n' "$SEG" | awk 'END{print $2}')
[ -n "$TOTAL" ] || TOTAL=$(awk -v s="$START" -v e="$LASTEND" -v t="$TAIL" 'BEGIN{printf "%.2f", s+e+t}')
# 2) music level: set REL dB from the voice's own loudness, before ducking.
lufs() { ffmpeg -hide_banner -nostats -i "$1" ${2:-} -af ebur128 -f null - 2>&1 | sed -n 's/.*  I: *\(-*[0-9.]*\) LUFS.*/\1/p' | tail -1; }
VL=$(lufs "$VOICE"); ML=$(lufs "$MUSIC")
MG=$(awk -v v="$VL" -v m="$ML" -v r="$REL" 'BEGIN{printf "%.2f", v+r-m}')
# 3) mix: voice delayed by START, music looped if short, cut to TOTAL, ducked, faded in and out.
ffmpeg -hide_banner -loglevel error -y -i "$VOICE" -stream_loop -1 -i "$MUSIC" -filter_complex "[0:a]aformat=channel_layouts=stereo,afade=t=in:d=0.01,adelay=${START}s:all=1[v];[1:a]aformat=channel_layouts=stereo,atrim=duration=$TOTAL,asetpts=PTS-STARTPTS,volume=${MG}dB,volume='$EXPR':eval=frame:precision=float,afade=t=in:d=$FADEIN,afade=t=out:st=$(awk -v t=$TOTAL -v f=$FADEOUT 'BEGIN{print t-f}'):d=$FADEOUT[m];[v][m]amix=inputs=2:duration=longest:normalize=0" -t "$TOTAL" -c:a pcm_f32le "$TMP/mix.wav"
# 4) loudness in two passes, then what you delivered.
M=$(ffmpeg -hide_banner -i "$TMP/mix.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
v() { printf '%s' "$M" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }
SR=$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 "$VOICE")
ffmpeg -hide_banner -loglevel error -y -i "$TMP/mix.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:measured_I=$(v input_i):measured_TP=$(v input_tp):measured_LRA=$(v input_lra):measured_thresh=$(v input_thresh):offset=$(v target_offset):linear=true" -ar "$SR" -c:a pcm_s16le "$OUT"
ffmpeg -hide_banner -nostats -i "$OUT" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | tail -2
```

### Recipe C: a radio spot

Edit `LINES`, `TOTAL`, `FIRST` (seconds before line 1), `GAP` (quiet between lines). Each line is cut to its speech, the sting ends 0.1 s before the end, and the music fades out under it. If the lines and sting do not fit, the gaps shrink to 0.3 s first.

```bash
#!/usr/bin/env bash
# A radio spot: voice lines in order over a ducked music bed, a closing sting, an exact length. Edit the names and numbers on the next
# lines, then run: bash process.sh
set -euo pipefail
OUT=${OUT:-out.wav}; TOTAL=${TOTAL:-15}; MUSIC=${MUSIC:-music.wav}; STING=${STING:-sting.wav}
LINES=(line1.wav line2.wav line3.wav)
FIRST=${FIRST:-0.5}; GAP=${GAP:-0.5}; DUCK=${DUCK:-16}; REL=${REL:--8}; TARGET=${TARGET:--16}; PEAK=${PEAK:--1.5}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
lufs() { ffmpeg -hide_banner -nostats -i "$1" -af ebur128 -f null - 2>&1 | sed -n 's/.*  I: *\(-*[0-9.]*\) LUFS.*/\1/p' | tail -1; }
# 1) cut each line to its speech plus 50 ms either side; remember the silence each one had before and after.
n=0; : > "$TMP/rows.txt"
for f in "${LINES[@]}"; do n=$((n+1))
  L=$(dur "$f")
  ffmpeg -hide_banner -loglevel error -y -i "$f" -af "silenceremove=start_periods=1:start_threshold=-50dB" "$TMP/a.wav"; L1=$(dur "$TMP/a.wav")
  ffmpeg -hide_banner -loglevel error -y -i "$TMP/a.wav" -af "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse" "$TMP/b.wav"; S=$(dur "$TMP/b.wav")
  ffmpeg -hide_banner -loglevel error -y -i "$f" -af "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,afade=t=in:d=0.01,aformat=channel_layouts=stereo" -ar 44100 "$TMP/l$n.wav"
  echo "$(dur "$TMP/l$n.wav") $(awk -v l="$L" -v l1="$L1" 'BEGIN{print l-l1}') $(awk -v l1="$L1" -v s="$S" 'BEGIN{print l1-s}')" >> "$TMP/rows.txt"
done
SL=$(dur "$STING")
# 2) timeline: gap between speech = GAP (never less than the recordings' own quiet ends need); the sting ends 0.1 s before TOTAL.
read -r STARTS STS < <(awk -v first="$FIRST" -v gap="$GAP" -v total="$TOTAL" -v sl="$SL" '
 {d[NR]=$1; lead[NR]=$2; trail[NR]=$3} END{
  for(i=1;i<NR;i++){ g[i]=trail[i]+lead[i+1]+0.02; if(g[i]<gap)g[i]=gap }
  latest=total-0.1-sl; f=first
  for(pass=0;pass<2;pass++){ t=f-0.05; for(i=1;i<=NR;i++){ p[i]=t; t+=d[i]; if(i<NR)t+=g[i]-0.1 } endl=t-0.05
    if(endl+0.05<=latest)break
    if(pass==0){ for(i=1;i<NR;i++){ m=trail[i]+lead[i+1]+0.02; if(m<0.3)m=0.3; over=endl+0.05-latest; g[i]-=over/(NR-1); if(g[i]<m)g[i]=m }; f=0.3 } }
  for(i=1;i<=NR;i++) s=s (i>1?",":"") sprintf("%.3f",p[i]); printf "%s %.3f\n", s, latest }' "$TMP/rows.txt")
echo "files start at $STARTS; sting at $STS" >&2
IFS=, read -ra ST <<< "$STARTS"
# 3) the voice stem
IN=(); FC=""; MIXIN=""; for i in $(seq 1 $n); do IN+=(-i "$TMP/l$i.wav"); ms=$(awk -v s="${ST[$((i-1))]}" 'BEGIN{printf "%d", s*1000}'); FC="$FC[$((i-1)):a]adelay=${ms}:all=1[d$i];"; MIXIN="$MIXIN[d$i]"; done
ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -filter_complex "${FC}${MIXIN}amix=inputs=$n:duration=longest:normalize=0,apad=whole_dur=$TOTAL" -t "$TOTAL" -ar 44100 -c:a pcm_f32le "$TMP/voice.wav"
VL=$(lufs "$TMP/voice.wav"); ML=$(lufs "$MUSIC"); SLU=$(lufs "$STING")
MG=$(awk -v v="$VL" -v m="$ML" -v r="$REL" 'BEGIN{printf "%.2f", v+r-m}'); SG=$(awk -v v="$VL" -v m="$SLU" 'BEGIN{printf "%.2f", v-3-m}')
# 4) the duck curve: down 0.15 s before each line, back up 0.25 s after
EXPR=$(for i in $(seq 1 $n); do awk -v a="${ST[$((i-1))]}" -v d="$(dur "$TMP/l$i.wav")" 'BEGIN{printf "%.3f %.3f\n", a, a+d}'; done | awk -v dk="$DUCK" 'BEGIN{g=10^(-dk/20)} {x=x (x?"+":"") sprintf("clip((t-%.3f)/0.15,0,1)*clip((%.3f-t)/0.25,0,1)", $1-0.15, $2+0.25)} END{printf "1-(1-%.5f)*min(1,%s)", g, x}')
STMS=$(awk -v s="$STS" 'BEGIN{printf "%d", s*1000}')
ffmpeg -hide_banner -loglevel error -y -i "$TMP/voice.wav" -stream_loop -1 -i "$MUSIC" -i "$STING" -filter_complex "[1:a]aformat=channel_layouts=stereo,atrim=duration=$TOTAL,asetpts=PTS-STARTPTS,volume=${MG}dB,volume='$EXPR':eval=frame:precision=float,afade=t=in:d=0.02,afade=t=out:st=$(awk -v t=$TOTAL 'BEGIN{print t-0.9}'):d=0.9[m];[2:a]aformat=channel_layouts=stereo,volume=${SG}dB,afade=t=in:d=0.005,afade=t=out:st=$(awk -v s=$SL 'BEGIN{print s-0.4}'):d=0.4,adelay=${STMS}:all=1[s];[0:a][m][s]amix=inputs=3:duration=longest:normalize=0" -t "$TOTAL" -c:a pcm_f32le "$TMP/mix.wav"
# 5) loudness in two passes, then what you delivered.
M=$(ffmpeg -hide_banner -i "$TMP/mix.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
v() { printf '%s' "$M" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }
ffmpeg -hide_banner -loglevel error -y -i "$TMP/mix.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:measured_I=$(v input_i):measured_TP=$(v input_tp):measured_LRA=$(v input_lra):measured_thresh=$(v input_thresh):offset=$(v target_offset):linear=true" -ar 44100 -c:a pcm_s16le "$OUT"
ffmpeg -hide_banner -nostats -i "$OUT" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | tail -2
```

## Why the recipes look like this

Keep these if you must change one.

- **Hum is 50 Hz or 60 Hz, plus harmonics.** Notch both families and the first five harmonics. A high-pass alone leaves it.
- **Rumble is below 80 Hz.** Cut it with a steep filter (the FIR here); a gentle one leaves a hump near 60 Hz.
- **Denoise before you level.** Leveling lifts the hiss with the quiet words. Then gate the pauses and add room tone.
- **Loudness takes two passes.** One pass of `loudnorm` misses the target. Measure, then apply the measured values with `linear=true`. Check the result with `ebur128`.
- **Duck at least 12 dB** (16 here), starting 0.3 s before the voice and recovering over 0.5 s after it. Ducking 5 dB is not ducking.
- **No sidechain unless you split the voice.** A label can feed only one filter. If you write `sidechaincompress`, split the voice with `asplit` first. The gain curve in Recipe B avoids the problem.
- **Fades of 5 to 20 ms at every cut,** so nothing clicks.
- **Length is exact.** Set it with `-t`, and fade the last second.

## What Hildegard has

Everything above needs only FFmpeg and Python. The rest of this section is for when Hildegard is linked: `hildegard_status`
and `list_presets` show what's installed; `list_voices` shows the voices. Without Hildegard: for speech, use the voice
tool your user has (or have them record it), and for transcripts any transcription tool; the cleaning, ducking, spot and
measuring scripts work on any file.

- **Speech:** `speak` turns a script into speech on the owner's GPU, in a voice from `list_voices`. Act a line with
  tags in square brackets (`[whispers]`, `[laughs]`) and `[pause 0.5s]`; give one line of `direction` ("warm, close
  to the mic"). `design_voice` makes a new voice from a description, and `keep_designed_voice` saves it.
- **Changing and reading speech:** `convert_voice` says a recording in another voice, `transcribe` turns speech into
  text with timings, and `dub` does both into another language. Long jobs return an id: poll `voice_job_status`.
- **Cloning a real person's voice** happens only in the Studio, with that person reading a fresh consent line aloud.
  `clone_voice` explains it; you can't start one. Never imitate a real person's voice any other way.
- **Sound with picture:** LTX makes sound together with its video, from the prompt: say what is heard ("rain on a
  tin roof, a kettle starting to whistle"). Wan makes none.
- **Music:** Hildegard has no music model. Use music your user provides or a library track with a license that
  allows the use, write a brief for a music model they run elsewhere (below), and mix it with Recipe B.
- If a voice model isn't installed, `install_voice_model` downloads it. Its first call returns the license terms:
  show them to your user word for word, and call again with `accept_license` only if they say yes.

## Music

If you have **hildegard-craft**, read it first for anything Hildegard makes; `references/slop.md` here is its slop
catalogue, with a Sound section. Generic "epic" music and robotic narration are the sound of slop.

A music brief, not a mood word:

- **Form and length:** "45 s: 8 bars intro, verse, lift at 0:28 on the door opening, ring out".
- **Tempo and key:** "78 BPM, D minor".
- **Instruments:** "felt piano, upright bass, brushed snare, no synth pads".
- **Era or scene:** "late-night jazz club, 1958", by qualities, not by an artist's name.
- **Where it sits:** under dialogue (sparse, no lead melody where words are) or in front (a music video).

Lint lyrics with `review_prompt` and `medium: "music"` (Hildegard linked); without it, check them against the Sound
section of `references/slop.md`. Stock lines ("set me free", "into the night") are slop. Write lyrics from one
concrete scene.

## Voice

- **Consent first.** Never clone or imitate a real person's voice without their clear permission. Refuse and say why.
- Write for speaking: short sentences, one idea each, punctuation where a breath goes. Read it aloud in your head.
- Lint narration with `review_prompt` and `medium: "voice"` (Hildegard linked); without it, against the Sound section
  of `references/slop.md`.
- Generate line by line, so a bad line can be redone alone. Listen to every line; re-generate any that are flat,
  rushed or mispronounced.

### A person's own voice, for a voice-over

You can't use your user's microphone from a chat, so ask Hildegard for a page that can. `record_link` with
`kind: "voice"` and a short `purpose` gives a link that works once for 30 minutes. Show your user the link and the
sentence it comes with, then call `recording_status` until it says received. The link is a secret for that person:
don't paste it anywhere else. Then `clean_voice` with the `media_id`: it takes out hum, rumble, clicks and room noise,
evens the level and sets it to -16 LUFS with the true peak under -1.5 dB (`target_lufs` and `peak` change that), and
returns the loudness it measured. Listen to the cleaned file before you use it. The cleanup chain lives in one place,
`tools/voice_clean.py`; point to that file and don't write the filters out again.

Put it over a film with `export_film` and `voiceover: { media_id }`. The film's own sound ducks 12 dB while the voice
speaks (`duck_db`), `start_seconds` and `gain_db` place and level it, and the mix is set to -14 LUFS and -1 dBTP at the
film's length. For video of a person, `record_link` with `kind: "video"`; `clean_voice` cleans its sound and keeps
the picture.

## Sound design

Every shot has a sound even if nothing "happens": a room tone, wind, distant traffic. Silence reads as broken. Layer:

1. **Ambience** for the place, continuous across cuts in the same place.
2. **Effects** for things we see (footsteps, a door, a cup set down), in sync with the frame.
3. **Music and voice** on top.

Change the ambience exactly on the cut when the place changes; overlap it a few frames (a J or L cut) to carry the
viewer across.

## Mix and master

- Speech is the reference: everything else sits under it.
- Duck music under speech with Recipe B or `duck_mix.py`.
- Master to about -14 LUFS integrated with true peak under -1 dB for a film (speech-only: -16 LUFS), with the two-pass loudnorm in the recipes.
- Check: `python3 scripts/measure.py final.wav` (it reads a finished video's sound too; with Hildegard installed,
  `hildegard review final.mp4 --audio` also works). `clipping` or `loudness` failing means fix the mix, not the
  limiter.

## Deliver

Listen through once, start to end, before you say it's done. Tell your user what is in the mix, its loudness, and
where any sound came from (generated, their files, a library and its license).
