---
name: hildegard-plugin-and-loop
description: How Hildegard installs into AI apps (Claude Code plugin, .plugin, skill zips, chatbots) and how the loop works (PR #23, 0.1.6)
metadata:
  type: project
  modified: 2026-10-24T19:13:32.387Z
---

2026-10-24, PR #23 (release 0.1.6). Donovan's ask: Hildegard installs into ChatGPT, Claude, Claude Code and Grok Bot as "the way people link to their local compute", with strong art and 3D skills and loop mechanics (Codex modeling, etc.).

- The repo root is a Claude Code marketplace and plugin: `.claude-plugin/{marketplace.json,plugin.json,icon.png}`. Install with `/plugin marketplace add baney75/hildegard` then `/plugin install hildegard@hildegard`. `plugin/mcp.mjs` spawns the installed `hildegard mcp`; if Hildegard isn't installed, it runs a stand-in server whose one tool is `hildegard_install`. The repo root must never get a top-level `bin/`, because claude.ai and Cowork refuse such plugins (a test enforces this). `connect claude-code` is skipped when the plugin is enabled.
- Releases carry `hildegard.plugin` (skills only, for the Claude app and Cowork) and `skill-<name>.zip` files (for claude.ai and ChatGPT uploads), built by scripts/pack-skills.mjs.
- Skills over MCP: `list_skills`, `read_skill`, plus a prompt per skill, so ChatGPT, Grok and Grok Bot get the skills through the link itself.
- Web chatbots (claude.ai, ChatGPT, Grok, Grok Bot) need the public Funnel link (`hildegard host --funnel`), and only on the user's request. Grok Bot runs on xAI's cloud computer, takes a custom MCP URL with OAuth, and omits the MCP-Protocol-Version header on reused sessions; stateless /mcp handles that, and a test covers it. Steps are in docs/chatbots.md.
- Loop: server apps/server/src/loop.ts. Kinds are model, image, video and audio. A round must be critiqued with evidence before the next one is accepted. 3D checks are in tools/review_mesh.py. `hildegard loop run codex "<idea>" --kind model` hands a whole loop to an agent, subject to provider terms ([[agent-terms-and-skills]]).
- Skills added: hildegard (from Donovan's plugin), hildegard-3d (mesh_kit.py), hildegard-loop.
- Locally failing in cloud sandboxes (on main too): voice-worker.test.ts and the CLI background-start test.
