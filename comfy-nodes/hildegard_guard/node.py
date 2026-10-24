# SPDX-License-Identifier: Apache-2.0
from .guard import MAX_THRESHOLD, MIN_THRESHOLD, Classifier, GuardBlocked, judge, read_weights

_loaded = {}


def _device():
    try:  # inside ComfyUI, use the GPU it uses
        import comfy.model_management as mm

        return mm.get_torch_device()
    except Exception:
        import torch

        return torch.device("cpu")


def _classifier(name):
    import folder_paths

    path = folder_paths.get_full_path("safety", name)
    if not path:
        raise GuardBlocked(
            "HildegardGuard: the safety classifier is missing, so nothing can render. "
            "Run `hildegard models install` again to download it."
        )
    if path not in _loaded:
        dev = _device()
        _loaded.clear()
        _loaded[path] = (Classifier(read_weights(path)).to(dev), dev)
    return _loaded[path]


def _files():
    try:
        import folder_paths

        return folder_paths.get_filename_list("safety") or ["model.safetensors"]
    except Exception:
        return ["model.safetensors"]


class HildegardGuard:
    CATEGORY = "image/safety"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    DESCRIPTION = "Stops the render when a frame looks sexual. Returns the frames untouched otherwise."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "classifier": (_files(),),
                "threshold": ("FLOAT", {"default": 0.8, "min": MIN_THRESHOLD, "max": MAX_THRESHOLD, "step": 0.01}),
                "what": (["take", "start frame", "reference", "still"], {"default": "take"}),
            }
        }

    def run(self, images, classifier, threshold, what):
        model, dev = _classifier(classifier)
        return (judge(images, model, threshold, what=what, device=dev),)
