---
name: hildegard-reports
description: How agents file bug reports and feature ideas to baney75/hildegard (PR #31, 2026-10-26)
metadata:
  type: project
  modified: 2026-10-26T01:53:50.301Z
---

2026-10-26, PR #31. Donovan asked that agents can file bug reports and feature requests.

- MCP tools `report_draft` / `report_file` (mcp/src/report-tools.ts); core with redaction, prefilled issue-form URL and GitHub search in mcp/src/report.ts; server `Reports` class (apps/server/src/report.ts) with routes POST /api/report/draft and /api/report/file; CLI `hildegard report bug|idea|file|show`.
- Drafts are saved in `<dataDir>/reports/r<12 hex>.json`. Only a saved draft, unchanged, can be filed, and only with confirm. The owner files through `gh` on the Hildegard machine; anyone else (and the no-gh case) gets the prefilled bug.yml/idea.yml URL. Limits: each draft files once, the same title goes onto the first issue, 5 a day per computer.
- Labels `bug` and `idea` both exist (idea created 2026-10-26 via gh in the cloud session). Filing still retries without labels if one is missing.
- Skill suggestions (Donovan 2026-10-26, "SECURITY MATTERS"): kind `skill` (skill, model, change). Data only, never auto-applied. mcp/src/skill-scan.ts blocks attack shapes before drafting; CI `scripts/check-skills.mjs` scans skills/ with owner-read exceptions in skills/SCAN-ALLOW (line hash); CODEOWNERS on skills/ etc. Model notes: skills/<name>/models/<family>.md, read_skill(model). Threat model docs/skill-suggestions.md. Next: sandboxed evals, model reviewer in CI.
- Docs: docs/agents.md "Telling Hildegard's makers", skills/hildegard-setup. See [[hildegard-plugin-and-loop]].
