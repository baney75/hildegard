# Hildegard roadmap: win #OpenSourceHiggsfield, then build the whole thing

*Written 2026-10-19 (Monday). Builds on [the technical foundation](../architecture/hildegard-technical-foundation.md), [the MCP public link plan](../architecture/mcp-public-link.md), [the Cinema Studio entry plan](../challenge/cinema-studio-plan.md) and the finished design canvas ([Hildegard · Studio](https://claude.ai/artifact/HDHruShi7AMyD2ccwgMqEA)). This replaces nothing in those files; it puts them in order.*

## The short version

- **Two tracks, one codebase.** Everything built for the challenge is the first real slice of Hildegard and lives in `baney75/hildegard`. Nothing is throwaway.
- **Track 1, the next 11 days:** ship **Cinema Studio**. You pick a camera, lens, move and look, type a shot, and get an LTX video with sound on your own GPU through ComfyUI. Agents can direct shots over MCP. It installs with one command and has a Runpod template. Submissions close **Friday, Oct 30, 9am PT**. We aim to submit **Thursday, Oct 29**.
- **Track 2, after Oct 30:** grow that slice into the full app. That means the Rust daemon, the desktop app, more models, clustering, remote access over Tailscale (Hildegard Link later, shown as "coming soon"), costs, cloud GPUs, phones, and then 1.0.
- **Clusters that pool devices, not just share a queue.** Your devices form a Choir that can spread jobs across machines *and* split one model too big for any single device across several, including laptops and desktops you still use every day. Those lend their GPU only while idle and hand it back within seconds. Details are in [Clusters](#clusters-that-run-models-no-single-device-can).
- **Agents can install it for you.** An agent can do the whole install with no password, using `omarchy plugin add … --yes` and then `hildegard install --yes --json`. It only stops for the steps that need you: signing in to Tailscale, and anything that spends money. Remote access ships on **Tailscale**. **Hildegard Link** is shown as "coming soon".
- **On Omarchy, Hildegard is a plugin anyone can add with one command:** `omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable`. It's modeled on 0xSero's Local AI plugin and listed on plugins.omarchy.org. A first version is a stretch goal for the challenge. Details are in [Omarchy](#omarchy-a-plugin-anyone-on-omarchy-can-add-with-one-command).
- **The blocker today is yours:** the public repo doesn't exist yet. Until it does, nothing can be pushed. [What only you can do](#what-only-you-can-do-and-when) lists the rest, with dates.

---

## Track 1: winning #OpenSourceHiggsfield

### What we know about the rules (checked 2026-10-19)

From [comfy.org/open-source-higgsfield](https://comfy.org/open-source-higgsfield) and Comfy's [launch post](https://blog.comfy.org/p/higgsfield-promised-to-open-source):

| Item | What it says |
|---|---|
| Deadline | Submissions close **Oct 30, 9am PT**. Winners are announced Nov 6. |
| What to build | An open-source rebuild of a paid creative app (Cinema Studio is named) "using the Comfy Developer Platform". "Publish the repo. Let anyone run it, fork it, and make it better." |
| Best Overall | **$10,000**. Every entry is considered automatically. |
| Most Innovative | RTX 5090. "An app that's never been done, novel custom node packs, or uses of ComfyUI." The demo video **must explain why it's innovative**. |
| Most Viral | RTX 5090. "Delightful to use and made to be shared." |
| Open Weights Only | RTX 5090. No partner nodes or closed APIs, open-weights models only. |
| LTX VFX bonus | **$2,000 cash**. LTX must be the core video model. |
| Runner-ups | 10 × $250 in Comfy credits. |
| Sign-up | Separate Typeform. The first 200 sign-ups get free credits. |
| Build Nights | SF Oct 28, LA Oct 29. Optional. |

**What the page doesn't show.** Its "App requirements", "Prepare your submission" and FAQ answers (license, demo polish, combining prizes) didn't render for me, and I can't read the Typeform itself. Comfy's previous challenge (Oct 5 to 19) published these, and they very likely carry over:
- an open-source license and setup steps good enough for a stranger to run it;
- SFW content, with no unlicensed IP or likenesses;
- one entry per person;
- judging by a panel from **ComfyUI, NVIDIA and Runpod**, scoring usefulness, completeness and **reproducibility**;
- video polish counted only for the "entertaining" prize, so a plain screen recording scored the same everywhere else;
- each entry eligible for one main prize and one bonus.

**Action:** open [the submission form](https://form.typeform.com/to/V1dSQrkS) today and paste its questions in this thread, so we build to the real checklist.

**What "Comfy Developer Platform" means for us.** Comfy's SDKs (`@comfyorg/sdk` for TypeScript, `comfy-sdk` for Python) talk to Comfy API v2, and the same code runs against a local ComfyUI through Comfy's `comfy-api-proxy` (set `COMFY_BASE_URL`, no API key) ([docs](https://docs.comfy.org/development/api-development/sdks)). So Cinema Studio uses the **TypeScript SDK against a local ComfyUI**. That satisfies the platform rule and keeps the open-weights-only claim honest. The Runpod template uses the same code with a different base URL.

### Which prizes we go for, and why we can win them

1. **Best Overall ($10K).** Judges from Comfy, NVIDIA and Runpod reward things that work and that they can reproduce. Most entries will be a workflow plus a thin UI. Ours is a polished, designed app with presets, a queue, a gallery, agent control and a one-command install. It's also visibly the first piece of something bigger.
2. **Open Weights Only (5090).** Easy to qualify: LTX weights only, no partner nodes, no paid APIs.
3. **LTX VFX bonus ($2K).** LTX is the core model of every shot.
4. **Most Innovative (5090), the stretch.** No other entry is likely to have **agents directing a film on your own GPU through MCP**. The 2-minute video spends 20 seconds on exactly that, and says in one line why it's new.
5. **Most Viral, cheaply.** A **Shot Card** export: the clip plus a slim film-slate overlay ("Hildegard · 35mm · Anamorphic · Dolly in · f/1.8 · rendered on my RTX 4090 · $0.00"), sized for X, Bluesky and TikTok. Every shared clip advertises the project. It costs about half a day.

### The model: decide on Tuesday after a test on real hardware

LTX moved fast this year. The entry plan was written for **LTX-2 (19B)**, which has Lightricks' camera-control LoRAs. **LTX-2.5 (22B, August 2026)** is newer and ships distilled, int8 and NVFP4 checkpoints, IC-LoRA motion and union control, and joint audio ([summary](https://comfyui-wiki.com/en/news/2026-08-11-ltx-2-5-open-weights-release)). I couldn't confirm camera-move LoRAs for 2.5 yet.

**Default:** build on **LTX-2.5 distilled** (NVFP4 on RTX 50-series, int8 otherwise). Make moves with IC-LoRA motion guides from short reference clips we render ourselves. If 2.5 can't do clean dollies by Tuesday night, fall back to LTX-2 and its camera LoRAs. Presets abstract the model, so switching costs a manifest change, not a rewrite.

### What goes in the repo (and stays there afterwards)

```
hildegard/
  apps/studio/        React + TypeScript UI, built from the design system; wrapped by Tauri in Track 2
  packages/presets/   preset schema (TOML) + loader: camera, lens, move, look → workflow, LoRAs, prompt, post
  packages/comfy/     thin client over @comfyorg/sdk: run a workflow, stream progress and previews, fetch outputs
  workflows/ltx/      pinned ComfyUI API-format graphs (text→video, image→video, motion-guided move, post/look)
  mcp/                MCP server (stdio + .mcpb bundle): list_presets, direct_shot, shot_status, get_shot, make_sequence
  install/            one-command installer: uv, ComfyUI + comfy-api-proxy, pinned node packs, model fetch by hash
  deploy/runpod/      Runpod template (same code, base URL pointed at the pod)
  docs/               README with GIFs, hardware table, "why open weights", security notes
```

In Track 2, the Rust daemon takes over talking to ComfyUI and the generated MCP catalog replaces `mcp/`. The UI, presets, workflows and installer carry straight over.

### Day by day

| Day | Claude builds | You |
|---|---|---|
| **Mon 19** | This roadmap. Repo scaffold ready to push: monorepo, license files, CI (typecheck, lint, workflow-graph validation), README skeleton. | Create the repo, sign up, choose the license, open the submission form (see below). |
| **Tue 20** | Install script on your GPU box: ComfyUI, comfy-api-proxy, ComfyUI-LTXVideo, VideoHelperSuite, all pinned. **Model test** of LTX-2.5 vs LTX-2: VRAM, speed, and dolly quality, at fixed seeds. | Allow a session on your GPU machine so the tests run on real hardware. |
| **Wed 21** | Model decided. Base text→video and image→video graphs. Preset schema v1. The Comfy client streams progress and preview frames. | Glance at 6 test clips and pick the best-looking direction. |
| **Thu 22** | **Camera moves**: dolly in/out, truck, jib, static, orbit, crane, push-in via motion guides or LoRAs. **Looks**: 35mm, 8mm, DV, anamorphic, vintage, clean, done with prompt fragments plus post nodes (grain, halation, vignette, crop, LUT). | |
| **Fri 23** | Studio UI per the canvas: director's panel (Camera, Lens, Move, Look), shot prompt, queue with live previews, gallery, dark default. | |
| **Sat 24** | MCP server plus `make_sequence` (several shots, stitched). A `.mcpb` bundle for one-click install in Claude Desktop and a `hildegard connect` snippet for Claude Code and Cursor. | Try "direct a 3-shot scene" from Claude Desktop. |
| **Sun 25** | Shot Card export. Stretch: a first Omarchy plugin (bar ring while rendering, queue, Open Studio). Re-shoot (upload a clip, re-render it with a new move) if time allows. | |
| **Mon 26** | Runpod template and a "Run on Runpod" button. Fresh-machine install test: clean Arch/Omarchy, Ubuntu, and Windows via WSL as best effort. Apple Silicon is documented as "not yet". | |
| **Tue 27** | **Feature freeze.** Bug bash, README with GIFs and a hardware table, golden-output check for every preset at fixed seeds. Demo script and shot list written. | Install from the README on your machine. Anything confusing gets fixed today. |
| **Wed 28** | Fixes only. | **Record the demo** (screen recording plus voice-over from the script, 2 minutes max). Optional: SF Build Night. |
| **Thu 29** | Tag `v0.1.0-cinema`, final README, social post text, submission answers drafted. | **Post on social with #OpenSourceHiggsfield and submit the form.** Optional: LA Build Night. |
| **Fri 30** | Buffer only. The deadline is 9am PT. | |

### The 2-minute demo (draft outline)

1. **0:00** A finished 3-shot sequence plays, with the line "Made on one GPU at home. Open weights. $0."
2. **0:10** Director's panel: pick 35mm, anamorphic, dolly in, golden-hour look. Type the shot and render. The preview streams.
3. **0:45** Switch to crane and DV camcorder, then re-render the same shot. Side by side.
4. **1:05** **Agents direct.** Claude Desktop is asked for "a 3-shot noir opening". It calls `make_sequence` on the local GPU and the stitched clip lands in the gallery. One sentence on why this is new: any agent, even a small local model, can now direct film on hardware you own.
5. **1:35** One-command install, the Runpod button for people without a GPU, and the open-weights list.
6. **1:50** "Cinema Studio is the first room of Hildegard: voice, music, 3D next." Repo URL.

### Risks and what we do about them

| Risk | Plan |
|---|---|
| The model doesn't fit or is too slow on your GPU | The distilled and quantized checkpoints, shorter clips (5 seconds) and 720p for live previews, with a 1080p final render. Runpod as the backup recording rig. |
| No clean camera moves on LTX-2.5 | Fall back to LTX-2 with its camera LoRAs (decided Tuesday). |
| `comfy-api-proxy` gaps (it has no job list) | Keep our own queue in the app. Use the raw ComfyUI WebSocket only for preview frames if the proxy lacks them. |
| Scope creep | Re-shoot and the Colab notebook are the first things cut. Freeze on Tuesday the 27th, no exceptions. |
| Install breaks on a stranger's machine | Pin everything by hash. Run the clean-machine tests on Monday the 26th. Reproducibility is likely a scored criterion. |

---

## Track 2: building the full Hildegard

The order follows the foundation doc: security and correctness first, then capability, and design at every step. Each phase ends in a release someone can install.

### Phase 1, "Studio": a real app on one machine (Nov to mid-Dec)
- **`hildegardd` in Rust:**
  - scheduler with the Forced, Interactive, Batch and Agent classes;
  - model manifests (safetensors and GGUF only, BLAKE3-pinned);
  - SQLite plus a content-addressed blob store;
  - a sandboxed ComfyUI worker (bubblewrap + Landlock on Linux).
- **One protobuf schema** generates the TypeScript client and the **MCP tool catalog**. The challenge's hand-written `mcp/` retires.
- **`hildegard` CLI** with `--json` on every command, so agents can set everything up.
- **Desktop app on Tauri 2** around the Studio UI. Linux first (Omarchy), then macOS.
- **MVP modalities beyond video:** transcription (whisper.cpp), image labeling (a small vision LLM through llama.cpp), image generation (FLUX-class open weights through ComfyUI), and TTS. These are small models, so the first-run experience is fast on any machine.
- **Security baseline:** a threat model doc, `SECURITY.md`, `cargo-deny` and `cargo-audit`, signed release artifacts, and an SBOM.
- **Release 0.2:** the full Omarchy plugin plus the `hildegard-bin` AUR package it installs, listed on plugins.omarchy.org, and a macOS build.

### Phase 2, "Choir": many devices, any chatbot (mid-Dec to Feb)
- iroh pairing by QR code, LAN discovery, and weights copied between your devices by hash.
- **Opportunistic mode:** idle detection (on Omarchy/Hyprland through `ext-idle-notify`), backing off when another app uses the GPU, yielding within 2 seconds, and **Force now**.
- **Split models across devices**, in two steps. First, LLMs with layers split across machines. Second, video and image models split across GPUs. See [Clusters](#clusters-that-run-models-no-single-device-can).
- **Remote access over Tailscale:** the phone and other devices connect over your tailnet, and claude.ai and ChatGPT connect through Tailscale Funnel. The daemon is its own OAuth server, and each connection needs one approval tap. **Hildegard Link is shown as "coming soon"** and built when there's time; it isn't blocking any release. See [Remote access](#remote-access-tailscale-now-hildegard-link-coming-soon).
- Windows build, signed.
- **Release 0.3.**

### Phase 3, "Full studio": everything Higgsfield, Suno and ElevenLabs do (Feb to Apr)
- Music (open music models), voice cloning with consent safeguards, and 3D (image → shape → texture → export, as designed). Code-CAD for parts is already in: OpenSCAD source in model loops (PR #34, see below).
- **Costs:** BYO API keys stored in the OS keychain, a pricing table, the savings counter, and budgets enforced in the daemon.
- **Cloud GPUs:** one-click Runpod join, a Colab notebook, Hugging Face endpoints, privacy labels, and auto shutdown.

### Phase 4, "Anywhere": phones (Apr to Jun)
- SwiftUI and Compose apps on the shared Rust core (UniFFI): connect, queue, library, costs, Live Activity, and an end-to-end-encrypted push relay.
- TestFlight and Play internal testing first.

### Phase 5, "1.0"
- An external security audit, a hardware CI matrix (Apple Silicon, NVIDIA, AMD, Windows), visual regression tests on every screen, reproducible builds as a goal, and stable, beta and nightly channels.

### Clusters that run models no single device can

*Added 2026-10-19 at Donovan's request.* A Choir does two things:
- **Spread work.** Different jobs run on different devices. This is already in the foundation doc.
- **Pool devices.** One big model is split across several devices, so three ordinary machines can run what none could alone.

Some of those machines are ones people still use every day.

**How a model gets split.** It depends on the kind of model:

| Model kind | How it splits | What it needs | Engine to build on |
|---|---|---|---|
| LLMs and vision-language models (chat, labeling, agents) | **By layers.** Each device holds a slice of the model, and activations pass along the chain. | 10 GbE or Thunderbolt for good speed. 1 GbE works for overnight batch jobs. | llama.cpp's RPC backend (mixes CPU, NVIDIA, AMD and Apple, which fits a home Choir best). MLX distributed for groups of Macs. vLLM with Ray when every node is NVIDIA. |
| Video and image diffusion (LTX, Wan, FLUX) | **Within one step:** sequence or tensor parallel across GPUs (xDiT-style), and text encoder, VAE and transformer placed on different devices. | Several GPUs in one machine, or a fast link. Over a home LAN, splitting the parts across devices is what works. | ComfyUI multi-GPU and distributed node packs, after review and pinning. xDiT for supported video models. |
| Batches and sequences (4 takes, a 6-shot film, 200 photos to label) | **One job per device**, run in parallel. | Any network. | Hildegard's own scheduler. This is the biggest everyday win and the first one to ship. |

**Making it safe to include machines people use.**
- **Split groups are planned, not improvised.** The scheduler builds a group only from devices whose combined memory fits the model. It prefers server-mode members and adds opportunistic ones only when they're idle *and* their learned schedule says they'll stay free for the job's expected length.
- **When the owner comes back, the group heals.** The returning device pauses at the next step or token boundary and hands its slice to a spare member if one exists (weights are already cached by hash). Otherwise the job checkpoints and waits. The person at the keyboard gets their GPU back within 2 seconds, as the foundation doc requires.
- **Force now is honest.** It names every device it would borrow and says who is using each one, as the design's Force now sheet does.
- **Owners stay in control.** Each device has a cap ("lend at most 12 GB of VRAM" or "never join split groups"), and a laptop on battery or hot never joins.
- **It's all tested in simulation.** The foundation doc's deterministic tests (fake clock, network and devices) cover a member leaving mid-split, a link slowing down, and the coordinator moving.

**Order of delivery.**
1. Phase 2: batches and sequences in parallel across the Choir, and the parts of an image or video model spread across devices.
2. Late Phase 2: LLM layer-splitting over llama.cpp RPC, and MLX distributed for Macs.
3. Phase 3: video diffusion split across GPUs for the biggest models.

The Choir screen shows a split group as one glowing chain across the devices, with how much each one lends.

**To check before Phase 2 starts:** current speeds of llama.cpp RPC and MLX distributed over 2.5 and 10 GbE and Thunderbolt 5, whether exo is maintained and usable, and which ComfyUI distributed node packs are safe to allowlist. All of these moved quickly this year.

### What makes it fun (so it's built in, not bolted on)
- **The first result arrives fast.** Onboarding detects your hardware and installs one small model that fits. Your first image or voice line arrives before you'd lose interest. Big models download in the background, with a progress ring.
- **Directing, not prompting.** Cinema Studio's camera, lens, move and look presets become the pattern for every modality: voices you cast, music you score, objects you sculpt.
- **Shot Cards and share sheets** on every output, so results travel and carry the name.
- **Your devices as a choir.** Watching a second machine light up and take half the queue is the "wow" moment of clustering. The design already has it; we make it feel alive.
- **A visible savings counter** ("Saved this month $41.20") that's honest and computed from real price tables.
- **Agents that just work.** "Hey Claude, make me a podcast intro with my voice" works on your own GPU, and agent setup needs one tap from you.

### Remote access: Tailscale now, Hildegard Link "coming soon"

*Changed 2026-10-19 by Donovan.* The first releases ship with **Tailscale** as the way to reach Hildegard from anywhere. **Hildegard Link stays in the plan, but it's optional** and shows in the app as **"Hildegard Link (coming soon)"** until the relay is built and running.

- **Your phone and your other devices** reach Hildegard over your tailnet. The Connect screen lists Tailscale first and marks it Recommended. Same Wi-Fi works with no setup at all.
- **Cloud chatbots (claude.ai, ChatGPT)** reach it through **Tailscale Funnel**. That gives one public `https://<machine>.<tailnet>.ts.net/mcp` URL, end-to-end encrypted, with Hildegard's own OAuth sign-in on top, and every connection still approved on one of your devices.
- **On Omarchy it's nearly free.** Omarchy's Install > Service > Tailscale (`omarchy-install-service-tailscale`) installs Tailscale, signs you in, makes you its operator, and adds Omarchy's Tailscale bar widget. Because you're the operator, Hildegard can turn `tailscale serve` and `tailscale funnel` on and off **without sudo**. That's the same trick Local AI uses to share models.
- **Two steps need a person once:** signing in to Tailscale in a browser, and allowing Funnel in the tailnet's settings, which Tailscale's own page offers on first use. Hildegard checks both and says exactly which is missing.
- **Hildegard Link (coming soon)** appears in Connect, greyed out, with one line: "No account, works anywhere, end-to-end encrypted. Coming soon." When it ships, it becomes an alternative for people who don't want a Tailscale account. Its design is unchanged in [the MCP public link plan](../architecture/mcp-public-link.md). Your own Cloudflare Tunnel stays an advanced option.
- **The design canvas needs one small change:** the phone Connect screens mark Hildegard Link as Recommended. The Round 3 fix put that there because the earlier plan made Link the default. Tailscale goes back to Recommended, and Link gets the "coming soon" state. I'll write that change up when the mobile phase starts.

### Easy for agents to install, especially on Omarchy

*Added 2026-10-19 at Donovan's request.* An agent, whether Claude Code, Codex or a small local model, should be able to install and set up Hildegard for its owner from a single sentence like "install Hildegard". The owner only steps in for the few things that genuinely need a person.

**No password needed for the basic install.** By default, Hildegard installs entirely in your home folder, the way Omarchy installs T3 Code:
- the app and CLI go in `~/.local`;
- Python workers are managed by `uv`;
- the service runs as a `systemd --user` unit;
- a GPU runtime (CUDA or ROCm) is used from the system when it's there.

So an agent can install it with no sudo prompt at all. The `hildegard-bin` AUR package stays available for people who prefer pacman, and the plugin's Set up page offers both.

**On Omarchy, an agent runs three commands:**
```
omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable --yes
hildegard install --yes --json        # user-space install, picks the CUDA/ROCm/Vulkan/CPU build, starts the service
hildegard setup --yes --json          # starter model that fits this GPU, connects local agents, checks Tailscale
```
`--yes` is Omarchy's own flag for scripts and agents. Each `--json` command returns a list of steps, each one `done`, `skipped` or `needs-owner`, plus a plain sentence for the owner, so the agent knows what's left and can say so.

**What still needs the owner, and nothing else:**
- **Signing in to Tailscale.** Hildegard prints the login link, and the agent passes it on.
- **Allowing Funnel**, only if they want cloud chatbots.
- **The GPU driver**, if it's missing. That needs sudo, so Hildegard names the exact Omarchy command (for example, `omarchy-pkg-add` for the NVIDIA packages) and the agent asks the owner to run it.
- **Anything that spends money or opens the machine to the internet.** It waits for one tap on a paired device, per [section 6a of the link plan](../architecture/mcp-public-link.md).

**Agents find out how in the places they look:**
- An `AGENTS.md` and a short `INSTALL-FOR-AGENTS.md` sit in both repos: the exact commands, the JSON format, and what to ask the owner.
- A one-line installer, `curl -fsSL https://hildegard.dev/install | sh`, is published with a checksum and readable before it runs, for non-Omarchy Linux and macOS. *(The domain is a placeholder until you pick one.)*
- `hildegard connect <agent>` (Claude Code, Claude Desktop, Codex, Cursor, OpenCode, pi) adds Hildegard's MCP to that agent in one step, without touching the agent's other settings.
- Every setup step is also an **MCP tool**, so an agent that already has Hildegard can finish setting it up, or add another device to the Choir.

**Tested like a feature.** CI runs the agent path on a fresh Omarchy machine image: plugin add, install, setup, then one image and one voice line through MCP. If an agent can't get from nothing to a first result unattended, apart from the `needs-owner` steps, the build fails.

**For the challenge:** Cinema Studio's README gets an "Install with your agent" section and an `AGENTS.md` from day one, so judges can point Claude Code at the repo and have it running.

### Omarchy: a plugin anyone on Omarchy can add with one command

*Revised 2026-10-19 after Donovan's correction: there's no Hildegard theme for Omarchy. The goal is an installable Omarchy plugin, like 0xSero's **Local AI**.*

**How Omarchy plugins work now.** I checked Omarchy's source (stable is v4.0.5, released Oct 16, 2026):
- The whole desktop runs as one Quickshell process.
- A plugin is a public git repo with a `manifest.json` and QML at its root.
- People install one with `omarchy plugin add <repo-url> --enable`.
- Plugins are listed at [plugins.omarchy.org](https://plugins.omarchy.org) after a submission form and automated checks. The marketplace lists about 5,700 today.
- Adding or updating a plugin never runs install scripts or sudo. It only clones files and checks the manifest.

**The model to copy is [Local AI](https://github.com/0xSero/omarchy-local-ai) by 0xSero** (v6.24, MIT, updated Oct 18). It's the closest thing to what we want: a local-AI product delivered entirely as an Omarchy plugin. *(I didn't find a separate plugin from the LocalAI project in the marketplace. "Local AI" is 0xSero's.)* What it does well, and we'll copy:
- **One line to install, then one button.** After `omarchy plugin add …`, the bar panel shows **Set up Local AI**. That opens a terminal that runs only Omarchy's own commands (`omarchy-pkg-add`, its Sudoless Docker setup), each with a password prompt that names why. The plugin itself never runs as root.
- **A thin panel over one backend command.** `Panel.qml` polls `omarchy-local-ai snapshot` for JSON: every 1.5 seconds while starting, 5 seconds while open, 30 seconds closed. `Model.js` turns that snapshot into the view as pure functions, so every page renders and tests without the backend.
- **Models validated per GPU.** It ships a list of models proven on each card, and offers only those that fit the machine, saying why the others don't.
- **Opens your agent on it.** One click opens Claude Code, Codex, pi, OpenCode and others, already pointed at the local model, without touching their config.
- **Pinned and checked.** Hugging Face revisions are pinned, every file's hash is checked, and container images are pinned by digest. Engines sit on an isolated Docker network behind a keyed gateway.
- **Clean removal.** One remove command takes everything back out, then `omarchy plugin remove`.
- **A full test suite and release workflow** in the repo.

**Hildegard for Omarchy, built the same way.** It lives in the repo `baney75/omarchy-hildegard`, with the plugin id `baney75.hildegard`.

1. **Install:** `omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable`. That puts the burning-egg mark in the bar. While a job renders, the mark gets a gold progress ring. It dims while the machine is lending its GPU to the Choir.
2. **First click:** a **Set up Hildegard** button. It installs Hildegard in your home folder with no password, then turns on the `systemd --user` service and picks the CUDA, ROCm, Vulkan or CPU build. People who prefer the `hildegard-bin` AUR package get that option. Agents run the same steps with `--yes --json`; see [Easy for agents](#easy-for-agents-to-install-especially-on-omarchy).
3. **The panel** reads `hildegard status --json`, the same snapshot pattern as Local AI. It has these pages:
   - **Home:** what's rendering, with progress, plus Pause, Force now, and recent outputs you can drag into any app.
   - **Create:** quick actions. Shoot a shot from a Cinema Studio preset, speak the selected text, transcribe the clipboard, and label a folder of photos.
   - **Models:** validated for your GPU, marked "Fits", "May be slow" or "Won't fit", with one-click install.
   - **Choir:** your devices, what each is lending, and which split groups are running.
   - **Agents:** one click opens Claude Code, pi, OpenCode or Codex with Hildegard's MCP already attached. You can also copy your Tailscale Funnel MCP link for claude.ai or ChatGPT. Hildegard Link sits beside it, marked "coming soon".
   - **Full screen** opens the Studio app.
4. **Removal:** `omarchy-remove-ai-hildegard` stops the service and removes the package, models and settings (asking about your outputs), then `omarchy plugin remove baney75.hildegard`.
5. **Listing:** we submit it to plugins.omarchy.org and keep it verified with one-click install. The quality bar is below.
6. **Later, upstream:** we propose Hildegard for Omarchy's **Install > AI** menu, next to LM Studio and Ollama. Omarchy's maintainers decide that, so it comes after we have users.

**The quality bar: match or beat Local AI's listing.** *Added 2026-10-19 after Donovan pointed at [its marketplace page](https://plugins.omarchy.org/plugin.html?id=sero.local-ai).* I read the listing record, the repo and the preview.

What Local AI has:
- **Stars:** 148, about the 12th most-starred of roughly 5,700 plugins.
- **Preview:** a 1600×900 poster. It shows a big title, a one-line promise ("personal intelligence is 1 click away"), striking dot-art of the Creation of Adam, and a "Supported" strip of card, agent and model logos.
- **Description:** concrete, and it ends with the install line.
- **History:** many releases with a long changelog, about 24 test scripts, opt-in install counts with a public stats page, and a careful security write-up.

Where its listing is weak, and ours can beat it:
- It's marked **"Manual setup"**, so the marketplace hides its install button.
- Its current code shows as **"Update unverified"**, because it ships faster than it re-verifies.

| | Local AI today | Ours |
|---|---|---|
| Install on the marketplace | "Manual setup", so there's no install button | **One-click install shown.** The plugin enables cleanly with nothing installed. Setup happens from inside the panel, which shows a Set up page when needed. We pass the automated baseline (no download-to-shell, pinned sources, no sudoers changes) and ask for standard installation. |
| Verification | "Update unverified" | **"Snapshot verified" kept current.** Every release is a tagged version, followed by a verification request for that exact commit. |
| Scope | One job: run a chat model and open a coding agent on it | **A whole studio.** Video, voice, music, images, 3D, transcription and labeling. It also works across all your machines (the Choir, with split models), and links to any agent, local or cloud (MCP over Tailscale, with Hildegard Link coming). |
| Preview poster | Strong art, a promise and a logo strip | Same structure in our design language: the burning-egg mark and a Cinema Studio frame, the line "Your own studio. On every machine you own.", and a strip of **Cards** (NVIDIA, AMD, Intel, Apple) · **Makes** (Video, Voice, Music, Image, 3D) · **Agents** (Claude Code, Codex, OpenCode, pi, claude.ai, ChatGPT). Plus a second image of the real panel. |
| Models | Validated per GPU, with "too big" reasons | The same, as Hildegard manifests: "Fits", "May be slow" and "Won't fit", in words, each with the reason. Golden-output checks prove a model makes the right picture or sound, not just that it loads. |
| Panel craft | Tabs, keyboard navigation, a hardware page with temperatures, an activity grid, full-screen view | All of those, plus live preview frames while a shot renders, outputs you can drag into any app, and the Force now sheet naming what it pauses. |
| Privacy | Opt-in counts, a public stats endpoint, `DO_NOT_TRACK` respected | Same rules. Off until you allow it, with nothing about prompts or outputs, ever. |
| Removal | One command removes everything | Same, and it asks before deleting your outputs. |
| Proof | ~24 shell test scripts | Pure view functions tested without the backend, screenshot tests of every panel page, and a clean-machine Omarchy install test in CI. |

**Listing copy (draft):** "Make video, voice, music, images and 3D on your own GPU, and on every other computer you own. Hildegard picks models tested on your card, runs them when your machines are idle, and lets Claude Code, Codex, claude.ai or ChatGPT use them as tools. Nothing leaves your machines unless you say so. Install: `omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable`"

**When.** A first version of the plugin is a **stretch goal for the challenge** (Sun 25 to Mon 26), but only if Cinema Studio is on track. It would be a bar ring while shots render, plus a panel with the queue, Open Studio and "open Claude Code with Hildegard attached". Omarchy users are exactly the people who share setups, so it helps Most Viral. If it doesn't fit, it's the first deliverable of Phase 1.

**Worth knowing:** a small [ComfyUI status plugin](https://github.com/sshbrian/omarchy-comfyui-status-plugin) by sshbrian already exists (idle, sampler progress, it/s). Ours goes much further, but we shouldn't describe ours as the first ComfyUI plugin for Omarchy.

---

### Agents report bugs and make the skills better (added 2026-10-26)

Asked for by Donovan on 2026-10-26: people's agents should file bug reports and ideas, and suggest improvements to the skills over time, model-specific ones especially, so the plugins get better with each update. Security matters most here, because someone could suggest a hostile skill.

- **Done (PR #31):**
  - `report_draft` and `report_file` over MCP, and `hildegard report bug|idea|skill|file|show` in the CLI.
  - Bug reports carry diagnostics with private things taken out. Each draft is checked against existing issues, and the person sees the exact text and says yes before anything is filed.
  - Filing uses the owner's GitHub CLI, or a link that opens the issue form already filled in.
  - New issue form and labels: `skill.yml`, and `idea` and `skill`.
- **Skill suggestions, secured in layers (PR #31):**
  - A suggestion is data only. It becomes an issue, and nothing reads it back or applies it on its own.
  - A scanner (`mcp/src/skill-scan.ts`) refuses suggestions that look like an attack before they are even drafted: hidden characters, prompt injection, hiding things from the user, running code fetched from the web, reading keys, sending data out, turning off safeguards, making things start by themselves, wiping files, and long encoded blobs.
  - The same scanner runs in CI over all of `skills/`. A line it blocks fails the build until the owner has read it and listed it in `skills/SCAN-ALLOW`.
  - CODEOWNERS puts skills and the files that ship them under the owner's review.
  - Skills reach people only through signed releases.
  - Model-specific notes live in `skills/<name>/models/<family>.md`, and `read_skill` takes a `model` argument to return them.
  - The full path and threat model are in `docs/skill-suggestions.md`.
- **Next:**
  - Sandboxed evals of a suggested change: fixed prompts, no network, no keys, with the before and after attached to the PR.
  - An advisory model-based reviewer in CI for skill diffs.
  - Counts of suggestions per skill and per model.
  - A Studio button to report a problem.

### OpenSCAD for exact parts (added 2026-10-26)

Asked for by Donovan on 2026-10-26: consider OpenSCAD for 3D. Research and design are in `architecture/openscad-research.md`.

- **Done (PR #34):**
  - Model loops take OpenSCAD source: one `.scad`, or a folder or ZIP with `main.scad`. Hildegard renders it with the OpenSCAD on the computer, using Manifold when the build has it, then checks the mesh and draws the sheet like any round, and keeps the source.
  - Prints declare `parts = [...]`. Each part is rendered on its own, so the fits between parts are measured.
  - Security: every file is read before it runs. Includes, imports and surfaces may only reach the round's own files or the installed libraries. The render runs in its own folder with a time limit and no secrets in its environment.
  - `openscad_status` MCP tool, the `hildegard-openscad` skill (with BOSL2), docs and a LICENSING note: OpenSCAD is GPL-2.0+ and runs as a separate program, never linked or shipped.
- **Next:**
  - OS sandbox for renders: bubblewrap or Landlock on Linux, sandbox-exec on macOS, AppContainer on Windows.
  - `hildegard openscad install`: a snapshot via Homebrew, winget, Flatpak or AUR, plus BOSL2 at a pinned, hashed commit, and an Omarchy plugin step.
  - 3MF with colours and parts.
  - A customizer in Studio: a round's parameters as sliders, re-rendered without an agent.
  - Rounds with 2 to 4 variants side by side, keeping the best (EvoCAD's lesson).
  - Drawing on the sheet as feedback.
  - PythonSCAD and build123d as further code-CAD routes.

## What only you can do, and when

| When | What | Why it matters |
|---|---|---|
| **Today, Oct 19** | **Create the public repo `baney75/hildegard`**, empty with no README, and make sure the Claude GitHub app can reach it ([install](https://github.com/apps/claude/installations/select_target)). | Nothing can be pushed until it exists. |
| Today | **Choose the license.** My default: **AGPL-3.0** for the app, with **Apache-2.0** for `presets/`, `workflows/` and the future protocol and client libraries. (The entry plan said Apache-2.0 for everything. Project memory said AGPL. This settles it.) | It's required for the entry and hard to change later. |
| Today | **Sign up** at [the sign-up form](https://form.typeform.com/to/Ayn9Cwfj) (the first 200 get credits). Open [the submission form](https://form.typeform.com/to/V1dSQrkS) and paste its questions here. | It confirms the real requirements: video length, social post, license. |
| **Tue, Oct 20** | Allow a session on your **NVIDIA GPU machine** (24 GB+ is ideal). If you don't have one, add Runpod credit. | The model test and the demo need real hardware. |
| Wed, Oct 21 | Pick the look you like from 6 test clips. | It's a taste call. |
| Sat, Oct 24 | Try the agent demo in your own Claude Desktop. | It's the "innovative" moment, so it should feel right to you. |
| **Tue, Oct 27** | Install from the README on your machine. | It's the reproducibility check the judges will do. |
| **Wed, Oct 28** | **Record the demo** (2 minutes max, screen plus voice). Decide whether to go to a Build Night (SF 28, LA 29). | It's your voice and your entry. |
| **Thu, Oct 29** | **Post with #OpenSourceHiggsfield and submit the form** (one entry per person, so only you can). | We submit a day early, and the 30th is a buffer. |
| After Oct 30 | Pick a domain for the website and the one-line installer. Create an **AUR account**, or let me prepare packages for you to publish. Make sure Tailscale is on the machines you'll test with. | The installer, the optional AUR package and remote access need these. **hildegard.link** and its Public Suffix List request can wait until Link moves off "coming soon". |
| Phase 2 to 4 | **Apple Developer** ($99 a year), **Google Play** ($25 once), and a **Windows signing** certificate. Approve the Link Plus price, still open from Oct 18. | Signed apps and the mobile releases need them. |

## Decisions already made (not reopened here)
- The entry *is* Hildegard (Oct 16).
- Rust daemon, Tauri + React desktop, native mobile on a Rust core (proposed Oct 16, building by default).
- ComfyUI as the image and video engine, with pinned, allowlisted nodes only.
- Remote access ships on **Tailscale** (Oct 19). **Hildegard Link** is optional and shown as "coming soon" until built (Oct 19, replacing the Oct 18 "default" decision).
- Install must be easy for agents, especially on Omarchy (Oct 19).
- The design round is done: 105 boards, axe-clean.

## Sources
- [Open Source Higgsfield challenge page](https://comfy.org/open-source-higgsfield)
- [Comfy launch post](https://blog.comfy.org/p/higgsfield-promised-to-open-source)
- [Comfy's previous challenge rules (Oct 5 to 19)](https://comfyui-wiki.com/en/news/2026-10-01-comfy-dev-platform-challenge)
- [Comfy SDKs and the self-hosted API proxy](https://docs.comfy.org/development/api-development/sdks), [Run workflows overview](https://docs.comfy.org/development/run-workflows/overview)
- [Multi-node local LLM inference guide, 2026](https://fungies.io/multi-node-local-llm-inference-guide-2026) (llama.cpp RPC, vLLM + Ray), [LocalAI on MLX distributed](https://localai.io/features/mlx-distributed/)
- [LTX-2.5 release summary](https://comfyui-wiki.com/en/news/2026-08-11-ltx-2-5-open-weights-release)
- [Local AI for Omarchy by 0xSero](https://github.com/0xSero/omarchy-local-ai) (README and `docs/design.md`, commit a6328d9), [Omarchy plugin marketplace](https://github.com/omacom/omarchy-plugin-marketplace) and its [publishing guide](https://plugins.omarchy.org/publish.html)
- Omarchy source at v4.0.5 and `quattro` (commit 81fd2d2, Oct 18): `manual/32-shell-plugins.md`, `docs/omarchy-shell.md`, `shell/plugins/README.md`, `bin/omarchy-plugin-*`, `bin/omarchy-install-ai-t3-code`, `default/omarchy/omarchy-menu.jsonc` ([github.com/basecamp/omarchy](https://github.com/basecamp/omarchy))
