# Capabilities and Talk

## What a device says it can do

Every Hildegard answers `GET /api/node/info` for the devices paired with it. That answer now carries
`capabilities`, the device's own claim about what it can do:

| Field | Meaning |
| --- | --- |
| `mic`, `speaker` | The device has a Talk surface that can hear and play a turn. |
| `stt` | Transcription models it can run now, by voice model id (`whisper-small`). |
| `tts` | Speech models it can run now, by voice model id (`kokoro-82m`). |
| `llm` | Language models running on it: runtime, model, and memory when known. |
| `gpu` | The same GPU the device already reports for rendering. |
| `compute` | `interactive` for a computer someone waits on, `batch` for one that works through queues. |

The server builds it in `apps/server/src/capabilities.ts` from real local state: voice models that are installed
with their Python environment ready, language models found running on this computer (`llm.ts`), and the GPU. With
the stand-in GPU it advertises the stand-in models and a stub language model (`stub` / `hildegard-echo`), so tests
and `--fake-gpu` see a full set without downloads.

Older devices leave the field out, so it is optional on `NodeInfo`. A claim that fails the schema (`Capabilities`,
zod) is dropped as if the device never made one. A claim is the device's say-so and decides nothing about trust;
the bearer key still opens only `/api/node/*`.

The Studio reads the same type, `DeviceCapabilities` in `@hildegard/presets`: on each joined device in choir state
(`ChoirDevice.capabilities`), and for this computer as `ChoirState.capabilities`. Directors see neither.

## Assumptions

- `mic` and `speaker` are true on any Hildegard server today. The device with a Talk surface is the one that hears
  and plays a turn, and every server has one. The browser's microphone in the Studio is separate: the registry is
  what the device claims, not what a browser tab can reach.
- `compute` is always `interactive` for now. Nothing in Hildegard marks a computer as batch only yet; a rented GPU
  is the first candidate once Talk routes work between devices.
- `llm[].vramGb` is null: the runtimes don't report memory per model in a form Hildegard reads yet.

## A local Talk turn

`POST /api/talk/turn` (owner only) takes a multipart recording (`audio`, and an optional `language`) or JSON naming
an earlier voice upload (`{ "uploadId": "<sha256>.wav" }`). `apps/server/src/talk.ts` runs one turn:

1. Keep the recording with the voice studio's uploads.
2. `TalkStt.transcribe` hears it (Whisper, through a voice studio transcribe job).
3. `TalkLlm.complete` answers it (the first running local model, through `LocalModels`). Only a model on this
   computer counts: one Hildegard found, Local AI's gateway, or an owner's endpoint at a loopback address. An
   owner's endpoint anywhere else is never asked, and capabilities don't list it.
