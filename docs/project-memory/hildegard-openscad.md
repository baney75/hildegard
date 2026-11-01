---
name: hildegard-openscad
description: How Hildegard renders OpenSCAD source in model loops, its security rules, parts convention, and next steps (PR #34, 2026-10-26)
metadata:
  type: project
  modified: 2026-10-26T02:24:04.276Z
---

2026-10-26, PR #34 (branch claude/project-thread-kqqy4g). Donovan asked to "consider openscad, research deeply". Research: /mnt/project-files/architecture/openscad-research.md; roadmap section "OpenSCAD for exact parts".

- apps/server/src/openscad.ts: find (HILDEGARD_OPENSCAD, app paths, PATH), probe version + Manifold flag, vetScad (include/use relative no `..`; import/surface only a string literal naming a round file), renderScad (round's temp dir, timeout HILDEGARD_OPENSCAD_TIMEOUT, secret-looking env stripped, OPENSCADPATH = installed lib dirs).
- Loops: model round may be .scad text/file or folder/ZIP with main.scad; refused/failed renders use no round. `parts = ["a","b"];` at top level -> each rendered with -D part="a", combined into named OBJ so review_mesh measures fits.
- MCP tool openscad_status, GET /api/openscad; skill skills/hildegard-openscad. CI apt-installs openscad on Linux; real-render tests skip elsewhere.
- Stable OpenSCAD is still 2021.01 (CGAL, slow); snapshots default to Manifold since 2025-08-17. GitHub is blocked from the cloud container's network, but apt works.
- Next: OS sandbox for renders, `hildegard openscad install` + pinned BOSL2, 3MF, Studio customizer.
Related: [[hildegard-plugin-and-loop]] [[hildegard-roadmap]]
