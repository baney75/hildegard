# SPDX-License-Identifier: Apache-2.0
"""`python -m hildegard_voice`: the engine, talking JSON lines on stdin and stdout. Logs go to stderr."""
import os
import sys

# Never reach the network: every file is in the model folder Hildegard checked, and nothing phones home.
for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
    os.environ[k] = "1"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Apple's GPU lacks a few ops some of these models use; run those on the CPU instead of failing.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from .protocol import serve  # noqa: E402

if __name__ == "__main__":
    # Library chatter on stdout would break the protocol: keep the real stdout for answers, send prints to stderr.
    out = sys.stdout
    sys.stdout = sys.stderr
    serve(stdout=out)
