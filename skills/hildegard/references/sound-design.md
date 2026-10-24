# Sound design, music production and mixing

Load this for anything with sound you make or shape: sound effects for film, soundscapes, music made in code, mixing and mastering, dialogue cleanup, and audio for interactive pieces. For songs written for Suno, see `song-suno.md`; for podcasts, `podcast.md`.

## Sources

- **Michel Chion, *Audio-Vision* (1994):**
  - added value: sound changes what we see;
  - synchresis: sound and image fusing when they coincide;
  - the three listening modes: causal (what made it), semantic (what it means), reduced (the sound itself).
- **Walter Murch** ("Dense Clarity, Clear Density," and *The Conversations*): about two or three distinct layers are clear at once; past that, the mix turns to density. He coined "worldizing": playing sound back in a real space and re-recording it.
- **David Sonnenschein, *Sound Design: The Expressive Power of Music, Voice, and Sound Effects in Cinema* (2001).**
- **Ric Viers, *The Sound Effects Bible* (2008):** recording and building effects.
- **Ben Burtt** (*Star Wars*, *WALL·E*): real-world sources transformed. The lightsaber is a projector motor hum plus TV interference. *Take:* layer sounds from unexpected sources, then process them into something new.
- **Gary Rydstrom, Randy Thom** ("Designing a Movie for Sound"): write films so sound can be a character.
- **Mike Senior, *Mixing Secrets for the Small Studio* (2nd ed., 2018),** and **Bobby Owsinski, *The Mixing Engineer's Handbook*:** practical mixing.
- **Bob Katz, *Mastering Audio* (3rd ed., 2015):** mastering, loudness and dynamics.
- **David Huron, *Sweet Anticipation* (2006):** expectation as the engine of musical emotion (see also `song-suno.md`).

## Sound design for picture

**Layers of a soundtrack:**
- **Dialogue:** always intelligible; everything else serves it.
- **Ambience and room tone:** the place's own sound (wind, a distant road, a hum). It is never true silence, unless silence is the effect.
- **Hard effects:** sounds tied to visible actions (a door, a step, a gunshot).
- **Foley:** sounds performed to picture (footsteps, cloth, props). Cloth rustle, often missed, makes bodies feel real.
- **Designed sound:** sounds of things that don't exist, or heightened versions of things that do.
- **Music.**

**Building a designed sound.** Layer three parts:
1. a **transient**, the attack (a click, a hit);
2. a **body**, the character of the thing (a tone, a texture);
3. a **tail**, the space (reverb, debris, decay).

Pitch, stretch, filter and reverse the sources until the result fits the object's size and material. Lower pitch reads as bigger and heavier.

**Principles:**
- **Size and distance.** Big things are low and slow; small things are high and quick. Distance removes high frequencies and adds reverb.
- **Perspective follows the camera.** A close-up sounds close; a wide shot sounds distant.
- **Point-of-view sound.** Hear what the character hears: muffled underwater, ringing after a blast, a heartbeat in panic.
- **Contrast.** Silence before a big hit makes the hit bigger. A drop to near-silence is one of the strongest moves available.
- **Off-screen sound** builds the world beyond the frame, and it is cheaper than showing it.
- **Sync:** hard effects must hit the frame exactly (within one frame); sound arriving before the picture is noticed first (ITU-R BT.1359).
- **Motifs:** a sound tied to a character or idea, returning transformed, as in music.

## Making sound in code

- **Synthesis** (numpy, or Web Audio for browser pieces):
  - additive (sums of partials);
  - subtractive (a noise or a saw wave, filtered);
  - FM (bells, metallic sounds);
  - granular (textures from small slices of a sample);
  - physical models (Karplus-Strong for plucked strings);
  - filtered noise for wind, water and breath.

  **Never** use bare sine or square waves as instruments. Shape every sound with an ADSR envelope, and add variation (detuning, jitter, randomized timing, randomized velocity).
- **Samples:** use public domain or CC0 libraries (Freesound, filtered by license; the BBC Sound Effects archive under its own terms) or the user's recordings. Keep a license list.
- **Space:** reverb by convolution with real impulse responses (OpenAIR is a library of them), or synthetic ones made of decaying noise. Use pre-delay to place a sound in front of the reverb.
- **Processing:**
  - EQ (scipy filters, or ffmpeg `equalizer` and `highpass`);
  - compression (ffmpeg `acompressor`), and sidechain for ducking;
  - saturation (tanh soft clip);
  - time-stretching and pitch-shifting (`rubberband`, or librosa).
- **Music in code:**
  - write the notes as data (MIDI with `mido` or `pretty_midi`);
  - render them with a SoundFont through `fluidsynth`, or with numpy synths;
  - follow the composition guidance in this file's music section (below);
  - for full songs with vocals, write for Suno (`song-suno.md`) or use the user's DAW.

