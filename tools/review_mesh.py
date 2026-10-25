# SPDX-License-Identifier: AGPL-3.0-only
"""Checks a 3D model for the faults that sink a print or a viewing model, and draws a turntable sheet to look at.

    python review_mesh.py SPEC.json

SPEC is {"path": str, "sheet": str or null, "print": bool, "size_mm": [x, y, z] or null, "bed_mm": [x, y, z] or
null, "max_triangles": int or null, "up": "z" or "y" or null}, and for a print, optionally:

    "fits":      [{"a": part, "b": part, "kind": "press"|"snug"|"slide"|"free"}], how named parts mate
    "clearance": {"press": mm, ...}, this printer's clearance per side for each fit
    "views":     [{"name": "front", "look": "+y", "up": "+z", "outline": [[u, v], ...] in mm, "tolerance_mm": 1}],
                 the object's outline as photographed, for the likeness check
    "export_dir": a folder to write the model into as binary STL, one file per part, each standing on the bed
    "print_pose": {part: [rx, ry, rz]}, degrees from the assembled pose to the pose each part prints in

Prints one JSON object: {"ok": true, "kind": "mesh", "info": {...}, "checks": [...]}, where each check is {"id",
"status": "pass"|"warn"|"fail", "value", "limit", "detail"}; or {"ok": false, "error": msg}.

Parts are the named objects of a GLB or glTF (nodes), an OBJ (`o` or `g`) or an ASCII STL (`solid`). For a print with
more than one, every two parts that come within 2 mm are measured: one poking into the other is interference, and a
declared fit is held to its clearance. The parts, fits and likeness checks follow print3d by mfranzon
(https://github.com/mfranzon/print3d, MIT; see THIRD_PARTY_NOTICES.md).

It reads STL (binary or ASCII), OBJ, PLY (ASCII or binary) and GLB or glTF with embedded buffers. It only reads
geometry: it never runs a script, opens another file a model points to, or decodes compressed (Draco) meshes, so it is
safe on a model that came from anywhere. The sheet is eight views around the model and one from above, shaded as grey
clay with back faces in magenta (a hole or a flipped face shows as a magenta patch), and a row of black silhouettes,
the way a sculptor checks the contour from every side. Uses numpy and Pillow.
"""

import base64
import json
import math
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw

MAX_BYTES = 512 * 1024 * 1024
MAX_TRIANGLES = 5_000_000
VIEW = 360  # pixels per view, square
POINTS_MIN, POINTS_MAX = 200_000, 3_000_000  # surface samples for the views
DEFAULT_BED = (256.0, 256.0, 256.0)


def check(cid, status, value, limit, detail):
    return {"id": cid, "status": status, "value": value, "limit": limit, "detail": detail}


# ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────


def read_stl(data):
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + n * 50 == len(data):
            rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]),
                                count=n, offset=84)
            return rec["v"].astype(np.float64).reshape(-1, 3), np.arange(n * 3).reshape(-1, 3), None, None
    text = data.decode("ascii", errors="replace")
    if not text.lstrip().lower().startswith("solid"):
        raise ValueError("This STL is neither binary nor ASCII STL.")
    verts, labels, names, part = [], [], [], 0
    for line in text.splitlines():
        t = line.strip()
        low = t.lower()
        if low.startswith("solid"):
            name = t[5:].strip() or f"part {len(names) + 1}"
            names.append(name)
            part = len(names) - 1
        elif low.startswith("vertex"):
            verts.append(t.split()[1:4])
            if len(verts) % 3 == 0:
                labels.append(part)
    if len(verts) % 3:
        raise ValueError("This ASCII STL has a facet without three vertices.")
    v = np.array(verts, dtype=np.float64).reshape(-1, 3)
    return v, np.arange(len(v)).reshape(-1, 3), np.array(labels, dtype=np.int64), names or ["model"]


def read_obj(data):
    verts, faces, labels, names, part = [], [], [], [], None
    for line in data.decode("utf-8", errors="replace").splitlines():
        if line.startswith("v "):
            verts.append(line.split()[1:4])
        elif line.startswith(("o ", "g ")):
            name = line[2:].strip() or f"part {len(names) + 1}"
            if name not in names:
                names.append(name)
            part = names.index(name)
        elif line.startswith("f "):
            idx = []
            for tok in line.split()[1:]:
                i = int(tok.split("/")[0])
                idx.append(i - 1 if i > 0 else len(verts) + i)
            if part is None:
                names.append("model")
                part = 0
            for k in range(1, len(idx) - 1):  # a polygon becomes a fan of triangles
                faces.append((idx[0], idx[k], idx[k + 1]))
                labels.append(part)
    if not verts:
        raise ValueError("This OBJ has no vertices.")
    v = np.array(verts, dtype=np.float64)
    f = np.array(faces, dtype=np.int64).reshape(-1, 3)
    if len(f) and (f.min() < 0 or f.max() >= len(v)):
        raise ValueError("This OBJ has a face that names a vertex it doesn't have.")
    return v, f, np.array(labels, dtype=np.int64), names or ["model"]


PLY_TYPES = {"char": "i1", "uchar": "u1", "short": "i2", "ushort": "u2", "int": "i4", "uint": "u4",
             "float": "f4", "double": "f8", "int8": "i1", "uint8": "u1", "int16": "i2", "uint16": "u2",
             "int32": "i4", "uint32": "u4", "float32": "f4", "float64": "f8"}


