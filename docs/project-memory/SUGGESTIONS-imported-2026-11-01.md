# Hildegard: where things stand and what to do next

Compiled 2026-11-01 from the project's open threads, project memory, the roadmap, and GitHub (baney75/hildegard main at 429dc97, version 0.1.12).

## 1. Things only you can do (ranked by urgency)

1. **NLnet grant for Hildegard Link closes 2026-11-03.** You must write and submit it yourself. The plan, budget and talking points are in `project-files/architecture/link-funding-plan.md`.
2. **Wake the rectory1 session in "Build Hildegard".** Send any message there ("go"). It then moves gatehouse1 and the Mac from 0.1.5 to the current release, updates parish1 and abbey1 remotely, and checks that a failed update rolls back on a real device.
3. **LTX licensing.** Two open questions from `project-files/architecture/licensing.md`: should we email licensing@ltx.io about license item 20 (no competing products), and do you expect revenue at or above $10M? Until answered, Wan 2.2 (Apache-2.0) stays the license-free option alongside LTX.
4. **Omarchy marketplace.** Give the OK for a parish1 session to run a real fresh Omarchy install and take a real screenshot for the listing, then say yes to submitting to the marketplace (thread "Make Omarchy install great"). Hildegard is not in the marketplace registry yet.
5. **GitHub repo polish** that the cloud can't set: `gh repo edit baney75/hildegard --description ... --add-topic ...` and upload `brand/social-preview.jpg` under Settings, Social preview. Copy is in `brand/listing.md`.
6. **Hildegard Link pricing.** The "MCP linking and tunnel costs" thread proposed Link Plus at $24 a year with profit capped at 30%, free tier 2 GB a month. It's still waiting on your yes or a change. Tailscale remains the shipping option; Link shows "coming soon".
7. **Host owner on parish1** (open since 2026-10-23).
8. **Review PR #56** (local secret-scan pre-commit hook), which is open now.

## 2. Unfinished engineering work (roadmap)

**Clustering (Choir).** The biggest gap against the vision. Done: pairing over Tailscale, opportunistic sharing, presence detection, `choir use auto`. Not done:
- Split one large model across devices, including opportunistic ones still in daily use (llama.cpp RPC and MLX distributed for LLMs, xDiT for video diffusion). Split groups must heal when an owner comes back.
- Run takes in parallel across devices. Auto still runs one job at a time fleet-wide.

**Real hardware testing.**
- DGX Spark: detection and ComfyUI flags shipped in 0.1.11, but nothing has run on a real Spark.
- Voice studio: real-GPU check on parish1 and gatehouse1, then pin the voice models in `models.lock.json` (huggingface.co is blocked from the cloud, so do it from rectory1 or CI).
- Apple GPUs: every model is off on MPS because Wan 2.2 took 70 minutes and came out blurred. Ideas not yet tried: ComfyUI `--fp32-vae` or `--force-fp32`, bf16 weights, and an early check that rejects blank or NaN frames.
- Hugging Face browser sign-in has never been confirmed end to end with a real browser.

**Open issues.** #53 (pack-skills icons: realpath, zip collisions, more refusal tests) and #49 (follow-ups to the baney-review status gate).

**Products and studios still to build.**
- Music studio (shown as "coming soon" on the site).
- Sites canvas: free drag-and-drop layout, the one thing still missing against pen.dev.
- Skill suggestions: sandboxed evals and a model reviewer in CI.
- Runpod deploy exists; Hugging Face Jobs and Colab compute are not built yet.
- Phones: iOS and Android remote apps (roadmap phase 4).
- No AUR package exists, although `brand/listing.md` mentions one. Either publish `hildegard-bin` or fix the copy.

## 3. Suggestions

- **Do the NLnet application first**, today or tomorrow. It is the only hard deadline left, and funding Link would pay for the relay work.
- **Make model splitting the next big feature.** It is the promise no rival makes ("cluster your own devices"), and the scheduler groundwork from 0.1.11 and 0.1.12 is already in place. Start with LLM splitting through llama.cpp RPC, which is the most mature, then video.
- **Run one hardware day** with a Remote Control session on rectory1 that drives the fleet over ssh: update every machine, voice GPU check, pin voice models, rollback check, Omarchy fresh install and screenshot. That clears five open items at once.
- **Submit to the Omarchy marketplace** right after that fresh install. The plugin already passes the marketplace's security scan in CI.
- **Settle LTX before any public push.** If the answer to item 20 is unclear, make Wan 2.2 the default and keep LTX opt-in.
- **Add the desktop auto-updater check to the release checklist.** Signed updates exist since 0.1.9, but devices stuck on 0.1.5 show that old installs need a nudge.
- **Keep a short public changelog** on dbaney.com/hildegard. Releases publish themselves, but visitors see no history.

## 4. What has been built (for reference)

Releases v0.1.0 through v0.1.12 (0.1.8 never published). Highlights: Cinema Studio on ComfyUI (LTX and Wan 2.2), Characters with consistency, premium Voice studio with living consent for cloning, signed native updates with rollback, Choir clustering with opportunistic sharing, MCP for every chatbot (Claude Code plugin, ChatGPT, Grok), generate/render/critique/refine loops for image, video, audio, 3D, web and OpenSCAD, 3D printing workflow, Sites with templates and Figma import, content safety (guard node, blocklists), agent bug and idea reports, the Omarchy plugin, and the website at dbaney.com/hildegard.
