# Soundscape format for `soundscape.py`

Long, seamless, non-repeating audio: binaural beats, isochronic tones, noise colors and nature beds, mixed. Copy a file
from `soundscapes/` and edit it. Run `python3 scripts/soundscape.py recipe.json --check` after each change.

```
python3 scripts/soundscape.py recipe.json out.wav             render
python3 scripts/soundscape.py recipe.json --check             validate, and render three sample windows to estimate the level
python3 scripts/soundscape.py --preset ocean_beach out.wav --minutes 60
options: --minutes M | --seconds S   a new length (the timelines in the recipe stretch with it)
         --seed N   --chunk S   --bits 16|24   --json   --sheet out.png   .mp3 and .ogg outputs need ffmpeg
```

## What it guarantees, and what it does not

- **Seamless.** Every sound is a function of absolute time with seeded randomness, and the file is rendered in chunks
  (30 s by default). A chunked render is byte for byte the same file as a one-pass render, so there is no seam at a chunk
  join, and memory stays flat whether the file is 10 minutes or 3 hours.
- **Non-repeating.** Nothing is looped. Waves arrive at irregular gaps and sizes in sets, rain drops and crackles are
  random events, wind gusts wander, crickets drift in and out of step. Two hours is two hours of new events.
- **Exact length.** The file has exactly the samples asked for (`--check` fails if it does not).
- **Loudness.** Measured as the file is written (ITU-R BS.1770, streaming) and trimmed until it is within 0.1 LU of the
  target (default -20 LUFS; the presets use -22 to -26 for quiet beds), with the true peak under -1 dBTP.
- **Time to render.** About 6 to 10 times faster than real time for a four-layer mix on one core: a one hour file takes
  roughly 6 to 10 minutes. The terminal shows progress on files over two minutes.
- **Disk.** 16-bit stereo WAV is about 10 MB a minute (600 MB an hour). Use `.mp3` for a small file.

**Binaural beats need stereo headphones.** Each ear hears one pure tone (for example 195 Hz and 205 Hz), and the beat
(10 Hz) exists only in the listener's head. On speakers the two tones mix into an ordinary tremolo. No claim is made that any beat frequency
does anything for anyone's health, sleep, focus or mood; the skill never says so and neither should the delivery.
**Isochronic tones** switch one tone on and off at the chosen rate and work on speakers. Keep levels low and tell the
user to stop if it is unpleasant.

## Recipe

| Field | Meaning | Range |
|---|---|---|
| `name`, `note`, `vary` | free text | |
| `seed` | random seed; same seed, same file | whole number |
| `minutes` or `seconds` | the length (default 10 minutes) | 3 s to 24 h |
| `layers` | what is mixed | 1 to 16 |
| `master.loudness` | `lufs` -40 to -6 (default -20) and `true_peak` (default -1) | |
| `master.fade` | `{"in": s, "out": s}`, default 5 percent of the length up to 10 s | |
| `master.chunk_s` | chunk length for rendering | 4 to 120 |
| `master.gain_db` | extra gain before the loudness stage (rarely needed) | |

Every layer has `type`, `gain_db` (-60 to 12) and optional `automation`, a list of `[minute, dB]` points that moves
the layer's level through the piece (use -80 for silence). At `gain_db` 0 every layer type has about the same loudness,
so `gain_db` is a fair mixer: a bed at 0, a detail at -8, a tone under it at -12. Types:

| `type` | What it makes | Fields |
|---|---|---|
| `binaural` | a pure tone per ear, a set beat apart | `carrier_hz` 50 to 1000 (default 200), `beat_hz` 0.5 to 40, or `stages`, `ramp_s`, `split` (`symmetric` puts the carrier in the middle, `right` keeps the left ear on it) |
| `isochronic` | one tone gated on and off | `carrier_hz`, `rate_hz` 0.5 to 40 or `stages`, `ramp_s`, `duty` 0.1 to 0.9, `softness` 0.05 to 1, `depth` 0.2 to 1 |
| `noise` | white, pink or brown noise, slowly drifting in level | `color`, `lowpass`, `highpass` (Hz), `width` 0 (same in both ears) to 1 (independent) |
| `waves` | ocean waves on a beach | `period_s` 4 to 24 (the gap between swells), `intensity` 0 to 1, `foam` 0 to 1, `distance` 0 (shore) to 1 (far), `width` |
| `rain` | rain drops over a hiss | `intensity` 0 to 1 or a curve `[[minute, 0 to 1], ...]`, `surface`: `roof`, `leaves`, `ground`, `window` |
| `wind` | gusting wind with a rustle and a whistle | `strength` 0 to 1, `gustiness` 0 to 1, `whistle` 0 to 1 |
| `creek` | running water with bubbles | `flow` 0 to 1, `brightness` 0 to 1 |
| `crickets` | night insects in different pitches and tempos | `count` 1 to 12, `pitch_hz` 2500 to 6500, `tempo` 0.5 to 2, `distance` 0 to 1 |
| `fire` | roar, hiss, crackles in clusters, pops | `roar` 0 to 1, `crackle` 0 to 1 |
| `pad` | a soft evolving drone from a few notes | `notes` (up to 8, names like `"A2"` or Hz), `brightness`, `motion` |

A field that does not belong to the layer's type fails `--check` and the message lists the fields the type takes.

### Stages (binaural and isochronic)

```json
{"type": "binaural", "carrier_hz": 200, "ramp_s": 90,
 "stages": [{"beat_hz": 14, "minutes": 5}, {"beat_hz": 10, "minutes": 8}, {"beat_hz": 6, "minutes": 10}, {"beat_hz": 3, "minutes": 7}]}
```

Each stage holds its value and then glides (a smooth curve, not a jump) into the next over `ramp_s` seconds (at most
half the stage). The last stage holds to the end. A stage may also set its own `carrier_hz`. The stages should add up
to the piece length; `--check` warns when they do not. Asking for a new length with `--minutes` stretches the stages
and every `automation` and `intensity` curve in proportion, so the same journey takes longer or shorter.

## Mixing rules that work

- **One bed, one or two details, one tone.** For example waves (0 dB), rain on leaves (-8), a pad (-11), a binaural
  tone (-12). More layers than that smear into noise.
- **Keep the carrier clear.** A binaural carrier at 200 Hz is masked by anything loud near it. Keep pad notes at least
  15 Hz away from 190 to 215 Hz, and keep the tone no more than 10 dB under the bed.
- **Match the places.** Waves belong with wind and gulls' absence; crickets with a creek and a faint wind; rain with a
  fire or a roof. Do not put waves and crickets in the same scene.
- **Quiet is the point.** Beds sit at -22 to -26 LUFS. For sleep, lower the target rather than raising it.
- **Check what you made.** Add `--sheet out.png` and look at it: the loudness curve should be flat (or follow the
  automation you wrote), the spectrogram should show the bands you expect, and a binaural layer prints its measured
  beat for each stage in the report.

## What `--check` measures in the file

The length in samples, integrated loudness, true peak, clipped samples, DC offset, silence, and, for each binaural or
isochronic layer, the beat or rate measured from the output at the middle of long steady stages (a windowed FFT with a
parabolic peak fit, accurate to a few hundredths of a hertz). A measured value more than 0.1 Hz from the recipe is an
error. The binaural report also gives the frequency each ear actually carries.
