# SPDX-License-Identifier: AGPL-3.0-only
"""Writes a take's poster: one frame of its video, at full size, as a JPEG.

    python poster.py VIDEO.mp4 OUT.jpg

The frame is a quarter of the way in, past any fade from black. The sampler's live preview is small, so a poster made
from it looks blocky on a high-density screen; this one is as sharp as the video. Uses PyAV and Pillow, which ComfyUI
already installs. Exits non-zero on any failure, and the caller keeps the preview instead.
"""

import sys

import av


def main(src, out):
    with av.open(src) as c:
        v = c.streams.video[0]
        frames = v.frames or 0
        target = frames // 4
        last = None
        for i, frame in enumerate(c.decode(v)):
            last = frame
            if i >= target:
                break
        if last is None:
            raise ValueError("The video has no frames.")
        last.to_image().save(out, "JPEG", quality=88, optimize=True, progressive=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
