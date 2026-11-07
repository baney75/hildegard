import numpy as np, wave
sr = 44100; rng = np.random.default_rng(3)
n = int(1.1 * sr); t = np.arange(n) / sr
x = rng.standard_normal(n)
X = np.fft.rfft(x); f = np.fft.rfftfreq(n, 1 / sr)
X *= np.clip((f - 1200) / 1200, 0, 1) * np.clip((9000 - f) / 2000, 0, 1)
x = np.fft.irfft(X, n)
env = np.minimum(1, t / 0.03) * np.exp(-((t - 0.3) / 0.22) ** 2) * (0.7 + 0.3 * np.sin(2 * np.pi * 13 * t))
env += 0.35 * np.exp(-((t - 0.8) / 0.05) ** 2)
y = x * env
y *= 10 ** (-3 / 20) / np.max(np.abs(y))
y[-441:] *= np.linspace(1, 0, 441)
w = wave.open('out.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((y * 32767).astype('<i2').tobytes()); w.close()
