# OpenSCAD in Hildegard: research and what we built

Written 2026-10-26 for Donovan's ask: "for 3d consider openscad, research deeply". The work shipped in PR #34 (baney75/hildegard).

## The short version

OpenSCAD is the best route Hildegard has for **parts with real dimensions** (brackets, enclosures, lids, clips, gears, threads). The model is a short text program, so every number has a name and every loop round is a small change you can describe in one sentence. Agents are already good at writing it. It isn't the right tool for organic shapes like figures, animals or drapery; signed-distance code or Blender stay the route for those.

Hildegard now takes OpenSCAD source directly in a model loop. It checks the source, renders it in a sandbox, runs the usual mesh checks and draws the sheet, and keeps the source with the round. A print can name its parts so the fits between them get measured. The license is fine: OpenSCAD runs as a separate program and is never linked or shipped.

## What OpenSCAD is today

- **License:** GPL-2.0-or-later ([Wikipedia](https://en.wikipedia.org/wiki/OpenSCAD)).
- **Stable release:** still **2021.01**. A newer stable is "hopefully soon" with a release candidate in progress, but there is no date ([openscad/openscad#6664](https://github.com/openscad/openscad/issues/6664)). Development snapshots are current and widely used, including Flathub beta and Homebrew `openscad@snapshot`.
- **Manifold geometry engine:** snapshots have had it for a while, and it became the default in snapshots on **2025-08-17** (Marius Kintel on the [mailing list](https://lists.openscad.org/empathy/thread/TMJEJCZINIJNYJX2YF7IDNBAPQY66KIF)). It makes booleans one to two orders of magnitude faster than CGAL, which is the main reason to prefer a snapshot. 2021.01 renders with CGAL only.
- **Headless:** `openscad -o out.stl --export-format binstl in.scad` needs no display. In this cloud container it rendered in milliseconds. Exports are STL, OFF, AMF, 3MF, DXF, SVG, PDF and PNG. A PNG preview needs OpenGL, so Hildegard draws its own sheet from the mesh instead.
- **Customizer:** `/* [Group] */` comments and `-D name=value` on the command line let the same file make variants. Hildegard uses `-D part="…"` to render the parts of a print separately.
- **Known security history:** two STL-importer memory bugs, CVE-2020-28599 and CVE-2020-28600, were fixed in 2021.01 ([Arch security tracker](https://security.archlinux.org/package/openscad)). Treat every import parser as attack surface.

## Libraries

| Library | License | Use |
| --- | --- | --- |
| [BOSL2](https://github.com/BelfrySCAD/BOSL2) | BSD-2-Clause | The standard library in practice: rounding and chamfers, attachments and anchors, threads, screws, gears, sweeps. The skill teaches it first. |
| MCAD | LGPL-2.1 | Ships with OpenSCAD on Linux. Old but always there. |
| [NopSCADlib](https://github.com/nophead/NopSCADlib) | GPL-3.0-or-later | Real hardware: vitamins, enclosures, printed parts. |
| [Round-Anything](https://github.com/Irev-Dev/Round-Anything) | MIT | Fillets on polygons. |
| [threads-scad](https://github.com/rcolyer/threads-scad) | CC0 | Simple threads. |
| [dotSCAD](https://github.com/JustinSDK/dotSCAD) | LGPL-3.0 | Patterns, sweeps, generative shapes. |

License sources: [openscad.org/libraries](https://openscad.org/libraries.html).

Hildegard never copies these. It finds whatever is installed (Hildegard's own `<data>/openscad/libraries`, the user's OpenSCAD library folder, and `/usr/share/openscad/libraries` on Linux) and lists it through `openscad_status`.

## Licensing with AGPL

- Hildegard **runs** OpenSCAD as a separate program, the same way it runs ComfyUI. That is mere aggregation, so it puts no GPL obligation on Hildegard's code.
- If we ever shipped OpenSCAD inside an installer, GPL-2.0-or-later lets us take it under GPLv3, and GPLv3 is compatible with AGPLv3 (section 13). Even then we would only need to offer OpenSCAD's source and keep its notice.
- A mesh OpenSCAD renders is the author's work. Like a compiler's output, it isn't covered by OpenSCAD's GPL.
- A user's `.scad` that includes a GPL library (NopSCADlib) is the user's own business when it stays in their own files. Hildegard doesn't distribute it.
- LICENSING.md now says all of this.

## How agents do with OpenSCAD (evidence)

- **ModelRift's benchmark** ([blog](https://modelrift.com/blog/openscad-llm-benchmark)) had Codex 5.5, Claude Code with Sonnet 4.6 and Opus 4.7, Cursor Composer 2.5 and Gemini 3.5 Flash build the Pantheon from images, using the OpenSCAD CLI with PNG previews.
  - OpenSCAD is "a good target for LLMs" and the CLI wasn't the bottleneck. Geometric judgement was.
  - A **render-feedback loop was essential**, and the best result came from the agent that looked up **real measurements**.
  - One agent's preview looked better than its exported STL, so **check the exported mesh, not the preview**.
  - Feedback drawn on the render beat feedback written in text.
- **EvoCAD** ([arXiv 2510.11631](https://arxiv.org/pdf/2510.11631)) used CadQuery rather than OpenSCAD, but its lessons carry over:
  - Have one model describe the rendered views and a different step judge them against the spec.
  - A single chain of refinements plateaus after about two rounds. A small population with an "elite" (keep the best) keeps improving.
  - Cheap topology checks (Euler characteristic, holes) catch errors the visual judge misses.
- **Other OpenSCAD MCP servers exist.** The most complete is [quellant/openscad-mcp](https://glama.ai/mcp/servers/quellant/openscad-mcp) (MIT), with render, validate, measure, export and reference data. Its own README says path checks only apply when `allowed_paths` is configured, which is off by default, and that it has no OS sandbox. Ours is safe by default.

How this lines up with Hildegard: the loop already does what the evidence says works. It renders every round, checks the exported mesh rather than the preview, draws eight views and silhouettes, measures topology (watertight, manifold, bodies, debris), and asks for a critique with evidence before the next round. The print skill already insists on measured dimensions. What OpenSCAD adds is that the source is the model, so Hildegard renders it, keeps it, and refuses anything unsafe before it runs.

## Compared with what Hildegard already had

| | mesh_kit.py (hildegard-3d) | print3d method (hildegard-print) | OpenSCAD (new) |
| --- | --- | --- | --- |
| Best for | Organic forms: SDF, smooth union, marching cubes | The method for working parts: evidence, fits, slicing, print sheet | Exact, parametric, hard-surface parts |
| Runs where | Any Python with numpy, including a chatbot's code tool | Python with Pillow and numpy | OpenSCAD on the Hildegard computer |
| What the agent sends | An exported mesh | An exported mesh with named parts | **The source itself** |
| Parts and fits | Named OBJ or GLB nodes | Measured by review_mesh.py | `parts = [...]`, each rendered with `-D part=`, then sent as a named OBJ |
| Owner can edit later | The Python script | The script | The `.scad` with customizer parameters, kept with every round |

They work together: hildegard-print is the method, OpenSCAD is the strongest way to build the part, and review_mesh.py checks the result either way.

## What we built (PR #34)

- `apps/server/src/openscad.ts`:
  - finds OpenSCAD: `HILDEGARD_OPENSCAD`, the macOS and Windows app locations, PATH, Flatpak
  - checks its version and whether it has Manifold
  - lists library folders and the libraries in them
  - reads the source before it runs (`vetScad`)
  - renders it (`renderScad`)
  - handles parts (`declaredParts`, `partsObj`)
- **The loop:** a model round can be `.scad` text, a `.scad` file, or a folder or ZIP with `main.scad`. A refused or failing render costs no round, and OpenSCAD's own error comes back. `info.openscad` gives the version, engine and time, `info.echo` gives the echoes, and an `openscad` check warns on warnings. The round keeps its source.
- **MCP:** the `openscad_status` tool, `loop_submit` and `loop_start` now describe source rounds, and `file_path` takes a folder of `.scad` files. HTTP: `GET /api/openscad`. Paths are shown only to someone at the computer.
- **Skill:** `skills/hildegard-openscad` covers file structure, eps overlaps, 2D-first, hull, hardware holes, teardrops, BOSL2 (anchors, `diff`/`tag`, threads, screws, gears, `$slop` from the printer's clearance), the parts convention, and what gets refused and why.
- **CI** installs OpenSCAD on Linux, so real renders are tested: a single file, a folder with `use`, parts with a measured slide fit, refusals, parser errors and empty models.

## Security: what an attacker could try, and what stops it

The source is untrusted. It may come from someone else's agent, a pasted file, or a hostile suggestion.

| Risk | What stops it |
| --- | --- |
| `include </etc/passwd>`, `use <../../x>`, `include <~/.ssh/…>` to read files (OpenSCAD opens them, as we checked here) | Refused before running: include and use must be relative, with no `..`, no `~`, no drive and no backslash |
| `import(path)` or `surface(file=…)` reading any file; `str()` or variable tricks; `\x2e` escapes | Must be a plain string literal naming a file in the round; backslashes refused; a module wrapping `import(p)` refused |
| Importer parser bugs (the STL CVEs) | Only files the round itself carries reach an importer, and 2021.01 or newer is required in practice |
| Secrets in the environment | Variables named like keys, tokens or passwords are stripped. OpenSCAD has no `getenv` anyway. |
| Running programs | OpenSCAD has no exec. Its `-m make_cmd` option is never passed, and Hildegard controls every argument. |
| Endless renders, huge output | Time limit (180 s, `HILDEGARD_OPENSCAD_TIMEOUT`); the mesh goes through review_mesh's size and triangle limits |
| Writing elsewhere | It runs in the round's own temp folder, and only `-o` writes. The folder is deleted after. |

Known residual risk: library code (BOSL2 and the rest) isn't vetted, so a library module that passed a caller's path to `import()` could be used to read a file. BOSL2 isn't known to do this. The fix is an OS sandbox (next steps).

## Next steps (in the roadmap)

1. **OS sandbox for the render:** bubblewrap or Landlock on Linux, `sandbox-exec` on macOS, an AppContainer or job object on Windows. No network, read-only access to the libraries, and write access only to the round folder.
2. **Install OpenSCAD and BOSL2 for people:**
   - `hildegard openscad install`: snapshot via Homebrew, winget, Flatpak or AUR `openscad-git`.
   - BOSL2 at a pinned commit, verified by SHA-256.
   - An Omarchy plugin step.
3. **3MF with colours and parts** from snapshots (`lazy-union`), so multi-material prints come out as one file.
4. **Customizer in Studio:** show a round's parameters as sliders. The owner changes a number and Hildegard re-renders, with no agent needed.
5. **Population rounds (EvoCAD's lesson):** let a loop render 2 to 4 variants of one round, put them side by side on the sheet, and keep the best.
6. **Annotate the sheet:** let the owner draw on a view and send that drawing to the agent as feedback, as ModelRift found works best.
7. **PythonSCAD and build123d** as more code-CAD routes, with the same pattern: read the source, sandbox the render, check the mesh.
