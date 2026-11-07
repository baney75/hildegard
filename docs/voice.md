# Voice

Hildegard speaks, designs voices, clones a voice with its owner’s consent, changes the voice in a recording,
transcribes and dubs, all on your own GPU. Nothing leaves the computer, and every clip it makes carries an inaudible
watermark.

## Set it up

```sh
hildegard voice install          # speech and cloning; voice design too where it fits (8 GB of GPU memory or more)
hildegard voice install --env qwen
hildegard voice                  # what's set up here
```

Each model family runs in its own Python environment under `<data>/voice/envs/<env>`, because Chatterbox, Qwen3-TTS
and Kokoro pin versions of PyTorch and transformers that can’t share:

| Environment | Python | What it runs |
| --- | --- | --- |
| `speech` | 3.12 | Kokoro, faster-whisper, the watermark and the speaker check. Every voice feature needs it |
| `chatterbox` | 3.11 | Chatterbox Multilingual: cloning and speech to speech. Pins torch 2.6, so it gets the CUDA 12.6 build on newer cards |
| `qwen` | 3.12 | Qwen3-TTS: designing voices from words, and a second cloning model |

The packages come from `voice-engine/requirements/<env>.txt`, compiled by uv and pinned exactly; PyTorch comes from
the PyTorch index for this GPU. The installer copies the engine itself to `<data>/voice/engine` and writes
`hildegard-voice.json` in each environment last, so a half-finished install is never used. Hildegard notices a new
environment by itself; there’s nothing to restart.

Model weights download from the Studio’s Voice page or with the `install_voice_model` MCP tool, after the owner
accepts each license. Every voice model Hildegard offers is open weights under a license that allows commercial use:

| Model | License | Does |
| --- | --- | --- |
| Kokoro-82M | Apache-2.0 | Fast speech in 25 built-in voices; runs on any GPU and on the CPU |
| Chatterbox Multilingual | MIT | Cloning in 23 languages, emotion and pace, speech to speech |
| Qwen3-TTS Voice Design 1.7B | Apache-2.0 | A new voice from a description |
| Qwen3-TTS Base 0.6B | Apache-2.0 | Cloning, smaller |
| faster-whisper small | MIT | Transcription, and hearing the consent line |

On a 4 GB card (edge-1’s GTX 1650) Kokoro, Whisper and Chatterbox fit; Qwen3-TTS Voice Design wants about 8 GB.
Voice shares the GPU with video through `Scheduler.lease()`: a voice job waits for a take to finish, and asks
ComfyUI to let go of its memory first.

## Living consent

A voice is cloned only when the person it belongs to says so, aloud, just now. Hildegard doesn’t take a checkbox or
an upload of an old recording as consent. The method:

1. **A fresh line.** Hildegard writes a line with the speaker’s name and four random words: “My name is Ada. I agree
   that Hildegard may make a copy of my voice. amber violin meadow comet.” It’s good for ten minutes
   (`phraseMinutes`). The random words mean a recording made earlier, or for something else, can’t be reused.
2. **Read by the person, live.** They read it in the Studio, or on their own phone through a one-time link (only when
   Hildegard is shared over HTTPS). The phone page can do nothing else.
3. **Heard.** Whisper transcribes the recording, and at least 85% of the line must be heard in order, with every
   random word (`phraseMatch`).
4. **Not made by AI.** The recording must not carry Hildegard’s watermark (Perth), so a voice Hildegard made can’t
   consent for anyone (`markedAbove`, 0.5). Measured on LibriSpeech, real speech reads 0.01 to 0.03 unmarked and
   1.0 marked.
5. **Same person throughout.** Every sample to clone from must match the consent recording on the speaker encoder,
   cosine 0.75 or more (`sameSpeaker`). A clip of someone else is refused.
6. **Enough speech.** Ten seconds or more in all, counting the consent line (`quickSeconds`).
7. **Signed.** The voice gets a certificate, signed with the install’s Ed25519 key (`<data>/voice/consent-key.pem`):
   who, the exact line, when, how it was recorded, and SHA-256 hashes of the recording and every sample. Anyone can
   check it against the public key at `/api/voice/consent-key`.
8. **Revocable.** Revoking deletes the reference audio, so the voice can’t speak again, and keeps the certificate and
   the ledger of every use (which job, which agent, the clip’s hash).

The thresholds are in `[consent]` in `presets/voices.toml`. Agents can list, speak in and check consented voices over
MCP, but only a person in the Studio can start a clone: `clone_voice` tells the agent where to send its owner.

“Is this ours?” on the Recordings page, and the `check_watermark` tool, say whether a clip carries Hildegard’s mark.

## Record from any chat

No chat app reliably lets a panel inside it use the microphone, so Hildegard has its own page for it, and the chat
shows a link to that page. The person opens the link on a phone or computer, taps Record, listens (or watches) back,
records again if they like, and taps Send. The page never starts the microphone or camera until that tap.

