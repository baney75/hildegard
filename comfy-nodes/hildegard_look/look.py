# SPDX-License-Identifier: Apache-2.0
import math

import torch
import torch.nn.functional as F

CHUNK = 8  # frames processed at once, so a 10 s 1080p clip never needs a second full copy in flight

_LUMA = torch.tensor([0.2126, 0.7152, 0.0722])


def _gauss_kernel(sigma: float, device) -> torch.Tensor:
    radius = max(1, int(math.ceil(sigma * 3)))
    x = torch.arange(-radius, radius + 1, device=device, dtype=torch.float32)
    k = torch.exp(-(x * x) / (2 * sigma * sigma))
    return k / k.sum()


def blur(x: torch.Tensor, sigma: float) -> torch.Tensor:
    """Separable Gaussian blur of an NCHW tensor, with edges extended."""
    if sigma <= 0.05:
        return x
    k = _gauss_kernel(sigma, x.device)
    c = x.shape[1]
    pad = k.numel() // 2
    kh = k.view(1, 1, 1, -1).repeat(c, 1, 1, 1)
    kv = k.view(1, 1, -1, 1).repeat(c, 1, 1, 1)
    x = F.conv2d(F.pad(x, (pad, pad, 0, 0), mode="replicate"), kh, groups=c)
    return F.conv2d(F.pad(x, (0, 0, pad, pad), mode="replicate"), kv, groups=c)


