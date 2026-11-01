# Hildegard licensing review

Reviewed 2026-10-19 against branch `cinema-studio` (repo read-only for this review). This is an engineering review of license texts, not legal advice. Item 20 and the $10M threshold are the two points worth a lawyer's or Lightricks' written answer.

## Decision

**Keep the planned split. It is compatible with everything Hildegard links, ships or talks to.**

- **App** (`apps/`, `packages/comfy`, `packages/shared`, `mcp/`, `install/`, `deploy/`): **AGPL-3.0-only**. All runtime npm dependencies are MIT, ISC or BSD-3-Clause, which are GPL-compatible. AGPL qualifies as the "open-source license" the challenge asks for.
- **Presets, workflows, `packages/presets`, `comfy-nodes/hildegard_look`**: **Apache-2.0**. Apache-2.0 can be combined into GPLv3/AGPLv3 works, so the AGPL server can import `@hildegard/presets`, and the node can load into GPL-3.0 ComfyUI without being relicensed.
- **Model weights**: never shipped. Each user downloads them from the publisher's Hugging Face repo and becomes the licensee. Hildegard only has to show the license honestly, let the user accept it, and avoid undermining the license (for example by stripping provenance from outputs).
- **Default video model**: LTX under the LTX Community Licenses. **Wan 2.2 (Apache-2.0)** is the license-free option. One finding: **LTX-2.5 now has its own, stricter license**, the "LTX-2.x Community License" dated 2026-08-11. The repo currently labels it with the LTX-2 license.

### Actions in the repo (in priority order)

1. **Fix model license metadata in `presets/models.toml`:**
   - LTX-2.5: `license = "LTX-2.x Community License"`, `licenseUrl = https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x`.
   - LTX-2 and camera LoRAs: `licenseUrl = https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2`.
   - Add a second license entry for the LTX-2 Gemma 3 text encoder (`Comfy-Org/ltx-2`, Gemma Terms of Use).
   - Add Wan 2.2 entries with `license = "Apache-2.0"` and `licenseUrl = https://github.com/Wan-Video/Wan2.2/blob/main/LICENSE.txt`. The HF repos link a `LICENSE.txt` that is not actually in them.
2. **Add an in-app license step before the first download of each model.** Show:
   - the license name and link
   - the $10M revenue rule
   - a short list of the Attachment A use restrictions, including the AI-disclosure rule (A.5), no deepfakes without consent (A.7) and item 20
   - the Gemma terms for LTX-2

   Record the user's acceptance (model id, license version, date) in local config. This matters most for **LTX-2, which is not gated on HF**: without this step nobody ever clicks "accept". For gated LTX-2.5, keep the current `needs-license` flow and also show the summary.
3. **Add `THIRD_PARTY_NOTICES.md` and a `licenses/` folder**, containing:
   - full texts of MIT, BSD-3-Clause, ISC and OFL-1.1, plus a single MIT copy for the Rust crates inside `@napi-rs/keyring`
   - each npm package's copyright line, generated from `pnpm licenses list --prod --json`
   - an `OFL.txt` next to the fonts

   Configure the Vite build so `dist/` ships the notices (for example `public/THIRD_PARTY_NOTICES.txt` and `public/fonts/OFL.txt`). Bundled code and fonts are distributed, so their notices must travel with them.
4. **Meet AGPL §13 in the UI.** Add a visible "Source" link, for example in the About screen and footer, pointing to the public repo at the running commit. Also:
   - add `SPDX-License-Identifier: AGPL-3.0-only` headers to app source files
   - add a copyright line ("Copyright 2026 Donovan Baney") to `LICENSING.md`
   - list `mcp/`, `install/` and `deploy/` explicitly in `LICENSING.md`