def read_ply(data):
    end = data.find(b"end_header")
    if not data.startswith(b"ply") or end < 0:
        raise ValueError("This isn't a PLY file.")
    body_at = data.index(b"\n", end) + 1
    header = data[:end].decode("ascii", errors="replace").splitlines()
    fmt, elements = "ascii", []
    for line in header:
        p = line.split()
        if not p:
            continue
        if p[0] == "format":
            fmt = p[1]
        elif p[0] == "element":
            elements.append({"name": p[1], "count": int(p[2]), "props": []})
        elif p[0] == "property" and elements:
            elements[-1]["props"].append(p[1:])
    if fmt not in ("ascii", "binary_little_endian", "binary_big_endian"):
        raise ValueError(f"PLY format {fmt} isn't supported.")
    verts, faces = None, []
    if fmt == "ascii":
        rows = data[body_at:].decode("ascii", errors="replace").split("\n")
        at = 0
        for el in elements:
            lines = rows[at : at + el["count"]]
            at += el["count"]
            if el["name"] == "vertex":
                names = [pr[-1] for pr in el["props"]]
                xi, yi, zi = names.index("x"), names.index("y"), names.index("z")
                arr = np.array([ln.split() for ln in lines], dtype=np.float64)
                verts = arr[:, [xi, yi, zi]]
            elif el["name"] == "face":
                for ln in lines:
                    vals = [int(x) for x in ln.split()]
                    n = vals[0]
                    idx = vals[1 : 1 + n]
                    faces.extend((idx[0], idx[k], idx[k + 1]) for k in range(1, n - 1))
    else:
        order = "<" if fmt == "binary_little_endian" else ">"
        at = body_at
        for el in elements:
            if all(pr[0] != "list" for pr in el["props"]):
                dt = np.dtype([(pr[-1], order + PLY_TYPES[pr[0]]) for pr in el["props"]])
                arr = np.frombuffer(data, dtype=dt, count=el["count"], offset=at)
                at += dt.itemsize * el["count"]
                if el["name"] == "vertex":
                    verts = np.stack([arr["x"], arr["y"], arr["z"]], axis=1).astype(np.float64)
                continue
            if el["name"] != "face" or len(el["props"]) != 1:
                raise ValueError("This PLY has list properties Hildegard doesn't read.")
            _, count_t, item_t, _ = el["props"][0]
            ct, it = np.dtype(order + PLY_TYPES[count_t]), np.dtype(order + PLY_TYPES[item_t])
            for _ in range(el["count"]):
                n = int(np.frombuffer(data, dtype=ct, count=1, offset=at)[0])
                at += ct.itemsize
                idx = np.frombuffer(data, dtype=it, count=n, offset=at).astype(np.int64)
                at += it.itemsize * n
                faces.extend((idx[0], idx[k], idx[k + 1]) for k in range(1, n - 1))
    if verts is None:
        raise ValueError("This PLY has no vertices.")
    f = np.array(faces, dtype=np.int64).reshape(-1, 3)
    if len(f) and (f.min() < 0 or f.max() >= len(verts)):
        raise ValueError("This PLY has a face that names a vertex it doesn't have.")
    return verts, f, None, None


GL_TYPES = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
GL_SIZES = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def node_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    t = np.eye(4)
    t[:3, 3] = node.get("translation", [0, 0, 0])
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    r = np.eye(4)
    r[:3, :3] = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    s = np.diag([*node.get("scale", [1, 1, 1]), 1.0])
    return t @ r @ s


