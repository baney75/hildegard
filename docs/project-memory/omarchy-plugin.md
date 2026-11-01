---
name: omarchy-plugin
description: How the Hildegard Omarchy plugin ships and gets marketplace-verified (bundled installer, mirror follows releases, scan in CI)
metadata:
  type: project
  modified: 2026-10-26T02:11:18.469Z
---

2026-10-26, PR #33 (thread "Make Omarchy install great").
- Marketplace (omacom/omarchy-plugin-marketplace) Automated Security Baseline flags ANY download-then-execute as `curl-pipe-shell` (needs-fixes), even with a pinned SHA. A finding blocks "Snapshot verified" and standard (one-command) install. Old Set up (curl install.sh + bash) failed it.
- Fix: each release builds the plugin with its own install.sh at share/install.sh (pinned in release.env) via scripts/build-omarchy.mjs; release asset hildegard-omarchy-<v>.tar.gz. Source omarchy/release.env stays empty. Scan result now review-required, `installer` capability only (same as 0xSero Local AI) -> eligible for maintainer verification + standard install.
- CI lint job runs scripts/scan-omarchy.mjs against marketplace commit e5f3cbc.
- Mirror baney75/omarchy-hildegard: workflow .github/workflows/follow-hildegard.yml pulls each release's asset hourly, commits "Hildegard X", tags vX. Mirror was stuck on 0.1.5 before.
- "Update unverified" shows whenever mirror HEAD moves past the verified snapshot; each mirror update needs a Plugin verification issue on the marketplace (owner must approve submissions; agents must show title/body first).
- Hildegard is NOT yet submitted to the marketplace (not in registry.json as of 2026-10-26). No AUR package exists despite brand/listing.md copy.
- Agents: `omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable --yes` then `~/.config/omarchy/plugins/io.github.baney75.hildegard/bin/hildegard-omarchy-setup --yes --json`.
Related: [[hildegard-roadmap]] [[devices]]
