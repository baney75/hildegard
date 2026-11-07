# SPDX-License-Identifier: AGPL-3.0-only
"""Objective scores for an audio task: score_audio.py <task id> <script> [--tasks tasks.json heldout.json] > metrics.json

The responder's process.sh is run here, not trusted: copied into a temp folder holding only the task's input files, then
`unshare -rn bash process.sh` (no network) under a 120 s timeout. Its out.wav is measured:

  ran, dur, channels, sr     did it run, how long, what format
  lufs, lufs_err, tp         integrated loudness and true peak (ffmpeg ebur128), error against the brief's target
  clip_count                 samples at full scale in the decoded output
  clean tasks (compared with the clean reference, over the clean file's own speech and pause frames):
    hum_prom_db              how far the 60/120/180 Hz peaks stand above the noise around them, in the pauses
    pause_gap_db             speech level minus pause level (bigger is quieter pauses)
    rumble_rel_db            energy below 70 Hz in the pauses, relative to speech level
    fidelity                 STOI-like speech fidelity against the clean reference, 0 to 1 (see stoi_like)
    dip_gap_db               speech level inside the quiet stretches minus outside (0 means evened out)
    pop_rel_db               loudest sample near each pop, relative to speech level
  duck and spot tasks: the voice and music files are located in the output by cross-correlation, then fitted window by
  window (least squares) so the music's gain can be read while the voice speaks and while it doesn't:
    voice_at, music_found    where the voice starts; whether the music is there
    duck_db                  music gain in the gaps (80th percentile) minus music gain under speech (median)
    vmr_db                   voice level minus music level while the voice speaks
    voice_fidelity           STOI-like fidelity of the original voice inside the mix
    end_peak_db              peak in the last 10 ms (a hard cut shows here)
  spot tasks also: order_ok, sting_at.

`checks` turns those into pass/fail booleans; `passed` and `total` count them. Limits: the fit assumes the voice and music
are placed once, unchanged except for gain and mild filtering; a script that loops the music is scored on the first pass."""
import json, os, re, shutil, subprocess, sys, tempfile, time
import numpy as np
from audiolib import SR, read_audio, rms_db, db, frame_db, pause_frames, welch, segments_from_frames

E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
HERE = os.path.dirname(os.path.abspath(__file__))


def run_script(task_id, script, out_name, timeout=120):
    """Run the responder's script on a fresh copy of the inputs. Returns (ok, seconds, folder, log)."""
    tmp = tempfile.mkdtemp(prefix=f'creative-{task_id}-')
    for f in os.listdir(os.path.join(E, 'inputs', task_id)):
        shutil.copy(os.path.join(E, 'inputs', task_id, f), tmp)
    shutil.copy(script, os.path.join(tmp, 'process.sh'))
    env = {'PATH': '/usr/bin:/bin:/usr/local/bin', 'HOME': tmp, 'LANG': 'C.UTF-8', 'TMPDIR': tmp}
    cmd = ['bash', 'process.sh']
    if shutil.which('unshare') and subprocess.run(['unshare', '-rn', 'true']).returncode == 0:
        cmd = ['unshare', '-rn'] + cmd
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True, timeout=timeout)
        log, code = (r.stdout + r.stderr)[-1500:], r.returncode
    except subprocess.TimeoutExpired:
        log, code = f'timed out after {timeout} s', -9
    ok = os.path.exists(os.path.join(tmp, out_name)) and os.path.getsize(os.path.join(tmp, out_name)) > 1000
    return ok, round(time.time() - t0, 1), tmp, log, code


def loudness(path):
    r = subprocess.run(['ffmpeg', '-nostats', '-hide_banner', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True)
    t = r.stderr[r.stderr.rfind('Summary:'):]
    i = re.search(r'I:\s+(-?[\d.]+) LUFS', t)
    p = re.search(r'True peak:\s+Peak:\s+(-?[\d.]+) dBFS', t)
    return (float(i.group(1)) if i else None), (float(p.group(1)) if p else None)


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate:format=duration',
                        '-of', 'json', path], capture_output=True, text=True)
    d = json.loads(r.stdout or '{}')
    s = (d.get('streams') or [{}])[0]
    return float(d.get('format', {}).get('duration', 0) or 0), int(s.get('channels', 0)), int(s.get('sample_rate', 0))


