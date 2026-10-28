# Working on Hildegard

For people and coding agents changing this repository. (Setting Hildegard up for someone, as an app, a host at a link
or a fleet, is [docs/agents.md](docs/agents.md).)

## Layout

| Path | What it is |
| --- | --- |
| `apps/cli` | The `hildegard` command: install, setup, start/stop, models, connect, hf, choir, host, doctor, mcp. Commands return `{ ok, needsOwner, steps[], message }` |
| `apps/server` | The local HTTP server (Hono): projects, shots, the render queue, model downloads, Hugging Face, agents, loops (`loop.ts`). Serves the Studio |
| `apps/studio` | The Studio UI: React and Vite. Pages in `src/pages`, design tokens and components in `src/styles` and `src/components` |
| `apps/desktop` | The Hildegard app (Tauri 2): the Studio from the local server in a native window, a tray, and the first-run install (`ui/`). `src-tauri` is the Rust shell |
| `mcp` | The MCP server: tools for AI apps, talking to the HTTP server, the loop tools (`loop-tools.ts`) and the skills over MCP (`skill-tools.ts`) |
| `packages/presets` | Cameras, lenses, looks and models (`presets/*.toml`), prompt composition, and the API types shared by everything |
| `packages/comfy` | ComfyUI graphs for each model, the engine that runs them through comfy-api-proxy, and a fake proxy for tests |
| `packages/craft` | Quality gates against slop: prompt lint, `reviewMedia` and `reviewMesh` (run `tools/review_media.py` and `tools/review_mesh.py`), and critique rubrics |
| `packages/agents` | Runs Claude Code, Codex, OMP and Pi only in the ways each provider's terms allow (`policy.ts`), and installs `skills/` for them |
| `packages/cloud` | Rented GPUs: the Runpod REST client and pod spec; `deploy/runpod/boot.sh` is what the pod runs |
| `skills/` | Agent skills for creative work (hildegard), film, video and photo editing, art, sound, 3D, the loop, setup and cloud, with Hildegard's quality gates. Packed for uploads by `scripts/pack-skills.mjs` |
| `.claude-plugin/`, `plugin/` | The repository as a Claude Code plugin and marketplace; `plugin/mcp.mjs` starts the installed Hildegard's MCP server. See [docs/chatbots.md](docs/chatbots.md) |
| `packages/runtime` | Installs and supervises ComfyUI (uv, pinned ComfyUI, PyTorch per GPU), detects the GPU, links AI apps |
| `voice-engine/` | The voice engine (Python, Apache-2.0): speech, voice design, consented cloning, speech to speech and transcription, one worker per environment. See [docs/voice.md](docs/voice.md) |
| `comfy-nodes/hildegard_look` | The film-look ComfyUI node (Python): grain, halation, gate weave |
| `comfy-nodes/hildegard_guard` | The safety ComfyUI node (Python): refuses frames an image classifier scores as sexual. See [docs/safety.md](docs/safety.md) |
| `brand/app-icons` | The design system's app icons, the source for every icon file: `node scripts/app-icons.mjs` renders them |
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
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml             # if you touched apps/desktop/
```

The desktop app's Rust build wants what the app carries in place first: `pnpm --filter @hildegard/studio build`,
`node apps/desktop/scripts/prepare-bundle.mjs`, then `pnpm --filter @hildegard/desktop build` (see the README).

The server's film-export tests run `python3` with PyAV and numpy; install them as CI does:
`python3 -m pip install av==19.0.1 numpy==2.5.3`.

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
- **No sexual content.** Prompts go through `SafetyCheck.text()`, every model or LoRA through `SafetyCheck.model()`
  and the SHA-256 blocklist before it downloads, and every graph that makes frames passes them through
  `HildegardGuard` (`vetGraph` refuses one that doesn't). A new way in (an import, a new model kind, a new graph)
  gets the same checks and a test that a sexual one is refused. [docs/safety.md](docs/safety.md) has the layers.
- **Voices are cloned only with living consent.** Never add a way to clone a voice that skips the consent session
  (a fresh line read aloud, heard by Whisper, unmarked, and the same speaker as every sample), and never let an agent
  start one over MCP. `voice-engine/` is Apache-2.0. [docs/voice.md](docs/voice.md) has the method and the installer.
- **Brand files come from the design system.** Never hand-draw an icon or edit a rendered PNG; change
  `brand/app-icons/` and run `node scripts/app-icons.mjs`.

## Choir: rendering on another device

A Hildegard without a usable GPU renders on another of the owner's devices. Two halves, both in `apps/server`:

- **Sharing a GPU** (`choir.ts`, `node-api.ts`). `hildegard choir invite` (or `POST /api/choir/invite`, loopback only)
  makes a join code `hgc1_<base64url {n,u,t}>`: the device's name, its Tailscale URL, and a fresh 256-bit key that is
  stored only as a SHA-256 hash in `<data>/choir/sharing.json` (0600). The server then also listens on that address
  with `nodeOnlyApp`: `/api/node/*` behind the bearer key (`pairedOnly`, constant-time compare) and a 404 for
  everything else. Graphs from peers must pass `vetGraph` (node classes in `GRAPH_NODE_CLASSES`, model files from the
  catalog, one SaveVideo, LoadImage only as the start frame) and run through `Scheduler.guest`, so they queue with
  local takes. `revoke` drops every key and closes that listener. `hildegard choir opportunistic on|off` (or
  `POST /api/choir/opportunistic`, owner only (loopback or a signed-in owner, like `/api/choir/update`), kept in `<data>/choir/settings.json`) sets how guests queue: on,
  `Scheduler.setOpportunistic` ranks them after all local work, a local take, still or voice lease stops a running
  guest (it requeues, as Force now does), and a guest starts only after `hostBusy` (`busy.ts`: NVIDIA use, load per
  core) says the computer is free, asking again every 30 s (an error counts as busy; a clearance is for one guest, for 2 s; the first ask waits 3 s after local work ends).
  `sharing.busyCheck` says what `hostBusy` can see here. The server's `lookHost` adds `presence.ts` to it: the
  owner's input in the last 3 minutes (macOS ioreg, GNOME Mutter, xprintidle on X11, logind, Windows
  GetLastInputInfo, or `POST /api/choir/presence` from a local idle hook) and other programs holding 1 GiB+ of GPU
  memory (`nvidia-smi --query-compute-apps`, Linux, Hildegard's own processes left out by /proc ancestry and
  `ComfyRuntime.pids`). A 5 s watch calls `Scheduler.interruptGuest` when either appears mid-render, and keeps
  `sharing.busy` for Settings and for `/api/node/info`. Off, guests queue as studio work.
- **Any free device** (`choir use auto`). `place()` in choir.ts picks the device for each job from
  `Choir.candidates()` and `localCandidate()`; the scheduler's `choose` hook calls `route(job)` before each job
  starts (its `pump` never nests), so the engine can switch per job. Guests always run here. In auto, the joined
  devices are refreshed every 15 s.
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

## Host mode: Hildegard at a link

People reach a Hildegard from other devices and sign in. Three parts, all in `apps/server`:

- **Who is asking** (`access.ts`). `fromThisComputer` is a loopback socket with no proxy headers, not on the hosted
  listener: that is the owner at this computer, trusted as before, cookies ignored. Everyone else needs a session;
  `open()` lists the few paths reachable before signing in (the Studio's files, health, `/api/auth/*`). A director may
  use only the routes in `DIRECTOR`, and handlers check `sees()` for every film, shot, take, export and media file, so
  someone else's is a 404. `snapshotFor` and `eventFilter` trim what each person sees, and blank ComfyUI's address for
  anyone not here.
- **People** (`people.ts`). Passphrases as scrypt (N=2^15, r=8, p=1) with the parameters in the hash; invites and
  sessions as random 256-bit tokens kept only as SHA-256 hashes, compared in constant time, in
  `<data>/people/{people,sessions}.json` (0600). Sessions rotate hourly (the old token lives 60 s more), end after 7 idle
  days or 30 days, and end at once on sign-out, a new owner passphrase or removal, which also ends open event streams.
  Changing your own passphrase (`POST /api/auth/passphrase`, current one required) ends every other session of yours.
  `Limiter` counts failed sign-ins per account and per address. `directorQueue` (default 3) caps the takes each
  director has queued or running; `queueFull` in `app.ts` answers 429 with `code: 'queue'` past it.
- **The link** (`host.ts`, `server.ts`). `hildegard host` (or `POST /api/host`, loopback only) runs
  `tailscale serve --bg --https=<443|8443|10000> http://127.0.0.1:<hostPort>`, or `tailscale funnel` when asked by
  name; `hostPort` (`--host-port`, else the main port plus one) is a listener where every request is from elsewhere.
  `--address` answers on a Tailscale address instead; anything outside the tailnet is refused. The state is
  `<data>/host.json`, and `resume()` sets the link up again at start.

Rules for changes here: a new route a director may use goes in `DIRECTOR` and checks `sees()`; anything that changes
the computer stays loopback only (`local(c)`), even for owners signed in elsewhere; never let `/api/node/*` or ComfyUI
behind the hosted listener; tests in `host.test.ts` cover each refusal, and `people.test.ts` the crypto and expiry.
