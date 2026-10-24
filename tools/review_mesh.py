# SPDX-License-Identifier: AGPL-3.0-only
"""Checks a 3D model for the faults that sink a print or a viewing model, and draws a turntable sheet to look at.

    python review_mesh.py SPEC.json

SPEC is {"path": str, "sheet": str or null, "print": bool, "size_mm": [x, y, z] or null, "bed_mm": [x, y, z] or
null, "max_triangles": int or null, "up": "z" or "y" or null}. Prints one JSON object: {"ok": true, "kind": "mesh",
"info": {...}, "checks": [...]}, where each check is {"id", "status": "pass"|"warn"|"fail", "value", "limit",
"detail"}; or {"ok": false, "error": msg}.

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
            return rec["v"].astype(np.float64).reshape(-1, 3), np.arange(n * 3).reshape(-1, 3)
    text = data.decode("ascii", errors="replace")
    if not text.lstrip().lower().startswith("solid"):
        raise ValueError("This STL is neither binary nor ASCII STL.")
    verts = [line.split()[1:4] for line in text.splitlines() if line.strip().lower().startswith("vertex")]
    if len(verts) % 3:
        raise ValueError("This ASCII STL has a facet without three vertices.")
    v = np.array(verts, dtype=np.float64).reshape(-1, 3)
    return v, np.arange(len(v)).reshape(-1, 3)


def read_obj(data):
    verts, faces = [], []
    for line in data.decode("utf-8", errors="replace").splitlines():
        if line.startswith("v "):
            verts.append(line.split()[1:4])
        elif line.startswith("f "):
            idx = []
            for tok in line.split()[1:]:
                i = int(tok.split("/")[0])
                idx.append(i - 1 if i > 0 else len(verts) + i)
            for k in range(1, len(idx) - 1):  # a polygon becomes a fan of triangles
                faces.append((idx[0], idx[k], idx[k + 1]))
    if not verts:
        raise ValueError("This OBJ has no vertices.")
    v = np.array(verts, dtype=np.float64)
    f = np.array(faces, dtype=np.int64).reshape(-1, 3)
    if len(f) and (f.min() < 0 or f.max() >= len(v)):
        raise ValueError("This OBJ has a face that names a vertex it doesn't have.")
    return v, f


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
    return verts, f


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

    verts, faces, count = [], [], 0
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
    if not verts:
        raise ValueError("This model has no triangle meshes in its scene.")
    return np.concatenate(verts), np.concatenate(faces)


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
        v, f = read_stl(data)
    elif ext == "obj":
        v, f = read_obj(data)
    elif ext == "ply":
        v, f = read_ply(data)
    elif ext == "glb":
        v, f = read_glb(data)
    elif ext == "gltf":
        doc = json.loads(data.decode("utf-8"))
        v, f = read_gltf(doc, [data_uri(b) for b in doc.get("buffers", [])])
    else:
        raise ValueError("Send a model as GLB, glTF, STL, OBJ or PLY.")
    if len(f) == 0:
        raise ValueError("This model has no triangles.")
    if len(f) > MAX_TRIANGLES:
        raise ValueError(f"This model has {len(f)} triangles; Hildegard checks models up to {MAX_TRIANGLES}.")
    if not np.all(np.isfinite(v)):
        raise ValueError("This model has vertices that aren't numbers (NaN or infinite).")
    return ext, v, f.astype(np.int64)


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


def measure(v, f, spec, fmt="stl"):
    up = up_axis(fmt, spec)
    if up == "y":  # Y-up (glTF): turn so Z is up for every measurement and view
        v = v[:, [0, 2, 1]] * np.array([1, -1, 1])
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
    labels, body_area = np.unique(body, return_inverse=True)
    per_body = np.bincount(body_area, weights=area)
    debris = int(np.sum(per_body < total_area * 0.001))

    unit = np.where(area2[:, None] > 0, cross / np.maximum(area2[:, None], 1e-30), 0)
    lo, hi = v.min(0), v.max(0)
    size = hi - lo
    centroid = tri.mean(1)
    return {
        "v": v, "f": f, "tri": tri, "area": area, "normals": unit, "total_area": total_area,
        "degenerate": int(degenerate.sum()), "boundary": boundary, "nonmanifold": nonmanifold, "flipped": flipped,
        "volume": volume, "bodies": len(labels), "debris": debris, "lo": lo, "hi": hi, "size": size,
        "centroid": centroid,
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
    out.append(check("bodies", "warn" if printing and m["bodies"] > 1 else "pass", m["bodies"], 1 if printing else None,
                     "Separate pieces. Fine if the parts are meant to be separate; otherwise they'll print loose."))
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
    return pts, m["normals"][pick]


def view(pts, nrm, center, radius, azimuth, elevation, res=VIEW):
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
    colour = shade[:, None] * np.array([0.78, 0.76, 0.72])
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


def draw_sheet(m, path, printing=False):
    pts, nrm = surface_points(m)
    center = (m["lo"] + m["hi"]) / 2
    radius = float(np.linalg.norm(m["hi"] - m["lo"]) / 2) or 1.0
    cols, gap, label = 3, 6, 18
    sil = VIEW // 3
    w = cols * VIEW + (cols + 1) * gap
    h = 3 * (VIEW + label) + 4 * gap + sil + label
    sheet = Image.new("RGB", (w, h), (24, 24, 22))
    draw = ImageDraw.Draw(sheet)
    silhouettes = []
    # For a print, the ninth view is the underside, where the base and any hole in it are.
    for i, (name, az, el) in enumerate([*VIEWS, BELOW if printing else TOP]):
        rgb, mask = view(pts, nrm, center, radius, az, el)
        x = gap + (i % cols) * (VIEW + gap)
        y = gap + (i // cols) * (VIEW + label + gap)
        sheet.paste(Image.fromarray((rgb * 255).astype(np.uint8)), (x, y + label))
        draw.text((x + 2, y + 2), name, fill=(230, 228, 220))
        if abs(el) < 80:
            silhouettes.append(Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).resize((sil, sil)))
    y = 3 * (VIEW + label + gap) + gap
    draw.text((gap + 2, y + 2), "silhouettes, every 45°", fill=(230, 228, 220))
    step = (w - gap) // len(silhouettes)
    for i, s in enumerate(silhouettes):
        sheet.paste(s.convert("RGB"), (gap + i * step, y + label))
    sheet.save(path, quality=88)


def main():
    try:
        with open(sys.argv[1], encoding="utf-8") as f:
            spec = json.load(f)
        fmt, v, f = read_model(spec["path"])
        m = measure(v, f, spec, fmt)
        checks = mesh_checks(m, spec)
        info = {
            "format": fmt, "triangles": int(len(m["f"])), "vertices": int(len(m["v"])),
            "size": [round(float(s), 3) for s in m["size"]], "min": [round(float(s), 3) for s in m["lo"]],
            "area": round(m["total_area"], 3), "volume": round(m["volume"], 3), "bodies": m["bodies"],
            "units": "mm" if spec.get("print") else "as authored",
            "up": "y (turned to z for the checks and views)" if up_axis(fmt, spec) == "y" else "z",
        }
        if spec.get("sheet"):
            draw_sheet(m, spec["sheet"], bool(spec.get("print")))
            info["sheet"] = spec["sheet"]
        print(json.dumps({"ok": True, "kind": "mesh", "info": info, "checks": checks}))
    except Exception as e:  # noqa: BLE001 — every failure becomes an answer the caller can show
        print(json.dumps({"ok": False, "error": str(e) or type(e).__name__}))


if __name__ == "__main__":
    main()
