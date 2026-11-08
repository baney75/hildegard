# Recipe format for `sfx.py`

A recipe is one JSON object. Copy a file from `presets/` and edit it; every field below appears in one of them.
Run `python3 scripts/sfx.py recipe.json --check` after each change.

## Top level

| Field | Meaning | Range |
|---|---|---|
| `name`, `note`, `vary` | free text; `note` says what it is and how to vary it | text |
| `seed` | random seed (noise, jitter, scatter); same seed, same sound | whole number |
| `duration` | force the file to this many seconds (cut or pad) | 0.02 to 120 |
| `layers` | the sounds that are mixed; at least one | 1 to 24 layers |
| `master` | the chain after the mix | below |

## A layer

A layer is one sound: a **source**, shaped by an amplitude envelope, a filter and distortion, placed in time.

| Field | Meaning | Range |
|---|---|---|
| `source` | `sine`, `triangle`, `saw`, `square` (band-limited), `white`, `pink`, `brown` (noise), `fm`, `sample` | required |
| `dur` | seconds the layer lasts, release included | 0.005 to 60, required |
| `start` | seconds before the layer begins | 0 to 120 |
| `gain_db` | level of this layer in the mix | -60 to 12 |
| `pan` | left -1 to right 1 | |
| `freq` | pitch in Hz or a note name (`"A4"`) | 10 to 20000 |
| `freq_points` | pitch as a curve: `[[seconds, Hz], ...]` | |
| `sweep` | `{"to": Hz, "time": s, "curve": "lin"/"exp"/"fast"}`: glides from `freq` to `to`; `fast` drops quickly then settles | |
| `vibrato` | `{"rate": Hz, "depth_cents": c, "delay": s}` | |
| `pulse_width` | square only | 0.05 to 0.95 |
| `fm` | `{"ratio": r, "index": i}` or `{"index_points": [[s, i], ...]}`: a carrier and a modulator at `freq` x `ratio`; a higher index is brighter and more metallic | |
| `file`, `rate`, `offset` | `sample` only: a WAV (or anything ffmpeg reads) next to the recipe, speed, start offset in seconds | |
| `stereo` | noise only: independent noise in each ear | true or false |
| `env` | amplitude envelope, below | |
| `filter` | `{"type": "lowpass"/"highpass"/"bandpass", "cutoff": Hz or [[s, Hz], ...], "q": 0.3 to 12, "poles": 2 or 4, "lfo": {"rate": Hz, "octaves": n}}` | |
| `distortion` | `{"type": "tanh"/"clip"/"fold"/"crush", "drive_db": 0 to 40, "mix": 0 to 1, "bits": 2 to 16, "down": 1 to 32}` | |
| `events` | repeat or scatter the layer, below | |

**Envelope.** Either `{"attack": s, "decay": s, "sustain": 0 to 1, "release": s}` or `{"points": [[s, level 0 to 1], ...],
"curve": "lin" or "exp"}`. `exp` falls in equal decibel steps, which is how most natural sounds fade. Keep attack plus
decay plus release no longer than `dur`; `--check` warns when it is.

**Filter.** A low-pass removes highs (muffled, distant), a high-pass removes lows (thin, airy), a band-pass keeps a
band (a whoosh, a wind). A `cutoff` curve moves the filter through the sound; a `q` above 1 adds a peak at the cutoff.
`poles: 4` is steeper. Filters are zero-phase, so a very sharp transient can smear a few milliseconds before it.

**Events.** `{"count": n, "interval": s, "jitter": 0 to 1, "decay_db": -3, "gain_jitter_db": 3, "pitch_jitter_cents": 100}`
plays the layer `count` times, `interval` seconds apart, with timing wobble (`jitter`), a gain change each time
(`decay_db`, negative is quieter) and random gain and pitch. Add `"random": true, "span": seconds` to scatter the hits
at random times instead (rain, crackle). Layers that share the same `events` numbers hit together, so a thump, a
click and a scrape make one footstep. Pitch jitter also shifts a noise layer's filter, which varies noise hits.

## Master

| Field | Meaning | Range |
|---|---|---|
| `eq` | list of `{"type": "peak"/"lowshelf"/"highshelf"/"lowcut"/"highcut", "freq", "gain_db", "q"}` | up to 8 |
| `compressor` | `{"threshold_db", "ratio", "attack_ms", "release_ms", "makeup_db"}` | glue and punch |
| `reverb` | `{"mix": 0 to 1, "room": 0 to 1, "damp": 0 to 1, "predelay_ms", "highcut"}`; a small room is 0.2, a hall 0.8 | |
| `width` | 0 mono, 1 as made, 2 twice as wide (bass stays centered) | 0 to 2 |
| `fade` | `{"in": s, "out": s}` | |
| `tail` | extra seconds after the last layer for reverb to ring | 0 to 20 |
| `loudness` | `{"lufs": -40 to -6, "true_peak": -6 to 0, "limit_db": 0 to 20}` | default -18 LUFS, -1 dBTP |
| `normalize` | `false` skips the loudness stage (raw levels; clipping then fails `--check`) | |
| `gain_db` | extra gain before the loudness stage | |

Loudness of very short sounds: a clip under 0.4 s is measured over the whole clip, and a peaky sound (a click, a hit)
may not reach a high target without the limiter working too hard. `--check` then reports "loudness ... from the
target". Lower the target (UI sounds sit around -22 LUFS, beds around -26, hits and whooshes around -20).

## Building a sound that is not in `presets/`

1. Find the nearest preset and copy it. Change one layer at a time.
2. Build in **three parts**: a *transient* (the first 5 to 50 ms: a click, a noise burst), a *body* (what the object
   is: a tone, a rumble, a filtered noise), a *tail* (the space: reverb, a decaying ring).
3. **Size**: bigger things are lower and slower. Halve the pitch and double the decay for a bigger version.
   **Distance**: lower the `cutoff` of a low-pass, raise `reverb.mix`, lower the level.
4. **Variation**: use `events` with `jitter`, `gain_jitter_db` and `pitch_jitter_cents`, so repeated sounds are never
   identical. A single sound used many times in a project: render several seeds (`--seed 1`, `2`, `3`).
5. Keep it short (most effects are under 2 s) and end quietly: the renderer fades the last 10 ms, but a sound that
   ends mid-loud is still audible as a cut.
6. Run `--check`. Read the numbers: duration, loudness, true peak. Report those, and leave the listening verdict to the user.

Recipes for common needs (change the numbers, keep the shape):

| Need | Shape |
|---|---|
| a click | 2 to 3 kHz sine, 60 ms, fast decay, plus a 10 ms high-passed noise burst at -10 dB |
| a bell or chime | `fm` source, `ratio` 3.5, `index_points` falling from 2.4 to 0 over the ring, `env` exp decay of 1 to 1.5 s, a sine at the same pitch at -9 dB, reverb mix 0.25 |
| a whoosh | `pink` stereo noise, band-pass with a `cutoff` curve rising then falling, `env` points rising then falling over 1 s |
| a hit | a sine falling from 130 to 40 Hz over 0.25 s, a brown-noise low-pass tail, a 90 ms noise crack at -8 dB, a compressor, a big reverb |
| a laser | a saw `sweep` from 2.6 kHz to 160 Hz with the `fast` curve, a filter closing, a short noise zap |
| a riser | two detuned saws sweeping up with `exp`, a low-pass opening, noise rising under them, `env` exp up and a hard stop |
| ambience | stereo `pink` and `white` noise bands for the bed, `events` with `random` for details (drops, pops), `fade` in and out |
| a heartbeat or footstep | a falling sine plus filtered noise, `events` with `jitter` |
