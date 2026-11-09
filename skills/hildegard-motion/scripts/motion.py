#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Motion: video drawn in code, from a JSON spec.

  python3 motion.py spec.json out.mp4 [--preview frames.jpg] [--check] [--force]
  python3 motion.py spec.json --check            # validate only, print plain problems
  python3 motion.py spec.json --preview sheet.jpg   # contact sheet of 8 frames, no video
  python3 motion.py --fonts [fetch]              # the pinned Google Fonts and what is cached

The spec is documented in references/spec.md and described by references/spec.schema.json.
Everything is drawn with Pillow and numpy at 2x and downscaled (anti-aliased), in sRGB, and
encoded by ffmpeg (on PATH) or PyAV. Same spec, same frames. A spec that fails --check does not
render unless --force. Python 3.10+; Linux, macOS and Windows.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

# numpy 2.5 and PyAV 19 need Python 3.12, so these are minimums that pip resolves on 3.10 through 3.13, not pins.
INSTALL_LIBS = 'python3 -m pip install "numpy>=1.26" "pillow>=10.1"'
INSTALL_AV = 'python3 -m pip install "av>=12"'

try:
    import numpy as np
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
except ImportError as _e:  # pragma: no cover
    sys.exit(f"motion.py needs numpy and Pillow ({_e}). Install them: {INSTALL_LIBS}")

SS = 2  # supersampling: layers are drawn at 2x and reduced with a box filter
HERE = Path(__file__).resolve().parent
SCHEMA_PATH = HERE.parent / "references" / "spec.schema.json"
MIN_WORD_SECONDS = 0.25  # readable time per word
MIN_TEXT_SECONDS = 1.2
SMALL_TEXT_VH = 5.0  # text smaller than this (percent of frame height) needs 4.5:1 contrast, larger 3:1

# --------------------------------------------------------------------------------------------
# Fonts: Google Fonts (SIL OFL 1.1) pinned to one google/fonts commit and checked by SHA-256.
# Nothing is bundled in the skill; a font is downloaded once into the cache and never fetched
# again while the cached file matches its pin.
# --------------------------------------------------------------------------------------------
FONTS_COMMIT = "86aced91de05cd4f96a06838124cca45be337b2b"
FONTS_BASE = f"https://raw.githubusercontent.com/google/fonts/{FONTS_COMMIT}/"
FONT_PINS = {
    "Inter": {"regular": ("ofl/inter/Inter[opsz,wght].ttf", "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031"), "italic": ("ofl/inter/Inter-Italic[opsz,wght].ttf", "acd98e64795781b2058f07b18475e0ecee2a0fe2b42a49e2f9e37d0d6bf66ce6")},
    "Montserrat": {"regular": ("ofl/montserrat/Montserrat[wght].ttf", "0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7"), "italic": ("ofl/montserrat/Montserrat-Italic[wght].ttf", "51607f316bc020e59f03cbf51543eecffbea501c0b31d73e5b82927c5cca442c")},
    "Space Grotesk": {"regular": ("ofl/spacegrotesk/SpaceGrotesk[wght].ttf", "acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72")},
    "Playfair Display": {"regular": ("ofl/playfairdisplay/PlayfairDisplay[wght].ttf", "c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6"), "italic": ("ofl/playfairdisplay/PlayfairDisplay-Italic[wght].ttf", "a5e26dc5e2e77fb2803a0bf02fd4f81ee136ec8dea863ccdb0c59a263b21378b")},
    "Lora": {"regular": ("ofl/lora/Lora[wght].ttf", "822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7"), "italic": ("ofl/lora/Lora-Italic[wght].ttf", "22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3")},
    "EB Garamond": {"regular": ("ofl/ebgaramond/EBGaramond[wght].ttf", "ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027"), "italic": ("ofl/ebgaramond/EBGaramond-Italic[wght].ttf", "bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e")},
    "Bebas Neue": {"regular": ("ofl/bebasneue/BebasNeue-Regular.ttf", "08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73")},
    "Oswald": {"regular": ("ofl/oswald/Oswald[wght].ttf", "5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817")},
    "DM Serif Display": {"regular": ("ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf", "8cc3643535edf039aa5d95440a8542735e9197e4f4b8d9303e980fefbf5ab616"), "italic": ("ofl/dmserifdisplay/DMSerifDisplay-Italic.ttf", "df74c0ac387baeaeb0fe4f2324e1668e6a3ed8c09cd9796fe162c71753e19e45")},
    "JetBrains Mono": {"regular": ("ofl/jetbrainsmono/JetBrainsMono[wght].ttf", "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda")},
}
DEFAULT_FONT = "Inter"


def font_cache_dir() -> Path:
    env = os.environ.get("HILDEGARD_MOTION_FONTS")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "hildegard" / "Cache" / "motion-fonts"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "hildegard" / "motion-fonts"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "hildegard" / "motion-fonts"


def _pin_file(family: str, italic: bool):
    pins = FONT_PINS[family]
    return pins["italic"] if italic and "italic" in pins else pins["regular"]


def cached_font_path(family: str, italic: bool = False) -> Path:
    rel, _ = _pin_file(family, italic)
    return font_cache_dir() / FONTS_COMMIT[:10] / Path(rel).name


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_font(family: str, italic: bool = False):
    """Return (path, error). Downloads once; a cached file that matches its pin is never fetched again."""
    rel, want = _pin_file(family, italic)
    path = cached_font_path(family, italic)
    if path.exists() and _sha256(path) == want:
        return path, None
    if os.environ.get("HILDEGARD_MOTION_OFFLINE") == "1":
        return None, f"{family} is not in the font cache ({path.parent}) and HILDEGARD_MOTION_OFFLINE=1"
    url = FONTS_BASE + urllib.parse.quote(rel)
    data, last = None, None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                data = r.read()
            break
        except Exception as e:  # noqa: BLE001 - any network failure reads the same to the user
            last = e
            time.sleep(1.5 * (attempt + 1))
    if data is None:
        return None, f"{family} is not cached and could not be downloaded ({last})"
    if hashlib.sha256(data).hexdigest() != want:
        return None, f"{family} downloaded from {url} but its SHA-256 does not match the pin; refusing to use it"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return path, None


class FontSpec:
    """A font a layer can name: a pinned Google family or a file on disk."""

    def __init__(self, name, family=None, path=None, base=None):
        self.name, self.family, self.base = name, family, base
        self.path_str = path
        self.error = None
        self._paths = {}

    def resolve(self, italic: bool):
        """Path of the font file for the style, or None (self.error says why)."""
        if italic in self._paths:
            return self._paths[italic]
        p = None
        if self.family:
            p, err = ensure_font(self.family, italic)
            if err:
                self.error = err
        else:
            cand = Path(self.path_str)
            if not cand.is_absolute() and self.base:
                cand = Path(self.base) / cand
            if cand.exists():
                p = cand
            else:
                self.error = f'font file "{self.path_str}" does not exist'
        self._paths[italic] = p
        return p


_FONT_OBJS: dict = {}


def load_font(spec: FontSpec, px: float, weight: int, italic: bool):
    """A PIL font at px pixels; variable fonts get the weight (and optical size) set. Falls back to Pillow's built-in face."""
    px = max(1.0, round(px * 8) / 8)
    key = (spec.name, px, weight, italic)
    f = _FONT_OBJS.get(key)
    if f is not None:
        return f
    path = spec.resolve(italic)
    if path is None:
        f = ImageFont.load_default(px)
    else:
        f = ImageFont.truetype(str(path), px)
        try:
            axes = f.get_variation_axes()
        except Exception:  # noqa: BLE001 - static fonts have no axes
            axes = []
        if axes:
            vals = []
            for a in axes:
                nm = a["name"].decode() if isinstance(a["name"], bytes) else str(a["name"])
                if nm.lower().startswith("weight"):
                    vals.append(min(max(weight, a["minimum"]), a["maximum"]))
                elif nm.lower().startswith("optical"):
                    vals.append(min(max(px / SS * 0.75, a["minimum"]), a["maximum"]))
                else:
                    vals.append(a["default"])
            try:
                f.set_variation_by_axes(vals)
            except Exception:  # noqa: BLE001
                pass
    if len(_FONT_OBJS) > 400:
        _FONT_OBJS.clear()
    _FONT_OBJS[key] = f
    return f


# --------------------------------------------------------------------------------------------
# Colors
# --------------------------------------------------------------------------------------------
HEX_RE = re.compile(r"^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def parse_color(s):
    """'#rgb', '#rgba', '#rrggbb', '#rrggbbaa' or 'transparent' -> (r, g, b, a) with r, g, b in 0..255 and a in 0..1."""
    if s == "transparent":
        return (0.0, 0.0, 0.0, 0.0)
    m = HEX_RE.match(s) if isinstance(s, str) else None
    if not m:
        raise ValueError(f'"{s}" is not a color; write #rrggbb or #rrggbbaa')
    h = m.group(1)
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    v = [int(h[i : i + 2], 16) for i in range(0, len(h), 2)]
    return (float(v[0]), float(v[1]), float(v[2]), (v[3] / 255.0) if len(v) == 4 else 1.0)


SPLIT_KINDS = ("fade", "rise", "drop", "slide-from-left", "slide-from-right", "zoom", "pop")


def opt(v):
    """An option object: absent, null and false are off; true and {} are on with every default."""
    if v is None or v is False:
        return None
    return {} if v is True else v


def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = rgb[:3]
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast_ratio(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def lerp(a, b, t):
    if isinstance(a, tuple):
        return tuple(x + (y - x) * t for x, y in zip(a, b))
    return a + (b - a) * t


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


# --------------------------------------------------------------------------------------------
# Easing: every move in a spec names one of these.
# --------------------------------------------------------------------------------------------
def _back(t, c1=1.70158):
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def _spring(t):
    f = lambda x: 1 - math.exp(-6.5 * x) * math.cos(2 * math.pi * 1.4 * x)  # noqa: E731
    return f(t) - (f(1.0) - 1.0) * t  # lands on exactly 1.0 at t = 1


def _bounce(t):
    n1, d1 = 7.5625, 2.75
    if t < 1 / d1:
        return n1 * t * t
    if t < 2 / d1:
        t -= 1.5 / d1
        return n1 * t * t + 0.75
    if t < 2.5 / d1:
        t -= 2.25 / d1
        return n1 * t * t + 0.9375
    t -= 2.625 / d1
    return n1 * t * t + 0.984375


def _in_out(f):
    return lambda t: f(2 * t) / 2 if t < 0.5 else 1 - f(2 - 2 * t) / 2


EASES = {
    "linear": lambda t: t,
    "easeInSine": lambda t: 1 - math.cos(t * math.pi / 2),
    "easeOutSine": lambda t: math.sin(t * math.pi / 2),
    "easeInOutSine": lambda t: -(math.cos(math.pi * t) - 1) / 2,
    "easeInQuad": lambda t: t * t,
    "easeOutQuad": lambda t: 1 - (1 - t) ** 2,
    "easeInOutQuad": lambda t: 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2,
    "easeInCubic": lambda t: t**3,
    "easeOutCubic": lambda t: 1 - (1 - t) ** 3,
    "easeInOutCubic": lambda t: 4 * t**3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2,
    "easeInQuart": lambda t: t**4,
    "easeOutQuart": lambda t: 1 - (1 - t) ** 4,
    "easeInOutQuart": lambda t: 8 * t**4 if t < 0.5 else 1 - (-2 * t + 2) ** 4 / 2,
    "easeInExpo": lambda t: 0.0 if t <= 0 else 2 ** (10 * t - 10),
    "easeOutExpo": lambda t: 1.0 if t >= 1 else 1 - 2 ** (-10 * t),
    "easeInOutExpo": lambda t: 0.0 if t <= 0 else 1.0 if t >= 1 else (2 ** (20 * t - 10) / 2 if t < 0.5 else (2 - 2 ** (-20 * t + 10)) / 2),
    "easeInBack": lambda t: 2.70158 * t**3 - 1.70158 * t**2,
    "easeOutBack": _back,
    "easeInOutBack": lambda t: ((2 * t) ** 2 * ((2.5949095 + 1) * 2 * t - 2.5949095)) / 2 if t < 0.5 else ((2 * t - 2) ** 2 * ((2.5949095 + 1) * (t * 2 - 2) + 2.5949095) + 2) / 2,
    "spring": _spring,
    "bounce": _bounce,
}
EASE_NAMES = list(EASES)


class Seg:
    """One move of one property: from `a` to `b` starting `at` seconds into the layer, over `dur` seconds."""

    __slots__ = ("at", "dur", "ease", "a", "b", "src")

    def __init__(self, at, dur, ease, a, b, src="animate"):
        self.at, self.dur, self.ease, self.a, self.b, self.src = at, dur, ease, a, b, src

    @property
    def end(self):
        return self.at + self.dur


def seg_value(segs, t, base):
    """Value of a property at layer time t: before the first move its `from`, then eased, then held at the last `to`."""
    if not segs:
        return base
    cur = None
    for s in segs:
        if t >= s.at:
            cur = s
        else:
            break
    if cur is None:
        return segs[0].a
    p = 1.0 if cur.dur <= 0 else clamp((t - cur.at) / cur.dur, 0.0, 1.0)
    return lerp(cur.a, cur.b, EASES[cur.ease](p))


def progress(t, at, dur, ease):
    p = 1.0 if dur <= 0 else clamp((t - at) / dur, 0.0, 1.0)
    return EASES[ease](p)


# --------------------------------------------------------------------------------------------
# A small JSON Schema checker (the subset spec.schema.json uses), so --check needs no packages
# and every message can say what to write instead.
# --------------------------------------------------------------------------------------------
def _type_ok(v, t):
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, float) and v.is_integer())
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "array":
        return isinstance(v, list)
    if t == "object":
        return isinstance(v, dict)
    if t == "null":
        return v is None
    return True


def suggest(value, options):
    """Up to three names in `options` that `value` most likely meant: case, dashes and underscores are ignored, so "ease-out" and
    "pushin" find their names, and a longer or shorter form ("fadeout", "words") finds its stem; then the closest spellings."""
    norm = lambda x: re.sub(r"[^a-z0-9]", "", str(x).lower())  # noqa: E731
    v = norm(value)
    names = [str(o) for o in options]
    if not v:
        return []
    same = [o for o in names if norm(o) == v]
    if same:
        return same[:1]
    stem = [o for o in names if len(norm(o)) >= 3 and (norm(o).startswith(v) or v.startswith(norm(o)))]
    out = []
    for o in stem + difflib.get_close_matches(str(value), names, 3, 0.6):
        if o not in out:
            out.append(o)
    return out[:3]


def did_you_mean(hints):
    q = [f'"{h}"' for h in hints]
    if not q:
        return ""
    return " (did you mean " + (q[0] if len(q) == 1 else ", ".join(q[:-1]) + " or " + q[-1]) + "?)"


def _describe(v):
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= 40 else s[:37] + "..."


def _type_words(t):
    ts = t if isinstance(t, list) else [t]
    names = {"string": "text", "number": "a number", "integer": "a whole number", "boolean": "true or false", "array": "a list", "object": "an object"}
    return " or ".join(names.get(x, x) for x in ts)


