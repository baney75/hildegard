# Claude Design prompt: Hildegard app + logo

Paste everything below the line into Claude Design.

---

Design the visual identity and core app UI for **Hildegard**, an open source, self-hosted generative AI studio. I want three things: **a logo (with app icon variants)**, **a desktop app design with its key screens**, and **iOS and Android companion apps**.

Treat this as a flagship product. The bar is near perfectionist: every spacing value, icon stroke, state and transition should be deliberate and consistent across desktop and mobile. Prefer fewer, finished screens over many rough ones.

## What Hildegard is

Hildegard is a local, open source alternative to Higgsfield, Suno and ElevenLabs. One app covers every kind of generative work, from simple jobs like transcription and image labeling up to video, music, voice and 3D model generation. It installs on Mac, Windows and Linux (plus an Omarchy plugin), and it can cluster several of your own devices into one pool of compute.

Each device runs in one of two modes:
- **Server mode**: always available, a dedicated box.
- **Opportunistic mode**: the device lends compute only when it detects you are not using it (idle times are learned automatically). The user can always **force a request through** to jump the queue and claim compute now.

Users can optionally add their own API keys for outside models (OpenAI, Anthropic, ElevenLabs, etc.). Hildegard shows exactly what every request costs, and how much was saved by running locally instead.

The three promises: **you save money, your work stays private, and you own everything you make.**

Audience: creators, musicians, indie filmmakers, podcasters and technical hobbyists who are comfortable installing software but do not want to babysit Python environments. It should feel powerful but calm, never like a dev tool dashboard.

## The name and the inspiration

The app is named after **Saint Hildegard of Bingen** (1098 to 1179), the Benedictine abbess, composer, visionary, naturalist and Doctor of the Church. She is a fitting patron because she did everything at once: she wrote music (the *Symphonia* and the *Ordo Virtutum*), recorded and illustrated her visions (*Scivias*), wrote on medicine and the natural world (*Physica*), and even invented her own language and alphabet (the *Lingua Ignota* and *Litterae Ignotae*). One person, every medium. That is the product.

Motifs to draw from, used with restraint and respect, never as kitsch or costume:
- **Viriditas**, her word for "greenness": the living, growing force in all things. This should anchor the palette.
- **The Living Light** (*lux vivens*) she described in her visions: a radiant light seen through a softer "shadow of the living light."
- The **illuminated manuscripts of her visions** (the Rupertsberg *Scivias*): concentric circles, the cosmic egg, mandorlas, flame-like rays, gold leaf against deep blue and black, small dense patterning.
- **"A feather on the breath of God"**, her own image of herself: lightness, carried by something larger.
- **The choir**: many voices in one harmony, a natural metaphor for many devices clustering into one.

The result should read as a modern, premium creative tool first, with a quiet medieval soul underneath. Think "illuminated manuscript meets contemporary pro audio and video software," not "church website."

## Deliverable 1: Logo

Design a logo system:
1. **Primary mark**: a simple symbol that works at 16px. Explore directions such as an H formed from or contained in concentric rings; a stylized feather crossed with a sound waveform; a mandorla or cosmic egg that doubles as a "living light" aperture; a leaf with viriditas green that also reads as a flame. Show 3 to 4 directions, then refine the strongest.
2. **Wordmark**: "Hildegard" in a typeface with calligraphic or uncial character but clean modern proportions. Optionally a custom letterform for the H or g nodding to her invented alphabet.
3. **Lockups**: horizontal (mark + wordmark) and stacked.
4. **App icons**: macOS (rounded square), Windows, and a Linux/Omarchy-friendly flat variant. Also a monochrome version for the menu bar and system tray.
5. Show the logo on light, dark and green backgrounds.

## Deliverable 2: Visual system

- **Palette**: a deep viriditas green as the brand color; manuscript gold as the accent for highlights and "live" states; ink near-black and lapis blue for dark mode surfaces; warm vellum off-white for light mode. Include semantic colors for running, queued, idle, error, and cost/savings.
- **Type**: a refined serif or uncial-inspired display face for headings, a clean humanist sans for UI, and a mono for model names, logs and costs.
- **Texture and ornament**: subtle, optional: fine gold rule lines, small concentric-circle motifs as loading and progress indicators, very faint vellum grain. Ornament must never reduce legibility or density.
- **Dark mode is the default.** Provide light mode too.

## Deliverable 3: Key screens (desktop app, about 1440 x 900)

