---
name: agent-terms-and-skills
description: How Hildegard runs Claude Code/Codex/OMP within provider terms, where its anti-slop skills live, and the Runpod deploy design (2026-10-24)
metadata:
  type: project
  modified: 2026-10-24T02:27:52.214Z
---

Donovan (2026-10-24) demanded a LEGAL way to call Claude Code, Codex, OMP etc. that "we WILL NOT GET BANNED THROUGH", strong skills that don't produce slop, and easy agent deploys to Runpod and similar.

Decided rules (docs/agent-terms.md in baney75/hildegard, enforced by packages/agents/src/policy.ts):
- Claude plan only in unmodified Claude Code; ChatGPT plan only in Codex. Only for the owner, only when the owner starts the run (no schedules, no invited people, no fleet peers), paced: 1 at a time, 30 s apart, 40/day.
- Owner's own API key or cloud account: anything for the owner incl. schedules. Invited people: never on Anthropic keys or Claude cloud accounts; other providers only if owner turns on share-keys; never resold.
- OMP: API key or local model only, never a Claude/ChatGPT login (OMP isn't an OpenAI-listed partner).
- Never read/copy agent credential files.
- Colab ToS forbids proxies/web services/distributed workers: notebook batch only, never in the fleet.

**Why:** Anthropic's legal-and-compliance page reserves plan OAuth for ordinary use of its native apps; OpenAI limits third-party ChatGPT sign-in to listed partners and recommends API keys for automation.
**How to apply:** any new feature that runs agents goes through policy.ts decide(); update doc and code together when terms change.

Skills: repo skills/ (hildegard-craft is the bar; film, video-edit, photo-edit, art, sound, setup, cloud). Slop gates: brief, review_prompt lint, review_take (tools/review_media.py + contact sheet + rubric), max 3 rounds. See docs/craft.md.

Runpod: `hildegard cloud runpod up` (docs/cloud.md). HF Jobs and Colab batches are designed but not built (listed "coming next").
PR from branch claude/project-thread-bcqcqp. Related: [[hildegard-roadmap]].

Repo gotcha: GitGuardian scans every PR commit; never write key-shaped test strings (sk-ant-…, sk-proj-… with entropy). Build them at run time (['sk','ant','oat01','test'].join('-')).
2026-10-24 audit (PR #10): invited people never run Claude on the owner's Anthropic key/cloud account (Anthropic's "each end user must authenticate with their own" rule); model endpoints refuse claude.ai/chatgpt.com/Copilot hosts and sk-ant-oat tokens; LTX license requires disclaiming machine-generated output whenever shared.
Merging (2026-10-24): auto-merge is on for baney75/hildegard; PRs merge once the 13 required checks pass. Don't ask Donovan to merge or tag; a merged version bump (package versions + .github/release-notes/v<version>.md) publishes its own release.
2026-10-26 (PR #26): `hildegard connect --all` links OMP (~/.omp/agent/mcp.json), Pi ($PI_CODING_AGENT_DIR or ~/.pi/agent/mcp.json), Gemini CLI (~/.gemini/settings.json) plus the earlier apps, installs skills per app (Pi: ~/.pi/agent/skills; Codex/Gemini/OpenCode: ~/.agents/skills; Claude Code/OMP: ~/.claude/skills), and adds a sign-in-<app> step (OMP, Pi, OpenCode: API key or local model only). Zed, Goose: `connect --print` only (formats unverified).
