# Working on Hildegard

For people and coding agents changing this repository. (Installing Hildegard for someone is
[INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md).)

## Layout

| Path | What it is |
| --- | --- |
| `apps/cli` | The `hildegard` command: install, setup, start/stop, models, connect, hf, mcp. Commands return `{ ok, needsOwner, steps[], message }` |
| `apps/server` | The local HTTP server (Hono): projects, shots, the render queue, model downloads, Hugging Face, agents. Serves the Studio |
| `apps/studio` | The Studio UI: React and Vite. Pages in `src/pages`, design tokens and components in `src/styles` and `src/components` |
| `mcp` | The MCP server: tools for AI apps, talking to the HTTP server |
| `packages/presets` | Cameras, lenses, looks and models (`presets/*.toml`), prompt composition, and the API types shared by everything |
| `packages/comfy` | ComfyUI graphs for each model, the engine that runs them through comfy-api-proxy, and a fake proxy for tests |
| `packages/runtime` | Installs and supervises ComfyUI (uv, pinned ComfyUI, PyTorch per GPU), detects the GPU, links AI apps |
| `comfy-nodes/hildegard_look` | The film-look ComfyUI node (Python): grain, halation, gate weave |
| `install/` | `install.sh` and `install.ps1`; `scripts/build-release.mjs` fills in versions and hashes |
| `presets/` | Apache-2.0 preset data. `models.lock.json` pins every model file by revision and SHA-256 |

## Run it

```sh
pnpm install
pnpm dev                    # server with a fake GPU on :7341, Studio with hot reload on :5173
node apps/cli/src/main.ts   # the CLI from source (Node 22.18+ runs the TypeScript directly)
```

The fake GPU walks each shot through queued, rendering and done with preview frames and a sample clip, so all of the
UI works without a GPU. Put `[fail:oom]` or `[fail:node]` in a prompt to see failures.

## Before you push

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm e2e
```

CI runs those on Linux, macOS and Windows; renders a real (tiny) video through ComfyUI and comfy-api-proxy; builds the
release; and runs the real installer from it on all three, then renders through what it installed.

## Rules

- **No regressions.** Every fix comes with a test that fails without it. Never skip or loosen a test to get green.
- **Security first.** The server listens on loopback unless told otherwise and checks Host and Origin on every request.
  Anything that changes the computer (linking apps, stopping the server) is loopback only. Secrets go to the OS
  keychain through `SecretStore`, never to logs, argv, or files an agent might read.
- **Licenses are the owner's.** Never accept a model license or link an account on the owner's behalf; return a
  `needs-owner` step with the command for them instead.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter properties, so Node runs the
  source as is.
- **Pin everything.** Runtime dependencies to exact versions, downloads to SHA-256, model files to a revision in
  `models.lock.json`.
- **Words.** UI text and command output are plain sentences in the second person, with curly quotes and apostrophes.
  `install.sh` is the exception: ASCII only, since macOS's `/bin/sh` misreads UTF-8 after a `$VARIABLE`.
- **Licenses in files.** Each code file starts with its `SPDX-License-Identifier: AGPL-3.0-only` line; `presets/` is
  Apache-2.0. After changing dependencies, run `node scripts/notices.mjs` to regenerate the notices (CI checks them).