## Music composition and production (instrumentals, scores, soundscapes)

- **Plan the form before the notes:** a cue sheet with sections, keys, tempi, instruments and dynamics, and an arc built toward the hero moment.
- **Motif:** three to six notes, developed by repetition, sequence, inversion, augmentation and reharmonization. Random notes are the sound version of clutter.
- **Melody** moves mostly by step; leaps resolve by step in the opposite direction. Phrases breathe, and cadences land.
- **Harmony and voice-leading:** real chord movement, a bass line with purpose, tension resolved at the right moments (Huron: anticipation pays).
- **Arrangement by register:** only one instrument owns each frequency range at a time. Use countermelody and call-and-response to fill space instead of stacking more parts.
- **Score for picture:** hit the turns, not every event. Use the score for emotion the picture can't show, and leave room for dialogue (stay out of 1–4 kHz under speech).
- **Humanize:** vary timing by about 5–15 ms and vary velocity. Keep breaths and noise in recorded parts.

## Mixing

1. **Gain staging:** sensible levels with headroom, peaks around −10 to −6 dBFS before the master bus.
2. **Balance first** with faders alone. Most of a mix is balance.
3. **Pan** to make space: bass, kick and lead vocal in the center; doubled parts wide.
4. **EQ to separate,** not to decorate:
   - high-pass everything that doesn't need lows (the low end goes to bass and kick);
   - cut the mud around 200–400 Hz;
   - tame harshness around 2–5 kHz;
   - give each part its own spectral slot.
