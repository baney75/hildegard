#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic anti-slop HTML/CSS linter, prescriptive web linter, DESIGN.md schema checker, art/VFX contract checker, and SVG logo checker.

  python3 -B check_design.py --html FILE_OR_DIR [--json]
  python3 -B check_design.py --web-lint FILE_OR_DIR [--fidelity] [--json]
  python3 -B check_design.py --design-md DESIGN.md [--json]
  python3 -B check_design.py --iso ISO.json [--pre-render] [--json]
  python3 -B check_design.py --ink-anim INK.json [--pre-render] [--json]
  python3 -B check_design.py --sakuga SAKUGA.json [--pre-render] [--json]
  python3 -B check_design.py --logo LOGO.svg [--allow-draft-text] [--surface #FFFFFF] [--json]

Pure Python 3 stdlib (zero external dependencies).
"""

import argparse
import colorsys
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

SKIP_DIRS = {"node_modules", ".git", "__pycache__", "dist", "build"}
HTML_EXTS = {".html", ".htm"}
CSS_EXTS = {".css"}
WEB_EXTS = HTML_EXTS | CSS_EXTS

CSS_COMMENT_RE = re.compile(r"/\*[\s\S]*?\*/")
STYLE_TAG_RE = re.compile(r"<style\b[^>]*>([\s\S]*?)</style>", re.I)
INLINE_STYLE_RE = re.compile(r'\bstyle\s*=\s*(?:"([^"]*)"|\'([^\']*)\')', re.I)
VW_100_RE = re.compile(r"(?:width|min-width|max-width)\s*:\s*100vw\b", re.I)
HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b")
RGB_COLOR_RE = re.compile(r"\b(?:rgba?|hsla?|oklch|oklab)\s*\(", re.I)
URL_FUNC_RE = re.compile(r"\burl\s*\([^)]*\)", re.I)
QUOTED_STR_RE = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'')
PURPLE_BLUE_GRAD_RE = re.compile(
    r"linear-gradient\([^)]*(?:#(?:[5-9a-d][0-9a-f][0-5][0-9a-f][a-f][0-9a-f]|6366f1|7c3aed|8b5cf6|a855f7)|purple|violet|indigo)[^)]*(?:#(?:[0-4][0-9a-f][5-9a-f][0-9a-f][c-f][0-9a-f]|3b82f6|2563eb|06b6d4)|blue|cyan)",
    re.I,
)
ITALIC_WORD_IN_HEADING_RE = re.compile(r"<h[1-6]\b[^>]*>[^<]*<(?:em|i)\b[^>]*>[^<\s]+</(?:em|i)>[^<]*</h[1-6]>", re.I)
SLOP_COPY_RE = re.compile(r"\b(?:lorem\s+ipsum|unlock\s+the\s+power\s+of|reimagined\b|elevate\s+your)\b", re.I)
INTERACTIVE_TAG_RE = re.compile(r"<(?:button|a\s+[^>]*href|input|select|textarea)\b", re.I)
HAS_MOTION_RE = re.compile(r"@keyframes\b|\b(?:transition|animation)\s*:", re.I)

YAML_FENCE_RE = re.compile(r"```yaml\s*\n([\s\S]*?)```", re.I)
TOKEN_REF_RE = re.compile(r"\{([a-zA-Z0-9_.-]+)\}")
EXT_REF_RE = re.compile(r"(?<![A-Za-z0-9_.+-])@([^\s`\"'()\[\]<>#,;]+)")
CSS_AT_RULES = {"media", "font-face", "import", "keyframes", "layer", "supports", "charset", "property", "container", "scope", "starting-style", "page"}
HEX_STRICT_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
COLOR_FUNC_PREFIX_RE = re.compile(r"^(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color-mix)\(", re.I)
CSS_NAMED_COLORS = {
    "transparent", "currentcolor", "black", "white", "silver", "gray", "grey", "maroon", "red", "purple",
    "fuchsia", "magenta", "green", "lime", "olive", "yellow", "navy", "blue", "teal", "aqua", "cyan",
    "orange", "aliceblue", "antiquewhite", "aquamarine", "azure", "beige", "bisque", "blanchedalmond",
    "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
    "cornsilk", "crimson", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
    "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon",
    "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet",
    "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
    "gainsboro", "ghostwhite", "gold", "goldenrod", "greenyellow", "honeydew", "hotpink", "indianred",
    "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue",
    "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink",
    "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
    "lightyellow", "limegreen", "linen", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
    "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred",
    "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite", "oldlace", "olivedrab", "orangered",
    "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
    "peru", "pink", "plum", "powderblue", "rebeccapurple", "rosybrown", "royalblue", "saddlebrown", "salmon",
    "sandybrown", "seagreen", "seashell", "sienna", "skyblue", "slateblue", "slategray", "slategrey", "snow",
    "springgreen", "steelblue", "tan", "thistle", "tomato", "turquoise", "violet", "wheat", "whitesmoke",
    "yellowgreen",
}
TIMING_KEYWORDS = {"ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end", "allow-discrete", "normal"}
LAYOUT_PROPS = {"width", "height", "top", "left"}
METADATA_KEYS = {"version", "name", "description", "omitted"}
ISO_KNOWN_KEYS = {"tier", "azimuth_deg", "elevation_deg", "tones", "lit_count", "parts", "depth_sorted", "floating_line_ends", "closeup_4x_checked", "themes_checked"}
ISO_TIER_MIN = {"figure": 40, "hero": 80, "epic": 150}
ISO_ROOT_HOSTS = {"ground", "base", "bench", "floor", "stand"}
INK_ANIM_KNOWN_KEYS = {"open_stroke_limbs", "curved_lines", "gait", "skeleton_first_cloth", "card_fixed_bg", "palette_tokens", "debug_stepping", "zoomed_strip_checked", "day_cycle_checked"}
INK_GAIT_KINDS = {"walk", "shuffle", "run"}
SAKUGA_KNOWN_KEYS = {"control", "plain_at_rest", "immediate_state_change", "beats", "shared_clock_canvas", "visual_rules", "css_vars", "verification"}
SAKUGA_CONTROLS = {"button", "toggle", "switch", "slider", "checkbox", "radio", "input", "tabs", "progress", "rating", "toast", "tooltip"}
SAKUGA_BEAT_ORDER = ("anticipation", "hit", "follow_through", "settle")
EMOJI_EXTRA_CPS = {0x26A0, 0x26A1, 0x2705, 0x2728, 0x274C, 0x2764}
ROOT_THEME_SEL_RE = re.compile(
    r"^(?::root(?:\[data-theme[^\]]*\])?|html(?:\[data-theme[^\]]*\])?|\[data-theme[^\]]*\])$",
    re.I,
)
GROUPING_AT_RULE_RE = re.compile(r"^@(?:media|supports|layer|container)(?:\s|\(|$)", re.I)
YAML_LIST_MAP_RE = re.compile(r'^("(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$')


def _chk(cid, ok, value, limit, detail):
    return {"id": cid, "ok": bool(ok), "value": value, "limit": limit, "detail": detail}


def _has_emoji(text):
    for ch in text:
        cp = ord(ch)
        if (0x1F300 <= cp <= 0x1FAFF) or cp in EMOJI_EXTRA_CPS:
            return True
    return False


def _is_valid_css_color(val):
    s = val.strip()
    if re.fullmatch(r"\{[a-zA-Z0-9_.-]+\}", s):
        return True
    if HEX_STRICT_RE.match(s):
        return True
    if s.lower() in CSS_NAMED_COLORS:
        return True
    if COLOR_FUNC_PREFIX_RE.match(s) and s.endswith(")"):
        depth = 0
        for idx, ch in enumerate(s):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth < 0 or (depth == 0 and idx != len(s) - 1):
                    return False
        return depth == 0
    return False


def _split_grouping_stack(sel_stack):
    """Return non-@ selectors when every @ frame in sel_stack is a grouping at-rule, else None."""
    non_at = []
    for frame in sel_stack:
        s = frame.strip()
        if not s:
            return None
        if s.startswith("@"):
            if not GROUPING_AT_RULE_RE.match(s):
                return None
        else:
            non_at.append(s)
    return non_at


def _is_root_theme_stack(sel_stack):
    """True iff sel_stack has one root/theme token selector plus optional grouping at-rules."""
    non_at = _split_grouping_stack(sel_stack)
    if non_at is None or len(non_at) != 1:
        return False
    parts = [p.strip() for p in non_at[0].split(",") if p.strip()]
    return bool(parts) and all(ROOT_THEME_SEL_RE.match(p) for p in parts)


def _is_html_body_stack(sel_stack):
    """True iff sel_stack has one non-@ selector targeting html or body plus optional grouping at-rules."""
    non_at = _split_grouping_stack(sel_stack)
    if non_at is None or len(non_at) != 1:
        return False
    parts = [p.strip().lower() for p in non_at[0].split(",") if p.strip()]
    return any(p in ("html", "body") for p in parts)


def _is_font_face_stack(sel_stack):
    return bool(sel_stack) and sel_stack[-1].strip().lower().startswith("@font-face")


def _iter_declarations(css):
    """Yield (sel_stack_tuple, prop, val) for declarations at any CSS nesting depth (never selectors)."""
    sel_stack = []
    buf = []
    in_sq = in_dq = False
    i, n = 0, len(css)
    while i < n:
        ch = css[i]
        if ch == "\\" and (in_sq or in_dq) and i + 1 < n:
            buf.append(ch)
            buf.append(css[i + 1])
            i += 2
            continue
        if ch == "'" and not in_dq:
            in_sq = not in_sq
            buf.append(ch)
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
            buf.append(ch)
        elif not in_sq and not in_dq and ch == "{":
            sel = "".join(buf).strip()
            sel_stack.append(sel)
            buf = []
        elif not in_sq and not in_dq and ch in (";", "}"):
            seg = "".join(buf).strip()
            buf = []
            if sel_stack and ":" in seg and not seg.startswith("@"):
                prop, val = seg.split(":", 1)
                prop = prop.strip().lower()
                if prop and re.fullmatch(r"(?:--[a-z0-9_-]+|[a-z-]+)", prop):
                    yield tuple(sel_stack), prop, val.strip()
            if ch == "}" and sel_stack:
                sel_stack.pop()
        else:
            buf.append(ch)
        i += 1


def _is_bad_transition(prop, val):
    """Return (transition_all_hit, layout_prop_hit) for transition / transition-property declarations."""
    t_all = False
    l_prop = False
    val_no_imp = re.sub(r"\s*!important\s*$", "", val, flags=re.I)
    # Strip var(...) and cubic-bezier(...) / steps(...) parens so tokens like var(--t-all) never false-match
    cleaned = re.sub(r"\b(?:var|cubic-bezier|steps)\s*\([^)]*\)", " ", val_no_imp, flags=re.I)
    for item in cleaned.split(","):
        s = item.strip().lower()
        if not s or s == "none":
            continue
        tokens = [tok for tok in re.split(r"\s+", s) if tok]
        if prop == "transition-property":
            for tok in tokens:
                if tok == "all":
                    t_all = True
                elif tok in LAYOUT_PROPS:
                    l_prop = True
            continue
        # transition shorthand: inspect non-time, non-easing property tokens
        prop_tokens = [
            tok
            for tok in tokens
            if tok not in TIMING_KEYWORDS and not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)m?s", tok)
        ]
        if not prop_tokens:
            # Bare timing shorthand (e.g. `transition: 200ms ease-out`) implicitly transitions `all`
            t_all = True
        for tok in prop_tokens:
            if tok == "all":
                t_all = True
            elif tok in LAYOUT_PROPS:
                l_prop = True
    return t_all, l_prop


def check_html_path(target):
    if not os.path.exists(target):
        return {"ok": False, "checks": [_chk("html_path_exists", False, target, "existing file or directory", "HTML/CSS path does not exist")]}
    files = []
    if os.path.isfile(target):
        if os.path.splitext(target)[1].lower() in WEB_EXTS:
            files.append((target, os.path.basename(target)))
    elif os.path.isdir(target):
        for root, dirs, names in os.walk(target):
            dirs[:] = [d for d in sorted(dirs) if d not in SKIP_DIRS]
            for name in sorted(names):
                if os.path.splitext(name)[1].lower() in WEB_EXTS:
                    p = os.path.join(root, name)
                    files.append((p, os.path.relpath(p, target)))
    if not files:
        return {"ok": False, "checks": [_chk("html_files_scanned", False, 0, ">= 1 .html/.css file", f"no HTML or CSS files found under {target}")]}

    all_html = []
    all_css = []
    inline_css = []
    for path, _ in files:
        ext = os.path.splitext(path)[1].lower()
        text = open(path, encoding="utf-8", errors="replace").read()
        if ext in HTML_EXTS:
            all_html.append(text)
            for sm in STYLE_TAG_RE.finditer(text):
                all_css.append(sm.group(1))
            for im in INLINE_STYLE_RE.finditer(text):
                style_val = im.group(1) if im.group(1) is not None else im.group(2)
                if style_val and style_val.strip():
                    inline_css.append(f"inline-style {{ {style_val} }}")
        else:
            all_css.append(text)

    html_blob = "\n".join(all_html)
    css_blob = CSS_COMMENT_RE.sub(" ", "\n".join(all_css + inline_css))

    checks = [_chk("html_files_scanned", True, len(files), ">= 1 .html/.css file", "HTML/CSS files audited")]

    if css_blob.strip():
        all_decls = list(_iter_declarations(css_blob))
        has_root_tokens = False
        raw_colors = []
        raw_fonts = []
        trans_all = False
        layout_anim = False
        ov_hidden = False
        for sel_stack, prop, v in all_decls:
            is_root_theme = _is_root_theme_stack(sel_stack)
            is_font_face = _is_font_face_stack(sel_stack)
            if prop.startswith("--"):
                if is_root_theme:
                    has_root_tokens = True
                    continue
            if not is_font_face:
                if prop != "content":
                    scrubbed = QUOTED_STR_RE.sub(" ", URL_FUNC_RE.sub(" ", v))
                    raw_colors.extend(HEX_COLOR_RE.findall(scrubbed))
                    raw_colors.extend(RGB_COLOR_RE.findall(scrubbed))
                if prop == "font-family" and "var(" not in v and v.lower() not in ("inherit", "initial", "unset"):
                    raw_fonts.append(v)
            if prop in ("transition", "transition-property"):
                ta, lp = _is_bad_transition(prop, v)
                trans_all = trans_all or ta
                layout_anim = layout_anim or lp
            if prop == "overflow-x":
                ov_clean = re.sub(r"\s*!important\s*$", "", v, flags=re.I).strip().lower()
                ov_tokens = ov_clean.split()
                if ov_tokens and ov_tokens[0] == "hidden" and _is_html_body_stack(sel_stack):
                    ov_hidden = True

        token_ok = has_root_tokens and not raw_colors and not raw_fonts
        detail_val = "clean" if token_ok else {"has_root_tokens": has_root_tokens, "raw_colors": raw_colors[:5], "raw_fonts": raw_fonts[:5]}
        checks.append(_chk("css_tokens", token_ok, detail_val, "all colors and fonts via :root custom properties", "declare tokens in :root and reference them with var(--*)"))

        checks.append(_chk("no_transition_all", not trans_all and not layout_anim, "clean" if (not trans_all and not layout_anim) else {"transition_all": trans_all, "layout_prop": layout_anim}, "no transition:all or width/height/top/left animation", "animate transform/opacity only, never transition: all"))

        vw_bad = bool(VW_100_RE.search(css_blob))
        checks.append(_chk("safe_overflow", not vw_bad and not ov_hidden, "clean" if (not vw_bad and not ov_hidden) else {"100vw": vw_bad, "overflow_x_hidden": ov_hidden}, "no 100vw width or html/body overflow-x: hidden (use clip)", "use overflow-x: clip and avoid 100vw scrollbar overflow"))

        if HAS_MOTION_RE.search(css_blob):
            has_rm = "prefers-reduced-motion" in css_blob
            checks.append(_chk("reduced_motion", has_rm, has_rm, True, "animations include a prefers-reduced-motion fallback"))

    if INTERACTIVE_TAG_RE.search(html_blob):
        has_focus = ":focus-visible" in css_blob
        checks.append(_chk("focus_visible", has_focus, has_focus, True, "interactive controls define :focus-visible styling"))

    slop_hits = []
    if PURPLE_BLUE_GRAD_RE.search(css_blob):
        slop_hits.append("purple-blue-gradient")
    if ITALIC_WORD_IN_HEADING_RE.search(html_blob):
        slop_hits.append("italic-word-in-heading")
    m_copy = SLOP_COPY_RE.search(html_blob)
    if m_copy:
        slop_hits.append(f"slop-copy:{m_copy.group(0)}")
    if _has_emoji(html_blob):
        slop_hits.append("emoji-in-markup")
    checks.append(_chk("no_slop_patterns", not slop_hits, slop_hits or "clean", "[]", "no purple-blue gradients, emoji icons, italic-word headings, or filler copy"))

    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def _strip_yaml_comment(raw):
    in_sq = in_dq = False
    for i, ch in enumerate(raw):
        if ch == "'" and not in_dq:
            in_sq = not in_sq
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
        elif ch == "#" and not in_sq and not in_dq and (i == 0 or raw[i - 1].isspace()):
            if not re.match(r"#[0-9a-fA-F]{3,8}(?:\s|$)", raw[i:]):
                return raw[:i].rstrip()
    return raw.rstrip()


def _parse_simple_yaml(block):
    """Minimal stdlib YAML subset parser; returns (root, duplicate_top_keys, all_color_maps)."""
    root = {}
    dup_top = []
    color_maps = []
    stack = [(-1, root, None)]  # (indent, container, key_in_parent)
    for raw in block.splitlines():
        line = _strip_yaml_comment(raw)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if stripped.startswith("- "):
            # Support both 0-indented (same indent as parent key) and indented block lists (including lists of mappings)
            while len(stack) > 1 and indent < stack[-1][0]:
                stack.pop()
            if len(stack) > 1 and not isinstance(stack[-1][1], list) and indent <= stack[-1][0]:
                # Only pop a non-list item if its container was a previous list-item mapping
                if stack[-1][2] is None and isinstance(stack[-2][1], list):
                    stack.pop()
            _, container, k_in_parent = stack[-1]
            if (
                isinstance(container, dict)
                and container == {}
                and len(stack) > 1
                and k_in_parent is not None
                and isinstance(stack[-2][1], dict)
            ):
                lst = []
                stack[-2][1][k_in_parent] = lst
                stack[-1] = (stack[-1][0], lst, k_in_parent)
                container = lst
            item_raw = stripped[2:].strip()
            if isinstance(container, list):
                m_item = YAML_LIST_MAP_RE.match(item_raw)
                if m_item:
                    ik = m_item.group(1).strip().strip("\"'")
                    iv = (m_item.group(2) or "").strip().strip("\"'")
                    entry = {ik: iv} if iv else {ik: {}}
                    if k_in_parent == "omitted" and ik == "section" and iv:
                        container.append(iv)
                    else:
                        container.append(entry)
                    stack.append((indent + 1, entry, None))
                else:
                    container.append(item_raw.strip("\"'"))
            continue
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if not isinstance(parent, dict):
            continue
        if ":" not in stripped:
            continue
        key, rest = stripped.split(":", 1)
        key = key.strip().strip("\"'")
        val = rest.strip()
        if parent is root and key in root:
            dup_top.append(key)
        if val == "":
            child = {}
            if parent is root and key == "colors":
                color_maps.append(child)
            parent[key] = child
            stack.append((indent, child, key))
        else:
            if val.startswith("[") and val.endswith("]"):
                parent[key] = [x.strip().strip("\"'") for x in val[1:-1].split(",") if x.strip()]
            else:
                parent[key] = val.strip("\"'")
    return root, dup_top, color_maps


def _flatten_tokens(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                out[path] = v
                out.update(_flatten_tokens(v, path))
            else:
                out[path] = v
    return out


def _resolve_token_ref(start_key, ref, flat):
    """Resolve {ref} transitively, rejecting missing, group, metadata, and cyclic references."""
    seen = {start_key}
    cur = ref
    while True:
        if cur in seen:
            return None, "cycle", cur
        if cur in METADATA_KEYS:
            return None, "non-token", cur
        if cur not in flat:
            return None, "missing", cur
        seen.add(cur)
        val = flat[cur]
        if isinstance(val, dict):
            if start_key.startswith("components.") and "." in cur and val and all(not isinstance(x, dict) for x in val.values()):
                return val, "composite", cur
            return None, "group", cur
        if isinstance(val, list):
            return None, "group", cur
        if isinstance(val, str):
            m_full = re.fullmatch(r"\{([a-zA-Z0-9_.-]+)\}", val.strip())
            if m_full:
                cur = m_full.group(1)
                continue
        return val, "scalar", cur


def check_design_md(path):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("design_md_exists", False, path, "existing DESIGN.md file", "DESIGN.md file not found")]}
    text = open(path, encoding="utf-8", errors="replace").read()
    blocks = []
    if text.startswith("---\n") or text.startswith("---\r\n"):
        parts = re.split(r"^---\s*$", text, maxsplit=2, flags=re.M)
        if len(parts) >= 3:
            blocks.append(parts[1])
            body = parts[2]
        else:
            body = text
    else:
        body = text
    for m in YAML_FENCE_RE.finditer(body):
        blocks.append(m.group(1))

    merged = {}
    dup_keys = []
    all_color_maps = []
    for blk in blocks:
        parsed, block_dups, blk_colors = _parse_simple_yaml(blk)
        dup_keys.extend(block_dups)
        all_color_maps.extend(blk_colors)
        for k, v in parsed.items():
            if k in merged:
                dup_keys.append(k)
            else:
                merged[k] = v

    checks = []
    checks.append(_chk("yaml_blocks_present", bool(blocks), len(blocks), ">= 1 YAML token block", "DESIGN.md embeds YAML front matter or fenced yaml token blocks"))
    checks.append(_chk("unique_top_keys", not dup_keys, dup_keys or "unique", "[]", "each top-level schema key is defined at most once"))

    raw_omitted = merged.get("omitted")
    if isinstance(raw_omitted, list):
        omitted = {
            x if isinstance(x, str) else x.get("section", "")
            for x in raw_omitted
            if isinstance(x, str) or (isinstance(x, dict) and isinstance(x.get("section"), str))
        } - {""}
    elif isinstance(raw_omitted, dict):
        omitted = {k for k in raw_omitted.keys() if isinstance(k, str)}
    else:
        omitted = set()
    has_name = isinstance(merged.get("name"), str) and bool(merged["name"].strip())
    has_colors = ("colors" in merged and isinstance(merged["colors"], dict) and bool(merged["colors"])) or ("colors" in omitted)
    checks.append(_chk("required_fields", has_name and has_colors, {"name": has_name, "colors_or_omitted": has_colors}, "name + colors (or omitted)", "DESIGN.md defines name and colors palette"))

    flat = _flatten_tokens(merged)
    bad_colors = []
    for cmap in all_color_maps:
        for k, v in _flatten_tokens(cmap, "colors").items():
            if isinstance(v, str) and not _is_valid_css_color(v):
                bad_colors.append(f"{k}={v}")
    checks.append(_chk("valid_color_tokens", not bad_colors, bad_colors or "valid", "[]", "color tokens use valid CSS color syntax or token references"))

    broken_refs = []
    for cmap in all_color_maps:
        for k, v in _flatten_tokens(cmap, "colors").items():
            if isinstance(v, str):
                for rm in TOKEN_REF_RE.finditer(v):
                    ref = rm.group(1)
                    resolved_val, kind, terminal = _resolve_token_ref(k, ref, flat)
                    if resolved_val is None:
                        broken_refs.append(f"{k}->{{{ref}}}({kind})")
                    elif kind != "scalar" or not terminal.startswith("colors."):
                        broken_refs.append(f"{k}->{{{ref}}}(non-color)")
    for k, v in flat.items():
        if k.startswith("colors."):
            continue
        if isinstance(v, str):
            for rm in TOKEN_REF_RE.finditer(v):
                ref = rm.group(1)
                resolved_val, kind, _ = _resolve_token_ref(k, ref, flat)
                if resolved_val is None:
                    broken_refs.append(f"{k}->{{{ref}}}({kind})")
    checks.append(_chk("token_refs_valid", not broken_refs, broken_refs or "valid", "[]", "every {path.to.token} reference resolves to a non-cyclic token"))

    base_dir = os.path.realpath(os.path.dirname(os.path.abspath(path)))
    unsafe_ext = []
    for em in EXT_REF_RE.finditer(text):
        base_ref = em.group(1).rstrip(",;:!?")
        if not base_ref or base_ref.lower() in CSS_AT_RULES:
            continue
        cands = [base_ref]
        stripped_dot = base_ref.rstrip(".")
        if stripped_dot and stripped_dot != base_ref:
            cands.append(stripped_dot)
        for cand in cands:
            if cand.lower() in CSS_AT_RULES:
                continue
            norm = cand.replace("\\", "/")
            if norm.startswith("/") or norm.startswith("~") or re.match(r"^[A-Za-z]:", norm) or ".." in norm.split("/"):
                unsafe_ext.append(base_ref)
                break
            resolved = os.path.realpath(os.path.join(base_dir, norm))
            if not (resolved == base_dir or resolved.startswith(base_dir + os.sep)):
                unsafe_ext.append(base_ref)
                break
    checks.append(_chk("external_refs_safe", not unsafe_ext, unsafe_ext or "safe", "[]", "external @path references stay inside the DESIGN.md directory"))

    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def check_iso_spec(spec, pre_render=False):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "iso spec must be a JSON object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - ISO_KNOWN_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized keys: {', '.join(unknown)}"))

    try:
        az = float(spec.get("azimuth_deg", -1))
        el = float(spec.get("elevation_deg", -1))
    except (TypeError, ValueError):
        az, el = -1.0, -1.0
    cam_ok = math.isfinite(az) and math.isfinite(el) and (35.0 <= az <= 60.0) and (20.0 <= el <= 50.0)
    checks.append(_chk("camera_iso", cam_ok, [az, el], "azimuth 35..60 deg, elevation 20..50 deg", "isometric camera projection angles"))

    tones = spec.get("tones")
    req_tones = {"lo", "mid", "hi", "lit"}
    tones_ok = (
        isinstance(tones, dict)
        and req_tones.issubset(tones.keys())
        and all(isinstance(tones[k], str) and bool(tones[k].strip()) for k in req_tones)
        and len({tones[k].strip().lower() for k in req_tones}) == 4
    )
    lit_count = spec.get("lit_count")
    lit_ok = isinstance(lit_count, int) and not isinstance(lit_count, bool) and lit_count == 1
    checks.append(_chk("four_tone_ramp", tones_ok and lit_ok, {"tones": sorted(tones.keys()) if isinstance(tones, dict) else tones, "lit_count": lit_count}, "4 distinct tones (lo/mid/hi/lit) + lit_count == 1", "four-tone directional shading with one lit focal accent"))

    tier_raw = spec.get("tier")
    tier = tier_raw.strip().lower() if isinstance(tier_raw, str) else None
    min_parts = ISO_TIER_MIN.get(tier) if tier else None
    parts = spec.get("parts")
    if min_parts is None:
        checks.append(_chk("part_density", False, tier_raw, "figure|hero|epic", "explicit isometric tier required"))
    elif isinstance(parts, list):
        total_parts = 0
        unmounted = 0
        entries = []
        for p in parts:
            if not isinstance(p, dict):
                unmounted += 1
                continue
            c = p.get("count", 1)
            if not (isinstance(c, int) and not isinstance(c, bool) and c >= 1):
                unmounted += 1
                continue
            total_parts += c
            pid = str(p.get("group") or p.get("name") or "").strip().lower()
            host = str(p.get("host") or "").strip().lower()
            entries.append((pid, host, c))
        host_map = {pid: host for pid, host, _ in entries if pid}
        for pid, host, c in entries:
            if not host:
                unmounted += c
                continue
            cur = host
            seen = {pid} if pid else set()
            grounded = False
            while cur:
                if cur in ISO_ROOT_HOSTS:
                    grounded = True
                    break
                if cur in seen or cur not in host_map:
                    break
                seen.add(cur)
                cur = host_map[cur]
            if not grounded:
                unmounted += c
        checks.append(_chk("part_density", total_parts >= min_parts and unmounted == 0, {"count": total_parts, "unmounted": unmounted}, f">= {min_parts} grounded parts for {tier}", "dense recognizable machine where every part mounts transitively to ground/base without cycles"))
    else:
        checks.append(_chk("part_density", False, parts, f"list of >= {min_parts} part objects with host", "parts list required"))

    checks.append(_chk("depth_sorted", spec.get("depth_sorted") is True, spec.get("depth_sorted"), True, "painter's depth order verified"))
    if not pre_render:
        fl = spec.get("floating_line_ends", -1)
        fl_ok = isinstance(fl, int) and not isinstance(fl, bool) and fl == 0
        checks.append(_chk("line_ends_resolved", fl_ok, fl, 0, "every seam, tick, and texture line ends on a stroke, dot, or outline"))
        checks.append(_chk("closeup_4x_checked", spec.get("closeup_4x_checked") is True, spec.get("closeup_4x_checked"), True, "4x close-up audit performed at junctions"))
        themes = spec.get("themes_checked")
        themes_ok = isinstance(themes, list) and {"light", "dark"}.issubset({str(x).lower() for x in themes})
        checks.append(_chk("dual_theme_checked", themes_ok, themes, "['light', 'dark']", "verified in both dark and light paper themes"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def check_iso_file(path, pre_render=False):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("iso_file_exists", False, path, "existing JSON file", "iso spec path does not exist or is not a file")]}
    try:
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "checks": [_chk("iso_json_valid", False, str(exc), "valid JSON", "iso spec must be valid JSON")]}
    return check_iso_spec(spec, pre_render=pre_render)


def _finite_num(val):
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        f = float(val)
        return f if math.isfinite(f) else None
    return None


def _strict_int(val):
    return val if isinstance(val, int) and not isinstance(val, bool) else None


def check_ink_anim_spec(spec, pre_render=False):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "ink-anim spec must be a JSON object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - INK_ANIM_KNOWN_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized keys: {', '.join(unknown)}"))

    checks.append(_chk("open_stroke_limbs", spec.get("open_stroke_limbs") is True, spec.get("open_stroke_limbs"), True, "limbs drawn as two open curved strokes, never closed tubes"))
    checks.append(_chk("curved_lines", spec.get("curved_lines") is True, spec.get("curved_lines"), True, "joints rounded and edges slightly bowed, never ruler-straight"))

    gait = spec.get("gait")
    if not isinstance(gait, dict):
        checks.append(_chk("planted_foot_gait", False, gait, "gait object with kind/stride/duty/period_s/scale/travel_speed", "gait mechanics object required"))
    else:
        kind = gait.get("kind").strip().lower() if isinstance(gait.get("kind"), str) else ""
        stride = _finite_num(gait.get("stride"))
        duty = _finite_num(gait.get("duty"))
        period = _finite_num(gait.get("period_s"))
        scale = _finite_num(gait.get("scale", 1.0))
        speed = _finite_num(gait.get("travel_speed"))
        kind_ok = kind in INK_GAIT_KINDS
        duty_ok = duty is not None and (0.1 < duty < 0.95) and ((duty < 0.5) if kind == "run" else (duty >= 0.5))
        if kind_ok and duty_ok and None not in (stride, period, scale, speed) and stride > 0.0 and period > 0.0 and scale > 0.0:
            want = (stride / (duty * period)) * scale
            speed_ok = abs(speed - want) <= 1e-3 * max(1.0, abs(want))
            checks.append(_chk("planted_foot_gait", speed_ok, round(speed, 4), round(want, 4), "travel_speed == (stride / (duty * period_s)) * scale so stance feet stay planted"))
        else:
            checks.append(_chk("planted_foot_gait", False, gait, "valid kind (walk/shuffle/run), duty, stride, period_s, scale, and exact travel_speed", "planted-foot gait speed must match stride / (duty * period_s) * scale"))
        checks.append(_chk("no_free_sine_walk", gait.get("free_sine_walk") is False, gait.get("free_sine_walk"), False, "never animate walking figures with free-running sines"))

    checks.append(_chk("skeleton_first_cloth", spec.get("skeleton_first_cloth") is True, spec.get("skeleton_first_cloth"), True, "solve hidden legs first and derive garment hem from forward knee and ankles"))
    checks.append(_chk("card_fixed_bg", spec.get("card_fixed_bg") is True, spec.get("card_fixed_bg"), True, "self-contained card; page background around it never shifts with time of day"))

    pal = spec.get("palette_tokens")
    pal_ok = (
        isinstance(pal, dict)
        and isinstance(pal.get("ink"), str)
        and pal["ink"].strip().lower() == "currentcolor"
        and isinstance(pal.get("paper_class"), str)
        and pal["paper_class"].strip().startswith(".")
        and len(pal["paper_class"].strip()) >= 2
    )
    checks.append(_chk("ink_paper_tokens", pal_ok, pal, "{'ink': 'currentColor', 'paper_class': '.pp'}", "ink uses currentColor and paper uses a dedicated CSS class for clean day/night retinting"))

    dbg = spec.get("debug_stepping")
    if isinstance(dbg, dict):
        qf = dbg.get("query_flag")
        sfn = dbg.get("step_fn")
        dt = _finite_num(dbg.get("dt_s"))
        dbg_ok = (
            isinstance(qf, str)
            and qf.strip().startswith("?")
            and len(qf.strip()) >= 2
            and isinstance(sfn, str)
            and bool(sfn.strip())
            and dt is not None
            and 0.0 < dt <= (1.0 / 24.0) + 1e-6
        )
    else:
        dbg_ok = False
    checks.append(_chk("deterministic_debug_step", dbg_ok, dbg, "{'query_flag': '?debug', 'step_fn': 'window.__step', 'dt_s': <= 1/24}", "skip rAF in headless/background tabs and step exact fixed frames"))

    if not pre_render:
        checks.append(_chk("zoomed_strip_checked", spec.get("zoomed_strip_checked") is True, spec.get("zoomed_strip_checked"), True, "inspected zoomed 4x-11x frame strip of every moving figure"))
        if "day_cycle_checked" in spec:
            checks.append(_chk("day_cycle_checked", spec.get("day_cycle_checked") is True, spec.get("day_cycle_checked"), True, "contrast verified across day/sunset/night/dawn palette sweep"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def check_ink_anim_file(path, pre_render=False):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("ink_anim_file_exists", False, path, "existing JSON file", "ink-anim spec path does not exist or is not a file")]}
    try:
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "checks": [_chk("ink_anim_json_valid", False, str(exc), "valid JSON", "ink-anim spec must be valid JSON")]}
    return check_ink_anim_spec(spec, pre_render=pre_render)


def check_sakuga_spec(spec, pre_render=False):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "sakuga spec must be a JSON object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - SAKUGA_KNOWN_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized keys: {', '.join(unknown)}"))

    ctrl = spec.get("control").strip().lower() if isinstance(spec.get("control"), str) else ""
    checks.append(_chk("semantic_control", ctrl in SAKUGA_CONTROLS, spec.get("control"), sorted(SAKUGA_CONTROLS), "built around a real semantic control with keyboard and focus support"))
    checks.append(_chk("plain_at_rest", spec.get("plain_at_rest") is True, spec.get("plain_at_rest"), True, "control stays plain at rest with no idle animation clutter"))
    checks.append(_chk("immediate_state_change", spec.get("immediate_state_change") is True, spec.get("immediate_state_change"), True, "functional state updates immediately; drawn VFX only decorate"))

    beats = spec.get("beats")
    beats_ok = False
    sfx_ok = False
    if isinstance(beats, list) and len(beats) == 4:
        names = []
        valid_beats = True
        sfx_beats = []
        for b in beats:
            if not isinstance(b, dict):
                valid_beats = False
                break
            bn = b.get("name").strip().lower() if isinstance(b.get("name"), str) else ""
            effs = b.get("effects")
            if not isinstance(effs, list) or not all(isinstance(e, str) and e.strip() for e in effs):
                valid_beats = False
                break
            min_e = 0 if bn == "settle" else 1
            if not (min_e <= len(effs) <= 2):
                valid_beats = False
                break
            names.append(bn)
            sw = b.get("sfx_word")
            if sw is not None:
                if not (isinstance(sw, str) and sw.strip()):
                    valid_beats = False
                    break
                sfx_beats.append(bn)
        beats_ok = valid_beats and tuple(names) == SAKUGA_BEAT_ORDER
        sfx_ok = valid_beats and len(sfx_beats) <= 1 and all(bn == "hit" for bn in sfx_beats)
    checks.append(_chk("sakuga_beats", beats_ok, beats, "ordered [anticipation, hit, follow_through, settle] with 1..2 effects/beat", "explicit 4-beat reaction with 1-2 effects per beat"))
    checks.append(_chk("sakuga_sfx_on_hit", sfx_ok, [b.get("name") for b in beats if isinstance(b, dict) and b.get("sfx_word")] if isinstance(beats, list) else beats, "<= 1 sfx_word, on hit beat only", "at most one sound-effect lettering word per reaction, landing on hit"))

    checks.append(_chk("shared_clock_canvas", spec.get("shared_clock_canvas") is True, spec.get("shared_clock_canvas"), True, "single shared overlay canvas and shared clock (later queue, no raw setTimeout)"))

    vr = spec.get("visual_rules")
    if not isinstance(vr, dict):
        checks.append(_chk("sakuga_visual_rules", False, vr, "visual_rules object", "visual_rules object required"))
    else:
        checks.append(_chk("flat_two_tone_outline", vr.get("flat_two_tone_outline") is True, vr.get("flat_two_tone_outline"), True, "two flat tones plus ink outline; no gradients or blur"))
        checks.append(_chk("exit_by_shrink_not_fade", vr.get("exit_by_shrink_not_fade") is True, vr.get("exit_by_shrink_not_fade"), True, "effects leave by shrinking or thinning, never by fading opacity"))
        checks.append(_chk("spring_driven", vr.get("spring_driven") is True, vr.get("spring_driven"), True, "hand-moved controls use spring physics with velocity-driven stretch"))
        checks.append(_chk("reduced_motion_keeps_state", vr.get("reduced_motion_keeps_state") is True, vr.get("reduced_motion_keeps_state"), True, "prefers-reduced-motion disables VFX while preserving functional state changes"))
        sq = vr.get("volume_preserving_squash")
        if isinstance(sq, dict):
            sx = _finite_num(sq.get("scale_x"))
            sy = _finite_num(sq.get("scale_y"))
            sq_ok = sx is not None and sy is not None and sx > 0.0 and sy > 0.0 and (abs(sx - 1.0) > 1e-3 or abs(sy - 1.0) > 1e-3) and abs(sx * sy - 1.0) <= 0.15
        else:
            sq_ok = False
        checks.append(_chk("volume_preserving_squash", sq_ok, sq, "scale_x * scale_y in [0.85, 1.15] with active squash/stretch", "squash keeps area/volume constant (shorter means wider)"))

    cv = spec.get("css_vars")
    cv_ok = (
        isinstance(cv, dict)
        and 2 <= len(cv) <= 8
        and all(
            isinstance(k, str)
            and k.startswith("--")
            and len(k) >= 4
            and isinstance(v, str)
            and not v.strip().startswith("{")
            and _is_valid_css_color(v)
            for k, v in cv.items()
        )
    )
    checks.append(_chk("css_var_theming", cv_ok, cv, "2..8 --* CSS custom properties with valid CSS colors", "host page :root CSS variables override control colors cleanly"))

    if not pre_render:
        ver = spec.get("verification")
        if not isinstance(ver, dict):
            checks.append(_chk("sakuga_verification", False, ver, "verification object", "frame-strip and responsive/keyboard verification required"))
        else:
            ts = ver.get("frame_strip_times_s")
            ts_nums = [_finite_num(x) for x in ts] if isinstance(ts, list) else []
            ts_ok = isinstance(ts, list) and len(ts_nums) >= 4 and all(x is not None and x >= 0.0 for x in ts_nums) and all(ts_nums[i] < ts_nums[i + 1] for i in range(len(ts_nums) - 1))
            checks.append(_chk("stepped_frame_strip", ts_ok, ts, ">= 4 strictly increasing timestamps in seconds", "stepped frame strip captured across anticipation, hit, follow-through, and settle"))
            ws = ver.get("widths_px")
            ws_ints = [_strict_int(x) for x in ws] if isinstance(ws, list) else []
            ws_ok = isinstance(ws, list) and all(x is not None and x >= 320 for x in ws_ints) and any(x <= 390 for x in ws_ints) and any(x >= 1024 for x in ws_ints)
            checks.append(_chk("responsive_widths", ws_ok, ws, "phone (<=390px) and desktop (>=1024px)", "verified at both phone and desktop widths"))
            checks.append(_chk("no_horizontal_overflow", ver.get("horizontal_overflow") is False, ver.get("horizontal_overflow"), False, "zero sideways scroll at phone width"))
            checks.append(_chk("keyboard_checked", ver.get("keyboard_checked") is True, ver.get("keyboard_checked"), True, "verified with Tab focus and keyboard activation"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def check_sakuga_file(path, pre_render=False):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("sakuga_file_exists", False, path, "existing JSON file", "sakuga spec path does not exist or is not a file")]}
    try:
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "checks": [_chk("sakuga_json_valid", False, str(exc), "valid JSON", "sakuga spec must be valid JSON")]}
    return check_sakuga_spec(spec, pre_render=pre_render)


SVG_NS = "http://www.w3.org/2000/svg"
XML_NS = "http://www.w3.org/XML/1998/namespace"
SVG_NS_TAG = f"{{{SVG_NS}}}svg"

LOGO_SHAPE_TAGS = frozenset({"path", "circle", "ellipse", "rect", "polygon", "polyline", "line"})
LOGO_ALWAYS_ALLOWED_TAGS = frozenset({
    "svg", "g", "path", "rect", "circle", "ellipse", "line",
    "polygon", "polyline", "title", "desc",
})
LOGO_DRAFT_TEXT_TAGS = frozenset({"text", "tspan"})
LOGO_EFFECT_TAGS = frozenset({
    "filter", "fegaussianblur", "fedropshadow", "lineargradient", "radialgradient",
})
LOGO_NON_RENDER_TAGS = frozenset({
    "defs", "clippath", "mask", "symbol", "pattern", "marker",
    "filter", "lineargradient", "radialgradient", "title", "desc",
    "metadata", "script", "style", "foreignobject",
})
LOGO_SHARED_ATTRS = frozenset({
    "id", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "stroke-miterlimit", "fill-rule", "clip-rule", "transform", "color",
    "opacity", "fill-opacity", "stroke-opacity",
})
LOGO_TAG_ATTRS = {
    "svg": LOGO_SHARED_ATTRS | frozenset({
        "viewBox", "width", "height", "version", "preserveAspectRatio", "role", "aria-label",
    }),
    "g": LOGO_SHARED_ATTRS,
    "path": LOGO_SHARED_ATTRS | frozenset({"d"}),
    "rect": LOGO_SHARED_ATTRS | frozenset({"x", "y", "width", "height", "rx", "ry"}),
    "circle": LOGO_SHARED_ATTRS | frozenset({"cx", "cy", "r"}),
    "ellipse": LOGO_SHARED_ATTRS | frozenset({"cx", "cy", "rx", "ry"}),
    "line": LOGO_SHARED_ATTRS | frozenset({"x1", "y1", "x2", "y2"}),
    "polygon": LOGO_SHARED_ATTRS | frozenset({"points"}),
    "polyline": LOGO_SHARED_ATTRS | frozenset({"points"}),
    "text": LOGO_SHARED_ATTRS | frozenset({
        "x", "y", "dx", "dy", "font-family", "font-size", "font-weight",
        "letter-spacing", "text-anchor", "dominant-baseline",
    }),
    "tspan": LOGO_SHARED_ATTRS | frozenset({
        "x", "y", "dx", "dy", "font-family", "font-size", "font-weight",
        "letter-spacing", "text-anchor", "dominant-baseline",
    }),
    "title": frozenset({"id"}),
    "desc": frozenset({"id"}),
}

# Packed 24-bit sRGB values for every named color in CSS_NAMED_COLORS (grouped by family)
LOGO_NAMED_HEX = {
    # Neutrals and whites
    "black": 0x000000, "white": 0xFFFFFF, "silver": 0xC0C0C0, "gray": 0x808080, "grey": 0x808080,
    "darkgray": 0xA9A9A9, "darkgrey": 0xA9A9A9, "dimgray": 0x696969, "dimgrey": 0x696969,
    "lightgray": 0xD3D3D3, "lightgrey": 0xD3D3D3, "gainsboro": 0xDCDCDC, "whitesmoke": 0xF5F5F5,
    "snow": 0xFFFAFA, "ghostwhite": 0xF8F8FF, "floralwhite": 0xFFFAF0, "ivory": 0xFFFFF0,
    "linen": 0xFAF0E6, "oldlace": 0xFDF5E6, "seashell": 0xFFF5EE, "beige": 0xF5F5DC,
    "antiquewhite": 0xFAEBD7, "cornsilk": 0xFFF8DC, "mintcream": 0xF5FFFA, "azure": 0xF0FFFF,
    "aliceblue": 0xF0F8FF, "honeydew": 0xF0FFF0, "lavenderblush": 0xFFF0F5, "mistyrose": 0xFFE4E1,
    "slategray": 0x708090, "slategrey": 0x708090, "lightslategray": 0x778899, "lightslategrey": 0x778899,
    "darkslategray": 0x2F4F4F, "darkslategrey": 0x2F4F4F,
    # Reds and pinks
    "red": 0xFF0000, "darkred": 0x8B0000, "maroon": 0x800000, "firebrick": 0xB22222, "crimson": 0xDC143C,
    "indianred": 0xCD5C5C, "lightcoral": 0xF08080, "salmon": 0xFA8072, "darksalmon": 0xE9967A,
    "lightsalmon": 0xFFA07A, "coral": 0xFF7F50, "tomato": 0xFF6347, "orangered": 0xFF4500,
    "pink": 0xFFC0CB, "lightpink": 0xFFB6C1, "hotpink": 0xFF69B4, "deeppink": 0xFF1493,
    "palevioletred": 0xDB7093, "mediumvioletred": 0xC71585, "rosybrown": 0xBC8F8F,
    # Oranges, yellows, and browns
    "orange": 0xFFA500, "darkorange": 0xFF8C00, "gold": 0xFFD700, "yellow": 0xFFFF00,
    "lightyellow": 0xFFFFE0, "lemonchiffon": 0xFFFACD, "lightgoldenrodyellow": 0xFAFAD2,
    "papayawhip": 0xFFEFD5, "moccasin": 0xFFE4B5, "peachpuff": 0xFFDAB9, "palegoldenrod": 0xEEE8AA,
    "khaki": 0xF0E68C, "darkkhaki": 0xBDB76B, "goldenrod": 0xDAA520, "darkgoldenrod": 0xB8860B,
    "olive": 0x808000, "bisque": 0xFFE4C4, "blanchedalmond": 0xFFEBCD, "wheat": 0xF5DEB3,
    "navajowhite": 0xFFDEAD, "burlywood": 0xDEB887, "tan": 0xD2B48C, "sandybrown": 0xF4A460,
    "peru": 0xCD853F, "chocolate": 0xD2691E, "saddlebrown": 0x8B4513, "sienna": 0xA0522D,
    "brown": 0xA52A2A,
    # Greens
    "green": 0x008000, "darkgreen": 0x006400, "lime": 0x00FF00, "limegreen": 0x32CD32,
    "forestgreen": 0x228B22, "seagreen": 0x2E8B57, "mediumseagreen": 0x3CB371, "darkseagreen": 0x8FBC8F,
    "springgreen": 0x00FF7F, "mediumspringgreen": 0x00FA9A, "palegreen": 0x98FB98, "lightgreen": 0x90EE90,
    "yellowgreen": 0x9ACD32, "olivedrab": 0x6B8E23, "darkolivegreen": 0x556B2F, "lawngreen": 0x7CFC00,
    "chartreuse": 0x7FFF00, "greenyellow": 0xADFF2F, "mediumaquamarine": 0x66CDAA, "aquamarine": 0x7FFFD4,
    # Cyans and blues
    "aqua": 0x00FFFF, "cyan": 0x00FFFF, "lightcyan": 0xE0FFFF, "paleturquoise": 0xAFEEEE,
    "turquoise": 0x40E0D0, "mediumturquoise": 0x48D1CC, "darkturquoise": 0x00CED1, "darkcyan": 0x008B8B,
    "teal": 0x008080, "cadetblue": 0x5F9EA0, "lightseagreen": 0x20B2AA, "steelblue": 0x4682B4,
    "lightsteelblue": 0xB0C4DE, "powderblue": 0xB0E0E6, "lightblue": 0xADD8E6, "skyblue": 0x87CEEB,
    "lightskyblue": 0x87CEFA, "deepskyblue": 0x00BFFF, "dodgerblue": 0x1E90FF, "cornflowerblue": 0x6495ED,
    "royalblue": 0x4169E1, "blue": 0x0000FF, "mediumblue": 0x0000CD, "darkblue": 0x00008B,
    "navy": 0x000080, "midnightblue": 0x191970,
    # Purples and violets
    "lavender": 0xE6E6FA, "thistle": 0xD8BFD8, "plum": 0xDDA0DD, "violet": 0xEE82EE,
    "orchid": 0xDA70D6, "fuchsia": 0xFF00FF, "magenta": 0xFF00FF, "mediumorchid": 0xBA55D3,
    "mediumpurple": 0x9370DB, "rebeccapurple": 0x663399, "blueviolet": 0x8A2BE2, "darkviolet": 0x9400D3,
    "darkorchid": 0x9932CC, "darkmagenta": 0x8B008B, "purple": 0x800080, "indigo": 0x4B0082,
    "slateblue": 0x6A5ACD, "darkslateblue": 0x483D8B, "mediumslateblue": 0x7B68EE,
}

SVG_NUM_RE = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
SVG_LEN_RE = re.compile(r"^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(px|pt|pc|in|cm|mm|%|em)?$", re.I)
SVG_LEN_UNIT_PX = {
    "": 1.0,
    "px": 1.0,
    "pt": 4.0 / 3.0,
    "pc": 16.0,
    "in": 96.0,
    "cm": 96.0 / 2.54,
    "mm": 96.0 / 25.4,
}
SVG_TF_ITEM_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*)\s*\(([^)]*)\)")
SVG_TF_SEP_RE = re.compile(r"[\s,]*")
SVG_XML_STYLESHEET_RE = re.compile(r"<\?\s*xml-stylesheet\b", re.I)
SVG_CONTROL_WS_RE = re.compile(r"[\x00-\x20]+")
SVG_FORBIDDEN_URI_RE = re.compile(
    r"(?:url\(|javascript:|vbscript:|data:|https?:|blob:|ftp:|mailto:|file:)",
    re.I,
)
SVG_MAT_IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _split_ns_name(name):
    if not isinstance(name, str):
        return "", ""
    if name.startswith("{") and "}" in name:
        ns, local = name[1:].split("}", 1)
        return ns, local
    return "", name


def _has_forbidden_uri_or_url(val):
    if not isinstance(val, str) or not val:
        return False
    compact = SVG_CONTROL_WS_RE.sub("", val)
    return bool(SVG_FORBIDDEN_URI_RE.search(compact))


def _parse_plain_float(val):
    if not isinstance(val, str):
        return None
    s = val.strip()
    if not s or not SVG_NUM_RE.fullmatch(s):
        return None
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def _parse_svg_len(val, ref_len=None, em_size=None):
    """Parse SVG length supporting unitless, px, pt, pc, in, cm, mm, %, and em (relative to em_size)."""
    if not isinstance(val, str):
        return None
    s = val.strip()
    m = SVG_LEN_RE.fullmatch(s)
    if not m:
        return None
    try:
        num = float(m.group(1))
    except ValueError:
        return None
    if not math.isfinite(num):
        return None
    unit = (m.group(2) or "").lower()
    if unit == "%":
        if ref_len is None or not math.isfinite(ref_len):
            return None
        res = (num / 100.0) * ref_len
    elif unit == "em":
        if em_size is None or not math.isfinite(em_size):
            return None
        res = num * em_size
    else:
        res = num * SVG_LEN_UNIT_PX[unit]
    return res if math.isfinite(res) else None


def _parse_opacity_val(val):
    """Parse CSS/SVG opacity (number or percentage). Returns float clamped to [0, 1] or None if invalid."""
    if not isinstance(val, str):
        return None
    s = val.strip()
    if not s:
        return None
    if s.endswith("%"):
        num = _parse_plain_float(s[:-1])
        if num is None:
            return None
        v = num / 100.0
    else:
        v = _parse_plain_float(s)
        if v is None:
            return None
    return max(0.0, min(1.0, v))


def _parse_alpha_token(tok):
    return _parse_opacity_val(tok)


def _split_css_func_args(body):
    """Split CSS color function arguments supporting both legacy comma and CSS Color 4 space/slash syntax."""
    s = body.strip()
    if not s:
        return None, None
    if "," in s:
        if "/" in s:
            return None, None
        parts = [p.strip() for p in s.split(",")]
        if any(not p for p in parts):
            return None, None
        if len(parts) == 3:
            return parts, None
        if len(parts) == 4:
            return parts[:3], parts[3]
        return None, None
    if "/" in s:
        left, right = s.split("/", 1)
        if "/" in right:
            return None, None
        chans = [p for p in left.split() if p]
        alpha = right.strip()
        if len(chans) == 3 and alpha:
            return chans, alpha
        return None, None
    chans = [p for p in s.split() if p]
    if len(chans) == 3:
        return chans, None
    return None, None


def _parse_logo_paint(val):
    """Parse an SVG logo paint string into (kind, value).

    Kinds:
      - ('none', None): explicit 'none', 'transparent', or parsed color with alpha == 0
      - ('currentColor', 'currentColor'): 'currentColor'
      - ('rgb', (r, g, b)): opaque color (alpha == 1)
      - ('translucent', alpha): valid color with 0 < alpha < 1
      - ('invalid', raw): unparsed, unsupported, or paint-server string (e.g. inherit, context-fill, url(...))
    """
    if not isinstance(val, str):
        return ("invalid", str(val))
    raw = val.strip()
    s = raw.lower()
    if not s:
        return ("invalid", raw)
    if s in ("none", "transparent"):
        return ("none", None)
    if s == "currentcolor":
        return ("currentColor", "currentColor")
    if s in LOGO_NAMED_HEX:
        hx = LOGO_NAMED_HEX[s]
        return ("rgb", ((hx >> 16) & 0xFF, (hx >> 8) & 0xFF, hx & 0xFF))

    if s.startswith("#"):
        h = s[1:]
        if re.fullmatch(r"[0-9a-f]{3}", h):
            return ("rgb", (int(h[0] * 2, 16), int(h[1] * 2, 16), int(h[2] * 2, 16)))
        if re.fullmatch(r"[0-9a-f]{6}", h):
            return ("rgb", (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
        if re.fullmatch(r"[0-9a-f]{4}", h):
            a = int(h[3] * 2, 16) / 255.0
            if a <= 0.0:
                return ("none", None)
            if a < 1.0 - 1e-9:
                return ("translucent", round(a, 4))
            return ("rgb", (int(h[0] * 2, 16), int(h[1] * 2, 16), int(h[2] * 2, 16)))
        if re.fullmatch(r"[0-9a-f]{8}", h):
            a = int(h[6:8], 16) / 255.0
            if a <= 0.0:
                return ("none", None)
            if a < 1.0 - 1e-9:
                return ("translucent", round(a, 4))
            return ("rgb", (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
        return ("invalid", raw)

    m_rgb = re.fullmatch(r"rgba?\((.*)\)", s)
    if m_rgb:
        chans, alpha_tok = _split_css_func_args(m_rgb.group(1))
        if chans is None:
            return ("invalid", raw)
        rgb = []
        for ch in chans:
            if ch.endswith("%"):
                num = _parse_plain_float(ch[:-1])
                if num is None:
                    return ("invalid", raw)
                v = num * 2.55
            else:
                num = _parse_plain_float(ch)
                if num is None:
                    return ("invalid", raw)
                v = num
            rgb.append(max(0, min(255, int(round(v)))))
        if alpha_tok is not None:
            a = _parse_alpha_token(alpha_tok)
            if a is None:
                return ("invalid", raw)
            if a <= 0.0:
                return ("none", None)
            if a < 1.0 - 1e-9:
                return ("translucent", round(a, 4))
        return ("rgb", tuple(rgb))

    m_hsl = re.fullmatch(r"hsla?\((.*)\)", s)
    if m_hsl:
        chans, alpha_tok = _split_css_func_args(m_hsl.group(1))
        if chans is None:
            return ("invalid", raw)
        h_tok, s_tok, l_tok = chans
        m_ang = re.fullmatch(r"([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(deg|rad|grad|turn)?", h_tok)
        if not m_ang:
            return ("invalid", raw)
        h_num = _parse_plain_float(m_ang.group(1))
        if h_num is None:
            return ("invalid", raw)
        ang_unit = m_ang.group(2) or "deg"
        if ang_unit == "rad":
            h_deg = math.degrees(h_num)
        elif ang_unit == "grad":
            h_deg = h_num * 0.9
        elif ang_unit == "turn":
            h_deg = h_num * 360.0
        else:
            h_deg = h_num
        if not (s_tok.endswith("%") and l_tok.endswith("%")):
            return ("invalid", raw)
        sat = _parse_plain_float(s_tok[:-1])
        lit = _parse_plain_float(l_tok[:-1])
        if sat is None or lit is None:
            return ("invalid", raw)
        sat = max(0.0, min(100.0, sat)) / 100.0
        lit = max(0.0, min(100.0, lit)) / 100.0
        if alpha_tok is not None:
            a = _parse_alpha_token(alpha_tok)
            if a is None:
                return ("invalid", raw)
            if a <= 0.0:
                return ("none", None)
            if a < 1.0 - 1e-9:
                return ("translucent", round(a, 4))
        rf, gf, bf = colorsys.hls_to_rgb((h_deg % 360.0) / 360.0, lit, sat)
        return ("rgb", (int(round(rf * 255.0)), int(round(gf * 255.0)), int(round(bf * 255.0))))

    return ("invalid", raw)


def _rel_luminance(rgb):
    def ch(c):
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])


def _contrast_ratio(rgb1, rgb2):
    l1, l2 = _rel_luminance(rgb1), _rel_luminance(rgb2)
    hi, lo = (l1, l2) if l1 >= l2 else (l2, l1)
    return (hi + 0.05) / (lo + 0.05)


def _mat_mul(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    res = (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )
    return res if all(math.isfinite(v) for v in res) else None


def _mat_apply(mat, x, y):
    a, b, c, d, e, f = mat
    return (a * x + c * y + e, b * x + d * y + f)


def _mat_linear_scales(mat):
    """Return (min_scale, max_scale) singular values of the 2x2 linear part of mat."""
    a, b, c, d, _, _ = mat
    s1 = math.hypot(a + d, b - c)
    s2 = math.hypot(a - d, b + c)
    return 0.5 * abs(s1 - s2), 0.5 * (s1 + s2)


def _parse_transform_matrix(attr):
    """Parse SVG transform attribute into (matrix, error_or_None). Rejects unknown functions or bad syntax."""
    if not attr or not attr.strip():
        return SVG_MAT_IDENTITY, None
    s = attr.strip()
    pos = 0
    n = len(s)
    mat = SVG_MAT_IDENTITY
    while pos < n:
        sep = SVG_TF_SEP_RE.match(s, pos)
        if sep:
            pos = sep.end()
        if pos >= n:
            break
        m = SVG_TF_ITEM_RE.match(s, pos)
        if not m:
            return mat, f"transform:syntax:{s[pos:pos + 24]}"
        pos = m.end()
        kind = m.group(1).lower()
        arg_str = m.group(2).strip()
        nums = []
        if arg_str:
            ap = 0
            an = len(arg_str)
            while ap < an:
                sp = SVG_TF_SEP_RE.match(arg_str, ap)
                if sp:
                    ap = sp.end()
                if ap >= an:
                    break
                nm = SVG_NUM_RE.match(arg_str, ap)
                if not nm:
                    return mat, f"transform:{kind}:bad-arg:{arg_str[ap:ap + 16]}"
                val = float(nm.group(0))
                if not math.isfinite(val):
                    return mat, f"transform:{kind}:non-finite"
                nums.append(val)
                ap = nm.end()

        if kind == "translate" and len(nums) in (1, 2):
            tx = nums[0]
            ty = nums[1] if len(nums) == 2 else 0.0
            cur = (1.0, 0.0, 0.0, 1.0, tx, ty)
        elif kind == "scale" and len(nums) in (1, 2):
            sx = nums[0]
            sy = nums[1] if len(nums) == 2 else sx
            cur = (sx, 0.0, 0.0, sy, 0.0, 0.0)
        elif kind == "rotate" and len(nums) in (1, 3):
            ang = math.radians(nums[0])
            ca, sa = math.cos(ang), math.sin(ang)
            if len(nums) == 3:
                rx, ry = nums[1], nums[2]
                cur = (ca, sa, -sa, ca, rx - ca * rx + sa * ry, ry - sa * rx - ca * ry)
            else:
                cur = (ca, sa, -sa, ca, 0.0, 0.0)
        elif kind == "skewx" and len(nums) == 1:
            rad = math.radians(nums[0])
            if abs(math.cos(rad)) < 1e-12:
                return mat, f"transform:skewX:singular:{nums[0]}"
            cur = (1.0, 0.0, math.tan(rad), 1.0, 0.0, 0.0)
        elif kind == "skewy" and len(nums) == 1:
            rad = math.radians(nums[0])
            if abs(math.cos(rad)) < 1e-12:
                return mat, f"transform:skewY:singular:{nums[0]}"
            cur = (1.0, math.tan(rad), 0.0, 1.0, 0.0, 0.0)
        elif kind == "matrix" and len(nums) == 6:
            cur = tuple(nums)
        else:
            return mat, f"transform:unsupported:{kind}({len(nums)})"
        if not all(math.isfinite(v) for v in cur):
            return SVG_MAT_IDENTITY, f"transform:{kind}:non-finite"
        nxt = _mat_mul(mat, cur)
        if nxt is None:
            return SVG_MAT_IDENTITY, f"transform:{kind}:non-finite"
        mat = nxt
    return mat, None


def _quad_bezier_bbox_pts(p0, p1, p2):
    """Return endpoints plus exact interior x/y extrema of a quadratic Bezier curve."""
    pts = [p0, p2]
    for axis in (0, 1):
        v0, v1, v2 = p0[axis], p1[axis], p2[axis]
        denom = v0 - 2.0 * v1 + v2
        if abs(denom) > 1e-12:
            t = (v0 - v1) / denom
            if 0.0 < t < 1.0:
                mt = 1.0 - t
                pts.append((
                    mt * mt * p0[0] + 2.0 * mt * t * p1[0] + t * t * p2[0],
                    mt * mt * p0[1] + 2.0 * mt * t * p1[1] + t * t * p2[1],
                ))
    return pts


def _cubic_bezier_bbox_pts(p0, p1, p2, p3):
    """Return endpoints plus exact interior x/y extrema of a cubic Bezier curve."""
    pts = [p0, p3]
    for axis in (0, 1):
        v0, v1, v2, v3 = p0[axis], p1[axis], p2[axis], p3[axis]
        qa = -v0 + 3.0 * v1 - 3.0 * v2 + v3
        qb = v0 - 2.0 * v1 + v2
        qc = v1 - v0
        roots = []
        if abs(qa) < 1e-12:
            if abs(qb) > 1e-12:
                roots.append(-qc / (2.0 * qb))
        else:
            disc = qb * qb - qa * qc
            if disc >= 0.0:
                sq = math.sqrt(disc)
                roots.append((-qb + sq) / qa)
                roots.append((-qb - sq) / qa)
        for t in roots:
            if 0.0 < t < 1.0:
                mt = 1.0 - t
                c0 = mt * mt * mt
                c1 = 3.0 * mt * mt * t
                c2 = 3.0 * mt * t * t
                c3 = t * t * t
                pts.append((
                    c0 * p0[0] + c1 * p1[0] + c2 * p2[0] + c3 * p3[0],
                    c0 * p0[1] + c1 * p1[1] + c2 * p2[1] + c3 * p3[1],
                ))
    return pts


def _arc_transformed_bbox_pts(p0, rx, ry, x_rot_deg, large_arc, sweep, p1, mat):
    """Return exact transformed endpoints and extrema of an SVG elliptical arc under affine matrix mat."""
    x1, y1 = p0
    x2, y2 = p1
    tp0 = _mat_apply(mat, x1, y1)
    tp1 = _mat_apply(mat, x2, y2)
    rx = abs(rx)
    ry = abs(ry)
    if rx < 1e-12 or ry < 1e-12 or (abs(x1 - x2) < 1e-12 and abs(y1 - y2) < 1e-12):
        return [tp0, tp1]

    phi = math.radians(x_rot_deg)
    cphi, sphi = math.cos(phi), math.sin(phi)
    dx2 = 0.5 * (x1 - x2)
    dy2 = 0.5 * (y1 - y2)
    x1p = cphi * dx2 + sphi * dy2
    y1p = -sphi * dx2 + cphi * dy2

    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1.0:
        s_lam = math.sqrt(lam)
        rx *= s_lam
        ry *= s_lam

    rx2, ry2 = rx * rx, ry * ry
    x1p2, y1p2 = x1p * x1p, y1p * y1p
    num = max(0.0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
    den = rx2 * y1p2 + ry2 * x1p2
    coef = math.sqrt(num / den) if den > 1e-18 else 0.0
    if large_arc == sweep:
        coef = -coef
    cxp = coef * (rx * y1p / ry)
    cyp = coef * (-ry * x1p / rx)

    cx = cphi * cxp - sphi * cyp + 0.5 * (x1 + x2)
    cy = sphi * cxp + cphi * cyp + 0.5 * (y1 + y2)

    def vec_angle(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        mag = math.hypot(ux, uy) * math.hypot(vx, vy)
        if mag < 1e-18:
            return 0.0
        ang = math.acos(max(-1.0, min(1.0, dot / mag)))
        return -ang if (ux * vy - uy * vx) < 0.0 else ang

    ux, uy = (x1p - cxp) / rx, (y1p - cyp) / ry
    vx, vy = (-x1p - cxp) / rx, (-y1p - cyp) / ry
    theta1 = vec_angle(1.0, 0.0, ux, uy)
    dtheta = vec_angle(ux, uy, vx, vy)
    if sweep == 0 and dtheta > 0.0:
        dtheta -= 2.0 * math.pi
    elif sweep == 1 and dtheta < 0.0:
        dtheta += 2.0 * math.pi

    a, b, c, d, _, _ = mat
    tcx, tcy = _mat_apply(mat, cx, cy)
    # Local ellipse basis vectors u = rx*(cos phi, sin phi), v = ry*(-sin phi, cos phi)
    lux, luy = rx * cphi, rx * sphi
    lvx, lvy = -ry * sphi, ry * cphi
    tux, tuy = a * lux + c * luy, b * lux + d * luy
    tvx, tvy = a * lvx + c * lvy, b * lvx + d * lvy

    t_lo = min(theta1, theta1 + dtheta)
    t_hi = max(theta1, theta1 + dtheta)
    cand_bases = []
    if abs(tux) > 1e-12 or abs(tvx) > 1e-12:
        cand_bases.append(math.atan2(tvx, tux))
    if abs(tuy) > 1e-12 or abs(tvy) > 1e-12:
        cand_bases.append(math.atan2(tvy, tuy))

    pts = [tp0, tp1]
    two_pi = 2.0 * math.pi
    for base in cand_bases:
        for half_shift in (0.0, math.pi):
            ang = base + half_shift
            k_start = math.floor((t_lo - ang) / two_pi)
            for k in range(k_start, k_start + 3):
                t = ang + k * two_pi
                if t_lo + 1e-12 < t < t_hi - 1e-12:
                    ct, st = math.cos(t), math.sin(t)
                    pts.append((tcx + tux * ct + tvx * st, tcy + tuy * ct + tvy * st))
    return pts


def _path_transformed_points_and_cmds(d, mat):
    """Parse SVG path data strictly, returning (transformed_bbox_pts, executed_cmd_count, error_or_None)."""
    if d is None:
        return [], 0, None
    s = d
    n = len(s)
    pos = 0
    pts = []
    cmds = 0
    cx = cy = sx = sy = 0.0
    prev_cmd = None
    last_ctrl = None
    valid_cmds = set("MmLlHhVvCcSsQqTtAaZz")

    def skip_ws():
        nonlocal pos
        while pos < n and s[pos] in " \t\r\n":
            pos += 1

    def skip_sep(allow_comma=True):
        nonlocal pos
        skip_ws()
        if allow_comma and pos < n and s[pos] == ",":
            pos += 1
            skip_ws()

    def read_num(allow_comma=True):
        nonlocal pos
        skip_sep(allow_comma=allow_comma)
        if pos >= n:
            return None
        m = SVG_NUM_RE.match(s, pos)
        if not m:
            return None
        val = float(m.group(0))
        if not math.isfinite(val):
            return None
        pos = m.end()
        return val

    def read_flag():
        nonlocal pos
        skip_sep(allow_comma=True)
        if pos >= n or s[pos] not in ("0", "1"):
            return None
        val = 1 if s[pos] == "1" else 0
        pos += 1
        return val

    def has_next_arg(allow_comma=True):
        saved = pos
        skip_sep(allow_comma=allow_comma)
        if pos >= n:
            pos_res = False
        else:
            pos_res = s[pos] in "0123456789+-."
        return pos_res, saved

    while True:
        skip_ws()
        if pos >= n:
            break
        ch = s[pos]
        if ch not in valid_cmds:
            return pts, cmds, f"path:unexpected:{s[pos:pos + 16]}"
        cmd = ch
        if prev_cmd is None and cmd not in ("M", "m"):
            return pts, cmds, f"path:must-start-with-moveto:{cmd}"
        pos += 1

        if cmd in ("Z", "z"):
            cmds += 1
            cx, cy = sx, sy
            prev_cmd = cmd
            last_ctrl = None
            continue

        first_tuple = True
        while True:
            if not first_tuple:
                more, saved = has_next_arg(allow_comma=True)
                pos = saved
                if not more:
                    break
            allow_comma = not first_tuple
            first_tuple = False
            cmds += 1

            if cmd in ("M", "m"):
                x = read_num(allow_comma=allow_comma)
                y = read_num(allow_comma=True)
                if x is None or y is None:
                    return pts, cmds, f"path:truncated:{cmd}"
                cx, cy = (cx + x, cy + y) if cmd == "m" else (x, y)
                sx, sy = cx, cy
                pts.append(_mat_apply(mat, cx, cy))
                prev_cmd = cmd
                last_ctrl = None
                cmd = "l" if cmd == "m" else "L"
            elif cmd in ("L", "l"):
                x = read_num(allow_comma=allow_comma)
                y = read_num(allow_comma=True)
                if x is None or y is None:
                    return pts, cmds, f"path:truncated:{cmd}"
                nx, ny = (cx + x, cy + y) if cmd == "l" else (x, y)
                pts.append(_mat_apply(mat, cx, cy))
                pts.append(_mat_apply(mat, nx, ny))
                cx, cy = nx, ny
                prev_cmd = cmd
                last_ctrl = None
            elif cmd in ("H", "h"):
                x = read_num(allow_comma=allow_comma)
                if x is None:
                    return pts, cmds, f"path:truncated:{cmd}"
                nx = cx + x if cmd == "h" else x
                pts.append(_mat_apply(mat, cx, cy))
                pts.append(_mat_apply(mat, nx, cy))
                cx = nx
                prev_cmd = cmd
                last_ctrl = None
            elif cmd in ("V", "v"):
                y = read_num(allow_comma=allow_comma)
                if y is None:
                    return pts, cmds, f"path:truncated:{cmd}"
                ny = cy + y if cmd == "v" else y
                pts.append(_mat_apply(mat, cx, cy))
                pts.append(_mat_apply(mat, cx, ny))
                cy = ny
                prev_cmd = cmd
                last_ctrl = None
            elif cmd in ("C", "c"):
                vals = [read_num(allow_comma=(allow_comma if idx == 0 else True)) for idx in range(6)]
                if any(v is None for v in vals):
                    return pts, cmds, f"path:truncated:{cmd}"
                if cmd == "c":
                    p1 = (cx + vals[0], cy + vals[1])
                    p2 = (cx + vals[2], cy + vals[3])
                    p3 = (cx + vals[4], cy + vals[5])
                else:
                    p1 = (vals[0], vals[1])
                    p2 = (vals[2], vals[3])
                    p3 = (vals[4], vals[5])
                pts.extend(_cubic_bezier_bbox_pts(
                    _mat_apply(mat, cx, cy),
                    _mat_apply(mat, p1[0], p1[1]),
                    _mat_apply(mat, p2[0], p2[1]),
                    _mat_apply(mat, p3[0], p3[1]),
                ))
                cx, cy = p3
                last_ctrl = p2
                prev_cmd = cmd
            elif cmd in ("S", "s"):
                vals = [read_num(allow_comma=(allow_comma if idx == 0 else True)) for idx in range(4)]
                if any(v is None for v in vals):
                    return pts, cmds, f"path:truncated:{cmd}"
                if prev_cmd in ("C", "c", "S", "s") and last_ctrl is not None:
                    p1 = (2.0 * cx - last_ctrl[0], 2.0 * cy - last_ctrl[1])
                else:
                    p1 = (cx, cy)
                if cmd == "s":
                    p2 = (cx + vals[0], cy + vals[1])
                    p3 = (cx + vals[2], cy + vals[3])
                else:
                    p2 = (vals[0], vals[1])
                    p3 = (vals[2], vals[3])
                pts.extend(_cubic_bezier_bbox_pts(
                    _mat_apply(mat, cx, cy),
                    _mat_apply(mat, p1[0], p1[1]),
                    _mat_apply(mat, p2[0], p2[1]),
                    _mat_apply(mat, p3[0], p3[1]),
                ))
                cx, cy = p3
                last_ctrl = p2
                prev_cmd = cmd
            elif cmd in ("Q", "q"):
                vals = [read_num(allow_comma=(allow_comma if idx == 0 else True)) for idx in range(4)]
                if any(v is None for v in vals):
                    return pts, cmds, f"path:truncated:{cmd}"
                if cmd == "q":
                    p1 = (cx + vals[0], cy + vals[1])
                    p2 = (cx + vals[2], cy + vals[3])
                else:
                    p1 = (vals[0], vals[1])
                    p2 = (vals[2], vals[3])
                pts.extend(_quad_bezier_bbox_pts(
                    _mat_apply(mat, cx, cy),
                    _mat_apply(mat, p1[0], p1[1]),
                    _mat_apply(mat, p2[0], p2[1]),
                ))
                cx, cy = p2
                last_ctrl = p1
                prev_cmd = cmd
            elif cmd in ("T", "t"):
                x = read_num(allow_comma=allow_comma)
                y = read_num(allow_comma=True)
                if x is None or y is None:
                    return pts, cmds, f"path:truncated:{cmd}"
                if prev_cmd in ("Q", "q", "T", "t") and last_ctrl is not None:
                    p1 = (2.0 * cx - last_ctrl[0], 2.0 * cy - last_ctrl[1])
                else:
                    p1 = (cx, cy)
                p2 = (cx + x, cy + y) if cmd == "t" else (x, y)
                pts.extend(_quad_bezier_bbox_pts(
                    _mat_apply(mat, cx, cy),
                    _mat_apply(mat, p1[0], p1[1]),
                    _mat_apply(mat, p2[0], p2[1]),
                ))
                cx, cy = p2
                last_ctrl = p1
                prev_cmd = cmd
            elif cmd in ("A", "a"):
                rx = read_num(allow_comma=allow_comma)
                ry = read_num(allow_comma=True)
                rot = read_num(allow_comma=True)
                large = read_flag()
                sweep = read_flag()
                ax = read_num(allow_comma=True)
                ay = read_num(allow_comma=True)
                if None in (rx, ry, rot, large, sweep, ax, ay):
                    return pts, cmds, f"path:truncated-or-bad-flag:{cmd}"
                nx, ny = (cx + ax, cy + ay) if cmd == "a" else (ax, ay)
                pts.extend(_arc_transformed_bbox_pts((cx, cy), rx, ry, rot, large, sweep, (nx, ny), mat))
                cx, cy = nx, ny
                last_ctrl = None
                prev_cmd = cmd
    return pts, cmds, None


def _parse_points_attr(raw):
    """Parse SVG polygon/polyline points attribute strictly. Returns (list_of_xy, error_or_None)."""
    if raw is None or not raw.strip():
        return [], None
    s = raw.strip()
    pos = 0
    n = len(s)
    nums = []
    while pos < n:
        sp = SVG_TF_SEP_RE.match(s, pos)
        if sp:
            pos = sp.end()
        if pos >= n:
            break
        m = SVG_NUM_RE.match(s, pos)
        if not m:
            return [], f"points:bad-token:{s[pos:pos + 16]}"
        v = float(m.group(0))
        if not math.isfinite(v):
            return [], "points:non-finite"
        nums.append(v)
        pos = m.end()
    if len(nums) % 2 != 0:
        return [], "points:odd-count"
    return [(nums[k], nums[k + 1]) for k in range(0, len(nums), 2)], None


def check_logo_svg(path, allow_draft_text=False, surface=None):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("logo_file_exists", False, path, "existing SVG file", "logo SVG path does not exist or is not a file")]}
    try:
        raw = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError) as exc:
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, str(exc), "readable UTF-8 SVG", "logo SVG must be readable UTF-8")]}
    if re.search(r"<!\s*ENTITY\b|<!\s*DOCTYPE\b[^>]*\b(?:SYSTEM|PUBLIC)\b", raw, re.I):
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, "XML entity/DTD declaration", "plain SVG without <!ENTITY> or external DTD", "reject XML entity and external DTD declarations in logo SVG")]}
    has_xml_stylesheet = bool(SVG_XML_STYLESHEET_RE.search(raw))
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, str(exc), "valid XML/SVG", "logo SVG must parse cleanly as XML")]}
    if root.tag != SVG_NS_TAG:
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, root.tag, SVG_NS_TAG, 'root element must be <svg xmlns="http://www.w3.org/2000/svg">')]}

    checks = [_chk("logo_svg_valid", True, "valid", "valid <svg> in SVG namespace", "SVG parsed cleanly")]

    # 1. Explicit clean 4-number viewBox (no units) and positive width/height aspect match
    vb_raw = root.attrib.get("viewBox", "").strip()
    vb_tokens = [t for t in re.split(r"[\s,]+", vb_raw) if t] if vb_raw else []
    vb_nums = [_parse_plain_float(t) for t in vb_tokens]
    vb_ok = len(vb_nums) == 4 and all(v is not None for v in vb_nums) and vb_nums[2] > 0.0 and vb_nums[3] > 0.0
    if vb_ok:
        vb_x, vb_y, vb_w, vb_h = vb_nums
    else:
        vb_x, vb_y, vb_w, vb_h = 0.0, 0.0, 100.0, 100.0

    raw_w = root.attrib.get("width")
    raw_h = root.attrib.get("height")
    w_attr = _parse_svg_len(raw_w, ref_len=vb_w) if raw_w is not None else None
    h_attr = _parse_svg_len(raw_h, ref_len=vb_h) if raw_h is not None else None
    if raw_w is not None and (w_attr is None or w_attr <= 0.0):
        vb_ok = False
    if raw_h is not None and (h_attr is None or h_attr <= 0.0):
        vb_ok = False
    if vb_ok and w_attr is not None and h_attr is not None:
        ar_vb = vb_w / vb_h
        ar_wh = w_attr / h_attr
        if abs(ar_wh - ar_vb) / max(ar_vb, 1e-9) > 0.05:
            vb_ok = False
    checks.append(_chk("logo_viewbox", vb_ok, vb_raw or "missing", "4 plain numbers in viewBox with positive dimensions matching width/height ratio", "explicit unitless viewBox required so logo scales cleanly"))

    # Walk tree with inherited fill/stroke/stroke-width/opacity and composed 2D affine matrix
    security_hits = ["xml-stylesheet"] if has_xml_stylesheet else []
    text_hits = 0
    effect_hits = []
    invalid_paints = []
    geometry_errors = []
    shape_count = 0
    path_cmd_total = 0
    thin_features = []
    bbox = [float("inf"), float("inf"), float("-inf"), float("-inf")]
    colors_seen = set()
    has_current_color = False
    vb_short = min(vb_w, vb_h)
    vb_diag = math.hypot(vb_w, vb_h) / math.sqrt(2.0)
    min_feature = vb_short / 32.0

    def read_len_attr(el, tag, name, default, ref_len, non_negative=False):
        raw_v = el.attrib.get(name)
        if raw_v is None:
            return default
        parsed = _parse_svg_len(raw_v, ref_len=ref_len)
        if parsed is None or (non_negative and parsed < 0.0):
            geometry_errors.append(f"{tag}:{name}={raw_v}")
            return None
        return parsed

    def inspect_paint(tag, prop_name, prop_val, cur_color):
        nonlocal has_current_color
        kind, parsed = _parse_logo_paint(prop_val)
        if kind == "none":
            return kind
        if kind == "currentColor":
            if cur_color is not None:
                colors_seen.add(cur_color)
            else:
                has_current_color = True
            return kind
        if kind == "rgb":
            colors_seen.add(parsed)
            return kind
        if kind == "translucent":
            effect_hits.append(f"{tag}:{prop_name}-translucent({parsed})")
            return kind
        # kind == "invalid"
        low = (prop_val or "").strip().lower()
        if low.startswith("url("):
            effect_hits.append(f"paint:{prop_val.strip()}")
            security_hits.append(f"paint-url:{prop_val.strip()[:28]}")
        else:
            invalid_paints.append(f"{tag}:{prop_name}={prop_val}")
        return kind

    def walk(
        el,
        inh_fill,
        inh_stroke,
        inh_sw,
        inh_color,
        inh_op,
        inh_fop,
        inh_sop,
        inh_fs,
        inh_anchor,
        inh_baseline,
        parent_mat,
        in_non_render=False,
        is_root=False,
        text_cursor=None,
    ):
        nonlocal text_hits, shape_count, path_cmd_total
        el_ns, local = _split_ns_name(el.tag)
        local_low = local.lower()

        in_svg_ns = el_ns == SVG_NS
        tag = local
        if not in_svg_ns:
            security_hits.append(f"non-svg-ns:{el.tag}")
        else:
            if tag == "svg":
                if not is_root:
                    security_hits.append("nested:<svg>")
            elif tag in LOGO_ALWAYS_ALLOWED_TAGS:
                pass
            elif tag in LOGO_DRAFT_TEXT_TAGS:
                if not allow_draft_text and not in_non_render:
                    text_hits += 1
            elif local_low in LOGO_EFFECT_TAGS or local_low.startswith("fe"):
                effect_hits.append(f"<{tag}>")
            else:
                security_hits.append(f"disallowed-tag:<{tag}>")

        allowed_attrs = LOGO_TAG_ATTRS.get(tag, frozenset()) if in_svg_ns else frozenset()
        for k, v in el.attrib.items():
            ans, alocal = _split_ns_name(k)
            alocal_low = alocal.lower()
            vl = (v or "").strip()
            if ans != "":
                if not (ans == XML_NS and alocal == "space" and in_svg_ns and tag in LOGO_DRAFT_TEXT_TAGS):
                    security_hits.append(f"{tag}:disallowed-attr:{k}")
            elif alocal not in allowed_attrs:
                security_hits.append(f"{tag}:disallowed-attr:{alocal}")
            if alocal_low == "filter" and vl.lower() not in ("", "none"):
                effect_hits.append(f"{tag}:filter:{vl}")
            if _has_forbidden_uri_or_url(v):
                security_hits.append(f"{tag}:forbidden-uri:{alocal}")

        cur_fill = el.attrib.get("fill", inh_fill)
        cur_stroke = el.attrib.get("stroke", inh_stroke)
        cur_sw_raw = el.attrib.get("stroke-width", inh_sw)

        next_non_render = in_non_render or (not in_svg_ns) or (local_low in LOGO_NON_RENDER_TAGS)

        cur_color = inh_color
        if not next_non_render and "color" in el.attrib:
            c_raw = el.attrib["color"]
            c_kind, c_parsed = _parse_logo_paint(c_raw)
            if c_kind == "rgb":
                cur_color = c_parsed
            elif c_kind == "currentColor":
                cur_color = inh_color
            elif c_kind == "translucent":
                effect_hits.append(f"{tag}:color-translucent({c_parsed})")
            else:
                low = (c_raw or "").strip().lower()
                if low.startswith("url("):
                    effect_hits.append(f"color:{c_raw.strip()}")
                else:
                    invalid_paints.append(f"{tag}:color={c_raw}")

        # Strict opacity tracking (opacity multiplies; fill-opacity/stroke-opacity inherit)
        cur_op = inh_op
        cur_fop = inh_fop
        cur_sop = inh_sop
        if not next_non_render:
            op_raw = el.attrib.get("opacity")
            if op_raw is not None:
                op_val = _parse_opacity_val(op_raw)
                if op_val is None or op_val < 1.0 - 1e-9:
                    effect_hits.append(f"{tag}:opacity={op_raw}")
                    cur_op = 0.0 if op_val is None else cur_op * op_val
                else:
                    cur_op *= op_val
            fop_raw = el.attrib.get("fill-opacity")
            if fop_raw is not None:
                fop_val = _parse_opacity_val(fop_raw)
                if fop_val is None or fop_val < 1.0 - 1e-9:
                    effect_hits.append(f"{tag}:fill-opacity={fop_raw}")
                    cur_fop = 0.0 if fop_val is None else fop_val
                else:
                    cur_fop = fop_val
            sop_raw = el.attrib.get("stroke-opacity")
            if sop_raw is not None:
                sop_val = _parse_opacity_val(sop_raw)
                if sop_val is None or sop_val < 1.0 - 1e-9:
                    effect_hits.append(f"{tag}:stroke-opacity={sop_raw}")
                    cur_sop = 0.0 if sop_val is None else sop_val
                else:
                    cur_sop = sop_val

        tf_mat, tf_err = _parse_transform_matrix(el.attrib.get("transform", ""))
        if tf_err and not next_non_render:
            geometry_errors.append(f"{tag}:{tf_err}")
        cur_mat = _mat_mul(parent_mat, tf_mat)
        if cur_mat is None:
            if not next_non_render:
                geometry_errors.append(f"{tag}:transform:non-finite")
            cur_mat = SVG_MAT_IDENTITY

        cur_fs = inh_fs
        cur_anchor = el.attrib.get("text-anchor", inh_anchor).strip().lower() if "text-anchor" in el.attrib else inh_anchor
        cur_baseline = el.attrib.get("dominant-baseline", inh_baseline).strip().lower() if "dominant-baseline" in el.attrib else inh_baseline
        child_text_cursor = text_cursor
        measure_text_segment = None

        is_rendered_shape = in_svg_ns and tag in LOGO_SHAPE_TAGS
        is_rendered_text = in_svg_ns and allow_draft_text and tag == "text"
        is_rendered_tspan = in_svg_ns and allow_draft_text and tag == "tspan"

        if not next_non_render and (is_rendered_shape or is_rendered_text or is_rendered_tspan):
            if not is_rendered_tspan:
                shape_count += 1
            if cur_op < 1.0 - 1e-9:
                effect_hits.append(f"{tag}:inherited-opacity={round(cur_op, 3)}")
            if tag != "line" and cur_fop < 1.0 - 1e-9:
                effect_hits.append(f"{tag}:inherited-fill-opacity={round(cur_fop, 3)}")
            if cur_sop < 1.0 - 1e-9:
                effect_hits.append(f"{tag}:inherited-stroke-opacity={round(cur_sop, 3)}")

            if tag == "line":
                fill_kind = "none"
                stroke_kind = inspect_paint(tag, "stroke", cur_stroke, cur_color)
            else:
                fill_kind = inspect_paint(tag, "fill", cur_fill, cur_color)
                stroke_kind = inspect_paint(tag, "stroke", cur_stroke, cur_color)

            eff_scale_min, eff_scale_max = _mat_linear_scales(cur_mat)
            if not (math.isfinite(eff_scale_min) and math.isfinite(eff_scale_max)):
                geometry_errors.append(f"{tag}:transform:non-finite")
                eff_scale_min, eff_scale_max = 1.0, 1.0
            fill_active = fill_kind != "none"
            stroke_active = stroke_kind != "none"
            if cur_sw_raw is None:
                sw_val = 1.0
            else:
                sw_val = _parse_svg_len(cur_sw_raw, ref_len=vb_diag)
                if sw_val is None or sw_val < 0.0:
                    geometry_errors.append(f"{tag}:stroke-width={cur_sw_raw}")
                    sw_val = 1.0
            eff_sw = sw_val * eff_scale_min
            if stroke_active and eff_sw < min_feature - 1e-6:
                thin_features.append(f"{tag}:stroke-width={round(eff_sw, 3)}<{round(min_feature, 3)}")
            pad = (sw_val * eff_scale_max / 2.0) if stroke_active else 0.0

            tpts = []
            if tag == "rect":
                x = read_len_attr(el, tag, "x", 0.0, vb_w)
                y = read_len_attr(el, tag, "y", 0.0, vb_h)
                w = read_len_attr(el, tag, "width", 0.0, vb_w, non_negative=True)
                h = read_len_attr(el, tag, "height", 0.0, vb_h, non_negative=True)
                if "rx" in el.attrib:
                    read_len_attr(el, tag, "rx", 0.0, vb_w, non_negative=True)
                if "ry" in el.attrib:
                    read_len_attr(el, tag, "ry", 0.0, vb_h, non_negative=True)
                if None not in (x, y, w, h):
                    a, b, c, d, _, _ = cur_mat
                    rw = w * math.hypot(a, b)
                    rh = h * math.hypot(c, d)
                    det = abs(a * d - b * c)
                    alt_min = (det * w * h) / max(rw, rh, 1e-12) if (rw > 0.0 or rh > 0.0) else 0.0
                    if rw < min_feature - 1e-6 or rh < min_feature - 1e-6 or alt_min < min_feature - 1e-6:
                        thin_features.append(f"rect:{round(rw, 2)}x{round(rh, 2)}<{round(min_feature, 2)}")
                    tpts = [
                        _mat_apply(cur_mat, x, y),
                        _mat_apply(cur_mat, x + w, y),
                        _mat_apply(cur_mat, x, y + h),
                        _mat_apply(cur_mat, x + w, y + h),
                    ]
            elif tag == "circle":
                cx = read_len_attr(el, tag, "cx", 0.0, vb_w)
                cy = read_len_attr(el, tag, "cy", 0.0, vb_h)
                r = read_len_attr(el, tag, "r", 0.0, vb_diag, non_negative=True)
                if None not in (cx, cy, r):
                    if 2.0 * r * eff_scale_min < min_feature - 1e-6:
                        thin_features.append(f"circle:d={round(2.0 * r * eff_scale_min, 2)}<{round(min_feature, 2)}")
                    a, b, c, d, _, _ = cur_mat
                    tcx, tcy = _mat_apply(cur_mat, cx, cy)
                    hx = math.hypot(a * r, c * r)
                    hy = math.hypot(b * r, d * r)
                    tpts = [(tcx - hx, tcy - hy), (tcx + hx, tcy + hy)]
            elif tag == "ellipse":
                cx = read_len_attr(el, tag, "cx", 0.0, vb_w)
                cy = read_len_attr(el, tag, "cy", 0.0, vb_h)
                rx = read_len_attr(el, tag, "rx", 0.0, vb_w, non_negative=True)
                ry = read_len_attr(el, tag, "ry", 0.0, vb_h, non_negative=True)
                if None not in (cx, cy, rx, ry):
                    a, b, c, d, _, _ = cur_mat
                    e_min, _ = _mat_linear_scales((a * rx, b * rx, c * ry, d * ry, 0.0, 0.0))
                    if 2.0 * e_min < min_feature - 1e-6:
                        thin_features.append(f"ellipse:min_d={round(2.0 * e_min, 2)}<{round(min_feature, 2)}")
                    tcx, tcy = _mat_apply(cur_mat, cx, cy)
                    hx = math.hypot(a * rx, c * ry)
                    hy = math.hypot(b * rx, d * ry)
                    tpts = [(tcx - hx, tcy - hy), (tcx + hx, tcy + hy)]
            elif tag == "line":
                x1 = read_len_attr(el, tag, "x1", 0.0, vb_w)
                y1 = read_len_attr(el, tag, "y1", 0.0, vb_h)
                x2 = read_len_attr(el, tag, "x2", 0.0, vb_w)
                y2 = read_len_attr(el, tag, "y2", 0.0, vb_h)
                if None not in (x1, y1, x2, y2):
                    tpts = [_mat_apply(cur_mat, x1, y1), _mat_apply(cur_mat, x2, y2)]
            elif tag in ("polygon", "polyline"):
                ppts, perr = _parse_points_attr(el.attrib.get("points", ""))
                if perr:
                    geometry_errors.append(f"{tag}:{perr}")
                else:
                    path_cmd_total += len(ppts)
                    tpts = [_mat_apply(cur_mat, px, py) for px, py in ppts]
                    if tpts:
                        bw = max(p[0] for p in tpts) - min(p[0] for p in tpts)
                        bh = max(p[1] for p in tpts) - min(p[1] for p in tpts)
                    else:
                        bw = bh = 0.0
                    if fill_active:
                        eff_dim = min(bw, bh) + (eff_sw if stroke_active else 0.0)
                        if eff_dim < min_feature - 1e-6:
                            thin_features.append(f"{tag}:bbox={round(bw, 2)}x{round(bh, 2)}<{round(min_feature, 2)}")
                    elif stroke_active:
                        if max(bw, bh) + eff_sw < min_feature - 1e-6:
                            thin_features.append(f"{tag}:span={round(max(bw, bh) + eff_sw, 2)}<{round(min_feature, 2)}")
            elif tag == "path":
                ppts, cmds, perr = _path_transformed_points_and_cmds(el.attrib.get("d", ""), cur_mat)
                path_cmd_total += cmds
                if perr:
                    geometry_errors.append(perr)
                else:
                    tpts = ppts
                    if tpts:
                        bw = max(p[0] for p in tpts) - min(p[0] for p in tpts)
                        bh = max(p[1] for p in tpts) - min(p[1] for p in tpts)
                    else:
                        bw = bh = 0.0
                    if fill_active:
                        eff_dim = min(bw, bh) + (eff_sw if stroke_active else 0.0)
                        if eff_dim < min_feature - 1e-6:
                            thin_features.append(f"path:bbox={round(bw, 2)}x{round(bh, 2)}<{round(min_feature, 2)}")
                    elif stroke_active:
                        if max(bw, bh) + eff_sw < min_feature - 1e-6:
                            thin_features.append(f"path:span={round(max(bw, bh) + eff_sw, 2)}<{round(min_feature, 2)}")
            elif tag in ("text", "tspan"):
                # Per-span bbox & micro-legibility for --allow-draft-text wordmarks (supporting stacked tspans and em units)
                if "font-size" in el.attrib:
                    raw_fs = el.attrib["font-size"]
                    fs_val = _parse_svg_len(raw_fs, ref_len=vb_diag, em_size=inh_fs)
                    if fs_val is None or fs_val < 0.0:
                        geometry_errors.append(f"{tag}:font-size={raw_fs}")
                        fs_val = None
                    else:
                        cur_fs = fs_val
                else:
                    fs_val = inh_fs

                em_ref = cur_fs if fs_val is not None else inh_fs
                if tag == "text" or child_text_cursor is None:
                    child_text_cursor = [0.0, 0.0]

                def parse_coord_first(attr_name, ref_len):
                    raw_attr = el.attrib.get(attr_name)
                    if raw_attr is None or not raw_attr.strip():
                        return False, None
                    tokens = [tok for tok in re.split(r"[\s,]+", raw_attr.strip()) if tok]
                    if not tokens:
                        geometry_errors.append(f"{tag}:{attr_name}={raw_attr}")
                        return True, None
                    parsed = [_parse_svg_len(tok, ref_len=ref_len, em_size=em_ref) for tok in tokens]
                    if any(v is None for v in parsed):
                        geometry_errors.append(f"{tag}:{attr_name}={raw_attr}")
                        return True, None
                    return True, parsed[0]

                has_x, x_val = parse_coord_first("x", vb_w)
                if has_x:
                    child_text_cursor[0] = x_val
                has_y, y_val = parse_coord_first("y", vb_h)
                if has_y:
                    child_text_cursor[1] = y_val
                has_dx, dx_val = parse_coord_first("dx", vb_w)
                if has_dx:
                    if dx_val is None or child_text_cursor[0] is None:
                        child_text_cursor[0] = None
                    else:
                        nx = child_text_cursor[0] + dx_val
                        if not math.isfinite(nx):
                            geometry_errors.append(f"{tag}:dx={el.attrib.get('dx')}")
                            child_text_cursor[0] = None
                        else:
                            child_text_cursor[0] = nx
                has_dy, dy_val = parse_coord_first("dy", vb_h)
                if has_dy:
                    if dy_val is None or child_text_cursor[1] is None:
                        child_text_cursor[1] = None
                    else:
                        ny = child_text_cursor[1] + dy_val
                        if not math.isfinite(ny):
                            geometry_errors.append(f"{tag}:dy={el.attrib.get('dy')}")
                            child_text_cursor[1] = None
                        else:
                            child_text_cursor[1] = ny

                text_legibility_checked = False

                def _measure_seg(
                    seg_text,
                    _fs=fs_val,
                    _scale_min=eff_scale_min,
                    _anchor=cur_anchor,
                    _baseline=cur_baseline,
                    _mat=cur_mat,
                    _pad=pad,
                    _tag=tag,
                    _cursor=child_text_cursor,
                ):
                    nonlocal text_legibility_checked
                    txt_content = (seg_text or "").strip()
                    if not txt_content:
                        return
                    if not text_legibility_checked and _fs is not None:
                        text_legibility_checked = True
                        eff_fs = _fs * _scale_min
                        if not math.isfinite(eff_fs) or eff_fs < min_feature - 1e-6:
                            thin_features.append(f"{_tag}:font-size={round(eff_fs, 3)}<{round(min_feature, 3)}")
                    if None in (_cursor[0], _cursor[1], _fs) or _fs <= 0.0:
                        return
                    tx, ty = _cursor[0], _cursor[1]
                    est_w = len(txt_content) * 0.55 * _fs
                    if _anchor == "middle":
                        x0, x1 = tx - 0.5 * est_w, tx + 0.5 * est_w
                    elif _anchor == "end":
                        x0, x1 = tx - est_w, tx
                    else:
                        x0, x1 = tx, tx + est_w
                    if _baseline in ("middle", "central"):
                        y0, y1 = ty - 0.45 * _fs, ty + 0.45 * _fs
                    elif _baseline in ("hanging", "text-before-edge", "text-top"):
                        y0, y1 = ty, ty + 0.95 * _fs
                    else:
                        y0, y1 = ty - 0.75 * _fs, ty + 0.2 * _fs
                    seg_pts = [
                        _mat_apply(_mat, x0, y0),
                        _mat_apply(_mat, x1, y0),
                        _mat_apply(_mat, x0, y1),
                        _mat_apply(_mat, x1, y1),
                    ]
                    if any(not (math.isfinite(px) and math.isfinite(py)) for px, py in seg_pts):
                        geometry_errors.append(f"{_tag}:non-finite-bbox")
                        return
                    for px, py in seg_pts:
                        bbox[0] = min(bbox[0], px - _pad)
                        bbox[1] = min(bbox[1], py - _pad)
                        bbox[2] = max(bbox[2], px + _pad)
                        bbox[3] = max(bbox[3], py + _pad)

                measure_text_segment = _measure_seg
                measure_text_segment(el.text)

            if any(not (math.isfinite(px) and math.isfinite(py)) for px, py in tpts):
                geometry_errors.append(f"{tag}:non-finite-bbox")
            else:
                for px, py in tpts:
                    bbox[0] = min(bbox[0], px - pad)
                    bbox[1] = min(bbox[1], py - pad)
                    bbox[2] = max(bbox[2], px + pad)
                    bbox[3] = max(bbox[3], py + pad)

        for child in list(el):
            walk(
                child, cur_fill, cur_stroke, cur_sw_raw, cur_color, cur_op, cur_fop, cur_sop,
                cur_fs, cur_anchor, cur_baseline, cur_mat, next_non_render, False,
                child_text_cursor if (is_rendered_text or is_rendered_tspan) else None,
            )
            if measure_text_segment is not None and child.tail:
                measure_text_segment(child.tail)

    walk(root, "black", "none", None, None, 1.0, 1.0, 1.0, 16.0, "start", "auto", SVG_MAT_IDENTITY, False, True, None)

    checks.append(_chk("logo_self_contained", not security_hits, security_hits or "clean", "[]", "strict SVG tag/namespace/attribute allowlist: zero style attributes, disallowed tags, event handlers, url(...) references, external/data URIs, or non-SVG elements"))
    checks.append(_chk("logo_geometry", not geometry_errors, geometry_errors or "valid", "[]", "valid SVG path syntax, transforms, points, and length attributes"))
    text_ok = allow_draft_text or text_hits == 0
    checks.append(_chk("logo_outlined_text", text_ok, text_hits if not text_ok else "outlined", "0 <text> nodes (or --allow-draft-text)", "convert wordmark glyphs to <path> outlines so logos never font-substitute"))
    comp_ok = (1 <= shape_count <= 64) and (path_cmd_total <= 400)
    checks.append(_chk("logo_complexity", comp_ok, {"shapes": shape_count, "path_cmds": path_cmd_total}, "1..64 shapes and <= 400 path commands/vertices", "clean vector geometry without bloated auto-trace soup"))
    checks.append(_chk("logo_micro_legibility", not thin_features, thin_features or "legible", f"strokes/features >= {round(min_feature, 3)} (>= 0.5px at 16px favicon)", "features survive 16px favicon downscale without vanishing"))

    if bbox[0] <= bbox[2] and bbox[1] <= bbox[3]:
        mx, my = 0.04 * vb_w, 0.04 * vb_h
        cs_ok = (
            bbox[0] >= vb_x + mx - 1e-6
            and bbox[1] >= vb_y + my - 1e-6
            and bbox[2] <= vb_x + vb_w - mx + 1e-6
            and bbox[3] <= vb_y + vb_h - my + 1e-6
        )
        cs_val = [round(v, 2) for v in bbox]
    else:
        cs_ok = False
        cs_val = "empty"
    checks.append(_chk("logo_clearspace", cs_ok, cs_val, f"within [{round(vb_x + 0.04*vb_w, 2)}, {round(vb_y + 0.04*vb_h, 2)}]..[{round(vb_x + 0.96*vb_w, 2)}, {round(vb_y + 0.96*vb_h, 2)}]", "keep >= 4% clearspace inside viewBox with zero clipped edges"))

    checks.append(_chk("logo_monochrome_safe", not effect_hits, effect_hits or "flat", "[]", "flat opaque solid shapes without gradients, blur, drop-shadow filters, or opacity < 1"))

    total_inks = len(colors_seen) + (1 if has_current_color else 0)
    pal_ok = (not invalid_paints) and (1 <= total_inks <= 3)
    pal_val = {"inks": total_inks, "invalid_paints": invalid_paints} if invalid_paints else total_inks
    checks.append(_chk("logo_palette_restraint", pal_ok, pal_val, "1..3 distinct valid flat brand colors", "cap logo palette to at most 3 distinct flat brand inks with valid CSS colors"))

    if surface is not None:
        surf_kind, surf_rgb = _parse_logo_paint(surface)
        if surf_kind != "rgb":
            contrast_ok = False
            contrast_val = f"invalid surface {surface}"
        elif invalid_paints:
            contrast_ok = False
            contrast_val = {"surface": surface, "invalid_paints": invalid_paints}
        elif not colors_seen and has_current_color:
            contrast_ok = True
            contrast_val = "currentColor"
        else:
            raw_ratios = [_contrast_ratio(c, surf_rgb) for c in colors_seen]
            contrast_ok = bool(raw_ratios) and all(r >= 3.0 for r in raw_ratios)
            contrast_val = {"surface": surface, "min_ratio": round(min(raw_ratios), 4) if raw_ratios else 0.0}
    else:
        if invalid_paints:
            contrast_ok = False
            contrast_val = {"invalid_paints": invalid_paints}
        elif not colors_seen and has_current_color:
            contrast_ok = True
            contrast_val = "currentColor"
        else:
            light_ratios = [_contrast_ratio(c, (255, 255, 255)) for c in colors_seen]
            dark_ratios = [_contrast_ratio(c, (17, 17, 17)) for c in colors_seen]
            light_ok = bool(light_ratios) and all(r >= 3.0 for r in light_ratios)
            dark_ok = bool(dark_ratios) and all(r >= 3.0 for r in dark_ratios)
            contrast_ok = light_ok or dark_ok
            min_l = round(min(light_ratios, default=0.0), 4)
            min_d = round(min(dark_ratios, default=0.0), 4)
            contrast_val = {"min_on_light": min_l, "min_on_dark": min_d}
    checks.append(_chk("logo_contrast", contrast_ok, contrast_val, ">= 3.0:1 WCAG graphical contrast on light or dark surface (no fake white-fill cutouts)", "all logo inks meet >= 3:1 contrast on their target surface"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


WEB_LINT_EXTS = {".html", ".htm", ".css", ".jsx", ".tsx"}
CUSTOM_PROP_KEY_RE = re.compile(r"^--[A-Za-z0-9_-]+$")
REDUCED_MOTION_MEDIA_RE = re.compile(r"^@media\b[^;]*prefers-reduced-motion\s*:\s*reduce\b", re.I)
NO_PREF_MOTION_MEDIA_RE = re.compile(r"^@media\b[^;]*prefers-reduced-motion\s*:\s*no-preference\b", re.I)
RESPONSIVE_MEDIA_RE = re.compile(
    r"@media\b[^{]*(?:width|height|orientation|aspect-ratio|pointer|hover)\b|@container\b",
    re.I,
)
TAILWIND_CSS_RE = re.compile(r"@tailwind\b|@theme\b|@import\s+(?:url\(\s*)?['\"][^'\"]*tailwindcss", re.I)
TAILWIND_TAG_RE = re.compile(r"<(?:script|link|style)\b[^>]*tailwindcss", re.I)
TW_RAW_PALETTE_RE = re.compile(
    r"^(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|accent|caret)-"
    r"(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)"
    r"-(?:50|[1-9]00|950)(?:/(?:[A-Za-z0-9._-]+|\[[^\]]+\]))?$"
)
TW_ARB_COLOR_RE = re.compile(
    r"^(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|accent|caret)-\[(?:#|rgba?\(|hsla?\(|hwb\(|oklch\(|oklab\(|lch\(|lab\()[^\]]+\](?:/(?:[A-Za-z0-9._-]+|\[[^\]]+\]))?$",
    re.I,
)
TW_ARB_VAL_RE = re.compile(
    r"^(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|w|h|min-w|max-w|min-h|max-h|text|rounded|z|leading|tracking|border)-\[(?!(?:[a-z-]+:)?var\(--)[^\]]+\](?:/(?:[A-Za-z0-9._-]+|\[[^\]]+\]))?$"
)
TW_RESTYLE_PREFIX_RE = re.compile(
    r"^(?:bg|text|p|px|py|pt|pr|pb|pl|rounded|border|shadow|font|tracking|leading|ring|outline|fill|stroke)-"
)
TW_BARE_RESTYLE_UTILS = frozenset({
    "border", "rounded", "shadow", "ring", "outline", "italic", "underline", "truncate",
})
TW_LAYOUT_PREFIX_RE = re.compile(
    r"^(?:m|mx|my|mt|mr|mb|ml|w|h|min-w|max-w|min-h|max-h|col-span|row-span|col-start|row-start|self|justify-self|place-self|flex|grow|shrink|basis|order|static|relative|absolute|fixed|sticky|top|right|bottom|left|inset|z|block|inline|hidden|grid|sr-only)(?:-|$)"
)
HTML_TAG_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9:-]*")
HTML_ATTR_NAME_RE = re.compile(r"[A-Za-z_:][A-Za-z0-9_.:-]*")
HTML_INTERACTIVE_TAGS = frozenset({"button", "input", "select", "textarea"})
TS_GENERIC_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
HTML_LOWER_TAGS = frozenset({
    "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo",
    "blockquote", "body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup",
    "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
    "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd",
    "label", "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav",
    "noscript", "object", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress",
    "q", "rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select", "slot", "small",
    "source", "span", "strong", "style", "sub", "summary", "sup", "svg", "table", "tbody", "td",
    "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul",
    "var", "video", "wbr",
})
JSX_TAG_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]*")
JSX_ATTR_NAME_RE = re.compile(r"[A-Za-z_:][A-Za-z0-9_.:-]*")
JSX_RAW_INTERACTIVE_TAGS = frozenset({"button", "input", "select", "textarea"})
JS_REGEX_KEYWORDS = frozenset({
    "return", "case", "throw", "in", "instanceof", "typeof", "void",
    "delete", "new", "else", "do", "of", "yield", "await", "export", "default",
})
TS_TYPE_CONT_PREV_TOKENS = frozenset({
    "=", ":", "|", "&", "=>", "?", ",", "(", "[", "{", "<",
    "extends", "as", "satisfies", "keyof", "typeof", "readonly", "infer", "new",
})
TS_DECL_BLOCK_PREV = frozenset({
    "const", "let", "var", "import", "as", "satisfies", "extends", "typeof", "keyof", ":", ",", "(", "?",
})
KNOWN_CLASS_HELPERS = frozenset({
    "cn", "clsx", "cx", "classNames", "classnames", "twMerge", "twJoin", "cva", "join",
})
CSS_SCALE_ZERO_RE = re.compile(r"\bscale(?:3d)?\s*\(\s*0(?:\.0+)?(?:\s*,\s*0(?:\.0+)?)?(?:\s*,\s*[0-9.]+)?\s*\)", re.I)
CSS_EASE_IN_ONLY_RE = re.compile(r"(?<![A-Za-z0-9_-])ease-in(?![A-Za-z0-9_-])", re.I)


def _mask_newlines_only(match):
    return re.sub(r"[^\n]", " ", match.group(0))


def _mask_range(chars, start, end):
    for idx in range(start, end):
        if chars[idx] != "\n":
            chars[idx] = " "


def _normalize_tw_token(tok):
    """Strip Tailwind variant prefixes (respecting [...] arbitrary variants), leading/trailing '!', and leading '-'."""
    bracket_depth = 0
    last_colon = -1
    for idx, ch in enumerate(tok):
        if ch == "[":
            bracket_depth += 1
        elif ch == "]" and bracket_depth > 0:
            bracket_depth -= 1
        elif ch == ":" and bracket_depth == 0:
            last_colon = idx
    base = tok[last_colon + 1:] if last_colon >= 0 else tok
    if base.startswith("!"):
        base = base[1:]
    if base.endswith("!"):
        base = base[:-1]
    if base.startswith("-"):
        base = base[1:]
    return base


def _try_scan_regex_literal(text, start):
    """Given text[start] == '/' in regex-allowed position, return index past /pattern/flags or -1."""
    n = len(text)
    if start + 1 >= n or text[start + 1] in ("/", "*", "\n", "\r"):
        return -1
    j = start + 1
    in_class = False
    while j < n:
        c = text[j]
        if c in ("\n", "\r"):
            return -1
        if c == "\\":
            if j + 1 >= n or text[j + 1] in ("\n", "\r"):
                return -1
            j += 2
            continue
        if c == "[":
            in_class = True
            j += 1
            continue
        if c == "]" and in_class:
            in_class = False
            j += 1
            continue
        if c == "/" and not in_class:
            j += 1
            while j < n and text[j].isalpha():
                j += 1
            return j
        j += 1
    return -1


def _skip_ws_and_js_comments(text, pos, mask_out=None):
    """Advance past whitespace, // line comments, and /* ... */ block comments. Return (pos, unclosed_comment)."""
    n = len(text)
    while pos < n:
        ch = text[pos]
        if ch in " \t\r\n":
            pos += 1
            continue
        if ch == "/" and pos + 1 < n and text[pos + 1] == "/":
            nl = text.find("\n", pos + 2)
            end_c = n if nl < 0 else nl
            if mask_out is not None:
                _mask_range(mask_out, pos, end_c)
            pos = n if nl < 0 else nl + 1
            continue
        if ch == "/" and pos + 1 < n and text[pos + 1] == "*":
            end_c = text.find("*/", pos + 2)
            if end_c < 0:
                if mask_out is not None:
                    _mask_range(mask_out, pos, n)
                return n, True
            if mask_out is not None:
                _mask_range(mask_out, pos, end_c + 2)
            pos = end_c + 2
            continue
        break
    return pos, False


def _skip_horiz_ws_and_inline_comments(text, pos):
    """Advance past spaces/tabs and single-line /* ... */ comments without crossing a newline."""
    n = len(text)
    while pos < n:
        ch = text[pos]
        if ch in " \t":
            pos += 1
            continue
        if ch == "/" and pos + 1 < n and text[pos + 1] == "*":
            end_c = text.find("*/", pos + 2)
            if end_c < 0 or "\n" in text[pos + 2:end_c] or "\r" in text[pos + 2:end_c]:
                break
            pos = end_c + 2
            continue
        break
    return pos


def _add_unparsed(ctx, text, pos, why, fix, end=None):
    if ctx is not None:
        hi = min(end, pos + 50) if end is not None else pos + 50
        ctx["unparsed"].append((pos, (text[pos:hi].splitlines() or [""])[0], why, fix))


def _skip_js_atom(s, i, can_regex=False, mask_out=None, strict_str=True, allow_tpl=True):
    """Skip a JS string, template literal, comment, or regex at s[i]. Return (kind, next_i) where kind is None|'comment'|'literal'|'err'."""
    n, ch = len(s), s[i]
    if ch in ("'", '"'):
        q, j = ch, i + 1
        while j < n:
            c = s[j]
            if c == "\\":
                if j + 1 < n:
                    j += 3 if (s[j + 1] == "\r" and j + 2 < n and s[j + 2] == "\n") else 2
                    continue
                return ("err" if strict_str else "literal"), n
            if strict_str and c in ("\n", "\r"):
                return "err", j
            if c == q:
                return "literal", j + 1
            j += 1
        return ("err" if strict_str else "literal"), n
    if ch == "`" and allow_tpl:
        end_t = _scan_template_literal_end(s, i, ctx={"mask": mask_out} if mask_out is not None else None)
        return ("literal", end_t) if end_t >= 0 else (("err" if strict_str else "literal"), n)
    if ch == "/" and i + 1 < n and s[i + 1] == "*":
        end_c = s.find("*/", i + 2)
        if end_c < 0:
            if mask_out is not None:
                _mask_range(mask_out, i, n)
            return ("err" if strict_str else "comment"), n
        if mask_out is not None:
            _mask_range(mask_out, i, end_c + 2)
        return "comment", end_c + 2
    if ch == "/" and i + 1 < n and s[i + 1] == "/":
        nl = s.find("\n", i + 2)
        if mask_out is not None:
            _mask_range(mask_out, i, n if nl < 0 else nl)
        return "comment", n if nl < 0 else nl + 1
    if ch == "/" and can_regex:
        end_r = _try_scan_regex_literal(s, i)
        if end_r > 0:
            return "literal", end_r
    return None, i


def _scan_js_word(s, i):
    """If s[i] starts an identifier or number, return (kind, end_idx), else (None, i)."""
    n, ch = len(s), s[i]
    if ch.isalpha() or ch in "_$":
        j = i + 1
        while j < n and (s[j].isalnum() or s[j] in "_$"):
            j += 1
        return "ident", j
    if ch.isdigit():
        j = i + 1
        while j < n and (s[j].isalnum() or s[j] in "_."):
            j += 1
        return "num", j
    return None, i


def _scan_ts_type_args(text, start, mask_out=None):
    """Given text[start] == '<', scan balanced TypeScript generic type args <...> and return index past '>' or -1."""
    n = len(text)
    if start >= n or text[start] != "<":
        return -1
    depth, i = 0, start
    while i < n:
        kind, nxt = _skip_js_atom(text, i, mask_out=mask_out)
        if kind == "err":
            return -1
        if kind is not None:
            i = nxt
            continue
        if text.startswith("=>", i):
            i += 2
            continue
        ch = text[i]
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def _scan_balanced_delim(text, start, open_ch, close_ch):
    """Given text[start] == open_ch, return index of matching close_ch or -1, respecting strings, templates, comments, and regexes."""
    n = len(text)
    if start >= n or text[start] != open_ch:
        return -1
    depth, i, can_regex, prev_was_dot = 0, start, True, False
    while i < n:
        ch = text[i]
        if ch in " \t\r\n":
            i += 1
            continue
        kind, nxt = _skip_js_atom(text, i, can_regex=can_regex)
        if kind == "err":
            return -1
        if kind is not None:
            i = nxt
            if kind == "literal":
                can_regex, prev_was_dot = False, False
            continue
        if ch == open_ch:
            depth += 1
            i, can_regex, prev_was_dot = i + 1, True, False
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
            i, can_regex, prev_was_dot = i + 1, (close_ch == "}"), False
        elif ch in (")", "]"):
            i, can_regex, prev_was_dot = i + 1, False, False
        elif ch == ".":
            i, can_regex, prev_was_dot = i + 1, False, True
        elif ch in ("+", "-") and i + 1 < n and text[i + 1] == ch:
            i, prev_was_dot = i + 2, False
        else:
            wk, j = _scan_js_word(text, i)
            if wk == "ident":
                can_regex = (not prev_was_dot) and (text[i:j] in JS_REGEX_KEYWORDS)
                i, prev_was_dot = j, False
            elif wk == "num":
                i, can_regex, prev_was_dot = j, False, False
            else:
                i, can_regex, prev_was_dot = i + 1, True, False
    return -1


def _scan_balanced_parens(text, start):
    """Given text[start] == '(', return index of matching ')' or -1."""
    return _scan_balanced_delim(text, start, "(", ")")


def _has_arrow_after_optional_return_type(text, after_p):
    """Return True iff after_p starts with '=>' or ': ReturnType =>' (never bare ':' without '=>')."""
    n = len(text)
    if after_p >= n:
        return False
    if text.startswith("=>", after_p):
        return True
    if text[after_p] != ":":
        return False
    i, depth = after_p + 1, 0
    while i < n:
        ch = text[i]
        if ch in " \t\r\n":
            i += 1
            continue
        kind, nxt = _skip_js_atom(text, i)
        if kind == "err":
            return False
        if kind is not None:
            i = nxt
            continue
        if text.startswith("=>", i):
            if depth == 0:
                return True
            i += 2
            continue
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            if depth == 0:
                return False
            depth -= 1
        elif depth == 0 and ch in (";", ",", "="):
            return False
        i += 1
    return False


def _try_scan_ts_generic_params(text, lt, in_type_pos=False, in_type_brace_member=False, mask_out=None):
    """Detect TS generic type parameter list at text[lt] == '<' in JS mode; return index past '>' or -1."""
    n = len(text)
    if lt >= n or text[lt] != "<":
        return -1
    p, unc = _skip_ws_and_js_comments(text, lt + 1)
    m = TS_GENERIC_IDENT_RE.match(text, p) if (not unc and p < n) else None
    if not m:
        return -1
    first_ident = ident = m.group(0)
    p, has_const = m.end(), False
    if first_ident == "const":
        p2, unc2 = _skip_ws_and_js_comments(text, p)
        m2 = TS_GENERIC_IDENT_RE.match(text, p2) if (not unc2 and p2 > p) else None
        if m2:
            has_const, ident, p = True, m2.group(0), m2.end()
    if not in_type_pos and ((not has_const and first_ident in HTML_LOWER_TAGS) or ident in HTML_LOWER_TAGS):
        return -1
    p, unc = _skip_ws_and_js_comments(text, p)
    if unc or p >= n:
        return -1
    has_disamb = text[p] == ","
    if not has_disamb and re.match(r"extends\b", text[p:]):
        p_ext, unc_ext = _skip_ws_and_js_comments(text, p + 7)
        has_disamb = not unc_ext and p_ext < n and text[p_ext] != ">"
    elif not has_disamb and text[p] == "=" and not text.startswith("=>", p):
        p_eq, unc_eq = _skip_ws_and_js_comments(text, p + 1)
        has_disamb = not unc_eq and p_eq < n and text[p_eq] != ">"
    if not (has_disamb or (in_type_pos and text[p] == ">")):
        return -1
    end_gen = _scan_ts_type_args(text, lt)
    if end_gen < 0:
        return -1
    after_gt, unc3 = _skip_ws_and_js_comments(text, end_gen)
    if unc3 or after_gt >= n or text[after_gt] != "(":
        return -1
    close_p = _scan_balanced_parens(text, after_gt)
    if close_p < 0:
        return -1
    after_p, unc4 = _skip_ws_and_js_comments(text, close_p + 1)
    if unc4 or after_p >= n:
        return -1
    if in_type_pos:
        if not (text.startswith("=>", after_p) or (in_type_brace_member and text[after_p] == ":")):
            return -1
    elif not _has_arrow_after_optional_return_type(text, after_p):
        return -1
    if mask_out is not None:
        _scan_ts_type_args(text, lt, mask_out=mask_out)
    return end_gen


def _scan_template_literal_end(text, start, ctx=None, open_tags=()):
    """Given text[start] == '`', return index just past the matching closing '`' or -1."""
    n, i = len(text), start + 1
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            i += 2
            continue
        if ch == "$" and i + 1 < n and text[i + 1] == "{":
            before_unp = len(ctx["unparsed"]) if (ctx and "unparsed" in ctx) else 0
            end_b = _scan_js_mode(text, i + 2, stop_at_close_brace=True, ctx=ctx, open_tags=open_tags)
            if end_b < 0:
                if ctx and "unparsed" in ctx and len(ctx["unparsed"]) == before_unp:
                    _add_unparsed(ctx, text, start, "unclosed template literal interpolation reached end of file", "close the '${...}' interpolation and template literal so --web-lint can audit the remaining code")
                return -1
            i = end_b + 1
            continue
        if ch == "`":
            return i + 1
        i += 1
    if ctx and "unparsed" in ctx:
        _add_unparsed(ctx, text, start, "unclosed template literal reached end of file", "close the backtick template literal so --web-lint can audit the remaining code")
    return -1


def _scan_balanced_braces(text, start):
    """Given text[start] == '{', return index of matching '}' or -1 if unclosed."""
    return _scan_js_mode(text, start + 1, stop_at_close_brace=True) if (start < len(text) and text[start] == "{") else -1


def _try_parse_jsx_opening_tag(text, lt, ctx=None, in_jsx_children=False, open_tags=()):
    """Parse a JSX opening tag at text[lt] == '<'. Returns None if not a JSX tag, else (kind, tag_name, next_pos)."""
    n = len(text)
    if lt + 1 >= n or text[lt + 1] == "/":
        return None
    if text[lt + 1] == ">":
        return ("fragment", "", lt + 2)
    m_tag = JSX_TAG_NAME_RE.match(text, lt + 1)
    if not m_tag:
        return None
    tag_name, pos = m_tag.group(0), m_tag.end()
    if not in_jsx_children and ((pos < n and text[pos] == ",") or re.match(r"[ \t\r\n]+extends\b", text[pos:])):
        return None
    mask_out = ctx["mask"] if (ctx and "mask" in ctx) else None
    unp_ctx = ctx if (ctx and "unparsed" in ctx) else None
    if pos < n and text[pos] == "<":
        end_t = _scan_ts_type_args(text, pos, mask_out=mask_out)
        if end_t < 0:
            _add_unparsed(unp_ctx, text, lt, "unclosed TypeScript generic type argument on JSX tag", "close the generic <...> type argument list on the JSX tag so --web-lint can audit its props")
            return ("unparsed", tag_name, pos + 1)
        pos = end_t
    if pos < n and text[pos] not in " \t\r\n/>" and not (text[pos] == "/" and pos + 1 < n and text[pos + 1] in ("/", "*")):
        return None

    attrs = []
    while pos < n:
        pos, unclosed_c = _skip_ws_and_js_comments(text, pos, mask_out=mask_out)
        if unclosed_c:
            _add_unparsed(unp_ctx, text, lt, "unclosed block comment inside JSX opening tag", "close the /* ... */ comment inside the JSX tag so --web-lint can audit its props")
            return ("unparsed", tag_name, n)
        if pos >= n:
            break
        if text[pos] == ">":
            if ctx and "tags" in ctx:
                ctx["tags"].append((tag_name, lt, attrs))
            return ("open", tag_name, pos + 1)
        if text[pos] == "/" and pos + 1 < n and text[pos + 1] == ">":
            if ctx and "tags" in ctx:
                ctx["tags"].append((tag_name, lt, attrs))
            return ("self", tag_name, pos + 2)
        if text[pos] == "{":
            expr_start = pos + 1
            end_b = _scan_js_mode(text, expr_start, stop_at_close_brace=True, ctx=ctx, open_tags=open_tags)
            if end_b < 0:
                _add_unparsed(unp_ctx, text, pos, "unclosed '{...}' expression inside JSX opening tag", "balance braces in the JSX attribute expression so --web-lint can audit the tag")
                return ("unparsed", tag_name, n)
            inner_s = ("".join(mask_out[expr_start:end_b]) if mask_out is not None else text[expr_start:end_b]).strip()
            if inner_s and not inner_s.startswith("..."):
                _add_unparsed(unp_ctx, text, pos, f"malformed JSX attribute expression on <{tag_name}>", "use named prop={...} or spread {...props} syntax inside JSX opening tags", end=end_b + 1)
            pos = end_b + 1
            continue
        m_attr = JSX_ATTR_NAME_RE.match(text, pos)
        if not m_attr:
            _add_unparsed(unp_ctx, text, pos, f"malformed attribute inside <{tag_name}> opening tag", "fix the malformed JSX attribute syntax so --web-lint can audit every prop")
            return ("unparsed", tag_name, pos + 1)
        attr_name, attr_start, pos = m_attr.group(0), pos, m_attr.end()
        pos, unclosed_c = _skip_ws_and_js_comments(text, pos, mask_out=mask_out)
        if unclosed_c:
            _add_unparsed(unp_ctx, text, attr_start, "unclosed block comment after JSX attribute name", "close the /* ... */ comment inside the JSX opening tag")
            return ("unparsed", tag_name, n)
        if pos < n and text[pos] == "=":
            pos, unclosed_c = _skip_ws_and_js_comments(text, pos + 1, mask_out=mask_out)
            if unclosed_c or pos >= n:
                _add_unparsed(unp_ctx, text, attr_start, f"missing attribute value for '{attr_name}' on <{tag_name}>", f"provide a quoted string or balanced {{...}} value for '{attr_name}'")
                return ("unparsed", tag_name, n)
            if text[pos] in ('"', "'"):
                q, val_start = text[pos], pos + 1
                end_q = text.find(q, val_start)
                if end_q < 0:
                    _add_unparsed(unp_ctx, text, attr_start, f"unclosed string attribute '{attr_name}' on <{tag_name}>", f"close the quoted string for '{attr_name}' so --web-lint can audit the tag")
                    return ("unparsed", tag_name, n)
                attrs.append((attr_name, attr_start, "string", text[val_start:end_q]))
                pos = end_q + 1
            elif text[pos] == "{":
                expr_start = pos + 1
                end_b = _scan_js_mode(text, expr_start, stop_at_close_brace=True, ctx=ctx, open_tags=open_tags)
                if end_b < 0:
                    _add_unparsed(unp_ctx, text, attr_start, f"unclosed '{{...}}' expression for '{attr_name}' on <{tag_name}>", f"balance braces in '{attr_name}={{...}}' so --web-lint can audit the tag")
                    return ("unparsed", tag_name, n)
                expr_val = "".join(mask_out[expr_start:end_b]) if mask_out is not None else text[expr_start:end_b]
                attrs.append((attr_name, attr_start, "expr", expr_val))
                pos = end_b + 1
            else:
                _add_unparsed(unp_ctx, text, attr_start, f"unquoted or malformed attribute value for '{attr_name}' on <{tag_name}>", f"wrap '{attr_name}' value in quotes or balanced {{...}} braces")
                while pos < n and text[pos] not in " \t\r\n/>":
                    pos += 1
        else:
            attrs.append((attr_name, attr_start, "bool", ""))
    _add_unparsed(unp_ctx, text, lt, "unclosed JSX opening tag reached end of file", "close the JSX opening tag with '>' or '/>' so --web-lint can audit it")
    return ("unparsed", tag_name, n)


def _scan_jsx_element(text, lt, ctx, in_jsx_children, open_tags):
    parsed = _try_parse_jsx_opening_tag(text, lt, ctx=ctx, in_jsx_children=in_jsx_children, open_tags=open_tags)
    if parsed is None:
        return -1
    kind, child_tag, pos = parsed
    if kind in ("open", "fragment"):
        body_start = pos
        pos = _scan_jsx_children(text, pos, child_tag, ctx=ctx, open_tags=open_tags)
        if kind == "open" and child_tag.lower() == "style" and ctx and "styles" in ctx:
            close_idx = text.rfind("</", body_start, pos)
            ctx["styles"].append((lt, body_start, close_idx if close_idx >= body_start else pos, pos))
    return pos


def _scan_jsx_children(text, pos, open_tag, ctx=None, open_tags=()):
    """Scan JSX element children until matching </open_tag> (or ancestor closing tag / EOF)."""
    n, child_open_tags = len(text), open_tags + (open_tag,)
    unp_ctx = ctx if (ctx and "unparsed" in ctx) else None
    while pos < n:
        ch = text[pos]
        if ch == "{":
            end_b = _scan_js_mode(text, pos + 1, stop_at_close_brace=True, ctx=ctx, open_tags=child_open_tags)
            if end_b < 0:
                _add_unparsed(unp_ctx, text, pos, "unclosed '{...}' JSX child expression", "balance braces in the JSX expression container")
                return n
            pos = end_b + 1
            continue
        if ch == "<":
            if pos + 1 < n and text[pos + 1] == "/":
                j = pos + 2
                while j < n and text[j] in " \t\r\n":
                    j += 1
                m_close = JSX_TAG_NAME_RE.match(text, j)
                close_name, k = (m_close.group(0), m_close.end()) if m_close else ("", j)
                while k < n and text[k] in " \t\r\n":
                    k += 1
                if k < n and text[k] == ">":
                    if close_name == open_tag:
                        return k + 1
                    if close_name in open_tags:
                        return pos
                    pos = k + 1
                    continue
                pos += 2
                continue
            nxt = _scan_jsx_element(text, pos, ctx, True, child_open_tags)
            if nxt >= 0:
                pos = nxt
                continue
        pos += 1
    return pos


def _new_js_frame(kind):
    return {
        "kind": kind, "ternary_depth": 0, "in_type_alias": False, "expect_type_brace": False,
        "var_decl_state": None, "in_param_type": False, "in_ret_type": False,
        "in_type_assert": False, "in_case": False, "at_member_start": kind == "type_brace",
    }


def _scan_js_mode(text, pos, stop_at_close_brace=False, ctx=None, open_tags=()):
    """Single-pass JS/TSX scanner handling strings, templates, regexes, comments, balanced braces, TS type context, and JSX."""
    n = len(text)
    mask_out = ctx["mask"] if (ctx and "mask" in ctx) else None
    unp_ctx = ctx if (ctx and "unparsed" in ctx) else None
    brace_depth = 0
    frames = [_new_js_frame("root")]
    can_regex, prev_was_dot, prev_tok, saw_newline = True, False, "", False

    def clear_type_flags(f, full=False):
        f["in_type_alias"] = f["in_ret_type"] = f["in_type_assert"] = False
        if full:
            f["expect_type_brace"] = f["in_case"] = False
            f["var_decl_state"] = None
            f["ternary_depth"] = 0

    def current_type_context():
        f = frames[-1]
        fk = f["kind"]
        if fk == "type_brace":
            return True, f["at_member_start"]
        if fk in ("type_paren", "type_bracket"):
            return True, False
        return bool(f["in_type_alias"] or f["var_decl_state"] == "type_annot" or f["in_param_type"] or f["in_ret_type"] or f["in_type_assert"]), False

    while pos < n:
        ch = text[pos]
        if ch in " \t\r\n":
            if ch in ("\n", "\r"):
                saw_newline = True
            pos += 1
            continue
        if ch == "/" and pos + 1 < n and text[pos + 1] == "*":
            end_c = text.find("*/", pos + 2)
            if end_c < 0:
                if mask_out is not None:
                    _mask_range(mask_out, pos, n)
                _add_unparsed(unp_ctx, text, pos, "unclosed block comment '/*' reached end of file", "close the '/* ... */' block comment so --web-lint can audit the remaining code")
                return -1 if stop_at_close_brace else n
            if "\n" in text[pos + 2:end_c] or "\r" in text[pos + 2:end_c]:
                saw_newline = True
            if mask_out is not None:
                _mask_range(mask_out, pos, end_c + 2)
            pos = end_c + 2
            continue
        if ch == "/" and pos + 1 < n and text[pos + 1] == "/":
            nl = text.find("\n", pos + 2)
            if mask_out is not None:
                _mask_range(mask_out, pos, n if nl < 0 else nl)
            if nl >= 0:
                saw_newline = True
            pos = n if nl < 0 else nl + 1
            continue

        cur_f = frames[-1]
        if saw_newline:
            saw_newline = False
            next_is_type_cont = ch in ("|", "&", "?", ":", "[", ".") or text.startswith("=>", pos) or bool(re.match(r"extends\b", text[pos:]))
            if prev_tok not in TS_TYPE_CONT_PREV_TOKENS and not next_is_type_cont:
                if cur_f["kind"] == "type_brace":
                    cur_f["at_member_start"] = True
                else:
                    clear_type_flags(cur_f)
                    if cur_f["var_decl_state"] == "type_annot":
                        cur_f["var_decl_state"] = None

        if ch in ("'", '"'):
            q, str_start, pos = ch, pos, pos + 1
            closed_str = hit_newline = False
            while pos < n:
                c = text[pos]
                if c == "\\":
                    if pos + 1 < n:
                        pos += 3 if (text[pos + 1] == "\r" and pos + 2 < n and text[pos + 2] == "\n") else 2
                        continue
                    pos += 1
                    break
                if c in ("\n", "\r"):
                    hit_newline = True
                    break
                if c == q:
                    pos, closed_str = pos + 1, True
                    break
                pos += 1
            if not closed_str:
                why = "unclosed string literal (unescaped newline)" if hit_newline else "unclosed string literal reached end of file"
                fix = "close the quoted string literal before the line break so --web-lint can audit the remaining code" if hit_newline else "close the quoted string literal so --web-lint can audit the remaining code"
                _add_unparsed(unp_ctx, text, str_start, why, fix)
            if cur_f["kind"] == "type_brace":
                cur_f["at_member_start"] = False
            can_regex, prev_was_dot, prev_tok = False, False, "literal"
            continue
        if ch == "`":
            end_t = _scan_template_literal_end(text, pos, ctx=ctx, open_tags=open_tags)
            if end_t < 0:
                return -1 if stop_at_close_brace else n
            if cur_f["kind"] == "type_brace":
                cur_f["at_member_start"] = False
            pos, can_regex, prev_was_dot, prev_tok = end_t, False, False, "literal"
            continue
        if ch == "/":
            end_r = _try_scan_regex_literal(text, pos) if can_regex else -1
            if end_r > 0:
                pos, can_regex, prev_was_dot, prev_tok = end_r, False, False, "literal"
            else:
                pos, can_regex, prev_was_dot, prev_tok = pos + 1, True, False, "/"
            continue
        if ch == "<" and cur_f["expect_type_brace"]:
            end_t = _scan_ts_type_args(text, pos, mask_out=mask_out)
            if end_t > 0:
                pos, can_regex, prev_was_dot, prev_tok = end_t, False, False, ">"
                continue
        in_type_pos, in_type_brace_member = current_type_context()
        if ch == "<" and (can_regex or prev_tok == "async" or in_type_brace_member):
            end_gen = _try_scan_ts_generic_params(text, pos, in_type_pos=in_type_pos, in_type_brace_member=in_type_brace_member, mask_out=mask_out)
            if end_gen > 0:
                if cur_f["kind"] == "type_brace":
                    cur_f["at_member_start"] = False
                pos, can_regex, prev_was_dot, prev_tok = end_gen, True, False, "generic"
                continue
            if can_regex and not in_type_pos:
                nxt = _scan_jsx_element(text, pos, ctx, False, open_tags)
                if nxt >= 0:
                    pos, can_regex, prev_was_dot, prev_tok = nxt, True, False, "jsx"
                    continue
        if ch == "{":
            brace_depth += 1
            if cur_f["expect_type_brace"]:
                cur_f["expect_type_brace"] = False
                new_k = "type_brace"
            elif cur_f["in_ret_type"]:
                if prev_tok in (":", "|", "&", "=>", "(", "[", ","):
                    new_k = "type_brace"
                else:
                    cur_f["in_ret_type"] = False
                    new_k = "expr_brace"
            else:
                new_k = "type_brace" if in_type_pos else "expr_brace"
            frames.append(_new_js_frame(new_k))
            pos, can_regex, prev_was_dot, prev_tok = pos + 1, True, False, "{"
            continue
        if ch == "}":
            if brace_depth == 0:
                if stop_at_close_brace:
                    return pos
            else:
                brace_depth -= 1
                while len(frames) > 1:
                    if frames.pop()["kind"] in ("expr_brace", "type_brace"):
                        break
            pos, can_regex, prev_was_dot, prev_tok = pos + 1, True, False, "}"
            continue
        if ch in "([":
            frames.append(_new_js_frame(("type_paren" if in_type_pos else "expr_paren") if ch == "(" else ("type_bracket" if in_type_pos else "expr_bracket")))
            pos, can_regex, prev_was_dot, prev_tok = pos + 1, True, False, ch
            continue
        if ch in ")]":
            targets = ("expr_paren", "type_paren") if ch == ")" else ("expr_bracket", "type_bracket")
            idx = len(frames) - 1
            while idx > 0 and frames[idx]["kind"] not in (*targets, "expr_brace", "type_brace"):
                idx -= 1
            if idx > 0 and frames[idx]["kind"] in targets:
                del frames[idx:]
            pos, can_regex, prev_was_dot, prev_tok = pos + 1, False, False, ch
            continue
        if ch == ".":
            pos, can_regex, prev_was_dot, prev_tok = pos + 1, False, True, "."
            continue
        wk, j = _scan_js_word(text, pos)
        if wk == "ident":
            ident = text[pos:j]
            if cur_f["kind"] == "type_brace":
                if ident not in ("readonly", "new") or not cur_f["at_member_start"]:
                    cur_f["at_member_start"] = False
            elif not prev_was_dot:
                in_stmt_scope = cur_f["kind"] in ("root", "expr_brace")
                if ident in ("type", "interface") and in_stmt_scope and prev_tok not in TS_DECL_BLOCK_PREV:
                    p_name = _skip_horiz_ws_and_inline_comments(text, j)
                    m_name = TS_GENERIC_IDENT_RE.match(text, p_name) if p_name > j else None
                    if m_name and ident == "interface":
                        cur_f["expect_type_brace"] = True
                        cur_f["in_type_alias"] = False
                        cur_f["var_decl_state"] = None
                    elif m_name:
                        p_after, unc_a = _skip_ws_and_js_comments(text, m_name.end())
                        if not unc_a and p_after < n and text[p_after] == "<":
                            end_ta = _scan_ts_type_args(text, p_after)
                            p_after, unc_a = _skip_ws_and_js_comments(text, end_ta) if end_ta > 0 else (n, True)
                        if not unc_a and p_after < n and text[p_after] == "=" and not text.startswith(("==", "=>"), p_after):
                            p_cur, _ = _skip_ws_and_js_comments(text, m_name.end(), mask_out=mask_out)
                            if p_cur < n and text[p_cur] == "<":
                                p_cur, _ = _skip_ws_and_js_comments(text, _scan_ts_type_args(text, p_cur, mask_out=mask_out), mask_out=mask_out)
                            clear_type_flags(cur_f)
                            cur_f["in_type_alias"] = True
                            cur_f["var_decl_state"] = None
                            pos, can_regex, prev_was_dot, prev_tok = p_cur + 1, True, False, "="
                            continue
                elif ident in ("const", "let", "var") and in_stmt_scope:
                    clear_type_flags(cur_f)
                    cur_f["var_decl_state"] = "binding"
                elif ident in ("case", "default") and in_stmt_scope:
                    cur_f["in_case"] = True
                elif ident in ("as", "satisfies") and prev_tok not in ("import", "export", "*", "{", ",", "const", "let", "var"):
                    cur_f["in_type_assert"] = True
            can_regex = (not prev_was_dot) and (ident in JS_REGEX_KEYWORDS)
            pos, prev_was_dot, prev_tok = j, False, ident
            continue
        if wk == "num":
            if cur_f["kind"] == "type_brace":
                cur_f["at_member_start"] = False
            pos, can_regex, prev_was_dot, prev_tok = j, False, False, "literal"
            continue
        three = text[pos:pos + 3]
        if three in ("===", "!=="):
            pos, can_regex, prev_was_dot, prev_tok = pos + 3, True, False, three
            continue
        two = text[pos:pos + 2]
        if two in ("++", "--"):
            pos, prev_was_dot, prev_tok = pos + 2, False, two
            continue
        if two in ("?.", "??", "&&", "||", "==", "!=", "<=", ">="):
            if two in ("??", "&&", "||"):
                cur_f["in_type_assert"] = False
            pos, can_regex, prev_was_dot, prev_tok = pos + 2, (two != "?."), (two == "?."), two
            continue
        if two == "=>":
            if cur_f["kind"] in ("root", "expr_brace") and prev_tok != "generic":
                cur_f["in_ret_type"] = False
            cur_f["in_type_assert"] = False
            pos, can_regex, prev_was_dot, prev_tok = pos + 2, True, False, "=>"
            continue
        if ch == "?":
            p_after_q, unc_q = _skip_ws_and_js_comments(text, pos + 1)
            if not unc_q and p_after_q < n and text[p_after_q] == ":":
                pos, can_regex, prev_was_dot, prev_tok = pos + 1, True, False, "opt_q"
            else:
                cur_f["ternary_depth"] += 1
                cur_f["in_type_assert"] = False
                pos, can_regex, prev_was_dot, prev_tok = pos + 1, True, False, "?"
            continue
        if ch == ":":
            if cur_f["kind"] == "type_brace":
                cur_f["at_member_start"] = False
            elif cur_f["ternary_depth"] > 0:
                cur_f["ternary_depth"] -= 1
                cur_f["in_type_assert"] = False
            elif cur_f["in_case"]:
                cur_f["in_case"] = cur_f["in_type_assert"] = False
            elif cur_f["kind"] == "expr_paren":
                if prev_tok not in ("", "(", ",", "=", ":", "?", "&&", "||", "??", "=>"):
                    cur_f["in_param_type"] = True
            elif cur_f["kind"] in ("root", "expr_brace"):
                if cur_f["var_decl_state"] == "binding":
                    cur_f["var_decl_state"] = "type_annot"
                elif prev_tok == ")":
                    cur_f["in_ret_type"] = True
        elif ch == "=":
            if cur_f["kind"] == "expr_paren":
                cur_f["in_param_type"] = False
            elif cur_f["var_decl_state"] in ("binding", "type_annot"):
                cur_f["var_decl_state"] = "init"
            cur_f["in_type_assert"] = False
        elif ch == ",":
            if cur_f["kind"] == "type_brace":
                cur_f["at_member_start"] = True
            elif cur_f["kind"] == "expr_paren":
                cur_f["in_param_type"] = False
            elif cur_f["var_decl_state"] == "init":
                cur_f["var_decl_state"] = "binding"
            cur_f["in_ret_type"] = cur_f["in_type_assert"] = False
        elif ch == ";":
            if cur_f["kind"] == "type_brace":
                cur_f["at_member_start"] = True
            else:
                clear_type_flags(cur_f, full=True)
        pos, can_regex, prev_was_dot, prev_tok = pos + 1, True, False, ch
    return -1 if stop_at_close_brace else n


def _scan_jsx_file(text):
    """Single-pass JS/TSX scanner returning (comment_masked_text, tags, unparsed, style_spans)."""
    ctx = {"mask": list(text), "tags": [], "unparsed": [], "styles": []}
    _scan_js_mode(text, 0, stop_at_close_brace=False, ctx=ctx)
    return "".join(ctx["mask"]), ctx["tags"], ctx["unparsed"], ctx["styles"]


def _scan_html_web_lint(text):
    """Single left-to-right HTML scanner consuming comments and <script>/<style>/<pre>/<code> while skipping quoted attribute values."""
    n = len(text)
    tag_header_chars = list(text)
    markup_chars = list(text)
    html_tag_chars = list(text)
    css_blocks = []
    pos = 0
    while pos < n:
        lt = text.find("<", pos)
        if lt < 0:
            break
        if text.startswith("<!--", lt):
            end_c = text.find("-->", lt + 4)
            end = n if end_c < 0 else end_c + 3
            _mask_range(tag_header_chars, lt, end)
            _mask_range(markup_chars, lt, end)
            _mask_range(html_tag_chars, lt, end)
            pos = end
            continue
        if lt + 1 >= n or not text[lt + 1].isalpha():
            pos = lt + 1
            continue
        m_tag = HTML_TAG_NAME_RE.match(text, lt + 1)
        if not m_tag:
            pos = lt + 1
            continue
        tag_name = m_tag.group(0).lower()
        cur = m_tag.end()
        if cur < n and text[cur] not in " \t\r\n/>":
            pos = lt + 1
            continue
        closed = False
        self_closing = False
        while cur < n:
            while cur < n and text[cur] in " \t\r\n":
                cur += 1
            if cur >= n:
                break
            if text[cur] == ">":
                closed = True
                cur += 1
                break
            if text[cur] == "/" and cur + 1 < n and text[cur + 1] == ">":
                closed = True
                self_closing = True
                cur += 2
                break
            if text[cur] == "<":
                break
            m_attr = HTML_ATTR_NAME_RE.match(text, cur)
            if not m_attr:
                cur += 1
                continue
            cur = m_attr.end()
            while cur < n and text[cur] in " \t\r\n":
                cur += 1
            if cur < n and text[cur] == "=":
                cur += 1
                while cur < n and text[cur] in " \t\r\n":
                    cur += 1
                if cur < n and text[cur] in ('"', "'"):
                    q = text[cur]
                    end_q = text.find(q, cur + 1)
                    if end_q < 0:
                        cur = n
                        break
                    cur = end_q + 1
                else:
                    while cur < n and text[cur] not in " \t\r\n>":
                        if text[cur] == "/" and cur + 1 < n and text[cur + 1] == ">":
                            break
                        cur += 1
        if not closed:
            pos = lt + 1
            continue
        after_gt = cur
        if tag_name in ("script", "style", "pre", "code"):
            if tag_name in ("pre", "code") and self_closing:
                pos = after_gt
                continue
            body_start = after_gt
            close_m = re.search(rf"</{tag_name}\s*>", text[body_start:], re.I)
            body_end = body_start + close_m.start() if close_m else n
            full_end = body_start + close_m.end() if close_m else n
            if tag_name == "script":
                _mask_range(tag_header_chars, body_start, body_end)
                _mask_range(markup_chars, lt, full_end)
                _mask_range(html_tag_chars, lt, full_end)
            elif tag_name == "style":
                css_blocks.append((body_start, text[body_start:body_end]))
                _mask_range(markup_chars, lt, full_end)
                _mask_range(html_tag_chars, lt, full_end)
            else:
                _mask_range(html_tag_chars, body_start, body_end)
            pos = full_end
        else:
            pos = after_gt
    return "".join(tag_header_chars), "".join(markup_chars), "".join(html_tag_chars), css_blocks


def _iter_html_opening_tags(html):
    """Yield (tag_name_lower, tag_start, attrs) for real HTML opening tags only (never prose)."""
    n = len(html)
    i = 0
    while i < n:
        lt = html.find("<", i)
        if lt < 0:
            break
        if lt + 1 >= n or not html[lt + 1].isalpha():
            i = lt + 1
            continue
        m_tag = HTML_TAG_NAME_RE.match(html, lt + 1)
        if not m_tag:
            i = lt + 1
            continue
        tag_name = m_tag.group(0).lower()
        pos = m_tag.end()
        if pos < n and html[pos] not in " \t\r\n/>":
            i = lt + 1
            continue
        attrs = []
        closed = False
        while pos < n:
            while pos < n and html[pos] in " \t\r\n":
                pos += 1
            if pos >= n:
                break
            if html[pos] == ">":
                closed = True
                pos += 1
                break
            if html[pos] == "/" and pos + 1 < n and html[pos + 1] == ">":
                closed = True
                pos += 2
                break
            if html[pos] == "<":
                break
            m_attr = HTML_ATTR_NAME_RE.match(html, pos)
            if not m_attr:
                pos += 1
                continue
            attr_name = m_attr.group(0).lower()
            attr_start = pos
            pos = m_attr.end()
            while pos < n and html[pos] in " \t\r\n":
                pos += 1
            if pos < n and html[pos] == "=":
                pos += 1
                while pos < n and html[pos] in " \t\r\n":
                    pos += 1
                if pos < n and html[pos] in ('"', "'"):
                    q = html[pos]
                    val_start = pos + 1
                    end_q = html.find(q, val_start)
                    if end_q < 0:
                        pos = n
                        break
                    attrs.append((attr_name, attr_start, html[val_start:end_q]))
                    pos = end_q + 1
                else:
                    val_start = pos
                    while pos < n and html[pos] not in " \t\r\n>":
                        if html[pos] == "/" and pos + 1 < n and html[pos + 1] == ">":
                            break
                        pos += 1
                    attrs.append((attr_name, attr_start, html[val_start:pos]))
            else:
                attrs.append((attr_name, attr_start, None))
        if closed:
            yield tag_name, lt, attrs
            i = pos
        else:
            i = lt + 1


def _edit_distance(a, b):
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def _closest_match(name, candidates, max_dist=3):
    best = None
    best_d = max_dist + 1
    nl = name.lower()
    for c in sorted(candidates):
        d = _edit_distance(nl, c.lower())
        if d < best_d:
            best_d = d
            best = c
    return best


def _line_of(text, offset):
    return text.count("\n", 0, offset) + 1


def _extract_balanced_call(s, fn_name):
    """If s is 'fn_name(...)' with balanced parens spanning the full string, return inner text, else None."""
    prefix = fn_name + "("
    if not s.startswith(prefix) or not s.endswith(")"):
        return None
    depth = 0
    for idx in range(len(fn_name), len(s)):
        ch = s[idx]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return s[len(prefix):idx] if idx == len(s) - 1 else None
            if depth < 0:
                return None
    return None


def _parse_css_px(val):
    """Parse font-size px/rem/clamp/min/max into finite positive px (assuming 16px root) or None."""
    if not isinstance(val, str):
        return None
    s = re.sub(r"\s*!important\s*$", "", val, flags=re.I).strip().lower()
    inner_clamp = _extract_balanced_call(s, "clamp")
    if inner_clamp is not None:
        args = _split_top_level(inner_clamp, ",")
        if len(args) == 3:
            return _parse_css_px(args[2])
        return None
    inner_max = _extract_balanced_call(s, "max")
    if inner_max is not None:
        vals = [v for v in (_parse_css_px(a) for a in _split_top_level(inner_max, ",")) if v is not None]
        return max(vals) if vals else None
    inner_min = _extract_balanced_call(s, "min")
    if inner_min is not None:
        vals = [v for v in (_parse_css_px(a) for a in _split_top_level(inner_min, ",")) if v is not None]
        return min(vals) if vals else None
    m_px = re.match(r"([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)px\b", s)
    if m_px:
        try:
            px_v = float(m_px.group(1))
        except ValueError:
            return None
        return px_v if (math.isfinite(px_v) and px_v > 0) else None
    m_rem = re.match(r"([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)rem\b", s)
    if m_rem:
        try:
            px_v = float(m_rem.group(1)) * 16.0
        except ValueError:
            return None
        return px_v if (math.isfinite(px_v) and px_v > 0) else None
    return None


def _split_top_level(text, sep):
    """Split text on single-char sep outside quotes, template literals, and (), [], {}."""
    parts = []
    cur = []
    n = len(text)
    i = 0
    depth = 0
    while i < n:
        ch = text[i]
        if ch in ("'", '"'):
            q = ch
            cur.append(ch)
            i += 1
            while i < n:
                cur.append(text[i])
                if text[i] == "\\" and i + 1 < n:
                    i += 1
                    cur.append(text[i])
                    i += 1
                    continue
                if text[i] == q:
                    i += 1
                    break
                i += 1
            continue
        if ch == "`":
            end_t = _scan_template_literal_end(text, i)
            if end_t < 0:
                cur.append(text[i:])
                break
            cur.append(text[i:end_t])
            i = end_t
            continue
        if ch in "([{":
            depth += 1
            cur.append(ch)
        elif ch in ")]}":
            if depth > 0:
                depth -= 1
            cur.append(ch)
        elif ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    parts.append("".join(cur))
    return parts


def _iter_declarations_with_offsets(css):
    """Yield (sel_stack_tuple, prop, val, decl_offset) for declarations at any CSS nesting depth."""
    sel_stack = []
    buf = []
    buf_start = None
    in_sq = in_dq = False
    i, n = 0, len(css)
    while i < n:
        ch = css[i]
        if ch == "\\" and (in_sq or in_dq) and i + 1 < n:
            if buf_start is None:
                buf_start = i
            buf.append(ch)
            buf.append(css[i + 1])
            i += 2
            continue
        if ch == "'" and not in_dq:
            in_sq = not in_sq
            if buf_start is None:
                buf_start = i
            buf.append(ch)
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
            if buf_start is None:
                buf_start = i
            buf.append(ch)
        elif not in_sq and not in_dq and ch == "{":
            sel = "".join(buf).strip()
            sel_stack.append(sel)
            buf = []
            buf_start = None
        elif not in_sq and not in_dq and ch in (";", "}"):
            seg = "".join(buf).strip()
            decl_off = buf_start if buf_start is not None else i
            buf = []
            buf_start = None
            if sel_stack and ":" in seg and not seg.startswith("@"):
                prop, val = seg.split(":", 1)
                prop = prop.strip().lower()
                if prop and re.fullmatch(r"(?:--[a-z0-9_-]+|[a-z-]+)", prop):
                    yield tuple(sel_stack), prop, val.strip(), decl_off
            if ch == "}" and sel_stack:
                sel_stack.pop()
        else:
            if buf_start is None and not ch.isspace():
                buf_start = i
            buf.append(ch)
        i += 1


def _selector_targets_tag(sel_part, tags):
    """True iff the rightmost compound selector targets one of the given HTML element tags (not a pseudo-element)."""
    s = sel_part.strip().lower()
    if not s:
        return False
    depth = 0
    last_sep = -1
    for idx, ch in enumerate(s):
        if ch in "([":
            depth += 1
        elif ch in ")]" and depth > 0:
            depth -= 1
        elif depth == 0 and ch in " \t\r\n>+~":
            last_sep = idx
    compound = s[last_sep + 1:]
    if not compound or "::" in compound:
        return False
    m = re.match(r"^([a-z][a-z0-9]*)(?:$|[\.#:\[])", compound)
    return bool(m and m.group(1) in tags)


def _bare_html_body_tag(sel_part):
    """Return 'body' or 'html' iff sel_part is a bare top-level html/body selector (no combinators or ::)."""
    s = sel_part.strip().lower()
    if not s or "::" in s:
        return None
    depth = 0
    for ch in s:
        if ch in "([":
            depth += 1
        elif ch in ")]" and depth > 0:
            depth -= 1
        elif depth == 0 and ch in " \t\r\n>+~":
            return None
    m = re.match(r"^(html|body)(?:$|[\.#:\[])", s)
    return m.group(1) if m else None


def _is_non_none_motion_val(val):
    cleaned = re.sub(r"\s*!important\s*$", "", val, flags=re.I).strip().lower()
    if not cleaned:
        return False
    items = [p.strip() for p in _split_top_level(cleaned, ",") if p.strip()]
    return any(item != "none" for item in items)


def _has_dynamic_template_literal(expr):
    """True iff expr contains any template literal with ${...} interpolation."""
    n, i, can_regex, prev_was_dot = len(expr), 0, True, False
    while i < n:
        ch = expr[i]
        if ch in " \t\r\n":
            i += 1
            continue
        kind, nxt = _skip_js_atom(expr, i, can_regex=can_regex, strict_str=False, allow_tpl=False)
        if kind is not None:
            i = nxt
            if kind == "literal":
                can_regex, prev_was_dot = False, False
            continue
        if ch == "`":
            j = i + 1
            while j < n:
                c = expr[j]
                if c == "\\" and j + 1 < n:
                    j += 2
                    continue
                if c == "$" and j + 1 < n and expr[j + 1] == "{":
                    return True
                if c == "`":
                    j += 1
                    break
                j += 1
            i, can_regex, prev_was_dot = j, False, False
            continue
        if ch in (")", "]"):
            i, can_regex, prev_was_dot = i + 1, False, False
        elif ch == ".":
            i, can_regex, prev_was_dot = i + 1, False, True
        else:
            wk, j = _scan_js_word(expr, i)
            if wk == "ident":
                can_regex = (not prev_was_dot) and (expr[i:j] in JS_REGEX_KEYWORDS)
                i, prev_was_dot = j, False
            elif wk == "num":
                i, can_regex, prev_was_dot = j, False, False
            else:
                i, can_regex, prev_was_dot = i + 1, True, False
    return False


def _check_js_expr_balanced(s):
    """True iff strings, templates, regexes, block comments, and (), [], {} are syntactically balanced in s."""
    n, i, stack, can_regex, prev_was_dot = len(s), 0, [], True, False
    pairs = {"(": ")", "[": "]", "{": "}"}
    while i < n:
        ch = s[i]
        if ch in " \t\r\n":
            i += 1
            continue
        kind, nxt = _skip_js_atom(s, i, can_regex=can_regex)
        if kind == "err":
            return False
        if kind is not None:
            i = nxt
            if kind == "literal":
                can_regex, prev_was_dot = False, False
            continue
        if ch in pairs:
            stack.append(pairs[ch])
            i, can_regex, prev_was_dot = i + 1, True, False
        elif ch in (")", "]", "}"):
            if not stack or stack[-1] != ch:
                return False
            stack.pop()
            i, can_regex, prev_was_dot = i + 1, (ch == "}"), False
        elif ch == ".":
            i, can_regex, prev_was_dot = i + 1, False, True
        else:
            wk, j = _scan_js_word(s, i)
            if wk == "ident":
                can_regex = (not prev_was_dot) and (s[i:j] in JS_REGEX_KEYWORDS)
                i, prev_was_dot = j, False
            elif wk == "num":
                i, can_regex, prev_was_dot = j, False, False
            else:
                i, can_regex, prev_was_dot = i + 1, True, False
    return not stack


def _strip_js_outer_comments_and_parens(s):
    """Trim whitespace, outer JS comments, and redundant outer balanced parentheses."""
    while True:
        s, changed = s.strip(), False
        while s.startswith("/*"):
            end_c = s.find("*/", 2)
            if end_c < 0:
                break
            s, changed = s[end_c + 2:].strip(), True
        while s.startswith("//"):
            nl = s.find("\n", 2)
            s, changed = ("" if nl < 0 else s[nl + 1:].strip()), True
        while s.endswith("*/"):
            start_c = s.rfind("/*")
            if start_c < 0 or not _check_js_expr_balanced(s[:start_c]):
                break
            s, changed = s[:start_c].strip(), True
        if s.startswith("(") and s.endswith(")") and _scan_balanced_parens(s, 0) == len(s) - 1:
            s, changed = s[1:-1].strip(), True
        if not changed:
            return s


def _iter_js_top_level(s):
    """Yield (index, token_str) at paren/bracket/brace depth 0, skipping strings, templates, regexes, and comments."""
    n, i, depth, can_regex, prev_was_dot = len(s), 0, 0, True, False
    while i < n:
        ch = s[i]
        if ch in " \t\r\n":
            i += 1
            continue
        kind, nxt = _skip_js_atom(s, i, can_regex=can_regex, strict_str=False)
        if kind is not None:
            i = nxt
            if kind == "literal":
                can_regex, prev_was_dot = False, False
            continue
        if ch in "([{":
            if depth == 0:
                yield i, ch
            depth += 1
            i, can_regex, prev_was_dot = i + 1, True, False
        elif ch in ")]}":
            if depth > 0:
                depth -= 1
            if depth == 0:
                yield i, ch
            i, can_regex, prev_was_dot = i + 1, (ch == "}"), False
        elif ch == ".":
            if depth == 0:
                yield i, "."
            i, can_regex, prev_was_dot = i + 1, False, True
        else:
            wk, j = _scan_js_word(s, i)
            if wk is not None:
                tok = s[i:j]
                if depth == 0:
                    yield i, tok
                can_regex = (wk == "ident") and (not prev_was_dot) and (tok in JS_REGEX_KEYWORDS)
                i, prev_was_dot = j, False
            elif s[i:i + 2] in ("?.", "??", "||", "&&", "=>", "++", "--", "==", "!=", "<=", ">="):
                two = s[i:i + 2]
                if depth == 0:
                    yield i, two
                i, can_regex, prev_was_dot = i + 2, (two not in ("++", "--")), False
            else:
                if depth == 0:
                    yield i, ch
                i, can_regex, prev_was_dot = i + 1, True, False


def _split_top_level_ternary(s):
    """If s has a top-level ternary 'cond ? then : else', return (cond, then_expr, else_expr), else None."""
    q_idx, t_depth = -1, 0
    for idx, tok in _iter_js_top_level(s):
        if tok == "?":
            if q_idx < 0:
                q_idx = idx
            else:
                t_depth += 1
        elif tok == ":" and q_idx >= 0:
            if t_depth == 0:
                return s[:q_idx], s[q_idx + 1:idx], s[idx + 1:]
            t_depth -= 1
    return None


def _split_top_level_tokens(s, target_toks):
    """Split s on any top-level token in target_toks; returns list of segments."""
    cuts = [(idx, len(tok)) for idx, tok in _iter_js_top_level(s) if tok in target_toks]
    if not cuts:
        return [s]
    parts, start = [], 0
    for idx, tlen in cuts:
        parts.append(s[start:idx])
        start = idx + tlen
    parts.append(s[start:])
    return parts


def _parse_js_string_literal(s):
    """If s is a single complete JS '...' or \"...\" string literal, return unescaped value, else None."""
    if len(s) < 2 or s[0] not in ("'", '"') or s[-1] != s[0]:
        return None
    q, i, n, chars = s[0], 1, len(s), []
    while i < n:
        if s[i] == "\\" and i + 1 < n:
            chars.append(s[i + 1])
            i += 2
            continue
        if s[i] == q:
            return "".join(chars) if i == n - 1 else None
        chars.append(s[i])
        i += 1
    return None


def _strip_ts_class_wrappers(node):
    """Strip outer comments, balanced parens, trailing non-null '!', and top-level trailing 'as'/'satisfies'."""
    s = node
    while True:
        s = _strip_js_outer_comments_and_parens(s)
        if not s:
            return s
        toks = list(_iter_js_top_level(s))
        if not any(tok in ("?", "||", "??", "&&", "+") for _, tok in toks):
            if s.endswith("!") and not s.endswith("!=") and len(s) > 1:
                s = s[:-1].strip()
                continue
            changed = False
            for idx_pos, (ch_idx, tok) in enumerate(toks):
                if tok in ("as", "satisfies") and idx_pos > 0 and toks[idx_pos - 1][1] not in (".", "?."):
                    tail = s[ch_idx + len(tok):].strip()
                    if tail and not _has_top_level_expr_op(tail):
                        s, changed = s[:ch_idx].strip(), True
                        break
            if changed:
                continue
        return s


def _is_static_lookup_expr(s):
    """True iff s is an identifier/member-chain bracket lookup like TONE_MAP[tone] or cfg.tones?.[k]."""
    m = TS_GENERIC_IDENT_RE.match(s, 0)
    if not m:
        return False
    n, pos, saw_bracket = len(s), m.end(), False
    while pos < n:
        while pos < n and s[pos] in " \t\r\n":
            pos += 1
        if pos >= n:
            break
        opt = s.startswith("?.", pos)
        if opt or s[pos] == ".":
            pos += 2 if opt else 1
            while pos < n and s[pos] in " \t\r\n":
                pos += 1
            if not (opt and pos < n and s[pos] == "["):
                m2 = TS_GENERIC_IDENT_RE.match(s, pos)
                if not m2:
                    return False
                pos = m2.end()
                continue
        if s[pos] == "[":
            end_b = _scan_balanced_delim(s, pos, "[", "]")
            if end_b < 0:
                return False
            saw_bracket, pos = True, end_b + 1
            continue
        return False
    return saw_bracket


def _extract_jsx_class_strings(expr):
    """Return (static_strings, malformed_bool, unsupported_dynamic_bool, has_dyn_tpl_bool) from a JSX className={...} expression."""
    raw = expr.strip()
    if not raw or not _check_js_expr_balanced(raw):
        return [], True, False, False

    out, state = [], {"unsupported": False, "dyn_tpl": False}

    def add_static_or_tpl(tok):
        sv = _parse_js_string_literal(tok)
        if sv is not None:
            out.append(sv)
            return True
        if tok.startswith("`") and _scan_template_literal_end(tok, 0) == len(tok):
            if _has_dynamic_template_literal(tok):
                state["dyn_tpl"] = True
            else:
                out.append(tok[1:-1])
            return True
        return False

    def walk_class_expr(node):
        s = _strip_ts_class_wrappers(node)
        if not s:
            return
        tern = _split_top_level_ternary(s)
        if tern is not None:
            walk_class_expr(tern[1])
            walk_class_expr(tern[2])
            return
        or_parts = _split_top_level_tokens(s, ("||", "??"))
        if len(or_parts) > 1:
            for part in or_parts:
                walk_class_expr(part)
            return
        and_parts = _split_top_level_tokens(s, ("&&",))
        if len(and_parts) > 1:
            walk_class_expr(and_parts[-1])
            return
        plus_parts = [p.strip() for p in _split_top_level_tokens(s, ("+",)) if p.strip()]
        if len(plus_parts) > 1:
            state["unsupported"] = True
            for part in plus_parts:
                walk_class_expr(part)
            return
        if add_static_or_tpl(s):
            return
        if s.startswith("[") and s.endswith("]") and _scan_balanced_delim(s, 0, "[", "]") == len(s) - 1:
            for elem in _split_top_level_tokens(s[1:-1], (",",)):
                if elem.strip():
                    walk_class_expr(elem)
            return
        if s.startswith("{") and s.endswith("}") and _scan_balanced_braces(s, 0) == len(s) - 1:
            for entry in _split_top_level_tokens(s[1:-1], (",",)):
                es = _strip_js_outer_comments_and_parens(entry)
                if not es:
                    continue
                if es.startswith("..."):
                    state["unsupported"] = True
                    continue
                kv = _split_top_level_tokens(es, (":",))
                if len(kv) >= 2:
                    k_raw = _strip_js_outer_comments_and_parens(kv[0])
                    if k_raw.startswith("[") and k_raw.endswith("]") and _scan_balanced_delim(k_raw, 0, "[", "]") == len(k_raw) - 1:
                        walk_class_expr(k_raw[1:-1])
                    elif not add_static_or_tpl(k_raw):
                        if TS_GENERIC_IDENT_RE.fullmatch(k_raw):
                            out.append(k_raw)
                        else:
                            state["unsupported"] = True
                elif TS_GENERIC_IDENT_RE.fullmatch(es):
                    out.append(es)
                else:
                    state["unsupported"] = True
            return
        if s.endswith(")"):
            open_paren = -1
            for idx, tok in _iter_js_top_level(s):
                if tok == "(":
                    open_paren = idx
            if open_paren > 0 and _scan_balanced_parens(s, open_paren) == len(s) - 1:
                callee, args_str = s[:open_paren].strip(), s[open_paren + 1:-1]
                method_name = callee.rsplit(".", 1)[-1].strip() if "." in callee else callee
                if method_name == "join" and "." in callee:
                    walk_class_expr(callee.rsplit(".", 1)[0].strip())
                    return
                if method_name in KNOWN_CLASS_HELPERS:
                    for arg in _split_top_level_tokens(args_str, (",",)):
                        if arg.strip():
                            walk_class_expr(arg)
                    return
                state["unsupported"] = True
                return
        if s not in ("undefined", "null", "false") and not _is_static_lookup_expr(s):
            state["unsupported"] = True

    walk_class_expr(raw)
    return out, False, state["unsupported"], state["dyn_tpl"]


def _has_top_level_expr_op(tail):
    """True iff tail contains top-level ?, comma, semicolon, &&, ||, or ?? outside (), [], {}, <>."""
    n, i, depth = len(tail), 0, 0
    while i < n:
        kind, nxt = _skip_js_atom(tail, i)
        if kind == "err":
            return True
        if kind is not None:
            i = nxt
            continue
        if tail.startswith("=>", i):
            i += 2
            continue
        ch = tail[i]
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>" and depth > 0:
            depth -= 1
        elif depth == 0 and (ch in ("?", ",", ";") or tail[i:i + 2] in ("&&", "||", "??")):
            return True
        i += 1
    return False


def _unwrap_ts_style_expr(expr):
    """Strip outer balanced (...) and trailing TypeScript 'as ...' / 'satisfies ...' assertions."""
    s = expr.strip()
    while s:
        if s.startswith("("):
            close_idx = _scan_balanced_parens(s, 0)
            if close_idx == len(s) - 1:
                s = s[1:-1].strip()
                continue
            if close_idx > 0:
                tail = s[close_idx + 1:].strip()
                if re.match(r"^(?:as|satisfies)\b", tail) and not _has_top_level_expr_op(tail):
                    s = s[:close_idx + 1].strip()
                    continue
        if s.startswith("{"):
            end_b = _scan_balanced_braces(s, 0)
            if 0 <= end_b < len(s) - 1:
                tail = s[end_b + 1:].strip()
                if re.match(r"^(?:as|satisfies)\b", tail) and not _has_top_level_expr_op(tail):
                    s = s[:end_b + 1].strip()
                    continue
        break
    return s


def _is_custom_prop_only_style(style_str, is_jsx=False):
    """True iff inline style only assigns valid --custom-properties (no raw layout/color bypass)."""
    s = style_str.strip()
    if not s:
        return True
    if is_jsx:
        parts = [p.strip() for p in _split_top_level(s, ",") if p.strip()]
        if not parts:
            return False
        for p in parts:
            if p.startswith("..."):
                return False
            kv = _split_top_level(p, ":")
            if len(kv) < 2 or not kv[1].strip():
                return False
            raw_k = kv[0].strip()
            if len(raw_k) >= 2 and raw_k[0] in ("'", '"') and raw_k[-1] == raw_k[0]:
                k = raw_k[1:-1]
            else:
                k = raw_k
            if not CUSTOM_PROP_KEY_RE.fullmatch(k):
                return False
        return True
    parts = [p.strip() for p in _split_top_level(s, ";") if p.strip()]
    if not parts:
        return False
    for p in parts:
        kv = _split_top_level(p, ":")
        if len(kv) < 2 or not kv[1].strip():
            return False
        k = kv[0].strip()
        if not CUSTOM_PROP_KEY_RE.fullmatch(k):
            return False
    return True


def check_web_lint(target, fidelity=False):
    if not os.path.exists(target):
        return {"ok": False, "findings": [], "checks": [_chk("web_lint_path_exists", False, target, "existing file or directory", "target path does not exist")]}
    files = []
    if os.path.isfile(target):
        if os.path.splitext(target)[1].lower() in WEB_LINT_EXTS:
            files.append((target, os.path.basename(target)))
    elif os.path.isdir(target):
        for root_d, dirs, names in os.walk(target):
            dirs[:] = [
                d for d in sorted(dirs)
                if d not in SKIP_DIRS and not os.path.islink(os.path.join(root_d, d))
            ]
            for name in sorted(names):
                p = os.path.join(root_d, name)
                if os.path.islink(p):
                    continue
                if os.path.splitext(name)[1].lower() in WEB_LINT_EXTS:
                    files.append((p, os.path.relpath(p, target)))
    if not files:
        return {"ok": False, "findings": [], "checks": [_chk("web_lint_files_scanned", False, 0, ">= 1 web file", f"no HTML/CSS/JSX/TSX files found under {target}")]}

    # Pass 1: gather declared :root/@theme tokens, declared CSS classes, and Tailwind presence across all scanned files
    declared_tokens = set()
    declared_classes = set()
    file_texts = []
    all_css_chunks = []
    all_markup_chunks = []
    has_tailwind = False
    for path, rel in files:
        try:
            text = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError) as exc:
            return {"ok": False, "findings": [], "checks": [_chk("web_lint_readable", False, str(exc), "UTF-8 text file", f"could not read {rel}")]}
        ext = os.path.splitext(path)[1].lower()
        is_jsx = ext in (".jsx", ".tsx")
        if ext == ".css":
            scan_text = text
            markup_no_style = text
            html_tag_text = text
            css_parts = [(0, scan_text)]
            jsx_parsed = None
        elif is_jsx:
            scan_text, jsx_tags, jsx_unparsed, jsx_style_spans = _scan_jsx_file(text)
            markup_chars = list(scan_text)
            css_parts = []
            for st_start, body_start, body_end, st_end in jsx_style_spans:
                _mask_range(markup_chars, st_start, st_end)
                body_raw = scan_text[body_start:body_end]
                b_strip = body_raw.strip()
                if b_strip.startswith("{") and b_strip.endswith("}"):
                    inner = b_strip[1:-1].strip()
                    if len(inner) >= 2 and inner[0] in ("`", "'", '"') and inner[-1] == inner[0]:
                        inner_pos = scan_text.find(inner[1:-1], body_start, body_end)
                        css_parts.append((inner_pos if inner_pos >= 0 else body_start, inner[1:-1]))
                    else:
                        css_parts.append((body_start, body_raw))
                else:
                    css_parts.append((body_start, body_raw))
            markup_no_style = "".join(markup_chars)
            html_tag_text = markup_no_style
            jsx_parsed = (jsx_tags, jsx_unparsed)
        else:
            scan_text, markup_no_style, html_tag_text, css_parts = _scan_html_web_lint(text)
            if TAILWIND_TAG_RE.search(scan_text):
                has_tailwind = True
            jsx_parsed = None
        file_texts.append((rel, ext, scan_text, markup_no_style, html_tag_text, css_parts, jsx_parsed))
        if ext != ".css":
            all_markup_chunks.append(markup_no_style)
        for _, css_raw in css_parts:
            css_clean = CSS_COMMENT_RE.sub(_mask_newlines_only, css_raw)
            if TAILWIND_CSS_RE.search(css_clean):
                has_tailwind = True
            all_css_chunks.append(css_clean)
            for sel_stack, prop, _, _ in _iter_declarations_with_offsets(css_clean):
                if prop.startswith("--") and (_is_root_theme_stack(sel_stack) or any(s.strip().lower().startswith("@theme") for s in sel_stack)):
                    declared_tokens.add(prop)
                for frame in sel_stack:
                    if not frame.strip().startswith("@"):
                        for cm in re.finditer(r"\.([A-Za-z_][A-Za-z0-9_-]*)", frame):
                            declared_classes.add(cm.group(1))

    has_css = bool(all_css_chunks)
    token_hint = ", ".join(f"var({t})" for t in sorted(declared_tokens)[:8]) if declared_tokens else "declared :root tokens (e.g. var(--bg), var(--ink), var(--accent))"
    findings = []

    def add_finding(rule, rel, line, what, why, fix):
        findings.append({"rule": rule, "file": rel, "line": line, "what": what, "why": why, "fix": fix})

    # Pass 2: run prescriptive HTML/CSS/JSX/TSX design-system and micro-craft checks
    has_h1_px = None
    body_px = None
    html_px = None
    fallback_p_px = None
    has_media_or_fluid = False
    has_focus_visible = False
    has_reduced_motion = False
    has_motion = False
    has_interactive = False
    first_interactive_loc = None
    first_motion_loc = None

    def audit_class_tokens(rel, line_no, cls_val, is_jsx_file):
        for tok in cls_val.split():
            norm = _normalize_tw_token(tok)
            if TW_RAW_PALETTE_RE.match(norm) or TW_ARB_COLOR_RE.match(norm):
                add_finding(
                    "no-raw-colors",
                    rel,
                    line_no,
                    f'class "{tok}"',
                    "raw palette/arbitrary colors drift from the design system",
                    f"replace with a semantic token class or {token_hint}",
                )
            elif TW_ARB_VAL_RE.match(norm):
                add_finding(
                    "no-arbitrary-values",
                    rel,
                    line_no,
                    f'class "{tok}"',
                    "arbitrary bracket values break the spacing, type, and radius scale",
                    "snap to the nearest declared spacing/type/radius scale step or define a named token in :root/@theme",
                )
            elif norm in ("h-screen", "min-h-screen"):
                add_finding(
                    "micro-craft",
                    rel,
                    line_no,
                    f'class "{tok}"',
                    "100vh/h-screen clips under mobile browser toolbars",
                    f'replace "{tok}" with "{tok.replace("screen", "dvh")}"',
                )
            elif has_css and not is_jsx_file and not has_tailwind and tok not in declared_classes:
                near = _closest_match(tok, declared_classes) if declared_classes else None
                fix_msg = (
                    f'did you mean ".{near}"? Otherwise declare ".{tok}" in your stylesheet'
                    if near
                    else f'declare ".{tok}" in your stylesheet or remove the unused class'
                )
                add_finding(
                    "no-unknown-classes",
                    rel,
                    line_no,
                    f'class "{tok}"',
                    "undeclared class name has no matching style rule",
                    fix_msg,
                )

    for rel, ext, scan_text, markup_no_style, html_tag_text, css_blocks, jsx_parsed in file_texts:
        is_jsx = ext in (".jsx", ".tsx")

        if is_jsx:
            if "focus-visible:" in markup_no_style:
                has_focus_visible = True
            jsx_tags, jsx_unparsed = jsx_parsed
            for err_off, err_what, err_why, err_fix in jsx_unparsed:
                add_finding("web-lint-unparsed", rel, _line_of(scan_text, err_off), err_what, err_why, err_fix)
            for tag_name, tag_start, attrs in jsx_tags:
                is_component = bool(tag_name and tag_name[0].isupper())
                tag_line = _line_of(scan_text, tag_start)
                if tag_name in JSX_RAW_INTERACTIVE_TAGS or (tag_name == "a" and any(a[0] == "href" for a in attrs)):
                    has_interactive = True
                    if first_interactive_loc is None:
                        first_interactive_loc = (rel, tag_line, True)
                for attr_name, attr_start, attr_kind, attr_val in attrs:
                    attr_line = _line_of(scan_text, attr_start)
                    if attr_name in ("className", "class"):
                        cls_strings = []
                        if attr_kind == "string":
                            cls_strings.append(attr_val)
                        elif attr_kind == "expr":
                            extracted, cls_malformed, cls_unsupported, has_dyn_tpl = _extract_jsx_class_strings(attr_val)
                            if has_dyn_tpl:
                                raw_snip = f"className={{{attr_val.strip()}}}"
                                add_finding(
                                    "require-static-classes",
                                    rel,
                                    attr_line,
                                    raw_snip[:60],
                                    "dynamic template-string class names break static scanning and Tailwind extraction",
                                    f"replace {raw_snip[:50]} with a static Record<string, string> lookup map above the component (no template literal)",
                                )
                            cls_strings.extend(extracted)
                            if cls_malformed or (cls_unsupported and not has_dyn_tpl):
                                raw_snip = f"className={{{attr_val.strip()}}}"
                                add_finding(
                                    "web-lint-unparsed",
                                    rel,
                                    attr_line,
                                    raw_snip[:60],
                                    "unsupported or malformed dynamic className expression cannot be statically audited",
                                    "use static strings, a static Record<string, string> lookup, or cn()/clsx() with static string/array arguments",
                                )
                        for cls_s in cls_strings:
                            if is_component:
                                for tok in cls_s.split():
                                    norm = _normalize_tw_token(tok)
                                    if (norm in TW_BARE_RESTYLE_UTILS or TW_RESTYLE_PREFIX_RE.match(norm)) and not TW_LAYOUT_PREFIX_RE.match(norm):
                                        add_finding(
                                            "no-restyle",
                                            rel,
                                            tag_line,
                                            f'<{tag_name} className="...{tok}...">',
                                            f"<{tag_name}> owns its internal appearance and spacing",
                                            f'DELETE "{tok}" from <{tag_name} className=...> (omit className if no layout classes remain) and use a declared variant/size prop on <{tag_name}> instead',
                                        )
                            audit_class_tokens(rel, attr_line, cls_s, True)
                    elif attr_name == "style":
                        if attr_kind == "string":
                            if not _is_custom_prop_only_style(attr_val, is_jsx=False):
                                add_finding(
                                    "no-inline-styles",
                                    rel,
                                    attr_line,
                                    f'style="{attr_val.strip()[:50]}"',
                                    "inline styles bypass design tokens and component contracts",
                                    f'DELETE style="{attr_val.strip()[:50]}" from the HTML tag and move it into a CSS class in <style> using {token_hint} (keep inline style ONLY for --custom-properties)',
                                )
                        elif attr_kind == "expr":
                            st_unwrapped = _unwrap_ts_style_expr(attr_val)
                            if st_unwrapped.startswith("{") and _scan_balanced_braces(st_unwrapped, 0) == len(st_unwrapped) - 1:
                                inner_obj = st_unwrapped[1:-1]
                                if not _is_custom_prop_only_style(inner_obj, is_jsx=True):
                                    add_finding(
                                        "no-inline-styles",
                                        rel,
                                        attr_line,
                                        f"style={{{{{inner_obj.strip()[:45]}}}}}",
                                        "inline style objects bypass design tokens and component contracts",
                                        f"DELETE style={{{{{inner_obj.strip()[:45]}}}}} from the JSX element and move static styles to classes or component variants (keep style={{{{ '--var': val }}}} ONLY for dynamic CSS variables)",
                                    )
                            else:
                                raw_st = attr_val.strip()[:50]
                                add_finding(
                                    "no-inline-styles",
                                    rel,
                                    attr_line,
                                    f"style={{{raw_st}}}",
                                    "dynamic or non-literal inline style props bypass design tokens and cannot be verified as custom-property-only",
                                    f"DELETE style={{{raw_st}}} from the JSX element and use static classes or component variants (keep style={{{{ '--var': val }}}} ONLY for literal --custom-property objects)",
                                )
        elif ext != ".css":
            # HTML (.html, .htm): <pre>/<code> bodies already masked in single left-to-right scan
            for tag_name, tag_start, attrs in _iter_html_opening_tags(html_tag_text):
                if tag_name in HTML_INTERACTIVE_TAGS or (tag_name == "a" and any(a[0] == "href" for a in attrs)):
                    has_interactive = True
                    if first_interactive_loc is None:
                        first_interactive_loc = (rel, _line_of(scan_text, tag_start), False)
                for attr_name, attr_start, attr_val in attrs:
                    if attr_val is None:
                        continue
                    if attr_name == "class":
                        if "focus-visible:" in attr_val:
                            has_focus_visible = True
                        audit_class_tokens(rel, _line_of(scan_text, attr_start), attr_val, False)
                    elif attr_name == "style":
                        if not _is_custom_prop_only_style(attr_val, is_jsx=False):
                            add_finding(
                                "no-inline-styles",
                                rel,
                                _line_of(scan_text, attr_start),
                                f'style="{attr_val.strip()[:50]}"',
                                "inline styles bypass design tokens and component contracts",
                                f'DELETE style="{attr_val.strip()[:50]}" from the HTML tag and move it into a CSS class in <style> using {token_hint} (keep inline style ONLY for --custom-properties)',
                            )

        # Per-file markup slop checks (with exact file and line)
        if ext != ".css":
            for sm in SLOP_COPY_RE.finditer(markup_no_style):
                add_finding(
                    "no-slop-patterns",
                    rel,
                    _line_of(scan_text, sm.start()),
                    f"filler slop copy: {sm.group(0)}",
                    "generic placeholder/hype copy",
                    "replace with concrete product facts from the brief",
                )
            for idx, ch in enumerate(markup_no_style):
                cp = ord(ch)
                if (0x1F300 <= cp <= 0x1FAFF) or cp in EMOJI_EXTRA_CPS:
                    add_finding(
                        "no-slop-patterns",
                        rel,
                        _line_of(scan_text, idx),
                        "emoji used as UI icon",
                        "emoji icons look inconsistent and generic",
                        "use crisp monochrome SVG icons or typographic glyphs",
                    )
                    break

        # CSS checks (no-raw-colors, no-transition-all, safe-overflow, micro-craft scale(0)/ease-in, slop gradients)
        for base_off, css_raw in css_blocks:
            css_clean = CSS_COMMENT_RE.sub(_mask_newlines_only, css_raw)
            if RESPONSIVE_MEDIA_RE.search(css_clean) or "clamp(" in css_clean or "minmax(" in css_clean:
                has_media_or_fluid = True
            if ":focus-visible" in css_clean:
                has_focus_visible = True
            for vw_m in VW_100_RE.finditer(css_clean):
                add_finding(
                    "safe-overflow",
                    rel,
                    _line_of(scan_text, base_off + vw_m.start()),
                    "width: 100vw",
                    "100vw causes horizontal scrollbar overflow on desktop and mobile",
                    "replace 100vw with 100% and set overflow-x: clip on html, body",
                )
            for gm in PURPLE_BLUE_GRAD_RE.finditer(css_clean):
                add_finding(
                    "no-slop-patterns",
                    rel,
                    _line_of(scan_text, base_off + gm.start()),
                    "purple-blue linear-gradient",
                    "generic AI SaaS gradient slop",
                    f"replace linear-gradient(...) with a solid surface token ({token_hint})",
                )
            for sel_stack, prop, v, decl_off in _iter_declarations_with_offsets(css_clean):
                decl_line = _line_of(scan_text, base_off + decl_off)
                in_reduced_motion = any(REDUCED_MOTION_MEDIA_RE.match(s.strip()) for s in sel_stack)
                in_no_pref_motion = any(NO_PREF_MOTION_MEDIA_RE.match(s.strip()) for s in sel_stack)
                if in_reduced_motion:
                    has_reduced_motion = True
                if not in_reduced_motion and not in_no_pref_motion and prop in ("transition", "animation", "transition-property", "animation-name"):
                    if _is_non_none_motion_val(v):
                        has_motion = True
                        if first_motion_loc is None:
                            first_motion_loc = (rel, decl_line)
                is_root = _is_root_theme_stack(sel_stack) or any(s.strip().lower().startswith("@theme") for s in sel_stack)
                is_ff = _is_font_face_stack(sel_stack)
                non_at_frames = [s.strip().lower() for s in sel_stack if not s.strip().startswith("@")]
                sel_leaf = non_at_frames[-1] if non_at_frames else ""
                if prop == "font-size":
                    px_v = _parse_css_px(v)
                    if px_v is not None:
                        parts = [p.strip() for p in _split_top_level(sel_leaf, ",") if p.strip()]
                        if any(_selector_targets_tag(p, {"h1"}) for p in parts):
                            has_h1_px = max(has_h1_px or 0.0, px_v)
                        if len(non_at_frames) == 1:
                            for p in parts:
                                hb = _bare_html_body_tag(p)
                                if hb == "body":
                                    body_px = px_v if body_px is None else min(body_px, px_v)
                                elif hb == "html":
                                    html_px = px_v if html_px is None else min(html_px, px_v)
                                elif p.strip().lower() == "p":
                                    fallback_p_px = px_v if fallback_p_px is None else min(fallback_p_px, px_v)
                if prop.startswith("--") and is_root:
                    continue
                if not is_ff and prop != "content":
                    scrubbed = QUOTED_STR_RE.sub(" ", URL_FUNC_RE.sub(" ", v))
                    raw_hits = HEX_COLOR_RE.findall(scrubbed) + RGB_COLOR_RE.findall(scrubbed)
                    if raw_hits:
                        add_finding(
                            "no-raw-colors",
                            rel,
                            decl_line,
                            f"{prop}: {v[:40]}",
                            "raw color literal outside :root/@theme breaks theme consistency",
                            f"replace {raw_hits[0]} with a declared token ({token_hint})",
                        )
                if prop in ("transition", "transition-property"):
                    ta, lp = _is_bad_transition(prop, v)
                    if ta or lp:
                        add_finding(
                            "no-transition-all",
                            rel,
                            decl_line,
                            f"{prop}: {v[:45]}",
                            "transition: all or layout-property animation causes jank and unintended transitions",
                            "animate transform or opacity explicitly (e.g. transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1))",
                        )
                if prop in ("transition", "transition-timing-function", "animation", "animation-timing-function") and CSS_EASE_IN_ONLY_RE.search(v):
                    add_finding(
                        "micro-craft",
                        rel,
                        decl_line,
                        f"{prop}: {v[:45]}",
                        "ease-in starts sluggishly on UI entrances and interactions",
                        "use ease-out or cubic-bezier(0.22, 1, 0.36, 1) under 300ms",
                    )
                if prop == "transform" and CSS_SCALE_ZERO_RE.search(v):
                    add_finding(
                        "micro-craft",
                        rel,
                        decl_line,
                        f"transform: {v[:40]}",
                        "popping elements from scale(0) looks unnatural and harsh",
                        "start from transform: scale(0.95) with opacity: 0 instead of scale(0)",
                    )
                if prop == "overflow-x":
                    ov_clean = re.sub(r"\s*!important\s*$", "", v, flags=re.I).strip().lower()
                    ov_toks = ov_clean.split()
                    if ov_toks and ov_toks[0] == "hidden" and _is_html_body_stack(sel_stack):
                        add_finding(
                            "safe-overflow",
                            rel,
                            decl_line,
                            f"{sel_leaf} {{ overflow-x: hidden }}",
                            "overflow-x: hidden on html/body breaks position: sticky",
                            "use overflow-x: clip on html, body instead",
                        )

    primary_body_px = body_px if body_px is not None else html_px
    has_body_px = primary_body_px if primary_body_px is not None else fallback_p_px

    if has_interactive and not has_focus_visible:
        f_rel, f_line, f_is_jsx = (
            first_interactive_loc
            if first_interactive_loc
            else (files[0][1], 1, os.path.splitext(files[0][1])[1].lower() in (".jsx", ".tsx"))
        )
        focus_fix = (
            "add focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring (or project focus-visible utility) to interactive elements"
            if f_is_jsx
            else "add a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }"
        )
        add_finding(
            "focus-visible",
            f_rel,
            f_line,
            "interactive controls without :focus-visible",
            "keyboard users need a visible focus ring",
            focus_fix,
        )
    if has_motion and not has_reduced_motion:
        m_rel, m_line = first_motion_loc if first_motion_loc else (files[0][1], 1)
        add_finding(
            "reduced-motion",
            m_rel,
            m_line,
            "motion without prefers-reduced-motion",
            "animations must respect OS reduced-motion preferences",
            "add @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none; transition: none; } }",
        )

    markup_blob = "\n".join(all_markup_chunks)

    by_rule = {}
    for f in findings:
        by_rule.setdefault(f["rule"], []).append(f"{f['file']}:{f['line']} {f['what']} -> {f['fix']}")

    checks = [_chk("web_lint_files_scanned", True, len(files), ">= 1 web file", "web files audited")]
    for rule_name in (
        "no-restyle",
        "no-raw-colors",
        "no-arbitrary-values",
        "no-inline-styles",
        "no-unknown-classes",
        "require-static-classes",
        "micro-craft",
        "no-transition-all",
        "safe-overflow",
        "focus-visible",
        "reduced-motion",
        "no-slop-patterns",
        "web-lint-unparsed",
    ):
        hits = by_rule.get(rule_name, [])
        if hits or rule_name in ("no-restyle", "no-raw-colors", "no-arbitrary-values", "no-inline-styles", "no-unknown-classes", "require-static-classes", "micro-craft"):
            checks.append(_chk(rule_name, not hits, hits[:5] if hits else "clean", "0 findings", f"{rule_name} prescriptive check"))

    if fidelity:
        checks.append(_chk("fidelity_tokens", len(declared_tokens) >= 4, len(declared_tokens), ">= 4 semantic :root/@theme tokens", "declare full semantic token system (ground, ink, hairline/surface, accent) rather than stripping styles"))
        if has_h1_px is not None and has_body_px is not None and has_body_px > 0:
            ratio = round(has_h1_px / has_body_px, 2)
            checks.append(_chk("fidelity_type_scale", ratio >= 2.0, ratio, ">= 2.0 display/body ratio", "strong display-to-body typographic hierarchy"))
        else:
            checks.append(_chk("fidelity_type_scale", False, {"h1_px": has_h1_px, "body_px": has_body_px}, "explicit h1 and body font-size with ratio >= 2.0", "define explicit h1 and body font-size scale"))
        checks.append(_chk("fidelity_responsive", has_media_or_fluid, has_media_or_fluid, True, "responsive @media query or fluid clamp()/minmax() layout required"))
        has_lm = bool(re.search(r"<main\b", markup_blob, re.I)) and bool(re.search(r"<h1\b", markup_blob, re.I)) and bool(re.search(r"<(?:header|nav|section|article|footer)\b", markup_blob, re.I))
        checks.append(_chk("fidelity_landmarks", has_lm, has_lm, True, "semantic landmarks (<main>, <h1>, plus <header>/<section>/<footer>)"))

    ok = not findings and all(c["ok"] for c in checks)
    return {"ok": ok, "findings": findings, "checks": checks}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="HTML/CSS file or directory to audit against anti-slop Floor rules")
    ap.add_argument("--web-lint", help="HTML/CSS/JSX/TSX file or directory to audit with prescriptive self-repair diagnostics")
    ap.add_argument("--fidelity", action="store_true", help="For --web-lint: also enforce anti-regression visual hierarchy/token/landmark fidelity checks")
    ap.add_argument("--design-md", help="DESIGN.md file to validate against token and reference schema")
    ap.add_argument("--iso", help="Isometric technical illustration contract JSON to verify")
    ap.add_argument("--ink-anim", help="Line-art SVG ink animation contract JSON to verify")
    ap.add_argument("--sakuga", help="Sakuga tactile UI VFX control contract JSON to verify")
    ap.add_argument("--logo", help="Vector logo SVG file to validate against studio logo invariants")
    ap.add_argument("--allow-draft-text", action="store_true", help="For --logo: allow live <text> elements during early draft lockups")
    ap.add_argument("--surface", default=None, help="For --logo: target background color (e.g. #FFFFFF or #111111) for WCAG >= 3:1 contrast check")
    ap.add_argument("--pre-render", action="store_true", help="For --iso/--ink-anim/--sakuga: validate pre-render plan without requiring post-render audit flags")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    modes = (a.html, a.web_lint, a.design_md, a.iso, a.ink_anim, a.sakuga, a.logo)
    if sum(bool(x) for x in modes) != 1:
        ap.error("provide exactly one of --html, --web-lint, --design-md, --iso, --ink-anim, --sakuga, or --logo")
    if a.fidelity and not a.web_lint:
        ap.error("--fidelity can only be used with --web-lint")
    if a.html:
        res = check_html_path(a.html)
    elif a.web_lint:
        res = check_web_lint(a.web_lint, fidelity=a.fidelity)
    elif a.design_md:
        res = check_design_md(a.design_md)
    elif a.iso:
        res = check_iso_file(a.iso, pre_render=a.pre_render)
    elif a.ink_anim:
        res = check_ink_anim_file(a.ink_anim, pre_render=a.pre_render)
    elif a.sakuga:
        res = check_sakuga_file(a.sakuga, pre_render=a.pre_render)
    else:
        res = check_logo_svg(a.logo, allow_draft_text=a.allow_draft_text, surface=a.surface)

    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for f in res.get("findings", []):
            print(f"[{f['rule']}] {f['file']}:{f['line']} | {f['what']} | {f['why']} | Fix: {f['fix']}")
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()