def stoi_like(ref, deg, sr=16000, skip_s=(), N=30):
    """A simplified STOI. Both signals are cut into 1/3-octave band envelopes (15 bands from 150 Hz, 512-point STFT, 8 ms hop).
    In 30-frame segments (about 240 ms) of the reference that carry speech, each band's degraded envelope is rescaled to the
    reference's energy, clipped at 6.6x the reference (STOI's -15 dB floor), and correlated with the reference. The mean over
    bands and segments is the score: 1 for the same envelope; white noise scores about 0.4 (the clipping step pulls it toward the
    reference) and unrelated speech about 0.2. It ignores level (so loudness changes cost nothing) and phase, and it is not the
    standardized STOI, so use it to rank, not as an absolute."""
    n = min(len(ref), len(deg))
    ref, deg = ref[:n], deg[:n]
    nfft, hop = 512, 128
    win = np.hanning(nfft)
    fr = np.fft.rfftfreq(nfft, 1 / sr)
    bands = [(150 * 2 ** ((k - 0.5) / 3), 150 * 2 ** ((k + 0.5) / 3)) for k in range(15)]

    def env(x):
        idx = np.arange(0, len(x) - nfft, hop)[:, None] + np.arange(nfft)
        P = np.abs(np.fft.rfft(x[idx] * win, axis=1)) ** 2
        return np.stack([np.sqrt(P[:, (fr >= lo) & (fr < hi)].sum(axis=1)) for lo, hi in bands])
    X, Y = env(ref.astype(np.float64)), env(deg.astype(np.float64))
    energy = 20 * np.log10(np.sqrt((X ** 2).sum(axis=0)) + 1e-9)
    ok = energy > energy.max() - 40
    scores = []
    for s in range(0, X.shape[1] - N, N // 2):
        if ok[s:s + N].mean() < 0.6:
            continue
        t0, t1 = s * hop / sr, (s + N) * hop / sr
        if any(a - 0.3 < t1 and b + 0.3 > t0 for a, b in skip_s):
            continue
        c = []
        for k in range(15):
            x, y = X[k, s:s + N], Y[k, s:s + N]
            a = np.linalg.norm(x) / (np.linalg.norm(y) + 1e-12)
            y = np.minimum(y * a, x * 6.6)
            x, y = x - x.mean(), y - y.mean()
            c.append(float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-12)))
        scores.append(np.mean(c))
    return float(np.mean(scores)) if scores else None


def hum_prominence(x, mask, f0):
    segs = segments_from_frames(x, mask)
    f, p = welch(segs)
    if f is None:
        return None
    out = []
    for k in (1, 2, 3):
        c = f0 * k
        peak = p[(f > c - 6) & (f < c + 6)].max()
        near = p[((f > c - 45) & (f < c - 12)) | ((f > c + 12) & (f < c + 45))]
        out.append(10 * np.log10(peak / (np.median(near) + 1e-20)))
    return float(np.mean(out))


def band_rel(x, pause_mask, speech_db, lo_hz=0, hi_hz=70):
    f, p = welch(segments_from_frames(x, pause_mask))
    if f is None:
        return None
    tot = p[(f >= lo_hz) & (f < hi_hz)].sum() / (8192 * 8192 * 0.375)  # Hann window power, so this is mean-square
    return float(10 * np.log10(tot + 1e-20) - speech_db)


def frames_rms(x, mask):
    n = int(SR * 0.02)
    v = np.concatenate([x[i * n:(i + 1) * n] for i in np.flatnonzero(mask) if (i + 1) * n <= len(x)]) if mask.any() else x
    return rms_db(v)


def region_mask(nframes, regions, pad=0.0):
    m = np.zeros(nframes, bool)
    for a, b in regions:
        m[max(0, int((a - pad) / 0.02)):int((b + pad) / 0.02)] = True
    return m


def align(y, ref, sr, max_s=0.3):
    """Shift y so it lines up with ref. A filter's lookahead delays the output by a few milliseconds; that should not
    count against the script. Returns y moved by the best lag within +/- max_s seconds."""
    k = int(max_s * sr)
    a, pa = xcorr_lag(y, ref, k)
    b, pb = xcorr_lag(ref, y, k)
    if pa >= pb:
        y = y[a:]
    else:
        y = np.concatenate([np.zeros(b), y])
    return y[:len(ref)] if len(y) >= len(ref) else np.concatenate([y, np.zeros(len(ref) - len(y))])


