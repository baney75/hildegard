---
name: characters
description: Hildegard characters (consistent faces across shots) decisions, 2026-10-24: stills model, cast-shot graph, real-person likeness consent, routes
metadata:
  type: project
  modified: 2026-10-24T17:34:41.464Z
---
Donovan 2026-10-24 asked for character creation and consistency. Thread "characters", PR baney75/hildegard#22 merged 2026-10-24 17:41Z with all required CI green, including the real-ComfyUI graph check.

Decisions:
- Stills model FLUX.2 [klein] 4B (Apache-2.0; Qwen3-4B encoder Apache), Comfy-Org/Flux-2-Klein-4B, kind="image" in presets/models.toml, ~13 GB. Not hash-pinned yet (huggingface.co blocked from cloud); not tried on Apple GPU.
- Cast shot = one graph: klein keyframe from up to 4 refs (max 3 characters) -> video model's start-frame path. Cast and start frame are mutually exclusive.
- Real people: one-time 24h link /#/likeness/<token>, 3 live camera photos (no upload), Ed25519 signed record in <data>/likeness/, revoke link deletes photos+stills. Agents (MCP) can only make invented characters.
- Routes /api/likeness/* chosen so they don't collide with the voice studio's /api/consent/* and /#/consent/* (voice thread branch claude/project-thread-5t5ub6).
- No face matching: InsightFace weights are non-commercial.
- Voice wiring done by the voice thread in PR #21 (2026-10-24): app.ts `voiceFor(id)` reads `deps.voice.studio`, usable = not a clone or consent active. Possible later cleanup: one shared signer for voice and likeness consent.
Related: [[voice-studio]] [[hildegard-roadmap]]
