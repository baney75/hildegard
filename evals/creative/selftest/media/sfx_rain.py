# SPDX-License-Identifier: AGPL-3.0-only
import numpy as np, wave, subprocess, re
sr = 44100; rng = np.random.default_rng(5)
n = 30 * sr
x = rng.standard_normal(n)
X = np.fft.rfft(x); f = np.fft.rfftfreq(n, 1 / sr)
X *= np.clip((f - 400) / 800, 0, 1) * 1.0 / (1 + f / 6000)
wash = np.fft.irfft(X, n) * 0.5
drops = np.zeros(n + 2000)
for _ in range(int(30 * 500)):
    a = int(rng.integers(0, n)); fr = rng.uniform(2500, 7000); amp = rng.uniform(0.2, 1.0) ** 2
    tt = np.arange(900) / sr
    drops[a:a + 900] += amp * np.sin(2 * np.pi * fr * tt) * np.exp(-tt / 0.003)
y = wash / wash.std() * 0.3 + drops[:n] * 0.6
def write(path, v):
    w = wave.open(path, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(v, -1, 1) * 32767).astype('<i2').tobytes()); w.close()
y /= np.max(np.abs(y)) * 2
write('raw.wav', y)
r = subprocess.run(['ffmpeg', '-nostats', '-i', 'raw.wav', '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
i = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', r[r.rfind('Summary:'):])[0])
y *= 10 ** ((-24 - i) / 20)
write('out.wav', y)
