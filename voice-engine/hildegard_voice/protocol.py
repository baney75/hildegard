# SPDX-License-Identifier: Apache-2.0
"""JSON lines over stdin and stdout: one request a line in, a few progress lines and one answer a line out.

    → {"id": "7", "op": "speak", ...}
    ← {"id": "7", "progress": {"done": 1, "total": 3}}
    ← {"id": "7", "ok": true, "result": {...}}      or      {"id": "7", "ok": false, "error": {"code", "message"}}

Requests run one at a time, in order. Audio goes in and out as file paths in folders the server made for the job;
nothing else on the computer is read or written. The server stops a request by ending the process.

Ops (each takes `model`: {"engine", "dir"}, except where noted):

- hello: versions, the device, and whether the watermark works. No model.
- speak: `segments` [{text, language, instruct?, pause?}] in one `voice` ({kind: preset|clone|design|default, ...}),
  `settings` {speed, exaggeration, cfg, temperature} (a segment's own `settings` override them), `seed`, `out`. Writes one loudness-matched, watermarked WAV.
- convert: `source` spoken again in the voice of `ref`, to `out`. Speech to speech.
- transcribe: `path`, `language`? → segments with word timings.
- embed: `paths` → a speaker fingerprint for each. `model` is the speaker encoder's weights file.
- analyze: `path` → length, level, noise, clipping and how much is speech. No model.
- mark: `path` → how sure Hildegard's watermark is in it, 0 to 1. No model.
- decode: `path` (any recording a browser or phone makes) → `out`, a mono WAV at `sampleRate` (24000), plus its
  analysis. Every upload passes through this first, so the other environments only ever read WAV. No model.
- dub: `bed` (the original sound), `lines` [{start, seconds, path}], `out`: lines fitted to their slots over the bed.
- release: free the GPU. No model.
"""
import json
import os
import sys
import time
import traceback

import numpy as np

from . import __version__, audio, backends, mark
from .errors import VoiceError, classify

MAX_TEXT = 5000
MAX_SEGMENTS = 400


