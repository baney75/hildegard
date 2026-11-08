# SPDX-License-Identifier: AGPL-3.0-only
import numpy as np, wave
sr = 44100; n = int(3.0 * sr); t = np.arange(n) / sr; f0 = 1180.0
y = np.zeros(n)
for r, a, d in [(1, 1.0, 1.6), (2.0, 0.6, 1.2), (2.76, 0.5, 0.9), (5.4, 0.3, 0.5), (8.93, 0.15, 0.3)]:
    y += a * np.sin(2 * np.pi * f0 * r * t) * np.exp(-t / d)
y *= np.minimum(1, t / 0.002)
y *= np.minimum(1, (3.0 - t) / 0.3)
y *= 10 ** (-3 / 20) / np.max(np.abs(y))
w = wave.open('out.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((y * 32767).astype('<i2').tobytes()); w.close()