def blur_large(x: torch.Tensor, sigma: float) -> torch.Tensor:
    """Wide blur done at quarter size, which is visually identical for glows and much cheaper."""
    n, c, h, w = x.shape
    small = F.interpolate(x, size=(max(1, h // 4), max(1, w // 4)), mode="area")
    small = blur(small, sigma / 4)
    return F.interpolate(small, size=(h, w), mode="bilinear", align_corners=False)


def _device():
    try:  # inside ComfyUI, use the GPU it uses
        import comfy.model_management as mm

        return mm.get_torch_device()
    except Exception:
        return torch.device("cpu")


def apply_look(frames: torch.Tensor, seed: int, grain=0.0, halation=0.0, vignette=0.0, gate_weave=0.0,
               softness=0.0, saturation=1.0, contrast=1.0, warmth=0.0, lift=0.0) -> torch.Tensor:
    """frames: [N, H, W, C] floats in 0..1 (ComfyUI IMAGE). Returns a new tensor of the same shape."""
    neutral = (grain == halation == vignette == gate_weave == softness == warmth == lift == 0
               and saturation == 1 and contrast == 1)
    if neutral:
        return frames
    n, h, w, _ = frames.shape
    dev = _device()
    out = torch.empty_like(frames)
    gen = torch.Generator(device="cpu").manual_seed(int(seed) & 0xFFFFFFFF)
    luma_w = _LUMA.to(dev, frames.dtype).view(1, 3, 1, 1)

    # Vignette mask, computed once: a smooth radial falloff toward the corners.
    vmask = None
    if vignette > 0:
        yy = torch.linspace(-1, 1, h, device=dev).view(-1, 1)
        xx = torch.linspace(-1, 1, w, device=dev).view(1, -1)
        r = torch.sqrt(xx * xx + yy * yy) / math.sqrt(2)
        vmask = (1 - vignette * 0.85 * torch.clamp((r - 0.35) / 0.65, 0, 1) ** 2).view(1, 1, h, w)

    # Gate weave: a slow random walk of a pixel or two, the way film drifts in an old projector gate.
    offsets = []
    if gate_weave > 0:
        amp = 0.6 + 2.4 * gate_weave
        dx = dy = 0.0
        for _ in range(n):
            dx = 0.7 * dx + 0.3 * float(torch.randn(1, generator=gen)) * amp
            dy = 0.7 * dy + 0.3 * float(torch.randn(1, generator=gen)) * amp * 0.6
            offsets.append((int(round(dx)), int(round(dy))))

    for start in range(0, n, CHUNK):
        x = frames[start:start + CHUNK].to(dev).permute(0, 3, 1, 2).clone()  # NCHW
        x = x[:, :3]
        if softness > 0:
            x = torch.lerp(x, blur(x, 0.6 + 2.0 * softness), min(1.0, softness * 1.2))
        if halation > 0:
            lum = (x * luma_w).sum(1, keepdim=True)
            highlights = torch.clamp((lum - 0.72) / 0.28, 0, 1) * x
            glow = blur_large(highlights, 6 + 30 * halation)
            tint = torch.tensor([1.0, 0.35, 0.12], device=x.device, dtype=x.dtype).view(1, 3, 1, 1)
            x = x + glow * tint * (0.9 * halation)
        if lift > 0:
            x = lift + x * (1 - lift)
        if contrast != 1:
            x = (x - 0.5) * contrast + 0.5
        if saturation != 1:
            lum = (x * luma_w).sum(1, keepdim=True)
            x = lum + (x - lum) * saturation
        if warmth != 0:
            shift = torch.tensor([0.06, 0.015, -0.06], device=x.device, dtype=x.dtype).view(1, 3, 1, 1)
            x = x + shift * warmth
        if vmask is not None:
            x = x * vmask
        if grain > 0:
            # Film grain is a little soft, not per-pixel digital noise: draw it at half size and upsample.
            noise = torch.randn(x.shape[0], 1, (h + 1) // 2, (w + 1) // 2, generator=gen).to(x.device, x.dtype)
            noise = F.interpolate(noise, size=(h, w), mode="bilinear", align_corners=False) * 1.6
            lum = (x * luma_w).sum(1, keepdim=True).clamp(0, 1)
            weight = 4 * lum * (1 - lum)  # strongest in the midtones, like real stock
            x = x + noise * weight * (0.07 * grain)
        if offsets:
            shifted = []
            for i in range(x.shape[0]):
                ox, oy = offsets[start + i]
                shifted.append(torch.roll(x[i], shifts=(oy, ox), dims=(1, 2)))
            x = torch.stack(shifted)
        out[start:start + CHUNK, :, :, :3] = x.clamp(0, 1).permute(0, 2, 3, 1).to(out.device)
        if frames.shape[3] > 3:
            out[start:start + CHUNK, :, :, 3:] = frames[start:start + CHUNK, :, :, 3:]
    return out


def _f(default, lo, hi, tip):
    return ("FLOAT", {"default": default, "min": lo, "max": hi, "step": 0.01, "tooltip": tip})


class HildegardLook:
    CATEGORY = "image/postprocessing"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    DESCRIPTION = "Film look: grain, halation, vignette, gate weave, softness and a simple grade. Seeded."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
                "grain": _f(0.0, 0.0, 1.0, "Film grain, strongest in the midtones"),
                "halation": _f(0.0, 0.0, 1.0, "Red glow bleeding around highlights"),
                "vignette": _f(0.0, 0.0, 1.0, "Darkened corners"),
                "gateWeave": _f(0.0, 0.0, 1.0, "Slow frame drift, like film in a projector gate"),
                "softness": _f(0.0, 0.0, 1.0, "Overall softening"),
                "saturation": _f(1.0, 0.0, 2.0, "1 keeps colour as is, 0 is black and white"),
                "contrast": _f(1.0, 0.0, 2.0, "1 keeps contrast as is"),
                "warmth": _f(0.0, -1.0, 1.0, "Positive is warmer, negative cooler"),
                "lift": _f(0.0, 0.0, 0.3, "Raises the blacks for a faded print"),
            }
        }

    def run(self, images, seed, grain, halation, vignette, gateWeave, softness, saturation, contrast, warmth, lift):
        return (apply_look(images, seed, grain=grain, halation=halation, vignette=vignette, gate_weave=gateWeave,
                           softness=softness, saturation=saturation, contrast=contrast, warmth=warmth, lift=lift),)
