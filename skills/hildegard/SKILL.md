---
name: hildegard
description: "Hildegard, the midwife's method for serious creative work in any form - a Socratic interview scaled to the work, real research, drafts and contact sheets, full craft, blind critique and checks. Covers painting, drawing, figures, anatomy and drapery, image editing, background removal and compositing, color grading and color systems, film, animation, storyboards, video editing, sound design, music, podcasts, songs for Suno, music videos, 3D sculpture and printing, and all writing (fiction, poetry, scripts, essays, nonfiction, books, and academic papers in APA, Chicago or MLA). Use for /hildegard, /art, /vus, /mus and /suno, and for any request to make, edit, draft, design, write or compose a creative or written work."
---

# Hildegard — the midwife's craft

Named for Saint Hildegard of Bingen (1098–1179): composer of the *Symphonia* and the *Ordo Virtutum*, visionary whose *Scivias* was illuminated under her direction, writer on theology, medicine and nature. She was one person working in every form, all of it serving one vision. That is this skill's pattern: many systems, one claim.

> "Well, my art of midwifery is in most respects like theirs; but differs, in that I attend men and not women; and look after their souls when they are in labour, and not after their bodies: and the triumph of my art is in thoroughly examining whether the thought which the mind of the young man brings forth is a false idol or a noble and true birth." (Plato, *Theaetetus* 150b–c, trans. Jowett)

The piece belongs to the user. Your job is to draw it out, test whether it is alive, make it with full craft, and think honestly about its own making the whole way through. The test is Socrates' test: is this the real thing the user carries, or a false idol, the thing they think they are supposed to want?

**Scope: every creative and written form, every file it lives in.** That includes:
- painting, drawing and print (PNG, PDF);
- vector work (SVG);
- text art (TXT);
- color work: palettes, color coding for information, correction and grading (`references/color.md`);
- image editing: retouching, background removal and mattes, compositing, blending, restoration (`references/image-editing.md`);
- animation and film (MP4);
- songs for Suno: lyrics, hooks, hymns, style prompts, and fixes to a Suno take (step 5h);
- music videos, lyric videos, visualizers, Spotify Canvas loops and storyboards for songs, including songs made with step 5h (step 5i);
- music, soundscape and sound design (MP3, WAV); mixing and mastering; podcasts and audio stories (`references/podcast.md`);
- video editing of any footage, from films to reels (`references/video-editing.md`);
- sculpture and 3D, for viewing or printing (GLB, STL, 3MF);
- writing of every kind: poems, stories, novels, parables, scripts, prayers, speeches, essays, nonfiction, books, and academic papers in APA, Chicago or MLA (5e);
- interactive and generative pieces (HTML);
- work made from the user's own photos, footage, recordings, scans or drafts;
- combinations of any of these, such as a song with its cover, a poem with its reading, or a sculpture with its turntable film.

**The bar:** the piece rewards two distances. Pretty, on-topic and empty fails. So does busy at both distances.

| Medium | Far (one clear impression) | Near (keeps giving) |
|---|---|---|
| Image, print, vector | one striking image from across the room | marks, layers, hidden meaning, true detail at arm's length |
| Film | the whole arc | any frame, paused at random, holds up as a painting |
| Music, sound | the whole form and its one feeling | any five seconds: texture, motif, space |
| 3D | the silhouette from every angle | surface, joins and inscriptions when held or zoomed |
| Writing | the whole, read in one sitting | any line or sentence, read alone |
| Text art | the shape at a glance | every character chosen |
| Interactive | the first ten seconds | what rewards exploring |

**Honest limits.** You can see renders and read text, but you can't hear audio or hold an object. Sound and 3D are checked by measurement, spectrograms and rendered views, and the delivery says so. The user's ears and hands are the final check.

## The layers of Hildegard

Hildegard is built in layers. Use the top layer always, and load the others as the work needs them.

1. **The method** (this file): interview, seed, research, format, build, check, reflect, deliver. It is the same for a poster, a podcast and a dissertation.
2. **The craft library** (`references/`, next to this file). Read the file before building with that craft:

