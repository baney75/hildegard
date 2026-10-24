# SPDX-License-Identifier: Apache-2.0
"""Refuses frames that look sexual, using a ViT-base image classifier (labels: normal, nsfw).

Plain PyTorch, so it needs nothing ComfyUI doesn't already have: the network is small enough to write out here, and
reading the weights by their names means a transformers upgrade can't change what it does.
"""
import json
import math
import re
import struct

import torch
import torch.nn.functional as F

SIZE = 224
PATCH = 16
WIDTH = 768
LAYERS = 12
HEADS = 12
EPS = 1e-12
# Frames checked per clip, spread evenly from first to last. A 10 s take has 241, and a sexual stretch lasts longer
# than a tenth of a second; every frame of a start image or a short clip is checked.
SAMPLES = 24
MIN_THRESHOLD = 0.5
MAX_THRESHOLD = 0.95


class GuardBlocked(Exception):
    """Raised to stop the render. The engine reads the "HildegardGuard:" prefix and tells the person why."""


def read_weights(path):
    """Load a .safetensors file: with the safetensors package where it's installed (ComfyUI has it), else by hand."""
    try:
        from safetensors.torch import load_file

        return {k: v.float() for k, v in load_file(path).items()}
    except ImportError:
        pass
    dtypes = {"F32": torch.float32, "F16": torch.float16, "BF16": torch.bfloat16}
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(n))
        data = f.read()
    out = {}
    for name, info in header.items():
        if name == "__metadata__":
            continue
        start, end = info["data_offsets"]
        t = torch.frombuffer(bytearray(data[start:end]), dtype=dtypes[info["dtype"]])
        out[name] = t.reshape(info["shape"]).float()
    return out


# transformers 5 names the same weights differently; the published file uses the names transformers 4 wrote.
_RENAMES = [
    (r"^vit\.layers\.(\d+)\.attention\.([qkv])_proj\.", None),
    (r"^vit\.layers\.(\d+)\.attention\.o_proj\.", r"vit.encoder.layer.\1.attention.output.dense."),
    (r"^vit\.layers\.(\d+)\.mlp\.fc1\.", r"vit.encoder.layer.\1.intermediate.dense."),
    (r"^vit\.layers\.(\d+)\.mlp\.fc2\.", r"vit.encoder.layer.\1.output.dense."),
    (r"^vit\.layers\.(\d+)\.", r"vit.encoder.layer.\1."),
]
_QKV = {"q": "query", "k": "key", "v": "value"}


def legacy_names(weights):
    """The weights under transformers 4's names, whichever names they came with."""
    out = {}
    for name, t in weights.items():
        for pattern, repl in _RENAMES:
            m = re.match(pattern, name)
            if m:
                if repl is None:
                    name = re.sub(pattern, f"vit.encoder.layer.{m.group(1)}.attention.attention.{_QKV[m.group(2)]}.", name)
                else:
                    name = re.sub(pattern, repl, name)
                break
        out[name] = t
    return out


class Classifier:
    """ViT-B/16 at 224 px with a 2-way head, matching transformers' ViTForImageClassification weight names."""

    def __init__(self, weights, width=WIDTH, layers=LAYERS, heads=HEADS, patch=PATCH, size=SIZE):
        weights = legacy_names(weights)
        self.w = weights
        self.width, self.layers, self.heads, self.patch, self.size = width, layers, heads, patch, size
        need = ["vit.embeddings.cls_token", "vit.embeddings.position_embeddings", "classifier.weight"]
        missing = [k for k in need if k not in weights]
        if missing:
            raise GuardBlocked(f"HildegardGuard: the safety classifier is not the one Hildegard expects ({missing[0]}).")

    def to(self, *args, **kwargs):
        self.w = {k: v.to(*args, **kwargs) for k, v in self.w.items()}
        return self

    def _ln(self, x, name):
        return F.layer_norm(x, (self.width,), self.w[f"{name}.weight"], self.w[f"{name}.bias"], EPS)

    def _lin(self, x, name):
        return F.linear(x, self.w[f"{name}.weight"], self.w[f"{name}.bias"])

    @torch.no_grad()
    def __call__(self, pixels):
        """pixels: [B, 3, size, size], normalised to -1..1. Returns the probability that each image is sexual."""
        w = self.w
        x = F.conv2d(pixels, w["vit.embeddings.patch_embeddings.projection.weight"],
                     w["vit.embeddings.patch_embeddings.projection.bias"], stride=self.patch)
        x = x.flatten(2).transpose(1, 2)
        cls = w["vit.embeddings.cls_token"].expand(x.shape[0], -1, -1)
        x = torch.cat([cls, x], dim=1) + w["vit.embeddings.position_embeddings"]
        b, n, _ = x.shape
        hd = self.width // self.heads
        for i in range(self.layers):
            p = f"vit.encoder.layer.{i}"
            h = self._ln(x, f"{p}.layernorm_before")
            q, k, v = (self._lin(h, f"{p}.attention.attention.{t}").view(b, n, self.heads, hd).transpose(1, 2)
                       for t in ("query", "key", "value"))
            a = F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(b, n, self.width)
            x = x + self._lin(a, f"{p}.attention.output.dense")
            h = self._ln(x, f"{p}.layernorm_after")
            x = x + self._lin(F.gelu(self._lin(h, f"{p}.intermediate.dense")), f"{p}.output.dense")
        x = self._ln(x, "vit.layernorm")[:, 0]
        logits = F.linear(x, w["classifier.weight"], w["classifier.bias"])
        return logits.float().softmax(-1)[:, 1]


def pick(n, samples=SAMPLES):
    """Which frames to check: all of them for a short clip, else evenly spaced, always the first and the last."""
    if n <= samples:
        return list(range(n))
    return sorted({round(i * (n - 1) / (samples - 1)) for i in range(samples)})


def prepare(frames, idx, size=SIZE):
    """ComfyUI IMAGE [N, H, W, C] in 0..1 to the classifier's input: RGB, squashed to size × size, -1..1."""
    x = frames[idx][..., :3].permute(0, 3, 1, 2).float()
    x = F.interpolate(x, size=(size, size), mode="bilinear", align_corners=False, antialias=True)
    return (x - 0.5) / 0.5


def score(frames, model, device=None, batch=8):
    """The highest probability that any checked frame is sexual."""
    idx = pick(frames.shape[0])
    best = 0.0
    for start in range(0, len(idx), batch):
        x = prepare(frames, idx[start:start + batch], getattr(model, "size", SIZE))
        if device is not None:
            x = x.to(device)
        p = model(x)
        best = max(best, float(p.max()))
    return best


def clamp_threshold(t):
    t = float(t)
    if math.isnan(t):
        return MIN_THRESHOLD
    return min(MAX_THRESHOLD, max(MIN_THRESHOLD, t))


def judge(frames, model, threshold, what="take", device=None):
    """Raise GuardBlocked when a frame scores at or over the threshold; otherwise return the frames untouched."""
    s = score(frames, model, device)
    if s >= clamp_threshold(threshold):
        raise GuardBlocked(
            f"HildegardGuard: Hildegard refused this {what} because a frame looks sexual (score {s:.2f}). "
            "Hildegard doesn't make sexual content."
        )
    return frames