5. **Compress for control and character:** gentle for consistency, harder for punch. Use parallel compression for drums.
6. **Space:** reverb and delay on sends, with a shared reverb for one coherent room and pre-delay for clarity.
7. **Automation:** levels that move with the arrangement and the story. A static mix is flat.
8. **Reference:** compare against a professional track in the same genre, at matched loudness.
9. **Check on several systems:** headphones, a phone speaker, a car if possible. In code, at least check the spectrogram and the mono fold-down (`inspect_audio.py` in SKILL.md's check step; correlation near 1 means mono).

## Mastering and loudness targets

- **Music streaming:** about −14 LUFS integrated (Spotify, YouTube, Tidal); true peak −1 dBTP or lower (−2 for loud masters, which lossy encoding can push over).
- **Apple Music** normalizes to about −16 LUFS; **podcasts** go to −16 LUFS (Apple, ±1), with true peak −1 dBTP. A mono file measured on a stereo meter reads about 3 dB quieter, so a mono −19 LUFS file sounds as loud as stereo −16.
- **Broadcast:** −23 LUFS (EBU R128) or −24 LKFS (ATSC A/85); **Netflix** dialog-gated −27 LKFS ±2, true peak −2 dBTP.
- **Quiet, sacred or contemplative pieces** may sit lower on purpose. State the target in the delivery.
- **In ffmpeg:** two-pass `loudnorm` with the measured values, then a true-peak limiter; check with `ebur128=peak=true`. Re-measure after encoding, since AAC and MP3 can overshoot (5b).

## Dialogue cleanup (film, podcast, voice-over)

1. **Remove noise gently:** profile-based (`afftdn`, RNNoise via `arnndn`, or a model such as DeepFilterNet). Overdoing it makes "underwater" artifacts.
2. **High-pass** at about 70–100 Hz to remove rumble.
3. **Remove mouth clicks and plosives** with de-click and de-plosive tools, or by hand.
4. **De-ess:** sibilance around 5–8 kHz.
5. **Level the speech:** clip gain first, then gentle compression (2:1 to 3:1).
6. **EQ for presence:** a small lift around 2–5 kHz for intelligibility; cut boxiness around 300–600 Hz.
7. **Fill gaps with room tone,** never digital silence.
8. **Keep the breaths that carry feeling;** remove the ones that only distract.

## Checklist

- [ ] Dialogue is intelligible over everything, measured and heard (the user listens).
- [ ] Each sound has a source and a size consistent with the picture; hard effects are within a frame of sync.
- [ ] There are only two or three clear layers at any moment (Murch); contrast and silence are used.
- [ ] Nothing clips; true peak and loudness meet the destination's target, re-measured after encoding.
- [ ] Every sample's license is recorded.
- [ ] The report states what was measured; it never says how something "sounds" (you can't hear the result).



## Original 5c notes: music and sound made here

**Plan the form before any notes.** Write a cue sheet, one row per section: time, key or mode, tempo, instruments, dynamic, what changes, where the motif appears. Arc it through dynamics, register and density toward the hero moment.

**Composition:**
- Key, mode and tempo come from the research, not from defaults.
- Use one motif of three to six notes, developed by repetition, sequence, inversion, augmentation and reharmonization. Random notes are the sound version of clutter.
- Melodies move mostly by step, with leaps resolved by step the opposite way, phrases that breathe and cadences that land.
- Use real voice-leading and a bass with purpose.
- Silence is material.
- The up-close layer can be a public-domain hymn quoted in the bass, a name spelled in notes, a verse's syllables used as rhythm, or a threefold repetition.

**Lyrics** (see 5e): put stressed syllables on strong beats and open vowels on long or high notes. Every line must be singable in one breath.

**Making the sound, best first:**
1. The user's own recordings or stems (5f).
2. Code:
   - notes written as a list or MIDI file, rendered with a General MIDI SoundFont through fluidsynth (check `which fluidsynth`, find an `.sf2`, install if allowed);
   - or numpy synthesis (additive, subtractive, FM) for synth, ambient and sound-design textures;
   - or Web Audio offline when the sound belongs to a canvas piece.
3. AI generation (Hildegard's `speak` and `design_voice` on the user's own GPU first, or another speech or music tool the user has connected), only with the user's okay and disclosed. Voices come from the user, a consenting person, or a designed voice, never an unconsented clone of a real person.

**Sound craft:**
- **No raw sine or square waves as instruments.** Use detuned partials, ADSR envelopes, vibrato, and filtered noise for breath and bow.
- **Humanize.** Vary timing by 5–15 ms and vary velocity.
- **Give it space.** Use reverb (Freeverb in numpy, or convolution with a synthetic decaying-noise impulse response), pre-delay and stereo placement. Keep the bass mono below about 120 Hz.
- **Clean edges.** Put 5–10 ms fades on every edge, remove DC offset, avoid clipping before the limiter, and end on a natural decay.
- **Mix by register.** One element owns each range at a time. Clear mud around 200–400 Hz and keep the 2–5 kHz harshness in check.

**Master and encode:**
- Keep a WAV master: 24-bit, 44.1 kHz for music or 48 kHz for video.
- Run two-pass `loudnorm` to the destination target, then a limiter.
- Encode the MP3 with `-c:a libmp3lame -b:a 320k -id3v2_version 3 -metadata title=... -metadata artist=...`, using the name the user chooses.
- Embed the cover with `-i cover.png -map 0:a -map 1:v -c:v mjpeg -disposition:v attached_pic`. The cover is a visual piece: make it with 5a at 3000×3000 px.
- Re-measure the MP3 itself.


## Checks (from the original step 6)

**Music and sound.** Run this on the final MP3 and on the WAV master:

```python
# usage: python3 inspect_audio.py song.mp3   -> prints facts, writes inspect/wave_spec.png
import sys, os, subprocess, numpy as np
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
f, sr = sys.argv[1], 48000
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", f, "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"], capture_output=True, check=True).stdout
x = np.frombuffer(raw, np.float32).reshape(-1, 2); m = x.mean(1)
print(f"duration {len(x)/sr:.1f}s  sample peak {20*np.log10(np.abs(x).max()+1e-12):.1f} dBFS  clipped {(np.abs(x) >= .999).sum()}  DC {x.mean(0).round(4)}")
nz = np.where(np.abs(m) > 10**(-60/20))[0]
print(f"lead silence {nz[0]/sr:.2f}s  tail silence {(len(m)-nz[-1])/sr:.2f}s" if len(nz) else "ALL SILENT")
print(f"L/R correlation {np.corrcoef(x[:, 0], x[:, 1])[0, 1]:.2f}  (1.00 = mono)")
e = subprocess.run(["ffmpeg", "-hide_banner", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True).stderr
print(e[e.rfind("Summary:"):].strip())
os.makedirs("inspect", exist_ok=True)
fig, ax = plt.subplots(2, 1, figsize=(14, 6), sharex=True); step = max(1, len(m)//20000)
ax[0].plot(np.arange(0, len(m), step)/sr, m[::step], lw=.4); ax[0].set_ylabel("wave")
ax[1].specgram(m, NFFT=4096, Fs=sr, noverlap=2048, cmap="magma"); ax[1].set_ylim(0, 12000); ax[1].set_ylabel("Hz"); ax[1].set_xlabel("s")
plt.tight_layout(); plt.savefig("inspect/wave_spec.png", dpi=110); print("wrote inspect/wave_spec.png: view it")
```

Pass when:
- the loudness is on target, the true peak is ≤ −1 dBTP, no samples clip, DC is about 0, lead silence is under 0.5 s, and the tail decays naturally;
- stereo music has an L/R correlation of roughly 0.3–0.95;
- the image shows the cue sheet's sections, no flat-topped blocks and no click lines, and the hero moment at the peak;
- the tags and cover are present.

You can't hear the result, so never say how it "sounds". Report what was measured and ask the user to listen.
