# SPDX-License-Identifier: AGPL-3.0-only
import numpy as np, wave
sr = 44100
out = np.zeros(int(1.0 * sr))
for i, f in enumerate([659.26, 783.99, 1046.5]):
    t = np.arange(int(0.8 * sr)) / sr
    n = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) + 0.1 * np.sin(2 * np.pi * 3 * f * t)) * np.exp(-t * 5.5) * np.minimum(1, t / 0.004)
    a = int(i * 0.13 * sr)
    out[a:a + len(n)] += n[:len(out) - a]
out *= 10 ** (-3 / 20) / np.max(np.abs(out))
out[-441:] *= np.linspace(1, 0, 441)
w = wave.open('out.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((out * 32767).astype('<i2').tobytes()); w.close()
