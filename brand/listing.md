# Listing copy

The words Hildegard uses wherever it's listed: GitHub, the website, app stores, package managers and plugin
directories. Keep them in step with the website (`site/index.html`) and say only what a release does. The research
behind the choices is at the end.

## The one line

**Your own AI studio, on your own GPU.** Films, voices, characters and 3D, made on computers you own.

## GitHub

- **About:** Your own AI studio on your own GPU: AI video, voice, characters and 3D, local and private. A free, open
  source alternative to Higgsfield and ElevenLabs for Windows, macOS and Linux, and an MCP server for your AI apps.
- **Website:** https://dbaney.com/hildegard/
- **Topics (20, GitHub's limit):** `ai-video` `video-generation` `text-to-video` `local-ai` `self-hosted`
  `comfyui` `ltx-video` `wan-video` `text-to-speech` `voice-cloning` `generative-ai` `mcp` `mcp-server`
  `open-source-alternative` `higgsfield-alternative` `elevenlabs-alternative` `privacy` `gpu` `tauri` `ai-studio`
- **Social preview:** `brand/social-preview.jpg` (1280 by 640), from `node scripts/site-images.mjs`. Settings ›
  General › Social preview takes it by hand; there's no API for it.

## App stores

Stores read only certain fields for search, and reject other companies' names in them, so no competitor appears below.
Apple searches the name, subtitle and keyword field (not the description), and joins words across all three, so no
word appears twice. Google Play searches the title and both descriptions.

### Apple (the iPhone and iPad companion, and the Mac app)

| Field | Limit | Copy |
| --- | --- | --- |
| Name | 30 | Hildegard: AI Studio |
| Subtitle | 30 | Private AI video on your GPU |
| Keywords | 100 | `film,voice,clone,tts,speech,offline,local,maker,cinema,3d,comfyui,mcp,camera,dub,character,render` (97) |
| Promotional text | 170 | Direct films, give characters a face and a voice, and make 3D, all rendered on computers you own. No credits, no uploads, nothing leaves your devices. |
| Category | | Photo & Video (primary), Productivity (secondary) |

Description, first three lines (the ones shown before “more”):

> Hildegard is your own AI studio. Direct films with real camera language, cast the same character in every shot,
> give them a voice, and make 3D you can print, all on GPUs you own.
> Nothing you make leaves your devices, and nothing costs money per shot.

### Google Play (the Android companion)

| Field | Limit | Copy |
| --- | --- | --- |
| Title | 30 | Hildegard: AI Video & Voice |
| Short description | 80 | Make AI films and voices on your own GPU. Private, offline, no credits. (71) |
| Category | | Video Players & Editors |

The full description repeats the main phrases naturally once or twice each, never as a list of keywords: AI video
generator, text to video, text to speech, voice cloning with consent, private, offline, your own GPU, open source.

### Microsoft Store, and the Mac App Store

- **Short description:** Make AI films, voices, characters and 3D on your own GPU. Private, offline and open source.
- **Search terms (7 at most):** AI video, text to video, text to speech, voice cloning, local AI, ComfyUI, 3D printing

### Phone and tablet companions: what they must show

The phone apps reach a Hildegard at a link, so the first screenshot must say so, or reviewers and people alike will
expect rendering on the phone: “Direct shots from your phone. They render on your own computer.”

### Screenshots (in this order)

1. A real frame, full bleed, with the line “Your own AI studio, on your own GPU.”
2. The film board with kept takes: “Direct it like a film.”
3. The composer with camera, lens and move chips: “Real camera language.”
4. Characters: “The same face in every shot.”
5. Voice: “Voices, with consent built in.”
6. Devices: “Every computer you own, as one studio.”
7. Agents: “Your AI apps direct shots on your GPU.”
8. “Nothing leaves your devices. Nothing costs money per shot.”

## Package managers and directories

- **Flathub / AppStream summary (35):** AI video and voice on your GPU
- **AUR (`hildegard-bin`):** Your own AI studio on your own GPU: video, voice, characters and 3D
- **Homebrew cask:** AI studio for video, voice and 3D that runs on your own GPU
- **Omarchy plugin directory:** Hildegard in your bar: renders, voices and your studio, on your own GPU
- **MCP directories (Smithery, mcp.so, Glama, the official registry):** Hildegard: AI video, voice and 3D on your own
  GPU, as tools for any MCP client. Free, local, open source.

## What people search for

Grouped by what they want. The website answers each group in its own words: the title and description, “What it
makes”, “Why own it” and the questions.

- **Leaving a cloud tool:** Higgsfield alternative, free Higgsfield alternative, open source Higgsfield, ElevenLabs
  alternative, ElevenLabs open source, local ElevenLabs, Suno alternative, open source Suno, Pencil (pen.dev)
  alternative, Runway alternative, Kling alternative.
- **Running it themselves:** local AI video generator, run AI video locally, self-hosted AI video, offline text to
  speech, local voice cloning, local AI music, AI video on my own GPU, private AI video generator.
- **Model names:** LTX-2, LTX-2.5, Wan 2.2, FLUX.2 klein, Kokoro, Chatterbox, Qwen3-TTS, ComfyUI video workflow,
  ComfyUI GUI for video.
- **Hardware:** AI video on a 12 GB GPU, RTX 4080 AI video, AMD AI video Linux, AI video on a Mac.
- **Agents:** MCP video generation, Claude video generation, ChatGPT generate video locally, MCP server text to
  speech.

“Open Higgsfield AI” already ranks for the exact phrase “open source Higgsfield”, as a front end to cloud APIs plus a
few local models. Hildegard's difference to lead with: every frame renders on your own GPU, with no API gateway.