1. **Studio (home)**: one prompt bar that accepts any kind of request, with modality chips for Transcribe, Label, Image, Voice, Music, Video and 3D. Recent creations shown as a gallery. A small persistent strip shows cluster status and "saved this month."
2. **Create: Music**: a Suno-like flow: lyrics and style prompt, length, model picker, generated tracks with waveforms and variations.
3. **Create: Voice**: an ElevenLabs-like flow: voice library, cloned voices, text-to-speech editor with per-line voice and emotion, playback.
4. **Create: Video**: a Higgsfield-like flow: prompt, reference image, camera motion presets, duration, render queue with preview frames.
5. **Choir (cluster view)**: all devices as nodes in a constellation or concentric-ring diagram: each with OS, GPU, VRAM, mode (Server or Opportunistic), live load, and when it is likely free. Add device button with a simple pairing code or QR.
6. **Queue**: jobs across devices with progress, estimated start, which device runs them, and a prominent **Force now** button that explains what it will interrupt.
7. **Models**: a one-click model library grouped by modality, showing size, VRAM needed, which devices can run it, license, and install status across the cluster.
8. **Costs and Keys**: add and manage API keys; per-request cost history; a clear chart of spent on APIs versus saved by running locally; monthly budget caps and alerts.
9. **Onboarding**: 3 to 4 steps: welcome (introduce Hildegard and her story in one line), choose this device's mode, detect hardware and suggest starter models, optionally add API keys.
10. **Device settings**: activity detection schedule (learned idle hours shown as a weekly heatmap, editable), resource limits, privacy settings showing that nothing leaves the device unless you choose an outside API.

Also show one **compact menu bar / system tray popover**: this device's mode, current load, the job it is running, and a quick toggle to pause lending compute.

## Deliverable 4: iOS and Android apps

The phone app is a remote for your own Hildegard: you create on the go, and your home server or cluster does the work. It should feel native on each platform (follow iOS Human Interface Guidelines and Material 3 conventions for navigation, sheets and controls) while sharing the same brand, palette and type. Design at iPhone 16 Pro and Pixel 9 sizes, dark mode first.

Screens:
1. **Connect to your home Hildegard**: first run. Scan a QR code shown on the desktop app, or pick a connection method: **Tailscale** (recommended, one tap if already installed) or **your own Cloudflare Tunnel** (paste a URL). Make the trust step visible and reassuring: which server you are connecting to, its fingerprint or device name, and a clear "only your devices can reach this" message. Include success, failure and "server is asleep or offline" states.
2. **Home**: the same single prompt bar and modality chips as desktop, voice input front and center, recent creations below, and a slim status pill showing the connected server, Choir load and whether you are on Tailscale or a tunnel.
3. **Create flows**: compact versions of Music, Voice and Video. Use bottom sheets for options and keep the prompt and the Generate button in thumb reach.
4. **Queue and notifications**: running and waiting jobs, the **Force now** action, and push notification designs for "your track is ready" and "job failed."
5. **Library**: everything you have made, filterable by modality, with full-screen players for audio and video, a 3D model viewer, and share or save to device.
6. **Choir at a glance**: a simplified constellation of your devices and their status, with the ability to switch a device between Server and Opportunistic mode.
7. **Costs**: this month's API spend versus local savings, and budget alerts.
8. **Settings**: connections (manage multiple servers, switch between them), API keys (view and revoke only; adding keys can happen here or on desktop), security (Face ID / fingerprint lock, sign out of a server).

Also design a **home screen widget** (iOS and Android) showing the current job's progress and "saved this month," and a **Live Activity / ongoing notification** for a long render.

## Tone of copy

Warm, plain and confident. Short labels. Occasional gentle nods to the namesake are welcome (the cluster called "Choir," an empty gallery saying "Nothing yet. Every work begins as a vision."), but no religious language in functional UI and no jargon walls.

## Constraints

- Must feel at home on macOS, Windows and Linux; avoid platform-specific chrome in the core layouts.
- Accessible contrast (WCAG AA) in both modes; never rely on gold alone to signal state.
- Dense enough for power users, calm enough for first-timers.
- Cost and privacy should be visible on every creation screen, not buried in settings.
- Security should feel present but calm: show connection and encryption status plainly, never with alarming red unless something is actually wrong.
- Design every state, not just the happy path: empty, loading, offline, error, permission denied, and very long content.
- Define a shared design system (tokens for color, type, spacing, radius, elevation and motion, plus core components) that both the desktop and mobile apps use, and show it as its own page.
- Motion should be quick and purposeful (under about 250ms for UI transitions); the concentric-ring motif can carry progress and loading.