class Engine:
    def __init__(self, emit, fake_mark=False):
        self.emit = emit
        self.fake_mark = fake_mark
        self.loaded = {}

    def _backend(self, model):
        if not isinstance(model, dict) or not isinstance(model.get("engine"), str):
            raise VoiceError("bad_request", "Which model?")
        key = (model["engine"], model.get("dir") or "", model.get("device") or "")
        if key not in self.loaded:
            # One model on the GPU at a time: a worker serves one family, but its forms (Qwen's Base and VoiceDesign,
            # say) are different weights.
            self.release()
            mod = backends.load(model["engine"])
            self.loaded[key] = mod.Backend(model.get("dir") or "", model.get("device"))
        return self.loaded[key]

    def release(self, _req=None):
        for b in self.loaded.values():
            try:
                b.release()
            except Exception:
                pass
        self.loaded.clear()
        backends.free_gpu()
        return {"released": True}

    def _mark(self, wav, sr):
        return wav if self.fake_mark else mark.apply(wav, sr)

    # ── ops ──────────────────────────────────────────────────────────────────────────────────────────────────────

    def hello(self, _req):
        info = {"version": __version__, "python": sys.version.split()[0], "device": backends.pick_device()}
        try:
            import torch

            info["torch"] = torch.__version__
            if torch.cuda.is_available():
                p = torch.cuda.get_device_properties(0)
                info["gpu"] = p.name
                info["vramGb"] = round(p.total_memory / 1024**3, 1)
        except ImportError:
            pass
        info["watermark"] = self.fake_mark or _perth_works()
        return info

    def speak(self, req, rid):
        segments = req.get("segments")
        if not isinstance(segments, list) or not segments or len(segments) > MAX_SEGMENTS:
            raise VoiceError("bad_request", "Nothing to say.")
        for s in segments:
            if not isinstance(s, dict) or not isinstance(s.get("text"), str) or not s["text"].strip():
                raise VoiceError("bad_request", "Each paragraph needs words.")
            if len(s["text"]) > MAX_TEXT:
                raise VoiceError("bad_request", "A paragraph is too long; split it.")
        b = self._backend(req.get("model"))
        voice = req.get("voice") or {}
        settings = dict(req.get("settings") or {})
        seed = int(req.get("seed") or 0)
        parts, marks, at = [], [], 0.0
        started = time.time()
        for i, s in enumerate(segments):
            backends.seed_all(seed + i)
            # A tag can lift one segment's settings ([excited] raises Chatterbox's exaggeration, say).
            own = {**settings, **(s.get("settings") or {}), "seed": seed + i}
            wav = b.speak(s, voice, own)
            sr = b.sample_rate
            wav = audio.trim(np.asarray(wav, np.float32), sr)
            parts.append(wav)
            marks.append({"start": round(at, 3), "end": round(at + len(wav) / sr, 3)})
            at += len(wav) / sr
            pause = float(s.get("pause") or 0)
            if pause > 0:
                parts.append(audio.silence(min(pause, 10.0), sr))
                at += min(pause, 10.0)
            self.emit({"id": rid, "progress": {"done": i + 1, "total": len(segments)}})
        sr = b.sample_rate
        wav = audio.normalize(audio.join(parts, sr), sr)
        wav = self._mark(wav, sr)
        audio.write(req["out"], wav, sr, title=req.get("title"), comment=req.get("comment"))
        return {
            "path": req["out"],
            "seconds": round(len(wav) / sr, 3),
            "sampleRate": sr,
            "segments": marks,
            "ms": int((time.time() - started) * 1000),
        }

    def convert(self, req, _rid):
        b = self._backend(req.get("model"))
        if not hasattr(b, "convert"):
            raise VoiceError("unsupported", "This model can’t change one voice into another. Chatterbox can.")
        for k in ("source", "ref"):
            if not os.path.exists(req.get(k) or ""):
                raise VoiceError("bad_request", "The recording is missing.")
        started = time.time()
        wav = audio.normalize(np.asarray(b.convert(req["source"], req["ref"]), np.float32), b.sample_rate)
        wav = self._mark(wav, b.sample_rate)
        audio.write(req["out"], wav, b.sample_rate, title=req.get("title"), comment=req.get("comment"))
        return {"path": req["out"], "seconds": round(len(wav) / b.sample_rate, 3), "sampleRate": b.sample_rate,
                "ms": int((time.time() - started) * 1000)}

    def transcribe(self, req, _rid):
        b = self._backend(req.get("model"))
        if not hasattr(b, "transcribe"):
            raise VoiceError("unsupported", "This model doesn’t transcribe.")
        if not os.path.exists(req.get("path") or ""):
            raise VoiceError("bad_request", "The recording is missing.")
        return b.transcribe(req["path"], req.get("language"), req.get("words", True))

    def embed(self, req, _rid):
        from . import speaker

        weights = (req.get("model") or {}).get("dir")
        if not weights or not os.path.exists(weights):
            raise VoiceError("model_missing", "The speaker check isn’t installed.")
        out = []
        for p in req.get("paths") or []:
            out.append([round(float(x), 6) for x in speaker.embed(p, weights, device=backends.pick_device(mps=False))])
        return {"embeddings": out}

    def analyze(self, req, _rid):
        wav, sr = audio.read(req["path"])
        return audio.analyze(wav, sr)

    def decode(self, req, _rid):
        sr = int(req.get("sampleRate") or 24000)
        wav, _ = audio.read(req["path"], sr)
        if not len(wav):
            raise VoiceError("audio_unreadable", "That recording is empty.")
        audio.write(req["out"], wav, sr)
        return {"path": req["out"], "sampleRate": sr, **audio.analyze(wav, sr)}

    def mark(self, req, _rid):
        wav, sr = audio.read(req["path"])
        return {"score": round(mark.detect(wav, sr), 4), "seconds": round(len(wav) / sr, 3)}

    def dub(self, req, _rid):
        sr = int(req.get("sampleRate") or 24000)
        bed, _ = audio.read(req["bed"], sr) if req.get("bed") else (None, sr)
        lines = []
        for line in req.get("lines") or []:
            wav, _ = audio.read(line["path"], sr)
            lines.append((float(line["start"]), audio.fit(audio.trim(wav, sr), sr, float(line["seconds"]))))
        if bed is None:
            end = max((s + len(w) / sr for s, w in lines), default=0.0)
            bed = audio.silence(end, sr)
        wav = audio.mix(bed, sr, lines, duck_db=float(req.get("duckDb", -14.0)))
        audio.write(req["out"], wav, sr, title=req.get("title"), comment=req.get("comment"))
        return {"path": req["out"], "seconds": round(len(wav) / sr, 3), "sampleRate": sr}


def _perth_works():
    try:
        mark.apply(np.zeros(2400, np.float32), 24000)
        return True
    except Exception:
        return False


OPS = {"speak", "convert", "transcribe", "embed", "analyze", "decode", "mark", "dub"}


def handle(engine, req):
    """One request to one answer line (progress lines go out through engine.emit as it works)."""
    rid = str(req.get("id", ""))
    op = req.get("op")
    try:
        if op == "hello":
            result = engine.hello(req)
        elif op == "release":
            result = engine.release(req)
        elif op in OPS:
            for k in ("out",):
                if k in req and not isinstance(req[k], str):
                    raise VoiceError("bad_request", "Where should it go?")
            result = getattr(engine, op)(req, rid)
        else:
            raise VoiceError("bad_request", f"Unknown op {op!r}.")
        return {"id": rid, "ok": True, "result": result}
    except Exception as e:
        err = classify(e)
        if err.code == "engine_failed":
            traceback.print_exc(file=sys.stderr)
        return {"id": rid, "ok": False, "error": {"code": err.code, "message": err.message, "detail": err.detail[:2000]}}


def serve(stdin=None, stdout=None, fake_mark=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    if fake_mark is None:
        fake_mark = os.environ.get("HILDEGARD_VOICE_FAKE_MARK") == "1"

    def emit(obj):
        stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        stdout.flush()

    engine = Engine(emit, fake_mark=fake_mark)
    emit({"ready": True, "version": __version__})
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("not an object")
        except ValueError:
            emit({"id": "", "ok": False, "error": {"code": "bad_request", "message": "That isn’t a request.", "detail": ""}})
            continue
        emit(handle(engine, req))
    engine.release()
