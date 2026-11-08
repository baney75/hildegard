# SPDX-License-Identifier: AGPL-3.0-only
"""Probes for packages/craft/test/motion.test.ts: they import skills/hildegard-motion/scripts/motion.py, draw frames and print
JSON for the test to judge. Usage: motion_probe.py <skill dir> fields | nested | exits | wipe | units | empty | wipepad."""

import hashlib
import json
import os
import sys
import tempfile

SKILL = sys.argv[1]
sys.path.insert(0, os.path.join(SKILL, "scripts"))
import motion  # noqa: E402
import numpy as np  # noqa: E402

CANVAS = {"width": 640, "height": 360, "fps": 10, "background": "#223344"}


def compile_layers(layers, scene=None, dur=4):
    sc = {"duration": dur, "layers": layers}
    sc.update(scene or {})
    f = os.path.join(tempfile.mkdtemp(), "s.json")
    with open(f, "w") as fh:
        json.dump({"canvas": CANVAS, "scenes": [sc]}, fh)
    m, probs = motion.compile_spec(f)
    if m is not None:
        probs = probs + motion.run_checks(m)
    return m, [p.line() for p in probs if p.level == "error"]


def frames(m, times):
    r = motion.Renderer(m, 1.0)
    return [r.to_uint8(r.render_frame(t)) for t in times]


def digest(fr):
    return [hashlib.md5(f.tobytes()).hexdigest() for f in fr]


# ---- fields: every field a layer type allows is drawn or refused by --check
BASES = {
    "text": {"type": "text", "text": "Hello there friend", "size": 6, "x": 0.4, "y": 0.5, "box": 0.5},
    "image": {"type": "image", "file": "sample:dusk", "w": 0.5, "h": 0.5, "x": 0.4, "y": 0.5},
    "bars": {"type": "bars", "x": 0.5, "y": 0.5, "w": 0.6, "h": 0.5, "data": [{"label": "A", "value": 3}, {"label": "B", "value": 5}]},
    "rect": {"type": "shape", "shape": "rect", "x": 0.4, "y": 0.5, "w": 0.3, "h": 0.2, "fill": "#ff0000"},
    "rounded": {"type": "shape", "shape": "rounded", "x": 0.4, "y": 0.5, "w": 0.3, "h": 0.2, "fill": "#ff0000"},
    "ellipse": {"type": "shape", "shape": "ellipse", "x": 0.4, "y": 0.5, "w": 0.3, "h": 0.2, "fill": "#ff0000"},
    "circle": {"type": "shape", "shape": "circle", "x": 0.4, "y": 0.5, "w": 0.2, "fill": "#ff0000"},
    "line": {"type": "shape", "shape": "line", "from": [0.2, 0.5], "to": [0.6, 0.5], "stroke": {"color": "#ff0000", "width": 1}},
    "polygon": {"type": "shape", "shape": "polygon", "points": [[0.3, 0.3], [0.6, 0.3], [0.45, 0.7]], "fill": "#ff0000"},
    "path": {"type": "shape", "shape": "path", "d": "M 0.2 0.8 C 0.4 0.6 0.6 1.0 0.8 0.8 Z", "fill": "#ff0000", "stroke": {"color": "#ffffff", "width": 1}},
}
VALUE = {
    "start": 1.0, "end": 1.5, "x": 0.6, "y": 0.3, "anchor": "topleft", "scale": 0.5, "rotation": 20, "opacity": 0.5, "camera": True,
    "enter": {"type": "wipe", "duration": 2, "delay": 0.1}, "exit": {"type": "wipe", "duration": 2},
    "animate": [{"prop": "x", "to": 0.7, "at": 0, "duration": 1}], "direction": "up", "reveal": 0.5, "reveal_style": "wipe",
    "text": "Different words", "font": "Lora", "size": 9, "weight": 800, "italic": True, "color": "#00ff00", "align": "right", "box": 0.2,
    "line_height": 2, "letter_spacing": 1, "shadow": True, "backing": {"color": "#0000ff", "pad": 2}, "outline": {"color": "#00ff00", "width": 1},
    "count": {"to": 5}, "w": 0.45, "h": 0.4, "radius": 4, "fill": "#00ff00", "stroke": {"color": "#00ff00", "width": 2},
    "from": [0.1, 0.1], "to": [0.9, 0.9], "points": [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]], "d": "M 0.1 0.1 L 0.9 0.9 L 0.1 0.9 Z",
    "file": "sample:night", "fit": "contain", "focus": [0.1, 0.1], "dim": 0.7,
    "data": [{"label": "Z", "value": 9}], "max": 20, "value_color": "#00ff00", "label_color": "#00ff00", "axis_color": "#00ff00",
    "label_size": 5, "value_size": 6, "value_weight": 300, "label_weight": 300, "gap": 0.7, "decimals": 2, "prefix": "$", "suffix": "%",
    "grow": {"at": 2.5, "duration": 1},
}
# a field that shows only next to another one is compared with that one set on both sides
NEEDS = {
    "direction": {"reveal": 0.5, "reveal_style": "wipe"},
    "reveal_style": {"reveal": 0.5},
    "reveal": {"reveal_style": "wipe"},
    "count": {"text": "{n} riders"},
}
# these change what --check says (a message, a pass or a fail), not a pixel; the test covers each by name
CHECK_ONLY = {"type", "shape", "id", "safe", "max_lines"}
TIMES = (0.2, 0.8, 1.2, 1.8, 2.6, 3.7)


