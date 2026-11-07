# SPDX-License-Identifier: AGPL-3.0-only
"""Objective scores for sound-effect and music tasks, numpy only: score_sound.py <task id> <script> [--tasks a.json b.json]

The responder's script (make.py or make.sh) is run here in a temp folder with no network (score_media.run_script) and must write
out.wav. The output is then measured; the judge cannot hear, so it gets these numbers and spectrogram pictures (spectrogram_png).

All tasks: length, integrated loudness and true peak (ffmpeg ebur128), clipped samples, dead air, a hard cut at the end.
Sound effects (`kind: sfx`, `effect`): spectral checks for the effect.
  chime    a clear pitch: the loudest frame's strongest peak stands 18 dB above its neighbours; two or more steps, the last one
           higher than the first; a fast attack (-6 dB within 80 ms) and a decay
  page     noise, not tone: spectral flatness and centroid in a band, short, no tonal peak
  rain     broadband (energy within 35 dB across the octave bands 250 Hz to 8 kHz), no tonal peak in the long-term spectrum,
           steady level (1 s RMS varies by at most 2.5 dB), droplets (the 4 to 8 kHz band's 5 ms envelope varies more than
           filtered noise does: coefficient of variation above 0.35)
  whoosh   noisy, the spectral centroid rises then falls (peak between 25 and 75 percent of the sound, at least 1.8 times the start
           and 1.5 times the end), and the level peaks in the middle
  bell     partials ring: a clear pitch and an RMS tail still within 30 dB of the peak at least 1 s after it
Music (`kind: music`): tempo (onset autocorrelation with a harmonic sum; right within 5 percent of the asked BPM, or at half or
double it, which is reported), key (the share of chroma energy inside the asked key's scale, at least 0.85 in the whole piece
and 0.8 in each third, and that scale holding more energy than any other seven-note scale; the Krumhansl-Schmuckler estimate is reported), and the chroma is the 12 pitch classes from spectral
peaks between 80 Hz and 2 kHz at A = 440 Hz, leaving out a peak that is the 2nd to 6th harmonic of a stronger one below it."""
import json, os, re, sys
import numpy as np
from PIL import Image, ImageDraw
from audiolib import read_audio, db
import score_audio as sa

NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
MAJOR_SET, MINOR_SET = [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10, 11]  # the minor set includes the raised seventh


def stft(x, n=2048, hop=512, sr=44100):
    w = np.hanning(n)
    m = 1 + (len(x) - n) // hop if len(x) >= n else 0
    if m <= 0:
        x = np.pad(x, (0, n - len(x) + hop))
        m = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(m)[:, None]
    S = np.abs(np.fft.rfft(x[idx] * w, axis=1)).T  # (bins, frames)
    return np.fft.rfftfreq(n, 1 / sr), S


def frame_rms_db(x, sr, win=0.02):
    n = int(sr * win)
    m = len(x) // n
    f = x[:m * n].reshape(m, n).astype(np.float64)
    return db(np.sqrt(np.mean(f * f, axis=1) + 1e-18))


def peak_prominence_db(f, s, lo=200, hi=8000, width_hz=150):
    """How far the strongest spectral peak stands above the median of its neighbours (dB), and its frequency."""
    sel = (f >= lo) & (f <= hi)
    p = s[sel] ** 2
    ff = f[sel]
    i = int(np.argmax(p))
    near = p[(np.abs(ff - ff[i]) > 30) & (np.abs(ff - ff[i]) < width_hz)]
    return float(10 * np.log10(p[i] / (np.median(near) + 1e-20))), float(ff[i])


def flatness(S, f, lo=100, hi=16000):
    """Spectral flatness (geometric over arithmetic mean of the power) inside the band that holds the middle 90 percent of the
    sound's energy, so a filtered noise is judged on its own band: about 0.5 for noise, near 0 for a tone."""
    tot = (S ** 2).sum(axis=1)
    c = np.cumsum(tot) / (tot.sum() + 1e-20)
    lo, hi = max(lo, f[int(np.searchsorted(c, 0.05))]), min(hi, f[min(len(f) - 1, int(np.searchsorted(c, 0.95)))])
    if hi <= lo * 1.2:
        hi = lo * 1.5
    p = S[(f >= lo) & (f <= hi)] ** 2 + 1e-14
    return np.exp(np.mean(np.log(p), axis=0)) / np.mean(p, axis=0)


