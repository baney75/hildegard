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
pnpm dev                                   # server on :7341 with a fake GPU, Studio on :5173
pnpm test && pnpm typecheck && pnpm lint
pnpm e2e                                   # the Studio in Playwright, desktop and phone
pnpm --filter @hildegard/studio e2e:site   # the install page in site/
```

- Node 22.18 or later and pnpm 10. The fake GPU renders in a second, so nothing needs a graphics card until you test a
  real model.
- Pull requests need every CI check green. Add or change a test with each change in behaviour.
- Write for people: short sentences, plain words, no em-dashes, curly quotes in anything a person reads.
- New models or LoRAs go through the safety checks in [docs/safety.md](docs/safety.md), and their license is shown
  before download. Model weights are never committed.

## Licenses

By contributing, you agree that your work is released under the license of the part you change: AGPL-3.0-only for the
app, Apache-2.0 for `presets/`, `workflows/`, `packages/presets/`, `comfy-nodes/` and `voice-engine/`. See [LICENSING.md](LICENSING.md).

Be kind: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
