# SPDX-License-Identifier: Apache-2.0
import torch

from look import apply_look


def frames(n=10, h=64, w=96):
    g = torch.Generator().manual_seed(1)
    return torch.rand(n, h, w, 3, generator=g)


def test_neutral_is_identity():
    f = frames()
    assert apply_look(f, 1) is f


def test_shape_range_and_input_untouched():
    f = frames()
    before = f.clone()
    out = apply_look(f, 7, grain=1, halation=1, vignette=1, gate_weave=1, softness=1, saturation=0.5,
                     contrast=1.3, warmth=0.5, lift=0.1)
    assert out.shape == f.shape
    assert float(out.min()) >= 0 and float(out.max()) <= 1
    assert torch.equal(f, before)


def test_seeded():
    f = frames()
    a = apply_look(f, 3, grain=0.5, gate_weave=0.5)
    b = apply_look(f, 3, grain=0.5, gate_weave=0.5)
    c = apply_look(f, 4, grain=0.5, gate_weave=0.5)
    assert torch.equal(a, b)
    assert not torch.equal(a, c)


def test_black_and_white():
    out = apply_look(frames(), 0, saturation=0)
    assert torch.allclose(out[..., 0], out[..., 1], atol=1e-5)


def test_vignette_darkens_corners_not_centre():
    f = torch.full((2, 64, 64, 3), 0.5)
    out = apply_look(f, 0, vignette=1)
    assert float(out[0, 0, 0, 0]) < 0.3
    assert abs(float(out[0, 32, 32, 0]) - 0.5) < 1e-3


def test_chunks_cover_every_frame():
    f = frames(n=19)
    out = apply_look(f, 0, contrast=1.2)
    assert not torch.isnan(out).any()
    assert torch.allclose(out[-1], ((f[-1] - 0.5) * 1.2 + 0.5).clamp(0, 1), atol=1e-5)
