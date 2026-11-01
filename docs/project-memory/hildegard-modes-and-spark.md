---
name: hildegard-modes-and-spark
description: How Hildegard's opportunistic sharing, "any free device" placement and DGX Spark support fit together (as of 0.1.11, PR #44)
metadata:
  type: project
  modified: 2026-10-28T07:31:12.151Z
---

Donovan (2026-10-26) asked for DGX Spark support, good opportunistic clustering, and modes: opportunistic on means
lower priority for other tasks; off means every job sent runs.

There is ONE opportunistic setting: `hildegard choir opportunistic on|off` (POST /api/choir/opportunistic, kept in
<data>/choir/settings.json, from PR #39/#43). It governs paired devices' (guest) renders on the sharing computer: they
go behind its own work and wait while it's busy. Its own work never waits. A first attempt with a separate per-device
"mode" (/api/mode, activity.ts) was dropped on 2026-10-28 to avoid two overlapping settings; don't bring it back.

PR #44 (0.1.11, 2026-10-28) added on top: presence.ts (owner input in last 3 min, other programs holding >=1 GiB GPU
memory on Linux/NVIDIA, e.g. parish1's qwen3 server), a 5 s watch that interrupts a running guest, sharing.busy,
POST /api/choir/presence + `hildegard choir presence away|back` (Omarchy panel's IdleMonitor uses it),
`choir use auto` with place() in choir.ts, and Spark ComfyUI flags (--disable-mmap --disable-dynamic-vram), Chatterbox
on CPU there. Spark detection itself (GB10 name + [N/A] memory, 0.9 of RAM) is from PR #37.

PR #45 (0.1.12) carries the four #44 review fixes (#44 auto-merged before they were pushed): Job.models incl. keyframe stills model, remote fit over a local "no", GPU-memory check only with managed ComfyUI, auto devices never placed on (NodeInfo.auto). Later rounds added: Choir.record emits on eligibility change, place() never falls back to an unready device, and pure helpers withRemoteFit (choir.ts), gpuSourceFor (presence.ts), takeModels (scheduler.ts) with tests. Merged 2026-10-28 08:39Z.

Not done yet: splitting one model across devices (llama.cpp RPC / xDiT), running takes in parallel across devices
(auto still runs one job at a time fleet-wide), real-Spark testing. See [[hildegard-roadmap]].
