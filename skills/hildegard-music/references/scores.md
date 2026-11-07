# Score format for `music.py`

A score is one JSON object. Copy a file from `templates/` and edit it; every field below appears in one of them.
Run `python3 scripts/music.py score.json --check` after each change.

## Top level

| Field | Meaning | Range or values |
|---|---|---|
| `name`, `note`, `vary` | free text; `note` says what the piece is, `vary` lists the safe knobs | text |
| `seed` | the random seed for humanizing; same seed, same audio | whole number |
| `tempo` | quarter notes per minute (a 6/8 bar is 3 quarters) | 40 to 220 |
| `key` | tonic and mode, for example `"G major"`, `"A minor"`, `"D dorian"` | modes: major, minor, dorian, mixolydian, lydian, phrygian |
| `time` | time signature | 2/4, 3/4, 4/4, 5/4, 6/8, 9/8, 12/8 |
| `swing` | pushes off-beat eighths toward a triplet feel | 0 straight to 1 full triplet |
| `length_s` | exact file length in seconds; cuts or pads after the last bar's ring-out | 2 to 900 |
| `sections` | the form, in order | see below |
| `tracks` | the players | see below |
| `humanize` | `timing_ms` 0 to 40 and `velocity` 0 to 0.4, for the whole piece | defaults 8 and 0.08 |
| `mix.reverb` | `room` 0 to 1, `damp` 0 to 1, `predelay_ms`, `level_db` of the reverb return, `highcut` | |
| `master` | `loudness` {`lufs`, `true_peak`, `limit_db`}, `eq`, `compressor`, `width`, `fade_in`, `fade_out`, `tail`, `gain_db`, `normalize` | default -14 LUFS, -1 dBTP |

`master.normalize: false` turns the loudness stage off; use it only to see raw levels, because a mix that goes past full
scale then fails `--check` as clipping.

## Sections and chords

```json
"sections": [
  {"name": "intro", "bars": 2, "chords": ["I", "V"]},
  {"name": "verse", "bars": 8, "chords": ["I", "V", "vi", "IV"]}
]
```

- `bars` is the length. `chords` is one entry per bar and **cycles** to fill the bars (four chords in eight bars play
  twice). A bar with two chords: `"I|V"` (each gets half the bar). Four chords in a bar: `"I|ii|V|I"`.
- A chord is a **roman numeral** or a **name**.
  - Roman: `I ii iii IV V vi vii` (capital is major, lower case is minor), with `b` or `#` in front for a lowered or
    raised root (`bVII`), and endings: `7` (dominant 7th, or minor 7th on a lower-case numeral), `maj7`, `6`, `9`,
    `add9`, `sus2`, `sus4`, `dim` or `°`, `aug` or `+`. Examples: `I`, `vi7`, `Imaj7`, `V7`, `bVII`, `IVadd9`, `V/3` (V with
    its third in the bass). Roots follow the key's own scale: in A minor, `III` is C major and `VII` is G major.
  - Name: `C`, `Am`, `F#m7`, `Bbmaj7`, `Gsus4`, `G/B`. Names do not move when you change `--key`; numerals do.
- Sections with the same `name` can repeat; tracks look up their content by section name.
- Four or eight bars make a real phrase. A section of 3 or 5 bars is legal but rarely musical.

## Tracks

```json
{"role": "keys", "instrument": "felt_piano", "level_db": -5, "pan": -0.2, "reverb": 0.25,
 "sections": {"verse": "half", "chorus": {"pattern": "ballad", "gain_db": -3}}}
```

`sections` maps a section name to what the track plays there (`"*"` means every section not named). A section the track
does not mention is silent. A value is a pattern name (or melody text for `melody` and `chorale`), or an object with
`pattern` or `melody`, and `gain_db` (-40 to 12) for that section only.

| Track field | Meaning | Range |
|---|---|---|
| `role` | `pad`, `bass`, `keys`, `plucked`, `melody`, `chorale`, `drums` | required |
| `instrument` | one from the list below (drums use `kit`) | default per role |
| `kit` | drums only: `acoustic`, `electronic`, `lofi`, `soft` | |
| `level_db` | track level before mastering | -40 to 12 |
| `pan` | left -1 to right 1 | |
| `reverb` | send to the shared reverb | 0 to 1 |
| `duck` | dip this track by this many dB on every kick, so the kick stays clear | 0 to 18; `duck_release_ms` 40 to 800 |
| `lowcut`, `highcut` | filter this track in Hz | |
| `octave` | shift pitches by whole octaves | -2 to 2 |
| `attack`, `release` | seconds, replacing the instrument's own | |
| `chorus` | widens a mono track | 0 to 1 |
| `humanize` | `timing_ms` and `velocity` for this track | |
| `offset_ms` | play early (negative) or late | -60 to 60 |
| `fill` | drums: a tom and snare fill in the last bar of each section | true or false |
| `mute` | leave the track out (for stems) | true or false |
| `spread` | chorale only: how wide the four voices pan | 0 to 1 |

