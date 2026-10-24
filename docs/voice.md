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

On a 4 GB card (gatehouse1’s GTX 1650) Kokoro, Whisper and Chatterbox fit; Qwen3-TTS Voice Design wants about 8 GB.
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

## How it fits together

- `voice-engine/` (Apache-2.0): Python workers, one per environment, speaking JSON lines over stdin and stdout
  (`protocol.py`). They read and write only the files named in each request and never reach the network.
- `apps/server/src/voice.ts`: jobs, voices, consent sessions and the HTTP API under `/api/voice`.
  `voice-engine.ts` runs the workers; `FakeVoiceEngine` stands in for them in tests and `--fake-gpu`.
- `apps/server/src/voice-models.ts`: weights, verified like video models.
- `packages/runtime/src/voice.ts`: the installer behind `hildegard voice install`.
- `mcp/src/voice-tools.ts`: the MCP tools.
- `apps/studio/src/pages/Voice.tsx` and `pages/voice/`: Speak, Voices, Design, Clone, Recordings, and the phone page
  for consent.

## Tests

`pnpm test` covers the server, the consent rules and the installer with stand-ins; `pnpm e2e` walks the Studio through
speaking, designing, cloning with consent and revoking. The engine’s own tests run on the CPU:

```sh
cd voice-engine && python -m pytest -q
```
