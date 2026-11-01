---
name: hildegard-roadmap
description: Hildegard roadmap (2026-10-19): challenge day plan to Oct 30, phases after, Omarchy 4 plugin approach, model-splitting clusters, Donovan's to-dos
metadata:
  type: project
  modified: 2026-10-19T19:37:34.689Z
---
Full plan: /mnt/project-files/roadmap/hildegard-roadmap.md (written 2026-10-19).
- Challenge: Cinema Studio slice in baney75/hildegard, TS + @comfyorg/sdk against local ComfyUI via comfy-api-proxy (counts as Comfy Developer Platform). Feature freeze Tue Oct 27, Donovan records demo Oct 28, submit Thu Oct 29 (deadline Fri Oct 30 9am PT). Targets: Best Overall, Open Weights Only, LTX $2K bonus, Most Innovative (agents direct via MCP), Shot Card export for Most Viral.
- Models (Donovan chose 'LTX plus Wan', 2026-10-19): LTX-2.5 distilled stays default, fallback LTX-2 + camera LoRAs; Wan 2.2 TI2V-5B (Apache-2.0) added as the license-free option.
- Licensing (review 2026-10-19, /mnt/project-files/architecture/licensing.md): AGPL-3.0 app + Apache-2.0 presets/node confirmed compatible. Risk: LTX license item 20 (no competing products) and $10M revenue threshold; LTX-2.5 is on the stricter LTX-2.x Community License. Actions: in-app license acceptance before first model download, THIRD_PARTY_NOTICES + OFL fonts, Source link (AGPL §13), keep provenance tags. Asked Donovan whether to email licensing@ltx.io and about $10M revenue.
- Omarchy (Donovan 2026-10-19): NO Hildegard theme for Omarchy. Deliver an installable plugin modeled on 0xSero's Local AI (github.com/0xSero/omarchy-local-ai): repo baney75/omarchy-hildegard, id baney75.hildegard, `omarchy plugin add <url> --enable`; panel polls `hildegard status --json`; 'Set up Hildegard' button installs AUR hildegard-bin via Omarchy commands; agents page opens Claude Code etc. with Hildegard MCP; list on plugins.omarchy.org. Stretch for challenge (Oct 25-26), else Phase 1. Quality bar (Donovan 2026-10-19): match/beat Local AI's listing (148 stars, poster preview, validated-per-GPU models, tests, opt-in counts). Beat it on: one-click install (theirs is 'Manual setup'), keep 'Snapshot verified' via tagged releases + verification requests (theirs 'Update unverified'), pass the marketplace security baseline. Omarchy 4 = Quickshell, git-repo plugins (manifest.json + QML), no Waybar.
- Donovan 2026-10-19: clusters must split large models across devices, including opportunistic machines still in daily use. Plan: batches/sequences across Choir first, then LLM layer split (llama.cpp RPC, MLX distributed), then video diffusion split; split groups heal when an owner returns.
- Phases: 1 Studio (Rust daemon, Tauri, small MVP models, Omarchy), 2 Choir (iroh, opportunistic, splits, Hildegard Link, Windows), 3 music/voice/3D/costs/cloud, 4 phones, 5 1.0.
Related: [[hildegard-architecture]] [[hildegard-mcp-linking]]

**Product shape (Donovan 2026-10-23):** two surfaces, both clustered over Tailscale: the app (local, your own Higgsfield on your computer) and the server (someone hosts it and people reach it at a link, with sign-in). Agents must be able to install and set up both for people end to end.
