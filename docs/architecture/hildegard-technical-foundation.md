# Hildegard: Technical Foundation

*Recommendation, 2026-10-16. Research only; no repository exists yet. Claims about third-party tools reflect their state as of this date and should be re-checked when work starts.*

## The short version

| Layer | Recommendation | Why |
|---|---|---|
| Core daemon (scheduler, cluster, API, storage, networking) | **Rust** | Memory safety for a long-running, network-exposed service; predictable performance; one codebase compiles to every desktop OS and into the mobile apps. |
| Inference | **Orchestrate existing engines, don't rewrite them.** Native engines (llama.cpp, whisper.cpp, MLX on Apple Silicon, ONNX Runtime) where they exist; sandboxed **Python workers** (PyTorch, managed by `uv`) for diffusion, video, music and 3D. | The state of the art in video, music and 3D ships as Python. Rust owns everything around the model; Python only runs the model, in a box. |
| Desktop app (Mac, Windows, Linux) | **Tauri 2** with a **TypeScript + React** UI | Small, fast, native shell around the Rust core; web UI gives full design control and is reused for headless servers in a browser. |
| iOS and Android | **Native SwiftUI and Jetpack Compose**, sharing a **Rust core via UniFFI** | Design is paramount, and native UI is what feels right on phones. Shared Rust means networking, crypto and protocol code are written once. |
| Phone to home server | **Built-in iroh connection as the default**, Tailscale as a supported option, Cloudflare Tunnel as an advanced option for browser access | iroh is end-to-end encrypted, needs no extra app or account, and doesn't take the phone's single VPN slot. Cloudflare Tunnel decrypts traffic at Cloudflare, which conflicts with the privacy promise. |
| Wire protocol | **Protobuf schema, one source of truth**, served over iroh QUIC streams and over HTTP/2 (Connect RPC) | Generated, typed clients for Rust, TypeScript, Swift and Kotlin; automated breaking-change checks. |
| Storage | **SQLite (WAL)** for state, **content-addressed blob store (BLAKE3)** for outputs and model weights | Zero-ops, crash-safe, and blobs dedupe and sync across devices by hash. |

The rest of this document explains each choice, the alternatives considered, and how to bake in security, speed and zero regressions from the first commit.

---

## 1. System shape

```
             ┌──────────── phone (SwiftUI / Compose) ────────────┐
             │   Rust core via UniFFI: iroh, protocol, crypto     │
             └───────────────▲───────────────────────────────────┘
                             │ E2E-encrypted QUIC (iroh)
                             │ or Tailscale / Cloudflare Tunnel
┌────────────── device A: hildegardd (Rust) ─────────────────────┐
│ API ─ Scheduler ─ Activity detector ─ Model manager ─ Cost ledger│
│  │        │                                 │                    │
│  │   Worker supervisor ──► native engines (llama.cpp, MLX, ORT)  │
│  │                    └──► sandboxed Python workers (PyTorch)    │
│  SQLite + BLAKE3 blob store                                      │
└──────────────▲──────────────────────────────────────────────────┘
               │ iroh (LAN discovery + holepunching)
        device B, C… (same daemon, server or opportunistic mode)
```

- **One daemon, `hildegardd`, on every device.** It is the only thing that holds keys, talks to the network, and launches models. The desktop app, the CLI, the Omarchy plugin and the phone apps are all clients of it.
- **Every device is a peer.** No mandatory central server. One device is elected **coordinator** for the cluster's queue (the most available server-mode device, with automatic failover); any device can accept a request and forward it.
- **Headless servers** serve the same web UI bundle the desktop app uses, so a Linux box with no screen is managed from a browser or the phone.

## 2. Core server and scheduler: Rust

**Why Rust over Go, C++, or Python:**
- Go is a reasonable second choice (Tailscale is written in it), but Rust gives stronger guarantees for the security-critical parts (no data races, no nil panics in the hot path), embeds cleanly into mobile apps via UniFFI, and the best embeddable P2P stack (iroh) is Rust.
- C++ matches Rust on speed but not on safety; a daemon that parses network input and downloads files from the internet should not be written in a memory-unsafe language.
- Python as the core would make packaging, startup time, and memory use worse on every device, and makes the whole app as fragile as its dependency tree.

