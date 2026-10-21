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
| `omarchy/` | The Omarchy bar widget (QML, a bash backend, `Model.js` for what it shows). Its own README, tests and rules: `node scripts/check-omarchy.mjs` |
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
node --test omarchy/test/*.test.mjs && node scripts/check-omarchy.mjs   # if you touched omarchy/
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

## Choir: rendering on another device

A Hildegard without a usable GPU renders on another of the owner's devices. Two halves, both in `apps/server`:

- **Sharing a GPU** (`choir.ts`, `node-api.ts`). `hildegard choir invite` (or `POST /api/choir/invite`, loopback only)
  makes a join code `hgc1_<base64url {n,u,t}>`: the device's name, its Tailscale URL, and a fresh 256-bit key that is
  stored only as a SHA-256 hash in `<data>/choir/sharing.json` (0600). The server then also listens on that address
  with `nodeOnlyApp`: `/api/node/*` behind the bearer key (`pairedOnly`, constant-time compare) and a 404 for
  everything else. Graphs from peers must pass `vetGraph` (node classes in `GRAPH_NODE_CLASSES`, model files from the
  catalog, one SaveVideo, LoadImage only as the start frame) and run through `Scheduler.guest`, so they queue with
  local takes. `revoke` drops every key and closes that listener.
- **Rendering elsewhere** (`remote-engine.ts`). `hildegard choir join` checks the code against the device's
  `/api/node/info`, keeps the key in the keychain (`secretStores`, account `choir-<name>`; `HILDEGARD_SECRETS=file`
  forces 0600 files, which tests always use), and records the device in `<data>/choir/devices.json`. When `use` names
  a device, `server.ts` routes the scheduler to a `RemoteEngine`, the engine state reads `comfy: 'remote'` with the
  device's name and GPU, and model states come from the device, so nothing asks to download models here.

Setting it up for an owner, end to end:

1. Both devices: Hildegard installed and Tailscale signed in (the owner signs in; that is a `needs-owner` step).
2. GPU device: `hildegard install --yes --json`, a model installed (`hildegard models install <id>` after the owner
   accepts its license), then `hildegard choir invite --json`. Its `code` is a secret: hand it straight to the
   next step, never print it to logs or files. Without Tailscale it returns `needs-owner`; pass `--url` only with an
   address on the tailnet (or https).
3. Other device: `hildegard start`, then pipe the code in: `printf %s "$CODE" | hildegard choir join --code-stdin
   --json` (a code on the command line lands in shell history). `hildegard choir list --json` should show the device
   online with its models, and `hildegard status --json` names it in the `comfyui` step.

Rules for changes here: a peer's key opens `/api/node/*` and nothing else; any new graph node class needs a builder
that makes it, and the `vetGraph` test keeps the allowlist exact; pairing routes stay loopback only.
