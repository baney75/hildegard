# Safety: what Hildegard refuses

Hildegard doesn’t make sexual content, and it never makes anything sexual or suggestive involving children. No one
check catches everything, so there are several layers, each cheap where it can be and each able to stop a take on its
own. A refusal says why in plain words and costs nothing: nothing is kept, and nothing is retried.

## The layers

| Layer | Where | What it stops |
| --- | --- | --- |
| Prompt and title | `SafetyCheck.text()` in `packages/presets/src/safety.ts`, lists in `presets/safety.toml`. Called by `POST /api/shots`, again by the scheduler just before a take renders, and by `vetGraph` on every prompt in a graph another device sends | Sexual words and phrases, spelling tricks (`n.u.d.e`, `p0rn`, look-alike Cyrillic letters, zero-width spaces, `nuuude`), and any sexual or suggestive word next to a child or an age under 18. Returns `422 content_blocked` |
| Models and LoRAs | `SafetyCheck.model()`, called by `checkCatalog` for every model and LoRA in `presets/models.toml` | A name, card or tag that is sexual; Hugging Face’s `not-for-all-audiences` and similar tags; Civitai’s `nsfw` flag, its `nsfwLevel` bits for R, X and XXX, and its `minor` and `poi` flags; a repository on the blocklist |
| Model files by hash | `SafetyCheck.blockedHash()` in `apps/server/src/models.ts` | A file on `blockedSha256`, checked against the pinned hash and Hugging Face’s own hash before downloading, and against the bytes after. A blocked file is deleted |
| Hugging Face tags at download | `hubVerdict` in `apps/server/src/models.ts` | A file that isn’t pinned in `models.lock.json` and whose repository Hugging Face tags as adult |
| Every frame | The `HildegardGuard` ComfyUI node in `comfy-nodes/hildegard_guard` | A start frame, character reference, character still or rendered take that an image classifier scores as sexual. The take stops with `content_blocked`, and its preview and poster are deleted |
| Characters | `wordsRefused` in `apps/server/src/app.ts` on create and edit, and the scheduler's `castOf` before every cast shot. Reference uploads need a no-real-person attestation; a real person's character takes only the photos they take on their own consent link ([characters.md](characters.md)) | A name, description or outfit that is sexual. Reference images and character stills are checked frame by frame like everything else (the next row) |
| Every graph | `vetGraph` in `packages/comfy/src/graph.ts` | A graph without the guard after every decode and every loaded image (a reference image may reach the stills model only through it), with the wrong classifier, or with a threshold outside 0.5 to 0.95. Another device can’t send a graph that skips the check |
| Negative prompt | `NEGATIVE` in `packages/presets/src/compose.ts` | Nudity drifting into an innocent shot |

## The classifier

[`Falconsai/nsfw_image_detection`](https://huggingface.co/Falconsai/nsfw_image_detection) (Apache-2.0), a ViT-B/16
with two labels, pinned by revision and SHA-256 in `models.lock.json` like every other model file and installed with
the first video model. `guard.py` runs it in plain PyTorch with no `transformers`, so a library upgrade can’t change
what it does. It checks every frame of a short clip and 24 spread over a long one, and refuses when any scores at or
over the threshold (0.8 by default, in `presets/models.toml`). The node clamps any threshold to 0.5 to 0.95, so a
graph can’t switch it off.

## What it can’t do

- **Forks.** Hildegard is AGPL-3.0: anyone can change the code and remove the checks in their copy. The checks hold
  for the Hildegard you build and release, for every device in a Choir running it, and for any graph another device
  sends, which must carry the guard.
- **Classifiers miss things.** A word list misses new slang, and an image classifier has false negatives and false
  positives. That is why there are several layers. If ordinary shots are refused, report it with the prompt; if
  something gets through, report that too.
- **No CSAM hash matching.** PhotoDNA and similar lists are only licensed to vetted organisations. The child-safety
  rules here are words, ages and the classifier, and they are the strictest in the file: a child next to any
  suggestive word is refused, even words that are fine for an adult.

## Changing the lists

- Words and phrases: `presets/safety.toml`. Add a test to `packages/presets/test/safety.test.ts` with a prompt that
  must be refused and one that must still pass (“nude lipstick”, “a child flies a kite”).
- A model file: put its lowercase SHA-256 in `blockedSha256`. A whole author or repository: `blockedRepos`
  (`author/*` blocks every repository of that author).
- The classifier: change `[safety]` in `presets/models.toml`, pin it with `models.lock.json`, and add its repository to
  `trustedRepos` (the classifier itself is tagged adult on Hugging Face).

## Adding a way in

Any new route for a model, LoRA, prompt or picture (an importer, a URL box, a new graph) must go through the same
checks, with a test that a sexual one is refused. See the rule in [AGENTS.md](../AGENTS.md).
