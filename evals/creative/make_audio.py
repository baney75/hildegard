# SPDX-License-Identifier: AGPL-3.0-only
"""Make the inputs for the audio and video-edit tasks, reproducibly.

  python3 make_audio.py tasks.json [heldout.json ...]

Speech is a public-domain LibriVox reading of the Declaration of Independence (archive.org), pinned by SHA-256 and kept
outside git in $EVAL_DIR (default ~/.cache/hildegard-creative-eval). Music beds and the sting are synthesized with numpy
from a fixed seed. Degradations are numpy too. Per task this writes
  $EVAL_DIR/inputs/<id>/   what the responder is given (plus nothing else)
  $EVAL_DIR/ref/<id>/      the clean reference and a meta.json for the scorer (never shown to a responder)
Re-running skips tasks whose inputs exist."""
import hashlib, json, os, subprocess, sys, urllib.request
import numpy as np
from audiolib import SR, read_audio, write_wav, rms_db, db, pause_frames

E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
URL = 'https://archive.org/download/declaration_of_independence_librivox/DeclarationOfIndependence_librivox.m4b'
SHA256 = '03f70357a1562ba643576d9fc846b9156c79c2af720fe3ac7721a7b275c02f85'


def source():
    path = os.path.join(E, 'doi.m4b')
    os.makedirs(E, exist_ok=True)
    if not os.path.exists(path):
        urllib.request.urlretrieve(URL, path + '.part')
        os.replace(path + '.part', path)
    h = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if h != SHA256:
        raise SystemExit(f'{path}: SHA-256 {h} is not the pinned {SHA256}; delete it and re-run')
    return read_audio(path)


def snap_end(x, start, dur):
    """End time nearest start+dur that falls inside a pause of the source, so a cut never lands inside a word."""
    pause, _ = pause_frames(x)
    want = int((start + dur) / 0.02)
    best = min((abs(i - want), i) for i in range(max(0, want - 150), min(len(pause), want + 150)) if pause[i])
    return best[1] * 0.02


def segment(x, start, dur):
    end = snap_end(x, start, dur)
    return x[int(start * SR):int(end * SR)].copy()


def set_speech_rms(v, target_db):
    _, speech = pause_frames(v)
    n = int(SR * 0.02)
    f = np.concatenate([v[i * n:(i + 1) * n] for i in np.flatnonzero(speech)]) if speech.any() else v
    return v * 10 ** ((target_db - rms_db(f)) / 20)


def smooth_gain(n, regions, ramp=0.25):
    g = np.zeros(n)
    for a, b, gdb in regions:
        a, b = int(a * SR), int(b * SR)
        g[a:b] = gdb
    k = int(ramp * SR)
    if k > 1:
        g = np.convolve(np.pad(g, (k, k), mode='edge'), np.ones(k) / k, mode='same')[k:-k]
    return 10 ** (g / 20)


def reverb(v, wet, rng, rt60=0.45):
    t = np.arange(int(SR * rt60 * 1.2)) / SR
    ir = rng.standard_normal(len(t)) * np.exp(-t * 6.9 / rt60)
    ir[0] = 0
    ir[int(0.035 * SR)] += 6.0  # a hard early reflection, like a bare wall
    ir /= np.sqrt(np.sum(ir ** 2))
    n = len(v) + len(ir)
    w = np.fft.irfft(np.fft.rfft(v, n) * np.fft.rfft(ir, n), n)[:len(v)]
    w *= np.sqrt(np.mean(v ** 2) / (np.mean(w ** 2) + 1e-12))
    return (1 - wet) * v + wet * w


