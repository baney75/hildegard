# Hildegard multi-device: design for residency week

**Author:** Luke (builder) for Donovan Baney / Magnus  
**Date:** 2026-11-02 (America/New_York)  
**Repo tip:** `baney75/hildegard` public `main` @ `e31a2ef` (v0.1.13)  
**Status:** in-repo design. Approved multi-device design for residency week (sections 1-6), plus the Model types v2 section. Design only: no code changes come with this document.  
**Audience:** Hildegard contributors. Machine names only: rectory1 (Mac), parish1, abbey1.

## 1. What exists now

Hildegard is a pnpm monorepo: `apps/server` (Hono daemon on port 7341 by default, `apps/server/src/config.ts`), `apps/studio` (React UI), `apps/cli` (`hildegard`), `apps/desktop` (Tauri 2 shell, bundle id `io.github.baney75.hildegard`, `apps/desktop/src-tauri/tauri.conf.json`), plus `packages/*`, `voice-engine/` (Python workers), `mcp/`, `omarchy/`, and `install/`.

**Apps.** The product people run today is the CLI + local server + Studio in a browser, installed with:

```sh
curl -fsSL https://github.com/baney75/hildegard/releases/latest/download/install.sh | sh
```

(`install/install.sh`: user-local under `~/.local/share/hildegard` or macOS `~/Library/Application Support/Hildegard`, Node + app SHA-256 checked, no sudo.) The Tauri desktop app wraps the same Studio and can bootstrap the same install (`apps/desktop/src-tauri/src/lib.rs`), but README says there are **no GitHub Releases of the app yet**; `desktop.yml` keeps artifacts for two weeks. BaneyFleet's mac-updater already expects `Hildegard.app.tar.gz` on the **stable** channel (`tools/mac-updater/channels/hildegard.json`, inventory 2026-11-01: v0.1.12).

**Voice pipeline today (not a talk loop).** `docs/voice.md` and `apps/server/src/voice.ts` / `voice-engine.ts` implement a **Voice Studio**: speak, design, consented clone, dub, transcribe. There is **no** push-to-talk conversational "voice mode" (mic → STT → LLM → TTS → speaker) in the tree.

| Stage | Where it runs | Code |
| --- | --- | --- |
| Mic capture | Studio in the browser / WebView (`getUserMedia`) | `apps/studio/src/lib/voice.ts` (`useRecorder`) |
| STT | Local Python worker, faster-whisper small | `voice-engine/` env `speech`; `TRANSCRIBER` in `voice-models.ts` |
| TTS | Local workers: Kokoro, Chatterbox, Qwen3-TTS | `voice-engine/requirements/*`; ops `speak` / `convert` |
| LLM | Separate: discovers local OpenAI-compatible servers (Ollama, llama.cpp, vLLM, …) on loopback and proxies `/v1/*` | `apps/server/src/llm.ts` |
| Consent phone page | One-time HTTPS page when host mode is on | `apps/studio/src/pages/voice/ConsentPhone.tsx` |

Workers speak JSON lines over stdin/stdout and never open the network (`voice-engine.ts` header). Voice shares the GPU with video through `Scheduler.lease()`.

**Networking and pairing.** Two related surfaces:

1. **Choir** (`apps/server/src/choir.ts`, tests in `choir.test.ts`): pair devices to **render video graphs** on another GPU. Join code `hgc1_…` carries name, Tailscale (or https) URL, and a 256-bit token; token stored hashed (SHA-256), compared constant-time. `privateLink()` allows only https, loopback, or CGNAT Tailscale ranges / `*.ts.net`. Remote surface is `/api/node/*` only (`node-api.ts`): info + vetted Comfy graphs + media fetch. Studio and `/api/voice` stay on 127.0.0.1. Placement: `place()` / `choir use local|auto|<name>` (`Settings.tsx` Devices).
2. **Host** (`apps/server/src/host.ts`, CLI `apps/cli/src/host.ts`): `tailscale serve` HTTPS on the tailnet; optional `--funnel` (public) or `--public-url`. README and host code warn that Funnel opens the sign-in page. ComfyUI and the Choir node API are never behind the link.