def sample_run(layer, field, value):
    scene = {"camera": {"preset": "push-in", "amount": 0.3}} if field == "camera" else None
    if field == "camera" and layer["type"] == "image":  # an image follows the camera by default, so compare with it off
        base = dict(layer, camera=False)
    else:
        base = dict(layer)
    base.update(NEEDS.get(field, {}))
    m0, _ = compile_layers([base], scene)
    m1, errs = compile_layers([dict(base, **{field: value})], scene)
    drawn = m0 is not None and m1 is not None and digest(frames(m0, TIMES)) != digest(frames(m1, TIMES))
    refused = any(f'"{field}"' in e for e in errs)
    return drawn, refused


def cmd_fields():
    schema = json.load(open(os.path.join(SKILL, "references", "spec.schema.json")))
    out = {"unexplained": [], "refused_ok": []}
    for key, base in BASES.items():
        branch = next(b for b in schema["$defs"]["layer"]["oneOf"] if b["properties"]["type"]["const"] == base["type"])
        for field in branch["properties"]:
            if field in CHECK_ONLY:
                continue
            if field not in VALUE:
                out["unexplained"].append(f"{key}.{field}: the probe has no sample value for it")
                continue
            drawn, refused = sample_run(base, field, VALUE[field])
            if not (drawn or refused):
                out["unexplained"].append(f"{key}.{field}")
        # fields the schema names as not used by this layer type must be refused with a message that names them
        for field in branch.get("x-not-used", {}):
            drawn, refused = sample_run(base, field, VALUE[field])
            if not refused:
                out["unexplained"].append(f"{key}.{field}: listed as not used but --check does not say so")
            out["refused_ok"].append(f"{key}.{field}")
    print(json.dumps(out))


# ---- nested: every field the schema allows inside "enter" and "exit" is drawn or refused by --check, on every layer type
NESTED_VALUE = {"delay": 0.4, "ease": "easeInOutQuart", "direction": "up", "distance": 0.2, "split": "word", "stagger": 0.5}
NESTED_TIMES = (0.3, 0.9, 1.5, 3.0, 3.3, 3.6)


def cmd_nested():
    schema = json.load(open(os.path.join(SKILL, "references", "spec.schema.json")))
    out = {"unexplained": [], "refused": 0}
    for phase in ("enter", "exit"):
        defn = schema["$defs"][phase]
        types = defn["properties"]["type"]["enum"]
        for name, base in BASES.items():
            if name in ("bars", "rounded", "ellipse"):
                continue
            for kind in types:
                preset = {"type": kind, "duration": 1.5}
                m0, errs0 = compile_layers([dict(base, **{phase: preset})])
                if errs0 or m0 is None:  # this type does not fit this layer at all; --check says so already
                    continue
                for field in defn["properties"]:
                    if field in ("type", "duration"):
                        continue
                    m1, errs = compile_layers([dict(base, **{phase: dict(preset, **{field: NESTED_VALUE[field]})})])
                    drawn = m1 is not None and digest(frames(m0, NESTED_TIMES)) != digest(frames(m1, NESTED_TIMES))
                    refused = any(f'"{field}"' in e for e in errs)
                    out["refused"] += refused
                    if not (drawn or refused):
                        out["unexplained"].append(f"{name} {phase} {kind} {field}")
    print(json.dumps(out))