**Key crates (all mature):** `tokio` (async), `iroh` 1.x (networking), `iroh-blobs` (content-addressed transfer), `tonic`/`connectrpc` + `prost` (protocol), `rusqlite` or `sqlx` (SQLite), `blake3`, `tracing` (structured logs), `keyring` (OS keychain).

### The scheduler

Three priority classes, highest first:
1. **Forced**: the user pressed Force now. May preempt batch work on any device, and on opportunistic devices may run even when the user is present (with a visible notification on that device).
2. **Interactive**: a request someone is waiting on (TTS preview, transcription).
3. **Batch**: long renders, bulk labeling, model installs.

Placement is **VRAM- and residency-aware bin packing**: prefer a device that already has the model loaded, then one with enough free VRAM, then the fastest. Loading a 20 GB video model costs more than most jobs, so keeping models warm is the single biggest speed lever.

Preemption: workers report whether a job is checkpointable (diffusion steps and video frames usually are). Checkpointable jobs pause and resume; others are cancelled and requeued, and the Force now dialog says exactly which job it will interrupt, as the design calls for.

### Activity detection (opportunistic mode)

Combine signals, never one alone:
- **Input idle time**: macOS `CGEventSourceSecondsSinceLastEventType`, Windows `GetLastInputInfo`, Linux `org.freedesktop.login1` IdleHint and the Wayland `ext-idle-notify-v1` protocol (works on Hyprland/Omarchy).
- **Competing GPU use**: another process using the GPU (a game, an editor export) means back off immediately. NVML on NVIDIA, IOKit/Metal stats on Mac, DXGI on Windows, sysfs on AMD.
- **Fullscreen app, screen sharing, on battery, thermal pressure, low disk.**
- **Learned schedule**: a per-hour-of-week idle probability model built locally from the above (the heatmap in the design). Used for prediction ("likely free at 11 pm"), never as the sole permission to run.

Yield fast: when the user returns, an opportunistic device must release the GPU within a second or two. That means pausing at the next step boundary and unloading if needed, and is a tested requirement, not a hope.

## 3. Inference layer

- **Native engines first**, linked or run as subprocesses: llama.cpp (LLMs, vision-language for labeling), whisper.cpp / faster-whisper (transcription), **MLX** on Apple Silicon (substantially faster than PyTorch MPS for many models), ONNX Runtime with CUDA, DirectML, CoreML and ROCm providers.
- **Python workers** for the long tail (video, music, 3D, voice cloning) where models ship as PyTorch code. Each model family gets its own locked environment, built and cached by `uv`, so installing one model can never break another. Workers speak a small, versioned protobuf protocol over a local socket to the daemon.
- **Model manifests**: each installable model is a signed manifest (weights by BLAKE3 hash, license, VRAM per precision, supported backends, worker env lockfile). This is what makes one-click install, the Models screen, and cross-device install possible.
- **Weights only as safetensors or GGUF.** Never load pickle (`.bin`/`.pt`) files, which can execute code on load.
- **Cluster distribution**: weights move between your devices with `iroh-blobs` (verified by hash, resumable), so a model downloaded once from Hugging Face is copied over the LAN to other devices instead of downloaded again.
- **ComfyUI as the image and video engine** (added 2026-10-16). ComfyUI is the de facto open engine for diffusion image and video workflows (FLUX, LTX, Wan and the rest) with a large node ecosystem and an HTTP/WebSocket API. Rather than reimplementing that, each device runs a **headless ComfyUI instance as one more sandboxed Python worker**. Hildegard's features (camera motion presets, character consistency, relighting) are shipped as **versioned ComfyUI workflow graphs** behind Hildegard's simple UI; users never see a node graph unless they open an "advanced" view. Rules:
  - **Custom nodes are arbitrary Python code** and have been a real malware vector. Only an allowlist of pinned, reviewed node packs (by commit hash) is installable; no in-app "install any node" manager.
  - ComfyUI's own server binds to a local socket inside the sandbox and is never exposed to the LAN or internet; Hildegard's daemon is the only client.
  - ComfyUI is GPL-3.0; running it as a separate process keeps licensing simple and is compatible with the AGPL recommendation below.
  - Golden-output tests run every shipped workflow graph against pinned ComfyUI and node versions, so a ComfyUI upgrade can't silently change results.
- **Outside APIs** (OpenAI, Anthropic, ElevenLabs and others) are just another backend behind the same scheduler, so the UI and cost ledger treat local and remote uniformly.

## 3a. Agents on your GPUs: the MCP surface (first-class)