**Installer and updates.** `install.sh` / `install.ps1`; self-update every six hours with minisign (`apps/server/src/update.ts`, key also in Tauri updater config); rollback since 0.1.10 (`ROADMAP.md` §5). `hildegard update all` can push updates to paired Choir devices. No systemd/launchd unit ships in-tree; the process is started by CLI / desktop / Omarchy widget. RunPod boot lives under `deploy/runpod/`.

**Link.** `packages/link/` is a prototype encrypted relay for public MCP without Tailscale. ROADMAP: "Link … Not built yet; devices pair over Tailscale today."

**Gap vs Donovan's ask.** Choir pairs GPUs for **film renders**, not mic/speaker/STT/LLM/TTS, and there is no primary role or talk loop. Mac Apple silicon still cannot run the video models (README); a Linux NVIDIA box is already the film path. Voice and LLM can run on Linux today, but the Mac cannot yet keep local audio I/O while using that box as the brain.

## 2. Target architecture

Build on Choir + the fleet's existing Tailscale mesh. Do not invent a second pairing stack for Friday.

### Devices and roles

| Device | Role in target | Notes |
| --- | --- | --- |
| rectory1 (Mac) | Primary UI, mic, speaker; may hold TTS for low latency | Desktop or Studio; TCC mic permission |
| parish1 (Linux) | Server: STT, LLM, heavy TTS, later video | One-command install + user systemd |
| abbey1 | **Out of scope for Friday** | See Risks. Allowed later as a second server for model hosting (Model types v2) |
| iPhone | Mic/speaker client | PWA first (section 3) |

Any paired device can be marked **primary** (owns the session UI and default I/O). Primary is a Choir setting, not "whoever invited."

### Transport

**Prefer Tailscale (already how Choir and BaneyFleet enroll devices).** BaneyFleet onboarding and hub admission assume a signed-in tailnet; Hildegard already refuses non-private Choir URLs. LAN mDNS + pairing code is a fallback for users without Tailscale (aligns with future Link / iroh notes in `docs/roadmap/hildegard-roadmap.md`), not the residency demo path. **Funnel stays off** for this work: voice and pairing stay on Serve / tailnet IPs only.

### Auth and pairing keys

Reuse Choir tokens: invite produces `hgc1_` code; join stores token in the OS keychain via existing `SecretStore` (`choir.ts`). Extend the bearer on `/api/node/*` (or a sibling `/api/cap/*`) so the same key can call capability RPCs, still never the full Studio cookie surface. Rotate by `choir revoke` / re-invite. No ports published to the public internet.

### Capability registry

Extend `NodeInfo` (`remote-engine.ts`) beyond GPU/models/queue:

```
capabilities: {
  mic: bool, speaker: bool,
  stt: ["whisper-small"], tts: ["kokoro", …],
  llm: [{ runtime, model, vramGb }],
  gpu: { name, vramGb } | null,
  compute: "interactive" | "batch"
}
```

Primary picks routes with a small policy: prefer local I/O; prefer remote GPU for STT/LLM when local is Apple silicon or busy; never send consented voice refs off owned devices (existing privacy rule in the foundation doc).

### Voice mode routing

New **Talk** loop (Studio page + optional tray): record or stream short utterances → POST audio to the device advertising `stt` → text to the device advertising `llm` (OpenAI-compatible already in `llm.ts`) → TTS on best `tts` device → play on primary speaker. First cut: chunked HTTP (upload wav / download wav) over the tailnet. Second cut: WebRTC data/media between primary and server for lower latency. Pipeline STT, LLM, and TTS on **different** devices before any tensor-parallel.

### One-command server installer

Keep `curl | sh` as the human path. Add a **server profile** flag, e.g. `install.sh --server` or `hildegard install --server`, that: installs CLI+daemon, skips Studio browser open, writes a user `systemd` unit (Linux) or `launchd` agent (macOS) for `hildegard start`, enables voice+LLM deps, prints `hildegard choir invite` as the next step. Packaged binary optional later; Friday uses the existing release tarball.