4. `TalkTts.speak` says the answer (Kokoro's Heart voice, through a voice studio speak job).

The result is the transcript, the answer, and the answer's audio as a `/media/voice/...` URL, the same kind of URL
voice jobs already give the Studio. Voice jobs share the GPU with renders through the scheduler, as before.

With no local language model running, the turn still finishes: the answer is a stand-in that says so. With the
stand-in GPU, the stand-in voice engine hears a fixed line in any unmarked recording, so a full turn runs in tests
without a network or Python.

The Studio's Talk page (`#/talk`) records with the microphone or takes an uploaded file, and calls only
`/api/talk/turn`. It never calls `/api/voice/*`, so where each step runs can change without touching the page.

`GET /api/talk` says whether Talk is ready here, which language model answers, and this computer's capabilities.

## Talk on another device

Each step is a port with one method: `TalkStt`, `TalkLlm`, `TalkTts`. The orchestrator `talkTurn` knows nothing
about where they run; a port that runs elsewhere says so with `where: 'remote'`, and the turn's `route` reports
`local` or `remote` for each step from that.

### The routes a sharing device answers

A device sharing its GPU also hears, answers and speaks for the devices paired with it. The routes live in
`apps/server/src/talk-remote.ts` and are mounted inside `nodeRoutes`, so the same `pairedOnly` bearer check runs
first: a missing, wrong or revoked key gets the same 401 as `/api/node/info`. Like every `/api/node/*` route they are
on the private Choir address and this computer's loopback listener, and never on the hosted listener, so a
`tailscale serve` or Funnel link never reaches them. Funnel stays off for Talk.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/node/transcribe` | The recording as the raw body (WAV, WebM, MP3, OGG, FLAC or M4A), or multipart `audio`. `?language=` (or a form `language`) is optional. Up to 25 MB. | `{ "text": "..." }` |
| `POST /api/node/complete` | `{ "messages": TalkMessage[] }`, 1 to 40 messages of up to 8,000 characters. | `{ "text": "..." }` |
| `POST /api/node/speak` | `{ "text": "...", "voice"?: "kokoro-heart" }`, up to 2,000 characters. | The audio itself, `audio/wav`. |

Each runs the serving device's own local ports: `localStt` and `localTts` through its voice studio, and `localLlm`
with Tuesday's rules (a model on that computer, or the stand-in answer). `voice` must be one of the device's built-in
catalog voices; a cloned or designed voice is never lent out, so a 400 with `code: "voice"` answers anything else.
Errors come back as `{ error, code }` with the same codes a local turn uses.

### The adapters on the primary

`remoteStt`, `remoteLlm` and `remoteTts` take `{ url, token, name?, fetch? }` and call those routes with
`Authorization: Bearer <token>`, five minutes per step. `remoteTts` also takes `save`, where the answer's bytes are
kept so the Studio can play them; the server passes a function that writes them to the voice uploads under their
SHA-256 without decoding, so a primary with no voice engine installed can still run a remote turn. A refused key,
a device that doesn't answer, and a key that is gone each become a `TalkError` with a sentence that says which.

### Picking the device

`POST /api/talk/turn` takes an optional `device`, as a multipart field or in the JSON body. Left out (or `local`),
every step runs here, as before. Naming a joined Choir device runs all three steps there; the server refuses with
404 when no device has that name, and 409 when it is offline or its last `capabilities` don't list Whisper, a
language model and the model Talk's voice speaks with. The primary still keeps the recording and plays the answer.

The Talk page shows a "Hear and answer on" select when at least one joined device is online and says it can do all
three, and sends its choice as `device`.

### Policy

- Microphone and speaker stay on the primary. Only STT, LLM and TTS move, and only when `device` is set.
- Only the turn's own recording and the words of the turn leave the primary. Voice samples, consent recordings and
  cloned voices never do; the speak route only lends built-in voices.
- The serving device keeps a recording it was sent with its voice uploads, as a local turn does.
- The first serving device is the owner's GPU desktop. A second one waits until this path works there.
- Funnel stays off: the routes are only on the Choir address, which is on the tailnet or https.

### Checking it

`apps/server/test/talk-remote.test.ts` pairs two stand-in servers and runs a turn on the worker, calls each route
with good, missing and wrong keys, and checks the adapters alone. `node apps/server/scripts/talk-remote-harness.mjs`
does the same turn once with the staged fixture (`apps/server/test/fixtures/talk/lighthouse.wav` and its `.txt`
line) and writes `.runs/talk-remote-latency.json`: `{ transcript, replyText, ms, route, sha }`.

## Where this differs from the plan

- The JSON response carries audio bytes, when there are any, as base64 in `audio.data`, since raw bytes don't fit
  JSON. Local turns always return a URL instead, so this is unused today.
- `TalkLlm.complete` takes a `TalkMessage[]` alias with the same shape as the planned inline type.
- The reply is cut to 2,000 characters before it is spoken, well under a speech job's limit.
- `/api/node/speak` returns the audio as the response body rather than a media URL to fetch next, so nothing is
  left waiting on the serving device.
- The adapters take an optional `name` for messages, and `remoteTts` an optional `save`, beyond the planned
  `{ url, token, fetch }`.
- `/api/node/*` is also on the serving device's loopback listener behind the same key, as it already was for
  rendering; it was never on the hosted listener.
