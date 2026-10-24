import numpy as np, librosa, perth
w = perth.PerthImplicitWatermarker()
sr = 24000
t = np.arange(sr * 4) / sr
rng = np.random.default_rng(0)
cases = {
    "tone180": 0.2 * np.sin(2 * np.pi * 180 * t),
    "white": 0.05 * rng.standard_normal(len(t)),
    "vowel": sum(0.1 / k * np.sin(2 * np.pi * 140 * k * t) for k in range(1, 30)) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t)) + 0.003 * rng.standard_normal(len(t)),
}
for name in ["libri1", "libri2", "libri3"]:
    y, s = librosa.load(librosa.ex(name), sr=sr, duration=8)
    cases[name] = y
for name, y in list(cases.items()):
    y = np.asarray(y, np.float32)
    raw = w.get_watermark(y, sample_rate=sr, round=False)
    m = w.apply_watermark(y, sample_rate=sr)
    rawm = w.get_watermark(np.asarray(m, np.float32), sample_rate=sr, round=False)
    f = lambda a: f"mean={np.mean(a):.3f} med={np.median(a):.3f} frac>0.5={np.mean(a > 0.5):.3f} n={a.size}"
    print(f"{name:8s} plain {f(raw)} | marked {f(rawm)}")