def centroid(S, f):
    return (f[:, None] * S).sum(axis=0) / (S.sum(axis=0) + 1e-12)


def band_cv(x, sr, lo, hi, win=0.005):
    """Coefficient of variation of a band's energy envelope in 5 ms frames: filtered noise is steady (about 0.2 here), droplets are not."""
    n = int(sr * win)
    f, S = stft(x, n=512, hop=n, sr=sr)
    e = (S[(f >= lo) & (f < hi)] ** 2).sum(axis=0)
    return float(np.std(e) / (np.mean(e) + 1e-20))


def pitch_track(f, S, rms_db_frames, floor=-35):
    """Strongest peak (200 Hz to 5 kHz) per frame where the frame is within `floor` dB of the loudest."""
    sel = (f >= 200) & (f <= 5000)
    ff = f[sel]
    out = []
    lvl = 20 * np.log10(S.sum(axis=0) + 1e-9)
    top = lvl.max()
    for k in range(S.shape[1]):
        out.append(float(ff[int(np.argmax(S[sel, k]))]) if lvl[k] > top + floor else 0.0)
    return np.array(out)


def plateaus(track, hop_s, min_s=0.04, tol=0.04):
    steps, cur = [], []
    for v in list(track) + [0.0]:
        if v > 0 and (not cur or abs(v / np.median(cur) - 1) < tol):
            cur.append(v)
        else:
            if len(cur) * hop_s >= min_s:
                steps.append(float(np.median(cur)))
            cur = [v] if v > 0 else []
    return steps