### Distributed inference (honest ladder)

1. **Friday:** place whole requests; pipeline STT, LLM, TTS on different devices.  
2. **Next:** llama.cpp RPC or exo-style layer split for oversized LLMs (needs fast LAN; exo is young/Mac-biased; neither helps Whisper/Kokoro much).  
3. **Later:** video tensor-parallel only on multi-GPU or 10 GbE (`docs/roadmap/hildegard-roadmap.md`). Not for the residency demo.

## 3. iPhone path by Friday

**Realistic by Fri Nov 6:** open the hosted Studio (or a thin Talk PWA) over **Tailscale Serve HTTPS** on parish1 or rectory1, use browser mic/speaker (`getUserMedia` / audio element). Consent phone page already proves HTTPS + mic in-browser (`ConsentPhone.tsx`). WebRTC peer to the primary is nice-to-have if time remains after Mac↔parish1 works.

**Not realistic this week:** App Store / TestFlight native app, PushKit, background audio as a daemon, or Funnel-based public URLs.

After residency: native Swift client that speaks the same capability RPC, still over the tailnet.

## 4. Smallest end-to-end by Fri Nov 6

**MVP:** rectory1 is primary (mic + speaker + Talk UI). parish1 has Hildegard server-profile installed by one command, Tailscale up, Choir-paired. One Talk turn: Mac records → parish1 STT + LLM → parish1 or Mac TTS → Mac plays. Operator can `choir use` / set primary so parish1-driven session is visible, and switch primary back to the Mac. Invented demo script only. abbey1 unused.

### Day-by-day PR plan

Each PR: worktree on parish1; implement via `claude -p` or `cursor-agent` or `codex exec` (no hand-edited product code); tests in the PR; one Sol review via `codex exec --model gpt-6.1-sol -c model_reasoning_effort=high`; CI green; stop after round 3 if Sol still blocks; owner merges unless standing merge permission exists.

| Day (ET) | PR | Scope | Decisive check |
| --- | --- | --- | --- |
| Tue Nov 3 | **PR A - Caps + Talk stub** | Extend `NodeInfo` with capabilities; local Talk page that does STT→LLM→TTS **all on one device** (fake engine OK in CI). | Unit tests for capability schema; e2e Talk once on fake-gpu. |
| Wed Nov 4 | **PR B - Remote voice RPC** | Bearer-auth routes on the node/cap API: `transcribe`, `complete`, `speak` (file in/out). Wire Talk to call remote when primary selects a device. | `choir.test.ts` / new cap tests with two fake servers; refuse bad token. |
| Thu Nov 5 | **PR C - Server installer** | `install.sh --server` + user systemd unit; docs; `hildegard doctor` checks voice+llm+choir listen. | Dry-run install in CI container; unit starts and `/api/health` 200. |
| Fri Nov 6 | **PR D - Primary + polish** | Primary device setting; Settings Devices shows caps; latency meters; demo script page with invented lines. Optional thin phone Talk route. | Manual Mac↔parish1 script timed; switch primary; Funnel off asserted. |

If behind: ship A+B+manual parish1 install (skip polished systemd) and still demo. Do not start abbey1 or Funnel work.

## 5. Risks

