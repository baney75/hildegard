---
name: hildegard-apple-gpu
description: Why Hildegard doesn't render locally on Apple silicon Macs, and what would change it
metadata:
  type: project
  modified: 2026-10-23T23:38:52.231Z
---

2026-10-23: on rectory1 (M5, 24 GB, PyTorch MPS), Wan 2.2 5B fp16 took 70 min for a 5 s 480p draft (~200 s/step) and output a blurred blob. The same draft on parish1's RTX 4080 takes ~150 s and is clean. LTX-2.5 (int8) and LTX-2 (fp8) have no kernels/dtype on MPS.
So all models have `mps = false` in presets/models.toml (cinema-studio 0fcf662). The UI says "Doesn't render on this Mac yet" (fitWhy 'apple-gpu'), and Mac setup points to `hildegard choir join`.
**How to apply:** re-enable a model on MPS only after a real Mac render is clean and reasonably fast. Untried ideas: ComfyUI --fp32-vae / --force-fp32, bf16 weights, plus a smoke check that rejects near-uniform or NaN frames early. See [[hildegard-roadmap]].
