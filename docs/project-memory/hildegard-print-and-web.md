---
name: hildegard-print-and-web
description: Print loops and web loop (0.1.7), plus sites, Figma/pen/URL imports, 8 templates and the Studio canvas (0.1.8); where they live
metadata:
  type: project
  modified: 2026-10-25T02:11:17.389Z
---

Donovan (2026-10-24) asked that Hildegard let people build products: bring in mfranzon/print3d's workflow, especially in the plugin, and add web design that beats pen.dev. PR #24 (version 0.1.7) does both; merged 2026-10-25 02:26Z, release publishes itself.

- Print: `printer_profile` MCP tool / `/api/printer` (apps/server/src/printer.ts; slicer and profile paths only from the local machine). review_mesh.py checks parts, fits/interference, likeness to photo outlines and print-pose STLs. Slicing works with PrusaSlicer, or with Orca/Bambu plus profiles. Print sheet comes from handoff.ts. The skill is skills/hildegard-print, with scripts/print_kit.py for photo measuring, evidence and the fit coupon.
- Web: `kind: "web"` loop (apps/server/src/web-review.ts plus tools/review_web.js). Pages render in Chromium over a CDP pipe with the network cut off, at 390/820/1440 px in light and dark. The skill is skills/hildegard-web, with references/tokens.css.
- Credit: licenses/code/print3d-MIT.txt, listed in scripts/notices.mjs `vendored`. docs/make.md has the pen.dev comparison.
- 0.1.8 (PR #29, merged 2026-10-26 01:46Z; PR #30 signed release goes out as 0.1.9; Donovan: "better than pen.dev, imports, amazing templates, improve the plugin"): Sites (apps/server/src/sites.ts, site-routes.ts; previews at /preview/<id>/<key>/, templates at /preview/template/<id>/), imports figma.ts / pen.ts / site-import.ts, 8 templates in skills/hildegard-web/templates (Apache-2.0, kept passing by apps/server/test/templates.test.ts), Studio canvas apps/studio/src/pages/Sites.tsx (#/sites), 8 site_* MCP tools, CLI `hildegard sites` / `hildegard figma token`. Figma token in keychain as secrets('figma'). Still missing vs pen.dev: free drag-and-drop layout on the canvas.
- New template workflow: review each with webReviewer({final:true,dark:true}) until every check passes, then look at the contact sheet.

Related: [[hildegard-plugin-and-loop]]