- **Latency.** Tailnet RTT plus Whisper plus LLM plus TTS can exceed 2-4 s. Mitigate: small LLM on parish1, Kokoro TTS, short VAD utterances, show partial transcript. Measure on the real link before claiming "realtime."
- **Auth / exposure.** Choir already binds node API to Tailscale only. Keep Funnel off (BaneyFleet field note: Funnel broken under Tailnet Lock anyway; product rule for this demo: never `--funnel`). No 0.0.0.0 binds for voice RPC.
- **abbey1.** Luke standing notes treat abbey1 as blocked (disk/WSL fragility, homeassistant/waypost bind mounts). BaneyFleet AGENTS lists abbey1 as a live host, not a coding target. **Flag: do not install or pair abbey1 for the Friday work.** parish1 only. Note: abbey1 (GTX 1650 SUPER, 4 GB) is now an allowed second server for post-Friday model hosting; the Friday-first parish1 priority stands (see Model types v2).
- **macOS mic + signing.** Talk needs mic TCC. BaneyFleet #508 / PROJECT-STANDARD: fixed bundle id, stable Developer ID designated requirement, no ad-hoc updates that reset grants. Desktop still uses `"signingIdentity": "-"` in `tauri.conf.json` (ad-hoc). Until DR-stable release artifacts exist, prefer Safari/Chrome against local Studio for the demo mic path, or a carefully signed nightly build that matches whatever is already on rectory1.
- **Auto-update / channel.** Hildegard is on mac-updater **stable**. This week's caps/Talk should **ride a nightly (or unsigned local) build on rectory1 for the demo**, not force stable. Promote to stable only after Sol+CI and a quiet soak; flipping stable mid-week risks TCC prompts and a broken demo. CLI/server on parish1 updates via `hildegard update` from GitHub Releases independently of the Mac app channel.

## 6. Demo plan (clean room)

Staged, polished, **no personal content** (demo rule: clean environment, invented content, never the live desktop with mail/calendar/photos).

1. Cold open: two named devices on Settings › Devices: `rectory1` (primary, mic/speaker) and `parish1` (STT/LLM). Caps icons visible.  
2. One-command flashback (pre-recorded or terminal with invented hostnames): `curl …/install.sh | sh -s -- --server` on parish1, then paste join code on the Mac.  
3. Talk: operator says an invented line ("Plan a short film about a lighthouse keeper"). Transcript appears; reply speaks through Mac speakers. On-screen diagram: mic@Mac → STT@parish1 → LLM@parish1 → TTS → speaker@Mac.  
4. Switch primary to parish1 (or show `choir use parish1` for compute) and back.  
5. Close: "Your studio, on every machine you own" + public repo URL. No Funnel, no phone required for the cut; optional 10 s iPhone Safari clip if PWA works.

Record on a scrubbed Space; OCR for host paths and real names before Magnus sees it.

## Model types v2

Status: design only. Nothing here changes code, the capability schema or the Talk RPC. It extends the Friday plan with the model types a professional assistant needs, and it says in what order they may land without putting the Friday voice loop at risk.

### Ground rules

- Every type goes through the same capability registry (`DeviceCapabilities`, `apps/server/src/capabilities.ts`, [talk-caps.md](talk-caps.md)) and the same primary switch. The primary owns mic and speaker. Compute stages route by capability and VRAM policy.
- Transport is the Choir bearer: chunked HTTP on the tailnet, the same `pairedOnly` token, never Funnel, never the hosted listener. New routes are siblings of `transcribe`, `complete` and `speak` under `/api/node/*`.
- Pipeline stages only. Whole requests are placed on one device. No tensor-parallel this week.
- Order 0 is the Friday voice loop on a remote device (`whisper-small`, `kokoro-82m`, a small local OpenAI-compatible LLM on parish1). Everything else ranks after it unless flagged safe before Friday.
- Existing film models in presets (Wan, LTX, flux-2-klein) stay on the render path through Choir node render, not Talk capabilities. They already use GPU scheduling (`Scheduler.lease()`), and they must not starve Friday Talk. Nothing below changes that path.

### Measured hardware

Measured by read-only SSH, 2026-11-02 about 9:55 PM ET.

**parish1** (native Linux): NVIDIA GeForce RTX 4080 Laptop GPU, 12282 MiB VRAM (437 MiB used at measure: two hildegard-gpu-test ComfyUI python processes at 186 MiB each), driver 610.57.04. 31 GiB RAM (about 8.7 GiB available). Root 952G with 693G free, plus /mnt/storage/media 466G and /srv/magnus-data 477G.

