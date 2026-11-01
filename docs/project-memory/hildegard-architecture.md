---
name: hildegard-architecture
description: Recommended Hildegard tech stack and remote-access approach (proposed 2026-10-16, not yet approved by Donovan)
metadata:
  type: project
---
Proposed 2026-10-16 in /mnt/project-files/architecture/hildegard-technical-foundation.md (awaiting Donovan's call on license, UI framework, MVP modalities).
- Core daemon hildegardd in Rust; Python workers (uv, sandboxed, no network) only for PyTorch-only models; native engines (llama.cpp, whisper.cpp, MLX, ORT) first.
- ComfyUI (headless, sandboxed, allowlisted pinned custom nodes only) is the image/video engine; features ship as versioned workflow graphs. Entering the #OpenSourceHiggsfield challenge (comfy.org/open-source-higgsfield): submissions close 2026-10-30 9am PT; must use Comfy Developer Platform (API, Router or SDK); needs public repo + OSS license, demo video max 2 min, tagged social post, Typeform; one entry per person. (An older Oct 19 Comfy challenge is a different contest.)
- Desktop: Tauri 2 + TypeScript + React. Mobile: native SwiftUI/Compose over shared Rust core via UniFFI.
- Remote access: embedded iroh (1.0, June 2026) as default, Tailscale option, Cloudflare Tunnel advanced-only (Cloudflare terminates TLS, conflicts with privacy).
- Protobuf single schema; SQLite + BLAKE3 blob store; hardware CI matrix, visual regression, deterministic scheduler sims for zero regressions.
- MCP is a first-class surface (Donovan 2026-10-16): every capability exposed as MCP tools (stdio + Streamable HTTP, OAuth 2.1), plus OpenAI-compatible API; agents scheduled as lowest priority class with scoped grants.
- Cloud compute (Donovan 2026-10-16): Runpod, Colab, HF Endpoints/Spaces join the Choir as the same daemon in a container (iroh, outbound only); ZeroGPU used as remote backend; cost-aware scheduling, auto shutdown, privacy labels. Doc section 3b.
- 2026-10-16: Donovan will enter #OpenSourceHiggsfield only if the entry IS Hildegard (not a separate project). Rules allow that: entry = Hildegard repo with its Cinema Studio slice. Plan: /mnt/project-files/challenge/cinema-studio-plan.md. Name chosen 2026-10-16: Hildegard (over Angelico). Public repo baney75/hildegard requested; Donovan must create it (session cannot create repos).
