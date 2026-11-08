// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-music, soundscape.py: long seamless generated audio. Every preset renders at the right length and loudness
// (measured by an independent meter), chunked and one-pass renders are the same file, the beat frequency of a binaural
// layer is measured from the output, and memory stays flat as the length grows.
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { joinJumpRatio, measure, readWav, toneHz } from './audio-meter.ts';

vi.setConfig({ testTimeout: 300_000 });

const run = promisify(execFile);
const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const skill = resolve(import.meta.dirname, '../../../skills/hildegard-music');
const script = join(skill, 'scripts/soundscape.py');
const work = mkdtempSync(join(tmpdir(), 'hg-soundscape-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const haveNumpy = spawnSync(python, ['-c', 'import numpy']).status === 0;
const suite = haveNumpy || process.env.CI ? describe : describe.skip;

interface Report {
  ok: boolean;
  errors: string[];
  warnings: string[];
  notes: string[];
  stats: { samples: number; lufs: number; true_peak: number } | null;
  beats: { layer: number; type: string; expected_hz: number; measured_hz: number }[];
  estimate: { gain_to_target_db: number } | null;
}

async function go(args: string[]): Promise<{ code: number; report: Report }> {
  try {
    const { stdout } = await run(python, [script, ...args, '--json'], { maxBuffer: 1 << 26 });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (err.code === 1 && err.stdout) return { code: 1, report: JSON.parse(err.stdout) };
    throw e;
  }
}

const presets = readdirSync(join(skill, 'soundscapes'))
  .filter((f) => f.endsWith('.json'))
  .sort();
const read = (f: string) => JSON.parse(readFileSync(join(skill, 'soundscapes', f), 'utf8'));
const SR = 44100;

suite('hildegard-music: soundscapes', () => {
  it('has the beds people ask for, each with a note on how to vary it', () => {
    expect(presets.length).toBeGreaterThanOrEqual(20);
    for (const name of [
      'binaural_delta_3hz',
      'binaural_theta_6hz',
      'binaural_alpha_10hz',
      'binaural_beta_14hz',
      'binaural_wind_down',
      'isochronic_10hz',
      'isochronic_wind_down',
      'ocean_beach',
      'rain_roof_light',
      'rain_roof_heavy',
      'rain_leaves',
      'wind_gentle',
      'creek',
      'crickets_night',
      'campfire',
      'brown_noise',
      'pink_noise',
      'white_noise',
      'beach_rain_alpha',
      'forest_night',
      'rainy_fireside',
    ])
      expect(presets, name).toContain(`${name}.json`);
    for (const f of presets) {
      const r = read(f);
      expect(r.name).toBe(f.replace(/\.json$/, ''));
      expect(r.note.length, f).toBeGreaterThan(50);
      expect(r.note, f).toMatch(/Vary/);
      // no preset may claim a health benefit
      expect(JSON.stringify(r), f).not.toMatch(
        /\b(cures?|treats?|treatment|heals?|healing|therap\w*|anxiety|insomnia|depress\w*|medical|clinical|diagnos\w*)\b/i,
      );
    }
    for (const f of presets.filter((x) => /binaural/.test(x))) expect(read(f).note, f).toMatch(/headphones/i);
  });

  describe.concurrent.each(presets)('%s', (f) => {
    it('renders 12 s of exactly the right length, on target, under the peak limit, unclipped, not silent', async () => {
      const recipe = read(f);
      const out = join(work, `${f}.wav`);
      const { code, report } = await go([join(skill, 'soundscapes', f), out, '--seconds', '12']);
      expect(report.errors, f).toEqual([]);
      expect(code).toBe(0);
      const target = recipe.master.loudness.lufs;
      const m = measure(out);
      expect(readWav(out).ch[0]!.length).toBe(12 * SR);
      expect(report.stats!.samples).toBe(12 * SR);
      expect(m.rmsDb).toBeGreaterThan(-60);
      expect(m.clipped).toBe(0);
      expect(m.dc).toBeLessThan(0.005);
      expect(Math.abs(m.lufs - target)).toBeLessThanOrEqual(1);
      expect(m.truePeak).toBeLessThanOrEqual(-1 + 0.1);
      for (const b of report.beats) expect(Math.abs(b.measured_hz - b.expected_hz)).toBeLessThanOrEqual(0.1);
      rmSync(out);
    });
  });

  it('chunked and one-pass renders are the same file, so chunks join without a seam', async () => {
    const a = join(work, 'chunk-small.wav');
    const b = join(work, 'chunk-whole.wav');
    const recipe = join(skill, 'soundscapes/forest_night.json');
    await Promise.all([
      run(python, [script, recipe, a, '--seconds', '33', '--chunk', '4']),
      run(python, [script, recipe, b, '--seconds', '33', '--chunk', '60']),
    ]);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    // and no click at the joins: the largest step at a 4 s boundary is no bigger than the signal's own steps
    const w = readWav(a);
    const chunkN = Math.round((4 * SR) / 2048) * 2048; // the script rounds a chunk to its frame grid
    const joins = [1, 2, 3, 4, 5].map((k) => k * chunkN);
    expect(joinJumpRatio(w, joins)).toBeLessThan(12);
  });

  it('measures the binaural beat in the file, in each ear, within 0.1 Hz at every stage', async () => {
    const recipe = {
      seed: 5,
      seconds: 45,
      layers: [
        {
          type: 'binaural',
          carrier_hz: 200,
          ramp_s: 8,
          stages: [
            { beat_hz: 4, seconds: 20 },
            { beat_hz: 10, seconds: 25 },
          ],
          gain_db: -4,
        },
        { type: 'noise', color: 'brown', lowpass: 800, gain_db: -12 },
        { type: 'pad', notes: ['A2', 'E3', 'C4'], gain_db: -16 },
      ],
      master: { loudness: { lufs: -22, true_peak: -1 } },
    };
    const p = join(work, 'beat-recipe.json');
    writeFileSync(p, JSON.stringify(recipe));
    const out = join(work, 'beat.wav');
    const { report } = await go([p, out]);
    expect(report.errors).toEqual([]);
    const w = readWav(out);
    for (const [at, beat] of [
      [8, 4],
      [34, 10],
    ] as const) {
      const left = toneHz(w, 0, at, 8, 190, 210);
      const right = toneHz(w, 1, at, 8, 190, 210);
      expect(Math.abs(left - (200 - beat / 2)), `left ${left} at ${at}`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(right - (200 + beat / 2)), `right ${right} at ${at}`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(right - left - beat)).toBeLessThanOrEqual(0.1);
    }
    expect(report.beats.length).toBeGreaterThanOrEqual(2);
    expect(report.notes.join(' ')).toMatch(/headphones/);
  });

  it("a length asked for on the command line stretches the stages, and the beat is still the recipe's", async () => {
    const recipe = {
      seed: 2,
      minutes: 1,
      layers: [
        {
          type: 'binaural',
          carrier_hz: 200,
          ramp_s: 6,
          stages: [
            { beat_hz: 4, minutes: 0.5 },
            { beat_hz: 10, minutes: 0.5 },
          ],
        },
        { type: 'noise', color: 'pink', gain_db: -10 },
      ],
    };
    const p = join(work, 'stretch-recipe.json');
    writeFileSync(p, JSON.stringify(recipe));
    const out = join(work, 'stretch.wav');
    const { report } = await go([p, out, '--seconds', '40']);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).not.toMatch(/stages/);
    expect(report.beats.map((b) => b.expected_hz)).toEqual([4, 10]);
    for (const b of report.beats) expect(Math.abs(b.measured_hz - b.expected_hz)).toBeLessThanOrEqual(0.1);
    expect(measure(out).seconds).toBeCloseTo(40, 3);
    // the shipped journey takes the same route: a one hour version keeps four stages, 14, 10, 6 and 3 Hz
    const j = await go([join(skill, 'soundscapes/binaural_wind_down.json'), '--check', '--minutes', '60']);
    expect(j.report.errors).toEqual([]);
    expect(j.report.warnings.join(' ')).not.toMatch(/stages/);
    // and every one of its four stages is measured in the file, the last (3 Hz) included
    const w = await go([
      join(skill, 'soundscapes/binaural_wind_down.json'),
      join(work, 'wind.wav'),
      '--minutes',
      '1.5',
    ]);
    expect(w.report.errors).toEqual([]);
    expect(w.report.beats.map((b) => b.expected_hz)).toEqual([14, 10, 6, 3]);
    for (const b of w.report.beats) expect(Math.abs(b.measured_hz - b.expected_hz)).toBeLessThanOrEqual(0.1);
  });

  it('an isochronic layer pulses at the rate in the recipe', async () => {
    const { report } = await go([
      join(skill, 'soundscapes/isochronic_10hz.json'),
      join(work, 'iso.wav'),
      '--seconds',
      '40',
    ]);
    expect(report.errors).toEqual([]);
    expect(report.beats[0]!.type).toBe('isochronic');
    expect(Math.abs(report.beats[0]!.measured_hz - 10)).toBeLessThanOrEqual(0.1);
  });

  it('the same seed gives the same file, another seed another', async () => {
    const r = join(skill, 'soundscapes/rain_leaves.json');
    const [a, b, c] = ['s1', 's2', 's3'].map((n) => join(work, `${n}.wav`));
    await Promise.all([
      run(python, [script, r, a!, '--seconds', '12', '--seed', '9']),
      run(python, [script, r, b!, '--seconds', '12', '--seed', '9']),
      run(python, [script, r, c!, '--seconds', '12', '--seed', '10']),
    ]);
    expect(readFileSync(a!).equals(readFileSync(b!))).toBe(true);
    expect(readFileSync(a!).equals(readFileSync(c!))).toBe(false);
  });

  it('--check reports bad recipes and writes nothing for them', async () => {
    const base = read('binaural_alpha_10hz.json');
    const bad = (mut: (r: typeof base) => void, name: string) => {
      const r = structuredClone(base);
      mut(r);
      const p = join(work, `bad-${name}.json`);
      writeFileSync(p, JSON.stringify(r));
      return p;
    };
    const out = join(work, 'bad-out.wav');
    const range = await go([
      bad((r) => {
        r.layers[0].beat_hz = 90;
      }, 'range'),
      out,
      '--seconds',
      '20',
    ]);
    expect(range.code).toBe(1);
    expect(range.report.errors.join('\n')).toMatch(/layers\[0\]\.beat_hz: 90 is out of range 0\.5 to 40/);
    const unknown = await go([
      bad((r) => {
        r.layers[0].carier_hz = 200;
      }, 'unknown'),
      out,
      '--seconds',
      '20',
    ]);
    expect(unknown.report.errors.join('\n')).toMatch(
      /carier_hz: unknown field \(did you mean carrier_hz\?\)/,
    );
    const wrongType = await go([
      bad((r) => {
        r.layers[1].beat_hz = 5;
      }, 'type'),
      out,
      '--seconds',
      '20',
    ]);
    expect(wrongType.report.errors.join('\n')).toMatch(/beat_hz: does not apply to type 'noise'/);
    const silent = await go([
      bad((r) => {
        for (const l of r.layers) l.gain_db = -60;
        r.layers[0].automation = [
          [0, -80],
          [1, -80],
        ];
        r.layers[1].automation = [
          [0, -80],
          [1, -80],
        ];
      }, 'silent'),
      out,
      '--seconds',
      '20',
    ]);
    expect(silent.code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
    const sampled = await go([join(skill, 'soundscapes/ocean_beach.json'), '--check', '--seconds', '60']);
    expect(sampled.code).toBe(0);
    expect(sampled.report.estimate).not.toBeNull();
  });

  it.skipIf(process.platform !== 'linux')(
    'memory stays flat: four times the length, about the same peak memory',
    async () => {
      const code = (seconds: number) => `
import sys, resource
sys.path.insert(0, ${JSON.stringify(join(skill, 'scripts'))})
import soundscape
rc = soundscape.main([${JSON.stringify(join(skill, 'soundscapes/beach_rain_alpha.json'))}, ${JSON.stringify(join(work, `mem-${seconds}.wav`))}, '--seconds', '${seconds}', '--chunk', '5', '--json'])
print(rc, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
`;
      const rss = async (s: number) =>
        Number((await run(python, ['-c', code(s)])).stdout.trim().split(/\s+/).pop());
      const [short, long] = await Promise.all([rss(40), rss(120)]);
      expect(long).toBeLessThan(short * 1.2 + 30_000);
      for (const n of [40, 120]) rmSync(join(work, `mem-${n}.wav`), { force: true });
    },
  );

  it('lists the presets and takes one by name', async () => {
    const { stdout } = await run(python, [script, '--list']);
    expect(stdout).toContain('ocean_beach');
    const out = join(work, 'byname.wav');
    await run(python, [script, 'pink_noise', out, '--seconds', '10']);
    expect(existsSync(out)).toBe(true);
  });
});