| The work involves | Read |
|---|---|
| the numbered pitfalls from real pieces (always, before building) | `pitfalls.md` |
| any picture: study, composition, value, color, marks, the image check | `images.md` |
| any person, hand, face or animal body | `figure-anatomy.md` |
| making a figure, hand, face, hair, cloth or text-as-form look real in code | `code-rendering.md` |
| clothing, cloth, drapery | `clothing-drapery.md` |
| a specific object, perspective, materials | `objects-materials.md` |
| drafts, thumbnails, comps, contact sheets, storyboards, animatics | `drafting-storyboards.md` |
| editing existing images, cutouts, compositing, restoration | `image-editing.md` (+ `given-media.md`) |
| palettes, color coding, correction, grading | `color.md` |
| film or animation production | `film-animation.md` |
| cutting any footage | `video-editing.md` |
| sound effects, soundscapes, music made here, mixing, mastering, dialogue | `sound-design.md` |
| podcasts, audio documentaries, audiobooks | `podcast.md` |
| songs, lyrics, hymns for Suno | `song-suno.md` (5h) |
| music videos, lyric videos, visualizers, Canvas | `music-video.md` (5i) |
| sculpture, 3D models, printing, renders | `sculpture-3d.md` |
| fiction, poetry, scripts, prayer, speech | `writing-craft.md` |
| essays, nonfiction, research, APA, Chicago or MLA | `nonfiction-academic.md` |
| a whole book | `books.md` |
| which masters, books, journals and tools to learn from | `masters-and-sources.md` |

3. **Tools** (`scripts/`):
   - `contact_sheet.py`: labeled grids of drafts, panels or film frames;
   - `animatic.py`: storyboard panels timed to audio;
   - `edit.py`: an edit decision list rendered to a finished, loudness-normalized cut;
   - `cutout.py`: background removal with edge checks and compositing;
   - `figure_rig.py`: a proportioned, posable mannequin in head units;
   - `canon_check.py`: measures a face or figure against Leonardo's, Loomis's and Bridgman's canons and prints pass/fail.

   The check scripts are in step 6 and in the domain files.
4. **Composite works** (5j): several media serving one claim (a song with its cover, video, lyric sheet and podcast episode; a book with its illustrations; a paper with its figures). One seed and one bible, then each medium's layer, in a planned order.

## With Hildegard connected: make it on the user's own machines

When the Hildegard tools are here (`hildegard_status` answers), the user's own GPUs do the rendering and checking, privately and at no cost per piece. Use them instead of a cloud generator, and say so in the delivery.

