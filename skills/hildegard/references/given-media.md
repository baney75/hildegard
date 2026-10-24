# Working with given media

Loaded by Hildegard step 5f, with `image-editing.md`.

## Given media (from the original 5f)

The user's photos, footage, recordings, scans and drafts are the strongest raw material there is: they are true.

**Take inventory first.** Before planning, view every image and a contact sheet of the footage, run the audio check on every recording, and read every draft. Note what is strong, what is damaged and what is missing.

**Work non-destructively.** Never overwrite an original. Work on copies, keep an edit list, and keep an untouched master.

**Respect the source.** The user's photo stays recognizably theirs unless they ask for a transformation. In the delivery, state every change: crop, grade, retouch, composite, AI fill, traced or sampled parts.

**Techniques by medium:**
- **Photos:**
  - crop for composition;
  - straighten the verticals;
  - grade with curves and white balance;
  - dodge and burn to steer the eye;
  - or use the photo as the underpainting for the 5a methods.
- **Footage:**
  - pick the best takes;
  - stabilize (ffmpeg `vidstabdetect`/`vidstabtransform`);
  - grade consistently, shot to shot;
  - cut to the composition and editing rules in 5b and to the music.
- **Audio:**
  - denoise gently (`afftdn`);
  - EQ, compression, leveling, crossfades;
  - keep breaths that carry feeling.
- **Scans and old photos:**
  - remove dust and repair the fading;
  - never "restore" a face into someone else.
- **Drafts:**
  - edit in the user's voice and mark substantial changes;
  - their words beat yours.

**Privacy.** Strip GPS and other EXIF data before anything is published. Treat people in the user's media with care (see Boundaries).

