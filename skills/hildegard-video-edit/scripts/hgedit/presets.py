# SPDX-License-Identifier: AGPL-3.0-only
"""Where a video is going: shape, loudness and length, as the platforms ask for them. Numbers are defaults; the edit
list's `target` can override any of them. The length limits only warn, since platforms change them."""

from .edl import EdlError, parse_aspect

TARGETS = {
    "youtube": dict(aspect="16:9", height=1080, lufs=-14.0, peak=-1.0, max_seconds=None, keep_original=True, bitrate_kbps=12000),
    "shorts": dict(aspect="9:16", height=1920, lufs=-14.0, peak=-1.0, max_seconds=180, keep_original=False, bitrate_kbps=10000),
    "reels": dict(aspect="9:16", height=1920, lufs=-14.0, peak=-1.0, max_seconds=180, keep_original=False, bitrate_kbps=10000),
    "tiktok": dict(aspect="9:16", height=1920, lufs=-14.0, peak=-1.0, max_seconds=600, keep_original=False, bitrate_kbps=10000),
    "x": dict(aspect="16:9", height=720, lufs=-14.0, peak=-1.0, max_seconds=140, keep_original=False, bitrate_kbps=6000),
    "podcast": dict(aspect="16:9", height=720, lufs=-16.0, peak=-1.0, max_seconds=None, keep_original=True, bitrate_kbps=4000),
}
# A video with no target is delivered at the shape and size it came in, to the web's usual loudness.
DEFAULT = dict(aspect=None, height=None, lufs=-14.0, peak=-1.0, max_seconds=None, keep_original=True, bitrate_kbps=None)


def resolve_target(edl):
    t = edl.get("target")
    if t is None:
        return dict(DEFAULT, name="default")
    if isinstance(t, str):
        if t not in TARGETS:
            raise EdlError(f"“{t}” isn’t a target. Use one of {', '.join(TARGETS)}.")
        return dict(TARGETS[t], name=t)
    base = dict(TARGETS.get(t.get("name", ""), DEFAULT))
    base.update({k: v for k, v in t.items() if k != "name" and v is not None})
    base["name"] = t.get("name", "custom")
    if base.get("aspect"):
        parse_aspect(base["aspect"])
    return base
