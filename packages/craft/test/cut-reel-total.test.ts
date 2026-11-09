// SPDX-License-Identifier: AGPL-3.0-only
// cut_reel.py's --total is an exact length: clips too short for it are held on their last frame, never stretched.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const script = resolve(import.meta.dirname, '../../../skills/hildegard-video-edit/scripts/cut_reel.py');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let dir: string;
let a: string;
let b: string;

const seconds = (file: string) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }),
  );
const freezes = (file: string) =>
  spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'freezedetect=d=0.5', '-an', '-f', 'null', '-'], {
    encoding: 'utf8',
  }).stderr.split('freeze_start').length - 1;
const cut = (name: string, ...args: string[]) => {
  const out = join(dir, name);
  const r = spawnSync(python, ['-I', script, out, '--clip', a, '--clip', b, ...args], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return out;
};

describe.skipIf(!hasFfmpeg)('cut_reel.py --total', { timeout: 120_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cut-reel-'));
    const clip = (name: string) => {
      const out = join(dir, name);
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=2',
        '-pix_fmt',
        'yuv420p',
        out,
      ]);
      return out;
    };
    a = clip('a.mp4');
    b = clip('b.mp4');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reaches the length by holding clips, with hard cuts', () => {
    const out = cut('hard.mp4', '--size', '320x180', '--fade', '0', '--total', '6');
    expect(seconds(out)).toBeCloseTo(6, 1);
    expect(freezes(out)).toBeGreaterThan(0);
  });

  it('reaches the length by holding clips, with crossfades and a closing card', () => {
    const out = cut(
      'fade.mp4',
      '--size',
      '320x180',
      '--fade',
      '0.4',
      '--card',
      'The end',
      '--card-secs',
      '1',
      '--total',
      '7',
    );
    expect(seconds(out)).toBeCloseTo(7, 1);
  });

  it('still trims when the clips run long', () => {
    const out = cut('trim.mp4', '--size', '320x180', '--fade', '0', '--total', '3');
    expect(seconds(out)).toBeCloseTo(3, 1);
  });
});