Level guide at default settings: a melody sits at 0 to +3, the bass at -3 to 0, keys and guitar at -7 to -4, a pad at
-12 to -7, drums at -9 to -3. The master brings the total to -14 LUFS whatever the sum is.

## Instruments

| Name | Role | What it is |
|---|---|---|
| `warm_pad` | pad | detuned saws with a slow filter: a warm bed under everything |
| `strings` | pad | bowed ensemble: saws with vibrato and a bright filter |
| `glass_pad` | pad | soft airy tone with a slow shimmer: calm, ambient |
| `choir` | pad | an ensemble of voices on one vowel (formant filtered) |
| `organ` | keys | church-style drawbar organ with a gentle tremolo |
| `piano` | keys | additive piano with inharmonic partials and a hammer thump |
| `felt_piano` | keys | a darker, softer piano: lo-fi, intimate |
| `epiano` | keys | FM electric piano (tine and tone bar): warm, a little bell on the attack |
| `bell` | keys | inharmonic FM bell: music box, chimes, sparkle |
| `nylon_guitar` | plucked | plucked nylon string (waveguide): warm, short sustain |
| `steel_guitar` | plucked | plucked steel string: brighter and longer |
| `harp` | plucked | plucked harp string: pure, long ring |
| `pluck_synth` | plucked | short synth pluck with a closing filter |
| `sub_bass` | bass | a round sine bass with a little third harmonic |
| `synth_bass` | bass | saw and square bass with a filter that snaps shut |
| `upright_bass` | bass | plucked string bass, woody and short |
| `flute` | lead | breathy flute: sine with air and delayed vibrato |
| `synth_lead` | lead | two detuned saws through a filter, with vibrato |
| `soft_lead` | lead | mellow triangle lead: lo-fi melodies |
| `violin` | lead | solo bowed string with vibrato and body resonance |
| `choir_solo` | lead | one voice on a vowel |

Any lead, keys or pad instrument can play a `melody` track (`bell`, `violin`, `flute` and `soft_lead` are the usual
choices). `--check` warns when an instrument is an odd fit for its role.

## Patterns for pad, keys, plucked and bass tracks

A pattern plays over every chord of the section. Durations clip to the chord's length, so a pattern also works when a
bar holds two chords.

| Role | Pattern | What it plays |
|---|---|---|
| pad | `sustain` | the chord held for its whole length |
| pad | `swell` | held, with a slow fade-in |
| pad | `restrike` | the chord again every two beats |
| pad | `off` | silent |
| keys | `block` | the chord held |
| keys | `quarters` | the chord on every beat |
| keys | `half` | the chord on beats 1 and 3 |
| keys | `offbeat` | short chords on the off-beats |
| keys | `arp_up` | eighth-note arpeggio up and back |
| keys | `arp_16` | sixteenth-note arpeggio |
| keys | `alberti` | low-high-middle-high broken chord |
| keys | `waltz` | bass, chord, chord (for 3/4) |
| keys | `lofi_comp` | off-beat chord stabs (use swing) |
| keys | `ballad` | held bass with a rolling eighth arpeggio |
| keys | `sustain` | the chord held for its whole length |
| keys | `off` | silent |
| plucked | `strum` | one strum per chord |
| plucked | `strum_folk` | down down-up up-down-up strum |
| plucked | `fingerpick` | picked pattern, eighths |
| plucked | `boom_chick` | bass note, chord, fifth, chord (country) |
| plucked | `arp_up` | eighth-note arpeggio up and back |
| plucked | `arp_16` | sixteenth-note arpeggio |
| plucked | `sparse` | two plucks per bar |
| plucked | `off` | silent |
| bass | `root` | the root held |
| bass | `root_half` | root on 1 and 3 |
| bass | `root_fifth` | root on 1, fifth on 3 |
| bass | `eighths` | root eighth notes |
| bass | `octave_8ths` | root and octave eighths (disco) |
| bass | `pulse` | root on every beat |
| bass | `walking` | quarter-note walking line |
| bass | `shuffle_walk` | root, third, fifth, sixth (blues and country shuffle) |
| bass | `syncopated` | root with off-beat pushes |
| bass | `off` | silent |

