# LTX + ComfyUI + Comfy SDK facts for Cinema Studio (verified 2026-10-19)

## @comfyorg/sdk 0.5.0 (MIT, Node >=22)
- `new Comfy({ apiKey?, timeoutMs?, fetch? })`; base URL only from env `COMFY_BASE_URL` (unset = cloud.comfy.org). Self-hosted: leave `COMFY_API_KEY` unset.
- `client.workflows.fromJson(apiGraph)`, `wf.setInput(nodeId, field, value)`; `client.submit(wf)` → Job; `job.events()` yields progress / preview(bytes) / outputReady / statusChange / log; `job.cancel()`; outputs via `job.getOutputs(nodeId)` → `.toFile()/.toBytes()`.
- Uploads: `client.assets.fromFile()` bound to a `LoadImage` filename widget.
- comfy-api-proxy (PyPI `comfy-api-proxy` 0.1.6): `comfy-api-proxy --comfyui http://127.0.0.1:8188 --port 8189`; then `COMFY_BASE_URL=http://127.0.0.1:8189`. Rejects job metadata labels.

## ComfyUI
- v0.42.1 (commit 63be2f9b82ad0dac88a7ceaa28a9cf3154125a18, 2026-10-18), Python 3.13 recommended.
- ComfyUI-LTXVideo: no tags; HEAD 44c8a36b7c31ee00b4271daed11dc2a4aa481140 (2026-10-14). Examples are UI-format with subgraphs.
- VideoHelperSuite 1.7.9, HEAD 4d907bee61e92c2e65af3bd6383a4e4d356126d1. Native `CreateVideo` + `SaveVideo` also works.

## LTX-2.5 distilled two-stage (Lightricks example `2.5/LTX-2.5_T2V_I2V_Two_Stage_Distilled.json`)
UNETLoader(transformer) · VAELoader(video vae) · VAELoader(audio vae) · CLIPLoader(gemma4-12b-with-proj, type ltxv) · LatentUpscaleModelLoader(x2) → CLIPTextEncode ±→ LTXVConditioning(fps) → EmptyLTXVLatentVideo(w,h,len) [+ LoadImage→ResizeImageMaskNode→LTXVPreprocess(18)→LTXVImgToVideoInplace(0.7) for i2v] + LTXVEmptyLatentAudio → LTXVConcatAVLatent → SamplerCustomAdvanced(RandomNoise, CFGGuider cfg 1, KSamplerSelect euler_ancestral, ManualSigmas "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0") → LTXVSeparateAVLatent → LTXVLatentUpsampler → LTXVImgToVideoInplace(1) → concat → SamplerCustomAdvanced(ManualSigmas "0.909375, 0.725, 0.421875, 0.0") → separate → VAEDecodeTiled(512,64,64,8) + LTXVAudioVAEDecode → CreateVideo(fps) → SaveVideo. Frames = 1 + 8n.

## Weights (HF)
- Lightricks/LTX-2.5: **gated (auto)**. diffusion_models/ltx-2.5-22b-distilled-transformer-{bf16 42GB, comfy-int8-convrot 21.5GB, nvfp4 18.7GB}; text_encoders/gemma4-12b-with-proj-ltx-2.5-{bf16, comfy-int8-convrot}; vae/ltx-2.5-video-vae-bf16, ltx-2.5-audio-vae-bf16; latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.
- Lightricks/LTX-2: not gated. ltx-2-19b-distilled(-fp8).safetensors (VAE + audio VAE bundled), ltx-2-spatial-upscaler-x2-1.0; text encoder Comfy-Org/ltx-2 split_files/text_encoders/gemma_3_12B_it(_fp8_scaled).safetensors.
- Camera LoRAs (LTX-2 19B only): Lightricks/LTX-2-19b-LoRA-Camera-Control-{Dolly-In,Dolly-Out,Dolly-Left,Dolly-Right,Jib-Up,Jib-Down,Static}, file ltx-2-19b-lora-camera-control-<move>.safetensors.
- LTX-2 Community License: free under $10M revenue; Attachment A: disclose AI-generated, no non-consensual deepfakes; **item 20 bars use in a product that directly competes with Lightricks' commercial products (e.g. LTX Studio) without a separate license → needs Donovan's / legal judgment.** Hildegard never rehosts weights; users download them under their own acceptance.
- LTXVideo README: 32 GB+ VRAM recommended, 100 GB+ disk.
