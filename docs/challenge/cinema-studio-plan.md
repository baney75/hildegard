# Hildegard Cinema Studio: #OpenSourceHiggsfield entry plan

> **Status 2026-10-16:** active. The entry is Hildegard itself (the hildegard repo), not a separate project.

*Draft, 2026-10-16. Rules: https://comfy.org/open-source-higgsfield. Submissions close 2026-10-30 9am PT; winners 2026-11-06.*

## What it is

An open-source rebuild of Higgsfield's Cinema Studio, as the first working slice of Hildegard. You pick a **camera body**, **lens**, **focal length**, **aperture**, **camera move** and **look**, type the shot, and get an LTX video with synchronized audio, rendered on your own GPU through ComfyUI. Every shot is also callable by agents through an **MCP server**, so Claude or a small local model can direct a sequence of shots.

## Prize targets

| Prize | Why we qualify |
|---|---|
| Best Overall ($10K) | Complete, polished, runs locally, part of a larger real product. |
| Open Weights Only (RTX 5090) | LTX open weights only; no partner nodes or paid APIs. |
| LTX VFX workflow ($2K) | LTX is the core video model. |
| Most Innovative (RTX 5090), stretch | Agents directing shots via MCP on your own GPU; demo video must say why it's new. |

## Scope (must have by Oct 27, leaving 3 days for video and polish)

1. **Workflow pack** (`workflows/`): versioned ComfyUI API-format graphs on LTX:
   - Text-to-video and image-to-video base shots.
   - **Camera moves** from Lightricks' LTX-2 camera-control LoRAs (dolly in/out/left/right, jib up/down, static), plus motion transfer from a reference clip via the LTX IC-LoRA guide (`LTXICLoRALoaderModelOnly`, `LTXAddVideoICLoRAGuide`) for moves without a LoRA (orbit, POV, crane).
   - **Camera body and lens looks** (35mm film, 8mm, DV camcorder; anamorphic, vintage, clean) as prompt conditioning plus post nodes (grain, halation, vignette, aspect crop, color grade LUTs).
   - Every model file pinned by Hugging Face repo + revision + hash; only pinned node packs (ComfyUI core, ComfyUI-LTXVideo, VideoHelperSuite).
2. **Preset schema** (`presets/*.toml`): camera, lens, move, look → which workflow, LoRA, strength, prompt fragments, post settings. This is the same manifest format Hildegard will use.
3. **Studio UI** (`app/`): React + TypeScript, styled with the Hildegard design system (dark default, viriditas green, gold live states). Director's panel with Camera, Lens, Move, Look; shot prompt; queue with live previews; gallery. Talks to ComfyUI through the Comfy SDK / API.
4. **MCP server** (`mcp/`): tools `list_presets`, `direct_shot` (returns a job id), `shot_status`, `get_shot` (returns an output resource), `make_sequence` (several shots, stitched). stdio transport.
5. **One-command local run**: `uv`-managed ComfyUI install script that fetches pinned nodes and models, then `pnpm dev` for the app. Tested on an NVIDIA box; Apple Silicon noted as best effort.
6. **License**: Apache-2.0 for the entry repo (keeps it easy for others to fork); the wider Hildegard license decision is still Donovan's.

## Nice to have

- **Re-shoot**: upload a clip, re-render it with a new camera move (IC-LoRA motion transfer).
- Try-it link on Comfy Cloud.
- **Run on Runpod** one-click template (Runpod is a contest partner, and it lets people without a big GPU try the entry), plus a Colab notebook.
- Shot list import (paste a scene, get a storyboard of shots via an agent).

## Submission checklist

- [ ] Public repo `baney75/hildegard` with code, workflows, license, run instructions
- [ ] Demo video ≤ 2 min: the director's panel, three moves, an agent directing a short sequence over MCP, and a line on why it's open weights only
- [ ] Social post with the video, tagged #OpenSourceHiggsfield
- [ ] Typeform entry (Donovan submits; one entry per person)

## Needs from Donovan

- Create the empty public repo `baney75/hildegard`.
- A machine with a capable NVIDIA GPU (LTX-2 19B wants ~24 GB+ VRAM, or a distilled/quantized variant) to run and record the demo; or Runpod / Comfy Cloud credits.

## Open questions to verify during build

- Exact Comfy SDK / Router usage that satisfies "built with the Comfy Developer Platform" for a fully local, open-weights entry (docs.comfy.org).
- Full list and licenses of the LTX-2 camera-control LoRAs on Hugging Face (Lightricks org), and the LTX model license terms for redistribution of workflows (we only reference weights, never rehost them).