Patterns written for four beats (`strum_folk`, `boom_chick`, `walking`, `syncopated`) are for 4/4. In 3/4 use `sustain`,
`block`, `quarters`, `waltz`, `ballad`, `arp_up`, `fingerpick`, `root`, `pulse`.

## Melody text (for `melody` and `chorale` tracks)

One string per section: bars separated by `|`, notes by spaces. Each note is `degree:beats`.

- **Degree** is the scale number in the key: `1` is the tonic, `5` the fifth, `7` the seventh. `^` after it goes up an
  octave (`1^`), `_` down (`7_`); `b` or `#` in front lowers or raises it (`b3`, `#4`). `r` is a rest. `-` holds the
  previous note longer. A note name like `E4` also works.
- **Beats** are quarter notes: `1` is a quarter, `0.5` an eighth, `2` a half, `1.5` a dotted quarter, `1/3` a triplet.
- **Every bar must add up to the bar length** (4 in 4/4, 3 in 3/4). `--check` names the bar that does not.
- The melody needs as many bars as the section, or a divisor of it (a 4-bar melody in an 8-bar section repeats).
  `"same:verse"` repeats another section's melody from the same track.
- Degree 1 sits near middle C (G major puts the tonic at G3, so use `octave: 1` for a lead there).
- Good habits: start and end on `1`, `3` or `5`; land chord tones on beat 1 of each bar; move mostly by step; repeat a
  short idea and vary it; leave a bar of rest or a long note so the tune breathes.

Strong-model form, for exact pitches and velocities: `{"notes": [[start_beat, beats, "E4", velocity], ...]}` in place of
the string (start is counted in quarter notes from the section's first bar).

### The chorale

A `chorale` track takes a melody string as its **soprano**. The renderer writes alto, tenor and bass for each note
from the chords (smooth inner voices, root in the bass, no parallel fifths or octaves, no doubled third). Rule for
the tune: on every beat where the chord changes, the melody note must be a note of that chord. Passing notes between
are fine. Two chorale tracks (organ and choir) on the same tune give one full sound.

## Drum patterns

Name them in a drums track: `"sections": {"verse": "backbeat"}`.

| Pattern | Beats per bar | Drums used |
|---|---|---|
| `four_floor` | 4 | kick, clap, hat |
| `backbeat` | 4 | kick, snare, hat |
| `rock` | 4 | kick, snare, hat |
| `halftime` | 4 | kick, snare, hat |
| `lofi` | 4 | kick, rim, snare, hat |
| `soft_pop` | 4 | kick, rim, shaker |
| `corporate` | 4 | kick, clap, hat, shaker |
| `shaker_8th` | 4 | kick, shaker |
| `brush` | 4 | kick, brush snare, shaker |
| `tick` | 4 | rim |
| `kick_only` | 4 | kick |
| `epic` | 4 | tom |
| `build` | 4 | snare, kick (a snare roll) |
| `shuffle` | 4 | kick, brush snare, hat (triplet grid) |
| `country_shuffle` | 4 | kick, brush snare, shaker (triplet grid) |
| `waltz` | 3 | kick, rim, hat |
| `waltz_soft` | 3 | kick, shaker |
| `compound` | 3 (6/8) | kick, rim, hat |

A custom pattern is a grid, one string per drum, one character per step (a 16th note by default, so 16 characters for
a 4/4 bar): `x` hit, `X` accent, `o` ghost, `.` rest. Spaces and `|` are ignored.

```json
"verse": {"grid": {"kick": "x...|....|x...|....", "snare": "....|x...|....|x...", "hat": "x.x.|x.x.|x.x.|x.x."}}
```

For a triplet feel add `"spq": 3` and use 12 characters per 4/4 bar. Drums: `kick`, `snare`, `snare_brush`, `clap`, `hat`,
`hat_open`, `shaker`, `rim`, `tom`, `ride`. Add `"gain_db"` beside `"grid"` to set that section's level.

## How the mix works

Each track is rendered note by note (cached), humanized, filtered, panned, ducked under the kick if asked, and summed.
A shared reverb gets each track's `reverb` send. The master is a 32 Hz high-pass, a gentle shelf at 7 kHz, a glue
compressor, then gain and a look-ahead limiter until the integrated loudness reaches `master.loudness.lufs` with the
true peak under `true_peak`. The result is stereo, 44.1 kHz, 16 bit.