1. **A link.** An agent calls `record_link` (`kind` voice or video, a short `purpose` the page shows, and the
   `film_id` it is for, if any), or the Studio's `POST /api/record/links` does the same. The link is
   `<the person’s Hildegard link, or this computer’s address>/record/<token>`. The token is 256 random bits and only its
   SHA-256 is kept (`<data>/record/recordings.json`, 0600). It works once and for 30 minutes. A file that is the wrong type or too
   big doesn’t use it up. The link belongs to whoever asked: nothing but that call returns it, and it is never logged.
2. **The page.** `GET /record/<token>` is the Studio’s page for a live link, 404 for one nobody made and 410 once it
   has run out. It asks for the microphone, or the camera and microphone, with the browser’s noise suppression and echo
   cancellation on (the clone recorder turns them off, because a clone should hear the raw voice; a voice-over is
   cleaned anyway, and room noise is what spoils it). The token is the only credential: it can read what is asked
   (`GET /api/record/<token>`) and send one recording (`POST /api/record/<token>`, 100 MB for sound, 500 MB for video,
   the type checked by the file’s first bytes, and against what it holds: a voice has no picture, a video has one).
3. **Where it goes.** `<media>/recordings/<person>/<id>.<ext>`, with an id of its own (`rec_…`). A person sees their
   own recordings and links; the owner of this Hildegard and this computer see everyone’s, as they do films. Another
   person’s recording is answered “no such recording”, over REST and over the MCP. `recording_status` (by id, or by
   the token, which travels in the body and never the address) says pending, received (with the length and a path, or
   a link that opens without signing in for an app on another device) or expired.

### Clean it

`clean_voice` (the MCP tool; `POST /api/record/<id>/clean` with `target_lufs`, default -16, and `peak`, default -1.5, is
the job behind it) makes a new recording from a voice or a video and returns its id with the loudness and true peak it
measured on the result. The original stays. The chain is in `tools/voice_clean.py` and nowhere else; the skills point
there. In order: two cascaded 80 Hz high-passes, notches at 50 and 60 Hz and their harmonics (100, 120, 150, 180,
240), click removal, FFT denoise, level evening, a lighter second denoise, a gate (threshold 0.06, ratio 2, range 0.4),
a gentle compressor, then two-pass loudnorm with the measured values and `linear=true`. Linear mode needs the take’s
peak to leave room for the gain, and speech often doesn’t, so when the measured result is off target or over the
ceiling the gain is set to the target and a look-ahead limiter holds the peak. A video keeps its picture, copied and not
re-encoded, with the cleaned sound.

It runs on PyAV’s filter graph when that build has every filter in the chain (`highpass`, `bandreject`, `adeclick`,
`afftdn`, `dynaudnorm`, `agate`, `acompressor`, `loudnorm`, `alimiter`), else on an `ffmpeg` found on PATH, else it says
that cleaning needs one of the two. `HILDEGARD_CLEAN_BACKEND=pyav` or `ffmpeg` forces one.

### Put it in a film

`export_film` takes an optional `voiceover`: `{ media_id | path, start_seconds: 0, gain_db: 0, duck_db: 12 }`. The voice
is mixed over the film’s own sound. The film dips by `duck_db` while the voice speaks (the voice’s level sets the
envelope: it follows within 30 ms, starts 50 ms before the first word, and lets go over 300 ms), the voice is padded or
cut to the film’s length, and the mix is set to -14 LUFS and -1 dBTP (`tools/export_film.py`, PyAV and numpy). A
`path` is read by the AI app’s own computer and brought in; an app on another device uses `media_id`.

## How it fits together

- `voice-engine/` (Apache-2.0): Python workers, one per environment, speaking JSON lines over stdin and stdout
  (`protocol.py`). They read and write only the files named in each request and never reach the network.
- `apps/server/src/voice.ts`: jobs, voices, consent sessions and the HTTP API under `/api/voice`.
  `voice-engine.ts` runs the workers; `FakeVoiceEngine` stands in for them in tests and `--fake-gpu`.
- `apps/server/src/voice-models.ts`: weights, verified like video models.
- `packages/runtime/src/voice.ts`: the installer behind `hildegard voice install`.
- `mcp/src/voice-tools.ts`: the MCP tools.
- `apps/server/src/record.ts`, `record-routes.ts`, `record-clean.ts`: record links, what comes back, and the cleaning job.
  `mcp/src/record-tools.ts`: `record_link`, `recording_status`, `clean_voice`. `apps/studio/src/pages/Record.tsx`: the page.
  `tools/voice_clean.py`: the cleanup chain.
- `apps/studio/src/pages/Voice.tsx` and `pages/voice/`: Speak, Voices, Design, Clone, Recordings, and the phone page
  for consent.

## Tests

`pnpm test` covers the server, the consent rules and the installer with stand-ins; `pnpm e2e` walks the Studio through
speaking, designing, cloning with consent and revoking. The engine’s own tests run on the CPU:

```sh
cd voice-engine && python -m pytest -q
```
