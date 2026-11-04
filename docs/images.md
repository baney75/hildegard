# Images: a picture on its own, from words or from other pictures

The Images studio draws a still image without a film or a character around it. Describe what you want and Hildegard
draws it on your GPU, in the same camera language as Cinema. Or hand it up to four pictures and say what to change.

## What it does

- **Words to image.** Type what you see, pick an aspect (16:9, 2.39:1, 9:16, 1:1 or 4:3), and draw one to four images
  at once. Each has its own seed, so you get four different takes on the same words. Give a seed to draw the same
  image again with other settings.
- **Edits with up to four references.** Add pictures from your computer and say what to do with them: "change the sky
  to green evening light", "put the person from image 1 in the room from image 2". The references are named in order,
  so "image 1" is the first you added. Each reference needs your word that it shows no real person (see below).
- **Camera and look.** Everything in Cinema’s rig is optional here: a camera body, a lens, a focal length, an
  aperture, then lighting, a palette, a genre and an era. Your words come first and stand as you wrote them. The rig
  follows as sentences, and only the parts you picked. Leave all of it out and the image is your words alone.
- **Draft or final.** A draft is 768 pixels on its short side and a final is 1,024, so wide and tall shapes have more pixels and take longer; both take four steps. Draft a few, pick one,
  then draw it final with the same seed.
- **Use as start frame.** On any finished image, Use as start frame opens the composer in Cinema with that image as a
  shot’s first frame, so the video starts from exactly that picture.
- **Edit.** Edit adds a finished image to the references, so you can say what to change and draw again.

Images are queued like takes and show their progress and queue position in the Studio.

## The API

`POST /api/images` queues images and answers `201` with `{ stills }`. An image is a still with `characterId: null` and
no view, so it travels in the same lists, events and files as a character’s stills.

| Field | What it is |
| --- | --- |
| `prompt` | What to draw, 1 to 2,000 characters. Required |
| `aspect` | `16:9`, `2.39:1`, `9:16`, `1:1` or `4:3`. Default `1:1` |
| `quality` | `draft` or `final`. Default `final` |
| `count` | 1 to 4 images, each with its own seed. Default 1 |
| `seed` | A whole number to start the seeds from |
| `references` | Up to four upload names from `POST /api/uploads`, to edit or draw from |
| `noRealPerson` | `true`. Required with `references` |
| `camera` | `{ body, lens, focal, aperture }`, ids from `GET /api/catalog` |
| `look` | `{ lighting, palette, genre, era }`, ids from `GET /api/catalog` |
| `agent` | The name of the app asking, so the image is labelled with it |

A word that fails the text check answers `422` with `code: content_blocked`. A reference that is a real person’s photo
answers `422` with `code: character`: draw them as a character, on their consent.

## The MCP tool

`make_image` takes the same fields for AI apps, with `wait_seconds` to wait for the finished images and return them
inline. `references` are paths to image files on the computer Hildegard runs on; the tool uploads them for you, and
refuses them from an app on another computer. `no_real_person` is required with references, and an agent must set it
only when it knows the pictures show no real person or only artwork your user has the rights to. It must never set it
for a photo of a real person, and it must ask your user if it can’t tell. With no prompt, the tool reports the recent
images and where each one stands. `list_presets` has the ids for `camera` and `look`.

## What it won’t make

- **Nothing sexual.** The prompt goes through the text check before anything queues. Every reference passes the image
  classifier before the model reads it, and every image passes it before it’s saved. A refused image is deleted and
  says why. See [safety.md](safety.md) for the layers.
- **No real people, except as characters.** Adding references means attesting they show no real person. Hildegard can’t
  check a face against a name, so that word is yours to give truthfully; an agent gives it only for what it knows. To
  draw a real person, make them a character: they give their own consent on their own device, and only then can they
  be drawn ([characters.md](characters.md)). A real person’s photo, or any still drawn of them, is refused here when it comes back byte for byte. Hildegard doesn’t match faces, so a photo of them from anywhere else rests on your word.
- **No other models.** Images use the one stills model. A model or LoRA you add goes through the same hash and tag
  checks as any other.

## The model

[FLUX.2 \[klein\] 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) by Black Forest Labs, under Apache-2.0,
with the Qwen3-4B text encoder (Apache-2.0), from
[Comfy-Org/Flux-2-Klein-4B](https://huggingface.co/Comfy-Org/Flux-2-Klein-4B). It is the model characters use, so one
install covers both. It reads up to four references at once, draws in four steps, and needs about 13 GB of GPU memory.
Install it like any model (Settings › Models, or `install_model flux-2-klein-4b`). It hasn’t yet been tried on Apple’s
GPU.
