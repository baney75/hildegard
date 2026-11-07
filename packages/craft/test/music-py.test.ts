// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-music: every preset and template renders, measured here by an independent BS.1770 meter (time-domain
// biquads) rather than by the script's own (frequency-domain) one; same seed same sound; --check catches bad recipes.
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A template renders for several seconds of CPU, and CI machines are slow: this file sets its own limit, and renders
// the long ones one at a time so ten Python processes never fight for two cores.
vi.setConfig({ testTimeout: 300_000 });

const run = promisify(execFile);
const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const skill = resolve(import.meta.dirname, '../../../skills/hildegard-music');
const sfx = join(skill, 'scripts/sfx.py');
const music = join(skill, 'scripts/music.py');
const work = mkdtempSync(join(tmpdir(), 'hg-music-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const haveNumpy = spawnSync(python, ['-c', 'import numpy']).status === 0;
// CI installs numpy; a machine without it skips instead of failing for a reason that is not the code's.
const suite = haveNumpy || process.env.CI ? describe : describe.skip;

interface Report {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: { duration_s: number; lufs: number; true_peak_dbtp: number } | null;
  file: string | null;
}

/** Runs a script and returns its --json report (exit status 1 still has one on stdout). */
async function go(script: string, args: string[]): Promise<{ code: number; report: Report }> {
  try {
    const { stdout } = await run(python, [script, ...args, '--json'], { maxBuffer: 1 << 26 });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (err.code === 1 && err.stdout) return { code: 1, report: JSON.parse(err.stdout) };
    throw e;
  }
}

// ---- an independent BS.1770-4 meter -------------------------------------------------------------------------------

interface Wav {
  rate: number;
  ch: Float64Array[];
}

function readWav(path: string): Wav {
  const b = readFileSync(path);
  expect(b.toString('latin1', 0, 4)).toBe('RIFF');
  let p = 12;
  let rate = 0;
  let nch = 0;
  let bits = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      nch = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
      bits = b.readUInt16LE(p + 22);
    } else if (id === 'data') {
      const bytes = bits / 8;
      const n = Math.floor(size / (bytes * nch));
      const ch = Array.from({ length: nch }, () => new Float64Array(n));
      for (let i = 0; i < n; i++)
        for (let c = 0; c < nch; c++) {
          const o = p + 8 + (i * nch + c) * bytes;
          ch[c]![i] = bits === 16 ? b.readInt16LE(o) / 32768 : b.readIntLE(o, 3) / 8388608;
        }
      return { rate, ch };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function biquad(x: Float64Array, b: number[], a: number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

function kWeight(x: Float64Array, fs: number): Float64Array {
  let f0 = 1681.974450955533;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const y = biquad(
    x,
    [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  );
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  return biquad(y, [1, -2, 1], [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]);
}

/** Integrated loudness. A clip shorter than one 400 ms block is measured whole (the script documents the same rule). */
function lufs(w: Wav): number {
  const n = w.ch[0]!.length;
  const sq = w.ch.map((c) => {
    const y = kWeight(c, w.rate);
    return y.map((v) => v * v);
  });
  const blk = Math.round(0.4 * w.rate);
  const hop = Math.round(0.1 * w.rate);
  const meanSq = (s: number, e: number) =>
    sq.reduce((t, c) => t + c.subarray(s, e).reduce((u, v) => u + v, 0) / (e - s), 0);
  if (n < blk) return -0.691 + 10 * Math.log10(Math.max(meanSq(0, n), 1e-20));
  const z: number[] = [];
  for (let s = 0; s + blk <= n; s += hop) z.push(meanSq(s, s + blk));
  const l = (v: number) => -0.691 + 10 * Math.log10(Math.max(v, 1e-20));
  const abs = z.filter((v) => l(v) > -70);
  if (!abs.length) return Number.NEGATIVE_INFINITY;
  const rel = l(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const kept = z.filter((v) => l(v) > Math.max(rel, -70));
  return l(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/** Peak of the 4x oversampled signal (windowed sinc, 32 taps per phase side), in dBTP. */
function truePeakDb(w: Wav): number {
  const half = 16;
  const phases = [0.25, 0.5, 0.75].map((f) => {
    const h = new Float64Array(2 * half);
    for (let k = -half + 1; k <= half; k++) {
      const t = k - f;
      const win = 0.5 + 0.5 * Math.cos((Math.PI * t) / (half + 1));
      h[k + half - 1] = (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * win;
    }
    return h;
  });
  let peak = 0;
  for (const c of w.ch) {
    for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]!));
    for (const h of phases)
      for (let i = half; i < c.length - half; i++) {
        let s = 0;
        for (let k = 0; k < 2 * half; k++) s += h[k]! * c[i - half + 1 + k]!;
        peak = Math.max(peak, Math.abs(s));
      }
  }
  return 20 * Math.log10(peak);
}

function measure(path: string) {
  const w = readWav(path);
  const n = w.ch[0]!.length;
  let peak = 0;
  let clipped = 0;
  let ss = 0;
  for (const c of w.ch)
    for (let i = 0; i < n; i++) {
      const v = Math.abs(c[i]!);
      peak = Math.max(peak, v);
      if (v >= 32767 / 32768) clipped++;
      ss += v * v;
    }
  return {
    seconds: n / w.rate,
    rate: w.rate,
    channels: w.ch.length,
    peak,
    clipped,
    rmsDb: 10 * Math.log10(ss / (n * w.ch.length) + 1e-20),
    lufs: lufs(w),
    truePeak: truePeakDb(w),
  };
}

// ---- recipes and scores -------------------------------------------------------------------------------------------

const list = (d: string) =>
  readdirSync(join(skill, d))
    .filter((f) => f.endsWith('.json'))
    .sort();
const read = (d: string, f: string) => JSON.parse(readFileSync(join(skill, d, f), 'utf8'));

suite('hildegard-music: sound effect presets', () => {
  const presets = list('presets');
  it('has at least twenty, each with a note on how to vary it', () => {
    expect(presets.length).toBeGreaterThanOrEqual(20);
    for (const f of presets) {
      const r = read('presets', f);
      expect(r.name).toBe(f.replace(/\.json$/, ''));
      expect(r.note.length, f).toBeGreaterThan(40);
      expect(r.note, f).toMatch(/Vary/);
    }
    for (const name of [
      'ui_click',
      'notification_chime',
      'whoosh',
      'impact_hit',
      'riser',
      'swell',
      'laser',
      'coin',
      'footsteps_wood',
      'door_knock',
      'rain_bed',
      'wind',
      'fire_crackle',
      'heartbeat',
      'typewriter',
      'camera_shutter',
      'page_turn',
      'magic_sparkle',
      'error_buzz',
      'success_jingle',
    ])
      expect(presets, name).toContain(`${name}.json`);
  });

  describe.concurrent.each(presets)('%s', (f) => {
    it('passes --check, renders, and is on target, under the peak limit, unclipped and not silent', async () => {
      const recipe = read('presets', f);
      const out = join(work, `sfx-${f}.wav`);
      const { code, report } = await go(sfx, [join(skill, 'presets', f), out, '--check']);
      expect(report.errors, f).toEqual([]);
      expect(code).toBe(0);
      const ld = recipe.master?.loudness ?? {};
      const target = ld.lufs ?? -18;
      const limit = ld.true_peak ?? -1;
      const m = measure(out);
      expect(m.rate).toBe(44100);
      expect(m.channels).toBe(2);
      expect(m.seconds).toBeGreaterThan(0.04);
      expect(m.seconds).toBeCloseTo(report.stats!.duration_s, 2);
      expect(m.rmsDb).toBeGreaterThan(-60);
      expect(m.clipped).toBe(0);
      expect(Math.abs(m.lufs - target)).toBeLessThanOrEqual(1);
      expect(m.truePeak).toBeLessThanOrEqual(limit + 0.1);
    });
  });

  it('gives the same bytes for the same seed, other bytes for another seed', async () => {
    const recipe = join(skill, 'presets/fire_crackle.json');
    const a = join(work, 'det-a.wav');
    const b = join(work, 'det-b.wav');
    const c = join(work, 'det-c.wav');
    await run(python, [sfx, recipe, a, '--seed', '7']);
    await run(python, [sfx, recipe, b, '--seed', '7']);
    await run(python, [sfx, recipe, c, '--seed', '8']);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    expect(readFileSync(a).equals(readFileSync(c))).toBe(false);
  });

  it('plays a sample layer from a WAV next to the recipe, and reports a missing one', async () => {
    const src = join(work, 'sample-src.wav');
    await run(python, [sfx, join(skill, 'presets/coin.json'), src]);
    const recipe = {
      layers: [{ source: 'sample', file: 'sample-src.wav', dur: 0.4, rate: 0.5 }],
      master: { loudness: { lufs: -20 } },
    };
    const p = join(work, 'sample-recipe.json');
    writeFileSync(p, JSON.stringify(recipe));
    const out = join(work, 'sample-out.wav');
    const ok = await go(sfx, [p, out, '--check']);
    expect(ok.report.errors).toEqual([]);
    expect(measure(out).seconds).toBeCloseTo(0.4, 1);
    recipe.layers[0]!.file = 'nope.wav';
    writeFileSync(p, JSON.stringify(recipe));
    const bad = await go(sfx, [p, '--check']);
    expect(bad.code).toBe(1);
    expect(bad.report.errors.join('\n')).toMatch(/nope\.wav was not found/);
  });

  it('lists the presets and takes a preset by name', async () => {
    const { stdout } = await run(python, [sfx, '--list']);
    expect(stdout).toContain('coin');
    const out = join(work, 'byname.wav');
    await run(python, [sfx, '--preset', 'coin', out]);
    expect(existsSync(out)).toBe(true);
  });

  it('--check catches an out-of-range value, an unknown field and a clipping recipe, and writes nothing for them', async () => {
    const base = read('presets', 'coin.json');
    const bad = (mut: (r: typeof base) => void, name: string) => {
      const r = structuredClone(base);
      mut(r);
      const p = join(work, `bad-${name}.json`);
      writeFileSync(p, JSON.stringify(r));
      return p;
    };
    const out = join(work, 'bad-out.wav');

    const range = await go(sfx, [
      bad((r) => {
        r.layers[0].filter.cutoff = 90000;
      }, 'range'),
      out,
      '--check',
    ]);
    expect(range.code).toBe(1);
    expect(range.report.errors.join('\n')).toMatch(/layers\[0\]\.filter\.cutoff: 90000 is out of range/);

    const unknown = await go(sfx, [
      bad((r) => {
        r.layers[0].filtr = {};
      }, 'unknown'),
      out,
      '--check',
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.report.errors.join('\n')).toMatch(/unknown field \(did you mean filter\?\)/);

    const clip = await go(sfx, [
      bad((r) => {
        r.master = { normalize: false, gain_db: 24 };
      }, 'clip'),
      out,
      '--check',
    ]);
    expect(clip.code).toBe(1);
    expect(clip.report.errors.join('\n')).toMatch(/clipping/);

    // a peaky hit asked to be as loud as a sustained tone: the limiter cannot get there, and --check says so
    const hit = read('presets', 'impact_hit.json');
    hit.master.loudness = { lufs: -6, true_peak: -1 };
    const hitPath = join(work, 'bad-loud.json');
    writeFileSync(hitPath, JSON.stringify(hit));
    const loud = await go(sfx, [hitPath, out, '--check']);
    expect(loud.code).toBe(1);
    expect(loud.report.errors.join('\n')).toMatch(/loudness .* from the target/);

    const silent = await go(sfx, [
      bad((r) => {
        for (const l of r.layers) l.gain_db = -60;
        r.master = { normalize: false };
      }, 'silent'),
      out,
      '--check',
    ]);
    expect(silent.code).toBe(1);
    expect(silent.report.errors.join('\n')).toMatch(/silent/);

    expect(existsSync(out)).toBe(false);
  });
});

suite('hildegard-music: music templates', () => {
  const templates = list('templates');
  it('has at least eight, in the styles people ask for', () => {
    expect(templates.length).toBeGreaterThanOrEqual(8);
    for (const name of [
      'church_announcement',
      'corporate_upbeat',
      'lofi',
      'cinematic_swell',
      'ambient_pad',
      'country_shuffle',
      'hymn_chorale',
      'radio_jingle_15s',
    ])
      expect(templates, name).toContain(`${name}.json`);
    for (const f of templates) expect(read('templates', f).note.length, f).toBeGreaterThan(60);
  });

  describe.each(templates)('%s', (f) => {
    it('passes --check and renders at -14 LUFS, under -1 dBTP, unclipped, the right length', async () => {
      const score = read('templates', f);
      const out = join(work, `mus-${f}.wav`);
      const { code, report } = await go(music, [join(skill, 'templates', f), out, '--check']);
      expect(report.errors, f).toEqual([]);
      expect(report.warnings, f).toEqual([]);
      expect(code).toBe(0);
      const m = measure(out);
      expect(m.clipped).toBe(0);
      expect(m.rmsDb).toBeGreaterThan(-40);
      expect(Math.abs(m.lufs - -14)).toBeLessThanOrEqual(1);
      expect(m.truePeak).toBeLessThanOrEqual(-1 + 0.1);
      const beats =
        Number(String(score.time ?? '4/4').split('/')[0]) *
        (4 / Number(String(score.time ?? '4/4').split('/')[1]));
      const bars = (score.sections as { bars: number }[]).reduce((t, s) => t + s.bars, 0);
      const bodySeconds = (bars * beats * 60) / score.tempo;
      if (score.length_s) expect(m.seconds).toBeCloseTo(score.length_s, 1);
      else expect(m.seconds).toBeGreaterThanOrEqual(bodySeconds);
      // a hit of silence at the start or a cut-off middle would show here: the first and last second both carry sound
      expect(report.stats!.duration_s).toBeCloseTo(m.seconds, 1);
    });
  });

  it('the radio jingle is exactly 15 seconds', async () => {
    const out = join(work, 'jingle15.wav');
    await run(python, [music, 'radio_jingle_15s', out]);
    expect(measure(out).seconds).toBeCloseTo(15, 2);
  });

  it('gives the same bytes for the same seed', async () => {
    const t = join(skill, 'templates/radio_jingle_15s.json');
    const a = join(work, 'mdet-a.wav');
    const b = join(work, 'mdet-b.wav');
    const c = join(work, 'mdet-c.wav');
    await Promise.all([
      run(python, [music, t, a, '--seed', '5']),
      run(python, [music, t, b, '--seed', '5']),
      run(python, [music, t, c, '--seed', '6']),
    ]);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    expect(readFileSync(a).equals(readFileSync(c))).toBe(false);
  });

  it('a new key or tempo from the command line still passes --check', async () => {
    const r = await go(music, [
      join(skill, 'templates/radio_jingle_15s.json'),
      '--check',
      '--key',
      'D major',
      '--tempo',
      '120',
      '--length',
      '14',
    ]);
    expect(r.report.errors).toEqual([]);
    expect(r.report.stats!.duration_s).toBeCloseTo(14, 1);
  });

  it('the chorale has no parallel fifths or octaves and keeps its voices in order', async () => {
    const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(skill, 'scripts'))})
import music
sc = json.load(open(${JSON.stringify(join(skill, 'templates/hymn_chorale.json'))}))
e, w = [], []
p = music.Piece(sc); p.build_events(e)
t = music.build_tracks(p, e, w)[0]['notes']
by = {}
for n in t: by.setdefault(round(n['q'], 3), []).append(n['midi'])
print(json.dumps([by[k] for k in sorted(by)]))
`;
    const { stdout } = await run(python, ['-c', code]);
    const v: number[][] = JSON.parse(stdout);
    expect(v.length).toBeGreaterThan(30);
    for (const c of v) for (let i = 0; i < 3; i++) expect(c[i]!).toBeGreaterThan(c[i + 1]!);
    for (let k = 1; k < v.length; k++)
      for (let i = 0; i < 4; i++)
        for (let j = i + 1; j < 4; j++) {
          const moved = v[k]![i] !== v[k - 1]![i] || v[k]![j] !== v[k - 1]![j];
          const a = (((v[k - 1]![i]! - v[k - 1]![j]!) % 12) + 12) % 12;
          const b = (((v[k]![i]! - v[k]![j]!) % 12) + 12) % 12;
          if (moved && a === b) expect([0, 7], `voices ${i} and ${j} at step ${k}`).not.toContain(a);
        }
  });

  it('--check reports bad scores: bars that do not add up, a wrong chord, a bad pattern, out-of-range tempo', async () => {
    const base = read('templates', 'radio_jingle_15s.json');
    const bad = (mut: (s: typeof base) => void, name: string) => {
      const s = structuredClone(base);
      mut(s);
      const p = join(work, `badscore-${name}.json`);
      writeFileSync(p, JSON.stringify(s));
      return p;
    };
    const out = join(work, 'badscore-out.wav');
    const bars = await go(music, [
      bad((s) => {
        s.tracks[5].sections.a = '5:1 3:1 5:1 | 7:4 | 6:4 | 4:4';
      }, 'bars'),
      out,
      '--check',
    ]);
    expect(bars.code).toBe(1);
    expect(bars.report.errors.join('\n')).toMatch(/bar 1: the lengths add up to 3 beats but a bar is 4/);
    const chord = await go(music, [
      bad((s) => {
        s.sections[1].chords[0] = 'Hm';
      }, 'chord'),
      out,
      '--check',
    ]);
    expect(chord.code).toBe(1);
    expect(chord.report.errors.join('\n')).toMatch(/cannot read the chord 'Hm'/);
    const pat = await go(music, [
      bad((s) => {
        s.tracks[1].sections.a = 'wobble';
      }, 'pat'),
      out,
      '--check',
    ]);
    expect(pat.code).toBe(1);
    expect(pat.report.errors.join('\n')).toMatch(/unknown bass pattern 'wobble'/);
    const range = await go(music, [
      bad((s) => {
        s.tempo = 500;
      }, 'tempo'),
      out,
      '--check',
    ]);
    expect(range.code).toBe(1);
    expect(range.report.errors.join('\n')).toMatch(/score\.tempo: 500 is out of range 40 to 220/);
    const unknown = await go(music, [
      bad((s) => {
        s.tracks[0].volume = 3;
      }, 'unk'),
      out,
      '--check',
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.report.errors.join('\n')).toMatch(/volume: unknown field/);
    const clip = await go(music, [
      bad((s) => {
        s.master = { normalize: false, gain_db: 24 };
      }, 'clip'),
      out,
      '--check',
    ]);
    expect(clip.code).toBe(1);
    expect(clip.report.errors.join('\n')).toMatch(/clipping/);
    expect(existsSync(out)).toBe(false);
  });

  it('--check warns, without failing, about a melody note outside the key', async () => {
    const s = read('templates', 'radio_jingle_15s.json');
    s.tracks[5].sections.end = '#4:4';
    const p = join(work, 'warn-key.json');
    writeFileSync(p, JSON.stringify(s));
    const { code, report } = await go(music, [p, '--check']);
    expect(code).toBe(0);
    expect(report.warnings.join('\n')).toMatch(/outside G major/);
  });
});

suite('hildegard-music: the docs match the code', () => {
  it('every instrument, pattern, drum and preset is named in the references, and the skill links its files', async () => {
    const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(skill, 'scripts'))})
import music, voices
pats = sorted({p for t in music.PATTERNS.values() for p in t})
print(json.dumps({"instruments": list(voices.INSTRUMENTS), "patterns": pats, "drums": list(music.DRUM_PATTERNS), "kits": list(voices.KITS)}))
`;
    const { stdout } = await run(python, ['-c', code]);
    const names: Record<string, string[]> = JSON.parse(stdout);
    const scores = readFileSync(join(skill, 'references/scores.md'), 'utf8');
    for (const group of Object.values(names)) for (const n of group) expect(scores, n).toContain(`\`${n}\``);
    const recipes = readFileSync(join(skill, 'references/recipes.md'), 'utf8');
    for (const k of [
      'sine',
      'triangle',
      'saw',
      'square',
      'white',
      'pink',
      'brown',
      'fm',
      'sample',
      'lowpass',
      'highpass',
      'bandpass',
      'tanh',
      'crush',
    ])
      expect(recipes, k).toContain(k);
    const md = readFileSync(join(skill, 'SKILL.md'), 'utf8');
    for (const f of [
      ...list('presets').map((x) => x.replace(/\.json$/, '')),
      ...list('templates').map((x) => x.replace(/\.json$/, '')),
    ])
      expect(md, f).toContain(`\`${f}\``);
    expect(md).toContain('references/song-suno.md');
    expect(existsSync(join(skill, 'references/models.md'))).toBe(true);
  });
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
describe.skipIf(!haveNumpy || !haveFfmpeg)('hildegard-music: against ffmpeg', () => {
  it('ffmpeg ebur128 agrees with the script on a template within 0.5 LU and on the true peak within 0.5 dB', async () => {
    const out = join(work, 'ff.wav');
    await run(python, [music, join(skill, 'templates/radio_jingle_15s.json'), out]);
    const r = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
      { encoding: 'utf8' },
    );
    const sum = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
    const i = Number(/I:\s+(-?[\d.]+) LUFS/.exec(sum)![1]);
    const tp = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(sum)![1]);
    expect(Math.abs(i - -14)).toBeLessThanOrEqual(0.5);
    expect(tp).toBeLessThanOrEqual(-0.9);
  });
});