# ---- exits: every documented exit moves every layer type
KINDS = {
    "text": {"type": "text", "text": "Hello there friend", "size": 8},
    "boxed text": {"type": "text", "text": "Hello there friend again", "size": 8, "box": 0.4},
    "rect": {"type": "shape", "shape": "rect", "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.2, "fill": "#ff0000"},
    "circle": {"type": "shape", "shape": "circle", "x": 0.5, "y": 0.5, "w": 0.2, "fill": "#ff0000"},
    "line": {"type": "shape", "shape": "line", "from": [0.2, 0.5], "to": [0.8, 0.5], "stroke": {"color": "#ff0000", "width": 1}},
    "polygon": {"type": "shape", "shape": "polygon", "points": [[0.3, 0.3], [0.7, 0.3], [0.5, 0.7]], "fill": "#ff0000"},
    "image": {"type": "image", "file": "sample:dusk", "w": 0.5, "h": 0.5},
    "bars": {"type": "bars", "x": 0.5, "y": 0.5, "w": 0.6, "h": 0.5, "data": [{"label": "A", "value": 3}, {"label": "B", "value": 5}], "grow": {"at": 0, "duration": 0.2}},
}
EXITS = ("fade", "rise", "drop", "slide-to-left", "slide-to-right", "zoom", "wipe")


def cmd_exits():
    still = []
    for ex in EXITS:
        for name, layer in KINDS.items():
            m, errs = compile_layers([dict(layer, exit={"type": ex, "duration": 1.0})])
            before, mid, late = frames(m, (2.0, 3.5, 3.95))  # the exit runs from 3.0 s to the end at 4.0 s
            if errs or (before == mid).all() or (before == late).all():
                still.append(f"{ex} on {name}: {errs or 'the frame did not change'}")
    print(json.dumps(still))


def cmd_wipe():
    """A text exit "wipe" must give the frame a static wipe at the same reveal gives, not letters typed away."""
    layer = {"type": "text", "text": "Hello there friend again", "size": 8, "box": 0.4}
    m, errs = compile_layers([dict(layer, exit={"type": "wipe", "duration": 1.0})])
    t = 3.5
    L = m.scenes[0].layers[0]
    r = motion.Renderer(m, 1.0)
    reveal = r.state(L, t)["reveal"]
    mid = r.to_uint8(r.render_frame(t))
    out = {"errors": errs, "reveal": reveal}
    for style in ("wipe", "type"):
        ref, _ = compile_layers([dict(layer, reveal=reveal, reveal_style=style)])
        out[style] = bool((frames(ref, (t,))[0] == mid).all())
    print(json.dumps(out))


# ---- units: a split layer counts the lines the layout really makes
def cmd_units():
    text = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    layer = {"type": "text", "text": text, "size": 6, "box": 0.3, "enter": {"type": "fade", "duration": 1.0, "delay": 0.5, "split": "line", "stagger": 0.7}}
    m, _ = compile_layers([layer], dur=12)
    L = m.scenes[0].layers[0]
    lines = [ln["s"] for ln in motion.Renderer(m, 1.0).layout(L, text)["lines"] if ln["s"]]
    print(json.dumps({"lines": len(lines), "anim_end": L.anim_end, "expected": 0.5 + 1.0 + 0.7 * (len(lines) - 1)}))


# ---- wipepad: a wipe covers the backing and the shadow too, so a layer at reveal 0 leaves no outline of its box
def cmd_wipepad():
    base = {"type": "text", "text": "Hello there friend", "size": 8, "x": 0.5, "y": 0.5, "box": 0.5}
    m_empty, _ = compile_layers([dict(base, text=" ", opacity=0)])
    blank = frames(m_empty, (0.0,))[0].astype(int)
    worst = {}
    for extra in ({"backing": {"color": "#ff0000", "pad": 3}}, {"shadow": {"color": "#ff0000", "blur": 3, "dy": 1}}):
        for direction in ("up", "down", "left", "right"):
            m, errs = compile_layers([dict(base, enter={"type": "wipe", "direction": direction, "duration": 1.0, "delay": 0.0}, exit={"type": "wipe", "direction": direction, "duration": 1.0}, **extra)])
            assert not errs, errs
            # reveal is 0 on the first frame of the enter and (all but) 0 at the end of the exit
            r = motion.Renderer(m, 1.0)
            for label, t in (("enter", 0.0), ("exit", 3.9999)):
                diff = int(np.abs(r.to_uint8(r.render_frame(t)).astype(int) - blank).max())
                worst[f"{next(iter(extra))} {direction} {label}"] = diff
    print(json.dumps(worst))


# ---- empty: an option that is present is on, even as {} (every default); it must not be dropped as falsy
def cmd_empty():
    off = []
    for name, base, field in (("text", BASES["text"], "backing"), ("text", BASES["text"], "outline"), ("text", BASES["text"], "shadow"), ("rect", BASES["rect"], "stroke")):
        m0, _ = compile_layers([base])
        m1, errs = compile_layers([dict(base, **{field: {}})])
        if errs or digest(frames(m0, (1.0,))) == digest(frames(m1, (1.0,))):
            off.append(f"{name}.{field}: {errs or 'drawn the same as without it'}")
    print(json.dumps(off))


{"fields": cmd_fields, "exits": cmd_exits, "wipe": cmd_wipe, "units": cmd_units, "empty": cmd_empty, "nested": cmd_nested, "wipepad": cmd_wipepad}[sys.argv[2]]()
