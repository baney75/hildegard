# SPDX-License-Identifier: AGPL-3.0-only
"""The edit list contract: load it, check it against edl.schema.json, and say what is wrong in plain words.

`validate` is a small JSON Schema checker (the subset edl.schema.json uses), so nothing has to be installed. Errors name
the field the way a person would find it: `keep[2].end`, `music.fade_out`. An unknown field is an error that lists the
allowed ones and the closest match, since that is the usual slip.
"""

import difflib
import hashlib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "edl.schema.json")


class EdlError(Exception):
    """The edit list can't be used; the message says why in one or two plain sentences."""

    def __init__(self, message, errors=None):
        super().__init__(message)
        self.errors = errors or []


def schema():
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        return json.load(f)


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise EdlError(f"There is no edit list at {path}.")
    except json.JSONDecodeError as e:
        raise EdlError(f"{os.path.basename(path)} isn’t valid JSON: {e.msg} at line {e.lineno}, column {e.colno}.")


# What the gate reads and the renderer doesn't: changing these needs no new render.
NOT_RENDERED = ("verify", "secrets")


def render_key(edl, base_dir):
    """A SHA-256 of everything in the edit list that goes into the video, with the transcript file it names, so the gate
    can tell whether a video was rendered from this very list."""
    body = {k: v for k, v in edl.items() if k not in NOT_RENDERED}
    if isinstance(edl.get("sources"), dict):
        body["source_order"] = list(edl["sources"])  # sort_keys erases it, and with no keep list the first source plays first
    caps = edl.get("captions")
    if isinstance(caps, dict) and isinstance(caps.get("transcript"), str):
        try:
            with open(os.path.join(base_dir, caps["transcript"]), "rb") as f:
                body["captions"] = dict(caps, transcript_sha256=hashlib.sha256(f.read()).hexdigest())
        except OSError:
            pass
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


# ── JSON Schema subset ──────────────────────────────────────────────────────────────────────────────────────────


def _type_ok(v, t):
    if t == "string":
        return isinstance(v, str)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")
    if t == "integer":
        return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())
    if t == "boolean":
        return isinstance(v, bool)
    if t == "array":
        return isinstance(v, list)
    if t == "object":
        return isinstance(v, dict)
    if t == "null":
        return v is None
    return True


def _name(t):
    return {"string": "text", "number": "a number", "integer": "a whole number", "boolean": "true or false",
            "array": "a list", "object": "an object"}.get(t, t)


def _resolve(root, node):
    while "$ref" in node:
        ref = node["$ref"]
        cur = root
        for part in ref.lstrip("#/").split("/"):
            cur = cur[part]
        node = cur
    return node


def _join(path, key):
    return f"{path}.{key}" if path else str(key)


def _check(root, node, v, path, errs):
    node = _resolve(root, node)
    if "const" in node and v != node["const"]:
        errs.append((path, f"must be {json.dumps(node['const'])}"))
        return
    if "enum" in node and v not in node["enum"]:
        errs.append((path, "must be one of " + ", ".join(json.dumps(x) for x in node["enum"])))
        return
    for key in ("oneOf", "anyOf"):
        if key in node:
            tries = []
            for sub in node[key]:
                e = []
                _check(root, sub, v, path, e)
                if not e:
                    break
                tries.append(e)
            else:
                # Report the alternative that fit the value's kind best; if none did, say what is allowed.
                kind = [s for s in node[key] if _type_ok(v, _resolve(root, s).get("type", "object"))
                        or ("enum" in _resolve(root, s) and isinstance(v, str))]
                if kind:
                    e = []
                    _check(root, kind[-1] if isinstance(v, dict) else kind[0], v, path, e)
                    errs.extend(e)
                else:
                    errs.append((path, "isn’t in a form the edit list accepts here"))
            return
    t = node.get("type")
    if t and not _type_ok(v, t):
        errs.append((path, f"must be {_name(t)}"))
        return
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in node and v < node["minimum"]:
            errs.append((path, f"must be at least {node['minimum']:g}"))
        if "maximum" in node and v > node["maximum"]:
            errs.append((path, f"must be at most {node['maximum']:g}"))
    if isinstance(v, str):
        if "minLength" in node and len(v) < node["minLength"]:
            errs.append((path, "can’t be empty" if node["minLength"] == 1 else f"needs at least {node['minLength']} characters"))
        if "maxLength" in node and len(v) > node["maxLength"]:
            errs.append((path, f"is too long (at most {node['maxLength']} characters)"))
        if "pattern" in node and not re.search(node["pattern"], v):
            errs.append((path, f"isn’t in the right form (expected {node['pattern']})"))
    if isinstance(v, list):
        if "minItems" in node and len(v) < node["minItems"]:
            errs.append((path, f"needs at least {node['minItems']} items"))
        if "maxItems" in node and len(v) > node["maxItems"]:
            errs.append((path, f"has too many items (at most {node['maxItems']})"))
        if "items" in node:
            for i, item in enumerate(v):
                _check(root, node["items"], item, f"{path}[{i}]", errs)
    if isinstance(v, dict):
        props = node.get("properties", {})
        for r in node.get("required", []):
            if r not in v:
                errs.append((_join(path, r), "is missing"))
        if "minProperties" in node and len(v) < node["minProperties"]:
            errs.append((path, f"needs at least {node['minProperties']} entries"))
        if "maxProperties" in node and len(v) > node["maxProperties"]:
            errs.append((path, f"has too many entries (at most {node['maxProperties']})"))
        names = node.get("propertyNames")
        extra = node.get("additionalProperties", True)
        for k, item in v.items():
            if names and "pattern" in names and not re.search(names["pattern"], k):
                errs.append((_join(path, k), "is not a valid name: start with a lowercase letter, then letters, digits, - or _"))
            if k in props:
                _check(root, props[k], item, _join(path, k), errs)
            elif extra is False:
                allowed = sorted(props)
                close = difflib.get_close_matches(k, allowed, n=1)
                hint = f" Did you mean “{close[0]}”?" if close else ""
                errs.append((_join(path, k), f"isn’t a field here.{hint} Allowed: {', '.join(allowed)}."))
            elif isinstance(extra, dict):
                _check(root, extra, item, _join(path, k), errs)


def validate(edl):
    """[(path, message)] for everything wrong with the shape of `edl`; empty when it fits the schema."""
    errs = []
    if not isinstance(edl, dict):
        return [("", "The edit list must be a JSON object.")]
    _check(schema(), schema(), edl, "", errs)
    # A field the schema names but the person left empty is never useful; keep the message in the order found.
    return errs


# ── Small helpers every module shares ───────────────────────────────────────────────────────────────────────────


def parse_aspect(text):
    """'9:16' → 0.5625."""
    a, b = text.split(":")
    if int(b) == 0 or int(a) == 0:
        raise EdlError(f"“{text}” isn’t an aspect ratio. Use 9:16, 1:1, 4:5 or 16:9.")
    return int(a) / int(b)


def default_source(edl):
    """The only source's id, or None when there are several."""
    ids = list(edl["sources"])
    return ids[0] if len(ids) == 1 else None


def source_of(edl, item, where, errors):
    """The id of the source an item means: its own, or the only one. Records an error when it can't be told."""
    s = item.get("source")
    if s is None:
        s = default_source(edl)
        if s is None:
            errors.append((where, "needs a source: there is more than one in the edit list"))
        return s
    if s not in edl["sources"]:
        errors.append((f"{where}.source", f"“{s}” isn’t one of the sources ({', '.join(edl['sources'])})"))
        return None
    return s
