import numpy as np, wave
sr = 44100; t = np.arange(int(1.0 * sr)) / sr
y = 0.5 * np.sin(2 * np.pi * 440 * t)
w = wave.open('out.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((y * 32767).astype('<i2').tobytes()); w.close()
