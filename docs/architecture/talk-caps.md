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
3. `TalkLlm.complete` answers it (the first running local model, through `LocalModels`).
4. `TalkTts.speak` says the answer (Kokoro's Heart voice, through a voice studio speak job).

The result is the transcript, the answer, and the answer's audio as a `/media/voice/...` URL, the same kind of URL
voice jobs already give the Studio. Voice jobs share the GPU with renders through the scheduler, as before.

With no local language model running, the turn still finishes: the answer is a stand-in that says so. With the
stand-in GPU, the stand-in voice engine hears a fixed line in any unmarked recording, so a full turn runs in tests
without a network or Python.

The Studio's Talk page (`#/talk`) records with the microphone or takes an uploaded file, and calls only
`/api/talk/turn`. It never calls `/api/voice/*`, so where each step runs can change without touching the page.

`GET /api/talk` says whether Talk is ready here, which language model answers, and this computer's capabilities.

## The remote hook

Each step is a port with one method: `TalkStt`, `TalkLlm`, `TalkTts`. The orchestrator `talkTurn` knows nothing
about where they run. The next step adds remote adapters that call a paired device over the Choir bearer key, chosen
from that device's `capabilities`, and `route` in the result then says `remote` for the steps that went there. The
ports take a file path and plain text, so a remote adapter reads the recording and sends its bytes. No new
`/api/node/*` routes are in this change.

## Where this differs from the plan

- The JSON response carries audio bytes, when there are any, as base64 in `audio.data`, since raw bytes don't fit
  JSON. Local turns always return a URL instead, so this is unused today.
- `TalkLlm.complete` takes a `TalkMessage[]` alias with the same shape as the planned inline type.
- The reply is cut to 2,000 characters before it is spoken, well under a speech job's limit.
