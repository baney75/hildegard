# SPDX-License-Identifier: Apache-2.0
"""Hildegard film look for ComfyUI: grain, halation, vignette, gate weave, softness and a simple grade.

One node, HildegardLook, applied to decoded frames before they are encoded. Everything is seeded, so the
same seed gives the same grain, and every setting at zero returns the frames untouched.
"""
from .look import HildegardLook

NODE_CLASS_MAPPINGS = {"HildegardLook": HildegardLook}
NODE_DISPLAY_NAME_MAPPINGS = {"HildegardLook": "Hildegard film look"}
