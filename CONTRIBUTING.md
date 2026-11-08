# Contributing to Hildegard

Thank you for helping. Hildegard is a pre-alpha, so the most useful things right now are bug reports from real GPUs,
fixes, and models or presets that render well.

## Before you start

- **Bugs and ideas:** open an issue with the form that fits. For a bug, paste `hildegard doctor --json`, or run `hildegard report bug "<what broke>" --what "<what happened>"`, which fills it in for you with private things taken out. AI agents can draft and, with your yes, file one the same way (`report_draft` over MCP; see [docs/agents.md](docs/agents.md)).
- **A bigger change:** open an issue first and say what you want to make, so the work fits where Hildegard is going.
- **Security problems:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Working on the code

[AGENTS.md](AGENTS.md) is the map: what lives where, and the rules every change follows. To run it:

```sh
pnpm install
pnpm dev                                   # server on :7361 with a fake GPU (data in .dev-data), Studio on :5173
pnpm test && pnpm typecheck && pnpm lint
pnpm e2e                                   # the Studio in Playwright, desktop and phone
pnpm --filter @hildegard/studio e2e:site   # the install page in site/
```

- Node 22.18 or later and pnpm 10. The fake GPU renders in a second, so nothing needs a graphics card until you test a
  real model.
- Some tests run `python3` with PyAV, numpy, Pillow and soundfile, as CI installs them:
  `python3 -m pip install av==19.0.1 numpy==2.5.3 pillow==12.3.0 soundfile==0.13.1`. `pnpm e2e` needs the built Studio
  (`pnpm --filter @hildegard/studio build`); `E2E_PORT=<n>` moves its ports off 7351 to 7353.
- Pull requests need every CI check green. Add or change a test with each change in behaviour.
- Write for people: short sentences, plain words, no em-dashes, curly quotes in anything a person reads.
- New models or LoRAs go through the safety checks in [docs/safety.md](docs/safety.md), and their license is shown
  before download. Model weights are never committed.

## Speed

Hildegard is meant to open and answer at once. `scripts/perf/` measures it, and CI holds it to budgets.

```sh
pnpm --filter @hildegard/studio build
pnpm perf --out report.json                # everything, about five minutes: Studio, server, CLI, MCP
pnpm perf --only cli,server                # just those (also: bundles, mcp, studio)
node scripts/perf/compare.mjs before.json after.json   # a before/after table from two reports
pnpm perf:budgets                          # the budgets CI runs; fails when one is over
```

The bench starts its own fake-GPU servers (ports from 7540, `--port` moves them) in throwaway folders with their own
home, and runs the Studio in Playwright's own headless Chromium (`PLAYWRIGHT_CHROMIUM` points at another). It measures:

- **Studio**, for Cinema, Images, Queue, Settings, Sites, Voice and Talk, cold (empty cache) and warm: JS and CSS bytes
  (raw, gzip, brotli), first and largest contentful paint, an estimate of time to interactive (the end of the last long
  task), layout shift, long tasks and the time to switch routes. Times run under 4x CPU throttling (`PERF_THROTTLE`), so a
  fast machine still shows what a slow one feels. Then scroll smoothness, DOM size and memory with 500 takes and 500
  images in the history.
- **Server**: cold start to the first `/api/health`; p50 and p95 over 50 calls of each endpoint the Studio and Settings
  ask for; time to the first event on `/api/events`; memory at idle.
- **CLI**: wall time of `--help`, `status`, `doctor`, `models`, `host status`, `tunnel`, `agents` and `lint` on a 10,000
  word file.
- **MCP**: time to `initialize`, `tools/list` and a few calls over stdio.

Times move with the machine and with whatever else it is doing, so compare two runs taken together, and read the
bytes and the DOM counts, which don't move. The budgets in `scripts/perf/budgets.json` are the CI gate: sizes a little
above what the build produces now, times far enough above it for a slow runner, and still under what the slips they
guard against cost. A pull request that earns a bigger number raises the budget and says why.

Rules that keep it fast:

- **Pages are chunks.** Add a page in `apps/studio/src/lib/pages.ts`, not as a static import in `App.tsx`. The shell
  (React and the store) is most of what every route downloads; keep it that way.
- **The CLI loads what it runs.** `apps/cli/src/main.ts` imports a command's module only when that command runs, and
  the commands reach the server through its small subpaths (`@hildegard/server/config`, `/version`, `/secrets`, …),
  never the whole package. `apps/cli/test/lazy-imports.test.ts` fails when `--help` or `status` loads the server.
- **Long lists are windowed.** More than a few dozen rows go through `WindowedRows` (uniform rows) or `useReveal`
  (grids) in `apps/studio/src/components/Windowed.tsx`.
- **No process per question on a request.** Ask the file system (`onPath` in `@hildegard/runtime`), run programs
  together (`detectAgentsAsync`), and share one answer between callers that arrive together (`ttlMemo`).
- **Node's compile cache** (`apps/server/src/compile-cache.ts`) keeps the type-stripped, compiled code between starts, in
  your cache folder. `HILDEGARD_COMPILE_CACHE=off` turns it off.

## Licenses

By contributing, you agree that your work is released under the license of the part you change: AGPL-3.0-only for the
app, Apache-2.0 for `presets/`, `workflows/`, `packages/presets/`, `comfy-nodes/` and `voice-engine/`. See [LICENSING.md](LICENSING.md).

Be kind: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
