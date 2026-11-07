# Going further with code

Read this when a spec cannot say what the piece needs: real page layout, an SVG or chart library, a shader, data-driven
animation, a physics sim. You are writing a renderer. Keep the bars the spec path enforces; the helpers below let you
reuse `motion.py`'s own measurements.

## The bars (same as the spec path)

| Bar | How to hold it in your own code |
|---|---|
| Safe margin 5% | measure each text box's bounding rectangle at the times it is readable; fail if it leaves `[0.05, 0.95]` of either side |
| Reading time | each text fully visible for `max(1.2, 0.25 * words)` seconds |
| Contrast | text color against the pixels behind it: 4.5:1 under 5% of the frame height, 3:1 above. Measure rendered pixels, not CSS colors |
| No overlap | no two text boxes share area at the same time; nothing drawn over text |
| Eased | every move uses an easing; `linear` only for typing and counters |
| Anti-aliased, sRGB | draw at 2x and reduce, or let the browser do it; tag the video bt709 |
| Deterministic | frame k depends only on the inputs and `k / fps`: no clock, no unseeded random; hash frames |
| Looked at | make an 8-frame contact sheet, open it, and answer the five questions in SKILL.md |

## Reuse motion.py as a library

```python
import sys; sys.path.insert(0, "path/to/hildegard-motion/scripts")  # this skill's scripts folder
import motion

motion.contrast_ratio((255, 255, 255), (79, 140, 255))   # WCAG contrast of two colors
ease = motion.EASES["easeOutCubic"]; ease(0.4)          # the named easings
motion.parse_color("#4f8cffcc")                          # (r, g, b, a)
model, problems = motion.compile_spec("spec.json")       # the compiled spec and compile-time problems
problems += motion.run_checks(model)                     # every --check rule on real rendered frames
R = motion.Renderer(model, scale=0.5)
frame = R.to_uint8(R.render_frame(2.5))                  # numpy (H, W, 3) uint8 at t = 2.5 s
```

A hybrid works well: let a spec draw the type, titles and background, render it, then lay your custom frames under or over
it with ffmpeg (`overlay`). The spec's checks then still cover the type.

## A Pillow or numpy frame loop

Frames in, MP4 out. The ffmpeg line is the same one `motion.py` uses.

```python
import subprocess, hashlib
import numpy as np
from PIL import Image, ImageDraw

W, H, FPS, SECONDS = 1920, 1080, 30, 6
ff = subprocess.Popen(
    ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
     "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
     "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
     "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart", "out.mp4"],
    stdin=subprocess.PIPE)
hashes = []
for k in range(FPS * SECONDS):
    t = k / FPS
    big = Image.new("RGB", (W * 2, H * 2), (11, 16, 32))        # draw at 2x
    d = ImageDraw.Draw(big)
    x = (0.2 + 0.6 * (1 - (1 - min(1, t / 2)) ** 3)) * W * 2   # easeOutCubic by hand
    d.ellipse((x - 120, H - 120, x + 120, H + 120), fill=(242, 184, 75))
    frame = np.asarray(big.resize((W, H), Image.BOX), dtype=np.uint8)   # reduce: anti-aliased
    hashes.append(hashlib.sha256(frame.tobytes()).hexdigest())
    ff.stdin.write(frame.tobytes())
ff.stdin.close(); ff.wait()
```

Without ffmpeg, PyAV does the same: `av.open("out.mp4", "w")`, `add_stream("libx264", rate=FPS)`, then for each frame
`av.VideoFrame.from_ndarray(frame, format="rgb24")` through `stream.encode`.

## An HTML canvas page captured with Playwright

Use this when layout is easier in CSS, or you want a chart library, SVG or WebGL. The page must be a pure function of time:
expose `window.renderAt(t)` that sets every animated value from `t` (no `requestAnimationFrame` loop, no `Date.now()`, no
CSS transitions) and the capture loop steps `t` frame by frame.

```python
# pip install playwright && python3 -m playwright install chromium   (ask the user to install it)
import hashlib, subprocess
from playwright.sync_api import sync_playwright

W, H, FPS, SECONDS = 1920, 1080, 30, 6
ff = subprocess.Popen(
    ["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-i", "-",
     "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
     "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "out.mp4"],
    stdin=subprocess.PIPE)
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    page.goto("file:///abs/path/scene.html")
    page.evaluate("document.fonts.ready")                    # fonts loaded before frame 0
    for k in range(FPS * SECONDS):
        page.evaluate(f"window.renderAt({k / FPS})")
        ff.stdin.write(page.screenshot(type="png"))
    browser.close()
ff.stdin.close(); ff.wait()
```

For the checks, read layout from the page instead of guessing: in `renderAt`, or from the loop with `page.evaluate`, collect
`el.getBoundingClientRect()` for each text element at the times it is readable, and compare against `[0.05 * W, 0.95 * W]`
and `[0.05 * H, 0.95 * H]`. Contrast: take the screenshot, crop each text rect, and compare the text color with the 10th
percentile of the contrast ratios of the pixels in the rect (`motion.contrast_ratio` per pixel, or the numpy form in
`Checker.check_contrast`). Reading time: the interval where the element's opacity is above 0.95.

Pin what you load: fonts from the pinned list in `motion.FONT_PINS` (or a file you have the right to use), libraries from a
local file or a pinned CDN URL, never an unpinned `latest`. No network at render time once everything is cached.

## Before you deliver anything made this way

Hash the frames twice and compare. Make the contact sheet and look at it. Run `ffprobe` on the output and confirm the
width, height, frame rate and duration are what you meant. Say in the delivery that this was code written for the piece,
not a spec, and what you checked.
