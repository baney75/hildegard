---
name: devices
description: Donovan's test devices for Hildegard (GPUs, OS, Remote Control folders) and what each can run
metadata:
  type: project
  modified: 2026-10-20T12:01:24.064Z
---

- parish1: Linux, RTX 4080 Laptop GPU 12 GB, driver 610.57, Node 26 (no corepack; pnpm installed into repo `.tools/`). RC folder /home/baney75/Projects. Real GPU test 2026-10-20 on cinema-studio@58328e7 passed: install.sh 67 s, torch cu130, ComfyUI 0.42.1, smoke render on cuda:0. Fits Wan 2.2 5B only; LTX needs 24 GB. Test install left at ~/.local/share/hildegard-gpu-test, server :7351.
- abbey1: WSL2 on a Windows PC (Microsoft Basic Render Driver in WSL, no nvidia-smi there; 27 GB RAM, ~920 GB free, checked 2026-10-23). RC folder /home/baney75/Projects. Good Windows/WSL install test box; GPU passthrough unconfirmed.
- rectory1: Mac, RC folders under /Users/baney (Projects, Documents, Downloads...).
- No Windows device reachable by RC; Windows is covered by CI.

**Why:** real-GPU and per-OS testing is part of the "fully done" bar. **How to apply:** pick parish1 for NVIDIA tests, rectory1 for Mac; accepting model licenses stays Donovan's call. See [[hildegard-roadmap]].

**Standing default (Donovan, 2026-10-21):** "baney fleet" devices get full access, no permission prompts ("full yolo"). On any device a session uses, set ~/.claude/settings.json permissions.defaultMode bypassPermissions plus allow Bash/Edit/Write/Read/WebFetch, and skipDangerousModePermissionPrompt. Don't ask him to approve routine commands; licenses, account links, releases and outbound email still need his yes.

**Fleet rendering (Donovan, 2026-10-21):** "Use the gpu of parish1, thats how this is supposed to work." A Mac (or any weak device) runs Hildegard and renders on a fleet GPU like parish1, never downloading models locally; this is a core selling point. Built as the "Choir" slice: authenticated node endpoints + `hildegard choir invite/join/use`, over Tailscale, never a raw ComfyUI exposed on the network.

**2026-10-23 overnight grant (Donovan, in the Build thread):** full access on rectory1/parish1/abbey1, no prompts, restart test servers, accept Wan 2.2 + LTX licenses, use his HF login, render freely. Device sessions only honor such grants when he writes them in the thread itself, not relayed from the project chat. rectory1 reaches parish1 and abbey1 by `ssh <name>` (BatchMode), so one RC session can drive the fleet.
