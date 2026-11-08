# Open music models for Hildegard's catalog (researched 2026-11-07)

Real songs, with a voice, need a generative model; `music.py` cannot make them. This is the survey behind the catalog
recommendation. Hildegard's rule applies: the owner accepts each model's license; an agent never does. Nothing here is
in `presets/models.lock.json` yet, and no model was run for this note (no GPU job).

How sure each fact is: **confirmed** means read on the model's own card, repository or ComfyUI documentation on
2026-11-07. **Reported** means from a README summary or a third-party page. **Unverified** means not found on a primary
page. Treat reported and unverified figures as leads, and check them before shipping.

## The table

| Model | License | Commercial use | VRAM (consumer NVIDIA) | Length | Vocals | ComfyUI | Notes |
|---|---|---|---|---|---|---|---|
| **ACE-Step 1.5** (turbo, sft and base DiT, 5 Hz LM planners) | MIT, card and repo LICENSE (confirmed) | Yes, no cap; the card says generated music can be used commercially (confirmed) | the DiT alone under 4 GB; about 8 to 16 GB with the 1.7B planner (README tiers, reported) | 10 s to 10 min (card, confirmed) | Yes, 50+ languages (card) | Native in core, text-to-music (confirmed); cover and repaint not yet | under 10 s per song on an RTX 3090 (authors); no independent listening test found |
| ACE-Step 1.5 XL (4B) | as above (reported) | as above | about 12 GB with offload and quantization, 20 GB without (reported) | as above | Yes | not stated | in the README, not on the card I read |
| Stable Audio 3 (Small Music, Small SFX, Medium) | Stability AI Community License (card, confirmed); its Gemma text encoder adds the Gemma Terms of Use | Free under a revenue limit and with registration, per Stability's license page (terms below) | no figure; "consumer-grade hardware", the Small model also runs on CPU (card) | Small 2 min, Medium about 6 min (reported); the card says "several minutes" | Not stated; treated as instrumental and effects | Native repackage `Comfy-Org/stable-audio-3` (reported) | the best fit for sound effects and loops; gated download |
| Stable Audio Open 1.0 | Stability AI Community License | same | unverified | 47 s | No | Yes (reported) | older; superseded by the above |
| HeartMuLa-oss-3B | Apache-2.0 (README, reported) | Yes | unverified; a community note says 24 GB is comfortable | 4 min by default | Yes, many languages | community node only, not official | strong lyric alignment in its authors' table |
| DiffRhythm (v1.2) | Apache-2.0 for code and DiT weights (README, confirmed); VAE weights not stated | Yes | 8 GB minimum with chunked decoding (confirmed) | 4:45 (confirmed) | Yes | no mention | older than ACE-Step 1.5; later versions not documented on the README |
| YuE2 (3B) | weights CC BY-NC 4.0, plus a creator permission clause; the repo LICENSE says Apache-2.0: they conflict (reported) | No for companies; unclear for individuals | 24 GB in bf16; a community Q8 GGUF is reported at about 6 GB | unverified | Yes | native nodes and a template (reported) | treat as non-commercial |
| MusicGen / AudioCraft | weights CC BY-NC 4.0, code MIT (card) | No | unverified | short clips | No realistic vocals | unverified | superseded |
| SongGeneration / LeVo 2 (Tencent) | not readable (unverified) | unverified | 22 to 28 GB for the large model (reported) | 4:30 (reported) | Yes | not found | no license, no catalog |
| SongBloom | unverified | unverified | unverified | 2:30 to 4 min | Yes | unverified | repository could not be read; skip |

Not found: any newer open music model from 2026 beyond these, in the searches run. Independent benchmarks (blind
listening tests) were not found for any model; quality claims above are the authors' own.

## Recommendation: ACE-Step 1.5 (turbo DiT with its Qwen text encoders)

**Why this one.** It is the only candidate that is at once permissively licensed, runs natively in ComfyUI, makes
songs with vocals and instrumentals past two minutes, and fits a 12 to 16 GB GPU. The next best on license, HeartMuLa
and DiffRhythm, have no native ComfyUI path; the best fit for effects, Stable Audio 3, has a revenue-limited license
and cannot make vocals.

**Exact license terms.** MIT License, `Copyright (c) 2026 ACEStep`
(https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/main/LICENSE). The clauses that matter: permission to use,
copy, modify, merge, publish, distribute, sublicense and sell, free of charge; the copyright notice and permission
notice must stay in copies or substantial portions; the software is provided "as is" with no warranty. There is no revenue
limit, no non-commercial clause and no field-of-use limit. The Hugging Face card (`ACE-Step/Ace-Step1.5`) lists the
license as MIT and says "You can strictly use the generated music for commercial purposes." The repository asks users
to say when AI was involved and to check originality; that is a request, not a term. The card does not publish a separate weights
license, and it says its training data is "legally compliant" (licensed tracks, royalty-free and public-domain music,
and synthetic audio from MIDI); that is the authors' claim and nobody audited it. Read the live card and file list
again on the day the model is added.

**What the catalog entry needs.**
- Files (ComfyUI documentation, confirmed): the all-in-one `ace_step_1.5_turbo_aio.safetensors` in `models/checkpoints/`, or
  the split `acestep_v1.5_turbo.safetensors` (diffusion models), `qwen_0.6b_ace15.safetensors` and
  `qwen_1.7b_ace15.safetensors` (text encoders) and `ace_1.5_vae.safetensors` (vae). Pin each by revision and SHA-256 in
  `models.lock.json`, as every model is.
- The license text shown to the owner is the MIT text above; accepting it is a `needs-owner` step with the command for
  the owner to run, never an agent action. `SafetyCheck.model()` and the SHA-256 blocklist run before download as for any model.
- Lyrics and prompts go through the usual prompt gates. Voices: this model sings in a generated voice; it is not a voice
  clone and must never be given a real person's voice (the consent rules in **hildegard-sound** hold).
- A graph that makes sound is not a graph that makes frames, so `HildegardGuard` does not apply; check what `vetGraph`
  needs for a new audio-only graph before adding the node classes to `GRAPH_NODE_CLASSES`.

**Risks.** No independent quality test and no RTX 4080 speed figure; cover and repaint are not in ComfyUI core yet; the XL
variant and the LM planner inside ComfyUI were not confirmed, so ship the native turbo template first.

**Runner-up, for instrumentals and effects: Stable Audio 3 Small Music and Small SFX.** Stability AI Community License
(https://stability.ai/license): the terms, as written in the Stable Audio Open 1.0 license and not yet confirmed for
version 3, are that commercial use is free under USD 1,000,000 in annual revenue, commercial users register with
Stability AI, the outputs may not be used to train or improve another foundation model, and products carry a
"Powered by Stability AI" notice. The download is gated, and the Gemma text encoder brings the Gemma Terms of Use, so the
owner would accept two licenses. If one-click permissive licensing is the rule, use ACE-Step for instrumentals too.

## Where this runs today

Parish1 already runs ACE-Step for another tool (`parish-media music`, on-demand jobs, no resident process). Its help
text only says the arguments follow `--`; no job was run for this note. Hildegard's own install would not share that.

## Using a model from the skill

Until a music model is in `list_presets`, write the brief (see SKILL.md) for Suno or for the model's prompt box, and
give the user the rendered template as a sketch of form and chords. When the model arrives, brief it the same way:
style words, tempo, key, instruments, structure with `[Verse]` and `[Chorus]` tags, and lyrics from the **hildegard**
skill's song method.