def clean_metrics(task, tid, out):
    meta = json.load(open(os.path.join(E, 'ref', tid, 'meta.json')))
    g = task['gen']
    clean = read_audio(os.path.join(E, 'ref', tid, meta['clean']))
    inp = read_audio(os.path.join(E, 'inputs', tid, meta['voice']))
    y = read_audio(out)
    m = {'len_diff_s': round(abs(len(y) - len(clean)) / SR, 2)}
    y = align(y, clean, SR)
    pause, speech = pause_frames(clean)
    n = min(len(pause), len(y) // int(SR * 0.02))
    pause, speech = pause[:n], speech[:n]
    dips = region_mask(n, [(a, b) for a, b, _ in g['dips']], 0.0)
    f0 = g['hum_hz']
    pop_s = [(p - 0.05, p + 0.25) for p in g['pops']]
    pops = region_mask(n, pop_s)
    for tag, x in (('in', inp), ('out', y)):
        sp = frames_rms(x, speech & ~dips & ~pops)
        m[f'speech_{tag}_db'] = round(sp, 1)
        m[f'pause_gap_{tag}_db'] = round(sp - frames_rms(x, pause), 1)
        m[f'hum_prom_{tag}_db'] = round(hum_prominence(x, pause, f0), 1)
        if g.get('rumble_rms'):
            m[f'rumble_rel_{tag}_db'] = round(band_rel(x, pause, sp), 1)
        dip_sp = frames_rms(x, speech & dips) if (speech & dips).any() else sp
        m[f'dip_gap_{tag}_db'] = round(dip_sp - sp, 1)
        pk = max(float(np.max(np.abs(x[int(a * SR):int(b * SR)]))) for a, b in pop_s)
        m[f'pop_rel_{tag}_db'] = round(float(db(pk)) - sp, 1)
        c16 = read_audio(os.path.join(E, 'ref', tid, meta['clean']), sr=16000)
        x16 = read_audio(os.path.join(E, 'inputs', tid, meta['voice']), sr=16000) if tag == 'in' else align(read_audio(out, sr=16000), c16, 16000)
        m[f'fidelity_{tag}'] = None if m['len_diff_s'] > 0.3 and tag == 'out' else (lambda v: None if v is None else round(v, 3))(stoi_like(c16, x16, skip_s=pop_s))
    return m


def xcorr_lag(o, s, max_lag):
    """Sample lag at which s best matches o (o delayed by lag relative to s), and the peak's prominence."""
    N = 1 << int(np.ceil(np.log2(len(o) + len(s))))
    c = np.fft.irfft(np.fft.rfft(o, N) * np.conj(np.fft.rfft(s, N)), N)[:max_lag]
    i = int(np.argmax(np.abs(c)))
    return i, float(np.abs(c[i]) / (np.std(c) + 1e-12))


def place(o_len, s, lag):
    r = np.zeros(o_len)
    a = max(lag, 0)
    n = min(len(s), o_len - a)
    if n > 0:
        r[a:a + n] = s[:n]
    return r


def mix_metrics(task, tid, out):
    meta = json.load(open(os.path.join(E, 'ref', tid, 'meta.json')))
    sr = 16000
    o = read_audio(out, sr=sr)
    voices = [read_audio(os.path.join(E, 'inputs', tid, v), sr=sr) for v in meta['voices']]
    music = read_audio(os.path.join(E, 'inputs', tid, meta['music']), sr=sr)
    m = {}
    lags, bad = [], False
    for v in voices:
        i, prom = xcorr_lag(o, v, len(o))
        lags.append(i)
        bad |= prom < 6
    m['voice_at'] = [round(i / sr, 2) for i in lags]
    m['voice_found'] = not bad
    Rv = sum(place(len(o), v, l) for v, l in zip(voices, lags))
    mi, mprom = xcorr_lag(o, music, len(o))
    m['music_found'] = mprom > 6
    Rm = place(len(o), music, mi)
    if meta.get('sting'):
        st = read_audio(os.path.join(E, 'inputs', tid, meta['sting']), sr=sr)
        si, sprom = xcorr_lag(o, st, len(o))
        m['sting_at'] = round(si / sr, 2) if sprom > 6 else None
        m['order_ok'] = bool(not bad and all(lags[k] + len(voices[k]) <= lags[k + 1] + int(0.1 * sr) for k in range(len(lags) - 1)))
    W = int(sr * (0.25 if meta.get('sting') else 0.5))
    vref = np.concatenate(voices)
    v_speech_db = rms_db(vref[np.abs(vref) > 0.01]) if (np.abs(vref) > 0.01).any() else rms_db(vref)
    gm, vm, rows = [], [], []
    for a in range(0, len(o) - W, W):
        A = np.stack([Rv[a:a + W], Rm[a:a + W]], axis=1)
        y = o[a:a + W]
        rv, rm = rms_db(A[:, 0]), rms_db(A[:, 1])
        if rm < -60:
            continue
        sol = np.linalg.lstsq(A, y, rcond=None)[0] if rv > -70 else np.array([0.0, float(A[:, 1] @ y / (A[:, 1] @ A[:, 1] + 1e-12))])
        rows.append((rv, rm, abs(sol[0]), abs(sol[1])))
    rows = np.array(rows) if rows else np.zeros((0, 4))
    if len(rows):
        speech = rows[:, 0] > v_speech_db - 12
        gap = rows[:, 0] < v_speech_db - 40
        gmdb = db(rows[:, 3])
        if speech.sum() >= 2 and gap.sum() >= 1:
            m['duck_db'] = round(float(np.percentile(gmdb[gap], 80) - np.median(gmdb[speech])), 1)
        if speech.sum() >= 2:
            vdb = rows[speech, 0] + db(rows[speech, 2])
            mdb = rows[speech, 1] + gmdb[speech]
            m['vmr_db'] = round(float(np.median(vdb - mdb)), 1)
    vf = stoi_like(Rv, o, sr=sr)
    m['voice_fidelity'] = None if vf is None else round(vf, 3)
    tail = o[-int(0.01 * sr):]
    m['end_peak_db'] = round(float(db(np.max(np.abs(tail)))), 1) if len(tail) else None
    m['voice_end_s'] = round(max(l + len(v) for v, l in zip(voices, lags)) / sr, 2)
    return m


def score(tid, script, tasks):
    task = next(t for t in tasks if t['id'] == tid)
    sc = task['score']
    ok, secs, tmp, log, code = run_script(tid, script, 'out.wav')
    res = {'task': tid, 'ran': ok, 'exit_code': code, 'seconds': secs, 'log_tail': log[-400:]}
    checks = {'wrote_out_wav': ok}
    if ok:
        out = os.path.join(tmp, 'out.wav')
        try:
            dur, ch, sr = probe(out)
            lufs, tp = loudness(out)
            x = read_audio(out, sr=sr or SR, channels=None)
            res.update(dur=round(dur, 2), channels=ch, sr=sr, lufs=lufs, tp=tp, clip_count=int(np.sum(np.abs(x) >= 0.9995)))
            res['lufs_err'] = None if lufs is None else round(lufs - sc['lufs'], 2)
            checks['loudness_within_1LU'] = lufs is not None and abs(lufs - sc['lufs']) <= 1.0
            checks['true_peak_ok'] = tp is not None and tp <= sc['tp'] + 0.1
            checks['no_clipping'] = res['clip_count'] == 0
            if sc['kind'] == 'clean':
                m = clean_metrics(task, tid, out)
                res.update(m)
                checks['same_length'] = m['len_diff_s'] <= 0.25
                checks['hum_gone'] = m['hum_prom_out_db'] <= 6.0
                checks['pauses_quieter'] = m['pause_gap_out_db'] >= m['pause_gap_in_db'] + 3
                checks['speech_kept'] = m['fidelity_out'] is not None and m['fidelity_out'] >= (m['fidelity_in'] or 0) - 0.08
                checks['levels_evened'] = abs(m['dip_gap_out_db']) <= 4.0
                checks['pop_tamed'] = m['pop_rel_out_db'] <= m['pop_rel_in_db'] - 6
                if 'rumble_rel_out_db' in m:
                    checks['rumble_gone'] = m['rumble_rel_out_db'] <= m['rumble_rel_in_db'] - 15
                if ch != task.get('out_channels', ch):
                    checks['channels'] = False
            else:
                m = mix_metrics(task, tid, out)
                res.update(m)
                checks['voice_present'] = m['voice_found']
                checks['music_present'] = m['music_found']
                checks['ducks'] = m.get('duck_db') is not None and m['duck_db'] >= sc['min_duck_db']
                checks['voice_above_music'] = m.get('vmr_db') is not None and m['vmr_db'] >= sc['min_vmr_db']
                checks['voice_intact'] = m['voice_fidelity'] is not None and m['voice_fidelity'] >= 0.6
                checks['ends_cleanly'] = m['end_peak_db'] is not None and m['end_peak_db'] <= -30
                if sc['kind'] == 'duck' and sc.get('tail'):
                    checks['voice_start'] = abs(m['voice_at'][0] - sc['voice_start']) <= 0.75
                    checks['tail_length'] = abs((dur - m['voice_end_s']) - sc['tail']) <= 1.5
                if sc.get('total'):
                    checks['voice_start'] = abs(m['voice_at'][0] - sc['voice_start']) <= 0.75
                    checks['length'] = abs(dur - sc['total']) <= sc['dur_tol']
                if sc['kind'] == 'spot':
                    checks['length'] = abs(dur - sc['dur']) <= sc['dur_tol']
                    checks['lines_in_order'] = bool(m['order_ok'])
                    checks['sting_at_end'] = m['sting_at'] is not None and 12.2 <= m['sting_at'] <= 14.2
        except Exception as e:  # a corrupt or odd output is a scored failure, not a crash
            res['score_error'] = f'{type(e).__name__}: {e}'
            checks['measurable'] = False
    res['checks'] = checks
    res['passed'], res['total'] = sum(checks.values()), len(checks)
    shutil.rmtree(tmp, ignore_errors=True)
    return res


if __name__ == '__main__':
    args = sys.argv[1:]
    paths = args[args.index('--tasks') + 1:] if '--tasks' in args else [os.path.join(HERE, 'tasks.json'), os.path.join(HERE, 'heldout.json')]
    tasks = [t for p in paths for t in json.load(open(p))]
    json.dump(score(args[0], args[1], tasks), sys.stdout, indent=1)
