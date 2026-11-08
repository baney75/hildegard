// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-sound's spot.py and Recipe C never cut a voice line: lines that cannot fit --total are refused, with the seconds over.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'skills/hildegard-sound/scripts/spot.py');
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

describe.skipIf(!hasFfmpeg)('a spot whose lines do not fit --total', () => {
  let music: string;
  let sting: string;
  let lines: string[];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'spot-'));
    music = tone('music.wav', 220, 5);
    sting = tone('sting.wav', 880, 1);
    // Three 3 s lines and a 1 s sting need about 11 s.
    lines = [tone('l1.wav', 300, 3), tone('l2.wav', 400, 3), tone('l3.wav', 500, 3)];
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the spot when the lines fit', () => {
    const out = join(dir, 'fits.wav');
    const r = run(python, [
      '-I',
      script,
      out,
      '--music',
      music,
      '--sting',
      sting,
      '--lines',
      ...lines,
      '--total',
      '15',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(length(out)).toBeCloseTo(15, 1);
  });

  it('refuses instead of cutting a line, says the seconds over, and writes nothing', () => {
    const out = join(dir, 'over.wav');
    const r = run(python, [
      '-I',
      script,
      out,
      '--music',
      music,
      '--sting',
      sting,
      '--lines',
      ...lines,
      '--total',
      '8',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/\d+\.\d\d s over/);
    expect(r.stderr).toMatch(/shorter lines/);
    expect(r.stderr).toMatch(/--allow-overrun/);
    expect(existsSync(out)).toBe(false);
  });

  it('grows the total with --allow-overrun, so every line is whole', () => {
    const out = join(dir, 'grown.wav');
    const r = run(python, [
      '-I',
      script,
      out,
      '--music',
      music,
      '--sting',
      sting,
      '--lines',
      ...lines,
      '--total',
      '8',
      '--allow-overrun',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/total grows from 8 s to/);
    // 3 lines of 3 s (a little less after trimming) plus the sting: well past the 8 s asked for.
    expect(length(out)).toBeGreaterThan(10);
  });

  it('Recipe C in SKILL.md does the same', () => {
    const recipe = skillMd.split('### Recipe C')[1]?.match(/```bash\n([\s\S]*?)```/)?.[1];
    expect(recipe).toBeDefined();
    const sh = join(dir, 'recipe-c.sh');
    execFileSync('node', [
      '-e',
      'require("fs").writeFileSync(process.argv[1], process.argv[2])',
      sh,
      recipe ?? '',
    ]);
    const env = (extra: Record<string, string>) => ({
      MUSIC: music,
      STING: sting,
      TOTAL: '8',
      ...extra,
    });
    // The recipe names its lines in an array; point it at the generated ones.
    const edited = (recipe ?? '').replace(
      'LINES=(line1.wav line2.wav line3.wav)',
      `LINES=(${lines.join(' ')})`,
    );
    execFileSync('node', ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', sh, edited]);
    const refused = run('bash', [sh], env({ OUT: join(dir, 'c-over.wav') }));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/\d+\.\d\d s over/);
    expect(existsSync(join(dir, 'c-over.wav'))).toBe(false);
    const grown = run('bash', [sh], env({ OUT: join(dir, 'c-grown.wav'), ALLOW_OVERRUN: '1' }));
    expect(grown.status, grown.stderr).toBe(0);
    expect(length(join(dir, 'c-grown.wav'))).toBeGreaterThan(10);
  });
});
