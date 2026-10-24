# SPDX-License-Identifier: Apache-2.0
import json
import os
import struct

import pytest
import torch

import guard
from guard import Classifier, GuardBlocked, judge, legacy_names, pick, read_weights

W, LAYERS, HEADS, SIZE = 32, 2, 4, 32


def tiny_weights(seed=0):
    """Random weights under the names the published classifier uses, at a tiny size."""
    g = torch.Generator().manual_seed(seed)
    r = lambda *s: torch.randn(*s, generator=g) * 0.2  # noqa: E731
    n = (SIZE // 16) ** 2 + 1
    w = {
        "vit.embeddings.cls_token": r(1, 1, W),
        "vit.embeddings.position_embeddings": r(1, n, W),
        "vit.embeddings.patch_embeddings.projection.weight": r(W, 3, 16, 16),
        "vit.embeddings.patch_embeddings.projection.bias": r(W),
        "vit.layernorm.weight": 1 + r(W),
        "vit.layernorm.bias": r(W),
        "classifier.weight": r(2, W),
        "classifier.bias": r(2),
    }
    for i in range(LAYERS):
        p = f"vit.encoder.layer.{i}"
        for t in ("query", "key", "value"):
            w[f"{p}.attention.attention.{t}.weight"] = r(W, W)
            w[f"{p}.attention.attention.{t}.bias"] = r(W)
        w[f"{p}.attention.output.dense.weight"] = r(W, W)
        w[f"{p}.attention.output.dense.bias"] = r(W)
        w[f"{p}.intermediate.dense.weight"] = r(4 * W, W)
        w[f"{p}.intermediate.dense.bias"] = r(4 * W)
        w[f"{p}.output.dense.weight"] = r(W, 4 * W)
        w[f"{p}.output.dense.bias"] = r(W)
        for ln in ("layernorm_before", "layernorm_after"):
            w[f"{p}.{ln}.weight"] = 1 + r(W)
            w[f"{p}.{ln}.bias"] = r(W)
    return w


def tiny(seed=0):
    return Classifier(tiny_weights(seed), width=W, layers=LAYERS, heads=HEADS, size=SIZE)


class Fixed:
    """A stand-in classifier that scores every frame the same."""

    size = SIZE

    def __init__(self, p):
        self.p = p
        self.seen = 0

    def __call__(self, x):
        self.seen += x.shape[0]
        return torch.full((x.shape[0],), self.p)


def frames(n=10, h=48, w=64):
    return torch.rand(n, h, w, 3, generator=torch.Generator().manual_seed(1))


def test_classifier_gives_one_probability_per_image():
    p = tiny()(torch.randn(3, 3, SIZE, SIZE))
    assert p.shape == (3,)
    assert float(p.min()) >= 0 and float(p.max()) <= 1


def test_transformers_5_names_read_as_the_published_ones():
    old = tiny_weights()
    new = {}
    for k, v in old.items():
        k2 = (k.replace("vit.encoder.layer.", "vit.layers.")
               .replace(".attention.attention.query.", ".attention.q_proj.")
               .replace(".attention.attention.key.", ".attention.k_proj.")
               .replace(".attention.attention.value.", ".attention.v_proj.")
               .replace(".attention.output.dense.", ".attention.o_proj.")
               .replace(".intermediate.dense.", ".mlp.fc1.")
               .replace(".output.dense.", ".mlp.fc2."))
        new[k2] = v
    assert set(legacy_names(new)) == set(old)
    x = torch.randn(2, 3, SIZE, SIZE)
    a = Classifier(old, width=W, layers=LAYERS, heads=HEADS, size=SIZE)(x)
    b = Classifier(new, width=W, layers=LAYERS, heads=HEADS, size=SIZE)(x)
    assert torch.allclose(a, b)


def test_wrong_weights_refuse_to_load():
    with pytest.raises(GuardBlocked, match="not the one Hildegard expects"):
        Classifier({"something": torch.zeros(1)})


def test_checks_every_frame_of_a_short_clip_and_spreads_over_a_long_one():
    assert pick(1) == [0]
    assert pick(24) == list(range(24))
    long = pick(241)
    assert len(long) == 24 and long[0] == 0 and long[-1] == 240
    assert all(b - a <= 11 for a, b in zip(long, long[1:]))


def test_passes_clean_frames_through_untouched():
    f = frames()
    assert judge(f, Fixed(0.1), 0.8) is f


def test_refuses_a_sexual_frame():
    with pytest.raises(GuardBlocked, match=r"^HildegardGuard: .*refused this take.*0\.90"):
        judge(frames(), Fixed(0.9), 0.8)
    with pytest.raises(GuardBlocked, match="start frame"):
        judge(frames(1), Fixed(0.9), 0.8, what="start frame")


def test_threshold_cannot_be_turned_off():
    # A graph asking for 1.0 (never refuse) or NaN still refuses at 0.95.
    for t in (1.0, 5.0, float("nan")):
        with pytest.raises(GuardBlocked):
            judge(frames(), Fixed(0.96), t)
    # And nothing stricter than 0.5 makes every take fail.
    assert judge(frames(), Fixed(0.4), 0.0) is not None


def test_scores_only_the_sampled_frames():
    m = Fixed(0.1)
    judge(frames(n=100, h=8, w=8), m, 0.8)
    assert m.seen == 24


def test_an_alpha_channel_is_ignored():
    f = torch.rand(2, 40, 40, 4)
    assert guard.prepare(f, [0, 1], SIZE).shape == (2, 3, SIZE, SIZE)


def write_safetensors(path, tensors):
    header, blobs, at = {}, [], 0
    for k, t in tensors.items():
        b = t.contiguous().float().numpy().tobytes() if hasattr(t, "numpy") else bytes()
        header[k] = {"dtype": "F32", "shape": list(t.shape), "data_offsets": [at, at + len(b)]}
        blobs.append(b)
        at += len(b)
    raw = json.dumps(header).encode()
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(raw)))
        f.write(raw)
        for b in blobs:
            f.write(b)


def test_reads_weights_without_the_safetensors_package(tmp_path, monkeypatch):
    import builtins

    real = builtins.__import__

    def no_safetensors(name, *a, **k):
        if name.startswith("safetensors"):
            raise ImportError(name)
        return real(name, *a, **k)

    w = {k: v for k, v in list(tiny_weights().items())[:4]}
    path = tmp_path / "model.safetensors"
    try:
        write_safetensors(path, w)
    except (RuntimeError, ImportError):  # torch without numpy
        pytest.skip("needs numpy to write the file")
    monkeypatch.setattr(builtins, "__import__", no_safetensors)
    back = read_weights(str(path))
    assert set(back) == set(w)
    assert all(torch.equal(back[k], w[k]) for k in w)


@pytest.mark.skipif(not os.environ.get("HILDEGARD_GUARD_WEIGHTS"), reason="set HILDEGARD_GUARD_WEIGHTS to the real file")
def test_real_classifier_passes_a_plain_frame():
    model = Classifier(read_weights(os.environ["HILDEGARD_GUARD_WEIGHTS"]))
    grey = torch.full((4, 256, 256, 3), 0.5)
    assert judge(grey, model, 0.8) is grey