| The work | Hildegard's tools | Its skill (read_skill) |
|---|---|---|
| Film, shots, sequences | `direct_shot`, `make_sequence`, `export_film`, then `review_take` on every take | `hildegard-film`, `hildegard-video-edit` |
| Characters who stay the same across shots | `create_character`, `make_character_stills`, `keep_still`, then cast them in `direct_shot` | `hildegard-film` |
| Stills, key art, covers | `make_character_stills`, or a held shot; `review_take` | `hildegard-art`, `hildegard-photo-edit` |
| Voice, narration, dubbing | `speak`, `design_voice`, `dub`, `transcribe` (never a clone without the person's consent session) | `hildegard-sound` |
| Sculpture, 3D models, prints | `loop_start` kind `model`, then `loop_submit`, `loop_critique`, `loop_finish` | `hildegard-3d` |
| Iterating any image, video or sound until it is right | `loop_start` with that kind, then the same loop | `hildegard-loop` |
| Any prompt, before it renders | `review_prompt` | `hildegard-craft` |

**The loop is step 6 made mechanical.** Every round comes back measured and drawn (a turntable with silhouettes for a model, a contact sheet for media); answer every question by pointing at a view or a check, change one thing, and send the next round. Hildegard won't take round two before the critique of round one, and it keeps every round so the user can see how the work got there.

When the tools aren't here and the user wants their own compute, read `hildegard-setup`: it installs Hildegard and links this app to it.

## Lenses and styles: choose on purpose

No single philosophy of art is assumed, and no house style.

**Lenses.** Pick a primary lens, usually the user's own convictions. Then test the seed against one contrasting lens to catch blind spots. Use lenses to make decisions; never lecture the user with them.

| Lens | The question it asks |
|---|---|
| Mimesis (Plato, Aristotle) | Is it true to the thing observed? |
| Catharsis (Aristotle, *Poetics*) | Does it carry the viewer or listener through tension to release? |
| Transcendentals (Aquinas: *integritas, consonantia, claritas*) | Is it whole (nothing missing), proportioned (nothing extra), radiant (clear)? |
| Icon theology (John of Damascus; Nicaea II, 787) | Is it a window rather than a mirror? Does it point beyond itself? |
| Expression (Tolstoy, *What Is Art?*; Collingwood) | Does it sincerely pass on a felt experience? |
| Formalism (Kant's free play; Clive Bell's "significant form") | Do the forms alone hold attention? |
| The sublime (Burke, Kant) | Does it hold awe at scale, even fear? |
| Medium-specific modernism (Pound's "Make it new"; Greenberg) | Does it do what only this medium can? |
| Wabi-sabi and *ma* | Does it honor imperfection, transience and empty space? |
| Craft and tradition (Ruskin, Morris; Eliot's "Tradition and the Individual Talent") | Is it honestly made, and in conversation with what came before? |
| Conceptual (Duchamp, Danto) | Does the idea carry it? (Use sparingly: the bar still demands craft.) |

**Styles.** Name the style with its lineage. Write down its three to five visible rules and apply them consistently. Examples:
- **Tenebrism (Caravaggio):** one hard light, deep blacks.
- **Impressionism:** broken color, light over line.
- **Expressionism:** distortion for feeling.
- **Byzantine:** gold ground, frontality, inverse perspective.
- **Ukiyo-e:** flat color, outline, asymmetry.
- **Baroque:** diagonals and drama.
- **Swiss/Bauhaus:** the grid, sans-serif type.
- **Film noir:** low-key light, hard shadows.
- **Minimalism:** reduction to essentials.
- **In sound:** chant, tintinnabuli, ambient, hymnody.
- **In writing:** plain style, the psalm's parallelism, Hopkins's sprung rhythm.

When the user hasn't chosen a style, offer two or three that pull in different directions. A model's own defaults are muted, centered, softly painterly images, polite symmetrical forms and tidy endings. Use one only when it is chosen, never by habit.

## Why pieces come out bad (read first)

Before building anything, read `references/pitfalls.md`: the numbered pitfalls from real prior work (*Who Do You Say That I Am?*, *Making an Icon of the Word*), each with the check that would have caught it. The rest of this file refers to them by number ("pitfall 18").

## The method

### 1. The interview (midwifery)

**Scale the interview to the work.** It always matters; its depth changes:
- **Craft service** (remove a background, color-match two shots, cut a podcast to length, format references in APA, fix a Suno take): no Socratic interview. Ask only what changes the result: the destination, the style guide and its edition, the look to match, the deadline. Then work.
- **Made to a brief** (an essay for a prompt, a thumbnail, a lyric video, a chapter edit, a podcast episode): a short intake of two or three questions. What it's for, who it's for, what must be true, what the user already has. Then the false-idol test once, on the angle.
- **A serious work of the user's own** (a painting, a song, a film, a novel, a sermon, a memoir): the full midwifery below.

When unsure, start light and deepen if the answers reveal the user carries something more.

**Rules:**
- Ask one question per message: open-ended, in plain text. No multiple choice, except to choose between concrete media or style options.
- Follow the heat: each question comes from what the user just said, not from a script.
- Usually four to seven questions. Stop once the seed is clear.
- Never lecture, and never propose the finished piece before the user has given you its parts.

If the user arrived with a full brief, skip what it already answers. If they say "just make it" or don't answer, take the most reasonable reading, state it in one line at the top of your next message, and go on.

Ask these questions in roughly this order, rephrased to fit what the user has said:

1. **The pressure.** "What's the thing that won't leave you alone about this?" With no topic yet: "What's been pressing on you lately that you'd want to see, hear or say?"
2. **The first sense.** "When you imagine it, what comes first: something you see, something you hear, a line of words, or something you'd hold?" Push for one concrete, physical thing.
3. **The claim.** "When someone has taken it all in, what should they walk away knowing or feeling?" This is the thesis the piece argues. (In Hoc Signo Vinces' was "we conquer through local AI.")
4. **The tension.** "What is it against, or what's the cost?" Gain and loss, old and new, glory and suffering, emptiness and rest.
5. **The true details.** "Is there a real object, text, tune, place or person in it that has to be exactly right?" Research these to the screw. Use the user's messages, lyrics, captions and quotations word for word, with their spelling.
6. **Given media.** "Do you have photos, footage, recordings, sketches or drafts I should work from?" If yes, follow 5f.
7. **Where it lives.** A wall, a print size, a social feed, a phone, headphones, a church, a printer (which one), a book, read aloud, a gift. This sets the format, the smallest surviving detail, the loudness, the physical size and the length. Ask it early, before you propose any medium that depends on it. A live-camera piece that would have put each viewer's own face in the pupil died as soon as the user said the piece would live only as a post in a social feed, where it could only be a still image or a video.
8. **The realism level and the method for hard parts.** If figures, hands or faces appear, settle what the brief implies ("look real," "as though truly present") and how each will be made, before the first render (pitfall 28).
9. **The hand and the style.** Ask only if still unclear. Offer two or three media or styles that fit what you've heard, each with one clause on what it would *say*.

**False-idol test (Socrates' test).** Before moving on, ask one probing question about the most generic thing the user said. "You said 'hope.' What does hope look like, or sound like, for you, here, physically?" Or: "Is that the thing, or what you think a piece about this should show?" A generic answer is a false idol, so press once more. A specific, felt answer is the living child.

### 2. The seed

Reflect it back in one short message and get a yes before researching deeply:

- **Title**: the user's, if they gave one.
- **One sentence**: the whole piece.
- **The hero moment**: the single thing that carries it. That is the far image; for a film, the final image; for music, the moment the form builds toward; for 3D, the silhouette; for writing, the line or the turn everything leads to.
- **The claim and the tension.**
- **The up-close layer**, what the second pass finds. For example:
  - a hidden inscription;
  - a pattern of meaningful units;
  - a scripture in the texture;
  - a motif hidden in every shot;
  - a hymn quoted in the bass;
  - an acrostic;
  - an inscription under a base.
- **Lens and style**, each with one clause on why.
- **Medium and format**, with one clause on why. When a medium can carry the claim itself, use it: "man branded the machine; now the machine brands man" became brushstrokes for the human world dissolving into code for the machine's. Users often answer the medium question with the thesis; listen for that.
- **Standing requirements**: every rule the user has set, such as "a cross or Bible in every shot", "no speech", "fits my Bambu A1" or "KJV only". Add every new rule from feedback to this list.

Adjust whatever they correct. Their words beat yours.

### 3. Research (serious, and it must change the piece)

Use web search, the user's notes and primary sources. Research three things:

- **The subject.** Real objects, places, texts, tunes, people, hardware, anatomy, interfaces, dimensions. Get the user's must-be-exact details exactly right. Save references and measurements. For figures, write down the proportions you'll work from. Quote scripture exactly, from a named translation (the user's choice; the KJV is public domain), checked against the text. This applies in conversation as well: check original-language text (Hebrew, Greek, Syriac, Latin) against a primary source or an interlinear before giving it to the user, not only before it goes into the piece (pitfall 19). Faces in sacred subjects follow the research too, not habit. For example, a first-century Judean gets brown eyes and olive skin.
- **The tradition.** How this subject has been shown, sounded or written before, and the conventions that carry meaning:
  - iconographic canon: inscriptions such as IC XC NIKA, the meanings of colors, what is never shown;
  - liturgical colors and seasons;
  - chant modes, hymn tunes and their dates;
  - poetic forms: sonnet, psalm, hymn meter;
  - for philosophy, the actual argument from the source, not a summary.
- **The technique.** The medium's real methods and lineage:
  - Seurat's divisionism, built on Chevreul's law of simultaneous contrast;
  - Hertzmann's painterly strokes;
  - Secord's weighted Voronoi stippling;
  - sumi-e's economy of stroke;
  - the gilder's red bole under gold;
  - ASCII density ramps;
  - Albers's *Interaction of Color* and Itten's seven contrasts;
  - Murch's rule of six for editing, and the Kuleshov effect;
  - the church modes, motivic development, B-A-C-H cryptograms, Pärt's tintinnabuli;
  - contrapposto, and the limits of FDM printing;
  - Pound's "go in fear of abstractions", Hopkins's sprung rhythm, common meter (8.6.8.6).

Write down three to six **load-bearing findings**, each tied to the decision it changes. For example: "Eusebius gives the motto in Greek, so the top inscription is ΕΝ ΤΟΥΤΩ ΝΙΚΑ." A finding that changes nothing is decoration, so drop it. Keep source links for the delivery.

### 4. Choose the format by meaning and destination

| The piece is… | Make | Tools |
|---|---|---|
| Painted, brushstroke, watercolor, pointillist, stippled | **PNG** (or lossless WebP), large | Python: numpy, Pillow, scipy, scikit-image, pycairo or skia-python |
| Line, geometric, calligraphic, emblem, anything that must scale | **SVG**, plus a PNG preview | generated SVG; previews with cairosvg or Chromium |
| Text characters: ASCII, block, braille | **.txt** (column count and font stated), plus a PNG render | Python; monospace render in Pillow |
| Print, poster, book page | **PDF** at final size, or PNG at 300 dpi (18×24 in = 5400×7200 px) | cairo, Chromium print, img2pdf |
| Interactive, generative | self-contained **HTML** artifact, plus a PNG still | canvas, WebGL, three.js; Playwright |
| Film, animation, loop with sound | **HTML player** (artifact) **plus MP4** (H.264 + AAC); silent loops can be GIF or WebM | canvas + Web Audio; Playwright, OfflineAudioContext, ffmpeg (5b) |
| Song for Suno (lyrics, hook, hymn, style prompt, fixing a take) | two paste-ready boxes, LYRICS and STYLE, with the title, the card line and the settings line (the fixed output contract in 5h) | research, a concept tournament, blind A&R critic, `check_song.py` (5h) |
| Music video, lyric video, visualizer, Canvas | treatment + storyboard as an HTML artifact first, then the MP4 (plus a 9:16 hook cutdown) | song map JSON, Remotion or Python + ffmpeg, Blender, AI video, or handmade frames with an X-sheet (5i) |
| Music, song, soundscape, sound design | **MP3** (320 kbps, tagged, cover embedded) **plus a WAV master** (24-bit) | MIDI (mido, pretty_midi) + SoundFont via fluidsynth; numpy synthesis; ffmpeg (5c) |
| 3D to view (web, AR, games) | **GLB** (glTF 2.0, PBR), plus renders and a viewer | Blender headless or `bpy`; trimesh; SDF + marching cubes; `<model-viewer>` (5d) |
| 3D to print, relief, lithophane | **STL** or **3MF** in millimeters, plus renders | trimesh + manifold3d, Blender, numpy-stl (5d) |
| Image edit, cutout, composite, restoration | the edited file (PNG with alpha for cutouts, original format otherwise) + the edit list | Pillow, OpenCV, rembg via `scripts/cutout.py` (`image-editing.md`) |
| Podcast or audio story | MP3 with tags, chapters, transcript, artwork, show notes | ffmpeg, Whisper, `scripts/edit.py` (`podcast.md`) |
| Academic paper | .docx (or PDF) in the required style, generated citations | pandoc + citeproc + official CSL (`nonfiction-academic.md`) |
| Book | manuscript, print PDF and/or EPUB, cover | pandoc, Typst or LaTeX, EPUBCheck (`books.md`) |
| Poem, story, essay, lyrics, prayer, script | a short poem can live in the reply; a piece to keep goes in a document (a Docs artifact in Claude, a canvas in ChatGPT), or a typeset HTML or PDF page when the typography is part of the art | 5e |
| A reading, spoken word | **MP3** of the reading, with the text | the user's recording, or a consented or designed voice (5c) |
| An edit of the user's media | the source's format, at source quality or better | Pillow, ffmpeg, the medium's tools (5f) |

**Destination specifics** (check current limits with a quick search):
- **Images:**
  - wall or print: 4000 px or more on the long side;
  - phone wallpaper: about 1290×2796 px;
  - album cover: 3000×3000 px.
- **Color:** sRGB for screens; soft-proof print in CMYK.
- **Film:** 1280×720 or 1920×1080, 30 fps.
- **Sound:**
  - streaming music: about −14 LUFS, true peak ≤ −1 dBTP;
  - video and spoken word: about −16 LUFS;
  - quiet, liturgical pieces lower, with the target stated.
- **3D view:** GLB under about 10–20 MB, Y-up, meters.
- **3D print:** millimeters, Z-up, a flat base, fits the printer bed; FDM walls ≥ 1.2 mm and details ≥ 0.4 mm.
- **Writing:** the length fits the moment (a card, a reading of under three minutes, a book page).

Combinations are fine. Choose the medium for what it means, never for novelty.

### 5. Build

Whatever the medium: build in stages, check each stage, and keep the generating script or the draft history, because that is how the piece gets revised. Once the first full composition exists (an underpainting, a rough cut or a first draft), send the user its thumbnail and ask for one reaction before polishing (pitfall 27).

#### 5a. Images: study, structure, then marks (also for film frames, covers and 3D renders)

Read `references/images.md` (the study, structure and marks ladder, composition, value and color, the finish, and the image check with `inspect_art.py`). Figures: `references/figure-anatomy.md`; drapery: `references/clothing-drapery.md`; objects: `references/objects-materials.md`.

#### 5b. Film and animation

Read `references/film-animation.md` (shot planning, composition in the frame, continuity, the deterministic HTML-canvas film architecture, sound for film, encoding), then `references/video-editing.md` for the cut, `references/sound-design.md` for the sound and `references/color.md` for the grade. Storyboards and animatics: `references/drafting-storyboards.md`.

#### 5c. Music, sound design and audio

Read `references/sound-design.md` (sound for picture, synthesis, composition, mixing, mastering, loudness targets, dialogue cleanup) and the original 5c notes at its end. Podcasts and audio storytelling: `references/podcast.md`. Songs written for Suno: 5h.

#### 5d. Sculpture and 3D

Read `references/sculpture-3d.md` (the blockout-to-detail pipeline, SDF and Blender building, photogrammetry, printing, turntables) and `references/figure-anatomy.md` for figures.

#### 5e. Writing, every kind

Read `references/writing-craft.md` for fiction, poetry, scripts, prayer and speeches; `references/nonfiction-academic.md` for essays, nonfiction, research and academic papers with APA, Chicago or MLA citations; and `references/books.md` for anything book-length. The machine-voice purge and the line-level rules apply to every kind of writing. A short piece can live in the reply; a piece to keep goes in a document (a Docs artifact or a canvas); a formatted paper or book goes to the file format it needs (.docx through pandoc for coursework, PDF or EPUB for books).

#### 5f. Working with given media and editing images

Read `references/given-media.md` (inventory, non-destructive work, respecting the source) and `references/image-editing.md` (retouching, background removal and mattes, compositing, blending, upscaling, restoration, thumbnails). Color correction and grading: `references/color.md`. Footage: `references/video-editing.md`.

#### 5g. Interactive and generative

- Keep it seeded and deterministic, so good outputs can be reproduced.
- Keep controls minimal: the piece, not a dashboard.
- For a series, render many seeds and curate a few, saying how many were made.
- Always capture a still of the strongest state.

#### 5h. Songs for Suno (merged from mus)

For any song, lyric, hook, hymn or Suno prompt, or a fix to a Suno take, **read `references/song-suno.md` (next to this file) before writing,** and follow it exactly. Its output contract overrides step 8's delivery format: the title in bold, the card line (`Speaker → listener · moment · turn`), exactly two fenced boxes (LYRICS, then STYLE), one settings line, and at most one Notes line. These are the rules that change the plan:

- **Interview lightly.** Infer the subject, use, language and length. Ask one short question only when the answer changes the song, and for a personal song ask once for two or three details only the user knows. The false-idol test still applies, aimed at the speaker and the moment: who is singing to whom, and why now?
- **Research is ballast, not cargo.** Sing at most three or four researched facts, each as an image, an action or speech. Check scripture and doctrine against the text itself (pitfall 19).
- **Run tournaments.** Write four concept cards (at least two with a non-obvious speaker), then a lane tournament that fixes the BPM, then three choruses. Then write the verses with the narrator, any-song and filler tests.
- **The sound pass:** a syllable budget set by the tempo, stresses on the beats, matched paired lines, open vowels on held notes.
- **The blind A&R critic is mandatory.** Ship only at a score of 8 or more and a "yes"; never run more than two rounds. Run `check_song.py` before delivery.
- The song's card line feeds 5i when the user wants a video.

When the user wants the music made rather than written for Suno, that is 5c.

#### 5i. Music videos (merged from vus)

For any music video, lyric video, visualizer, Spotify Canvas or storyboard, **read `references/music-video.md` (next to this file) before planning,** and follow it. It holds the music-video pitfalls, the song-map script, the four-concept method with its blind commissioner, the beat math and X-sheet script, per-medium production notes, edit specs and the verification steps. These are the rules that change the plan:

- **The song is the brief.** Build a measured song map (BPM, beats, downbeats, sections, energy curve, key moments, word timings) before any visual idea. Every cut and payoff is timed from it with absolute frame math (`round(time × fps)`), never from accumulated estimates.
- **Interview lightly.** When the brief already holds the song and its lyrics (from mus: the LYRICS and STYLE boxes and the card line), skip most of step 1. Ask once, in one bundle, only what the brief leaves open: the route (who makes the frames), the platform and aspect ratio, the deadline and the budget. Keep the false-idol test for the concept, not for the song.
- **Four concepts, then a blind commissioner.** At least two must not illustrate the lyric, and one must avoid the default look for the subject. Make the hero frame as a real still and judge it with this skill's image checks before storyboarding (pitfall 18 applies: the thumbnail is the feed).
- **Deliver the treatment first:** one polished HTML page (concept, hero frame, visual bible, song map, shot list, budget, production plan). Then the production assets, then the render.
- **Verify mechanically.** Use `ffprobe`, a contact sheet, and frame checks at five song-map times. Report by-ear sync as unchecked until the user has watched it with sound.

#### 5j. Composite works: bringing the systems together

When a work spans media (a song plus its cover, lyric video and launch post; a podcast plus its artwork, clips and transcript; a book plus its cover, illustrations and audiobook sample; a paper plus its figures and slides):
1. **One seed, one bible.** Write a single seed and a single visual and verbal bible (palette and color code, type, motifs, voice, standing requirements) before making any part. Every medium answers to them.
2. **Build in dependency order:**
   - words and music before picture (lyrics → song → song map → video);
   - the hero image before its variants (cover → thumbnail → banner → video's key frame);
   - the argument before its figures.
3. **One motif crosses every medium,** transformed in each: the image in the cover returns in the video's last frame; the refrain becomes the title of the episode.
4. **Each part passes its own domain's checks,** then the set is checked together: put every visual part on one contact sheet, read all the text side by side, and confirm the same claim, names and spellings everywhere.
5. **Deliver as a set:** one artifact or folder with every part, plus a one-line note on how they go together and in what order to release them.

**Code hygiene (every medium):**
- Patch with scripts that assert each anchor exists.
- Syntax-check after every edit (`node --check` on the extracted script, or `python -m py_compile`).
- Copy whole functions.
- After a rejected or interrupted edit, check what was actually applied.

### 6. Check, critique, revise (mandatory)

Run the check for the medium, view everything it writes, and fix the problems before delivery.

**Images, prints, vector, text art:** run `inspect_art.py` and its pass list from `references/images.md` (The image check) on the final raster, or on a raster render of an SVG, TXT or HTML piece. With Hildegard connected, an image loop (`hildegard-loop`) adds its measured checks.

**Film:** run the checks in `references/film-animation.md` (Checks) and `references/video-editing.md` (Deliverables and quality control).

**Music and sound:** run `inspect_audio.py` from `references/sound-design.md` (Checks) on the final file and the master. Report what was measured, never how it "sounds."

**3D:** with Hildegard connected, run the model loop (`hildegard-3d`): every round is measured and drawn from eight sides. Otherwise run `inspect_3d.py` from `references/sculpture-3d.md` (Checks), then real renders from four to eight angles.

**Writing:** run the checks in `references/writing-craft.md`; for academic work, also the checklist in `references/nonfiction-academic.md` (every source verified and every citation generated, never invented).

**Interactive.** Take screenshots of the first, middle and explored states, and check the console for errors.

**Blind critic.** When the Agent tool exists, spawn one fresh agent and give it only the work as experienced, with no title, seed or research:
- the image and its thumbnail;
- the film's contact sheet;
- the 3D renders;
- the text alone;
- for music, the cue sheet and spectrogram, asking only about form.

Use this prompt:

> You are a blunt museum curator (or editor) meeting this piece once. (1) What is it, and what is it about, in one sentence? (2) Where does your attention go first, and is that the right place? (3) What feeling does it leave? (4) On a close second pass, is there more to find, or is it empty or noisy? (5) The weakest part, and why. (6) Is anything cluttered, crude, illogical (perspective, light, contact, proportion, continuity), cliched or generic? (7) The one change that would most improve it. No praise padding.

For images, give the critic three views: a downscaled whole view, the same image at feed size (about 420 px wide), and two 100% crops (one of the focal point, one of the up-close layer). After a second round, also ask "who is the figure, and how old?" whenever a small figure carries the claim.

Then:
- If its one-sentence reading misses the seed's claim, the structure failed. Fix the composition, form, silhouette or argument, not the details. Look first for a symbol or object being read as something else (pitfall 14), and for the claim's key element being too weak to read (pitfall 15).
- Separate flaws from deliberate choices. The critic called the identical robes "one cutout repeated," but that sameness was the point (assimilation). Keep what serves the claim, and say why in the delivery.
- Fix the weakest part it names, unless you can say exactly why it's wrong.
- Run one critic round, or two if the first missed the seed. Never more.

Without an Agent tool, attack the piece yourself in writing: name the three weakest parts before fixing them.

**Diagnose, then repair** (after Impeccable's split between critique and audit):
- **Critique** (meaning): does it carry the claim? Is the focal element right? Does it reward both distances? Is it alive or generic?
- **Audit** (technical): every measurable check above (sizes, loudness, glyphs, edges, citations, specs).
- **The slop test:** would a stranger immediately guess this was made by AI, through generic composition, default palette, smooth sameness, stock phrasing, or perfect symmetry? If yes, find the cause and fix it before anything else.
- **Repair with named moves,** one at a time, re-checking after each. When the user asks for a change, make that change alone and show it before adding anything else (pitfall 32). After any part improves, re-audit its neighbors (pitfall 33):
  - **distill:** remove until only what serves the claim remains;
  - **bolder:** raise contrast at the focal point and commit harder to the idea;
  - **quieter:** lower everything that competes with the focal point;
  - **warmer** or **colder:** shift temperature toward the feeling;
  - **tighten:** cut length, words or frames;
  - **open:** add space, silence or rest;
  - **truer:** replace an invented detail with a researched one;
  - **polish:** the last pass on edges, transitions and typos.

  The user can ask for these by name.

**Re-check after every change.** Never deliver a version you haven't checked.

### 7. Reflect: think about the making (metacognition)

Reflection is part of the craft, not an afterword. Most of the failures in the pitfalls list were knowable earlier by someone watching their own process.

**Before building,** write a short private brief:
- What am I assuming about the user's intent?
- Which choices here are my defaults, and is each one chosen or habit?
- What is the riskiest unknown? (Usually figures, the light logic, or whether the claim reads.)
- What will "done" look like, judged by the bar and the lens?

**While building,** keep `decisions.md` beside the work: each major choice with its reason and the lens or finding behind it. When the same problem survives two fixes, stop patching symptoms and re-diagnose the cause. For example, the hands needed rebuilding, not reshading; the silhouette needed the real geometry mask, not a better hand-drawn guess.

**Calibrate.** Separate what you checked from what you believe. Never write "looks great". Write what the check showed.

**After each delivery and each round of feedback,** run a short retrospective:
- What did the user correct?
- Was it knowable earlier?
- Which question or check would have caught it?
- What will you do differently in the next round?

**The written retrospective** (offer one after any serious piece; the model is *Making an Icon of the Word*). It is a short, illustrated document written for the next agent:
1. **The brief as the user built it:** the interview answers that set the piece.
2. **What the research fixed:** each finding next to the decision it drove.
3. **The progression:** stages, with images of each draft.
4. **Every correction** in a three-column table: what the person said; the root cause in the agent; the check that would have caught it first. Most corrections are the person doing the agent's job, and the information to avoid each one usually existed before the first render.
5. **Techniques that worked,** written to be reused.
6. **Rules to carry into the next piece.**
7. **What is still weak,** and the next steps.

Publish it as a document or a PDF, and fold its new rules into this skill (below).

When a lesson is new and general, and the user asks or agrees, add it to `references/pitfalls.md`. Each new pitfall names the piece it came from, says what happened, and gives the check that would have caught it. This skill ships with Hildegard (`skills/hildegard` in baney75/hildegard): propose the change there as a pull request, or with the app's own skill tools (propose_skills in Claude, the skill editor in ChatGPT) when the user keeps their own copy. If neither can reach its source, send the user the complete updated SKILL.md. That is how this skill learns.

**When the subject is reflection itself** (a self-portrait, a journal piece, an examen, a confession, a memorial):
- Slow the interview down.
- Let the user's own words and memories lead.
- Mirror rather than interpret.
- Never psychoanalyze, and never supply a meaning they haven't given.

The Ignatian examen (gratitude, review, sorrow, resolve) and the psalm of lament (complaint, trust, praise) are forms that can hold such pieces.

### 8. Deliver

Send the files the way this app sends files (SendUserFile in Claude, a download link in ChatGPT, a path in a coding agent, or Hildegard's own link from loop_finish or export_film), and publish anything that plays in a browser as an artifact or canvas when the app has one. What each medium delivers:

| Medium | Deliver |
|---|---|
| Image | PNG (plus the print PDF) |
| Vector | SVG + PNG |
| Text art | TXT + PNG |
| Film | HTML player artifact + MP4 |
| Sound | tagged MP3 + WAV master + cover PNG |
| 3D | GLB and/or STL/3MF + renders + viewer artifact or turntable MP4 |
| Writing | in the reply, a Docs artifact, or a typeset page, per step 4 |
| Edited user media | the edited files + the edit list, originals untouched |
| Interactive | artifact + PNG still |

If the conversation is linked to the user's computer and they named a folder, also write the files there. Then write a short reply:

- **Title**, in bold.
- **A statement** of three to five sentences: what it is, what it argues, the lens and style, and the up-close layer.
- **What's true in it**: the load-bearing research, one line each.
- **What changed in the given media**, if any.
- **The weakest part**, in one honest line, and the next revision you'd make.
- **Sources**, as links.

On a revision round, list each flagged item and its fix, plus the related fixes made elsewhere (pitfall 13).

State plainly which of these is true: rendered, viewed, measured, read, critiqued, delivered. For sound, say measured, not heard. Don't recap the process.

## Boundaries

- **Originality.** Don't reproduce a specific artwork, cover, logo, known character, copyrighted melody, lyric or text passage, or a branded product's design. Don't imitate a living artist, author or singer by name or voice.
- **The public domain is fair to learn from and to quote:** Byzantine icons, Seurat, Hokusai, chant, and hymns, poems and texts first published before 1929 (check the date; don't assume). A modern studio's redesign, arrangement or translation of a public-domain work is not itself public domain.
- **Real people.** No likeness or voice without their consent, and nothing demeaning.
- **The user's own material is theirs to transform.** Say what was traced, sampled, edited or used.
- **Licensed or third-party references** (stock photos, other artists' work) inform pose and proportion only, never pixels, unless the user holds the rights. Say so in the delivery (pitfall 35).
- **Disclose** AI-generated bases, music, voices and text fills in the statement.
- **No weapons.** No functional weapons or weapon parts in any medium, including 3D-printable firearm components.
- **Sacred subjects** get the same care the user gives them: conventions researched, texts and tunes verified, nothing flippant.
## Notes for your model, and making the skills better

Some skills carry notes for one model family in `models/` (`models/claude.md`, `models/qwen.md`): read the one for the model you are, or pass `model` to `read_skill`. When a skill led you wrong, or you learned something it should say (above all something about how your model works), suggest it with `report_draft` kind `skill`: name the skill, your model, what happened and the words you would change. Show your person the exact text and file it only on their yes. A suggestion is a proposal: a maintainer reads it, and nothing changes until a signed release. Never put commands to fetch or run things, links or anything about keys in one; those are refused.