def read_gltf(doc, bins):
    if any("KHR_draco_mesh_compression" in e or "EXT_meshopt_compression" in e
           for e in doc.get("extensionsUsed", [])):
        raise ValueError("This model's meshes are compressed (Draco or meshopt). Export it without compression.")
    views = doc.get("bufferViews", [])

    def accessor(i):
        a = doc["accessors"][i]
        if "sparse" in a or "bufferView" not in a:
            raise ValueError("This model uses sparse accessors, which Hildegard doesn't read.")
        bv = views[a["bufferView"]]
        buf = bins[bv.get("buffer", 0)]
        dt = np.dtype(GL_TYPES[a["componentType"]])
        k = GL_SIZES[a["type"]]
        stride = bv.get("byteStride", 0) or dt.itemsize * k
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        n = a["count"]
        if start + stride * (n - 1) + dt.itemsize * k > len(buf):
            raise ValueError("This model's data runs past the end of its buffer.")
        raw = np.lib.stride_tricks.as_strided(
            np.frombuffer(buf, dtype=np.uint8, offset=start), shape=(n, dt.itemsize * k), strides=(stride, 1)
        )
        return np.ascontiguousarray(raw).view(dt).reshape(n, k).astype(np.float64 if dt.kind == "f" else np.int64)

    verts, faces, labels, names, count = [], [], [], [], 0
    nodes = doc.get("nodes", [])
    scene = doc.get("scenes", [{}])[doc.get("scene", 0)] if doc.get("scenes") else {"nodes": list(range(len(nodes)))}
    stack = [(i, np.eye(4)) for i in scene.get("nodes", [])]
    seen = 0
    while stack:
        i, parent = stack.pop()
        seen += 1
        if seen > 100_000:
            raise ValueError("This model's scene graph loops.")
        node = nodes[i]
        m = parent @ node_matrix(node)
        stack.extend((c, m) for c in node.get("children", []))
        if "mesh" not in node:
            continue
        for prim in doc["meshes"][node["mesh"]].get("primitives", []):
            if prim.get("mode", 4) != 4 or "POSITION" not in prim.get("attributes", {}):
                continue  # points and lines have no surface
            p = accessor(prim["attributes"]["POSITION"])[:, :3]
            p = (np.c_[p, np.ones(len(p))] @ m.T)[:, :3]
            idx = accessor(prim["indices"]).ravel() if "indices" in prim else np.arange(len(p))
            if len(idx) % 3 or (len(idx) and idx.max() >= len(p)):
                raise ValueError("This model has a triangle list that doesn't fit its vertices.")
            verts.append(p)
            faces.append(idx.reshape(-1, 3) + count)
            count += len(p)
            name = str(node.get("name") or doc["meshes"][node["mesh"]].get("name") or f"part {i + 1}")[:60]
            if name not in names:
                names.append(name)
            labels.append(np.full(len(idx) // 3, names.index(name), dtype=np.int64))
    if not verts:
        raise ValueError("This model has no triangle meshes in its scene.")
    return np.concatenate(verts), np.concatenate(faces), np.concatenate(labels), names


def read_glb(data):
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError("This isn't a glTF 2 binary (GLB).")
    at, doc, bins = 12, None, []
    while at + 8 <= min(length, len(data)):
        size, kind = struct.unpack_from("<I4s", data, at)
        chunk = data[at + 8 : at + 8 + size]
        if kind == b"JSON":
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == b"BIN\x00":
            bins.append(chunk)
        at += 8 + size
    if doc is None:
        raise ValueError("This GLB has no JSON chunk.")
    for b in doc.get("buffers", [])[len(bins):]:
        bins.append(data_uri(b))
    return read_gltf(doc, bins)


def data_uri(buffer):
    uri = buffer.get("uri", "")
    if not uri.startswith("data:"):
        # A model that points at another file is not read: the file it names might be anything on this computer.
        raise ValueError("This glTF points to a separate .bin file. Send it as one GLB instead.")
    return base64.b64decode(uri.split(",", 1)[1])


def read_model(path):
    with open(path, "rb") as f:
        data = f.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Models up to 512 MB.")
    ext = path.lower().rsplit(".", 1)[-1]
    if ext == "stl":
        v, f, labels, names = read_stl(data)
    elif ext == "obj":
        v, f, labels, names = read_obj(data)
    elif ext == "ply":
        v, f, labels, names = read_ply(data)
    elif ext == "glb":
        v, f, labels, names = read_glb(data)
    elif ext == "gltf":
        doc = json.loads(data.decode("utf-8"))
        v, f, labels, names = read_gltf(doc, [data_uri(b) for b in doc.get("buffers", [])])
    else:
        raise ValueError("Send a model as GLB, glTF, STL, OBJ or PLY.")
    if len(f) == 0:
        raise ValueError("This model has no triangles.")
    if len(f) > MAX_TRIANGLES:
        raise ValueError(f"This model has {len(f)} triangles; Hildegard checks models up to {MAX_TRIANGLES}.")
    if not np.all(np.isfinite(v)):
        raise ValueError("This model has vertices that aren't numbers (NaN or infinite).")
    if labels is None or len(labels) != len(f):
        labels, names = np.zeros(len(f), dtype=np.int64), ["model"]
    return ext, v, f.astype(np.int64), labels, names


# ── Measuring ────────────────────────────────────────────────────────────────────────────────────────────────────


def weld(v, f):
    """Merges vertices at the same place, so triangles that touch share their corners (STL never shares them)."""
    span = float(np.max(v.max(0) - v.min(0))) or 1.0
    q = np.round((v - v.min(0)) / (span * 1e-6)).astype(np.int64)
    _, first, inverse = np.unique(q, axis=0, return_index=True, return_inverse=True)
    return v[first], inverse.ravel()[f]


def components(n_verts, f):
    """Connected bodies: union-find over the triangles' corners."""
    parent = np.arange(n_verts)

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, c in f:
        ra, rb, rc = root(a), root(b), root(c)
        parent[rb] = ra
        parent[root(rc)] = ra
    roots = np.array([root(x) for x in range(n_verts)])
    return roots[f[:, 0]]


def up_axis(fmt, spec):
    """glTF is Y-up by its specification, STL and PLY are almost always Z-up, and OBJ follows what it is for."""
    if spec.get("up"):
        return spec["up"].lower()
    if fmt in ("glb", "gltf"):
        return "y"
    if fmt == "obj" and not spec.get("print"):
        return "y"
    return "z"


def measure(v, f, spec, fmt="stl", labels=None, names=None):
    up = up_axis(fmt, spec)
    if up == "y":  # Y-up (glTF): turn so Z is up for every measurement and view
        v = v[:, [0, 2, 1]] * np.array([1, -1, 1])
    if labels is None:
        labels, names = np.zeros(len(f), dtype=np.int64), ["model"]
    v, f = weld(v, f)
    tri = v[f]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area2 = np.linalg.norm(cross, axis=1)
    area = area2 / 2
    total_area = float(area.sum())
    span = float(np.max(v.max(0) - v.min(0))) or 1.0
    degenerate = area2 <= (span * 1e-7) ** 2

    # Edges: each undirected edge should belong to exactly two triangles, once in each direction.
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e = e[~np.repeat(degenerate[None, :], 3, axis=0).ravel()]
    key = np.sort(e, axis=1)
    uniq, inv, counts = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    boundary = int(np.sum(counts == 1))
    nonmanifold = int(np.sum(counts > 2))
    forward = (e[:, 0] < e[:, 1]).astype(np.int64)
    fwd = np.bincount(inv.ravel(), weights=forward, minlength=len(uniq))
    two = counts == 2
    flipped = int(np.sum(two & (fwd != 1)))

    volume = float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6)
    body = components(len(v), f)
    labels_b, body_area = np.unique(body, return_inverse=True)
    per_body = np.bincount(body_area, weights=area)
    debris = int(np.sum(per_body < total_area * 0.001))

    unit = np.where(area2[:, None] > 0, cross / np.maximum(area2[:, None], 1e-30), 0)
    lo, hi = v.min(0), v.max(0)
    size = hi - lo
    centroid = tri.mean(1)
    return {
        "v": v, "f": f, "tri": tri, "area": area, "normals": unit, "total_area": total_area,
        "degenerate": int(degenerate.sum()), "boundary": boundary, "nonmanifold": nonmanifold, "flipped": flipped,
        "volume": volume, "bodies": len(labels_b), "debris": debris, "lo": lo, "hi": hi, "size": size,
        "centroid": centroid, "labels": labels, "names": names or ["model"],
    }


def mesh_checks(m, spec):
    out = []
    printing = bool(spec.get("print"))
    n = len(m["f"])
    cap = spec.get("max_triangles")
    out.append(check("triangles", "warn" if cap and n > cap else "pass", n, cap,
                     "Triangle count. Past the limit the model is heavier than it needs to be for where it's going; "
                     "decimate it or move fine detail into a normal map."))
    share = m["degenerate"] / n
    out.append(check("degenerate", "fail" if share > 0.05 else "warn" if share > 0.001 else "pass",
                     round(share, 4), 0.001,
                     "Share of triangles with no area. They break booleans and slicers; merge by distance or remesh."))
    sev = "fail" if printing else "warn"
    out.append(check("watertight", sev if m["boundary"] else "pass", m["boundary"], 0,
                     "Open edges, belonging to one triangle only: holes in the surface. A print needs none; fill them "
                     "or remesh. They show magenta inside the views."))
    out.append(check("manifold", sev if m["nonmanifold"] else "pass", m["nonmanifold"], 0,
                     "Edges shared by more than two triangles: surfaces that pass through each other or touch at an "
                     "edge. Union the parts or remesh."))
    out.append(check("winding", sev if m["flipped"] else "pass", m["flipped"], 0,
                     "Edges whose two triangles face opposite ways: flipped faces. Recalculate normals outside."))
    closed = m["boundary"] == 0 and m["nonmanifold"] == 0
    if closed:
        out.append(check("volume", "fail" if m["volume"] <= 0 else "pass", round(m["volume"], 3), "> 0",
                         "Enclosed volume. Zero or negative means the whole model is inside out."))
    parts = len(m["names"])
    out.append(check("bodies", "warn" if printing and m["bodies"] > parts else "pass", m["bodies"],
                     parts if printing else None,
                     "Separate pieces. Fine if the parts are meant to be separate (name each part: a node in GLB, `o "
                     "name` in OBJ); otherwise they'll print loose."))
    out.append(check("debris", "warn" if m["debris"] else "pass", m["debris"], 0,
                     "Tiny loose pieces (under 0.1% of the surface each): leftovers from booleans or a scan. Delete them."))

    size = [round(float(s), 3) for s in m["size"]]
    want = spec.get("size_mm")
    if want:
        got = sorted(size, reverse=True)
        target = sorted((float(x) for x in want), reverse=True)
        off = max(abs(g - t) / t for g, t in zip(got, target) if t > 0)
        out.append(check("size", "fail" if off > 0.15 else "warn" if off > 0.05 else "pass", size, list(want),
                         f"Bounding box against the size asked for; the worst axis is {off:.0%} off. Scale the model "
                         "or change the brief."))
    if printing:
        biggest = max(size)
        out.append(check("units", "warn" if biggest < 5 or biggest > 2000 else "pass", biggest, [5, 2000],
                         "Largest dimension, read as millimetres. Under 5 or over 2000 usually means the model was made "
                         "in metres or centimetres; scale it to millimetres."))
        bed = [float(x) for x in (spec.get("bed_mm") or DEFAULT_BED)]
        fits = all(s <= b for s, b in zip(sorted(size), sorted(bed)))
        out.append(check("bed", "pass" if fits else "fail", size, bed,
                         "Whether the model fits the printer's build volume in some orientation. Split it or scale it."))
        normals, area, cen = m["normals"], m["area"], m["centroid"]
        floor = m["lo"][2]
        tol = max(0.2, float(m["size"][2]) * 0.002)
        base_faces = (normals[:, 2] < -0.99) & (cen[:, 2] < floor + tol)
        base_area = float(area[base_faces].sum())
        footprint = float(m["size"][0] * m["size"][1]) or 1.0
        out.append(check("base", "warn" if base_area < footprint * 0.02 else "pass", round(base_area, 2),
                         round(footprint * 0.02, 2),
                         "Flat area touching the bed, in square millimetres. Too little and the print tips or "
                         "lifts; flatten a base or plan a brim and supports."))
        over = (normals[:, 2] < -math.cos(math.radians(45))) & ~base_faces
        share = float(area[over].sum()) / (m["total_area"] or 1)
        out.append(check("overhang", "warn" if share > 0.1 else "pass", round(share, 3), 0.1,
                         "Share of the surface facing down steeper than 45°. Over the limit needs supports; reorient or "
                         "chamfer the undersides."))
        foot = float(min(m["size"][0], m["size"][1])) or 1e-6
        aspect = float(m["size"][2]) / foot
        out.append(check("slender", "warn" if aspect > 4 and parts == 1 else "pass", round(aspect, 2), 4,
                         "Height over the narrowest side of the footprint. A tall, narrow part can be knocked off the "
                         "bed by the nozzle: widen the base, add a foot or a brim, or lay it down."))
        if closed and m["volume"] > 0 and base_area > 0:
            tri = m["tri"]
            w = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2]))
            com = (tri.sum(1) * w[:, None]).sum(0) / (4 * w.sum())
            bx = cen[base_faces]
            inside = bx[:, 0].min() <= com[0] <= bx[:, 0].max() and bx[:, 1].min() <= com[1] <= bx[:, 1].max()
            out.append(check("balance", "pass" if inside else "warn", [round(float(c), 2) for c in com[:2]],
                             "over the base",
                             "Whether the centre of mass sits over the base. If not, the model tips over off the bed."))
    return out