def degrade(v, g, rng):
    n = len(v)
    t = np.arange(n) / SR
    ref = v.copy()
    d = reverb(v, g.get('reverb', 0.2), rng)
    d = d * smooth_gain(n, g.get('dips', []))
    for p in g.get('pops', []):
        i = int(p * SR)
        m = int(0.09 * SR)
        tt = np.arange(m) / SR
        thump = 1.8 * np.exp(-tt / 0.025) * np.sin(2 * np.pi * 85 * tt) + 0.5 * rng.standard_normal(m) * np.exp(-tt / 0.01)
        d[i:i + m] += thump[:n - i]
    f0, a = g['hum_hz'], g['hum_amp']
    for k, rel in enumerate([1.0, 0.7, 0.5, 0.25, 0.15], start=1):
        d += a * rel * np.sin(2 * np.pi * f0 * k * t + rng.uniform(0, 6.28))
    h = rng.standard_normal(n + 1)
    d += (h[1:] - 0.85 * h[:-1]) * (g['hiss_rms'] / np.sqrt(1 + 0.85 ** 2))
    if g.get('rumble_rms'):
        r = np.fft.rfft(rng.standard_normal(n))
        fr = np.fft.rfftfreq(n, 1 / SR)
        r[fr > 70] = 0
        r = np.fft.irfft(r, n)
        d += r * (g['rumble_rms'] / np.sqrt(np.mean(r ** 2)))
    return ref, np.clip(d, -1.0, 1.0)


def note(f, dur, rng=None, kind='pad'):
    t = np.arange(int(dur * SR)) / SR
    if kind == 'pad':
        s = sum(np.sin(2 * np.pi * f * (1 + dt) * t) + 0.35 * np.sin(2 * np.pi * 2 * f * (1 + dt) * t) for dt in (-0.0035, 0.0, 0.0035))
        env = np.minimum(1, t / 0.9) * np.minimum(1, (dur - t) / 0.9)
        return s * env / 3
    # pluck: decaying harmonics
    s = sum(np.sin(2 * np.pi * f * k * t) / k * np.exp(-t * (2.5 + 1.2 * k)) for k in range(1, 7))
    return s * np.minimum(1, t / 0.004)


def add(buf, a, s, g=1.0):
    n = min(len(s), len(buf) - a)
    if n > 0:
        buf[a:a + n] += s[:n] * g


def music(kind, dur, rng, rms_dbfs):
    n = int(dur * SR)
    m = lambda p: 440 * 2 ** ((p - 69) / 12)
    prog = {'pad_a': ([[48, 55, 64], [45, 52, 60], [41, 48, 57], [43, 50, 59]], 72, False, 'pad'),
            'pad_b': ([[50, 57, 66], [47, 54, 62], [43, 50, 59], [45, 52, 61]], 104, True, 'pad'),
            'pad_c': ([[45, 52, 60], [41, 48, 57], [48, 55, 64], [43, 50, 59]], 84, False, 'pluck')}[kind]
    chords, bpm, hats, voice = prog
    beat = 60 / bpm
    L, R = np.zeros(n + 5 * SR), np.zeros(n + 5 * SR)
    bar = 4 * beat
    for bi in range(int(dur / bar) + 2):
        ch = chords[bi % 4]
        a = int(bi * bar * SR)
        if voice == 'pad':
            for p in ch:
                s = note(m(p), bar + 0.8, kind='pad')
                add(L, a, s, 0.9)
                add(R, a, s, 1.0)
            for j, p in enumerate([ch[2] + 12, ch[1] + 12, ch[2] + 12, ch[0] + 24]):
                s = note(m(p), beat * 1.2, kind='pluck') * 0.5
                b = a + int(j * beat * SR)
                add(L, b, s)
                add(R, b, s, 0.8)
        else:
            for j in range(8):
                p = ch[[0, 1, 2, 1, 2, 1, 0, 2][j]] + (12 if j % 2 else 0)
                s = note(m(p), beat, kind='pluck')
                b = a + int(j * beat / 2 * SR)
                add(L, b, s, 0.6)
                add(R, b, s, 0.55)
    if hats:
        for j in range(int(dur / (beat / 2)) + 1):
            b = int(j * beat / 2 * SR)
            h = rng.standard_normal(int(0.04 * SR)) * np.exp(-np.arange(int(0.04 * SR)) / SR / 0.01) * (0.5 if j % 2 else 0.25)
            add(L, b, h)
            add(R, b, h)
    out = np.stack([L[:n], R[:n]], axis=1)
    out *= 10 ** ((rms_dbfs - rms_db(out)) / 20)
    return np.clip(out, -1, 1)


