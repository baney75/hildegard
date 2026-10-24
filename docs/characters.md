# Characters: the same face in every shot

A character is someone you cast again and again: a name, a description, an outfit, and up to eight reference images.
Every shot you cast them in starts from a frame drawn from those references, so the face, hair and clothes hold from
shot to shot and from film to film.

## How it works

1. **Describe them.** `POST /api/characters` with a name, a description and an outfit. The words go through the same
   text check as every prompt.
2. **Pick a face.** Hildegard draws four portraits (`POST /api/characters/:id/stills`). Keep the one that looks right
   (`POST /api/stills/:id/keep`): the first portrait kept is their face.
3. **Draw the other angles.** Three-quarter, profile and full length, each drawn from the face you kept, so the sheet
   agrees with itself. Keep the good ones. You can also add your own images of an invented character, saying each
   shows no real person.
4. **Cast them.** In the composer, type `@` and a name, or use the Cast button; agents pass `characters` to
   `direct_shot`. Up to three characters a shot, and the four best references between them.

A cast shot renders as one ComfyUI graph: the stills model draws the first frame from the references and the shot's
own words, and the video model takes it from there, as it would from a start frame you uploaded. So a cast shot and a
start frame don't mix.

The stills model is [FLUX.2 \[klein\] 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) by Black Forest
Labs, under Apache-2.0, with the Qwen3-4B text encoder (Apache-2.0), from
[Comfy-Org/Flux-2-Klein-4B](https://huggingface.co/Comfy-Org/Flux-2-Klein-4B). It reads up to four reference images
at once and keeps who is in them, in four steps. It needs about 13 GB of GPU memory. Install it like any model
(Settings › Models, or `install_model flux-2-klein-4b`). It hasn't yet been tried on Apple's GPU.

## People who are real

A character can be based on a real person only with that person's consent, given by them, on their own device:

1. You make the character as **a real person**. It has no images, and nothing can be uploaded to it.
2. You make a **consent link** (`POST /api/characters/:id/consent`). It is a fresh 256-bit token that works once, for
   24 hours. Hildegard keeps only its SHA-256, and never sends it anywhere: you send it to them yourself.
3. They open it (`/#/likeness/<token>`), with no account and nothing else of Hildegard on the page. It says who is
   asking, for which character, what it makes, and that they can stop it. They take three photos with the camera
   there (facing, turned, in profile; the page can't take a file), type their name and agree. Or they say no, and
   the link stops working.
4. Hildegard keeps their three photos as the character's only references and signs a record of who agreed, to what,
   when, and the SHA-256 of each photo, with this install's own Ed25519 key (`<data>/likeness/signing-key.pem`).
   Anyone can check a record: `GET /api/characters/:id/consent` downloads it with the public key, and
   `checkConsent` in `apps/server/src/likeness.ts` verifies it.
5. They get a second link (`/#/likeness/revoke/<token>`) that takes it all back. Using it, or Revoke in the Studio,
   stops the character at once: shots waiting to render with them fail, their photos and the stills made from them
   are deleted, and the record stays, marked revoked.

Agents can make invented characters over MCP, but never real ones: consent comes only from the person, on the page.

Voice consent is separate and lives in the voice studio. A character can carry a voice from it; a cloned voice stops
being offered when its own consent is taken back.

## What it can't do

- **No face matching.** Hildegard doesn't check that the photos on the consent page show the person the character is
  named for, or that the face in a render matches them. Face recognition models good enough for it (InsightFace's
  among them) are licensed for non-commercial use only. The consent page proves that someone with the link took three
  live photos and agreed in their own name; the link is only as good as where the maker sends it.
- **Pictures already made stay.** Taking consent back stops new renders and deletes the photos and stills, but takes
  and exported films already made are the maker's files. The revoke page says so.
- **Consistency isn't perfect.** The first frame holds the face and clothes; over a long or fast shot the video model
  can drift. Shorter shots and a clear reference sheet help.

The same safety checks apply throughout: character words are checked when they're saved and again before every render,
every reference image passes the image check before the stills model reads it, and every still passes it before it's
saved. See [safety.md](safety.md).