**abbey1** (WSL2, via `/usr/lib/wsl/lib/nvidia-smi`): NVIDIA GeForce GTX 1650 SUPER, 4096 MiB VRAM (104 MiB used, Xwayland only, no compute apps), driver 595.95, CUDA 13.2. AMD Ryzen 5 3600 (12 threads). 27 GiB RAM (about 23 GiB available). Root about 1007G with 889G free, and /mnt/magnus 1.8T with 1.6T free. It currently runs Hildegard Talk with `--fake-gpu` on port 47341.

### Voice loop budget

The Friday catalog is `whisper-small` (Systran/faster-whisper-small, `minVramGb` 0), `kokoro-82m` (`minVramGb` 0) and a small local LLM on parish1 (for example Qwen3-4B at Q4, about 3-5 GB). STT plus TTS peak at about 2-4 GB on GPU when accelerated. That leaves roughly 7-9 GB of the 12 GB on parish1 for a second model, and only about 0 GB if the owner picks a 7B chat model. Treat the Talk LLM as the resident tenant. Any model larger than the headroom swaps with it (see "Residency policy").

### Per-type designs

#### 1. Image generation

- **Primary, parish1:** `black-forest-labs/FLUX.1-schnell` (Apache-2.0, 12B) through ComfyUI, already in-tree. Use GGUF Q5_K_S or Q6_K, or FP8 with a text-encoder swap. Peak is about 10-12 GB, so unload the Talk LLM and any heavy TTS before generating, or generate only while Talk is idle. Expect about 5-20 s per image at 1024.
- **Co-residency:** not with the LLM. Load/unload swapping is required.
- **abbey1:** not for FLUX. Optionally `stabilityai/sdxl-turbo` with sequential offload later, or skip image generation there. Route image generation to parish1 always.
- **Fallback:** SDXL-Turbo FP16 (about 7.6 GB) on parish1 without unloading, if the LLM is small.

#### 2. Image understanding (vision)

- **parish1:** `Qwen/Qwen2.5-VL-7B-Instruct`, Q4_K_M GGUF plus mmproj, about 8-9 GB. Swap with the Talk LLM; a 7B chat model and the 7B VL model are not co-resident. Expect about 1-3 s per image.
- **abbey1:** `Qwen/Qwen2.5-VL-3B-Instruct` Q4_K_M is about 5-6 GB, which is tight on 4 GB. Prefer parish1. CPU offload on abbey1 counts as degraded.
- **Fallback:** describe through the parish1 remote capability.

#### 3. Embeddings (memory and search)

- **Both hosts:** `Qwen/Qwen3-Embedding-0.6B` (Apache-2.0, about 0.6B, 0.6-1.3 GB). `BAAI/bge-m3` (MIT, 568M, about 1.3 GB at FP16) is the alternative. Run on CPU or low VRAM so it never contends with Talk. No swapping. Expect tens of ms per chunk.
- **Fallback:** `nomic-ai/nomic-embed-text-v1.5` (about 137M, CPU).
- **Safe before Friday if trivial:** a CPU-only worker and one route, with no GPU schedule change.

#### 4. OCR

- **parish1, interactive documents:** `PaddlePaddle/PaddleOCR-VL-1.6` (about 0.9B, about 2 GB at FP16), or GOT-OCR2 (`stepfun-ai/GOT-OCR2_0`, about 580M, about 2-3 GB). Fits beside the Talk LLM at 4B, with a short load.
- **Batch and high quality, later:** `deepseek-ai/DeepSeek-OCR-2` (about 3B, about 8 GB) on parish1, with unload.
- **abbey1:** a PP-OCRv4 or v5 mobile or server CNN pipeline on CPU or the small GPU, or GOT-OCR2.
- **Fallback:** Tesseract on CPU.

#### 5. Wake word

- **Primary device (mic owner, often rectory1 or a phone):** openWakeWord ONNX (Apache-2.0), CPU only, custom phrase trained offline. No GPU. Under 80 ms per frame.
- **Not a remote RPC.** It stays on the mic path and only advertises in capabilities.
- **Fallback:** push-to-talk only, which Friday already plans.