def sting(rng):
    t = np.arange(int(1.5 * SR)) / SR
    s = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / d) for f, a, d in
            [(880, 1, 0.5), (1318.5, 0.7, 0.45), (1760, 0.5, 0.35), (2349, 0.3, 0.3), (110, 0.9, 0.25)])
    s += 0.4 * np.sin(2 * np.pi * (200 + 300 * np.minimum(t, 0.3)) * t) * np.exp(-t / 0.12)
    s *= 10 ** ((-12 - rms_db(s)) / 20) if rms_db(s) > -12 else 1
    s = s / np.max(np.abs(s)) * 0.5
    return np.stack([s, s], axis=1)


def vedit(inp, ref, rng):
    clips = [('clip_a.mp4', 'testsrc2=size=1280x720:rate=30', 12, 'sine=f=196:sample_rate=44100', 'testsrc2'),
             ('clip_b.mp4', 'gradients=size=1920x1080:rate=24:speed=0.03:seed=7', 10, 'sine=f=262:sample_rate=44100', 'gradients'),
             ('clip_c.mp4', 'rgbtestsrc=size=720x1280:rate=30', 8, 'sine=f=330:sample_rate=44100', 'rgbtestsrc'),
             ('clip_d.mp4', 'yuvtestsrc=size=1280x720:rate=25', 9, 'sine=f=392:sample_rate=44100', 'yuvtestsrc')]
    for name, vsrc, dur, asrc, _ in clips:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', vsrc, '-f', 'lavfi', '-i', asrc + ',volume=0.2', '-t', str(dur),
                        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
                        os.path.join(inp, name)], check=True)
    write_wav(os.path.join(inp, 'music.wav'), music('pad_c', 45.0, rng, -18.0))


def build(task):
    g = task.get('gen')
    if not g:
        return
    tid = task['id']
    inp, ref = os.path.join(E, 'inputs', tid), os.path.join(E, 'ref', tid)
    if os.path.exists(os.path.join(ref, 'meta.json')):
        return
    os.makedirs(inp, exist_ok=True)
    os.makedirs(ref, exist_ok=True)
    rng = np.random.default_rng(g.get('seed', 1))
    meta = {'task': tid, 'kind': g['kind']}
    if g['kind'] == 'vedit':
        vedit(inp, ref, rng)
    else:
        x = source()
        if g['kind'] == 'clean':
            v = set_speech_rms(segment(x, g['voice_start'], g['dur']), -22.0)
            clean, bad = degrade(v, g, rng)
            write_wav(os.path.join(inp, 'voice_raw.wav'), bad)
            write_wav(os.path.join(ref, 'clean.wav'), clean)
            meta.update(voice='voice_raw.wav', clean='clean.wav', pops=g['pops'], hum_hz=g['hum_hz'],
                        clipped_in=int(np.sum(np.abs(bad) >= 0.9995)))
        elif g['kind'] == 'duck':
            v = set_speech_rms(segment(x, g['voice_start'], g['dur']), -24.0)
            write_wav(os.path.join(inp, 'voice.wav'), v)
            write_wav(os.path.join(inp, 'music.wav'), music(g['music'], g['music_dur'], rng, g['music_rms_db']))
            meta.update(voices=['voice.wav'], music='music.wav', voice_dur=len(v) / SR)
        elif g['kind'] == 'spot':
            names = []
            for i, (s, d) in enumerate(g['lines'], start=1):
                v = set_speech_rms(segment(x, s, d), -22.0)
                write_wav(os.path.join(inp, f'line{i}.wav'), v)
                names.append(f'line{i}.wav')
            write_wav(os.path.join(inp, 'music.wav'), music(g['music'], g['music_dur'], rng, g['music_rms_db']))
            write_wav(os.path.join(inp, 'sting.wav'), sting(rng))
            meta.update(voices=names, music='music.wav', sting='sting.wav')
    json.dump(meta, open(os.path.join(ref, 'meta.json'), 'w'), indent=1)
    print('made', tid)


if __name__ == '__main__':
    for p in sys.argv[1:]:
        for t in json.load(open(p)):
            build(t)
