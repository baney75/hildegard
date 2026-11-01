# Claude Design prompt 2: Hildegard's screens

Paste everything below the line into Claude Design and attach the **Hildegard** design system (https://claude.ai/artifact/FmXD11DFRiM1PXneDpHXWf). It is written to run in four rounds. Send round 1 first, then send each later round as its own message once you're happy with the one before.

---

Use the attached **Hildegard** design system for everything: its tokens, fonts, icons, components (`hg-app` shell, prompt bar, chips, buttons, status, job row, Force now dialog, device card, cost strip, tray popover, layout switch) and its README rules. Don't invent new colours or type styles. If you need a component the system lacks, design it in the system's language and list it at the end so I can add it to the system.

The rules that matter most:
- **Colour meanings are fixed.** Viriditas green is for primary actions. Gold marks live, running work. Sapphire is for media grounds and queued work. Ember is **only** for Force now and money spent on outside APIs. Burgundy is for errors and deleting.
- **Dark is the default theme.** Show light versions only where I ask.
- **Cost and privacy go in the sentence on every creation screen.** For example: "Est. $0.00 · saves $0.48 · Stays on your devices". The estimate also sits on the Create button itself and updates live as settings change. A local job shows time and device ("~3 min on Studio PC"). An outside API shows dollars and names the provider.
- **Every layout works across window classes:** wide desktop at 1440 × 900, iPad portrait in the medium class, and phone in the compact class. The inspector docks on wide windows and becomes a sheet below 1280px.
- **Use the system's own words.** The device cluster is the Choir and its devices are voices. Copy is sentence case, plain and warm. No emoji, and no Latin or religious language in functional UI.

## What Hildegard must do better than Higgsfield, Suno and ElevenLabs

I studied about 35 of the best generative studios. These are the complaints people have about them that Hildegard should design out:
1. **Nothing is ever locked.** Every result can be downloaded in full quality: WAV, stems, 4K, GLB. Every result records its model and version, and old model versions stay available. Suno retired models people loved, and Udio disabled downloads altogether.
2. **No surprise spending.** Show the cost before the click. Failed outputs are free and say why they failed. Any agent or MCP request that would cost money asks first.
3. **No mystery waits.** Every job shows its queue position, which device it will run on, and an ETA.
4. **Everything can be repeated.** The seed is visible and can be locked, and every result has "Reuse settings".
5. **One studio, not five.** Video, image, voice, music and 3D share one shell, one queue, one library and one set of Elements (characters, places, props, voices).

## Round 1: Cinema Studio (video and image). Highest priority, design this first.

Cinema Studio is the first thing we build and demo. Make it feel like a camera department, not a form.

**Layout (wide):**
- Left: a **Director rail** with model, aspect, duration, resolution, seed (with a lock), and number of takes.
- Centre: a **board** of results, grouped by shot.
- Bottom: the **prompt bar**, with reference chips inline.
- Right: the inspector for the selected result.

**Screens and states to show:**
1. **The board with a project open.**
   - Shots are rows, and each shot's images and video takes stack under it, so a video sits beneath the frame it came from.
   - Each result card carries: Use as start frame, Use as end frame, Use as reference, Reuse settings, Upscale, Extend, Retake, Download.
   - The card shows its model, version, seed and device in mono.
2. **Camera rig picker.**
   - A sheet of visual cards: camera body (e.g. "Full-frame cinema", "IMAX", "Vintage 16mm"), then lens (e.g. "Clean modern", "Vintage anamorphic", "Macro", "Swirl bokeh"), then focal length (8 / 14 / 24 / 35 / 50 / 85mm), then aperture.
   - Each card shows a sample frame.
   - Rigs are saved as presets and are independent of the model, so changing the model never breaks a look.
   - Use generic names, never camera or lens brand names.
3. **Motion preset gallery.**
   - About 24 cards, each playing a short loop on hover: Dolly in, Dolly zoom, Crash zoom, Crane up, Orbit 360, FPV drone, Whip pan, Handheld, Static, Bullet time, Through object, Tilt reveal.
   - Group them into categories, and include search.
   - Let a person combine up to two motions, and show the combination.
4. **Director's panel.**
   - Genre, era, pacing, lighting and palette, set once per project and applied to every shot.
   - Show a "Project look" chip in the Director rail that opens it.
5. **Start and end frames.**
   - In video mode, two frame slots and a Loop toggle appear above the prompt.
   - Show the drag-a-result-into-a-slot interaction.
6. **Elements library.**
   - Characters, places and props as cards, each with up to 8 reference images, a name and an optional voice.
   - Typing `@` in the prompt opens an Elements picker.
   - Editing an Element offers "Update 6 shots that use Mara".
7. **Annotate to animate.**
   - On a frame, draw arrows, numbered steps, short labels and boxes to direct motion.
   - Beside the drawing, a model picker where each model has a one-line "good at" note.
8. **Draft, then finalize.**
   - A Draft toggle renders a cheap, fast preview.
   - **Finalize** re-renders the chosen draft at full quality with the same seed.
   - Show both the cost difference and the time difference.
9. **Retake and Extend on a clip.**
   - Retake: select a time range on the clip's scrubber, re-prompt only that range, and compare old against new.
   - Extend: continue from the last few seconds, with a "context" control for how many seconds it reads.
10. **Shot list and timeline.**
    - A strip under the board with shots as clips: reorder, trim handles, simple cross-dissolve, and **Export film**.
    - Export settings: resolution, format, and whether to include the audio track.
11. **Compare models.**
    - Run one prompt on 2 to 4 models and show them in a grid.
    - Each tile shows its time and cost, with Keep and Discard.
12. **Node view (power users).**
    - A toggle reveals the shot as a graph. Underneath, Hildegard runs ComfyUI workflows.
    - Ports are typed and coloured: text, image, video, audio.
    - Run node, Run downstream, and **Lock output**, which stops a node re-rendering.
    - Dragging from an output into empty space opens search for compatible nodes.
    - Keep this calm and on brand, not a raw ComfyUI clone.
13. **States.**
    - A job that is queued, showing position, device and ETA.
    - A job running, with a gold ring and live preview frames.
    - A failure that names the cause and offers a concrete retry: "Out of memory on Laptop. Retry on Studio PC (24 GB)?" The failure is marked free.
    - A content refusal from an outside API that names the provider and the reason.
    - The empty project state.

Also show Cinema Studio on iPad (medium) and phone (compact). On a phone, keep the prompt bar and Create button in thumb reach and put the Director rail in a bottom sheet.

## Round 2: Voice and Music

**Voice studio:**
1. **Text to speech.**
   - A voice rail on the left, the script in the centre, and a **Settings | History** inspector on the right.
   - Typing `[` autocompletes audio tags (Emotion / Delivery / Sound / Pause), shown as chips that are not spoken.
   - Each paragraph has a one-line acting direction field ("hushed, close to the mic").
   - **Enhance** may add tags but never changes your words, and it shows a diff.
2. **Controls the model supports.**
   - Sliders are labelled in words at both ends ("More expressive ↔ More stable").
   - A control the current model doesn't support is greyed out with a reason, never silently hidden.
3. **Long-form project, for audiobooks and narration.**
   - Chapters, each paragraph with its own voice orb, and a status gutter: not generated, generated, changed since generated, locked.
   - **Generate changed only**, a per-paragraph take history with A/B playback and Restore, and **Lock paragraph**.
   - A timeline beneath with narration, music and sound tracks. Clicking a word seeks to it.
   - A pronunciation dictionary, with a test play.
   - Export with chapter ZIP, loudness normalisation and audiobook metadata.
4. **Voice library.** Your voices, designed voices and clones in one library. A language-then-accent cascade, gender, age and use filters, one-tap preview, and a type badge (Designed / Quick clone / Pro clone / Built-in). **Use voice** opens text to speech with that voice selected.
5. **Design a voice.** Describe it in words and it returns 3 candidates to keep or discard.
6. **Clone a voice.**
   - A wizard that records in the browser with a teleprompter.
   - A live sample-length meter with one clear target.
   - Level, noise and echo checks on every clip.
   - Consent is a recorded statement that is stored with the voice and also used for training.
   - Show that clones are watermarked, and include an "Is this ours?" checker.
7. **Transcribe.**
   - A transcript editor with speaker orbs. Rename a speaker once and it applies everywhere.
   - Enter splits a segment, word timings can be re-aligned, and search jumps to timestamps.
   - Export to TXT, Markdown, SRT, VTT and DOCX.

**Music studio:**
1. **Create.**
   - A Simple or Custom toggle. Custom has Lyrics, Styles, **Exclude styles**, Title, Instrumental, Duration, BPM and Key.
   - Lyrics understand `[Verse: sparse piano]` section tags and show them as coloured chips.
   - Every option shows the memory it needs on this Choir.
2. **Results.** Takes as A/B rows (1 to 4, the person's choice), each with a waveform, play, keep and discard, plus the seed and Reuse settings.
3. **Song editor.**
   - The section timeline is the main object: drag to reorder and resize, with style, energy and key per section.
   - Edits are staged under a banner that reads "Song has changed", and there is one Generate button.
   - Select a region, then **Replace**. Alternates land in a takes tray with Generate more, and the seam can be dragged. Nothing changes until **Commit**.
   - **Extend** with a placement choice (Intro / Before / After / Outro) and how much of the song it listens to.
   - Takes are comped inside each section.
4. **Stems.** Split automatically or choose instruments; mute, solo and pan per stem; export WAV stems with tempo and key, or as a DAW project.
5. **Library dock.** A mini player that auditions a track against the open song. Arrow keys skip between tracks, and a track can be dragged into the timeline.

## Round 3: Choir, Models, Queue, Costs and Keys, Onboarding, Device settings, and 3D

1. **Choir.**
   - The orbit diagram plus a detail list.
   - A newly found device is pinned at the top: "New voice found: Den NAS. Approve?"
   - **Add a device** shows a QR code and a 6-character code. The new device is confirmed from a device you already trust, and no account is needed.
   - Each device shows what it can and can't do, and why ("Can't run video: 8 GB VRAM, needs 16 GB").
   - Show the links between devices with their speed.
2. **Models.**
   - A one-click library grouped by modality.
   - Each model and size option has a **fit pill**: Fits / May be slow / Won't fit, checked against each device and the whole Choir, plus a Recommended tag.
   - Show licence, size, memory needed, and install status per device.
   - Show placement in plain words: "Will run split across Studio PC + Studio Mac".
   - A Problems panel lists missing models with a single **Install all**.
   - Older versions stay installed and can be pinned.
3. **Queue.**
   - The full queue across the Choir.
   - Actions: Run next, Cancel, Cancel all except current, Cancel batch.
   - **Force now**, using its existing dialog.
   - Finished results land as candidates to Keep or Discard.
4. **Costs and Keys.**
   - A chart of spent on APIs versus saved by running locally.
   - A card for the biggest change since last month.
   - A per-request log, with filters that can be shared as links.
   - API keys with per-key limits that reset daily, weekly or monthly, a Disabled switch, and remaining balance.
   - Budgets are labelled clearly as **Alert only** or **Hard stop**. Alerts are on at 50 / 75 / 100%.
   - A hard stop pauses only outside-API jobs, says so in the queue, and resumes everything with one click when you raise the limit.
   - Agents (MCP) have their own budget and an "Ask before spending" switch.
5. **Onboarding.** Four steps:
   - Welcome, with one line of her story and the Uncial drop initial.
   - Choose this device's mode (Server or Opportunistic).
   - Detect hardware and suggest starter models with fit pills.
   - Then two cards: **Set up local** and **Add a provider**.
6. **Device settings.**
   - Learned idle hours as an editable weekly heatmap.
   - Resource limits.
   - Privacy: "Nothing leaves this device unless you choose an outside model."
7. **3D studio.**
   - Pick from image previews first, then build the mesh.
   - Run the same input on several models and switch between results for free.
   - A viewer with Wireframe / Clay / Maps / Environment / Auto-rotate.
   - Quality presets labelled by use, with face counts ("Hero · 50k", "Game · 18k", "Mobile · 8k").
   - A pipeline stepper (Shape, Parts, Clean mesh, UVs, Texture, Rig) where re-running an earlier step keeps later work where it can.
   - Repaint a region.
   - Export as GLB, FBX, OBJ, USD, STL and 3MF.

## Round 4: Phones, widgets and Live Activity

At iPhone 16 Pro and Pixel 9 sizes, dark first. Native feel on each platform (iOS HIG and Material 3), with the same brand.
1. **Connect.**
   - Scan the desktop's QR code, or choose Tailscale (recommended) or your own Cloudflare Tunnel.
   - A trust step showing the device name and its fingerprint, with "Only your devices can reach this".
   - Success, failure, and "Studio PC is asleep" states.
2. **Home.** The prompt bar with voice input at the front, recent creations, and a status pill showing the connected server, Choir load and connection type.
3. **Compact Create** for Video, Music and Voice. Options in bottom sheets, and Generate always in thumb reach.
4. **Queue and notifications.** Force now as a bottom sheet. Push notifications for "Your track is ready" and "Job failed on Laptop, retry on Studio PC?".
5. **Library.** Filter by modality. Full-screen players for audio and video, a 3D viewer, Share and Save to device.
6. **Choir at a glance,** with a Server / Opportunistic switch per device.
7. **Costs,** with budget alerts.
8. **Settings.** Several servers, viewing and revoking keys, and a Face ID or fingerprint lock.
9. **Widget (iOS and Android).** The current job's progress and "Saved this month".
10. **Live Activity / ongoing notification.**
    - Design the compact form first: "Rendering 3/7 · Studio PC".
    - Expanded: step, progress, and one Stop button.
    - Lock Screen: step, progress and elapsed time.
    - An end state reading "Still working. Open Hildegard" for renders that outlast the activity.

Leave out of the phone app: long-form voice projects, pro cloning, node view and the full song editor. Those stay on desktop, and the phone links to them with "Continue on Studio PC".

## Deliver

For each round: finished screens rather than wireframes, real copy (no lorem ipsum), and the main states for each screen. Then end with a short list of any new components or tokens you needed, so I can add them to the design system.
