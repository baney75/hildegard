# What the best generative studios do (and get wrong)

Research for Hildegard's second design pass, October 2026. It covers about 35 products across video and image, voice, music, 3D, local model tools, cost dashboards and device pairing. Each section gives the patterns worth taking (with the product that does it best) and the traps users complain about. Sources are linked inline. Items marked *(unverified)* come from older knowledge and could not be confirmed on a current page.

## Market facts that shape the design

- **Platforms keep taking work away from people.**
  - Udio disabled every download, old tracks included, after its UMG deal ([DMN, Oct 2025](https://www.digitalmusicnews.com/2025/10/31/udio-downloads-disabled-umg-deal/)).
  - PlayHT shut down and deleted user data with no migration path ([texttolab](https://texttolab.com/blog/play-ht-shutdown-alternatives)).
  - Suno v6 (Sep 2026) retires older models that users liked ([Suno](https://suno.com/blog/introducing-v6), [MusicRadar](https://www.musicradar.com/music-tech/im-cancelling-my-subscription-suno-users-slam-its-v6-update-as-muffled-generic-soulless-garbage)) and caps downloads at 20 a month on Pro.
  - This is Hildegard's strongest story: nothing is ever locked, every model version stays pinned, and everything exports.
- **Credit anxiety is the top complaint everywhere.**
  - People are charged for failed or black outputs (Runway, Meshy).
  - New users default to the priciest model (Runway).
  - An agent spent 9,000 credits without asking ([dev.to](https://dev.to/theaidownside/the-ai-video-squeeze-credit-traps-silent-refusals-and-disposable-tools-3oh3)).
  - Free regenerations vanish on refresh (ElevenLabs).
  - Budgets that look like caps only send alerts (OpenAI).
- **Long queues with no position or ETA** (Kling, Sora), and moderation blocks with no reason, are the next most common complaints.

## Video and image (Higgsfield, Runway, Kling, Luma, Flow, Sora, Pika, Krea, Midjourney, Freepik Spaces, LTX Studio)

Take:
1. **Camera rig picker** (Higgsfield Cinema Studio): pick a camera body, then lens, then focal length, then aperture, as visual cards. Higgsfield began with only three controls, and its presets are decoupled from the model, so a model swap never breaks a look ([how we built it](https://higgsfield.ai/blog/how-we-built-cinema-studio)).
2. **Director's panel:** genre, era, pacing, lighting and palette as one group. Genre drives camera behaviour (Higgsfield 3.5+).
3. **Motion preset gallery** with looping previews on hover: Dolly Zoom, Crash Zoom, FPV Drone, Bullet Time, Whip Pan, 360 Orbit and so on ([camera controls](https://higgsfield.ai/camera-controls)).
4. **Elements:** reusable characters, locations and props, called with @ in the prompt. Editing one updates every shot (LTX Studio, Krea, Sora character cameos, Higgsfield Elements).
5. **Start and end frame slots** that appear only in video mode, plus a Loop checkbox (Midjourney, Flow, Kling).
6. **"Use as…" on every result:** start frame, end frame, reference or style. Settings travel with the frame (Midjourney, Higgsfield).
7. **Lineage:** a video sits under the image it came from, and takes stack together (Luma Boards, [quick start](https://lumalabs.ai/learning-hub/web-quick-start)).
8. **Cost printed on the Generate button,** live as settings change (Higgsfield Popcorn, Midjourney's batch cost table).
9. **Draft then finalize:** cheap 360p drafts at about a third of the cost, then full quality with the same seed (Google Flow, Aug 2026).
10. **Retake a time range:** re-prompt only seconds 4–7 and check the blend (LTX Studio). **Extend** reads the last seconds of the previous clip (Flow).
11. **Shot list to timeline:** cards to reorder, trim handles and stitch in the app (Flow, LTX, Sora stitching). Kling users complain they can't combine clips.
12. **Annotate to animate:** draw arrows, labels and boxes on a frame to direct motion, with each model labelled by what it's good at (Higgsfield Draw-to-Video, Kling Motion Brush).
13. **Compare models side by side:** one prompt run on several models (Krea Multiple Models).
14. **Optional node view for power users:** typed, coloured ports; Run node and Run downstream; **Lock output** so a rerun never re-renders it; drag from an output into empty space to search compatible nodes (Runway Workflows, Freepik Spaces). This maps directly onto ComfyUI graphs.
15. **Queue states:** Queued, Running %, Done, Failed with a reason, and Cancelled. Cancelling keeps finished outputs (Spaces).

Avoid: features scattered across separate studios with confusing navigation (Higgsfield); silent refusals; defaulting to the most expensive model; agent spending with no "ask before generating" gate; references that quietly change text or identity (Kling).

## Voice and transcription (ElevenLabs, Descript, Hume, Cartesia, Murf, Resemble, MacWhisper, Superwhisper, Otter)

Take:
1. **Layout:** voice rail, script editor in the centre, and a **Settings | History** inspector ([ElevenLabs TTS](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech)).
2. **Audio tags typed in brackets** (`[whispers]`, `[sighs]`, `[laughs]`, `[applause]`). Show them as chips the voice won't speak, with autocomplete. **Enhance** may add tags but never changes your words; show it as a diff ([prompting guide](https://elevenlabs.io/docs/best-practices/prompting)).
3. **Per-utterance acting direction in plain words** ("whispering, hushed"), up to 100 characters (Hume Octave, [acting instructions](https://dev.hume.ai/docs/text-to-speech-tts/acting-instructions)).
4. **Long-form Studio** ([doc](https://elevenlabs.io/docs/eleven-creative/products/studio)):
   - Chapters.
   - Voice, model and settings set per paragraph, with a coloured voice orb on each.
   - Select text to recast it in another voice; "Replace voice across project" swaps one everywhere.
   - A status gutter marks each paragraph generated, ungenerated or edited since generating.
   - **Lock paragraph** protects approved takes, and each paragraph keeps a take history with **Restore**.
   - A pronunciation dictionary.
   - A cost-to-finish confirmation before export.
5. **Voice Library:** a language-then-accent cascade, filters, a single preview button, and a badge for the voice type. **Use voice** opens TTS with it preselected. Voice owners give a **notice period** before removing a voice.
6. **Voice Design** returns **3 candidates** to keep or discard (ElevenLabs, Hume).
7. **Cloning with real consent:**
   - The consent statement you record is also the training and verification sample (Descript, [custom speaker](https://help.descript.com/ai-speech/custom-speaker.md)).
   - Generated audio is watermarked, with a detector (Resemble).
   - The wizard shows a live sample-length meter with one clear target.
8. **Transcript editor** ([Scribe](https://elevenlabs.io/docs/eleven-creative/products/transcripts.md)):
   - Word timings with **Re-align**.
   - Press Enter to split a segment; merge only segments from the same speaker.
   - Click a speaker orb to reassign; "Move segments to" moves many at once.
   - Search jumps to timestamps (Otter's best feature).
9. **Recording overlay:** a live waveform, a visible indicator when context is captured, and a guard before cancelling a long take (Superwhisper).
10. **Reader mode:** words highlight as they play, speed up to 4×, sleep timer (ElevenReader).

Avoid: free regenerations that reset on refresh; unlabelled 0–100 sliders; controls that silently disappear when the model changes (grey them out and explain instead); generic "Speaker 1" labels; no way to export voices and consent records.

## Music (Suno, Udio, ElevenLabs Music, Stable Audio, Producer.ai, Mubert, ACE-Step UI, ComfyUI, plus Splice, BandLab and Logic conventions)

Take:
1. **Simple or Custom on one panel.** Custom has Lyrics, Styles, **Exclude styles**, Title, Instrumental, Duration, BPM and Key (Suno, ACE-Step UI).
2. **Lyrics editor that knows sections:** `[Verse: sparse piano]` tags shown as coloured chips that line up with the timeline. Rhymes and rewrites on request (Suno Lyrics Editor, Jul 2026).
3. **The section timeline is the main object.** Drag to resize and reorder; set style, tempo, energy and key per section; include and exclude styles per section ([ElevenLabs Music](https://elevenlabs.io/docs/creative-platform/products/music), Composer Aug 2026).
4. **Staged edits with one Generate button,** under a banner that reads "Song composition has changed" (ElevenLabs).
5. **Replace a region** ([Suno editor](https://help.suno.com/en/articles/6141505)):
   - Select a region, then use **Quick Replace** or Replace with a prompt.
   - Alternates go to an **Edits Library** tray, with **Generate More**.
   - The seam is draggable, and changes apply only after **Commit**.
6. **Extend dialog:** place the new part (Intro / Before / After / Outro) and set **Context Length**, how much of the song the model listens to (Udio).
7. **Two variations as A/B rows,** each with its own waveform. Users set the count, 1–4 (ACE-Step).
8. **Take lanes inside a section:** alternates are comped in place, and the region's waveform shows the active take (BandLab, Logic).
9. **Library dock with a mini player** that auditions against the session; arrow keys skip; drag a track into the timeline (Suno Studio).
10. **Stems tab:** split automatically or choose instruments; mute, solo and pan each stem; export WAV stems plus tempo and key, or a DAW project (Suno Studio, Splice "Export for DAW").
11. **Show VRAM and queue position on the options themselves,** offer "Reuse settings" on every clip, and expose the seed (ACE-Step UI).
12. **A licence note at export** (Mubert).

Avoid: no seed, so nothing can be repeated (Suno); charging for broken outputs; extending from a damaged tail with no warning; a hidden prompt rewriter that is on by default; a chat-only interface with no timeline (Producer.ai); WAV and stems locked behind higher tiers.

## 3D (Meshy, Tripo, Rodin, Hunyuan3D Studio, Spline)

Take: two stages, where you pick an image preview before the mesh is built (Spline); the same input run on several models with a result switcher that costs nothing extra ([Spline](https://docs.spline.design/generate/ai-3d-generation)); a **Wireframe / Clay / Maps / Environment / Auto-rotate** viewer toolbar; quality presets labelled by use with face counts shown ("hero 50k / mobile 8k"), and either a quality preset or a custom polycount, never both (Rodin); Quad or Triangle mesh and a T/A-pose toggle; a pipeline stepper (geometry, parts, retopology, UVs, texture, rig) where earlier stages re-run without losing later ones ([Hunyuan3D Studio](https://arxiv.org/html/2509.12815v1)); Magic Brush to repaint one area (Tripo); export to GLB, FBX, OBJ, USD, STL and 3MF.

Avoid: paywalled downloads and STL locked away (Tripo, Meshy); credits burned on retries that drift from the prompt.

## Models, devices and the Choir (LM Studio, Jan, Ollama, Msty, Stability Matrix, ComfyUI Desktop, Invoke, Draw Things, exo, GPUStack, Tailscale)

Take:
1. **Fit pill** on every model and quant: **Fits / May be slow / Won't fit**, plus Small / Balanced / Large and a Recommended tag ([Jan](https://docs.jan.ai/desktop/manage-models)). Checked against each device and the Choir as a whole.
2. **Live memory estimate** that turns red past capacity as context or resolution changes, plus an "estimate only" dry run (LM Studio).
3. **Placement explained:** "Placed on Studio PC + Studio Mac, split across 2 GPUs" (GPUStack, exo). Topology shows memory and link speed between devices (exo).
4. **One shared model store** for every engine, with pause and resume (Stability Matrix). Missing models appear in an **Errors** panel with a single batch install (ComfyUI Desktop).
5. **Queue verbs:** Run, **Run next** (front of the queue), Cancel current, Cancel all except current, Cancel batch ([Invoke](https://support.invoke.ai/support/solutions/articles/151000158823-queue)). Results land as candidates to Accept, Discard or Save.
6. **First run splits into "Set up local" and "Add a provider"** (Msty).
7. **Pairing:** a short code or QR shown on the new device and confirmed from one you already trust (Jellyfin Quick Connect, Tailscale QR). A new device is pinned at the top with a **Needs approval** badge (Tailscale). Unclaimed devices on the network are found automatically, as Plex does, but without requiring an account.
8. **Every device says what it can do and why not,** in one place. Continuity's lesson is that hidden requirements make features feel broken.

Avoid: pairing that depends on a cloud account and spins forever (Plex); opaque security refusals with no fix (ComfyUI); quiet slowdowns when a model spills into RAM; caches that grow without bound.

## Costs and keys (OpenRouter, Vercel, Claude Console, OpenAI, Replicate, fal)

Take: per-key limits that reset daily, weekly or monthly, a Disabled toggle and a remaining-balance counter ([OpenRouter](https://openrouter.ai/blog/tutorials/team-spend-controls-setup/)); a "credits vs your own key" split and a card for the biggest change since last period; filters saved in the URL with drill-through to the request log; alerts on by default at **50 / 75 / 100%** and a hard stop that must be explicitly confirmed and is recorded in the activity log ([Vercel](https://vercel.com/docs/spend-management)); click a bar to drill down to the hour; charge only for successful outputs ([fal](https://fal.ai/docs/documentation/model-apis/pricing)).

Avoid: a "budget" that only alerts but looks like a cap (label it **Alert only** or **Hard stop**); a silent 403 when a cap is hit; paused jobs that must each be resumed by hand after raising a limit.

## Phones, widgets and Live Activities

Take: a compact layout designed first ("Rendering 3/7 · Studio PC"); an expanded view with the current step, progress and one **Stop** button; push updates only when something changes (step, blocked, done) to stay within the 4 KB limit; and a graceful "still working, open Hildegard" ending for jobs that outlast the activity ([vp0](https://vp0.com/blogs/ios-dynamic-island-live-activities-ai-agent/)). On mobile, ElevenLabs keeps TTS, quick cloning and the voice library, and leaves long-form Studio, dubbing and pro cloning on the web. That split is a good guide for what belongs in Hildegard's phone app.