def schema_errors(value, schema, root, path="spec"):
    """List of (path, message). Understands type, enum, const, properties, required, additionalProperties,
    items, min/max, pattern, anyOf, oneOf (with x-discriminator) and $ref."""
    errs = []
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node[part]
        return schema_errors(value, node, root, path)
    if "anyOf" in schema:
        for sub in schema["anyOf"]:
            if not schema_errors(value, sub, root, path):
                return []
        # report against the most plausible branch: the first whose basic type matches
        for sub in schema["anyOf"]:
            ty = sub.get("type") or (root["$defs"][sub["$ref"].split("/")[-1]].get("type") if "$ref" in sub else None)
            if ty is None or _type_ok(value, ty):
                return schema_errors(value, sub, root, path)
        return [(path, f"has the wrong kind of value: {_describe(value)}")]
    if "oneOf" in schema:
        disc = schema.get("x-discriminator")
        if disc and isinstance(value, dict):
            names = [b["properties"][disc]["const"] for b in schema["oneOf"]]
            got = value.get(disc)
            if got not in names:
                return [(path, f'"{disc}" must be one of: {", ".join(names)}' + did_you_mean(suggest(got, names)) + (f", got {_describe(got)}" if got is not None else ", and it is missing"))]
            branch = schema["oneOf"][names.index(got)]
            return schema_errors(value, branch, root, path)
        for sub in schema["oneOf"]:
            if not schema_errors(value, sub, root, path):
                return []
        return [(path, f"does not match any allowed form: {_describe(value)}")]
    if "const" in schema and value != schema["const"]:
        return [(path, f"must be {_describe(schema['const'])}")]
    t = schema.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not any(_type_ok(value, x) for x in ts):
            return [(path, f"must be {_type_words(t)}, got {_describe(value)}")]
    if "enum" in schema and value not in schema["enum"]:
        opts = schema["enum"]
        shown = ", ".join(str(o) for o in opts)
        return [(path, f"must be one of: {shown}" + did_you_mean(suggest(value, opts)) + f", got {_describe(value)}")]
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            return [(path, schema.get("x-pattern-help") or f"{_describe(value)} is not in the right form")]
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append((path, "must not be empty"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append((path, f"must be at least {schema['minimum']}, got {value}"))
        if "maximum" in schema and value > schema["maximum"]:
            errs.append((path, f"must be at most {schema['maximum']}, got {value}"))
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errs.append((path, f"must be more than {schema['exclusiveMinimum']}, got {value}"))
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errs.append((path, f"needs at least {schema['minItems']} item(s)"))
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errs.append((path, f"takes at most {schema['maxItems']} item(s)"))
        if "items" in schema:
            for i, item in enumerate(value):
                errs += schema_errors(item, schema["items"], root, f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for req in schema.get("required", []):
            if req not in value:
                hint = (props.get(req) or {}).get("description", "")
                errs.append((path, f'is missing "{req}"' + (f" ({hint})" if hint else "")))
        for k, v in value.items():
            if k in props:
                errs += schema_errors(v, props[k], root, f"{path}.{k}")
            elif k in schema.get("x-not-used", {}):
                errs.append((path, f'"{k}" {schema["x-not-used"][k]}'))
            elif schema.get("additionalProperties") is False:
                hint = difflib.get_close_matches(k, list(props), 1, 0.6)
                allowed = ", ".join(p for p in props if not p.startswith("$"))
                errs.append((path, f'unknown field "{k}"' + (f' (did you mean "{hint[0]}"?)' if hint else f" (allowed here: {allowed})")))
            elif isinstance(schema.get("additionalProperties"), dict):
                errs += schema_errors(v, schema["additionalProperties"], root, f"{path}.{k}")
    return errs


def load_schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf8"))


# --------------------------------------------------------------------------------------------
# Sample images: `file: "sample:dusk"` draws a layered-ridge landscape so templates render with no assets.
# --------------------------------------------------------------------------------------------
SAMPLES = {
    "dusk": dict(sky=[(0, "#1d2150"), (0.5, "#b8507a"), (1, "#f7b27a")], sun=(0.7, 0.58, 0.07, "#ffe6b8"), ridges=["#6a3f73", "#47306a", "#2c2250", "#171233"], seed=3),
    "dawn": dict(sky=[(0, "#27406e"), (0.55, "#e79a8a"), (1, "#fde2b3")], sun=(0.3, 0.6, 0.06, "#fff3d6"), ridges=["#7c8aa6", "#566485", "#364263", "#1d2742"], seed=11),
    "moss": dict(sky=[(0, "#8fb4a7"), (0.6, "#d6e3c5"), (1, "#f5f1d6")], sun=(0.5, 0.5, 0.05, "#ffffe8"), ridges=["#8fae7a", "#5f8a63", "#3d6650", "#223f35"], seed=5),
    "night": dict(sky=[(0, "#05081a"), (0.6, "#16224f"), (1, "#34457f")], sun=(0.78, 0.3, 0.035, "#eef2ff"), ridges=["#24305e", "#18214a", "#0f1636", "#070b1e"], seed=21, stars=True),
    "sand": dict(sky=[(0, "#6d9bb8"), (0.55, "#e8d0b0"), (1, "#f6e4c4")], sun=(0.22, 0.44, 0.055, "#fffbe9"), ridges=["#d1a46a", "#b7824f", "#8d5f3c", "#5e3d2a"], seed=8),
}


def _grad1d(stops, n):
    xs = [p for p, _ in stops]
    cols = np.array([parse_color(c)[:3] for _, c in stops], dtype=np.float32)
    t = np.linspace(0, 1, n, dtype=np.float32)
    return np.stack([np.interp(t, xs, cols[:, i]) for i in range(3)], axis=1)


_SAMPLE_CACHE: dict = {}


def sample_image(name: str, w: int = 2048, h: int = 1152) -> Image.Image:
    key = (name, w, h)
    if key not in _SAMPLE_CACHE:
        _SAMPLE_CACHE[key] = _draw_sample(name, w, h)
    return _SAMPLE_CACHE[key]


def _draw_sample(name: str, w: int, h: int) -> Image.Image:
    spec = SAMPLES[name]
    rng = np.random.RandomState(spec["seed"])
    sky = _grad1d(spec["sky"], h)[:, None, :]
    img = np.broadcast_to(sky, (h, w, 3)).copy()
    yy = np.arange(h, dtype=np.float32)[:, None]
    xx = np.arange(w, dtype=np.float32)[None, :]
    if spec.get("stars"):
        n = 420
        sx, sy = rng.randint(0, w, n), rng.randint(0, int(h * 0.6), n)
        for x, y in zip(sx, sy):
            img[y : y + 2, x : x + 2] += rng.uniform(60, 190)
    cx, cy, r, col = spec["sun"]
    d = np.hypot(xx - cx * w, yy - cy * h) / (r * h)
    glow = np.exp(-(d**2) / 14.0)[..., None] * 0.55
    c = np.array(parse_color(col)[:3], dtype=np.float32)
    img = img * (1 - glow) + c * glow
    disc = np.clip((1.0 - d) * r * h, 0, 1)[..., None]
    img = img * (1 - disc) + c * disc
    haze = np.array(parse_color(spec["sky"][-1][1])[:3], dtype=np.float32)
    nr = len(spec["ridges"])
    for k, rc in enumerate(spec["ridges"]):
        depth = k / max(1, nr - 1)
        base = h * (0.56 + 0.1 * k)
        amp = h * (0.075 - 0.01 * k)
        line = np.full(w, base, dtype=np.float32)
        xs = np.arange(w, dtype=np.float32) / w
        for j in range(1, 6):
            line += amp * (0.55**j) * 1.6 * np.sin(2 * np.pi * (j * 1.7 + k * 0.6) * xs + rng.uniform(0, 6.283))
        cov = np.clip(yy - line[None, :] + 0.5, 0, 1)[..., None]
        top = np.array(parse_color(rc)[:3], dtype=np.float32)
        top = top * (0.55 + 0.45 * depth) + haze * (0.45 - 0.45 * depth) * 0.6
        shade = np.clip((yy - base) / (h - base), 0, 1)[..., None] * 0.35 * depth
        col_layer = top * (1 - shade)
        img = img * (1 - cov) + col_layer * cov
    vy = (yy / h - 0.5) ** 2 + (xx / w - 0.5) ** 2
    img *= (1 - 0.45 * vy)[..., None]
    img += rng.normal(0, 2.2, img.shape).astype(np.float32)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


# --------------------------------------------------------------------------------------------
# The model: a spec compiled into scenes, layers and timelines
# --------------------------------------------------------------------------------------------
# the fields each shape kind draws; one it does not draw is refused by --check instead of being ignored
SHAPE_FIELDS = {
    "rect": {"w", "h", "fill", "stroke"},
    "rounded": {"w", "h", "fill", "stroke", "radius"},
    "ellipse": {"w", "h", "fill", "stroke"},
    "circle": {"w", "fill", "stroke"},
    "line": {"from", "to", "stroke"},
    "polygon": {"points", "fill", "stroke"},
    "path": {"d", "fill", "stroke"},
}
SHAPE_ONLY = {"w", "h", "radius", "fill", "stroke", "from", "to", "points", "d"}
ANCHORS = {"center": (0.5, 0.5), "left": (0, 0.5), "right": (1, 0.5), "top": (0.5, 0), "bottom": (0.5, 1), "topleft": (0, 0), "topright": (1, 0), "bottomleft": (0, 1), "bottomright": (1, 1)}
NUM_PROPS = ("x", "y", "w", "h", "scale", "rotation", "opacity", "reveal")
ENTER_DUR = {"fade": 0.6, "rise": 0.7, "drop": 0.7, "slide-from-left": 0.7, "slide-from-right": 0.7, "zoom": 0.7, "pop": 0.6, "wipe": 0.8, "grow": 0.8, "draw": 1.0}
EXIT_DUR = 0.5


class Problem:
    def __init__(self, level, where, msg, order=(-1, 0)):
        self.level, self.where, self.msg, self.order = level, where, msg, order

    def line(self):
        tag = "PROBLEM" if self.level == "error" else "warning"
        return f"{tag} {self.where}: {self.msg}"


class Layer:
    def __init__(self, d, kind, scene, index, uid):
        self.d, self.kind, self.scene, self.index, self.uid = d, kind, scene, index, uid
        self.id = d.get("id")
        self.group = d.get("_group")
        self.segs = {}
        self.unit_segs = {}
        self.split = None
        self.stagger = 0.0
        self.base = {}
        self.label = ""
        self.overlay = False
        self.anim_end = 0.0
        self.units = 0  # pieces a split text layer animates, set when it compiles
        self.exit_wipe_at = None  # layer second at which an exit "wipe" starts, on text
        self.path = None
        self.paths = None
        self.cue = None

    @property
    def dur(self):
        return self.end - self.start


class Scene:
    def __init__(self, d, index):
        self.d, self.index = d, index
        self.id = d.get("id")
        self.dur = float(d["duration"])
        self.layers = []
        self.start = 0.0
        self.t_in = 0.0  # seconds this scene overlaps the one before it
        self.t_out = 0.0  # seconds the next scene overlaps the end of this one
        self.transition = None
        self.camera = None
        self.bg = None

    @property
    def end(self):
        return self.start + self.dur

    @property
    def name(self):
        return f"scene {self.index + 1}" + (f' ("{self.id}")' if self.id else "")


class Model:
    pass


def fmt_number(n, decimals=0, thousands=True):
    s = f"{abs(n):,.{decimals}f}" if thousands else f"{abs(n):.{decimals}f}"
    return ("-" if n < 0 and float(s.replace(",", "")) != 0 else "") + s


def snippet(s, n=24):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def parse_paint(p):
    """Color string -> ('solid', rgba); gradient object -> ('grad', dict with parsed stops)."""
    if isinstance(p, str):
        return ("solid", parse_color(p))
    g = dict(p)
    g["stops_parsed"] = sorted([(float(s["at"]), parse_color(s["color"])) for s in p["stops"]], key=lambda s: s[0])
    return ("grad", g)


def parse_srt(text):
    cues = []
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n").strip())
    for b in blocks:
        lines = [l for l in b.split("\n") if l.strip()]
        for i, l in enumerate(lines):
            m = re.match(r"(\d+):(\d\d):(\d\d)[,.](\d{1,3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{1,3})", l.strip())
            if m:
                g = m.groups()
                t0 = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3].ljust(3, "0")) / 1000
                t1 = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7].ljust(3, "0")) / 1000
                body = re.sub(r"<[^>]+>", "", "\n".join(lines[i + 1 :])).strip()
                if body:
                    cues.append({"start": t0, "end": t1, "text": body})
                break
    return cues


def parse_path(d):
    """SVG-style path in frame fractions: M, L, C, Q, Z (upper case, absolute). Returns [(points, closed)]."""
    toks = re.findall(r"[MLCQZmlcqz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?", d)
    subs, cur, i, pos, closed = [], [], 0, (0.0, 0.0), False
    cmd = None
    nums = {"M": 2, "L": 2, "C": 6, "Q": 4}

    def flush():
        nonlocal cur, closed
        if cur:
            subs.append((cur, closed))
        cur, closed = [], False

    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd = t.upper()
            i += 1
            if cmd == "Z":
                closed = True
                flush()
                continue
            if t.islower():
                raise ValueError("path commands must be upper case (absolute coordinates)")
            continue
        if cmd is None or cmd == "Z":
            raise ValueError("path must start with M")
        n = nums[cmd]
        if i + n > len(toks):
            raise ValueError(f"path command {cmd} needs {n} numbers")
        v = [float(x) for x in toks[i : i + n]]
        i += n
        if cmd == "M":
            flush()
            pos = (v[0], v[1])
            cur = [pos]
            cmd = "L"
        elif cmd == "L":
            pos = (v[0], v[1])
            cur.append(pos)
        elif cmd == "C":
            p0, p1, p2, p3 = pos, (v[0], v[1]), (v[2], v[3]), (v[4], v[5])
            for k in range(1, 25):
                u = k / 24
                a, b, c, e = (1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u**3
                cur.append((a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]))
            pos = p3
        elif cmd == "Q":
            p0, p1, p2 = pos, (v[0], v[1]), (v[2], v[3])
            for k in range(1, 17):
                u = k / 16
                a, b, c = (1 - u) ** 2, 2 * (1 - u) * u, u * u
                cur.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]))
            pos = p2
    flush()
    if not subs:
        raise ValueError("path has no points")
    return subs


def resolve_path(p, base):
    p = Path(p)
    return p if p.is_absolute() else Path(base) / p


def split_units(L, R):
    """How many pieces a split text layer animates (words, lines or characters). A line is a line of the layout the renderer
    draws, wrapped in the layer's box, so ask that layout (`R` is a Renderer) instead of guessing from the newlines."""
    txt = L.final_text() if L.kind == "text" else ""
    if L.split == "line":
        return max(1, sum(1 for ln in R.layout(L, txt)["lines"] if ln["s"]))
    if L.split == "word":
        return max(1, len(txt.split()))
    return max(1, len(txt.replace(" ", "").replace("\n", "")))