# ── Parts and fits ───────────────────────────────────────────────────────────────────────────────────────────────

# Per side, in millimetres: the usual starting points for a 0.4 mm nozzle in PLA, until the printer is calibrated.
CLEARANCE = {"press": 0.05, "snug": 0.10, "slide": 0.20, "free": 0.35}
NEAR_MM = 2.0  # parts closer than this are measured against each other
CONTACT_MM = 0.005
INTERFERE_MM = 0.02
TIGHTER_BY, LOOSER_BY = 0.04, 0.10
CHUNK = 400_000  # point-triangle pairs per step, to bound memory


def closest(p, tri):
    """Distance from each point to the nearest of the triangles (Ericson's regions, vectorised)."""
    best = np.full(len(p), np.inf)
    step = max(1, CHUNK // max(1, len(tri)))
    a, b, c = tri[None, :, 0], tri[None, :, 1], tri[None, :, 2]
    ab, ac, bc = b - a, c - a, c - b
    for i in range(0, len(p), step):
        q = p[i : i + step, None, :]
        ap, bp, cp = q - a, q - b, q - c
        d1, d2 = (ab * ap).sum(-1), (ac * ap).sum(-1)
        d3, d4 = (ab * bp).sum(-1), (ac * bp).sum(-1)
        d5, d6 = (ab * cp).sum(-1), (ac * cp).sum(-1)
        va, vb, vc = d3 * d6 - d5 * d4, d5 * d2 - d1 * d6, d1 * d4 - d3 * d2
        with np.errstate(divide="ignore", invalid="ignore"):
            den = 1.0 / (va + vb + vc)
            x = a + ab * (vb * den)[..., None] + ac * (vc * den)[..., None]
            t = (d4 - d3) / ((d4 - d3) + (d5 - d6))
            x = np.where(((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0))[..., None], b + bc * t[..., None], x)
            t = d2 / (d2 - d6)
            x = np.where(((vb <= 0) & (d2 >= 0) & (d6 <= 0))[..., None], a + ac * t[..., None], x)
            x = np.where(((d6 >= 0) & (d5 <= d6))[..., None], c + 0 * x, x)
            t = d1 / (d1 - d3)
            x = np.where(((vc <= 0) & (d1 >= 0) & (d3 <= 0))[..., None], a + ab * t[..., None], x)
            x = np.where(((d3 >= 0) & (d4 <= d3))[..., None], b + 0 * x, x)
            x = np.where(((d1 <= 0) & (d2 <= 0))[..., None], a + 0 * x, x)
        dist = np.linalg.norm(q - x, axis=-1)
        dist = np.where(np.isfinite(dist), dist, np.inf)
        best[i : i + step] = dist.min(1)
    return best


def inside(p, tri):
    """Whether each point is inside the closed surface, by its winding number (solid angles summed)."""
    total = np.zeros(len(p))
    step = max(1, CHUNK // max(1, len(tri)))
    for i in range(0, len(p), step):
        q = p[i : i + step, None, :]
        a, b, c = tri[None, :, 0] - q, tri[None, :, 1] - q, tri[None, :, 2] - q
        la, lb, lc = (np.linalg.norm(x, axis=-1) for x in (a, b, c))
        num = (a * np.cross(b, c)).sum(-1)
        den = la * lb * lc + (a * b).sum(-1) * lc + (b * c).sum(-1) * la + (c * a).sum(-1) * lb
        total[i : i + step] = (2 * np.arctan2(num, den)).sum(1)
    return np.abs(total) / (4 * math.pi) > 0.5


def part_mesh(m, k):
    f = m["f"][m["labels"] == k]
    return m["v"], f, m["v"][f]


def probe(m, k, box_lo, box_hi, limit=2500):
    """Points on part k to measure from: its vertices, and points spread over its surface, inside a box."""
    v, f, tri = part_mesh(m, k)
    used = np.unique(f)
    pts = v[used]
    rng = np.random.default_rng(11)
    area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    if area.sum() > 0:
        n = min(limit, max(200, len(tri)))
        pick = rng.choice(len(tri), size=n, p=area / area.sum())
        r1, r2 = rng.random(n), rng.random(n)
        sq = np.sqrt(r1)
        t = tri[pick]
        pts = np.concatenate([pts, t[:, 0] * (1 - sq)[:, None] + t[:, 1] * (sq * (1 - r2))[:, None]
                              + t[:, 2] * (sq * r2)[:, None]])
    keep = np.all((pts >= box_lo) & (pts <= box_hi), axis=1)
    pts = pts[keep]
    if len(pts) > limit * 2:
        pts = pts[rng.choice(len(pts), size=limit * 2, replace=False)]
    return pts


def measure_pair(m, i, j):
    """Interference and clearance between parts i and j, as modelled together; None if they're never near."""
    _, _, ti = part_mesh(m, i)
    _, _, tj = part_mesh(m, j)
    lo = np.maximum(ti.reshape(-1, 3).min(0), tj.reshape(-1, 3).min(0)) - NEAR_MM
    hi = np.minimum(ti.reshape(-1, 3).max(0), tj.reshape(-1, 3).max(0)) + NEAR_MM
    if np.any(lo > hi):
        return None
    depth, gaps, contact = 0.0, [], False
    for a, tb in ((i, tj), (j, ti)):
        pts = probe(m, a, lo, hi)
        if not len(pts):
            continue
        near_tri = tb[np.all((tb.max(1) >= lo) & (tb.min(1) <= hi), axis=1)]
        if not len(near_tri):
            continue
        d = closest(pts, near_tri)
        close = d < NEAR_MM
        if not close.any():
            continue
        within = np.zeros(len(pts), dtype=bool)
        within[close] = inside(pts[close], tb)
        if (within & (d > INTERFERE_MM)).any():
            depth = max(depth, float(d[within].max()))
        contact = contact or bool((d < CONTACT_MM).any() or (within & (d <= INTERFERE_MM)).any())
        out = close & ~within & (d >= CONTACT_MM)
        if out.any():
            gaps.append(float(d[out].min()))
    if not depth and not gaps and not contact:
        return None
    return {"a": m["names"][i], "b": m["names"][j], "interference_mm": round(depth, 3),
            "clearance_mm": round(min(gaps), 3) if gaps else None, "contact": contact}


def fit_checks(m, spec):
    names = m["names"]
    clearance = {**CLEARANCE, **{k: float(v) for k, v in (spec.get("clearance") or {}).items() if k in CLEARANCE}}
    declared = [x for x in spec.get("fits") or [] if x.get("kind") in CLEARANCE]
    unknown = sorted({n for x in declared for n in (x.get("a"), x.get("b")) if n not in names})
    pairs = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            r = measure_pair(m, i, j)
            if r:
                pairs.append(r)
    out, bad, odd = [], [], []
    for p in pairs:
        kind = next((x["kind"] for x in declared if {x["a"], x["b"]} == {p["a"], p["b"]}), None)
        gap = p["clearance_mm"]
        p["declared"] = kind
        if p["interference_mm"] > 0:
            p["verdict"] = "interference"
            bad.append(f"{p['a']} and {p['b']} overlap by {p['interference_mm']:.2f} mm")
        elif kind is None:
            p["verdict"] = ("fused" if gap is not None and not p["contact"] and gap < clearance["press"] - TIGHTER_BY / 2
                            else "clear")
            if p["verdict"] == "fused":
                odd.append(f"{p['a']} and {p['b']} are {gap:.2f} mm apart: too close to print apart, too far to touch")
        elif gap is None:
            p["verdict"] = "unmeasured"
            odd.append(f"{p['a']} and {p['b']} are declared a {kind} fit but no gap separates them")
        elif gap < clearance[kind] - TIGHTER_BY:
            p["verdict"] = "tight"
            odd.append(f"{p['a']} and {p['b']}: {gap:.2f} mm per side is tighter than {kind} ({clearance[kind]:.2f})")
        elif gap > clearance[kind] + LOOSER_BY:
            p["verdict"] = "loose"
            odd.append(f"{p['a']} and {p['b']}: {gap:.2f} mm per side is looser than {kind} ({clearance[kind]:.2f})")
        else:
            p["verdict"] = "ok"
    for x in declared:
        if x["a"] in names and x["b"] in names and not any({x["a"], x["b"]} == {p["a"], p["b"]} for p in pairs):
            odd.append(f"{x['a']} and {x['b']} are declared a {x['kind']} fit but never come within {NEAR_MM:g} mm")
    if unknown:
        odd.append(f"fits name parts the model doesn't have: {', '.join(unknown)} (its parts: {', '.join(names)})")
    out.append(check("interference", "fail" if bad else "pass", bad, [],
                     "Parts that poke into each other as assembled: they won't go together. Cut one back by this "
                     "printer's clearance for the fit (the clearance target)."))
    out.append(check("fits", "warn" if odd else "pass", odd, clearance,
                     "Declared fits measured against this printer's clearance per side, and parts so close they'd "
                     "fuse. Size every mating feature from the clearance, never a guessed number."))
    return out, pairs


# ── Likeness to a photograph ─────────────────────────────────────────────────────────────────────────────────────

AXES = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0), "-y": (0, -1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}
WORK = 360
TILTS = [0.0] + [sgn * k / 2 for k in range(1, 9) for sgn in (1, -1)]


def axis_name(v):
    i = int(np.argmax(np.abs(v)))
    return ("+" if v[i] > 0 else "-") + "xyz"[i]


def rasterise(polys, lo, cell, size):
    img = Image.new("L", size, 0)
    d = ImageDraw.Draw(img)
    for poly in polys:
        d.polygon([((u - lo[0]) / cell, size[1] - (v - lo[1]) / cell) for u, v in poly], fill=255)
    return img


def fill_holes(img):
    pad = Image.new("L", (img.width + 2, img.height + 2), 0)
    pad.paste(img, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    return pad.point(lambda x: 0 if x == 128 else 255).crop((1, 1, img.width + 1, img.height + 1))


def iou(a, b):
    x, y = np.asarray(a) > 127, np.asarray(b) > 127
    union = np.logical_or(x, y).sum()
    return float(np.logical_and(x, y).sum() / union) if union else 0.0


def likeness(m, view):
    """The model's silhouette along a photographed view, against the outline traced on the photograph."""
    look, up = np.array(AXES[view.get("look", "+y")], float), np.array(AXES[view.get("up", "+z")], float)
    if abs(look @ up) > 0.5:
        raise ValueError(f"The {view.get('name', 'view')} view's look and up are the same axis.")
    right = np.cross(look, up)
    outline = np.array(view["outline"], dtype=float)
    if len(outline) < 3:
        raise ValueError(f"The {view.get('name', 'view')} outline needs at least three points.")
    tri = m["tri"]
    flat = np.stack([tri @ right, tri @ up], axis=-1)
    span = max(np.ptp(flat.reshape(-1, 2), 0).max(), np.ptp(outline, 0).max()) * 1.25
    cell = span / WORK
    size = (WORK, WORK)

    def centred(points):
        c = (points.reshape(-1, 2).min(0) + points.reshape(-1, 2).max(0)) / 2
        return points - c

    model_flat = centred(flat)
    model = fill_holes(rasterise(model_flat, np.array([-span / 2, -span / 2]), cell, size))
    model_mm = np.ptp(flat.reshape(-1, 2), 0)

    def outline_img(deg):
        r = math.radians(deg)
        rot = np.array([[math.cos(r), -math.sin(r)], [math.sin(r), math.cos(r)]])
        o = centred(outline @ rot.T)
        return rasterise([o], np.array([-span / 2, -span / 2]), cell, size), np.ptp(o, 0)

    bbox = model.getbbox() or (0, 0, 1, 1)

    def stretched(photo):
        """The model stretched onto the photo outline's box: shape alone, whatever the size."""
        pbox = photo.getbbox() or (0, 0, 1, 1)
        out = Image.new("L", size, 0)
        out.paste(model.crop(bbox).resize((max(1, pbox[2] - pbox[0]), max(1, pbox[3] - pbox[1]))), pbox[:2])
        return out

    # Photos are rarely level. Level the outline by shape alone, so a wrong size can't pick the tilt.
    tilt = max(TILTS, key=lambda t: iou(outline_img(t)[0], stretched(outline_img(t)[0])))
    photo, photo_mm = outline_img(tilt)
    score = iou(photo, model)
    # The other seven ways the same silhouette could be turned or mirrored, with the camera axes that make each.
    poses = []
    for flip in (False, True):
        img = model.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if flip else model
        r_ax, u_ax = (-right if flip else right), up
        for _ in range(4):
            # Turning the picture a quarter counter-clockwise puts what was on the right at the top.
            poses.append((iou(photo, img), r_ax, u_ax))
            img, r_ax, u_ax = img.transpose(Image.Transpose.ROTATE_90), -u_ax, r_ax
    best = max(poses, key=lambda p: p[0])
    tol = float(view.get("tolerance_mm") or 1.0)
    result = {"view": view.get("name", "view"), "iou": round(score, 3), "shape_iou": round(iou(photo, stretched(photo)), 3),
              "photo_mm": [round(float(x), 2) for x in photo_mm], "model_mm": [round(float(x), 2) for x in model_mm],
              "tolerance_mm": tol, "tilt_deg": tilt}
    if best[0] > score + 0.05:
        result["better_pose"] = {"look": axis_name(np.cross(best[2], best[1])), "up": axis_name(best[2]),
                                 "iou": round(best[0], 3)}
    return result, photo, model


def likeness_checks(m, views):
    results, panels = [], []
    for view in views:
        r, photo, model = likeness(m, view)
        results.append(r)
        panels.append((r, photo, model))
    notes, worst = [], "pass"
    for r in results:
        off = [f"{ax} {mo:.1f} mm against {ph:.1f} ± {r['tolerance_mm']:.1f}"
               for ax, mo, ph in zip(("width", "height"), r["model_mm"], r["photo_mm"]) if abs(mo - ph) > r["tolerance_mm"]]
        if "better_pose" in r:
            sev = "fail"
            notes.append(f"{r['view']}: matches {r['better_pose']['iou']:.0%} seen with look={r['better_pose']['look']} "
                         f"up={r['better_pose']['up']}; turn the part, or fix the view's axes")
        elif off and r["shape_iou"] >= 0.9:
            sev = "fail"
            notes.append(f"{r['view']}: the shape is right, the size isn't: {'; '.join(off)}")
        elif r["iou"] < 0.8 or off:
            sev = "fail"
            notes.append(f"{r['view']}: covers the outline {r['iou']:.0%}; red on the sheet is in the photo and "
                         f"missing from the model, blue is model the photo doesn't show" + (f"; {'; '.join(off)}" if off else ""))
        elif r["iou"] < 0.9:
            sev = "warn"
            notes.append(f"{r['view']}: close ({r['iou']:.0%}); look where the outlines part on the sheet")
        else:
            sev = "pass"
        worst = max(worst, sev, key=["pass", "warn", "fail"].index)
    return check("likeness", worst, {r["view"]: r["iou"] for r in results}, 0.9,
                 "How the model's silhouette matches the object's outline in each photographed view, at true size "
                 "(1 is a perfect match). " + ("; ".join(notes) if notes else "Every view matches.")), results, panels


# ── Writing the print files ──────────────────────────────────────────────────────────────────────────────────────


def rotation(deg):
    rx, ry, rz = (math.radians(float(d)) for d in deg)
    x = np.array([[1, 0, 0], [0, math.cos(rx), -math.sin(rx)], [0, math.sin(rx), math.cos(rx)]])
    y = np.array([[math.cos(ry), 0, math.sin(ry)], [0, 1, 0], [-math.sin(ry), 0, math.cos(ry)]])
    z = np.array([[math.cos(rz), -math.sin(rz), 0], [math.sin(rz), math.cos(rz), 0], [0, 0, 1]])
    return z @ y @ x


def export_parts(m, folder, pose):
    """Each part as a binary STL, turned to its print pose and standing on the bed. Returns the file names."""
    import os

    os.makedirs(folder, exist_ok=True)
    files = []
    for k, name in enumerate(m["names"]):
        tri = m["tri"][m["labels"] == k]
        if not len(tri):
            continue
        if name in (pose or {}):
            tri = tri @ rotation(pose[name]).T
        tri = tri - np.array([*(tri.reshape(-1, 3).min(0)[:2] + tri.reshape(-1, 3).max(0)[:2]) / 2,
                              tri.reshape(-1, 3).min(0)[2]])
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        rec = np.zeros(len(tri), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
        rec["n"], rec["v"] = n, tri
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in name).strip("-") or f"part-{k + 1}"
        file = f"{k + 1:02d}-{safe[:40]}.stl"
        with open(os.path.join(folder, file), "wb") as out:
            out.write(b"Hildegard".ljust(80, b" ") + struct.pack("<I", len(tri)) + rec.tobytes())
        files.append(file)
    return files


# ── Views ────────────────────────────────────────────────────────────────────────────────────────────────────────


def surface_points(m, count=None):
    """Points spread evenly over the surface by area, enough for about a dozen in every pixel the model covers."""
    if count is None:
        radius = float(np.linalg.norm(m["hi"] - m["lo"]) / 2) or 1.0
        per_unit = ((VIEW / 2 - 8) / radius) ** 2
        count = int(min(POINTS_MAX, max(POINTS_MIN, 12 * m["total_area"] * per_unit)))
    rng = np.random.default_rng(7)
    area = m["area"]
    p = area / area.sum() if area.sum() > 0 else None
    pick = rng.choice(len(area), size=count, p=p)
    r1, r2 = rng.random(count), rng.random(count)
    s = np.sqrt(r1)
    tri = m["tri"][pick]
    pts = tri[:, 0] * (1 - s)[:, None] + tri[:, 1] * (s * (1 - r2))[:, None] + tri[:, 2] * (s * r2)[:, None]
    return pts, m["normals"][pick], m["labels"][pick]


# Clay tints, one per part, so separate parts read apart in the views (one part stays plain grey clay).
TINTS = np.array([[0.78, 0.76, 0.72], [0.62, 0.72, 0.80], [0.82, 0.70, 0.56], [0.66, 0.78, 0.64], [0.80, 0.66, 0.70],
                  [0.70, 0.68, 0.84]])


def view(pts, nrm, center, radius, azimuth, elevation, res=VIEW, part=None):
    """An orthographic view: grey clay lit from upper left, back faces magenta. Returns (rgb, mask)."""
    az, el = math.radians(azimuth), math.radians(elevation)
    # The camera looks at the centre from this direction; screen x to the right, y up.
    d = np.array([math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)])
    right = np.array([math.cos(az), math.sin(az), 0.0])
    up = np.cross(right, -d)
    rel = pts - center
    sx = rel @ right
    sy = rel @ up
    depth = rel @ d  # larger is nearer the camera
    scale = (res / 2 - 8) / radius
    px = np.clip((sx * scale + res / 2).astype(np.int64), 0, res - 1)
    py = np.clip((res / 2 - sy * scale).astype(np.int64), 0, res - 1)
    idx = py * res + px
    order = np.lexsort((-depth, idx))
    first = order[np.unique(idx[order], return_index=True)[1]]
    facing = nrm[first] @ d
    # The key light rides with the camera, from its upper left, so every view shows form the same way.
    key = -0.45 * right + 0.55 * up + 0.7 * d
    key = key / np.linalg.norm(key)
    lit = np.clip(nrm[first] @ key, 0, 1)
    rim = np.clip(1 - np.abs(facing), 0, 1) ** 3
    shade = np.clip(0.2 + 0.68 * lit + 0.12 * np.clip(facing, 0, 1) + 0.12 * rim, 0, 1)
    tint = TINTS[part[first] % len(TINTS)] if part is not None else np.array([0.78, 0.76, 0.72])
    colour = shade[:, None] * tint
    back = facing < -0.05
    colour[back] = np.array([0.85, 0.15, 0.6]) * (0.5 + 0.5 * shade[back, None])
    rgb = np.zeros((res * res, 3))
    zbuf = np.full(res * res, -np.inf)
    rgb[idx[first]] = colour
    zbuf[idx[first]] = depth[first]
    rgb, zbuf = rgb.reshape(res, res, 3), zbuf.reshape(res, res)
    # Between samples, a pixel can be empty, or show the far side through a gap in the near one. Where most
    # neighbours are filled and nearer, the pixel takes their average instead.
    shifts = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]
    for _ in range(2):
        pz = np.pad(zbuf, 1, constant_values=-np.inf)
        prgb = np.pad(rgb, ((1, 1), (1, 1), (0, 0)))
        near = np.zeros((res, res))
        acc = np.zeros((res, res, 3))
        for dy, dx in shifts:
            z = pz[1 + dy : 1 + dy + res, 1 + dx : 1 + dx + res]
            closer = z > zbuf + radius * 0.04
            near += closer
            acc += np.where(closer[..., None], prgb[1 + dy : 1 + dy + res, 1 + dx : 1 + dx + res], 0)
        fix = near >= 5
        if not fix.any():
            break
        best = np.max([pz[1 + dy : 1 + dy + res, 1 + dx : 1 + dx + res] for dy, dx in shifts], axis=0)
        rgb[fix] = acc[fix] / near[fix][:, None]
        zbuf[fix] = best[fix]
    mask = np.isfinite(zbuf)
    rgb[~mask] = np.array([0.93, 0.92, 0.89])
    return rgb, mask


