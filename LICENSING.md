# Licensing

Copyright 2026 Donovan Baney and Hildegard contributors.

- **The app** is licensed under the **GNU Affero General Public License v3.0 only** ([LICENSE](LICENSE)). That covers everything not listed below, including `apps/`, `packages/comfy/`, `mcp/`, `install/`, `deploy/` and `scripts/`. If you run a modified Hildegard as a service for others, you must offer them its source: set `HILDEGARD_SOURCE_URL` to your repository and the About page will link to it.
- **Presets, workflows, the client protocol and the film-look node** (`presets/`, `workflows/`, `packages/presets/`, `comfy-nodes/`) are licensed under the **Apache License 2.0** ([LICENSE-APACHE](LICENSE-APACHE)), so anyone can reuse them in their own tools. The node carries its own copy in [comfy-nodes/hildegard_look/LICENSE](comfy-nodes/hildegard_look/LICENSE).
- **The voice engine** (`voice-engine/`) is licensed under the **Apache License 2.0** too, with its own copy in [voice-engine/LICENSE](voice-engine/LICENSE). Its speaker check follows Chatterbox's encoder (MIT), whose notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Third-party code and fonts** are listed with their licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which also ships with the app. Regenerate it with `node scripts/notices.mjs` after changing dependencies. Two fonts are subsets renamed as their Reserved Font Names require: Hildegard Sans (from Source Sans 3) and Hildegard Uncial (from Uncial Antiqua).
- **Model weights are never included.** Hildegard downloads each model from its publisher's Hugging Face repository. You are the licensee, and Hildegard shows each model's license and asks you to accept it before the first download:
  - LTX-2.5: [LTX-2.x Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x)
  - LTX-2 and its camera LoRAs: [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2); its Gemma 3 text encoder comes under Google's Gemma Terms of Use
  - Wan 2.2 5B: [Apache-2.0](https://github.com/Wan-Video/Wan2.2/blob/main/LICENSE.txt)
  - Voice: Kokoro-82M ([Apache-2.0](https://huggingface.co/hexgrad/Kokoro-82M)), Chatterbox Multilingual and its speaker encoder ([MIT](https://huggingface.co/ResembleAI/chatterbox)), Qwen3-TTS Voice Design and Base ([Apache-2.0](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign)) and faster-whisper small ([MIT](https://huggingface.co/Systran/faster-whisper-small)). Every voice model Hildegard offers allows commercial use.

ComfyUI (GPL-3.0) runs as a separate program that Hildegard talks to over HTTP; it is not part of Hildegard.