*Added 2026-10-16 at Donovan's request.* Every capability Hildegard has is also exposed as **MCP tools**, so any agent (Claude, a small local model, a coding agent, a home automation agent) can generate images, voice, music, video and 3D, transcribe, and label on the user's own hardware. A small model that can call `generate_image` or `speak` becomes far more capable than its size suggests; that is the profound part.

- **One tool catalog, generated from the protocol schema.** The same protobuf definitions that drive the apps also generate the MCP tool list (`transcribe`, `label_image`, `generate_image`, `edit_image`, `generate_speech`, `clone_voice`, `generate_music`, `generate_video`, `generate_3d`, `job_status`, `list_models`, `estimate_cost`). The MCP surface can never drift from what the app can do, and the breaking-change checks in section 9 cover it too.
- **Built into the daemon, two transports.** stdio for agents on the same machine (`hildegard mcp`), and Streamable HTTP for agents elsewhere, reachable over the same iroh / Tailscale paths as the phone. Remote MCP uses OAuth 2.1 as the MCP spec requires, mapped onto Hildegard's paired-device grants.
- **Long jobs are jobs, not hanging calls.** A tool returns a job id immediately with progress notifications; results come back as MCP resources (`hildegard://outputs/<hash>`) so large media isn't stuffed into the model's context. Short jobs (TTS of one line, transcription of a short clip) can return inline.
- **Agents go through the same scheduler.** Agent requests are a fourth priority class below interactive by default, so an agent looping overnight can't steal the GPU from someone using the laptop. A user can raise a specific agent's priority.
- **Agents get scoped, revocable grants**, exactly like devices: which tools, which models, a GPU-hours cap, and an API spend cap (agents cannot spend money on outside APIs unless a grant says so). Every agent call is logged in the Queue and Costs screens with the agent's name.
- **Prompt-injection safety:** tools that only generate are low risk; anything that reads the user's gallery or files is a separate, off-by-default permission, and tool outputs are returned as data, never as instructions.
- **Also exposed as an OpenAI-compatible HTTP API** (images, audio speech, audio transcriptions, chat for local LLMs), so existing apps that already speak that API can point at Hildegard with one setting change.

## 3b. Rented and free cloud compute as Choir members

*Added 2026-10-16 at Donovan's request.* Not everyone owns a big GPU, so users can bring rented or free cloud GPUs into their cluster alongside their own devices. The rule is one daemon everywhere: a cloud node runs the same `hildegardd`, packaged as a container image, and joins the Choir by pairing code over iroh, using an outbound connection only. No ports need opening, and the scheduler sees it as just another server-mode device with a price per hour.