def sfx_metrics(x, sr, effect):
    m = {}
    f, S = stft(x, 2048, 512, sr)
    hop = 512 / sr
    lvl = frame_rms_db(x, sr, 0.02)
    m['peak_db'] = round(float(db(np.max(np.abs(x)))), 1)
    m['rms_db'] = round(float(db(np.sqrt(np.mean(x.astype(np.float64) ** 2)))), 1)
    act = lvl > lvl.max() - 40
    m['active_s'] = round(float(act.sum() * 0.02), 2)
    fl, ce = flatness(S, f), centroid(S, f)
    e = (S ** 2).sum(axis=0)
    on = e > e.max() * 1e-4
    m['flatness'] = round(float(np.median(fl[on])), 3) if on.any() else None
    m['centroid_hz'] = round(float(np.median(ce[on])), 0) if on.any() else None
    lt = (S ** 2).mean(axis=1)
    m['tonal_peak_db'] = round(peak_prominence_db(f, np.sqrt(lt), 150, 12000, 200)[0], 1)
    bands = [(250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000)]
    bl = [10 * np.log10(lt[(f >= a) & (f < b)].sum() + 1e-20) for a, b in bands]
    m['band_spread_db'] = round(float(max(bl) - min(bl)), 1)
    if effect in ('chime', 'bell'):
        k = int(np.argmax(e))
        m['pitch_prom_db'], m['pitch_hz'] = [round(v, 1) for v in peak_prominence_db(f, S[:, k])]
        tr = pitch_track(f, S, lvl)
        steps = plateaus(tr, hop)
        m['pitch_steps_hz'] = [round(s) for s in steps[:8]]
        m['pitch_rises'] = bool(len(steps) >= 2 and steps[-1] > steps[0] * 1.06)
        env = lvl
        pk = int(np.argmax(env))
        reach = np.flatnonzero(env >= env.max() - 6)
        m['attack_s'] = round(float(reach[0] * 0.02), 3)
        tail_i = min(len(env) - 1, pk + int(1.0 / 0.02))
        m['tail_1s_db'] = round(float(env[tail_i] - env.max()), 1) if pk + int(1.0 / 0.02) < len(env) else None
        m['end_db'] = round(float(env[-5:].mean() - env.max()), 1)
    if effect == 'rain':
        r = frame_rms_db(x, sr, 1.0)
        m['steady_db'] = round(float(np.std(r)), 2)
        m['droplet_cv'] = round(band_cv(x, sr, 4000, 8000), 3)
    if effect == 'whoosh':
        c = ce.copy()
        c[~on] = np.nan
        idx = np.flatnonzero(act_frames(e))
        if len(idx) > 6:
            lo, hi = idx[0], idx[-1] + 1
            cs = np.convolve(np.nan_to_num(c[lo:hi], nan=np.nanmedian(c[lo:hi])), np.ones(5) / 5, mode='same')
            pkc = int(np.argmax(cs))
            m['centroid_peak_at'] = round(pkc / len(cs), 2)
            m['centroid_rise'] = round(float(cs[pkc] / (np.mean(cs[:max(2, len(cs) // 10)]) + 1e-9)), 2)
            m['centroid_fall'] = round(float(cs[pkc] / (np.mean(cs[-max(2, len(cs) // 10):]) + 1e-9)), 2)
            m['level_peak_at'] = round(float(np.argmax(e[lo:hi]) / (hi - lo)), 2)
    return m


def act_frames(e):
    return e > e.max() * 10 ** (-30 / 10)


def sfx_checks(m, sc, effect, dur, tp):
    c = {}
    c['length'] = sc['dur'][0] <= dur <= sc['dur'][1]
    if sc.get('lufs') is not None:
        c['loudness'] = m.get('lufs') is not None and abs(m['lufs'] - sc['lufs']) <= sc.get('lufs_tol', 1.5)
    else:
        c['loudness'] = m['peak_db'] >= sc.get('peak_min', -12)
    c['true_peak_ok'] = tp is not None and tp <= -1.0 + 0.1
    c['not_silent'] = m['rms_db'] > -50 and m['active_s'] >= min(0.2, dur * 0.5)
    if effect == 'chime':
        c['clear_pitch'] = m['pitch_prom_db'] >= 18 and 400 <= m['pitch_hz'] <= 4000
        c['rising_steps'] = m['pitch_rises']
        c['fast_attack'] = m['attack_s'] <= 0.08
        c['decays'] = m['end_db'] <= -25
    elif effect == 'bell':
        c['clear_pitch'] = m['pitch_prom_db'] >= 18 and 500 <= m['pitch_hz'] <= 5000
        c['fast_attack'] = m['attack_s'] <= 0.05
        c['rings'] = m['tail_1s_db'] is not None and m['tail_1s_db'] >= -30
        c['decays'] = m['end_db'] <= -20
    elif effect == 'page':
        c['noisy'] = m['flatness'] is not None and m['flatness'] >= 0.12
        c['centroid_band'] = m['centroid_hz'] is not None and 1500 <= m['centroid_hz'] <= 9000
        c['no_tonal_peak'] = m['tonal_peak_db'] <= 22
    elif effect == 'rain':
        c['broadband'] = m['band_spread_db'] <= 35
        c['no_tonal_peak'] = m['tonal_peak_db'] <= 18
        c['steady'] = m['steady_db'] <= 2.5
        c['droplets'] = m['droplet_cv'] >= 0.35
    elif effect == 'whoosh':
        c['noisy'] = m['flatness'] is not None and m['flatness'] >= 0.1
        c['centroid_arc'] = (m.get('centroid_peak_at') is not None and 0.25 <= m['centroid_peak_at'] <= 0.75
                             and m['centroid_rise'] >= 1.8 and m['centroid_fall'] >= 1.5)
        c['level_peaks_mid'] = m.get('level_peak_at') is not None and 0.25 <= m['level_peak_at'] <= 0.9
    return c


# ---- music ----

def chroma(x, sr, n=8192, hop=4096):
    f, S = stft(x, n, hop, sr)
    sel = (f >= 80) & (f <= 2000)
    ff, SS = f[sel], S[sel]
    df = f[1] - f[0]
    C = np.zeros((12, SS.shape[1]))
    for k in range(SS.shape[1]):
        col = SS[:, k]
        pk = np.flatnonzero((col[1:-1] > col[:-2]) & (col[1:-1] >= col[2:]) & (col[1:-1] > col.max() * 0.05)) + 1
        kept = []  # ascending in frequency; a peak that sits on a harmonic (2 to 6 times) of a stronger kept one is that note's overtone
        for i in pk:
            a, b, c = np.log(col[i - 1] + 1e-12), np.log(col[i] + 1e-12), np.log(col[i + 1] + 1e-12)
            fi = ff[i] + df * 0.5 * (a - c) / (a - 2 * b + c + 1e-12)  # parabolic interpolation: a semitone at 80 Hz is under 5 Hz
            if any(abs(fi / q[0] - h) < 0.03 * h and q[1] >= 0.8 * col[i] for q in kept for h in (2, 3, 4, 5, 6)):
                continue
            kept.append((fi, col[i]))
            C[int(round(12 * np.log2(fi / 440.0) + 9)) % 12, k] += col[i]
    return C


def key_set(name):
    m = re.match(r'\s*([A-G][#b]?)\s*(major|minor)', name, re.I)
    t = NOTE.index({'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'}.get(m.group(1), m.group(1)))
    return t, m.group(2).lower(), {(t + i) % 12 for i in (MAJOR_SET if m.group(2).lower() == 'major' else MINOR_SET)}


def ks_best(c):
    c = c / (c.sum() + 1e-12)
    best = (-2, None)
    for t in range(12):
        for mode, prof in (('major', KS_MAJOR), ('minor', KS_MINOR)):
            r = float(np.corrcoef(c, np.roll(prof, t))[0, 1])
            if r > best[0]:
                best = (r, (t, mode))
    return best[1], best[0]


def tempo_estimate(x, sr):
    """BPM from the onset envelope's autocorrelation with a harmonic sum (lags k, 2k, 3k, 4k), 50 to 200 BPM."""
    n, hop = 1024, 256
    f, S = stft(x, n, hop, sr)
    mel = np.log1p(30 * np.stack([S[(f >= a) & (f < b)].sum(axis=0) for a, b in [(30, 150), (150, 400), (400, 1000), (1000, 2500), (2500, 6000), (6000, 12000)]]))
    flux = np.maximum(0, np.diff(mel, axis=1)).sum(axis=0)
    flux = flux - np.convolve(flux, np.ones(21) / 21, mode='same')
    flux = np.maximum(flux, 0)
    ac = np.correlate(flux, flux, mode='full')[len(flux) - 1:]
    ac = ac / (ac[0] + 1e-12)
    fps = sr / hop
    best, bs = 0, -1
    for bpm in np.arange(50, 200.01, 0.5):
        lag = 60 / bpm * fps
        s = 0
        for k, w in ((1, 1.0), (2, 0.7), (3, 0.5), (4, 0.4)):
            i = lag * k
            if int(i) + 1 < len(ac):
                s += w * (ac[int(i)] * (1 - (i - int(i))) + ac[int(i) + 1] * (i - int(i)))
        # a mild prior toward common dance and song tempi stops 30 or 240 beating the real one
        s *= np.exp(-0.5 * (np.log2(bpm / 100) / 0.9) ** 2)
        if s > bs:
            best, bs = bpm, s
    return float(best)


def music_metrics(x, sr, sc):
    m = {}
    m['tempo_bpm'] = round(tempo_estimate(x, sr), 1)
    C = chroma(x, sr)
    tot = C.sum(axis=1)
    m['chroma'] = [round(float(v), 3) for v in tot / (tot.sum() + 1e-12)]
    (t, mode), r = ks_best(tot)
    m['key_estimate'] = f'{NOTE[t]} {mode}'
    m['key_corr'] = round(r, 2)
    if sc.get('key'):
        kt, kmode, kset = key_set(sc['key'])
        share = float(sum(tot[i] for i in kset) / (tot.sum() + 1e-12))
        m['in_key_share'] = round(share, 3)
        thirds = np.array_split(C, 3, axis=1)
        sh = []
        for part in thirds:
            tt = part.sum(axis=1)
            sh.append(float(sum(tt[i] for i in kset) / (tt.sum() + 1e-12)))
        m['in_key_thirds'] = [round(v, 2) for v in sh]
        # the asked scale must hold more of the energy than any other seven-note scale (a neighbour on the circle of fifths shares
        # six notes, so this is what tells G major from C major); the Krumhansl-Schmuckler estimate is reported but not decisive
        nat = {(kt + i) % 12 for i in ([0, 2, 4, 5, 7, 9, 11] if kmode == 'major' else [0, 2, 3, 5, 7, 8, 10])}
        shares = {r: float(sum(tot[(r + i) % 12] for i in MAJOR_SET[:7]) / (tot.sum() + 1e-12)) for r in range(12)}
        asked = next(r for r in range(12) if {(r + i) % 12 for i in MAJOR_SET[:7]} == nat)
        m['best_scale_share'] = round(max(shares.values()), 3)
        m['scale_is_best'] = bool(shares[asked] >= max(v for r, v in shares.items() if r != asked) - 0.02)
    lvl = frame_rms_db(x, sr, 0.05)
    m['dead_air_s'] = round(float(((lvl < -60).sum()) * 0.05), 2)
    m['end_peak_db'] = round(float(db(np.max(np.abs(x[-int(0.01 * sr):])))), 1)
    m['rms_db'] = round(float(db(np.sqrt(np.mean(x.astype(np.float64) ** 2)))), 1)
    m['active_frac'] = round(float((lvl > lvl.max() - 45).mean()), 2)
    return m, C


def music_checks(m, sc, dur, tp):
    c = {}
    c['length'] = abs(dur - sc['dur']) <= sc.get('dur_tol', 2.0)
    c['loudness'] = m.get('lufs') is not None and abs(m['lufs'] - sc['lufs']) <= sc.get('lufs_tol', 1.5)
    c['true_peak_ok'] = tp is not None and tp <= -1.0 + 0.1
    c['not_silent'] = m['rms_db'] > -45 and m['dead_air_s'] <= 1.0 and m['active_frac'] >= 0.9
    c['no_hard_cut'] = m['end_peak_db'] <= -30
    if sc.get('bpm'):
        b, t = m['tempo_bpm'], sc['bpm']
        oct_ = [k for k in (1, 2, 0.5) if abs(b / (t * k) - 1) <= 0.05]
        m['tempo_octave'] = oct_[0] if oct_ else None
        c['tempo'] = bool(oct_)
    if sc.get('key'):
        c['key'] = m['in_key_share'] >= 0.85 and all(v >= 0.8 for v in m['in_key_thirds']) and m['scale_is_best']
    return c


# ---- the picture for the judge ----

def _cmap():
    stops = [(0, (4, 3, 20)), (0.25, (60, 15, 110)), (0.5, (160, 40, 100)), (0.75, (240, 130, 40)), (1.0, (252, 250, 190))]
    xs = np.linspace(0, 1, 256)
    out = np.zeros((256, 3))
    for ch in range(3):
        out[:, ch] = np.interp(xs, [s[0] for s in stops], [s[1][ch] for s in stops])
    return out.astype(np.uint8)


def spectrogram_png(x, sr, path, C=None, title=''):
    """Waveform envelope, a log-frequency spectrogram (40 Hz to 16 kHz, 70 dB range) and, for music, a chromagram, with axes."""
    n, W, H = 2048, 900, 260
    hop = max(256, int(len(x) / W))
    f, S = stft(x, n, hop, sr)
    S = S[:, :W] if S.shape[1] >= W else np.pad(S, ((0, 0), (0, W - S.shape[1])), constant_values=1e-9)
    fl = np.geomspace(40, min(16000, sr / 2 - 100), H)
    rows = np.stack([np.interp(fl, f, S[:, k]) for k in range(S.shape[1])], axis=1)
    d = 20 * np.log10(rows + 1e-9)
    d = np.clip((d - (d.max() - 70)) / 70, 0, 1)
    img = _cmap()[(d[::-1] * 255).astype(int)]
    cols = img.shape[1]
    # envelope strip
    env = frame_rms_db(x, sr, max(0.01, len(x) / sr / W))
    env = np.interp(np.linspace(0, len(env) - 1, cols), np.arange(len(env)), env)
    strip = np.full((70, cols, 3), 18, np.uint8)
    top = env.max()
    for i, v in enumerate(env):
        h = int(np.clip((v - (top - 60)) / 60, 0, 1) * 66)
        strip[70 - h:, i] = (90, 200, 120)
    parts = [strip, img]
    if C is not None:
        Cn = C / (C.max(axis=0, keepdims=True) + 1e-9)
        Cn = np.stack([np.interp(np.linspace(0, Cn.shape[1] - 1, cols), np.arange(Cn.shape[1]), Cn[r]) for r in range(12)])
        ch = np.repeat(_cmap()[(Cn[::-1] * 255).astype(int)], 14, axis=0)
        parts.append(ch)
    body = np.concatenate(parts, axis=0)
    pad_l, pad_t = 56, 22
    canvas = Image.new('RGB', (cols + pad_l + 8, body.shape[0] + pad_t + 24), (14, 14, 14))
    canvas.paste(Image.fromarray(body), (pad_l, pad_t))
    dr = ImageDraw.Draw(canvas)
    dr.text((pad_l, 4), (title + '   ' if title else '') + 'waveform level, spectrogram (log frequency), ' + ('chromagram (C at the bottom row top to B)' if C is not None else ''), fill=(220, 220, 220))
    for hz in (100, 1000, 10000):
        y = pad_t + 70 + (H - 1) - int(np.log(hz / 40) / np.log(fl[-1] / 40) * (H - 1))
        dr.line([(pad_l - 4, y), (pad_l, y)], fill=(200, 200, 200))
        dr.text((4, y - 5), f'{hz // 1000}k' if hz >= 1000 else str(hz), fill=(200, 200, 200))
    dur = len(x) / sr
    step = 1 if dur <= 12 else 5
    for s in np.arange(0, dur + 1e-6, step):
        xx = pad_l + int(s / dur * (cols - 1))
        dr.line([(xx, canvas.height - 24), (xx, canvas.height - 19)], fill=(200, 200, 200))
        dr.text((xx - 6, canvas.height - 16), f'{s:g}s', fill=(200, 200, 200))
    if C is not None:
        y0 = pad_t + 70 + H
        for r in range(12):
            dr.text((pad_l - 22, y0 + (11 - r) * 14), NOTE[r], fill=(200, 200, 200))
    canvas.save(path)


def score(tid, script_dir, tasks, run_dir=None):
    import score_media as sm
    task = next(t for t in tasks if t['id'] == tid)
    sc = task['score']
    ok, secs, tmp, log, code, name = sm.run_script(tid, script_dir, task['deliverable'], 'out.wav', timeout=180)
    res = {'task': tid, 'ran': ok, 'exit_code': code, 'seconds': secs, 'script': name, 'log_tail': log[-400:]}
    checks = {'wrote_out_wav': ok}
    if ok:
        out = os.path.join(tmp, 'out.wav')
        try:
            dur, ch, sr = sa.probe(out)
            lufs, tp = sa.loudness(out)
            xs = read_audio(out, sr=sr or 44100, channels=None)
            x = read_audio(out, sr=sr or 44100)
            res.update(dur=round(dur, 2), channels=ch, sr=sr, lufs=lufs, tp=tp, clip_count=int(np.sum(np.abs(xs) >= 0.9995)))
            checks['no_clipping'] = res['clip_count'] == 0
            if sc['kind'] == 'sfx':
                mm = sfx_metrics(x, sr, sc['effect'])
                mm['lufs'] = lufs
                res.update({k: v for k, v in mm.items() if k != 'lufs'})
                checks.update(sfx_checks(mm, sc, sc['effect'], dur, tp))
                C = None
            else:
                mm, C = music_metrics(x, sr, sc)
                mm['lufs'] = lufs
                checks.update(music_checks(mm, sc, dur, tp))
                res.update({k: v for k, v in mm.items() if k not in ('lufs', 'chroma')})
                res['chroma'] = mm['chroma']
            if run_dir:
                spectrogram_png(x, sr, os.path.join(run_dir, 'spec.png'), C, title=task['id'])
        except Exception as e:
            res['score_error'] = f'{type(e).__name__}: {e}'
            checks['measurable'] = False
    res['checks'] = checks
    res['passed'], res['total'] = sum(checks.values()), len(checks)
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    return res
