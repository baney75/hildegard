# SPDX-License-Identifier: AGPL-3.0-only
"""A small, dependency-light kit for making 3D models in code and sending them to a Hildegard loop.

Plain numpy for watertight primitives, transforms and the OBJ, STL and GLB writers, so it runs in any Python, a
chatbot's code tool included. Signed-distance modeling (`mesh_sdf`) also needs scikit-image for marching cubes.

    from mesh_kit import *
    body = sdf_ellipsoid((0, 0, 40), (14, 10, 22))
    head = sdf_sphere((0, 4, 72), 8)
    neck = sdf_capsule((0, 0, 55), (0, 4, 68), 3.5)
    shape = smin(smin(body, neck, 4), head, 3)
    v, f = mesh_sdf(shape, lo=(-20, -20, 0), hi=(20, 20, 90), step=0.6)
    v, f = merge((v, f), cylinder(r=12, h=6))          # a plinth: a separate body, on purpose
    write_stl("heron.stl", v, f)                          # or write_glb / write_obj
    # then: loop_submit with file_path="…/heron.stl", or data=base64 of the file

A mesh is (vertices: float array N×3, faces: int array M×3), faces wound counter-clockwise seen from outside.
"""

import json
import math
import struct

import numpy as np

# ── Primitives (watertight, outward-facing) ─────────────────────────────────────────────────────────────────────


def box(size=(1.0, 1.0, 1.0), center=(0.0, 0.0, 0.0)):
    sx, sy, sz = (s / 2 for s in size)
    v = np.array([[x, y, z] for z in (-sz, sz) for y in (-sy, sy) for x in (-sx, sx)], dtype=float) + center
    f = np.array([[0, 2, 3], [0, 3, 1], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4],
                  [1, 3, 7], [1, 7, 5], [3, 2, 6], [3, 6, 7], [2, 0, 4], [2, 4, 6]])
    return v, f


def sphere(r=1.0, center=(0.0, 0.0, 0.0), rings=24, segments=48):
    v = [[0, 0, r]]
    for i in range(1, rings):
        t = math.pi * i / rings
        for j in range(segments):
            p = 2 * math.pi * j / segments
            v.append([r * math.sin(t) * math.cos(p), r * math.sin(t) * math.sin(p), r * math.cos(t)])
    v.append([0, 0, -r])
    f = []
    for j in range(segments):
        f.append([0, 1 + j, 1 + (j + 1) % segments])
    for i in range(rings - 2):
        a, b = 1 + i * segments, 1 + (i + 1) * segments
        for j in range(segments):
            k = (j + 1) % segments
            f += [[a + j, b + j, b + k], [a + j, b + k, a + k]]
    last, a = len(v) - 1, 1 + (rings - 2) * segments
    for j in range(segments):
        f.append([a + j, last, a + (j + 1) % segments])
    return np.array(v) + center, np.array(f)


def cylinder(r=1.0, h=1.0, base=(0.0, 0.0, 0.0), segments=64):
    """A cylinder standing on `base`, axis along +Z."""
    ring = [[r * math.cos(2 * math.pi * j / segments), r * math.sin(2 * math.pi * j / segments)] for j in range(segments)]
    v = [[x, y, 0] for x, y in ring] + [[x, y, h] for x, y in ring] + [[0, 0, 0], [0, 0, h]]
    bottom, top = 2 * segments, 2 * segments + 1
    f = []
    for j in range(segments):
        k = (j + 1) % segments
        f += [[j, k, segments + k], [j, segments + k, segments + j]]
        f += [[bottom, k, j], [top, segments + j, segments + k]]
    return np.array(v, dtype=float) + base, np.array(f)


# ── Transforms ──────────────────────────────────────────────────────────────────────────────────────────────────


def translate(mesh, offset):
    v, f = mesh
    return v + np.asarray(offset, dtype=float), f


def scale(mesh, s):
    v, f = mesh
    s = np.broadcast_to(np.asarray(s, dtype=float), (3,))
    f = f if np.prod(s) > 0 else f[:, ::-1]  # a mirror turns faces inside out unless they're flipped back
    return v * s, f


def rotate(mesh, degrees, axis="z"):
    v, f = mesh
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    m = {"x": [[1, 0, 0], [0, c, -s], [0, s, c]], "y": [[c, 0, s], [0, 1, 0], [-s, 0, c]],
         "z": [[c, -s, 0], [s, c, 0], [0, 0, 1]]}[axis]
    return v @ np.array(m).T, f


def merge(*meshes):
    """Several meshes as one file, each still its own body (Hildegard's `bodies` check counts them)."""
    vs, fs, n = [], [], 0
    for v, f in meshes:
        vs.append(v)
        fs.append(f + n)
        n += len(v)
    return np.concatenate(vs), np.concatenate(fs)


def sit_on_floor(mesh):
    """Moves a mesh so its lowest point is at z = 0, centred on x and y: where a print starts."""
    v, f = mesh
    lo, hi = v.min(0), v.max(0)
    return v - [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]], f


# ── Signed-distance modeling ────────────────────────────────────────────────────────────────────────────────────
# Each sdf_* returns a function of points (N×3) giving distance: negative inside, positive outside.