| Provider | How it joins | Notes |
|---|---|---|
| **Runpod** (Pods) | One-click: Hildegard calls the Runpod API with the user's key, starts a Pod from the published Hildegard image, and it pairs itself. Also a public Runpod template for manual use. | Best fit. A network volume caches model weights so restarts are fast. Runpod Serverless can run ComfyUI workflows for bursty jobs. |
| **Google Colab** | A Hildegard notebook installs the daemon, mounts Google Drive for model cache, and shows a pairing code. | Sessions are time-limited and can be reclaimed, so the scheduler treats Colab nodes as preemptible. Colab's free tier restricts some generative and remote-UI uses, so default to paid runtimes, and the notebook links Google's current terms. |
| **Hugging Face Inference Endpoints / GPU Spaces** | Deploy the Hildegard image as a custom container; it pairs on boot. | Good for always-on hosting billed by the hour. |
| **Hugging Face ZeroGPU Spaces** | Not a node (GPUs are lent per function call). Used as a **remote backend** instead: Hildegard calls a Space's Gradio API like an outside model. | Small free quota, great for trying models; outputs come back into the user's gallery. |
| Others later (Vast.ai, Lambda, Modal, Paperspace, a friend's PC) | Same container image or install script. | |

What makes it safe and cheap:
- **Privacy is labeled, not hidden.** A cloud node is someone else's machine. The Choir and Create screens mark cloud nodes, and a per-project setting can keep sensitive work (voice clones of real people, personal photos) on owned devices only.
- **Cloud nodes hold no long-term secrets.** They get a short-lived, scoped grant, never the user's API keys or full gallery; outputs stream back to an owned device and are wiped from the node.
- **Cost-aware scheduling.** Each cloud node carries its live price. The scheduler prefers owned hardware and uses cloud when the user forces a job, sets a deadline, or the queue would otherwise wait too long, showing the cost before running.
- **Auto shutdown.** Idle cloud nodes stop themselves after a user-set timeout (default 10 minutes) and budget caps stop them hard, so no one wakes up to a surprise bill. This shows in the Costs screen next to API spending.
- **Warm starts.** Images are slim, weights come from the cached volume or by hash from another Choir member, and the most-used models load at boot.

## 4. Desktop apps: Tauri 2 + TypeScript + React

**Why Tauri 2:** the native shell is Rust, so the desktop app embeds the same core crates as the daemon; bundles are a few MB instead of Electron's ~100 MB+; memory use is far lower; and it has a built-in signed auto-updater and a permission ("capabilities") system that limits what the UI can call.

**Why React for the UI:** the largest ecosystem for the hard UI pieces Hildegard needs (waveform editors, timeline/video scrubbing, node graphs for the Choir view, virtualized galleries), and the widest hiring and contributor pool for an open source project. Svelte 5 or SolidJS would be marginally faster and lighter; the gap is small enough that ecosystem wins. Pair with a token-based design system (one source of design tokens exported to CSS, Swift and Kotlin) so desktop and mobile stay visually identical.

**Known risk:** Tauri uses the OS webview (WebKit on Mac, WebView2 on Windows, WebKitGTK on Linux). WebKitGTK is the weakest, especially for heavy canvas/WebGL work. Mitigations: render waveforms and video previews with WebGPU/WebGL carefully profiled on Linux in CI, keep a Linux performance budget, and treat Linux as a first-class test target from day one.

**Alternatives considered:**
- *Electron*: most predictable rendering (bundled Chromium) but heavy, and a worse security default. Fallback only if WebKitGTK proves unworkable.
- *Fully native per platform (SwiftUI, WinUI, GTK)*: best feel, but three UIs to build and keep pixel-consistent; not realistic for one project at this design bar.
- *Flutter / Compose Multiplatform desktop*: good, but desktop maturity and accessibility lag Tauri + web.

**System tray / menu bar popover:** Tauri tray APIs on Mac and Windows; on Linux, StatusNotifierItem.

**Omarchy plugin:** Omarchy is Arch + Hyprland, so the plugin is a `systemd --user` service for `hildegardd`, a Waybar module (mode, load, current job, pause toggle) fed by the `hildegard` CLI's JSON output, a Walker menu entry, and an AUR package. The CLI is a first-class client anyway, so this is mostly packaging.

## 5. iOS and Android: native UI on a shared Rust core

**Recommendation:** SwiftUI on iOS, Jetpack Compose on Android, with a shared Rust library (`hildegard-core`) exposed through **UniFFI**. The shared core holds the iroh connection, the generated protocol client, pairing and crypto, and offline caching logic. Each app's UI is native.

**Why not one cross-platform UI:**
- *Tauri mobile*: works, but mobile is its least mature target and webviews feel non-native on phones.
- *Flutter*: excellent and fast to build, but non-native controls, and it would be a fourth UI stack.
- *React Native*: could share some React code with desktop, but the shared logic Hildegard really needs (networking, crypto) is Rust, not UI.

Native UI also gives first-class audio playback, background downloads, share sheets, widgets, Live Activities (job progress on the lock screen) and accessibility.

**Push notifications** ("your render is done"): APNs and FCM require a sender with Apple/Google credentials. Run a tiny open-source relay that forwards **content-free, end-to-end-encrypted** wake-ups; the phone decrypts the payload locally. Self-hosters can run their own relay; Android users can use UnifiedPush/ntfy instead of FCM.

## 6. How phones reach a home server

### Comparison

| Option | Extra app/account needed | End-to-end encrypted (no third party can read) | Works behind CGNAT | Takes the phone's VPN slot | Self-hostable | Fit for Hildegard |
|---|---|---|---|---|---|---|
| **iroh (embedded)** | No | Yes (QUIC/TLS 1.3 between device keys; relays only forward ciphertext) | Yes (holepunching, relay fallback) | No | Yes (relay server is open source) | **Best default** |
| **Tailscale** | Yes, Tailscale app and account | Yes (WireGuard) | Yes | Yes (iOS allows one active VPN) | Control plane via Headscale | Great option for people who already use it |
| **Headscale** | Tailscale app + your own server | Yes | Yes | Yes | Yes | Power users only |
| **NetBird** | Yes, NetBird app | Yes (WireGuard) | Yes | Yes | Yes, fully open source | Similar to Tailscale; could be added later |
| **Plain WireGuard** | WireGuard app, manual keys | Yes | No (needs a port forward and public IP) | Yes | Yes | Too much setup for the audience |
| **Cloudflare Tunnel** | Cloudflare account and a domain | **No**: TLS ends at Cloudflare, which can see requests and generated media | Yes | No | No | Advanced option for browser access |

### Recommendation

1. **Default: built-in iroh connection.** Pairing is a QR code on the desktop that carries the device's public key and a one-time pairing secret; the phone scans it and from then on dials the server *by key*, from anywhere. No account, no extra app, no port forwarding. iroh reached 1.0 in June 2026 and is designed for exactly this (embedded, dial-by-key, NAT traversal, relay fallback). Hildegard can use n0's public relays by default and let users point at a self-hosted relay. This is the "better way" Donovan asked about.
2. **Option: Tailscale.** If the phone and server are already on a tailnet, the app connects over it directly (the daemon can also join a tailnet itself via Tailscale's embeddable `tsnet` library, so no Tailscale install is needed on the server). Keep this because many target users already run Tailscale.
3. **Advanced option: Cloudflare Tunnel**, documented honestly as "for opening Hildegard in any web browser from a public URL." Require Cloudflare Access in front of it, keep Hildegard's own device authentication on top, and warn clearly that Cloudflare terminates TLS. Free-plan request body limits (100 MB) also make large uploads to it unreliable.

### Rules that hold for every transport

- **The network is never trusted.** Every client is a paired device with its own key; every request is authenticated at the application layer regardless of whether it arrived over iroh, Tailscale, a tunnel, or the LAN.
- **Scoped, revocable device grants.** Each paired device gets a capability token (for example "submit jobs, view gallery, no API key management"), revocable from the Choir screen.
- **Keys at rest:** daemon keys in the OS keychain (Keychain, Windows Credential Manager/DPAPI, Secret Service/libsecret); phone keys in Keychain with `ThisDeviceOnly` and biometric access control, Android Keystore with StrongBox where available.
- **No unauthenticated localhost HTTP API.** Local clients use a Unix socket / named pipe with OS permissions, or authenticated loopback with Host-header checks, to rule out DNS-rebinding attacks from a browser tab.

## 7. Security, from day one

**Threat model to write first:** (1) a stranger on the internet, (2) a malicious or compromised model download, (3) a malicious dependency, (4) a lost or stolen phone, (5) another user or app on the same machine, (6) Hildegard's own update channel.

| Threat | Built-in defense |
|---|---|
| Internet attacker | iroh/WireGuard transport, mutual device auth, no open ports by default, rate limiting, fuzzed protocol parsers (`cargo-fuzz`). |
| Malicious model | safetensors/GGUF only; manifest hashes pinned; Python workers sandboxed with **no network and read-only access** to everything except their scratch dir (Linux: bubblewrap + Landlock + seccomp; macOS: sandbox profiles; Windows: AppContainer / restricted tokens). |
| Malicious dependency | Lockfiles everywhere; `cargo-deny` and `cargo-audit`, `npm audit`/`osv-scanner` in CI; minimal dependencies in the core; pinned and hash-checked Python wheels; Dependabot/Renovate with review. |
| Lost phone | Revoke the device from any other device; short-lived session tokens; biometric unlock for sensitive actions (adding API keys, Force now on another person's machine). |
| Local users/apps | Daemon runs as the user, not root; socket permissions; outputs stored with user-only file permissions; optional at-rest encryption of the gallery. |
| Update channel | Signed releases (Tauri updater signatures, Sigstore/cosign for artifacts), reproducible builds as a goal, SBOM per release, macOS notarization, Windows code signing. |
| API keys | Stored only in the daemon's keychain entry, never sent to clients after entry, never logged; per-key budget caps enforced in the daemon before a request is sent. |

Also: an external security audit before 1.0, a published `SECURITY.md` with a disclosure process, and opt-in-only telemetry and crash reports (self-hostable, scrubbed of prompts and outputs).

## 8. Speed and optimization

- **Model residency is king.** Keep hot models loaded, unload by least-recently-used under VRAM pressure, and predict upcoming needs from the queue.
- **Right backend per chip:** MLX/Metal on Apple Silicon, CUDA (with TensorRT where it helps) on NVIDIA, ROCm or Vulkan on AMD, DirectML fallback on Windows, CPU as last resort. Hardware detection in onboarding picks quantizations that fit.
- **Stream everything:** tokens, audio chunks, preview frames and progress stream to clients as they're produced, so perceived latency is low even when total time is long.
- **Zero-copy, hash-addressed media.** Outputs are written once to the blob store and served by range requests; thumbnails and waveform peaks are precomputed.
- **Budgets enforced in CI:** daemon cold start, app launch to interactive, idle memory, UI frame time on a reference Linux machine, and per-model throughput. A change that blows a budget fails the build.

## 9. Zero regressions

"Zero regressions" is achieved by making regressions *mechanically hard to merge*, not by care alone.

1. **Monorepo** (Rust workspace + pnpm workspace + iOS + Android) so every change is tested against every client in one CI run.
2. **One protocol schema** with `buf breaking` checks: a change that would break an older phone app talking to a newer server (or vice versa) fails CI. Support at least N-1 versions across the cluster, since devices update at different times.
3. **Deterministic simulation tests for the scheduler and cluster** (fake clock, fake network, fake devices) covering failover, partitions, preemption, the user returning mid-job, and Force now. This is where distributed bugs are cheapest to catch.
4. **Golden-output tests for models:** fixed seeds and inputs, compared by tolerance (perceptual hash for images and video frames, spectral distance for audio, word error rate for transcription), run on real hardware.
5. **Hardware CI matrix:** self-hosted runners on an Apple Silicon Mac, an NVIDIA Linux box, a Windows machine, and an AMD machine. Generative AI regressions are often backend-specific and invisible on cloud CI.
6. **Visual regression testing for the design:** screenshot tests of every screen in light and dark mode on all desktop platforms (Playwright for the web UI, snapshot tests for SwiftUI and Compose). Any pixel change needs explicit approval, which suits the near-perfectionist design bar.
7. **Database migrations tested forward from every released version**, using fixture databases from each release.
8. **Property tests and fuzzing** for parsers, the cost ledger and the scheduler's placement logic.
9. **Release channels:** nightly, beta, stable, with feature flags so unfinished work ships dark. Stable only promotes builds that spent time on beta.
10. **Merge queue with required checks and review**, so `main` is always green.

## 10. Cost tracking

- A versioned, open **pricing table** per provider and model, updated by PRs (and shown with an "as of" date in the UI).
- Costs computed from the provider's own usage figures in each response (tokens, characters, seconds), never estimated after the fact; estimates are shown *before* the request for confirmation.
- **Savings** computed by pricing each local job as if it had gone to a comparable API, with the comparison model shown so the number is defensible, minus a local electricity estimate from measured GPU power draw.
- Budgets and caps enforced in the daemon, so no client can overspend.

## 11. Decisions for Donovan

These are the choices that change the project's direction; everything above is a recommendation that can proceed by default.

1. **License.** AGPL-3.0 keeps hosted forks open; Apache-2.0 maximizes adoption and contributions. Recommendation: **AGPL-3.0 for the daemon, Apache-2.0 for the protocol and client libraries**.
2. **UI framework.** Recommendation: **React**; Svelte 5 is the lighter alternative if you prefer it.
3. **First modalities for an MVP.** Recommendation: transcription, image labeling, image generation and TTS first (they validate the scheduler, cluster and phone app on smaller models), then music, then video and 3D.

## Sources

- [Open Source Higgsfield challenge (Comfy)](https://comfy.org/open-source-higgsfield)
- [Comfy blog: Higgsfield promised to open source](https://blog.comfy.org/p/higgsfield-promised-to-open-source)

- [Iroh 1.0: Dial Keys, not IPs (iroh.computer)](https://iroh.computer/blog/v1)
- [iroh 1.0.0 on docs.rs](https://docs.rs/crate/iroh/1.0.0)
- [Tailscale on iOS (tailscale.com)](https://tailscale.com/docs/install/ios)
- [libtailscale package](https://pub.dev/packages/libtailscale)
- [Tauri vs Electron 2026 (pkgpulse)](https://www.pkgpulse.com/guides/electron-vs-tauri-2026)
- [Tauri 2 desktop and mobile deep dive (2026)](https://www.youngju.dev/blog/culture/2026-05-14-tauri-2-rust-webview-desktop-mobile-electron-alternative-deep-dive-2026)
