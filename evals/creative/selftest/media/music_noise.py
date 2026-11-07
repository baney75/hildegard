# SPDX-License-Identifier: AGPL-3.0-only
import numpy as np, wave
sr = 44100; y = np.random.default_rng(1).standard_normal(30 * sr) * 0.05
w = wave.open('out.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(y, -1, 1) * 32767).astype('<i2').tobytes()); w.close()
