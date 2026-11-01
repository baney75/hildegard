---
name: hildegard-safety-and-hf
description: Hildegard content safety layers, HF sign-in client ID (CIMD), and brand icon source of truth (PR #5, 2026-10-24)
metadata:
  type: project
  modified: 2026-10-24T02:49:27.896Z
---

- HF sign-in needs no registered app: client ID is the CIMD URL https://dbaney.com/hildegard/oauth/hf-client.json (dbaney.com commit 6682b81). HF's first call can return invalid_client; Hildegard retries once. A real browser sign-in to confirm the token exchange is still pending (2026-10-24).
- Content safety (docs/safety.md in repo): prompt word lists in presets/safety.toml, SafetyCheck.model() on every model/LoRA, SHA-256 blocklist, HildegardGuard ComfyUI node with Falconsai/nsfw_image_detection on every frame, vetGraph requires the guard. Any new model/LoRA import path must call these.
- Civitai's `nsfw` flag is untrustworthy (Pony V6 XL: nsfw false, nsfwLevel 7); use the nsfwLevel bits plus the minor/poi flags.
- Brand icons: brand/app-icons/ (copied from the design system) is the source; `node scripts/app-icons.mjs` renders all icon files. The design-system snapshot's favicon.svg lacks its <style> block (renders black); the site/brand copy is the correct one.
- The Omarchy bar glyph is a deliberate aperture ring with a progress arc, not the mark.

Related: [[hildegard-roadmap]]
