# SPDX-License-Identifier: Apache-2.0
"""Hildegard's safety check for ComfyUI: one node, HildegardGuard, that stops a render whose frames look sexual.

Hildegard puts it on every start frame and on every take's decoded frames, before the film look and the video file,
and a device sharing its GPU refuses a graph without it. The classifier lives in ComfyUI's models/safety folder.
"""
import os

from .node import HildegardGuard

try:  # inside ComfyUI: give the classifier its own models folder
    import folder_paths

    if "safety" not in folder_paths.folder_names_and_paths:
        folder_paths.folder_names_and_paths["safety"] = (
            [os.path.join(folder_paths.models_dir, "safety")],
            {".safetensors"},
        )
except ImportError:
    pass

NODE_CLASS_MAPPINGS = {"HildegardGuard": HildegardGuard}
NODE_DISPLAY_NAME_MAPPINGS = {"HildegardGuard": "Hildegard safety check"}