5. **Make the ComfyUI node self-contained.** Add `comfy-nodes/hildegard_look/LICENSE` (Apache-2.0) and a `pyproject.toml` with `license = "Apache-2.0"`, so the license travels with the node when it is installed or published on its own (Comfy Registry, git clone into `custom_nodes`).
6. **Keep and add AI provenance on outputs.**
   - Never strip metadata, watermarks or latent disclosures from LTX outputs. LTX-2.x §6 makes this a license condition for "any application… through which LTX-2.x… is made available".
   - Write an "AI-generated with <model> (<license>)" tag into the MP4 metadata (for example ffmpeg `-metadata comment=`) and show the same line in the export dialog. This helps users meet Attachment A item 5.
   - Email **licensing@ltx.io** about item 20 (see Open questions) before marketing Hildegard as a Higgsfield or "LTX Studio" alternative.

## Components

| Component | How Hildegard uses it | License (source) | Obligation for Hildegard | Risk |
|---|---|---|---|---|
| Hildegard app | Own code | AGPL-3.0-only (`LICENSE`, `package.json`) | §13: offer source to network users of a modified version. Add a "Source" link (action 4). | Low |
| Presets, workflows, `packages/presets`, HildegardLook node | Own code | Apache-2.0 (`LICENSE-APACHE`, SPDX headers in `look.py`) | Ship the LICENSE file with each separately distributed part. A NOTICE file is optional. | Low |
| ComfyUI | Separate program, reached over HTTP through comfy-api-proxy | GPL-3.0 ([LICENSE](https://github.com/comfyanonymous/ComfyUI/blob/master/LICENSE)) | None for the app: talking over a network to a separate program does not combine the works ([GPL FAQ, "mere aggregation"](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)). If an installer script ships ComfyUI, keep its license and give the source location. | Low |
| LTXV nodes used by `graph.ts` (`LTXVConditioning`, `LTXVLatentUpsampler`, …) | Called by name in ComfyUI core (`comfy_extras/nodes_lt*.py`) | GPL-3.0 (part of ComfyUI) | None. Hildegard does **not** use `Lightricks/ComfyUI-LTXVideo`, which is under the LTX-2 Community License. Keep it that way, or that code becomes LTX "Complementary Materials". | Low |
| HildegardLook node inside GPL ComfyUI | In-process plugin; imports only `torch` and `math`, nothing from `comfy` | Apache-2.0 | The FSF treats in-process plugins as one combined work ([GPL FAQ, plugins](https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins)). The combination must then be GPL-compatible, and **Apache-2.0 is** ([FSF license list](https://www.gnu.org/licenses/license-list.html#apache2)). The node does **not** have to be GPL. | Low |
| comfy-api-proxy 0.1.6 (PyPI) | Separate process in front of ComfyUI | MIT (PyPI `license_expression`, [repo LICENSE](https://github.com/Comfy-Org/comfy-api-proxy)) | Keep its notice if an installer ships it. | Low |
| @comfyorg/sdk 0.5.0 | Linked into the server | MIT (`package.json` + LICENSE file) | Notice in THIRD_PARTY_NOTICES. Its dependencies eventsource-parser and hash-wasm are also MIT. | Low |
| hono 4.13.13, @hono/node-server 2.1.5, zod 4.6.7 | Server runtime | MIT | Notice | Low |
| smol-toml 1.9.1 | Presets runtime | BSD-3-Clause | Notice. Do not use the author's name to endorse Hildegard. | Low |
| @napi-rs/keyring 2.1.2 (+ native binaries) | Server runtime | MIT (the Rust crates inside are MIT/Apache) | Notice | Low |
| react, react-dom 19.3.1, scheduler | Bundled into `dist/` | MIT | Notice must ship with the built bundle | Low |
| Vite 8, @vitejs/plugin-react, TypeScript, Vitest, Biome, Playwright, @axe-core/playwright, lightningcss | Build and test only, not shipped | MIT / Apache-2.0 / MIT OR Apache-2.0 / **MPL-2.0** (axe-core, lightningcss) | None, because they are not distributed. MPL-2.0 is file-level copyleft and AGPL-compatible anyway. | None |
| **Full npm scan** (`pnpm licenses list --json`, 66 packages) | – | MIT 48, Apache-2.0 7, MPL-2.0 5 (dev only), MIT OR Apache-2.0 3, BSD-3-Clause 2, ISC 1. **Production set:** MIT 12, BSD-3-Clause 1. | No GPL-incompatible, unlicensed or non-commercial licenses found. | None |
| **LTX-2 distilled fp8 + spatial upscaler** (`Lightricks/LTX-2`, not gated) | User downloads | LTX-2 Community License, 2026-01-05 ([text](https://huggingface.co/Lightricks/LTX-2/blob/main/LICENSE)) | Hildegard does not distribute, so §3 (pass the license to recipients) does not apply. Show the license and get acceptance (action 2). §8: no LTX logos or implied endorsement. | Medium (item 20) |
| **LTX-2 camera-control LoRAs** (7 repos) | User downloads | "See the base model license" ([model card](https://huggingface.co/Lightricks/LTX-2-19b-LoRA-Camera-Control-Static)), so the LTX-2 Community License | Same as LTX-2 | Medium |
| **LTX-2.5 distilled, VAEs, upscaler, Gemma 4 "with-proj" encoder** (`Lightricks/LTX-2.5`, gated) | User downloads after accepting on HF | **LTX-2.x Community License, 2026-08-11** ([LICENSE-2_x](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x)). Index: [LICENSE](https://github.com/Lightricks/LTX-2/blob/main/LICENSE). I could not read the gated HF repo, so this rests on the GitHub index saying it covers "all LTX-2.5 versions". | Applies to the user. Hildegard, as an "application through which LTX-2.x is made available", must not remove disclosures, watermarks or provenance (§6). Fix the label (action 1). | Medium |
| Gemma 3 12B-it fp8 (`Comfy-Org/ltx-2`, text encoder for LTX-2) | User downloads; not gated there | [Gemma Terms of Use](https://ai.google.dev/gemma/terms) (2026-04-01) + Gemma Prohibited Use Policy. The repo is tagged with the LTX license, but the base is `google/gemma-3-12b-it` (`license:gemma`). | Applies to the user. Show "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms" next to LTX-2. | Low |
| Gemma 4 (base of the LTX-2.5 encoder) | Inside the LTX-2.5 repo | Apache-2.0 ([google/gemma-4-12B-it](https://huggingface.co/google/gemma-4-12B-it)). As modified by Lightricks it ships under LTX-2.x. | None beyond LTX-2.x | Low |
| **Wan 2.2 TI2V-5B, T2V-A14B, I2V-A14B** (`Wan-AI/*`, or `Comfy-Org/Wan_2.2_ComfyUI_Repackaged`) | User downloads | Apache-2.0 (HF model cards; [GitHub LICENSE.txt](https://github.com/Wan-Video/Wan2.2/blob/main/LICENSE.txt)). The umt5-xxl encoder is Apache-2.0. The Comfy repack is Apache-2.0. | Show the license link. No acceptance step, revenue cap or use restrictions in the license itself; the card asks for lawful, non-harmful use. | Low |
| Cormorant Garamond (3 woff2) | Bundled | OFL-1.1, © 2015 the Cormorant Project Authors, no Reserved Font Name ([OFL.txt](https://github.com/google/fonts/blob/main/ofl/cormorantgaramond/OFL.txt)) | Ship the OFL text and copyright. Do not sell the font on its own. | Low |
| Source Sans 3 (variable woff2) | Bundled | OFL-1.1, © 2010-2020 Adobe, **RFN "Source"** ([OFL.txt](https://github.com/google/fonts/blob/main/ofl/sourcesans3/OFL.txt)) | OFL text. If you subset or modify the file yourself, rename the family away from "Source". Unmodified Google Fonts or Fontsource files are fine. | Low |
| DM Mono (400, 500) | Bundled | OFL-1.1, © 2020 The DM Mono Project Authors, no RFN ([OFL.txt](https://github.com/google/fonts/blob/main/ofl/dmmono/OFL.txt)) | OFL text | Low |
| Uncial Antiqua | Bundled | OFL-1.1, © 2011 Brian J. Bonislawsky (Astigmatic), **RFN "Uncial Antiqua"** ([OFL.txt](https://github.com/google/fonts/blob/main/ofl/uncialantiqua/OFL.txt)) | OFL text. Same renaming rule as Source Sans 3. | Low |
| Logo, wordmark, favicon SVGs | Own assets | Contain C2PA manifests showing they were made with Claude. Anthropic's terms assign outputs to the user. | Choose a license for them. Recommend keeping them **out** of Apache/AGPL: "All rights reserved, trademark of Donovan Baney", so forks rename. Keeping the C2PA metadata is fine. | Low |
| Generation parameters copied from Lightricks examples (sigma lists in `graph.ts`) | Numbers in own code | Facts and parameters; very unlikely to be copyrightable | None. Do not copy Lightricks' example workflow JSON verbatim: as "Complementary Materials" it would be an LTX Derivative. | Low |

### Model obligations: Hildegard vs. the end user

| | Hildegard (Donovan, the distributor of the software) | End user (downloads and runs the model) |
|---|---|---|
| **LTX-2 / LTX-2.x** | No redistribution, so §3 does not apply. Must not imply Lightricks endorsement (§8). Must not strip disclosures, watermarks or provenance, and must keep them in the app (§6, 2.x). Item 20 risk, see below. Donovan is also a user himself when testing and demoing. | Is the licensee. Entities with ≥ **$10M annual revenue**, counted across the whole group, need a paid license. Under 2.x, testing and evaluation in non-production use is exempt (§2.2). Attachment A applies, plus the [Acceptable Use Policy](https://static.lightricks.com/legal/ltx-acceptable-use-policy.pdf) (updated 2026-03-30, which also bans sexual content and using outputs "to build competing products or train AI models"). Must comply with the EU AI Act and California AI Transparency Act where they apply (2.x §6). |
| **Operator who hosts Hildegard for other people** (for example a RunPod deploy shared with clients) | – | "Hosts for third parties", so must put Attachment A into their terms and require users to comply (§3.1, §4) |
| **Gemma 3** | None (no redistribution) | Gemma Terms + Prohibited Use Policy; Google claims no rights in outputs (§3.3) |
| **Wan 2.2** | Keep the Apache notice if Hildegard ever ships a Wan file (it does not) | Apache-2.0; no use restrictions in the license |

**What Hildegard must show users:** the model name, publisher and license link before download; the revenue rule; the short restriction list; an acceptance checkbox saved locally; the Gemma notice for LTX-2; an "AI-generated" label on exports; a Licenses/About page with THIRD_PARTY_NOTICES and the Source link.

## Outputs

- **LTX-2 and LTX-2.x §5:** "Licensor claims no rights in the Output you generate." The user owns whatever rights exist, but output use is still bound by Attachment A. Users must:
  - disclose that content is machine generated when they publish it (A.5)
  - not make deepfakes without consent (A.7)
  - not use outputs to train competing models commercially (A.18)
  - follow the AUP's no-sexual-content rule

  Under 2.x, breaching AI-Regulation rules terminates the license automatically (§13).
- **Wan 2.2:** "We claim no rights over your generated contents." There are no license restrictions on outputs, but the card asks users not to share harmful or unlawful content.
- **Gemma:** Google claims no rights in outputs.
- **For all models:** purely AI-generated video may not be copyrightable in the US (US Copyright Office, Part 2 report, 2025). Tell users that ownership is "yours to the extent the law allows", and that they are responsible for likeness and IP in their prompts and reference images. The challenge rules also require "free of unlicensed IP or likenesses".

## THIRD_PARTY_NOTICES: what it must contain

1. A header saying Hildegard is AGPL-3.0-only (with Apache-2.0 parts), with a pointer to `LICENSING.md`.
2. For every **distributed** npm package: name, version, license, copyright line and repository URL. Today that is react, react-dom, scheduler, hono, @hono/node-server, zod, smol-toml, @comfyorg/sdk, eventsource-parser, hash-wasm, @napi-rs/keyring (+ platform binaries). Generate it with `pnpm licenses list --prod --json` in CI so it never goes stale.
3. The full text of each license used once (MIT, BSD-3-Clause, ISC, Apache-2.0, OFL-1.1). MIT and BSD require the actual text to accompany copies.
4. Fonts: family, copyright line, Reserved Font Names, OFL-1.1 text.
5. Separate, not-shipped programs Hildegard talks to (ComfyUI GPL-3.0, comfy-api-proxy MIT), each with its source URL.
6. Models: a statement that **no weights are included**, plus a table of each model's repo, license and link (LTX-2, LTX-2.x, Gemma, Wan 2.2), and the Gemma notice sentence.
7. The trademark line: "LTX is a trademark of Lightricks; Wan of Alibaba; Gemma of Google. No endorsement implied."

## Challenge (#OpenSourceHiggsfield)

Sources: [comfy.org/open-source-higgsfield](https://comfy.org/open-source-higgsfield/), [comfyui-wiki summary](https://comfyui-wiki.com/en/news/2026-10-15-open-source-higgsfield). Deadline **2026-10-30, 9am PT**.

- The repo must include "an open-source license" and setup instructions. No specific license is named, so AGPL qualifies (it is OSI-approved).
- Entries must be "built on the Comfy Developer Platform" (Comfy API, Router or SDK). Hildegard uses `@comfyorg/sdk`, so it qualifies.
- Submissions must be "lawful, SFW, and free of unlicensed IP or likenesses". This applies to the demo video (max 2 minutes) too.
- The "Open Weights Only" prize requires no partner nodes or APIs. LTX and Wan are both open weights.
- The "VFX built with LTX" bonus requires LTX as the core model, which supports keeping LTX as the default.
- The official FAQ entry "Does my repo need a license?" shows no answer on the page I fetched. Re-check before submitting.

## Open questions only Donovan can answer

1. **Item 20 (competing products).** LTX-2 and LTX-2.x Attachment A item 20 bars using LTX "in any product… that directly competes with Licensor's commercial products [LTX Studio]… or is designed to replace or substitute" them, unless you get a separate license.
   - A free, self-hosted cinema studio pitched as "open-source Higgsfield" could be read that way, even though it is free.
   - The license has no non-commercial carve-out for item 20.
   - Lightricks co-sponsoring an LTX track in the challenge is encouraging, but it does not grant a license.
   - Options: (a) email licensing@ltx.io for a written OK (recommended, before 10-30); (b) position Hildegard as a ComfyUI front-end, not an LTX Studio replacement; (c) if the answer is no, make Wan 2.2 the default.

   Does Hildegard competing with LTX Studio matter to you, and do you plan to charge for or host Hildegard?
2. **Revenue.** Are you, or anything you control or are employed by in connection with this work (BarnLabs?), at or above $10M annual revenue? If not, LTX use is free for you.
3. **AGPL-3.0-only vs -or-later.** "-only" keeps control. "-or-later" eases future relicensing by others. Either is fine for the challenge; confirm "-only".
4. **Brand assets.** OK to keep the logos and wordmark under "all rights reserved / trademark" rather than Apache or AGPL?
5. **Font provenance.** Were the woff2 files downloaded unmodified (Google Fonts or Fontsource), or subset by you? If you subset them, rename Source Sans 3 and Uncial Antiqua because of their Reserved Font Names.
6. **Hosted deployments.** Will the RunPod deploy ever serve people other than the owner? If yes, it needs a short terms page that passes on Attachment A.
7. **Contributors.** Will you accept outside PRs? Add a DCO sign-off (or CLA) now if you might ever need to relicense.

Not verified (unreachable or gated): the LTX-2.5 HF repo's own LICENSE and README (gated; relied on the GitHub index); the Gemma 3 HF model card (gated; relied on ai.google.dev/gemma/terms).