def sdf_sphere(c, r):
    c = np.asarray(c, dtype=float)
    return lambda p: np.linalg.norm(p - c, axis=-1) - r


def sdf_ellipsoid(c, radii):
    c, r = np.asarray(c, dtype=float), np.asarray(radii, dtype=float)

    def d(p):
        q = (p - c) / r
        k0 = np.linalg.norm(q, axis=-1)
        k1 = np.linalg.norm(q / r, axis=-1)
        return k0 * (k0 - 1) / np.maximum(k1, 1e-9)

    return d


def sdf_capsule(a, b, r):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)

    def d(p):
        pa, ba = p - a, b - a
        h = np.clip((pa @ ba) / (ba @ ba), 0, 1)
        return np.linalg.norm(pa - h[..., None] * ba, axis=-1) - r

    return d


def sdf_round_box(c, size, radius):
    c, half = np.asarray(c, dtype=float), np.asarray(size, dtype=float) / 2 - radius

    def d(p):
        q = np.abs(p - c) - half
        return np.linalg.norm(np.maximum(q, 0), axis=-1) + np.minimum(q.max(-1), 0) - radius

    return d


def smin(a, b, k):
    """Smooth union: the two forms flow into each other over a distance of about k."""

    def d(p):
        da, db = a(p), b(p)
        h = np.clip(0.5 + 0.5 * (db - da) / k, 0, 1)
        return db + (da - db) * h - k * h * (1 - h)

    return d


def smax(a, b, k):
    """Smooth subtraction of b from a."""
    return lambda p: -smin(lambda q: -a(q), b, k)(p)


def mesh_sdf(fn, lo, hi, step):
    """Meshes a distance function over the box lo..hi, at `step` units per sample, faces turned outward."""
    from skimage import measure  # scikit-image: pip install scikit-image

    lo, hi = np.asarray(lo, dtype=float), np.asarray(hi, dtype=float)
    n = np.ceil((hi - lo) / step).astype(int) + 3
    axes = [lo[i] - step + np.arange(n[i]) * step for i in range(3)]
    grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1)
    vol = fn(grid.reshape(-1, 3)).reshape(n)
    vol[0, :, :] = vol[-1, :, :] = vol[:, 0, :] = vol[:, -1, :] = vol[:, :, 0] = vol[:, :, -1] = step  # closed
    v, f, _, _ = measure.marching_cubes(vol, 0.0, spacing=(step, step, step))
    v = v + (lo - step)
    mesh = (v, f.astype(np.int64))
    return mesh if signed_volume(mesh) > 0 else (v, f[:, ::-1].astype(np.int64))


def signed_volume(mesh):
    v, f = mesh
    t = v[f]
    return float(np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() / 6)


# ── Writers ─────────────────────────────────────────────────────────────────────────────────────────────────────


def write_obj(path, v, f):
    with open(path, "w", encoding="ascii") as out:
        out.write("".join(f"v {x:.6g} {y:.6g} {z:.6g}\n" for x, y, z in v))
        out.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f))


def obj_text(v, f):
    """The mesh as OBJ text, to send as a loop round's `text`."""
    return "".join(f"v {x:.6g} {y:.6g} {z:.6g}\n" for x, y, z in v) + "".join(
        f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f)


def write_stl(path, v, f):
    t = np.asarray(v, dtype=np.float32)[f]
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rec = np.zeros(len(f), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"], rec["v"] = n, t
    with open(path, "wb") as out:
        out.write(b"mesh_kit".ljust(80, b" ") + struct.pack("<I", len(f)) + rec.tobytes())


def write_glb(path, v, f, y_up=True):
    """A GLB. Models here are Z-up (as for printing); glTF is Y-up, so by default they are turned to stand upright."""
    p = np.asarray(v, dtype=np.float32)
    if y_up:
        p = np.stack([p[:, 0], p[:, 2], -p[:, 1]], axis=1)
    pos, idx = p.astype("<f4").tobytes(), np.asarray(f, dtype="<u4").tobytes()
    doc = {
        "asset": {"version": "2.0", "generator": "Hildegard mesh_kit"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(pos) + len(idx)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
                        {"buffer": 0, "byteOffset": len(pos), "byteLength": len(idx), "target": 34963}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(p), "type": "VEC3",
             "min": p.min(0).tolist(), "max": p.max(0).tolist()},
            {"bufferView": 1, "componentType": 5125, "count": int(np.size(f)), "type": "SCALAR"},
        ],
    }
    j = json.dumps(doc).encode()
    j += b" " * (-len(j) % 4)
    b = pos + idx
    b += b"\0" * (-len(b) % 4)
    with open(path, "wb") as out:
        out.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(j) + 8 + len(b)))
        out.write(struct.pack("<I4s", len(j), b"JSON") + j)
        out.write(struct.pack("<I4s", len(b), b"BIN\0") + b)


if __name__ == "__main__":
    # A quick self-check: a plinth and a ball, written three ways.
    m = merge(cylinder(r=20, h=8), sphere(r=12, center=(0, 0, 20)))
    write_stl("mesh_kit_demo.stl", *m)
    write_obj("mesh_kit_demo.obj", *m)
    write_glb("mesh_kit_demo.glb", *m)
    print("wrote mesh_kit_demo.stl, .obj and .glb")