class Compiler:
    def __init__(self, spec, base_dir, schema_problems):
        self.spec, self.base = spec, base_dir
        self.problems = list(schema_problems)
        self.uid = 0
        self.m = Model()
        self._layout = None

    def err(self, where, msg):
        self.problems.append(Problem("error", where, msg))

    def warn(self, where, msg):
        self.problems.append(Problem("warn", where, msg))

    def layout_renderer(self):
        """A renderer at full size, for the line counts of split text (the same layout the checks and the render use)."""
        if self._layout is None:
            self._layout = Renderer(self.m, 1.0)
        return self._layout

    def ease(self, name, default):
        """An easing we have. A misspelled one is already a schema problem with a suggestion; the default keeps the model
        drawable, so the other checks still run instead of stopping on a KeyError."""
        return name if name in EASES else default

    # ---- top level
    def compile(self):
        spec, m = self.spec, self.m
        cv = spec.get("canvas", {})
        m.W, m.H, m.fps = int(cv.get("width", 1920)), int(cv.get("height", 1080)), int(cv.get("fps", 30))
        m.safe = float(cv.get("safe", 0.05))
        m.base_dir = self.base
        if m.W % 2 or m.H % 2:
            self.err("canvas", f"width and height must be even numbers (the video codec needs it); got {m.W}x{m.H}. Fix: use {m.W + m.W % 2}x{m.H + m.H % 2}.")
        m.bg = parse_paint(cv.get("background", "#000000"))
        m.fonts = {}
        for name, fd in (spec.get("fonts") or {}).items():
            if "google" in fd:
                fam = fd["google"]
                if fam not in FONT_PINS:
                    self.err(f"fonts.{name}", f'"{fam}" is not in the pinned list ({", ".join(FONT_PINS)}). Fix: pick one of those, or give a "path" to a font file you have the right to use.')
                    continue
                m.fonts[name] = FontSpec(name, family=fam)
            elif "path" in fd:
                m.fonts[name] = FontSpec(name, path=fd["path"], base=self.base)
            else:
                self.err(f"fonts.{name}", 'needs "google" (a pinned family) or "path" (a font file)')
        self.font_cache = {}
        m.scenes = []
        t = 0.0
        scenes = spec.get("scenes", [])
        for i, sd in enumerate(scenes):
            sc = Scene(sd, i)
            self.compile_scene(sc, sd, i)
            m.scenes.append(sc)
        # timeline: each transition overlaps the end of the scene before it
        for i, sc in enumerate(m.scenes):
            if i == 0:
                sc.start = 0.0
            else:
                prev = m.scenes[i - 1]
                sc.t_in = sc.transition["dur"] if sc.transition else 0.0
                prev.t_out = sc.t_in
                sc.start = prev.end - sc.t_in
        for sc in m.scenes:
            if sc.t_in + sc.t_out > sc.dur + 1e-6:
                self.err(sc.name, f"is {sc.dur:g} s long but its transitions take {sc.t_in:g} s in and {sc.t_out:g} s out. Fix: make the scene at least {sc.t_in + sc.t_out + 0.5:g} s or shorten the transitions.")
            if sc.index > 0 and sc.t_in > m.scenes[sc.index - 1].dur + 1e-6:
                self.err(sc.name, "its transition is longer than the scene before it")
        m.duration = m.scenes[-1].end if m.scenes else 0.0
        if "duration" in spec and m.scenes and abs(spec["duration"] - m.duration) > 0.05:
            self.err("duration", f"says {spec['duration']:g} s but the scenes add up to {m.duration:g} s (scene lengths minus the overlap of each transition). Fix: set duration to {m.duration:g}, or change a scene's duration.")
        m.nframes = max(1, round(m.duration * m.fps))
        m.fade = spec.get("fade")
        m.audio = spec.get("audio")
        if isinstance(m.audio, dict):
            m.audio = [m.audio]
        m.overlay = []
        self.compile_captions(spec.get("captions"))
        m.problems = self.problems
        return m

    # ---- scenes
    def compile_scene(self, sc, sd, i):
        m = self.m
        sc.bg = parse_paint(sd["background"]) if "background" in sd else m.bg
        tr = sd.get("transition")
        if tr and tr.get("type", "cut") != "cut":
            if i == 0:
                self.warn(sc.name, "the first scene has no scene before it, so its transition is ignored. Fix: use the top-level \"fade\" to open from black.")
            else:
                sc.transition = {"type": tr["type"], "dur": float(tr.get("duration", 0.6)), "direction": tr.get("direction", "left"), "color": parse_color(tr.get("color", "#000000"))}
        sc.camera = self.compile_camera(sc, sd.get("camera"))
        for j, ld in enumerate(sd.get("layers", [])):
            for L in self.compile_layer_maybe_group(sc, ld, j):
                sc.layers.append(L)

    def compile_camera(self, sc, cd):
        if not cd:
            return None
        amt = cd.get("amount")
        p = cd.get("preset")
        z0 = z1 = 1.0
        x0 = x1 = y0 = y1 = 0.5
        if p in ("push-in", "pull-out"):
            a = 0.12 if amt is None else amt
            z0, z1 = (1.0, 1.0 + a) if p == "push-in" else (1.0 + a, 1.0)
        elif p in ("pan-left", "pan-right", "pan-up", "pan-down"):
            a = 0.08 if amt is None else amt
            z0 = z1 = 1.0 / (1.0 - a) + 0.01
            h = a / 2
            if p == "pan-left":
                x0, x1 = 0.5 + h, 0.5 - h
            elif p == "pan-right":
                x0, x1 = 0.5 - h, 0.5 + h
            elif p == "pan-up":
                y0, y1 = 0.5 + h, 0.5 - h
            else:
                y0, y1 = 0.5 - h, 0.5 + h
        elif p == "drift":
            a = 0.06 if amt is None else amt
            z0, z1 = 1.0 / (1.0 - a) + 0.01, 1.0 / (1.0 - a) + 0.07
            x0, x1, y0, y1 = 0.5 - a / 2, 0.5 + a / 2, 0.5 + a / 3, 0.5 - a / 3
        else:
            f, t = cd.get("from", {}), cd.get("to", {})
            z0, x0, y0 = f.get("zoom", 1.0), f.get("x", 0.5), f.get("y", 0.5)
            z1, x1, y1 = t.get("zoom", z0), t.get("x", x0), t.get("y", y0)
        return {"a": (z0, x0, y0), "b": (z1, x1, y1), "ease": self.ease(cd.get("ease"), "easeInOutSine")}

    # ---- layers
    def compile_layer_maybe_group(self, sc, ld, j):
        if ld.get("type") == "bars":
            return self.expand_bars(sc, ld, j)
        return [self.compile_layer(sc, ld, j)]

    def font_for(self, name):
        m = self.m
        if name in m.fonts:
            return m.fonts[name]
        if name in FONT_PINS:
            fs = self.font_cache.get(name) or FontSpec(name, family=name)
            self.font_cache[name] = fs
            m.fonts[name] = fs
            return fs
        return None

    def label_of(self, sc, L):
        what = L.kind
        if L.kind == "text":
            what += f' "{snippet(L.d.get("text", ""))}"'
        elif L.kind == "image":
            what += f' {L.d.get("file", "")}'
        elif L.kind == "shape":
            what += f' {L.d.get("shape", "rect")}'
        who = f'"{L.id}" ' if L.id else ""
        where = sc.name if sc else "captions"
        return f"{where} layer {L.index + 1} {who}({what})"

    def compile_layer(self, sc, d, j, global_dur=None):
        self.uid += 1
        kind = d["type"]
        L = Layer(d, kind, sc, j, self.uid)
        L.label = self.label_of(sc, L)
        sdur = sc.dur if sc else global_dur
        L.start = float(d.get("start", 0.0))
        L.end = float(d.get("end", sdur))
        w = L.label
        if sc and L.start >= sdur - 1e-6:
            self.err(w, f"starts at {L.start:g} s but the scene is only {sdur:g} s long, so it never appears. Fix: start it earlier or lengthen the scene.")
        if L.end > sdur + 1e-6 and sc:
            self.warn(w, f"ends at {L.end:g} s, after the scene ends ({sdur:g} s); the end is cut off")
            L.end = sdur
        if L.end <= L.start and L.start < sdur - 1e-6:
            self.err(w, f"ends ({L.end:g} s) before it starts ({L.start:g} s)")
        if L.end <= L.start:
            L.end = L.start + 0.01
        shape_free = kind == "shape" and d.get("shape") in ("line", "polygon", "path")
        L.anchor = ANCHORS[d.get("anchor", "center")]
        L.anchor_name = d.get("anchor", "center")
        L.cam = float(d["camera"]) if isinstance(d.get("camera"), (int, float)) and not isinstance(d.get("camera"), bool) else (1.0 if d.get("camera", kind == "image") else 0.0)
        L.safe_check = d.get("safe", True)
        L.direction = d.get("direction") or (d.get("enter") or {}).get("direction") or (d.get("exit") or {}).get("direction") or "right"
        b = L.base
        b["x"] = float(d.get("x", 0.0 if shape_free else 0.5))
        b["y"] = float(d.get("y", 0.0 if shape_free else 0.5))
        b["scale"], b["rotation"], b["opacity"] = float(d.get("scale", 1.0)), float(d.get("rotation", 0.0)), float(d.get("opacity", 1.0))
        b["reveal"] = float(d.get("reveal", 1.0))
        b["w"], b["h"] = d.get("w"), d.get("h")
        L.reveal_style = d.get("reveal_style")
        if kind == "text":
            self.compile_text(L, d, w)
        elif kind == "shape":
            self.compile_shape(L, d, w)
        elif kind == "image":
            self.compile_image(L, d, w)
        self.compile_motion(L, d, w)
        return L

    def compile_text(self, L, d, w):
        m = self.m
        fname = d.get("font", DEFAULT_FONT)
        L.font = self.font_for(fname)
        if L.font is None:
            self.err(w, f'font "{fname}" is not declared in "fonts" and is not a pinned Google family ({", ".join(FONT_PINS)}). Fix: declare it under "fonts" or use one of those names.')
            L.font = self.font_for(DEFAULT_FONT)
        L.text = d.get("text", "")
        L.count = d.get("count")
        L.size = float(d.get("size", 6.0))
        L.weight = int(d.get("weight", 400))
        L.italic = bool(d.get("italic", False))
        L.align = d.get("align", "center")
        L.box = d.get("box")
        L.line_height = float(d.get("line_height", 1.2))
        L.ls = float(d.get("letter_spacing", 0.0))
        L.color = parse_color(d.get("color", "#ffffff"))
        L.base["color"] = L.color
        L.shadow = d.get("shadow")
        if L.shadow is True:
            L.shadow = {}
        elif L.shadow is False:
            L.shadow = None
        if L.shadow is not None:
            L.shadow = {"color": parse_color(L.shadow.get("color", "#000000b3")), "blur": float(L.shadow.get("blur", 0.9)), "dx": float(L.shadow.get("dx", 0.0)), "dy": float(L.shadow.get("dy", 0.35))}
        bk, ol = opt(d.get("backing")), opt(d.get("outline"))
        L.backing = {"color": parse_color(bk.get("color", "#000000b3")), "pad": float(bk.get("pad", 1.6)), "radius": float(bk.get("radius", 1.2))} if bk is not None else None
        L.outline = {"color": parse_color(ol.get("color", "#000000")), "width": float(ol.get("width", 0.25))} if ol is not None else None
        if L.count:
            c = L.count
            L.count = {"from": float(c.get("from", 0)), "to": float(c["to"]), "decimals": int(c.get("decimals", 0)), "thousands": bool(c.get("thousands", True)), "at": float(c.get("at", 0.0)), "duration": float(c.get("duration", 1.2)), "ease": self.ease(c.get("ease"), "easeOutCubic")}
            if "{n}" not in L.text:
                self.err(w, 'has "count" but its text has no {n} to put the number in. Fix: write the text like "{n} riders" or "{n}%".')
        L.words = max(1, len(L.final_text().split()))
        L.chars = len(L.final_text())

    def compile_shape(self, L, d, w):
        L.shape = d.get("shape", "rect")
        for k in sorted(SHAPE_ONLY & set(d)):
            if k not in SHAPE_FIELDS[L.shape]:
                self.err(w, f'a {L.shape} does not use "{k}", so it would be ignored. Fix: remove it. A {L.shape} takes {", ".join(sorted(SHAPE_FIELDS[L.shape]))}.')
        if L.shape in ("line", "polygon", "path") and "anchor" in d:
            self.err(w, f'a {L.shape} has no "anchor": its points are placed by themselves, and "x" and "y" move it. Fix: remove "anchor".')
        L.fill = parse_paint(d["fill"]) if "fill" in d else (("solid", (255.0, 255.0, 255.0, 1.0)) if L.shape not in ("line",) and d.get("stroke") in (None, False) else None)
        st = opt(d.get("stroke"))
        L.stroke = {"color": parse_color(st.get("color", "#ffffff")), "width": float(st.get("width", 0.4)), "round": bool(st.get("round", True))} if st is not None else None
        if L.shape == "line" and not L.stroke:
            L.stroke = {"color": parse_color("#ffffff"), "width": 0.4, "round": True}
        L.radius = float(d.get("radius", 1.5 if L.shape == "rounded" else 0.0))
        if L.shape in ("line", "polygon", "path") and L.stroke and not L.fill and "direction" in d:
            self.err(w, f'a stroked {L.shape} without a fill draws itself along its length, so "direction" would be ignored. Fix: remove "direction", or give it a "fill".')
        L.base["color"] = L.fill[1] if (L.fill and L.fill[0] == "solid") else (L.stroke["color"] if L.stroke else (255.0, 255.0, 255.0, 1.0))
        L.paths = None
        try:
            if L.shape == "line":
                f, t = d.get("from"), d.get("to")
                if not f or not t:
                    self.err(w, 'a line needs "from" and "to", each [x, y] as fractions of the frame')
                    f, t = [0.1, 0.5], [0.9, 0.5]
                L.paths = [([tuple(f), tuple(t)], False)]
            elif L.shape == "polygon":
                pts = d.get("points")
                if not pts or len(pts) < 3:
                    self.err(w, 'a polygon needs "points": at least 3 [x, y] pairs as fractions of the frame')
                    pts = [[0.4, 0.4], [0.6, 0.4], [0.5, 0.6]]
                L.paths = [([tuple(p) for p in pts], True)]
            elif L.shape == "path":
                if not d.get("d"):
                    self.err(w, 'a path needs "d", for example "M 0.1 0.5 C 0.3 0.1 0.6 0.9 0.9 0.5" (fractions of the frame)')
                    L.paths = [([(0.1, 0.5), (0.9, 0.5)], False)]
                else:
                    L.paths = parse_path(d["d"])
            else:
                if d.get("w") is None:
                    self.err(w, f'a {L.shape} needs "w" (fraction of frame width)' + ("" if L.shape == "circle" else ' and "h" (fraction of frame height)'))
                    L.base["w"] = 0.1
                if L.shape != "circle" and d.get("h") is None:
                    if L.shape in ("rect", "rounded", "ellipse"):
                        self.err(w, f'a {L.shape} needs "h" (fraction of frame height)')
                    L.base["h"] = 0.1
        except ValueError as e:
            self.err(w, f"bad path: {e}")
            L.paths = [([(0.1, 0.5), (0.9, 0.5)], False)]

    def compile_image(self, L, d, w):
        f = d.get("file", "")
        L.fit = d.get("fit", "cover")
        L.focus = tuple(d.get("focus", [0.5, 0.5]))
        L.dim = float(d.get("dim", 0.0))
        L.radius = float(d.get("radius", 0.0))
        L.base["w"] = float(d.get("w", 1.0))
        L.base["h"] = float(d.get("h", 1.0))
        if f.startswith("sample:"):
            if f[7:] not in SAMPLES:
                self.err(w, f'there is no "{f}"; samples are {", ".join("sample:" + k for k in SAMPLES)}')
            L.path = None
        else:
            L.path = resolve_path(f, self.base)
            if not L.path.exists():
                self.err(w, f'image file "{f}" does not exist (looked in {L.path.parent}). Fix: give the path relative to the spec file, or use "sample:dusk" to try the layout.')

    # ---- motion
    def compile_motion(self, L, d, w):
        dur = L.dur
        b = L.base
        enter, exit_ = d.get("enter"), d.get("exit")
        segs = {}

        def add(prop, seg):
            segs.setdefault(prop, []).append(seg)

        dirs = {x for x in (d.get("direction"), (enter or {}).get("direction"), (exit_ or {}).get("direction")) if x}
        if len(dirs) > 1:
            self.err(w, f'has {len(dirs)} different directions ({", ".join(sorted(dirs))}) but a layer wipes one way, so all but one would be ignored. Fix: keep one "direction".')
        # explicit tweens first
        for a in d.get("animate", []) or []:
            prop = a["prop"]
            if prop == "color":
                if L.kind == "image":
                    self.err(w, 'images have no "color" to animate. Fix: animate "opacity" instead.')
                    continue
                try:
                    to = parse_color(a["to"])
                    frm = parse_color(a["from"]) if "from" in a else b.get("color", (255.0, 255.0, 255.0, 1.0))
                except ValueError as e:
                    self.err(w, f"animate color: {e}")
                    continue
                if L.kind == "shape" and L.fill and L.fill[0] == "grad":
                    self.err(w, "animates color but its fill is a gradient. Fix: give it a solid fill color.")
                    continue
                add("color", Seg(float(a.get("at", 0.0)), float(a.get("duration", 0.6)), self.ease(a.get("ease"), "easeInOutCubic"), frm, to))
                continue
            if prop in ("w", "h") and L.kind == "text":
                self.err(w, f'text has no "{prop}" to animate. Fix: animate "scale" instead.')
                continue
            if prop == "reveal" and L.kind == "image":
                pass
            to = a["to"]
            if not isinstance(to, (int, float)) or isinstance(to, bool):
                self.err(w, f'animate {prop}: "to" must be a number')
                continue
            frm = a.get("from", b[prop] if b.get(prop) is not None else (1.0 if prop == "reveal" else 0.0))
            if frm is None:
                frm = 0.0
            add(prop, Seg(float(a.get("at", 0.0)), float(a.get("duration", 0.6)), self.ease(a.get("ease"), "easeInOutCubic"), float(frm), float(to)))
        # presets
        if enter:
            self.apply_preset(L, d, enter, "enter", segs, w)
        if exit_:
            self.apply_preset(L, d, exit_, "exit", segs, w)
        for prop, lst in segs.items():
            lst.sort(key=lambda s: s.at)
            for s1, s2 in zip(lst, lst[1:]):
                if s2.at < s1.end - 1e-6 and s1.src != s2.src:
                    self.warn(w, f'"{prop}" is moved by {s1.src} and by {s2.src} at the same time ({s2.at:g} s to {min(s1.end, s2.end):g} s); the later one wins. Fix: separate them in time.')
        L.segs = segs
        if L.kind == "text" and L.count:
            c = L.count
            L.count_seg = Seg(c["at"], c["duration"], c["ease"], c["from"], c["to"], "count")
        if L.reveal_style is None:
            L.reveal_style = "type" if L.kind == "text" and not (enter and enter["type"] == "wipe") else "wipe"
        # one animation clock: where the last move ends, for the "scene shorter than its animations" check
        ends = [s.end for lst in segs.values() for s in lst]
        if L.kind == "text" and L.count:
            ends.append(L.count["at"] + L.count["duration"])
        if L.split:
            L.units = split_units(L, self.layout_renderer())
            ends += [s.end + (L.units - 1) * L.stagger for lst in L.unit_segs.values() for s in lst]
        L.anim_end = max(ends) if ends else 0.0

    def refuse_unused(self, L, pd, kind, phase, w):
        """The schema lets every field sit on every enter and exit; each one a preset does not read is an error, never ignored."""

        def unused(field, why):
            if field in pd:
                self.err(w, f'{phase} "{kind}" does not use "{field}" ({why}), so it would be ignored. Fix: remove it.')

        for field in ("split", "stagger"):
            if phase != "enter":
                unused(field, "only an enter splits")
            elif L.kind != "text":
                unused(field, "only text splits into words, lines or characters")
            elif kind not in SPLIT_KINDS:
                unused(field, f'"{kind}" cannot split; fade, rise, drop, slide-from-left, slide-from-right, zoom and pop can')
        if "stagger" in pd and "split" not in pd and phase == "enter" and L.kind == "text" and kind in SPLIT_KINDS:
            unused("stagger", 'it spaces the pieces of a "split"')
        if kind not in ("rise", "drop", "slide-from-left", "slide-from-right", "slide-to-left", "slide-to-right"):
            unused("distance", "only rise, drop and the slides travel")
        if kind not in ("wipe", "grow", "draw"):
            unused("direction", "only wipe, grow and draw have one")
        elif L.kind == "shape" and L.shape == "circle" and kind == "grow":
            unused("direction", "a circle grows from its middle")
        elif L.kind == "shape" and L.shape in ("line", "polygon", "path") and not L.fill and kind in ("wipe", "draw"):
            unused("direction", f"a stroked {L.shape} without a fill draws itself along its length")

    def apply_preset(self, L, d, pd, phase, segs, w):
        kind = pd["type"]
        b = L.base
        is_enter = phase == "enter"
        text_only = {"type"}
        shape_only = {"draw"}
        if kind in text_only and L.kind != "text":
            self.err(w, f'"{kind}" only works on text. Fix: use "wipe" or "fade" for a {L.kind}.')
            return
        if kind == "draw" and not (L.kind == "shape" and L.shape in ("line", "polygon", "path")):
            self.err(w, '"draw" only works on line, polygon and path shapes. Fix: use "wipe".')
            return
        if kind == "grow" and not (L.kind == "shape" and L.shape in ("rect", "rounded", "ellipse", "circle")):
            self.err(w, '"grow" only works on rect, rounded, circle and ellipse shapes. Fix: use "wipe" or "zoom".')
            return
        if not is_enter and kind not in ("fade", "rise", "drop", "slide-to-left", "slide-to-right", "zoom", "wipe"):
            self.err(w, f'exit "{kind}" is not an exit; use fade, rise, drop, slide-to-left, slide-to-right, zoom or wipe')
            return
        if is_enter and kind in ("slide-to-left", "slide-to-right"):
            self.err(w, f'enter "{kind}" is an exit; use slide-from-left or slide-from-right')
            return
        self.refuse_unused(L, pd, kind, phase, w)
        dur = float(pd.get("duration", (ENTER_DUR.get(kind, 0.6) if is_enter else EXIT_DUR)))
        if kind == "type" and "duration" not in pd:
            dur = clamp(L.chars * 0.045, 0.5, 3.0)
        delay = float(pd.get("delay", 0.0)) if is_enter else 0.0
        at = delay if is_enter else max(0.0, L.dur - dur)
        dist = pd.get("distance")
        src = phase
        if is_enter and pd.get("split") and L.kind == "text":
            L.split = pd["split"]
            L.stagger = float(pd.get("stagger", 0.08))
        target = L.unit_segs if (is_enter and L.split and kind in SPLIT_KINDS) else segs

        def put(prop, a, bb, ease, dd=None, off=0.0):
            s = Seg(at + off, dur if dd is None else dd, ease, a, bb, src)
            target.setdefault(prop, []).append(s)

        ease = self.ease(pd.get("ease"), None)
        x, y, sc = b["x"], b["y"], b["scale"]
        op = b["opacity"]
        if is_enter:
            if kind == "fade":
                put("opacity", 0.0, op, ease or "easeOutSine")
            elif kind == "rise":
                put("opacity", 0.0, op, "easeOutSine", dur * 0.7)
                put("y", y + (0.04 if dist is None else dist), y, ease or "easeOutCubic")
            elif kind == "drop":
                put("opacity", 0.0, op, "easeOutSine", dur * 0.7)
                put("y", y - (0.04 if dist is None else dist), y, ease or "easeOutCubic")
            elif kind == "slide-from-left":
                put("opacity", 0.0, op, "easeOutSine", dur * 0.6)
                put("x", x - (0.08 if dist is None else dist), x, ease or "easeOutCubic")
            elif kind == "slide-from-right":
                put("opacity", 0.0, op, "easeOutSine", dur * 0.6)
                put("x", x + (0.08 if dist is None else dist), x, ease or "easeOutCubic")
            elif kind == "zoom":
                put("opacity", 0.0, op, "easeOutSine", dur * 0.7)
                put("scale", sc * 0.9, sc, ease or "easeOutCubic")
            elif kind == "pop":
                put("opacity", 0.0, op, "easeOutCubic", dur * 0.5)
                put("scale", sc * 0.6, sc, ease or "easeOutBack")
            elif kind == "type":
                put("reveal", 0.0, 1.0, ease or "linear")
            elif kind == "wipe":
                put("reveal", 0.0, 1.0, ease or "easeInOutCubic")
            elif kind == "draw":
                put("reveal", 0.0, 1.0, ease or "easeInOutCubic")
            elif kind == "grow":
                horiz = L.direction in ("left", "right")
                prop = "w" if horiz else "h"
                full = b.get(prop)
                if full is None and L.shape == "circle":
                    prop, full = "w", b["w"]
                if full is None:
                    return
                put(prop, 0.0, float(full), ease or "easeOutCubic")
        else:
            if kind == "fade":
                put("opacity", op, 0.0, ease or "easeInSine")
            elif kind == "rise":
                put("opacity", op, 0.0, "easeInSine")
                put("y", y, y - (0.03 if dist is None else dist), ease or "easeInCubic")
            elif kind == "drop":
                put("opacity", op, 0.0, "easeInSine")
                put("y", y, y + (0.03 if dist is None else dist), ease or "easeInCubic")
            elif kind == "slide-to-left":
                put("opacity", op, 0.0, "easeInSine")
                put("x", x, x - (0.08 if dist is None else dist), ease or "easeInCubic")
            elif kind == "slide-to-right":
                put("opacity", op, 0.0, "easeInSine")
                put("x", x, x + (0.08 if dist is None else dist), ease or "easeInCubic")
            elif kind == "zoom":
                put("opacity", op, 0.0, "easeInSine")
                put("scale", sc, sc * 1.12, ease or "easeInCubic")
            elif kind == "wipe":
                put("reveal", 1.0, 0.0, ease or "easeInOutCubic")
                if L.kind == "text":
                    L.exit_wipe_at = at  # text types its reveal by default; from here the edge wipes it away

    # ---- bars (a chart expands into ordinary layers, so every check applies to it)
    def expand_bars(self, sc, d, j):
        w = f'{sc.name} layer {j + 1}' + (f' "{d["id"]}"' if d.get("id") else "") + " (bars)"
        data = d["data"]
        n = len(data)
        cx, cy = d.get("x", 0.5), d.get("y", 0.55)
        cw, ch = d.get("w", 0.8), d.get("h", 0.62)
        anchor = ANCHORS[d.get("anchor", "center")]
        left, top = cx - anchor[0] * cw, cy - anchor[1] * ch
        font = d.get("font", DEFAULT_FONT)
        Hpx = self.m.H
        lab_sz, val_sz = float(d.get("label_size", 3.2)), float(d.get("value_size", 4.2))
        lab_h = lab_sz * 1.9 / 100
        val_h = val_sz * 1.9 / 100
        base_y = top + ch - lab_h
        max_bar = ch - lab_h - val_h
        vmax = float(d.get("max") or max(float(x["value"]) for x in data))
        if vmax <= 0:
            self.err(w, "the largest value must be above 0")
            vmax = 1.0
        slot = cw / n
        gap = float(d.get("gap", 0.35))
        bw = slot * (1 - gap)
        g = d.get("grow", {})
        dur, stag, at0 = float(g.get("duration", 1.1)), float(g.get("stagger", 0.14)), float(g.get("at", 0.2))
        ease = g.get("ease", "easeOutCubic")
        decimals, prefix, suffix = int(d.get("decimals", 0)), d.get("prefix", ""), d.get("suffix", "")
        out = []
        common = {"start": d.get("start", 0.0), "end": d.get("end", sc.dur), "_group": f"bars{j}"}
        for k in ("exit", "safe", "camera"):  # what a chart shares with its parts; the schema refuses the rest
            if k in d:
                common[k] = d[k]
        axis = {**common, "type": "shape", "shape": "rect", "x": left + cw / 2, "y": base_y, "w": cw, "h": 0.003, "anchor": "top", "fill": d.get("axis_color", "#ffffff55"), "_group": f"bars{j}a"}
        out.append(axis)
        for i, item in enumerate(data):
            v = float(item["value"])
            hh = max_bar * v / vmax
            xc = left + slot * (i + 0.5)
            col = item.get("color", d.get("color", "#4f8cff"))
            t0 = at0 + i * stag
            bar = {**common, "type": "shape", "shape": "rounded", "radius": float(d.get("radius", 0.9)), "x": xc, "y": base_y, "w": bw, "h": hh, "anchor": "bottom", "fill": col, "animate": [{"prop": "h", "from": 0.0, "to": hh, "at": t0, "duration": dur, "ease": ease}]}
            val = {**common, "type": "text", "font": font, "weight": int(d.get("value_weight", 700)), "size": val_sz, "color": d.get("value_color", "#ffffff"), "text": f"{prefix}{{n}}{suffix}", "x": xc, "y": base_y - hh - 0.012, "anchor": "bottom", "count": {"from": 0, "to": v, "decimals": decimals, "at": t0, "duration": dur, "ease": ease, "thousands": True}, "animate": [{"prop": "y", "from": base_y - 0.012, "to": base_y - hh - 0.012, "at": t0, "duration": dur, "ease": ease}, {"prop": "opacity", "from": 0.0, "to": 1.0, "at": t0, "duration": 0.15, "ease": "linear"}]}
            lab = {**common, "type": "text", "font": font, "weight": int(d.get("label_weight", 500)), "size": lab_sz, "color": d.get("label_color", "#d6dbe8"), "text": str(item["label"]), "x": xc, "y": base_y + 0.014, "anchor": "top", "box": slot * 0.96, "animate": [{"prop": "opacity", "from": 0.0, "to": 1.0, "at": t0, "duration": 0.4, "ease": "easeOutSine"}]}
            out += [bar, val, lab]
        layers = []
        for k, ld in enumerate(out):
            L = self.compile_layer(sc, ld, j)
            L.label = f"{w} {L.kind}" + (f' "{snippet(ld.get("text", ""))}"' if L.kind == "text" else "")
            L.group = ld["_group"] if ld["_group"].endswith("a") else f"bars{j}"
            layers.append(L)
        return layers

    # ---- captions
    def compile_captions(self, cd):
        m = self.m
        if not cd:
            return
        cues = list(cd.get("cues", []))
        if cd.get("srt"):
            p = resolve_path(cd["srt"], self.base)
            if not p.exists():
                self.err("captions", f'SRT file "{cd["srt"]}" does not exist (looked in {p.parent})')
            else:
                try:
                    cues += parse_srt(p.read_text(encoding="utf-8-sig"))
                except Exception as e:  # noqa: BLE001
                    self.err("captions", f"could not read the SRT: {e}")
        pos = cd.get("position", "bottom")
        ypos = {"bottom": (1 - m.safe - 0.03, "bottom"), "top": (m.safe + 0.03, "top"), "center": (0.5, "center")}[pos]
        for i, c in enumerate(cues):
            if c["end"] <= c["start"]:
                self.err(f"captions cue {i + 1}", f"ends ({c['end']:g} s) before it starts ({c['start']:g} s)")
                continue
            d = {
                "type": "text", "text": c["text"], "font": cd.get("font", DEFAULT_FONT), "weight": int(cd.get("weight", 600)), "size": float(cd.get("size", 3.9)),
                "color": cd.get("color", "#ffffff"), "x": 0.5, "y": ypos[0], "anchor": ypos[1], "box": float(cd.get("box", 0.8)), "align": "center", "line_height": 1.25,
                "start": c["start"], "end": c["end"],
                "backing": cd.get("backing", {"color": "#000000b8", "pad": 1.1, "radius": 0.9}),
                "enter": {"type": "fade", "duration": min(0.1, (c["end"] - c["start"]) / 4)}, "exit": {"type": "fade", "duration": min(0.1, (c["end"] - c["start"]) / 4)},
            }
            if opt(cd.get("shadow")) is not None:
                d["shadow"] = cd["shadow"]
            L = self.compile_layer(None, d, i, global_dur=max(c["end"], 0.1))
            L.label = f'captions cue {i + 1} ("{snippet(c["text"])}")'
            L.overlay = True
            L.cue = c
            m.overlay.append(L)
        if m.overlay:
            last = max(L.end for L in m.overlay)
            if last > m.duration + 0.05:
                self.warn("captions", f"the last cue ends at {last:g} s, after the video ends ({m.duration:g} s); it is cut off")


