---
name: voice-studio
description: Hildegard voice studio (ElevenLabs-class) plan and decisions, started 2026-10-24: models, engine design, consent method
metadata:
  type: project
  modified: 2026-10-24T15:32:45.188Z
---
Donovan 2026-10-24: wants a premium ElevenLabs-like voice experience (TTS, cloning, design, speech-to-speech, dubbing), local open weights, over Choir and MCP. Cloning must use a unique method that proves the cloned person consented.

Decisions (thread "Build premium voice studio"):
- Models (licenses checked): Kokoro-82M Apache (built-in voices, CPU ok), Chatterbox Multilingual MIT (clone, 23 langs, speech-to-speech, Perth watermark), Qwen3-TTS 12Hz VoiceDesign 1.7B + Base 0.6B Apache (design from words, clone), faster-whisper small MIT. Avoid F5-TTS/XTTS (non-commercial), VibeVoice (pulled).
- Engine: Python worker `voice-engine/hildegard_voice` (Apache-2.0), JSON lines over stdio, one uv venv per family (chatterbox-tts pins torch 2.6 + transformers 5.2; qwen-tts pins transformers 4.57.3; can't share ComfyUI's venv). Offline only, every output Perth-watermarked.
- Consent ("living consent", told Donovan 2026-10-24): fresh random challenge phrase, read live (no upload), whisper word match + speaker fingerprint (Chatterbox ve, vendored) on every sample + reject consent clips carrying an AI watermark, signed certificate with hashes, revocable, usage ledger, "Is this ours?" checker. Agents can't create clones over MCP.
- Donovan already runs Chatterbox on rectory1 (~/Projects/chatterbox, nano on mps).
- huggingface.co is blocked from the cloud container and the device VM; pin hashes via CI or a Remote Control session on rectory1.
Related: [[hildegard-roadmap]]

Status 2026-10-24 ~18:00Z: PR #21 merged to main (not yet in a release; no version bump). Install: `hildegard voice install` (envs speech/chatterbox/qwen; qwen only with >= 8 GB VRAM), docs/voice.md. Gotchas found: Perth needs setuptools<81 (pkg_resources) and torchaudio, now pinned and tested; Perth reads a pure sine as marked, real LibriSpeech speech reads 0.01-0.03 unmarked / 1.0 marked (consent threshold 0.5 holds). CI job `voice` (not a required check) installs all envs for real on CPU. Characters (PR #22) reads voices via `deps.voice.studio` (voiceFor in app.ts). Still to do: real-GPU check on parish1/gatehouse1, pin voice models in models.lock.json.
