import numpy as np, wave
sr = 44100; rng = np.random.default_rng(7)
T = 2.0; n = int(T * sr); N, hop = 2048, 512
x = rng.standard_normal(n + N)
win = np.hanning(N); out = np.zeros(n + N)
fr = np.fft.rfftfreq(N, 1 / sr)
for k, a in enumerate(range(0, n, hop)):
    p = a / sr / T
    fc = 250 * (24.0 ** np.sin(np.pi * p))  # 250 Hz up to 6 kHz and back
    m = np.exp(-0.5 * ((np.log(fr + 1) - np.log(fc)) / 0.7) ** 2)
    S = np.fft.rfft(x[a:a + N] * win) * m
    out[a:a + N] += np.fft.irfft(S, N) * win
y = out[:n] * (np.sin(np.pi * np.arange(n) / n) ** 1.6)
y *= 10 ** (-3 / 20) / np.max(np.abs(y))
w = wave.open('out.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((y * 32767).astype('<i2').tobytes()); w.close()
