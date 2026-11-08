// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-sound's duck_mix.py and Recipe B never cut a voice that runs past --total: they refuse, with the seconds over.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const scripts = ['hildegard-sound', 'hildegard-video-edit'].map((s) =>
  join(root, 'skills', s, 'scripts/duck_mix.py'),
);
const skillMd = readFileSync(join(root, 'skills/hildegard-sound/SKILL.md'), 'utf8');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let dir: string;

const tone = (name: string, hz: number, seconds: number) => {
  const out = join(dir, name);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:duration=${seconds}:sample_rate=44100`,
    '-ac',
    '1',
    out,
  ]);
  return out;
};
const length = (path: string) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
      encoding: 'utf8',
    }).trim(),
  );
const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

describe.skipIf(!hasFfmpeg)('music under a voice that runs past --total', () => {
  let voice: string;
  let music: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'duck-'));
    voice = tone('voice.wav', 300, 6); // speaks 6 s, so with --voice-start 4 it ends at 10 s
    music = tone('music.wav', 220, 5);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const script of scripts) {
    const label = script.includes('video-edit') ? 'the video-edit copy' : 'duck_mix.py';

    it(`${label} writes the mix when --total holds the whole voice`, () => {
      const out = join(dir, `fits-${label.length}.wav`);
      const r = run(python, ['-I', script, voice, music, out, '--total', '14']);
      expect(r.status, r.stderr).toBe(0);
      expect(length(out)).toBeCloseTo(14, 1);
    });

    it(`${label} refuses instead of cutting the voice, says the seconds over, and writes nothing`, () => {
      const out = join(dir, `over-${label.length}.wav`);
      const r = run(python, ['-I', script, voice, music, out, '--total', '8']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/\d+\.\d\d s over/);
      expect(r.stderr).toMatch(/--total of at least/);
      expect(r.stderr).toMatch(/--allow-overrun/);
      expect(existsSync(out)).toBe(false);
    });

    it(`${label} grows the total with --allow-overrun, so the voice is whole`, () => {
      const out = join(dir, `grown-${label.length}.wav`);
      const r = run(python, ['-I', script, voice, music, out, '--total', '8', '--allow-overrun']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/total grows from 8 s to/);
      expect(length(out)).toBeGreaterThan(10);
    });
  }

  it('Recipe B in SKILL.md does the same', () => {
    const recipe = skillMd.split('### Recipe B')[1]?.match(/```bash\n([\s\S]*?)```/)?.[1];
    expect(recipe).toBeDefined();
    const sh = join(dir, 'recipe-b.sh');
    writeFileSync(sh, recipe ?? '');
    const env = (extra: Record<string, string>) => ({
      VOICE: voice,
      MUSIC: music,
      TOTAL: '8',
      ...extra,
    });
    const refused = run('bash', [sh], env({ OUT: join(dir, 'b-over.wav') }));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/\d+\.\d\d s over/);
    expect(existsSync(join(dir, 'b-over.wav'))).toBe(false);
    const grown = run('bash', [sh], env({ OUT: join(dir, 'b-grown.wav'), ALLOW_OVERRUN: '1' }));
    expect(grown.status, grown.stderr).toBe(0);
    expect(length(join(dir, 'b-grown.wav'))).toBeGreaterThan(10);
  });
});