#### 6. Voice activity detection

- `snakers4/silero-vad` ONNX or JIT, about 2 MB, CPU, under 1 ms per 30 ms chunk. It gates STT and openWakeWord and runs always on the primary. No GPU.
- **Fallback:** fixed-length utterances.

#### 7. Reranker (justified for memory search)

- `BAAI/bge-reranker-v2-m3` (568M class; Q4 about 0.4-1 GB) on parish1 or abbey1, CPU or GPU. It runs after embeddings retrieve the top-k. Expect about 10-50 ms per pair batch.
- **Fallback:** no rerank, embedding order only.

#### 8. Speaker ID (justified, post-Friday)

- Optional. SpeechBrain `spkrec-ecapa-voxceleb` or a similar ECAPA embedding on CPU, for "whose voice" on consented enrollments only. It follows the existing voice consent rules in [voice.md](../voice.md): no enrollment without the consent session, and nothing leaves owned devices.
- **Fallback:** assume a single user.

### Summary table

| Type | Model | Host | VRAM (approx) | Order |
| --- | --- | --- | --- | --- |
| STT | whisper-small (faster-whisper) | parish1 (abbey1 overflow) | ~1 GB GPU or CPU | 0 |
| LLM | small OpenAI-compatible local (owner pick; e.g. Qwen3-4B Q4) | parish1 | ~3-5 GB | 0 |
| TTS | kokoro-82m | parish1 or primary | ~0-1 GB | 0 |
| Embed | Qwen3-Embedding-0.6B | parish1 or abbey1 CPU | ~0.6-1.3 GB (or RAM) | 0b |
| VAD | Silero VAD | primary CPU | ~0 GPU | 0c |
| Wake | openWakeWord | primary CPU | ~0 GPU | 1 |
| OCR | PaddleOCR-VL-1.6 or GOT-OCR2 | parish1 | ~2-3 GB | 2 |
| Rerank | bge-reranker-v2-m3 | parish1/abbey1 | ~0.5-1 GB | 3 |
| Vision | Qwen2.5-VL-7B Q4 | parish1 (swap) | ~8-9 GB | 4 |
| Image | FLUX.1-schnell Q5/FP8 | parish1 (unload) | ~10-12 GB | 5 |
| Speaker ID | ECAPA (SpeechBrain) | primary/parish1 CPU | ~0 GPU | 6 |

### Registry API shape

This documents the intended shape. It is not implemented here. `DeviceCapabilities` grows by optional fields, so older devices that leave them out keep working, and a claim that fails the schema is still dropped as before.

```
capabilities: {
  mic, speaker, stt, tts, llm, gpu, compute,  // existing
  imageGen: string[],      // model ids
  vision: string[],
  embed: string[],
  ocr: string[],
  wake: string[],          // usually on primary only
  vad: string[],
  rerank: string[],
  speakerId: string[]
}
```

New Choir bearer routes use the same `pairedOnly` token and sit beside `transcribe`, `complete` and `speak`. They are never reachable through Funnel or the hosted listener.

| Route | Purpose |
| --- | --- |
| POST /api/node/embed | `{ texts: string[] }` → `{ vectors: number[][] }` |
| POST /api/node/ocr | image body → `{ text, blocks? }` |
| POST /api/node/vision | multipart image + `{ prompt }` → `{ text }` |
| POST /api/node/image | `{ prompt, model?, size? }` → image bytes or media URL |
| POST /api/node/rerank | `{ query, documents: string[] }` → `{ scores: number[] }` |

Wake and VAD stay local on the primary because they sit on the mic path. They advertise in capabilities but are not remote RPCs for Friday. A claim is the device's say-so and decides nothing about trust; the bearer still opens only `/api/node/*`.

Rules that carry over from the existing routes: prompts to `/api/node/image` pass `SafetyCheck.text()`, every graph passes `vetGraph` and `HildegardGuard`, and a peer's image or document is data, never instructions.

### Routing and residency policy