def _final_text(self):
    t = self.text
    if getattr(self, "count", None):
        t = t.replace("{n}", fmt_number(self.count["to"], self.count["decimals"], self.count["thousands"]))
    return t


Layer.final_text = _final_text


def compile_spec(path):
    """Read, validate and compile a spec file. Returns (model | None, problems)."""
    path = Path(path)
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except OSError as e:
        return None, [Problem("error", "spec", f"cannot read {path}: {e}")]
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as e:
        return None, [Problem("error", "spec", f"is not valid JSON: {e.msg} at line {e.lineno}, column {e.colno}. Fix: check commas and quotes near there.")]
    errs = schema_errors(spec, load_schema(), load_schema())
    problems = [Problem("error", p, m_) for p, m_ in errs]
    if errs:
        # a spec with schema problems still gets its other problems reported when it compiles at all
        try:
            m = Compiler(spec, path.parent, problems).compile()
            return m, m.problems
        except Exception:  # noqa: BLE001 - a broken structure cannot be compiled; the schema problems say why
            return None, problems
    m = Compiler(spec, path.parent, problems).compile()
    return m, m.problems


# --------------------------------------------------------------------------------------------
# Drawing
# --------------------------------------------------------------------------------------------
def alpha_over(dst: Image.Image, src: Image.Image, x: int, y: int):
    """Composite src onto dst (both RGBA) at (x, y), clipping to dst."""
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.width, x + src.width), min(dst.height, y + src.height)
    if x1 <= x0 or y1 <= y0:
        return
    piece = src.crop((x0 - x, y0 - y, x1 - x, y1 - y))
    dst.alpha_composite(piece, (x0, y0))


def over(frame, patch: Image.Image, x: int, y: int, opacity: float = 1.0):
    """Composite an RGBA patch onto the opaque float32 frame (H, W, 3)."""
    H, W = frame.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + patch.width), min(H, y + patch.height)
    if x1 <= x0 or y1 <= y0 or opacity <= 0:
        return
    arr = np.asarray(patch.crop((x0 - x, y0 - y, x1 - x, y1 - y)), dtype=np.float32)
    region = frame[y0:y1, x0:x1]
    if patch.mode == "RGB":  # an opaque photo: no per-pixel alpha to work through
        if opacity >= 0.9999:
            region[...] = arr
        else:
            region *= 1.0 - opacity
            region += arr * opacity
        return
    a = arr[..., 3:4] * (opacity / 255.0)
    region *= 1.0 - a
    region += arr[..., :3] * a