VIEWS = [("front", 0, 12), ("front right", 45, 12), ("right", 90, 12), ("back right", 135, 12), ("back", 180, 12),
         ("back left", 225, 12), ("left", 270, 12), ("front left", 315, 12)]
TOP, BELOW = ("top", 0, 89), ("below", 0, -89)


def likeness_panel(r, photo, model, size):
    """Red: in the photo, missing from the model. Blue: in the model, not in the photo. Grey: both."""
    p, q = np.asarray(photo) > 127, np.asarray(model) > 127
    rgb = np.full((*p.shape, 3), 240, dtype=np.uint8)
    rgb[p & q] = (150, 148, 140)
    rgb[p & ~q] = (226, 50, 50)
    rgb[q & ~p] = (50, 96, 226)
    return Image.fromarray(rgb).resize((size, size), Image.NEAREST)


def draw_sheet(m, path, printing=False, panels=()):
    pts, nrm, part = surface_points(m)
    tint = part if len(m["names"]) > 1 else None
    center = (m["lo"] + m["hi"]) / 2
    radius = float(np.linalg.norm(m["hi"] - m["lo"]) / 2) or 1.0
    cols, gap, label = 3, 6, 18
    sil = VIEW // 3
    w = cols * VIEW + (cols + 1) * gap
    like = (VIEW // 2 + label + gap) if panels else 0
    h = 3 * (VIEW + label) + 4 * gap + sil + label + like
    sheet = Image.new("RGB", (w, h), (24, 24, 22))
    draw = ImageDraw.Draw(sheet)
    silhouettes = []
    # For a print, the ninth view is the underside, where the base and any hole in it are.
    for i, (name, az, el) in enumerate([*VIEWS, BELOW if printing else TOP]):
        rgb, mask = view(pts, nrm, center, radius, az, el, part=tint)
        x = gap + (i % cols) * (VIEW + gap)
        y = gap + (i // cols) * (VIEW + label + gap)
        sheet.paste(Image.fromarray((rgb * 255).astype(np.uint8)), (x, y + label))
        draw.text((x + 2, y + 2), name, fill=(230, 228, 220))
        if abs(el) < 80:
            silhouettes.append(Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).resize((sil, sil)))
    y = 3 * (VIEW + label + gap) + gap
    caption = "silhouettes, every 45°"
    if tint is not None:
        caption += "   parts: " + ", ".join(m["names"][:6]) + (" …" if len(m["names"]) > 6 else "")
    draw.text((gap + 2, y + 2), caption, fill=(230, 228, 220))
    step = (w - gap) // len(silhouettes)
    for i, s in enumerate(silhouettes):
        sheet.paste(s.convert("RGB"), (gap + i * step, y + label))
    if panels:
        y += label + sil + gap
        draw.text((gap + 2, y + 2), "likeness: red in the photo only, blue in the model only", fill=(230, 228, 220))
        half = VIEW // 2
        for i, (r, photo, model) in enumerate(panels[: (w - gap) // (half + gap)]):
            x = gap + i * (half + gap)
            sheet.paste(likeness_panel(r, photo, model, half), (x, y + label))
            draw.text((x + 4, y + label + 4), f"{r['view']} {r['iou']:.0%}", fill=(30, 30, 28))
    sheet.save(path, quality=88)


def main():
    try:
        with open(sys.argv[1], encoding="utf-8") as f:
            spec = json.load(f)
        fmt, v, f, labels, names = read_model(spec["path"])
        m = measure(v, f, spec, fmt, labels, names)
        checks = mesh_checks(m, spec)
        info = {
            "format": fmt, "triangles": int(len(m["f"])), "vertices": int(len(m["v"])),
            "size": [round(float(s), 3) for s in m["size"]], "min": [round(float(s), 3) for s in m["lo"]],
            "area": round(m["total_area"], 3), "volume": round(m["volume"], 3), "bodies": m["bodies"],
            "units": "mm" if spec.get("print") else "as authored",
            "up": "y (turned to z for the checks and views)" if up_axis(fmt, spec) == "y" else "z",
        }
        if len(m["names"]) > 1:
            info["parts"] = m["names"]
        panels = []
        if spec.get("print"):
            if len(m["names"]) > 1 or spec.get("fits"):
                fit, pairs = fit_checks(m, spec)
                checks += fit
                if pairs:
                    info["fits"] = pairs
            if spec.get("views"):
                c, results, panels = likeness_checks(m, spec["views"])
                checks.append(c)
                info["likeness"] = results
            if spec.get("export_dir") and not any(c["status"] == "fail" for c in checks):
                info["print_files"] = export_parts(m, spec["export_dir"], spec.get("print_pose"))
        if spec.get("sheet"):
            draw_sheet(m, spec["sheet"], bool(spec.get("print")), panels)
            info["sheet"] = spec["sheet"]
        print(json.dumps({"ok": True, "kind": "mesh", "info": info, "checks": checks}))
    except Exception as e:  # noqa: BLE001 — every failure becomes an answer the caller can show
        print(json.dumps({"ok": False, "error": str(e) or type(e).__name__}))


if __name__ == "__main__":
    main()