- **Primary switch unchanged.** Mic and speaker stay on the primary. Compute stages route by capability plus VRAM policy: prefer parish1 for GPU-heavy work, abbey1 for light embed, OCR and rerank, or for overflow STT when parish1 is busy.
- **Residency policy.** The Talk LLM is resident. A job whose declared peak exceeds current headroom must wait for Talk to be idle, then unload the LLM, run, and reload. Vision (order 4) and image generation (order 5) are the two types that need this; embeddings, rerank, VAD, wake and speaker ID never do. Swapping is a policy in the scheduler lease, not a new GPU scheduler, and it ships only with its own test.
- **Film renders** keep priority rules as they are today. A Talk turn in progress is never preempted by a model-type job.
- **abbey1 is an allowed second server** for post-Friday model hosting (GTX 1650 SUPER, 4 GB, WSL2). Its role is light CPU and small-GPU work, and its driver and WSL behavior must be proven (order 7) before anything depends on it.

### Build order

| Order | Type | When | Risk to Friday voice |
| --- | --- | --- | --- |
| 0 | Talk STT/LLM/TTS remote | Fri Nov 6 MVP | n/a (the MVP) |
| 0b | Embeddings Qwen3-Embedding-0.6B | **May land before Friday** if CPU-only worker + one route; no GPU schedule change | Low if CPU |
| 0c | Silero VAD on primary | Before Friday if it only gates local capture | Low |
| 1 | Wake word openWakeWord on primary | Right after Friday demo | Low |
| 2 | OCR GOT/PaddleOCR-VL on parish1 | After Friday | Medium (GPU share) |
| 3 | Reranker bge-reranker-v2-m3 | After embeddings | Low |
| 4 | Vision Qwen2.5-VL-7B on parish1 | After Friday; requires load/unload vs Talk LLM | High if always-loaded |
| 5 | Image gen FLUX.1-schnell on parish1 | After Friday; unload policy required | High if co-resident |
| 6 | Speaker ID | Later; consent-gated | Low |
| 7 | abbey1 real-GPU (not fake) for light caps | After parish1 Talk proven | Medium (WSL/driver) |

Embeddings (CPU) and VAD are the only items that may safely start before Friday without risking the remote voice loop. Everything else waits for the demo.

## Sources

- hildegard `main` @ e31a2ef: README, ROADMAP, `docs/voice.md`, `apps/server/src/{choir,host,node-api,voice,llm,config}.ts`, `install/install.sh`, desktop `tauri.conf.json`
- BaneyFleet mac-updater (#509), hildegard channel stable, #508 DR-stable signing; Tailscale onboarding; abbey1 off-limits practice
- `docs/roadmap/hildegard-roadmap.md` Clusters (llama.cpp RPC / exo tradeoffs)
- Model types v2, model cards: `BAAI/bge-m3`, `Qwen/Qwen3-Embedding-0.6B`, `BAAI/bge-reranker-v2-m3`, `Qwen/Qwen2.5-VL-7B-Instruct` and `Qwen/Qwen2.5-VL-3B-Instruct`, `black-forest-labs/FLUX.1-schnell`, `stabilityai/sdxl-turbo`, `deepseek-ai/DeepSeek-OCR-2`, `PaddlePaddle/PaddleOCR-VL-1.6` and PaddleOCR, `stepfun-ai/GOT-OCR2_0`, `nomic-ai/nomic-embed-text-v1.5`, `Systran/faster-whisper-small`, SpeechBrain `spkrec-ecapa-voxceleb` (all on huggingface.co)
- openWakeWord (github.com/dscripka/openWakeWord) and Silero VAD (github.com/snakers4/silero-vad)
- In-repo: [talk-caps.md](talk-caps.md), `apps/server/src/capabilities.ts`, `presets/voices.toml`, [voice.md](../voice.md)
- Hardware: read-only SSH measurement of parish1 and abbey1, 2026-11-02 about 9:55 PM ET (abbey1 GPU read via `/usr/lib/wsl/lib/nvidia-smi`)