def finish(img2x: Image.Image, left2x: int, top2x: int):
    """Reduce a 2x patch to 1x with a box filter, aligned so (left2x, top2x) land on the right half pixel.
    Returns (image, x, y) in 1x frame pixels."""
    ox, oy = left2x & 1, top2x & 1
    w, h = img2x.width + ox, img2x.height + oy
    w2, h2 = w + (w & 1), h + (h & 1)
    if (ox, oy) != (0, 0) or (w2, h2) != img2x.size:
        canvas = Image.new("RGBA", (w2, h2), (0, 0, 0, 0))
        canvas.paste(img2x, (ox, oy))
        img2x = canvas
    return img2x.resize((img2x.width // 2, img2x.height // 2), Image.BOX), left2x >> 1, top2x >> 1


def rot_point(px, py, cx, cy, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    dx, dy = px - cx, py - cy
    return cx + dx * c - dy * s, cy + dx * s + dy * c


def rotate_patch(img: Image.Image, pivot, deg):
    """Rotate an RGBA patch clockwise by deg about pivot, on a canvas big enough to hold it. Returns (img, new pivot)."""
    px, py = pivot
    r = int(math.ceil(max(math.hypot(px - cx, py - cy) for cx in (0, img.width) for cy in (0, img.height)))) + 2
    canvas = Image.new("RGBA", (2 * r, 2 * r), (0, 0, 0, 0))
    canvas.paste(img, (int(round(r - px)), int(round(r - py))))
    return canvas.rotate(-deg, resample=Image.BICUBIC, center=(r, r)), (r, r)


def ramp_mask(w, h, reveal, direction, feather):
    """float32 (h, w) alpha: 1 where revealed. direction is the way the wipe travels."""
    reveal = clamp(reveal, 0.0, 1.0)
    if direction in ("right", "left"):
        n, line = w, np.arange(w, dtype=np.float32)
    else:
        n, line = h, np.arange(h, dtype=np.float32)
    edge = reveal * (n + feather)
    if direction in ("left", "up"):
        line = (n - 1) - line
    m = np.clip((edge - line) / max(feather, 1.0), 0, 1)
    return np.broadcast_to(m[None, :], (h, w)) if direction in ("right", "left") else np.broadcast_to(m[:, None], (h, w))


def apply_alpha_mask(img: Image.Image, mask: np.ndarray):
    arr = np.array(img)
    arr[..., 3] = (arr[..., 3].astype(np.float32) * mask).round().astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


class Renderer:
    """Draws frames of a compiled model at a chosen output size."""

    def __init__(self, model, scale=1.0):
        self.m = model
        self.W = max(2, int(round(model.W * scale / 2)) * 2)
        self.H = max(2, int(round(model.H * scale / 2)) * 2)
        self.cache = OrderedDict()
        self.cache_px = 0
        self.bgs = {}
        self.sources = {}
        self.layouts = {}
        self.vh = self.H / 100.0

    # ---- caches
    def cget(self, key):
        v = self.cache.get(key)
        if v is not None:
            self.cache.move_to_end(key)
        return v

    def cput(self, key, val):
        self.cache[key] = val
        self.cache_px += val[0].width * val[0].height
        while self.cache_px > 70_000_000 and len(self.cache) > 1:
            _, old = self.cache.popitem(last=False)
            self.cache_px -= old[0].width * old[0].height

    # ---- paint
    def paint_array(self, paint, w, h, box=None):
        kind, v = paint
        if kind == "solid":
            return np.broadcast_to(np.array(v, dtype=np.float32), (h, w, 4))
        bx, by, bw, bh = box or (0, 0, w, h)
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        xs += 0.5
        ys += 0.5
        stops = v["stops_parsed"]
        pos = [s[0] for s in stops]
        if v.get("type", "linear") == "radial":
            fx, fy = v.get("center", [0.5, 0.5])
            rad = float(v.get("radius", 0.75)) * max(bw, bh)
            t = np.hypot(xs - (bx + fx * bw), ys - (by + fy * bh)) / max(rad, 1e-6)
        else:
            a = math.radians(float(v.get("angle", 180)))
            dx, dy = math.sin(a), -math.cos(a)
            length = abs(bw * dx) + abs(bh * dy)
            t = ((xs - (bx + bw / 2)) * dx + (ys - (by + bh / 2)) * dy) / max(length, 1e-6) + 0.5
        t = np.clip(t, 0, 1)
        out = np.empty((h, w, 4), dtype=np.float32)
        for c in range(4):
            out[..., c] = np.interp(t, pos, [s[1][c] for s in stops])
        return out

    def background(self, scene_or_paint):
        key = id(scene_or_paint)
        if key in self.bgs:
            return self.bgs[key]
        paint = scene_or_paint
        arr = self.paint_array(paint, self.W, self.H)
        rgb = arr[..., :3] * arr[..., 3:4]
        rgb = np.array(rgb, dtype=np.float32)
        if paint[0] == "grad":  # 1-level dither so smooth gradients do not band after encoding
            noise = np.random.RandomState(1234).random_sample((self.H, self.W, 1)).astype(np.float32)
            rgb += (noise - 0.5) * 1.4
        self.bgs[key] = rgb
        return rgb

    # ---- geometry shared by drawing and checks
    def cam_at(self, scene, lt):
        c = scene.camera if scene else None
        if not c:
            return (1.0, 0.5, 0.5)
        p = progress(lt, 0.0, scene.dur, c["ease"])
        return lerp(c["a"], c["b"], p)

    def state(self, L, llt):
        st = {}
        for p in ("x", "y", "scale", "rotation", "opacity", "reveal"):
            segs = L.segs.get(p)
            st[p] = seg_value(segs, llt, L.base[p]) if segs else L.base[p]
        for p in ("w", "h"):
            segs = L.segs.get(p)
            st[p] = seg_value(segs, llt, L.base[p]) if segs else L.base[p]
        segs = L.segs.get("color")
        st["color"] = seg_value(segs, llt, L.base.get("color")) if segs else L.base.get("color")
        return st

    def cam_factor(self, L, cam):
        f = L.cam
        z = 1 + (cam[0] - 1) * f
        return z, 0.5 + (cam[1] - 0.5) * f, 0.5 + (cam[2] - 0.5) * f

    def to_frame(self, L, fx, fy, cam):
        """Point in frame fractions -> frame pixels, through the camera."""
        px, py = fx * self.W, fy * self.H
        if L.cam:
            z, cx, cy = self.cam_factor(L, cam)
            px = self.W / 2 + (px - cx * self.W) * z
            py = self.H / 2 + (py - cy * self.H) * z
        return px, py

    # ---- text
    def positions(self, s, font, ls, tab, digw):
        n = len(s)
        if ls == 0 and not tab:
            pos = [font.getlength(s[:i]) for i in range(n + 1)]
            return pos
        pos, x = [], 0.0
        for i, ch in enumerate(s):
            pos.append(x)
            if tab and ch.isdigit():
                adv = digw
            elif i + 1 < n:
                adv = font.getlength(s[i : i + 2]) - font.getlength(s[i + 1 : i + 2])
            else:
                adv = font.getlength(ch)
            x += adv + ls
        pos.append(x - ls if n else 0.0)
        return pos

    def layout(self, L, string):
        key = (L.uid, string)
        lay = self.layouts.get(key)
        if lay is not None:
            return lay
        size2 = L.size * self.vh * SS
        font = load_font(L.font, size2, L.weight, L.italic)
        asc, desc = font.getmetrics()
        pitch = size2 * L.line_height
        ls = L.ls * self.vh * SS
        tab = bool(L.count)
        digw = max(font.getlength(c) for c in "0123456789")
        box2 = L.box * self.W * SS if L.box else None
        raw = []
        for para in string.split("\n"):
            if box2 is None:
                raw.append(para)
                continue
            cur = ""
            for wd in para.split(" "):
                trial = (cur + " " + wd) if cur else wd
                if not cur or self.positions(trial, font, ls, tab, digw)[-1] <= box2:
                    cur = trial
                else:
                    raw.append(cur)
                    cur = wd
            raw.append(cur)
        lines = []
        for s in raw:
            pos = self.positions(s, font, ls, tab, digw)
            lines.append({"s": s, "pos": pos, "w": pos[-1]})
        bw = box2 if box2 else max((ln["w"] for ln in lines), default=0.0)
        top = (pitch - (asc + desc)) / 2
        ix0 = iy0 = 1e9
        ix1 = iy1 = -1e9
        for i, ln in enumerate(lines):
            ln["x"] = {"left": 0.0, "center": (bw - ln["w"]) / 2, "right": bw - ln["w"]}[L.align]
            ln["base"] = i * pitch + top + asc
            if ln["s"].strip():
                l, t, r, b = font.getbbox(ln["s"], anchor="ls")
                if ls or tab:
                    l, r = 0, ln["w"]
                ix0, ix1 = min(ix0, ln["x"] + l), max(ix1, ln["x"] + max(r, ln["w"] if (ls or tab) else r))
                iy0, iy1 = min(iy0, ln["base"] + t), max(iy1, ln["base"] + b)
        if ix0 > ix1:
            ix0, iy0, ix1, iy1 = 0, 0, 0, 0
        lay = {"lines": lines, "w": bw, "h": pitch * len(lines), "asc": asc, "desc": desc, "pitch": pitch, "ink": (ix0, iy0, ix1, iy1), "size2": size2, "ls": ls, "tab": tab, "box2": box2, "max_line": max((ln["w"] for ln in lines), default=0.0), "digw": digw}
        if len(self.layouts) > 600:
            self.layouts.clear()
        self.layouts[key] = lay
        return lay

    def text_string(self, L, st, llt):
        if L.count:
            n = seg_value([L.count_seg], llt, L.count["from"])
            return L.text.replace("{n}", fmt_number(n, L.count["decimals"], L.count["thousands"]))
        return L.text

    def run_pad(self, L, S):
        pad = 2.0
        if L.outline:
            pad += L.outline["width"] * self.vh * SS * S
        if L.shadow:
            sh = L.shadow
            pad += sh["blur"] * self.vh * SS * S * 2.2 + max(abs(sh["dx"]), abs(sh["dy"])) * self.vh * SS * S
        return int(math.ceil(pad))

    def run_image(self, L, lay, line, a, b, S, color):
        """RGBA image of line['s'][a:b] at scale S (2x pixels) -> (img, ox, oy) where (ox, oy) is the run origin on the baseline."""
        font = load_font(L.font, lay["size2"] * S, L.weight, L.italic)
        pad = self.run_pad(L, S)
        pos = line["pos"]
        x0, x1 = pos[a] * S, pos[b] * S
        asc, desc = lay["asc"] * S, lay["desc"] * S
        w, h = int(math.ceil(x1 - x0)) + 2 * pad + 2, int(math.ceil(asc + desc)) + 2 * pad + 2
        text = line["s"][a:b]
        bx, by = pad + 1, pad + 1 + int(math.ceil(asc))
        sw = int(round(L.outline["width"] * self.vh * SS * S)) if L.outline else 0

        def paint(draw, fill, stroke_fill=None):
            if lay["ls"] == 0 and not lay["tab"]:
                draw.text((bx, by), text, font=font, fill=fill, anchor="ls", stroke_width=sw if stroke_fill else 0, stroke_fill=stroke_fill)
            else:
                for i, ch in enumerate(text):
                    gx = bx + (pos[a + i] - pos[a]) * S
                    if lay["tab"] and ch.isdigit():
                        gx += (lay["digw"] - font.getlength(ch) / S) * S / 2
                    draw.text((gx, by), ch, font=font, fill=fill, anchor="ls", stroke_width=sw if stroke_fill else 0, stroke_fill=stroke_fill)

        r, g, bl, al = color
        img = Image.new("RGBA", (w, h), (int(r), int(g), int(bl), 0))
        if L.shadow:
            sh = L.shadow
            m = Image.new("L", (w, h), 0)
            d = ImageDraw.Draw(m)
            if lay["ls"] == 0 and not lay["tab"]:
                d.text((bx + sh["dx"] * self.vh * SS * S, by + sh["dy"] * self.vh * SS * S), text, font=font, fill=255, anchor="ls")
            else:
                for i, ch in enumerate(text):
                    d.text((bx + (pos[a + i] - pos[a]) * S + sh["dx"] * self.vh * SS * S, by + sh["dy"] * self.vh * SS * S), ch, font=font, fill=255, anchor="ls")
            m = m.filter(ImageFilter.GaussianBlur(max(0.1, sh["blur"] * self.vh * SS * S)))
            sa = (np.asarray(m, dtype=np.float32) * sh["color"][3]).round().astype(np.uint8)
            simg = Image.new("RGBA", (w, h), (int(sh["color"][0]), int(sh["color"][1]), int(sh["color"][2]), 0))
            simg.putalpha(Image.fromarray(sa, "L"))
            img = simg
        d = ImageDraw.Draw(img)
        fill = (int(r), int(g), int(bl), int(round(al * 255)))
        if L.outline:
            oc = L.outline["color"]
            paint(d, fill, (int(oc[0]), int(oc[1]), int(oc[2]), int(round(oc[3] * 255))))
        else:
            paint(d, fill)
        return img, bx, by

    def text_units(self, L, lay, nshown):
        """[(line index, a, b)] runs to draw: whole lines, or words / characters when the layer splits."""
        units, left = [], nshown
        for li, ln in enumerate(lay["lines"]):
            n = len(ln["s"])
            take = min(n, left) if left is not None else n
            if left is not None:
                left -= n
            if take <= 0:
                continue
            if L.split == "word":
                for m in re.finditer(r"\S+", ln["s"]):
                    if m.start() < take:
                        units.append((li, m.start(), min(m.end(), take)))
            elif L.split == "char":
                for i, ch in enumerate(ln["s"][:take]):
                    if ch != " ":
                        units.append((li, i, i + 1))
            else:
                units.append((li, 0, take))
        return units

    def block_dims(self, L, lay, S):
        return lay["w"] * S, lay["h"] * S

    def backing_pad(self, L, S):
        return L.backing["pad"] * self.vh * SS * S if L.backing else 0.0

    def text_patch(self, L, st, llt, ink, unit_states=None):
        """Draw a text layer's block (unrotated) at 2x. Returns (img, pivot) with the pivot in image pixels."""
        string = self.text_string(L, st, llt)
        lay = self.layout(L, string)
        S = st["scale"] * self._zoom
        color = st["color"]
        total = sum(len(ln["s"]) for ln in lay["lines"])
        reveal = st["reveal"]
        style = self.reveal_style(L, llt)
        typed = style == "type" and reveal < 0.9999
        nshown = int(round(reveal * total)) if typed else None
        bw, bh = lay["w"] * S, lay["h"] * S
        P = int(math.ceil(max(self.run_pad(L, S), self.backing_pad(L, S)))) + 2
        key = None
        if not L.split:
            key = ("txt", L.uid, string, round(S, 4), color, nshown, ink)
            hit = self.cget(key)
            if hit is not None:
                img, piv = hit
                return self.maybe_wipe(L, img, st, P, bw, bh, style), piv
        img = Image.new("RGBA", (int(math.ceil(bw)) + 2 * P, int(math.ceil(bh)) + 2 * P), (0, 0, 0, 0))
        if L.backing:
            bp = self.backing_pad(L, S)
            c = L.backing["color"]
            ImageDraw.Draw(img).rounded_rectangle((P - bp, P - bp, P + bw + bp, P + bh + bp), radius=L.backing["radius"] * self.vh * SS * S, fill=(int(c[0]), int(c[1]), int(c[2]), int(round(c[3] * 255))))
        if ink and string.strip():
            for ui, (li, a, b) in enumerate(self.text_units(L, lay, nshown)):
                ln = lay["lines"][li]
                run, ox, oy = self.run_image(L, lay, ln, a, b, S, color)
                x = P + (ln["x"] + ln["pos"][a]) * S - ox
                y = P + ln["base"] * S - oy
                if L.split and unit_states is not None:
                    u = unit_states(ui)
                    if u["opacity"] <= 0.001:
                        continue
                    if abs(u["scale"] - 1) > 1e-3:
                        nw, nh = max(1, int(run.width * u["scale"])), max(1, int(run.height * u["scale"]))
                        x += (run.width - nw) / 2
                        y += (run.height - nh) / 2
                        run = run.resize((nw, nh), Image.BICUBIC)
                    if u["opacity"] < 0.999:
                        arr = np.array(run)
                        arr[..., 3] = (arr[..., 3] * u["opacity"]).round().astype(np.uint8)
                        run = Image.fromarray(arr, "RGBA")
                    x += u["dx"] * self.W * SS
                    y += u["dy"] * self.H * SS
                alpha_over(img, run, int(round(x)), int(round(y)))
        piv = (P + L.anchor[0] * bw, P + L.anchor[1] * bh)
        if key is not None:
            self.cput(key, (img, piv))
        return self.maybe_wipe(L, img, st, P, bw, bh, style), piv

    def reveal_style(self, L, llt):
        """How a text layer's reveal shows at layer time `llt`: typed or wiped. An exit "wipe" always wipes."""
        if L.exit_wipe_at is not None and llt >= L.exit_wipe_at - 1e-9:
            return "wipe"
        return L.reveal_style

    def maybe_wipe(self, L, img, st, P, bw, bh, style):
        if style == "wipe" and st["reveal"] < 0.9999:
            # the ramp spans the whole patch, so the padding (backing, shadow, outline) is revealed and hidden with the block
            m = ramp_mask(img.width, img.height, st["reveal"], L.direction, max(4.0, 0.08 * (bw if L.direction in ("left", "right") else bh)))
            return apply_alpha_mask(img, m)
        return img

    def unit_state_fn(self, L, llt):
        segs = L.unit_segs
        base = L.base
        stg = L.stagger

        def f(i):
            t = llt - i * stg
            op = seg_value(segs["opacity"], t, 1.0) if "opacity" in segs else 1.0
            dy = (seg_value(segs["y"], t, base["y"]) - base["y"]) if "y" in segs else 0.0
            dx = (seg_value(segs["x"], t, base["x"]) - base["x"]) if "x" in segs else 0.0
            sc = (seg_value(segs["scale"], t, base["scale"]) / base["scale"]) if "scale" in segs else 1.0
            return {"opacity": op, "dx": dx, "dy": dy, "scale": sc}

        return f

    # ---- the pose of a layer: where it sits in the frame
    def anchor_point(self, L, st, cam):
        if L.kind == "shape" and L.paths is not None:
            return None
        return self.to_frame(L, st["x"], st["y"], cam)

    def text_box(self, L, st, llt, cam):
        """Frame-pixel boxes of a text layer: (ink box, block box incl. backing), both as (x0, y0, x1, y1) after rotation."""
        string = self.text_string(L, st, llt) if not L.count else L.text.replace("{n}", fmt_number(L.count["to"], L.count["decimals"], L.count["thousands"]))
        lay = self.layout(L, string)
        z = self.cam_factor(L, cam)[0] if L.cam else 1.0
        S = st["scale"] * z
        px, py = self.to_frame(L, st["x"], st["y"], cam)
        bw, bh = lay["w"] * S / SS, lay["h"] * S / SS
        tlx, tly = px - L.anchor[0] * bw, py - L.anchor[1] * bh
        ix0, iy0, ix1, iy1 = lay["ink"]
        ink = [tlx + ix0 * S / SS, tly + iy0 * S / SS, tlx + ix1 * S / SS, tly + iy1 * S / SS]
        bp = self.backing_pad(L, S) / SS
        blk = [tlx - bp, tly - bp, tlx + bw + bp, tly + bh + bp]
        rot = st["rotation"]

        def rb(b):
            if abs(rot) < 0.01:
                return tuple(b)
            pts = [rot_point(x, y, px, py, rot) for x in (b[0], b[2]) for y in (b[1], b[3])]
            return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))

        return rb(ink), rb(blk), lay

    def draw_text(self, frame, L, st, llt, cam, ink=True):
        z = self.cam_factor(L, cam)[0] if L.cam else 1.0
        self._zoom = z
        us = self.unit_state_fn(L, llt) if L.split else None
        img, piv = self.text_patch(L, st, llt, ink, us)
        px, py = self.to_frame(L, st["x"], st["y"], cam)
        self.place(frame, img, piv, px, py, st["rotation"], st["opacity"])

    def place(self, frame, img, piv, px, py, rot, opacity):
        if abs(rot) > 0.01:
            img, piv = rotate_patch(img, piv, rot)
        left2x = int(round(px * SS - piv[0]))
        top2x = int(round(py * SS - piv[1]))
        fin, x, y = finish(img, left2x, top2x)
        over(frame, fin, x, y, opacity)

    # ---- shapes
    def stroke_px(self, L, S):
        return max(1.0, L.stroke["width"] * self.vh * SS * S) if L.stroke else 0.0

    def draw_shape(self, frame, L, st, llt, cam, ink=True):
        z = self.cam_factor(L, cam)[0] if L.cam else 1.0
        S = st["scale"] * z
        color = st["color"]
        reveal = st["reveal"]
        if L.paths is None:
            w_px = max(0.0, (st["w"] or 0.0) * self.W * S)
            h_px = w_px if L.shape == "circle" else max(0.0, (st["h"] or 0.0) * self.H * S)
            if w_px < 0.05 or h_px < 0.05:
                return
            px, py = self.to_frame(L, st["x"], st["y"], cam)
            sw = self.stroke_px(L, S)
            key = ("shp", L.uid, round(w_px, 2), round(h_px, 2), round(S, 4), color if (L.fill and L.fill[0] == "solid") else None, round(reveal, 3), self.W)
            hit = self.cget(key)
            bw, bh = int(round(w_px * SS)), int(round(h_px * SS))
            pad = int(math.ceil(sw / 2)) + 2
            piv = (pad + L.anchor[0] * bw, pad + L.anchor[1] * bh)
            if hit is None:
                mask = Image.new("L", (bw + 2 * pad, bh + 2 * pad), 0)
                dm = ImageDraw.Draw(mask)
                box = (pad, pad, pad + bw - 1, pad + bh - 1)
                self._shape_mask(dm, L, box, S, 255)
                img = self._fill_stroke(L, mask, box, color, sw, S)
                if reveal < 0.9999:
                    img = apply_alpha_mask(img, self._pad_ramp(img, pad, bw, bh, reveal, L.direction))
                hit = (img, piv)
                self.cput(key, hit)
            img, piv = hit
            self.place(frame, img, piv, px, py, st["rotation"], st["opacity"])
            return
        # polylines, polygons, paths: points are frame fractions, x and y offset them
        pts_sets = []
        allx, ally = [], []
        for pts, closed in L.paths:
            q = []
            for fx, fy in pts:
                q.append(self.to_frame(L, fx + st["x"], fy + st["y"], cam))
            pts_sets.append((q, closed))
            allx += [p[0] for p in q]
            ally += [p[1] for p in q]
        cx, cy = (min(allx) + max(allx)) / 2, (min(ally) + max(ally)) / 2
        out = []
        for q, closed in pts_sets:
            q2 = []
            for x, y in q:
                x, y = cx + (x - cx) * st["scale"], cy + (y - cy) * st["scale"]
                if abs(st["rotation"]) > 0.01:
                    x, y = rot_point(x, y, cx, cy, st["rotation"])
                q2.append((x, y))
            out.append((q2, closed))
        sw = self.stroke_px(L, z * st["scale"])
        xs = [p[0] for q, _ in out for p in q]
        ys = [p[1] for q, _ in out for p in q]
        pad = int(math.ceil(sw / 2)) + 3
        ox, oy = int(math.floor(min(xs) * SS)) - pad, int(math.floor(min(ys) * SS)) - pad
        w, h = int(math.ceil(max(xs) * SS)) + pad - ox, int(math.ceil(max(ys) * SS)) + pad - oy
        if w * h > 80_000_000 or w < 1 or h < 1:
            return
        mask_f = Image.new("L", (w, h), 0)
        mask_s = Image.new("L", (w, h), 0)
        df, ds = ImageDraw.Draw(mask_f), ImageDraw.Draw(mask_s)
        total = sum(math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]) for q, c in out for i in range(len(q) - 1)) or 1.0
        draw_on = L.stroke and not L.fill and reveal < 0.9999
        budget = reveal * total
        for q, closed in out:
            pp = [((x * SS - ox), (y * SS - oy)) for x, y in q]
            if L.fill and closed and len(pp) >= 3:
                df.polygon(pp, fill=255)
            if L.stroke:
                lp = pp + [pp[0]] if closed else pp
                if draw_on:
                    cut = [lp[0]]
                    for i in range(len(lp) - 1):
                        seg = math.hypot(lp[i + 1][0] - lp[i][0], lp[i + 1][1] - lp[i][1]) / SS
                        if budget >= seg:
                            cut.append(lp[i + 1])
                            budget -= seg
                        else:
                            f = budget / seg if seg else 0
                            cut.append((lp[i][0] + (lp[i + 1][0] - lp[i][0]) * f, lp[i][1] + (lp[i + 1][1] - lp[i][1]) * f))
                            budget = 0
                            break
                    lp = cut
                if len(lp) >= 2:
                    ds.line(lp, fill=255, width=int(round(sw)), joint="curve")
                    if L.stroke["round"]:
                        r = sw / 2
                        for ex, ey in (lp[0], lp[-1]):
                            ds.ellipse((ex - r, ey - r, ex + r, ey + r), fill=255)
        fill_arr = np.asarray(mask_f, dtype=np.float32) / 255.0
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        if L.fill:
            rgba = np.array(self.paint_array(L.fill if L.fill[0] == "grad" else ("solid", color), w, h, (min(xs) * SS - ox, min(ys) * SS - oy, (max(xs) - min(xs)) * SS, (max(ys) - min(ys)) * SS)))
            rgba[..., 3] = rgba[..., 3] * fill_arr * 255.0
            if reveal < 0.9999 and not draw_on:
                rgba[..., 3] *= ramp_mask(w, h, reveal, L.direction, max(4.0, 0.08 * min(w, h)))
            img = Image.fromarray(np.clip(rgba, 0, 255).round().astype(np.uint8), "RGBA")
        if L.stroke:
            sc = L.stroke["color"] if not (not L.fill and color) else (color if not L.fill else L.stroke["color"])
            if not L.fill:
                sc = (color[0], color[1], color[2], color[3] if len(color) > 3 else 1.0)
            simg = Image.new("RGBA", (w, h), (int(sc[0]), int(sc[1]), int(sc[2]), 0))
            simg.putalpha(Image.fromarray((np.asarray(mask_s, dtype=np.float32) * sc[3]).round().astype(np.uint8), "L"))
            img = Image.alpha_composite(img, simg)
        fin, x, y = finish(img, ox, oy)
        over(frame, fin, x, y, st["opacity"])

    def _pad_ramp(self, img, pad, bw, bh, reveal, direction):
        m = np.ones((img.height, img.width), dtype=np.float32)
        inner = ramp_mask(bw, bh, reveal, direction, max(4.0, 0.06 * (bw if direction in ("left", "right") else bh)))
        m[:] = 0
        m[pad : pad + bh, pad : pad + bw] = inner
        return m

    def _shape_mask(self, dm, L, box, S, fill):
        if L.shape in ("circle", "ellipse"):
            dm.ellipse(box, fill=fill)
        elif L.shape == "rounded":
            r = min(L.radius * self.vh * SS * S, min(box[2] - box[0], box[3] - box[1]) / 2)
            dm.rounded_rectangle(box, radius=max(0, r), fill=fill)
        else:
            dm.rectangle(box, fill=fill)

    def _fill_stroke(self, L, mask, box, color, sw, S):
        w, h = mask.size
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        if L.fill:
            if L.fill[0] == "solid":
                c = color if color else L.fill[1]
                img = Image.new("RGBA", (w, h), (int(c[0]), int(c[1]), int(c[2]), 0))
                img.putalpha(Image.fromarray((np.asarray(mask, dtype=np.float32) * c[3]).round().astype(np.uint8), "L"))
            else:
                rgba = np.array(self.paint_array(L.fill, w, h, (box[0], box[1], box[2] - box[0] + 1, box[3] - box[1] + 1)))
                rgba[..., 3] = rgba[..., 3] * np.asarray(mask, dtype=np.float32)
                img = Image.fromarray(np.clip(rgba, 0, 255).round().astype(np.uint8), "RGBA")
        if L.stroke:
            sm = Image.new("L", (w, h), 0)
            dsm = ImageDraw.Draw(sm)
            self._shape_mask(dsm, L, box, S, 255)
            inner = Image.new("L", (w, h), 0)
            b2 = (box[0] + sw, box[1] + sw, box[2] - sw, box[3] - sw)
            if b2[2] > b2[0] and b2[3] > b2[1]:
                self._shape_mask(ImageDraw.Draw(inner), L, b2, S, 255)
            ring = ImageChops.subtract(sm, inner)
            sc = L.stroke["color"]
            simg = Image.new("RGBA", (w, h), (int(sc[0]), int(sc[1]), int(sc[2]), 0))
            simg.putalpha(Image.fromarray((np.asarray(ring, dtype=np.float32) * sc[3]).round().astype(np.uint8), "L"))
            img = Image.alpha_composite(img, simg)
        return img

    # ---- images
    def source_image(self, L):
        key = L.uid
        if key in self.sources:
            return self.sources[key]
        name = L.d.get("file", "")
        zmax = 1.0
        for sc in (L.scene,) if L.scene else ():
            if sc.camera:
                zmax = max(sc.camera["a"][0], sc.camera["b"][0], 1.0)
        zmax *= max([L.base["scale"]] + [max(s.a, s.b) for s in L.segs.get("scale", [])])
        bw, bh = L.base["w"] * self.W, L.base["h"] * self.H
        if name.startswith("sample:"):  # drawn at the size this render needs, so a draft does not pay for 2K
            sw = int(clamp(max(bw, bh * 16 / 9) * zmax * 1.05, 320, 2048))
            im = sample_image(name[7:], sw + sw % 2, int(sw * 9 / 16) // 2 * 2)
        else:
            im = Image.open(L.path)
            im.load()
            from PIL import ImageOps  # noqa: PLC0415

            im = ImageOps.exif_transpose(im).convert("RGBA")
        if im.mode == "RGBA" and im.getchannel("A").getextrema()[0] == 255:
            im = im.convert("RGB")  # opaque photos take the faster path; alpha comes back only where it is needed
        iw, ih = im.size
        k = max(bw / iw, bh / ih) if L.fit == "cover" else min(bw / iw, bh / ih)
        want = k * zmax * 1.0
        if want < 1.0:
            im = im.resize((max(1, int(iw * want)), max(1, int(ih * want))), Image.LANCZOS)
        self.sources[key] = (im, im.width / iw)
        return self.sources[key]

    def draw_image(self, frame, L, st, llt, cam, ink=True):
        src, rs = self.source_image(L)
        iw, ih = src.width / rs, src.height / rs
        z = self.cam_factor(L, cam)[0] if L.cam else 1.0
        S = st["scale"] * z
        bw, bh = (st["w"] if st["w"] is not None else 1.0) * self.W * S, (st["h"] if st["h"] is not None else 1.0) * self.H * S
        if bw < 1 or bh < 1:
            return
        px, py = self.to_frame(L, st["x"], st["y"], cam)
        ax, ay = L.anchor
        rot = st["rotation"]
        # corners of the box in the frame
        tl = (px - ax * bw, py - ay * bh)
        corners = [rot_point(tl[0] + dx, tl[1] + dy, px, py, rot) for dx in (0, bw) for dy in (0, bh)]
        x0, y0 = max(0, int(math.floor(min(c[0] for c in corners)))), max(0, int(math.floor(min(c[1] for c in corners))))
        x1, y1 = min(self.W, int(math.ceil(max(c[0] for c in corners)))), min(self.H, int(math.ceil(max(c[1] for c in corners))))
        if x1 <= x0 or y1 <= y0:
            return
        if L.fit == "cover":
            k = max(bw / iw, bh / ih)
            cw, ch = bw / k, bh / k
            cx0 = clamp(L.focus[0] * iw - cw / 2, 0, iw - cw)
            cy0 = clamp(L.focus[1] * ih - ch / 2, 0, ih - ch)
            dw, dh, offx, offy = bw, bh, 0.0, 0.0
        else:
            k = min(bw / iw, bh / ih)
            cw, ch, cx0, cy0 = iw, ih, 0.0, 0.0
            dw, dh = iw * k, ih * k
            offx, offy = (bw - dw) / 2, (bh - dh) / 2
        a = math.radians(-rot)
        c, s = math.cos(a), math.sin(a)
        # patch pixel (x, y) centre -> frame (X, Y) -> box local -> source
        # local = R^-1 (X - px, Y - py) + (ax*bw, ay*bh) - off ; src = (crop0 + local * crop/d) * rs
        sx, sy = cw / dw * rs, ch / dh * rs
        # R^-1 for a clockwise rotation by rot is rotation by -rot in screen coordinates
        m00, m01, m10, m11 = c, -s, s, c
        tx = (m00 * (x0 - px) + m01 * (y0 - py)) + ax * bw - offx
        ty = (m10 * (x0 - px) + m11 * (y0 - py)) + ay * bh - offy
        coeffs = (m00 * sx, m01 * sx, (tx * sx) + cx0 * rs, m10 * sy, m11 * sy, (ty * sy) + cy0 * rs)
        if src.mode == "RGB" and (L.fit != "cover" or abs(rot) > 0.01):
            src = self.sources.setdefault(("rgba", L.uid), src.convert("RGBA"))  # edges outside the photo must be see-through
        patch = src.transform((x1 - x0, y1 - y0), Image.AFFINE, coeffs, resample=Image.BICUBIC)
        # box mask: rounded or rotated edges, antialiased at 2x
        need_mask = L.fit == "cover" or L.radius > 0 or abs(rot) > 0.01
        full = x0 == 0 and y0 == 0 and x1 == self.W and y1 == self.H and min(c_[0] for c_ in corners) <= 0 and min(c_[1] for c_ in corners) <= 0 and max(c_[0] for c_ in corners) >= self.W and max(c_[1] for c_ in corners) >= self.H and L.radius == 0
        if patch.mode == "RGB" and ((need_mask and not full) or st["reveal"] < 0.9999):
            patch = patch.convert("RGBA")
        if need_mask and not full:
            m2 = Image.new("L", ((x1 - x0) * SS, (y1 - y0) * SS), 0)
            dm = ImageDraw.Draw(m2)
            if abs(rot) > 0.01:
                dm.polygon([((p[0] - x0) * SS, (p[1] - y0) * SS) for p in (corners[0], corners[1], corners[3], corners[2])], fill=255)
            elif L.radius > 0:
                dm.rounded_rectangle(((tl[0] - x0) * SS, (tl[1] - y0) * SS, (tl[0] + bw - x0) * SS - 1, (tl[1] + bh - y0) * SS - 1), radius=min(L.radius * self.vh * SS * S, bw * SS / 2, bh * SS / 2), fill=255)
            else:
                dm.rectangle(((tl[0] - x0) * SS, (tl[1] - y0) * SS, (tl[0] + bw - x0) * SS - 1, (tl[1] + bh - y0) * SS - 1), fill=255)
            mask = np.asarray(m2.resize(patch.size, Image.BOX), dtype=np.float32) / 255.0
            arr = np.array(patch)
            arr[..., 3] = (arr[..., 3] * mask).round().astype(np.uint8)
            patch = Image.fromarray(arr, "RGBA")
        if L.dim > 0:
            arr = np.array(patch)
            arr[..., :3] = (arr[..., :3].astype(np.float32) * (1 - L.dim)).round().astype(np.uint8)
            patch = Image.fromarray(arr, patch.mode)
        if st["reveal"] < 0.9999:
            patch = apply_alpha_mask(patch, ramp_mask(patch.width, patch.height, st["reveal"], L.direction, max(4.0, 0.06 * max(patch.size))))
        over(frame, patch, x0, y0, st["opacity"])

    # ---- layers, scenes, frames
    def draw_layer(self, frame, L, lt, cam, ink=True):
        llt = lt - L.start
        if llt < -1e-9 or lt >= L.end + 1e-9:
            return
        st = self.state(L, llt)
        if st["opacity"] <= 0.001:
            return
        if st["reveal"] <= 0.0005 and L.kind != "text":
            return
        if L.kind == "text":
            self.draw_text(frame, L, st, llt, cam, ink)
        elif L.kind == "shape":
            self.draw_shape(frame, L, st, llt, cam, ink)
        else:
            self.draw_image(frame, L, st, llt, cam, ink)

    def render_scene(self, scene, lt, until=None):
        frame = self.background(scene.bg).copy()
        cam = self.cam_at(scene, lt)
        for L in scene.layers:
            if until is L:
                self.draw_layer(frame, L, lt, cam, ink=False)
                break
            self.draw_layer(frame, L, lt, cam)
        return frame

    def transition(self, a, b, tr, p):
        W, H = self.W, self.H
        kind = tr["type"]
        if kind == "crossfade":
            e = EASES["easeInOutSine"](p)
            return a * (1 - e) + b * e
        if kind == "dip":
            col = np.array(tr["color"][:3], dtype=np.float32)
            if p < 0.5:
                e = EASES["easeInSine"](p * 2)
                return a * (1 - e) + col * e
            e = EASES["easeOutSine"]((p - 0.5) * 2)
            return col * (1 - e) + b * e
        e = EASES["easeInOutCubic"](p)
        d = tr["direction"]
        if kind == "slide":
            out = np.empty_like(a)
            if d in ("left", "right"):
                s = int(round(e * W))
                if d == "left":  # the new scene arrives from the right, pushing the old one left
                    out[:, : W - s], out[:, W - s :] = a[:, s:], b[:, :s]
                else:
                    out[:, s:], out[:, :s] = a[:, : W - s], b[:, W - s :]
            else:
                s = int(round(e * H))
                if d == "up":
                    out[: H - s], out[H - s :] = a[s:], b[:s]
                else:
                    out[s:], out[:s] = a[: H - s], b[H - s :]
            return out
        if kind == "wipe":
            feather = max(4.0, 0.06 * (W if d in ("left", "right") else H))
            m = ramp_mask(W, H, e, d, feather)[..., None]
            return a * (1 - m) + b * m
        return b

    def render_frame(self, t, until=None):
        """Float32 (H, W, 3) frame at global time t. `until` = (layer) to stop before drawing its ink (for contrast checks)."""
        m = self.m
        active = [s for s in m.scenes if s.start - 1e-9 <= t < s.end - 1e-9]
        if not active:
            active = [m.scenes[-1]]
        stop = until if (until is not None and until.scene is not None) else None
        if len(active) >= 2:
            a, b = active[0], active[1]
            p = clamp((t - b.start) / max(b.t_in, 1e-6), 0.0, 1.0)
            fa = self.render_scene(a, t - a.start, stop)
            fb = self.render_scene(b, t - b.start, stop)
            frame = self.transition(fa, fb, b.transition, p)
        else:
            s = active[0]
            frame = self.render_scene(s, t - s.start, stop)
        if until is not None and until.scene is not None:
            return frame
        for L in m.overlay:
            if until is L:
                self.draw_layer(frame, L, t, (1.0, 0.5, 0.5), ink=False)
                break
            self.draw_layer(frame, L, t, (1.0, 0.5, 0.5))
        if until is not None:
            return frame
        k = self.fade_amount(t)
        if k > 0:
            col = np.array(parse_color(m.fade.get("color", "#000000"))[:3], dtype=np.float32)
            frame = frame * (1 - k) + col * k
        return frame

    def layer_sig(self, L, lt):
        llt = lt - L.start
        if llt < -1e-9 or lt >= L.end + 1e-9:
            return None
        st = self.state(L, llt)
        sig = [L.uid, tuple((k, st[k]) for k in sorted(st))]
        if L.kind == "text":
            sig.append(self.text_string(L, st, llt))
            if L.split:
                f = self.unit_state_fn(L, llt)
                sig.append(tuple(tuple(f(i).values()) for i in range(L.units + 1)))
        return tuple(sig)

    def signature(self, t):
        """Everything that decides a frame's pixels. Equal signatures mean equal frames, so a held moment is drawn once."""
        m = self.m
        active = [s for s in m.scenes if s.start - 1e-9 <= t < s.end - 1e-9] or [m.scenes[-1]]
        parts = []
        for s in active:
            lt = t - s.start
            parts.append((s.index, tuple(self.cam_at(s, lt)) if s.camera else None, tuple(self.layer_sig(L, lt) for L in s.layers)))
        if len(active) >= 2:
            parts.append(clamp((t - active[1].start) / max(active[1].t_in, 1e-6), 0.0, 1.0))
        parts.append(tuple(self.layer_sig(L, t) for L in m.overlay))
        parts.append(self.fade_amount(t))
        return tuple(parts)

    def fade_amount(self, t):
        fd = self.m.fade
        if not fd:
            return 0.0
        k = 0.0
        if fd.get("in", 0) > 0 and t < fd["in"]:
            k = max(k, 1 - EASES["easeOutSine"](t / fd["in"]))
        if fd.get("out", 0) > 0 and t > self.m.duration - fd["out"]:
            k = max(k, EASES["easeInSine"](clamp((t - (self.m.duration - fd["out"])) / fd["out"], 0, 1)))
        return k

    def to_uint8(self, frame):
        return np.clip(np.rint(frame), 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------------------------
# --check: problems in plain words, each with the fix
# --------------------------------------------------------------------------------------------
def box_overlap(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return (w, h) if w > 0 and h > 0 else (0, 0)


def area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def hexcolor(c):
    return "#%02x%02x%02x" % tuple(int(round(v)) for v in c[:3])


class Checker:
    def __init__(self, model):
        self.m = model
        self.R = Renderer(model, 1.0)
        self.Rc = Renderer(model, min(1.0, 640.0 / model.W))
        self.out = []
        self.dt = 1 / 30
        self.key = (999, 0)

    def at(self, L):
        self.key = (L.scene.index if L.scene else 998, L.index)

    def err(self, where, msg):
        self.out.append(Problem("error", where, msg, self.key))

    def warn(self, where, msg):
        self.out.append(Problem("warn", where, msg, self.key))

    # time at which every part of a text layer is shown: opacity up, fully revealed, split units entered
    def ready_after(self, L):
        r = 0.0
        if L.split and L.unit_segs:
            r = max(s.end for lst in L.unit_segs.values() for s in lst) + (L.units - 1) * L.stagger
        return r

    def readable(self, L):
        """Layer-local sample times at which the layer is fully on screen and not mixed with a transition."""
        R = self.R
        lo, hi = 0.0, L.dur
        sc = L.scene
        if sc is not None:
            lo = max(lo, sc.t_in - L.start)
            hi = min(hi, sc.dur - sc.t_out - L.start)
        ready = self.ready_after(L)
        # "Fully on screen" is the layer's own fullest moment: a line set to opacity 0.8 or revealed to 0.6 is fully there at
        # 0.8 or 0.6. Contrast then judges whether that is readable, so a faint line fails there, with a number, not here.
        top_op = top_rv = 0.0
        t = 0.0
        while t <= L.dur + 1e-9:
            st = R.state(L, t)
            top_op, top_rv = max(top_op, st["opacity"]), max(top_rv, st["reveal"])
            t += self.dt
        if top_rv < 0.05:  # never revealed at all
            top_rv = 1.0
        ts, t = [], max(lo, 0.0)
        while t <= hi + 1e-9:
            st = R.state(L, t)
            if st["opacity"] >= 0.95 * top_op and st["reveal"] >= top_rv - 1e-3 and t >= ready - 1e-9:
                ts.append(t)
            t += self.dt
        return ts

    def global_t(self, L, llt):
        return (L.scene.start if L.scene else 0.0) + L.start + llt

    def cam(self, L, llt):
        return self.R.cam_at(L.scene, L.start + llt) if L.scene else (1.0, 0.5, 0.5)

    def run(self):
        m = self.m
        self.check_fonts()
        self.check_layers()
        self.check_scenes()
        self.check_audio()
        self.out.sort(key=lambda p: p.order)
        return self.out

    def check_fonts(self):
        seen = set()
        for L in self.all_layers():
            if L.kind != "text":
                continue
            key = (L.font.name, L.italic)
            if key in seen:
                continue
            seen.add(key)
            if L.font.resolve(L.italic) is None:
                fix = "run once with a network connection so it is cached, or give the font a local file: \"fonts\": {\"" + L.font.name + "\": {\"path\": \"/path/to/font.ttf\"}}"
                self.err(f'font "{L.font.name}"', f"is missing: {L.font.error}. Fix: {fix}. (--force draws with Pillow's built-in face instead.)")

    def all_layers(self):
        for sc in self.m.scenes:
            yield from sc.layers
        yield from self.m.overlay

    def check_scenes(self):
        m = self.m
        for sc in m.scenes:
            words = sum(L.words for L in sc.layers if L.kind == "text" and not L.group)
            span = max(0.5, sc.dur - sc.t_in - sc.t_out)
            if words / span > 3.6 and words > 12:
                self.warn(sc.name, f"has {words} words in {span:.1f} s ({words / span:.1f} words per second). Viewers read about 3 per second. Fix: cut words (one idea per scene) or add time.")
            if sc.dur < 0.8:
                self.warn(sc.name, f"is only {sc.dur:g} s long; scenes under 1 s read as flicker")
        last_motion = 0.0
        for sc in m.scenes:
            for L in sc.layers:
                ends = [s.end for lst in L.segs.values() for s in lst if s.src != "exit"]
                if L.kind == "text" and L.count:
                    ends.append(L.count["at"] + L.count["duration"])
                if L.split:
                    ends += [s.end + (L.units - 1) * L.stagger for lst in L.unit_segs.values() for s in lst]
                if ends:
                    last_motion = max(last_motion, sc.start + L.start + max(ends))
        cam = m.scenes[-1].camera if m.scenes else None
        cam_moves = bool(cam and cam["a"] != cam["b"] and any(L.cam > 0 for L in m.scenes[-1].layers))
        if cam_moves:
            self.warn("ending", f"the camera on the last scene moves until the video ends at {m.duration:.1f} s. Hold the final frame for 1 s: remove the camera from the last scene.")
        elif m.scenes and m.duration - last_motion < 0.99 and last_motion > 0:
            self.warn("ending", f"the last thing moves at {last_motion:.1f} s and the video ends at {m.duration:.1f} s. Hold the final frame for 1 s: lengthen the last scene by {1 - (m.duration - last_motion):.1f} s.")

    def check_audio(self):
        m = self.m
        for i, a in enumerate(m.audio or []):
            p = resolve_path(a["file"], m.base_dir)
            if not p.exists():
                self.err(f"audio {i + 1}", f'file "{a["file"]}" does not exist (looked in {p.parent})')
        if m.audio and not shutil.which("ffmpeg"):
            self.err("audio", "needs ffmpeg on PATH to mix and normalize sound, and none was found. Fix: install ffmpeg, or remove \"audio\" and add the sound afterwards.")

    # ---- per layer
    def check_layers(self):
        m = self.m
        samples = {}  # layer -> {grid key: (global t, ink, blk)}
        for L in self.all_layers():
            self.at(L)
            where = L.label
            sdur = L.scene.dur if L.scene else L.end
            if L.scene is not None and L.start >= sdur - 1e-6:
                continue  # never appears; compile already said so
            if L.scene is not None and L.anim_end > L.dur + 0.02:
                kind = "scene" if abs(L.dur - (sdur - L.start)) < 0.02 else "layer"
                self.err(where, f"has animation running until {L.start + L.anim_end:g} s but the {kind} ends at {L.end:g} s, so it never finishes. Fix: lengthen the scene to at least {L.start + L.anim_end + 1:g} s, or shorten the animation.")
            if L.kind == "text":
                self.check_text(L, samples)
            elif L.kind in ("shape", "image"):
                self.check_nontext(L)
        self.check_overlaps(samples)
        self.check_covers()

    def check_text(self, L, samples):
        R, m = self.R, self.m
        where = L.label
        W, H = m.W, m.H
        if L.size < 2.0:
            self.err(where, f"size {L.size:g} is too small to read (under 2% of the frame height). Fix: use 3 or more; body copy is 3 to 4, headlines 7 to 12.")
        elif L.size < 3.0 and not L.overlay:
            self.warn(where, f"size {L.size:g} is small for video; phones need about 3 or more")
        string = L.text.replace("{n}", fmt_number(L.count["to"], L.count["decimals"], L.count["thousands"])) if L.count else L.text
        if not string.strip():
            self.err(where, "has no text")
            return
        lay = R.layout(L, string)
        if L.box and lay["max_line"] > lay["box2"] * 1.001:
            bad = max(string.replace("\n", " ").split(), key=len)
            self.err(where, f'the word "{bad}" is wider than its box ({L.box:g} of the frame width) and cannot wrap. Fix: widen "box", lower "size", or use a shorter word.')
        mx = L.d.get("max_lines")
        if mx and len(lay["lines"]) > mx:
            self.err(where, f"takes {len(lay['lines'])} lines but max_lines is {mx}. Fix: shorten the text, widen \"box\", or lower \"size\".")
        elif len(lay["lines"]) > 4 and not L.overlay:
            self.warn(where, f"wraps to {len(lay['lines'])} lines. Long blocks are not read in video. Fix: cut words or split across scenes.")
        ts = self.readable(L)
        words = L.words
        need = max(MIN_TEXT_SECONDS, MIN_WORD_SECONDS * words)
        have = len(ts) * self.dt
        if L.scene is not None or L.overlay:
            if have + 1e-6 < need - 0.5 * self.dt:
                fn = self.warn if L.overlay else self.err
                fn(where, f"is fully on screen for {have:.1f} s but {words} word{'s' if words != 1 else ''} need {need:.1f} s (0.25 s per word, at least 1.2 s). Fix: show it longer (end later, a longer scene) or shorten the animation.")
        if not ts:
            return
        pick = ts[:: max(1, len(ts) // 10)]
        if pick[-1] != ts[-1]:
            pick.append(ts[-1])
        grid = {}
        worst_over = None
        for t in pick:
            st = R.state(L, t)
            cam = self.cam(L, t)
            ink, blk, _ = R.text_box(L, st, t, cam)
            grid[round(self.global_t(L, t) / 0.25)] = (self.global_t(L, t), ink, blk)
            if not L.safe_check:
                continue
            tol_x, tol_y = 0.004 * W, 0.004 * H
            sx, sy = m.safe * W, m.safe * H
            lim = (sx - tol_x, sy - tol_y, W - sx + tol_x, H - sy + tol_y)
            if ink[0] < lim[0] or ink[1] < lim[1] or ink[2] > lim[2] or ink[3] > lim[3]:
                over = max(lim[0] - ink[0], lim[1] - ink[1], ink[2] - lim[2], ink[3] - lim[3])
                if worst_over is None or over > worst_over[0]:
                    worst_over = (over, ink, t)
        samples[L] = grid
        if worst_over:
            over, ink, t = worst_over
            off_frame = ink[0] < 0 or ink[1] < 0 or ink[2] > W or ink[3] > H
            w_ink = (ink[2] - ink[0]) / W
            avail = 1 - 2 * m.safe
            if off_frame:
                msg = "runs off the edge of the frame"
            else:
                msg = f"sits inside the {m.safe * 100:g}% safe margin (text near the edge is cut off on TVs and covered by app buttons on phones)"
            fix = []
            if w_ink > avail:
                fix.append(f"it is {w_ink * 100:.0f}% of the frame width: set \"box\": {min(avail - 0.02, 0.8):g} so it wraps, or lower \"size\"")
            fix.append("move it toward the center with x and y")
            self.err(where, f"{msg} at {self.global_t(L, t):.1f} s (spans x {ink[0] / W:.2f} to {ink[2] / W:.2f}, y {ink[1] / H:.2f} to {ink[3] / H:.2f}). Fix: " + "; or ".join(fix) + ".")
        self.check_contrast(L, ts)

    def check_contrast(self, L, ts):
        m, Rc = self.m, self.Rc
        need = 4.5 if L.size < SMALL_TEXT_VH else 3.0
        pick = [ts[len(ts) // 2]] + ([ts[-1]] if len(ts) > 2 else [])
        worst = None
        for t in pick:
            gt = self.global_t(L, t)
            st = Rc.state(L, t)
            cam = self.cam(L, t)
            ink, blk, _ = Rc.text_box(L, st, t, cam)
            x0, y0 = max(0, int(ink[0])), max(0, int(ink[1]))
            x1, y1 = min(Rc.W, int(math.ceil(ink[2]))), min(Rc.H, int(math.ceil(ink[3])))
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            frame = Rc.render_frame(min(gt, m.duration - 1e-3), until=L)
            px = frame[y0:y1, x0:x1].reshape(-1, 3)
            col = np.array(st["color"][:3], dtype=np.float32)
            a = st["color"][3] * st["opacity"]
            eff = col[None, :] * a + px * (1 - a)
            lum = lambda arr: 0.2126 * ((arr[:, 0] / 255) ** 2.2) + 0.7152 * ((arr[:, 1] / 255) ** 2.2) + 0.0722 * ((arr[:, 2] / 255) ** 2.2)  # noqa: E731
            lt_, lb_ = lum(eff), lum(px)
            ratio = (np.maximum(lt_, lb_) + 0.05) / (np.minimum(lt_, lb_) + 0.05)
            r10 = float(np.percentile(ratio, 10))
            if worst is None or r10 < worst[0]:
                worst = (r10, px.mean(axis=0), gt, st["color"])
        if worst and worst[0] < need:
            r10, bgc, gt, tcol = worst
            kind = "small" if L.size < SMALL_TEXT_VH else "large"
            photo = L.scene is not None and any(U.kind == "image" for U in L.scene.layers[: L.scene.layers.index(L)])
            fix = 'darken the photo with "dim": 0.4, give the text a "backing": {"color": "#00000099"}, or change its color' if photo else 'change the text color toward white or black (whichever is far from the background), or give it a "backing": {"color": "#00000099"}'
            self.err(L.label, f"has contrast {r10:.1f}:1 against what is behind it at {gt:.1f} s (text {hexcolor(tcol)} on about {hexcolor(bgc)}); {kind} text needs {need:g}:1. Fix: {fix}.")

    def check_nontext(self, L):
        R, m = self.R, self.m
        if L.kind == "image" and L.path is not None and L.path.exists():
            try:
                with Image.open(L.path) as im:
                    iw, ih = im.size
                if iw < m.W * 0.5 and L.base["w"] >= 0.9 and L.base["h"] >= 0.9:
                    self.warn(L.label, f"is only {iw}x{ih} px for a {m.W}x{m.H} frame and will look soft. Fix: use a larger photo.")
            except Exception as e:  # noqa: BLE001
                self.err(L.label, f"cannot be opened as an image: {e}")
        st = R.state(L, min(L.dur / 2, L.dur - 1e-3))
        bb = self.bbox(L, st, (1.0, 0.5, 0.5))
        if bb and L.scene is not None and st["opacity"] > 0.05:
            if bb[2] < 0 or bb[0] > m.W or bb[3] < 0 or bb[1] > m.H:
                self.err(L.label, "is completely outside the frame, so it never shows. Fix: x and y are fractions from 0 to 1 of the frame; check the numbers.")
        # camera must not uncover the edge of a full-frame photo
        if L.kind == "image" and L.scene is not None and L.scene.camera and L.cam > 0 and L.fit == "cover" and L.base["w"] >= 1 and L.base["h"] >= 1:
            sc = L.scene
            ax, ay = L.anchor
            bx0 = L.base["x"] - ax * L.base["w"] * L.base["scale"]
            bx1, by0 = bx0 + L.base["w"] * L.base["scale"], L.base["y"] - ay * L.base["h"] * L.base["scale"]
            by1 = by0 + L.base["h"] * L.base["scale"]
            if bx0 <= 1e-6 and by0 <= 1e-6 and bx1 >= 1 - 1e-6 and by1 >= 1 - 1e-6:
                for i in range(21):
                    z, cx, cy = R.cam_factor(L, R.cam_at(sc, sc.dur * i / 20))
                    if cx - 0.5 / z < bx0 - 1e-4 or cx + 0.5 / z > bx1 + 1e-4 or cy - 0.5 / z < by0 - 1e-4 or cy + 0.5 / z > by1 + 1e-4:
                        self.err(L.label, f"the camera move shows past the edge of the photo at {sc.dur * i / 20:.1f} s (zoom {z:.2f}, center {cx:.2f}, {cy:.2f}). Fix: raise the zoom or shrink the pan so the view stays inside the photo.")
                        break

    def bbox(self, L, st, cam):
        R = self.R
        if L.kind == "text":
            return R.text_box(L, st, 0.0, cam)[1]
        z = R.cam_factor(L, cam)[0] if L.cam else 1.0
        S = st["scale"] * z
        if L.kind == "shape" and L.paths is not None:
            pts = [R.to_frame(L, fx + st["x"], fy + st["y"], cam) for q, _ in L.paths for fx, fy in q]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
            return (cx + (min(xs) - cx) * S, cy + (min(ys) - cy) * S, cx + (max(xs) - cx) * S, cy + (max(ys) - cy) * S)
        w = (st["w"] if st["w"] is not None else 1.0) * R.W * S
        h = w if (L.kind == "shape" and L.shape == "circle") else (st["h"] if st["h"] is not None else 1.0) * R.H * S
        px, py = R.to_frame(L, st["x"], st["y"], cam)
        tl = (px - L.anchor[0] * w, py - L.anchor[1] * h)
        corners = [rot_point(tl[0] + dx, tl[1] + dy, px, py, st["rotation"]) for dx in (0, w) for dy in (0, h)]
        return (min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners))

    def check_overlaps(self, samples):
        texts = list(samples)
        for i, A in enumerate(texts):
            for B in texts[i + 1 :]:
                ga, gb = samples[A], samples[B]
                for k in set(ga) & set(gb):
                    w, h = box_overlap(ga[k][1], gb[k][1])
                    if w > 0.004 * self.m.W and h > 0.004 * self.m.H:
                        self.at(A)
                        self.err(A.label, f"overlaps {B.label} at {ga[k][0]:.1f} s (the two text blocks share a {w / self.m.W * 100:.0f}% x {h / self.m.H * 100:.0f}% patch of the frame). Fix: move one with y, or show them at different times.")
                        break

    def check_covers(self):
        R, m = self.R, self.m
        for sc in m.scenes:
            for i, T in enumerate(sc.layers):
                if T.kind != "text":
                    continue
                ts = self.readable(T)
                if not ts:
                    continue
                for U in sc.layers[i + 1 :]:
                    if U.kind == "text" or (U.kind == "image" and U.path is not None and not U.path.exists()) or (U.group and U.group == T.group) or U.group == f"{T.group}a":
                        continue
                    for t in ts[:: max(1, len(ts) // 6)]:
                        lt = T.start + t
                        if lt < U.start or lt >= U.end:
                            continue
                        su = R.state(U, lt - U.start)
                        if su["opacity"] < 0.3:
                            continue
                        if U.kind == "shape" and U.fill is None:
                            continue
                        if U.kind == "shape" and U.fill and U.fill[0] == "solid" and (su["color"] or U.fill[1])[3] < 0.2:
                            continue
                        if U.kind == "shape" and U.fill and U.fill[0] == "grad" and max(s[1][3] for s in U.fill[1]["stops_parsed"]) < 0.2:
                            continue
                        cam = R.cam_at(sc, lt)
                        ink = R.text_box(T, R.state(T, t), t, cam)[0]
                        ub = self.bbox(U, su, cam)
                        w, h = box_overlap(ink, ub)
                        if w * h > 0.3 * max(area(ink), 1.0):
                            self.at(T)
                            self.err(T.label, f"is covered by {U.label}, which is drawn after it. Fix: move that layer before the text in \"layers\" (layers draw in order, the last on top).")
                            break
                    else:
                        continue
                    break


def run_checks(model):
    return Checker(model).run()


def print_report(path, model, problems, as_json=False):
    errors = [p for p in problems if p.level == "error"]
    warns = [p for p in problems if p.level != "error"]
    if as_json:
        print(json.dumps({"ok": not errors, "problems": [{"level": p.level, "where": p.where, "message": p.msg} for p in problems], "duration": getattr(model, "duration", None)}, indent=2))
        return
    if model is not None:
        nl = sum(len(s.layers) for s in model.scenes)
        print(f"motion check: {path}\n  {model.W}x{model.H} at {model.fps} fps, {len(model.scenes)} scene(s), {model.duration:g} s, {nl} layer(s)")
    else:
        print(f"motion check: {path}")
    for p in errors + warns:
        print("  " + p.line())
    if errors:
        print(f"result: {len(errors)} problem(s), {len(warns)} warning(s). Fix the problems, then run --check again.")
    elif warns:
        print(f"result: no problems, {len(warns)} warning(s). Read them; fix any that are not on purpose.")
    else:
        print("result: clean")


# --------------------------------------------------------------------------------------------
# Encoding
# --------------------------------------------------------------------------------------------
def pick_encoder():
    want = os.environ.get("HILDEGARD_MOTION_ENCODER")
    if want == "av":
        return "av"
    if want == "ffmpeg" or shutil.which("ffmpeg"):
        return "ffmpeg" if shutil.which("ffmpeg") else None
    try:
        import av  # noqa: F401, PLC0415

        return "av"
    except ImportError:
        return None


def audio_filter(model, duration, first_input=1):
    """The mix of the audio tracks. Their inputs start at `first_input`: 1 in the render, where input 0 is the picture."""
    tracks = model.audio or []
    parts, labels = [], []
    lufs = -14.0
    norm = True
    for i, a in enumerate(tracks):
        start = float(a.get("start", 0.0))
        chain = f"[{i + first_input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS"
        if start > 0:
            ms = int(round(start * 1000))
            chain += f",adelay={ms}|{ms}"
        if a.get("volume_db"):
            chain += f",volume={a['volume_db']}dB"
        fi, fo = float(a.get("fade_in", 0.0)), float(a.get("fade_out", 0.0))
        if fi > 0:
            chain += f",afade=t=in:st={start:g}:d={fi:g}"
        if fo > 0:
            chain += f",afade=t=out:st={max(start, duration - fo):g}:d={fo:g}"
        lufs = float(a.get("lufs", lufs))
        norm = norm and a.get("loudnorm", True)
        parts.append(chain + f"[a{i}]")
        labels.append(f"[a{i}]")
    mix = "".join(labels) + (f"amix=inputs={len(labels)}:normalize=0:duration=longest[mix]" if len(labels) > 1 else "anull[mix]")
    return parts, mix, lufs, norm


def measure_loudness(model, duration, lufs):
    ffmpeg = shutil.which("ffmpeg")
    parts, mix, _, _ = audio_filter(model, duration, first_input=0)
    graph = ";".join(parts + [mix.replace("[mix]", "[m]"), f"[m]atrim=0:{duration:g},loudnorm=I={lufs:g}:TP=-1.5:LRA=11:print_format=json[o]"])
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "info", "-y"]
    for a in model.audio:
        cmd += ["-i", str(resolve_path(a["file"], model.base_dir))]
    cmd += ["-filter_complex", graph, "-map", "[o]", "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    m = re.findall(r"\{[^{}]*\}", r.stderr)
    tail = (r.stderr.strip().splitlines() or ["ffmpeg said nothing"])[-1]
    if r.returncode != 0 or not m:
        raise SystemExit(f"could not measure the loudness of the audio: {tail}")
    try:
        j = json.loads(m[-1])
    except json.JSONDecodeError:
        raise SystemExit(f"could not measure the loudness of the audio: {tail}")
    # Silence has no loudness to measure, so it gets the plain one-pass filter.
    return None if "inf" in str(j.get("input_i", "")) else j


class FfmpegSink:
    def __init__(self, model, out, W, H, fps, duration):
        ff = shutil.which("ffmpeg")
        cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-"]
        audio = model.audio or []
        for a in audio:
            cmd += ["-i", str(resolve_path(a["file"], model.base_dir))]
        vf = "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p"
        if audio:
            parts, mix, lufs, norm = audio_filter(model, duration)
            tail = f"{mix.replace('[mix]', '[m]')};[m]"
            if norm:
                j = measure_loudness(model, duration, lufs)
                if j:
                    tail += f"loudnorm=I={lufs:g}:TP=-1.5:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true,"
                else:
                    tail += f"loudnorm=I={lufs:g}:TP=-1.5:LRA=11,"
            tail += f"apad=whole_dur={duration:g},atrim=0:{duration:g}[aout]"
            cmd += ["-filter_complex", ";".join(parts + [tail]), "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-tune", "animation", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", "-t", f"{duration:g}", str(out)]
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def write(self, rgb):
        try:
            self.p.stdin.write(rgb.tobytes())
        except BrokenPipeError:
            raise SystemExit("ffmpeg stopped early; its error is printed above")

    def close(self):
        self.p.stdin.close()
        if self.p.wait() != 0:
            raise SystemExit("ffmpeg failed; its error is printed above")


class AvSink:
    def __init__(self, model, out, W, H, fps, duration):
        import av  # noqa: PLC0415
        from fractions import Fraction  # noqa: PLC0415

        self.av = av
        self.c = av.open(str(out), "w", options={"movflags": "+faststart"})
        codec = "libx264"
        try:
            self.s = self.c.add_stream(codec, rate=fps)
        except Exception:  # noqa: BLE001
            self.s = self.c.add_stream("mpeg4", rate=fps)
            codec = "mpeg4"
        self.s.width, self.s.height, self.s.pix_fmt = W, H, "yuv420p"
        if codec == "libx264":
            self.s.options = {"crf": "17", "preset": "medium", "tune": "animation"}
        else:
            self.s.bit_rate = 12_000_000
        self.s.time_base = Fraction(1, fps)
        try:  # tag the stream as BT.709 so players decode the colors the way they were encoded
            cc = self.s.codec_context
            cc.colorspace, cc.color_primaries, cc.color_trc = 1, 1, 1
        except Exception:  # noqa: BLE001
            pass
        self.n = 0
        self.fps = fps

    def write(self, rgb):
        frame = self.av.VideoFrame.from_ndarray(rgb, format="rgb24")
        try:
            from av.video.reformatter import Colorspace  # noqa: PLC0415

            frame = frame.reformat(format="yuv420p", dst_colorspace=Colorspace.ITU709, interpolation="BICUBIC")
        except Exception:  # noqa: BLE001
            frame = frame.reformat(format="yuv420p")
        frame.pts = self.n
        self.n += 1
        for pkt in self.s.encode(frame):
            self.c.mux(pkt)

    def close(self):
        for pkt in self.s.encode():
            self.c.mux(pkt)
        self.c.close()


def render_video(model, out, scale=1.0, fps=None, hashes=None, quiet=False):
    fps = int(fps or model.fps)
    n = max(1, round(model.duration * fps))
    R = Renderer(model, scale)
    enc = pick_encoder()
    if enc is None:
        sys.exit("No video encoder: install ffmpeg (on PATH) or PyAV ({INSTALL_AV}).")
    if model.audio and enc != "ffmpeg":
        sys.exit("Audio needs ffmpeg on PATH. Install ffmpeg, or remove \"audio\" from the spec.")
    Sink = FfmpegSink if enc == "ffmpeg" else AvSink
    sink = Sink(model, out, R.W, R.H, fps, model.duration)
    step = max(1, n // 10)
    prev_sig, rgb, digest = None, None, None
    for k in range(n):
        t = min(k / fps, model.duration - 1e-6)
        sig = R.signature(t)
        if sig != prev_sig:  # a held moment is drawn once and written again
            rgb = R.to_uint8(R.render_frame(t))
            digest = None
            prev_sig = sig
        if hashes is not None:
            digest = digest or hashlib.sha256(rgb.tobytes()).hexdigest()
            hashes.append(digest)
        sink.write(rgb)
        if not quiet and k % step == 0:
            print(f"  rendering {k * 100 // n}% (frame {k + 1} of {n})", file=sys.stderr, flush=True)
    sink.close()
    return {"frames": n, "fps": fps, "width": R.W, "height": R.H, "duration": n / fps, "encoder": enc}


# --------------------------------------------------------------------------------------------
# Preview: 8 frames on one sheet
# --------------------------------------------------------------------------------------------
def preview_times(model, count=8):
    cands = []
    for sc in model.scenes:
        lo, hi = sc.start + sc.t_in, sc.end - sc.t_out
        if hi <= lo:
            lo, hi = sc.start, sc.end
        cands += [lo + (hi - lo) * 0.3, lo + (hi - lo) * 0.92]
    fd = model.fade or {}
    first = (fd.get("in", 0) + 0.15) if fd.get("in") else 0.0
    last = model.duration - 1.0 / model.fps - ((fd.get("out", 0) + 0.15) if fd.get("out") else 0.0)
    cands.append(last)
    cands = sorted(set(round(min(max(c, first), last), 3) for c in cands))
    if len(cands) > count:
        keep = {0, len(cands) - 1}
        for i in range(1, count - 1):
            keep.add(round(i * (len(cands) - 1) / (count - 1)))
        cands = [cands[i] for i in sorted(keep)][:count]
    grid = [round(first + i * (last - first) / 200, 3) for i in range(201)]
    while len(cands) < count:  # add the moment farthest from every frame already chosen
        cands.append(max(grid, key=lambda g: min(abs(g - c) for c in cands)))
    cands = sorted(cands)
    return cands[:count]


def make_preview(model, path, tile_w=640):
    R = Renderer(model, min(1.0, tile_w / model.W))
    times = preview_times(model)
    tiles = [Image.fromarray(R.to_uint8(R.render_frame(t)), "RGB") for t in times]
    tw, th = tiles[0].size
    cols = 4
    rows = (len(tiles) + cols - 1) // cols
    gap, bar = 8, 26
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * gap, rows * (th + bar) + (rows + 1) * gap), (24, 24, 28))
    d = ImageDraw.Draw(sheet)
    f = ImageFont.load_default(15)
    for i, (t, im) in enumerate(zip(times, tiles)):
        x = gap + (i % cols) * (tw + gap)
        y = gap + (i // cols) * (th + bar + gap)
        sheet.paste(im, (x, y))
        d.text((x + 2, y + th + 5), f"{i + 1}  {t:.2f} s", fill=(220, 220, 225), font=f)
    sheet.save(path, quality=90)
    return times


# --------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------
def cmd_fonts(action):
    if action == "json":
        out = []
        for fam, pins in FONT_PINS.items():
            for style, (rel, sha) in pins.items():
                out.append({"family": fam, "style": style, "license": "OFL-1.1", "url": FONTS_BASE + urllib.parse.quote(rel), "sha256": sha, "commit": FONTS_COMMIT})
        print(json.dumps(out, indent=1))
        return 0
    print(f"Pinned Google Fonts (SIL Open Font License 1.1), google/fonts at {FONTS_COMMIT[:10]}; cache: {font_cache_dir()}")
    for fam, pins in FONT_PINS.items():
        for style in ("regular", "italic"):
            if style not in pins:
                continue
            italic = style == "italic"
            if action == "fetch":
                p, err = ensure_font(fam, italic)
                state = f"cached {p.name}" if p else f"FAILED: {err}"
            else:
                p = cached_font_path(fam, italic)
                state = "cached" if p.exists() and _sha256(p) == pins[style][1] else "not cached (downloaded on first use)"
            print(f"  {fam} {style}: {state}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Draw a video from a JSON spec. See references/spec.md.")
    ap.add_argument("spec", nargs="?", help="the spec file (JSON)")
    ap.add_argument("out", nargs="?", help="the MP4 to write")
    ap.add_argument("--check", action="store_true", help="validate and print problems; render nothing")
    ap.add_argument("--preview", metavar="SHEET.jpg", help="write a contact sheet of 8 frames")
    ap.add_argument("--force", action="store_true", help="render even if --check finds problems")
    ap.add_argument("--scale", type=float, default=1.0, help="output size factor, for fast drafts (0.5 renders half size)")
    ap.add_argument("--fps", type=int, help="override the frame rate (for drafts)")
    ap.add_argument("--hashes", metavar="FILE", help="write the SHA-256 of every frame (proves a render is repeatable)")
    ap.add_argument("--json", action="store_true", help="print the check report as JSON")
    ap.add_argument("--fonts", nargs="?", const="list", choices=["list", "fetch", "json"], help="list the pinned fonts, or fetch them all")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # curly quotes and ellipses must not crash a Windows console
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    if a.fonts:
        return cmd_fonts(a.fonts)
    if not a.spec:
        ap.error("give a spec file, for example: python3 motion.py spec.json out.mp4 --check")
    if a.spec and a.spec.lower().endswith(".mp4"):
        ap.error("the spec comes first: python3 motion.py spec.json out.mp4")
    model, problems = compile_spec(a.spec)
    if model is not None:
        try:
            problems = problems + run_checks(model)
        except Exception as e:  # noqa: BLE001 - a spec with problems may not be measurable; say the problems, not a traceback
            if not any(p.level == "error" for p in problems):
                raise
            problems.append(Problem("error", "check", f"could not finish the measuring checks ({type(e).__name__}) because of the problems above. Fix them, then run --check again."))
    errors = [p for p in problems if p.level == "error"]
    if a.check or model is None or (errors and not a.out and not a.preview):
        print_report(a.spec, model, problems, a.json)
        if a.check or model is None:
            return 1 if errors else 0
    if model is None:
        return 1
    if errors or any(p.level != "error" for p in problems):
        if not a.check:
            for p in problems:
                print(("  " + p.line()), file=sys.stderr)
    if a.preview:
        times = make_preview(model, a.preview)
        print(f"preview: {a.preview} ({', '.join(f'{t:.1f}s' for t in times)})")
    if a.out:
        if errors and not a.force:
            print(f"Not rendering: {len(errors)} problem(s) above. Fix them and run again, or pass --force to render anyway.", file=sys.stderr)
            return 1
        hashes = [] if a.hashes else None
        info = render_video(model, a.out, a.scale, a.fps, hashes, a.quiet)
        if a.hashes:
            Path(a.hashes).write_text("\n".join(hashes) + "\n")
        print(f"wrote {a.out}: {info['width']}x{info['height']}, {info['fps']} fps, {info['frames']} frames, {info['duration']:.2f} s ({info['encoder']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
