// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-photo-edit's scripts (straighten, color, denoise_sharpen, crop, measure, fix) do what the skill says on a synthetic scene
// with a known tilt, a known colour cast and a marked subject: they measure, they never invent pixels, they refuse when unsure.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const scripts = join(root, 'skills/hildegard-photo-edit/scripts');
const fixture = join(import.meta.dirname, 'photo_fixture.py');
const hasPython = spawnSync(python, ['-c', 'import PIL, numpy']).status === 0;
const hasMagick = spawnSync('magick', ['-version']).status === 0;
let dir: string;

const py = (script: string, ...args: string[]) =>
  spawnSync(python, ['-I', script, ...args], { encoding: 'utf8' });
const tool = (name: string, ...args: string[]) => py(join(scripts, `${name}.py`), ...args);
const make = (...args: string[]) => {
  const r = py(fixture, ...args);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};
const stats = (path: string, ref?: string) =>
  JSON.parse(make('stats', path, ...(ref ? [ref] : []))) as {
    chroma_error?: number;
    log_r_g?: number;
    log_b_g?: number;
    luma_error?: number;
    black_border: number;
  };
const f = (name: string) => join(dir, name);
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sh = (cwd: string, script: string) => spawnSync('bash', ['-ec', script], { cwd, encoding: 'utf8' });
const identify = (path: string) =>
  (spawnSync('magick', ['identify', '-format', '%w %h', path], { encoding: 'utf8' }).stdout || '')
    .trim()
    .split(' ')
    .map(Number);
const skillBlock = (from: string, to: string) => {
  const md = readFileSync(join(scripts, '../SKILL.md'), 'utf8');
  const a = md.indexOf(from);
  const b = md.indexOf(to, a);
  expect(a, `${from} in SKILL.md`).toBeGreaterThan(-1);
  expect(b, `${to} in SKILL.md`).toBeGreaterThan(a);
  return md.slice(a, b);
};
const json = (r: { stdout: string; stderr: string; status: number | null }) => {
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

describe.skipIf(!hasPython)('hildegard-photo-edit scripts', () => {
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 }); // each case runs Python on a 1200 x 800 picture
  let subject: number[];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'photo-tools-'));
    make('scene', f('scene.png'));
    subject = JSON.parse(make('scene', f('scene.png'))).subject;
    make('tilt', f('scene.png'), f('clean.png'), '0'); // the clean 1200 x 800 window every degradation starts from
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  describe('straighten.py', () => {
    it.each([3.0, -2.2, 1.4, -4.5])(
      'finds a known rotation of %s degrees within 0.3 and leaves no wedges',
      (deg) => {
        make('tilt', f('scene.png'), f('t.png'), String(deg));
        const r = json(tool('straighten', f('t.png'), f('s.png'), '--json'));
        expect(Math.abs(r.angle - deg)).toBeLessThanOrEqual(0.3);
        expect(stats(f('s.png')).black_border).toBe(0);
        // turned the right way: measuring the result again reads level
        const again = tool('straighten', f('s.png'), f('s2.png'), '--json');
        expect(Math.abs(JSON.parse(again.stdout || '{"tilt":0}').tilt ?? 0)).toBeLessThanOrEqual(0.3);
        const m = JSON.parse(tool('measure', f('s.png'), '--json').stdout);
        expect(Math.abs(m.tilt)).toBeLessThanOrEqual(0.5);
      },
    );

    it('prints the angle and the direction in words', () => {
      make('tilt', f('scene.png'), f('t.png'), '3');
      const r = tool('straighten', f('t.png'), f('s.png'));
      expect(r.stdout).toMatch(/tilt found: \+3\.0\d degrees, picture turned counter-clockwise/);
      expect(r.stdout).toMatch(/no empty corners/);
    });

    it('refuses a picture with no straight lines, writes nothing, and obeys --angle', () => {
      make('flat', f('flat.png'));
      const r = tool('straighten', f('flat.png'), f('flat-out.png'));
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/not straightened/);
      expect(existsSync(f('flat-out.png'))).toBe(false);
      const given = tool('straighten', f('flat.png'), f('flat-out.png'), '--angle', '2');
      expect(given.status, given.stderr).toBe(0);
      expect(stats(f('flat-out.png')).black_border).toBe(0);
    });

    it.skipIf(!hasMagick)(
      'the ImageMagick recipe cuts to the same rectangle as the tool, with no black wedges',
      () => {
        const recipe = skillBlock('# Orientation and straighten', '# Crop to 4:5').replace(
          'ANGLE=2.1',
          'ANGLE=2',
        );
        const work = join(dir, 'im-straighten');
        expect(sh(dir, `mkdir -p ${work}`).status).toBe(0);
        // a 3000 x 2000 photo, as the finding describes
        expect(sh(work, `magick ${f('scene.png')} -resize 3000x2000! in.jpg`).status).toBe(0);
        const py = json(
          tool('straighten', join(work, 'in.jpg'), join(work, 'py.png'), '--angle', '2', '--json'),
        );
        const r = sh(work, recipe);
        expect(r.status, r.stderr).toBe(0);
        const [w = 0, h = 0] = identify(join(work, 'straight.jpg'));
        expect(Math.abs(w - py.size[0])).toBeLessThanOrEqual(2);
        expect(Math.abs(h - py.size[1])).toBeLessThanOrEqual(2);
        expect(stats(join(work, 'straight.jpg')).black_border).toBe(0);
        expect(sh(work, 'test "$(magick identify -format %w straight.jpg)" -lt 3000').status).toBe(0);
      },
    );

    it('leaves a tilt under 0.6 degrees alone', () => {
      make('tilt', f('scene.png'), f('t.png'), '0.4');
      const r = json(tool('straighten', f('t.png'), f('s.png'), '--json'));
      expect(r.size).toEqual([1200, 800]);
    });
  });

  describe('color.py', () => {
    it.each([
      [0.82, 1.0, 1.2],
      [1.15, 1.0, 0.8],
    ])('fixes a known cast %s %s %s to within the scorer limit of 0.05', (r, g, b) => {
      make('cast', f('clean.png'), f('cast.png'), String(r), String(g), String(b));
      const before = stats(f('cast.png'), f('clean.png')).chroma_error ?? 1;
      expect(before).toBeGreaterThan(0.15);
      json(tool('color', f('cast.png'), f('fixed.png'), '--exposure', 'none', '--json'));
      expect(stats(f('fixed.png'), f('clean.png')).chroma_error ?? 1).toBeLessThanOrEqual(0.05);
    });

    it('brings a dark picture and a bright one back to within 0.06 of the clean brightness', () => {
      for (const stops of [-1.0, 0.8]) {
        make('stops', f('clean.png'), f('exp.png'), String(stops));
        json(tool('color', f('exp.png'), f('fixed.png'), '--wb', 'none', '--json'));
        expect(Math.abs(stats(f('fixed.png'), f('clean.png')).luma_error ?? 1)).toBeLessThanOrEqual(0.06);
      }
    });

    it('does nothing to a picture that is already right, and prints before and after', () => {
      const r = tool('color', f('clean.png'), f('same.png'));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/mean_luma\s+[\d.]+ -> [\d.]+/);
      expect(stats(f('same.png'), f('clean.png')).chroma_error ?? 1).toBeLessThanOrEqual(0.03);
    });

    it.each([0.97, 1.0])(
      'says what to give when a dark picture has bright highlights (patch %s) and auto leaves it',
      (patch) => {
        make('darkbright', f('db.png'), String(patch));
        const m = JSON.parse(tool('measure', f('db.png'), '--json').stdout);
        expect(m.mean_luma).toBeLessThan(0.28);
        const r = json(tool('color', f('db.png'), f('db-out.png'), '--wb', 'none', '--json'));
        expect(r.done.exposure_stops).toBe(0);
        expect(r.done.exposure_note).toMatch(/--exposure [+-]0\.5/);
        // and the number it names does something
        const lifted = json(
          tool('color', f('db.png'), f('db-out.png'), '--wb', 'none', '--exposure', '+0.5', '--json'),
        );
        expect(lifted.after.mean_luma).toBeGreaterThan(lifted.before.mean_luma + 0.02);
      },
    );

    it('keeps the SKILL.md reading table and the docstring to what the code does', () => {
      const md = readFileSync(join(scripts, '../SKILL.md'), 'utf8');
      expect(md).toMatch(/mean luminance under 0\.28[^\n]*bright highlights[^\n]*`--exposure \+0\.5`/);
      expect(md).toMatch(/clipped highlights over 0\.05[^\n]*only when the picture is bright overall/);
      expect(readFileSync(join(scripts, 'color.py'), 'utf8')).not.toContain('sane band');
    });

    it.skipIf(!hasMagick)(
      'the ImageMagick gray-world recipe makes all three channel means equal when G is not their mean',
      () => {
        const recipe = skillBlock('# White balance from the picture', '# Exposure:');
        const work = join(dir, 'im-wb');
        expect(sh(dir, `mkdir -p ${work}`).status).toBe(0);
        // channel means R 0.59, G 0.29, B 0.29: the mean of the three is 0.39, G is not it
        const made = sh(work, "magick -size 300x200 gradient:'rgb(80,40,40)-rgb(220,110,110)' in.jpg");
        expect(made.status, made.stderr).toBe(0);
        const before = stats(join(work, 'in.jpg'));
        expect(before.log_r_g).toBeGreaterThan(0.5);
        const r = sh(work, recipe);
        expect(r.status, r.stderr).toBe(0);
        const after = stats(join(work, 'wb.jpg'));
        expect(Math.abs(after.log_r_g ?? 1)).toBeLessThan(0.03);
        expect(Math.abs(after.log_b_g ?? 1)).toBeLessThan(0.03);
        // the tool agrees that the cast is gone
        json(
          tool(
            'color',
            join(work, 'in.jpg'),
            join(work, 'py.png'),
            '--wb',
            'gray',
            '--exposure',
            'none',
            '--json',
          ),
        );
        expect(Math.abs(stats(join(work, 'py.png')).log_r_g ?? 1)).toBeLessThan(0.03);
      },
    );

    it('never paints: a flat grey stays grey, with no gradient or cast added', () => {
      make('flat', f('flat.png'));
      json(tool('color', f('flat.png'), f('flat-out.png'), '--json'));
      const m = JSON.parse(tool('measure', f('flat-out.png'), '--json').stdout);
      expect(m.gray_world_error).toBeLessThan(0.1); // grain this heavy moves the colour a little, never into a cast
    });
  });

  describe('denoise_sharpen.py', () => {
    it('never lets sharpening raise noise past the ceiling, and lowers the noise of a noisy picture', () => {
      make('noise', f('clean.png'), f('noisy.png'), '8');
      for (const args of [[], ['--sharpen', '1.5'], ['--sharpen', '1.5', '--max-noise-increase', '0']]) {
        const r = json(tool('denoise_sharpen', f('noisy.png'), f('out.png'), '--json', ...args));
        expect(r.ceiling_held).toBe(true);
        expect(r.noise_out).toBeLessThanOrEqual(r.ceiling + 0.01);
        expect(r.noise_out).toBeLessThan(r.noise_in);
      }
    });

    it.each(['denoise', 'sharpen'])('--%s 0 means off: the same picture as none, never NaN', (flag) => {
      make('noise', f('clean.png'), f('noisy.png'), '8');
      const other = flag === 'denoise' ? ['--sharpen', 'none'] : ['--denoise', 'none'];
      const zero = tool(
        'denoise_sharpen',
        f('noisy.png'),
        f('zero.png'),
        `--${flag}`,
        '0',
        ...other,
        '--json',
      );
      const none = tool(
        'denoise_sharpen',
        f('noisy.png'),
        f('none.png'),
        `--${flag}`,
        'none',
        ...other,
        '--json',
      );
      expect(zero.status, zero.stderr).toBe(0);
      expect(none.status, none.stderr).toBe(0);
      expect(sha(f('zero.png'))).toBe(sha(f('none.png')));
      // off changes nothing: the same picture, pixel for pixel (a PNG is re-encoded, so compare the decoded numbers)
      expect(make('stats', f('zero.png'))).toBe(make('stats', f('noisy.png')));
      expect(JSON.parse(zero.stdout).ceiling_held).toBe(true);
    });

    it('--denoise 0 with automatic sharpening still gives a normal picture', () => {
      make('noise', f('clean.png'), f('noisy.png'), '8');
      const r = json(tool('denoise_sharpen', f('noisy.png'), f('zero.png'), '--denoise', '0', '--json'));
      expect(r.denoise).toBe('off');
      const m = JSON.parse(tool('measure', f('zero.png'), '--json').stdout);
      expect(
        Math.abs(m.mean_luma - JSON.parse(tool('measure', f('noisy.png'), '--json').stdout).mean_luma),
      ).toBeLessThan(0.02);
    });

    it.each(['-1', 'nan', 'inf'])('rejects --denoise %s in plain words', (v) => {
      const r = tool('denoise_sharpen', f('clean.png'), f('bad.png'), `--denoise=${v}`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toMatch(/Traceback/);
      expect(r.stderr).toMatch(/takes auto, none/);
    });

    it('skips a clean picture and says so', () => {
      const r = json(tool('denoise_sharpen', f('clean.png'), f('out.png'), '--json'));
      expect(r.denoise).toMatch(/skipped/);
      expect(r.noise_out).toBeLessThanOrEqual(r.ceiling + 0.01);
    });
  });

  describe('crop.py', () => {
    it.each([
      ['4:5', 4 / 5],
      ['1:1', 1],
      ['16:9', 16 / 9],
      ['9:16', 9 / 16],
    ])('crops to %s and keeps the marked subject whole', (aspect, ratio) => {
      const box = subject.join(',');
      const r = json(
        tool('crop', f('clean.png'), f('crop.png'), '--aspect', aspect, '--subject', box, '--json'),
      );
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = r.box as number[];
      expect((x1 - x0) / (y1 - y0)).toBeCloseTo(ratio, 1);
      const [fx0 = 0, fy0 = 0, fx1 = 0, fy1 = 0] = subject;
      const [sx0, sy0, sx1, sy1] = [fx0 * 1200, fy0 * 800, fx1 * 1200, fy1 * 800];
      expect(x0).toBeLessThanOrEqual(sx0);
      expect(y0).toBeLessThanOrEqual(sy0);
      expect(x1).toBeGreaterThanOrEqual(sx1);
      expect(y1).toBeGreaterThanOrEqual(sy1);
    });

    it('guesses the subject from saliency when none is given, and says so', () => {
      const r = tool('crop', f('clean.png'), f('crop.png'), '--aspect', '1:1');
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/GUESSED/);
    });

    it('resizes to an exact size', () => {
      json(
        tool(
          'crop',
          f('clean.png'),
          f('crop.png'),
          '--size',
          '1080x1350',
          '--subject',
          subject.join(','),
          '--json',
        ),
      );
      expect(JSON.parse(tool('measure', f('crop.png'), '--json').stdout)).toMatchObject({
        width: 1080,
        height: 1350,
      });
    });

    it('refuses a shape that would cut the subject, and writes nothing', () => {
      const r = tool(
        'crop',
        f('clean.png'),
        f('nope.png'),
        '--aspect',
        '9:16',
        '--subject',
        '0.05,0.1,0.95,0.9',
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/not cropped/);
      expect(existsSync(f('nope.png'))).toBe(false);
    });
  });

  describe('fix.py', () => {
    it('straightens, crops, corrects and prints a short report, at the exact size under the byte cap', () => {
      make('tilt', f('scene.png'), f('t.png'), '-3');
      make('cast', f('t.png'), f('bad.png'), '0.85', '1', '1.15');
      make('noise', f('bad.png'), f('bad.jpg'), '5');
      const out = f('fixed.jpg');
      const r = tool(
        'fix',
        f('bad.jpg'),
        out,
        '--size',
        '1000x800',
        '--subject',
        subject.join(','),
        '--family',
        'h',
        '--max-bytes',
        '400000',
      );
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.split('\n');
      for (const head of [
        'straighten:',
        'crop:',
        'color:',
        'denoise_sharpen:',
        'before -> after:',
        'wrote ',
      ]) {
        expect(
          lines.some((l) => l.startsWith(head)),
          `${head}\n${r.stdout}`,
        ).toBe(true);
      }
      expect(r.stdout).toMatch(/tilt -3\.\d\d degrees/);
      expect(readFileSync(out).length).toBeLessThanOrEqual(400000);
      const m = JSON.parse(tool('measure', out, '--json').stdout);
      expect([m.width, m.height]).toEqual([1000, 800]);
      expect(Math.abs(m.tilt)).toBeLessThanOrEqual(0.5);
      expect(m.gray_world_error).toBeLessThan(0.1);
      expect(stats(out).black_border).toBe(0);
    });

    it('says plainly what straightening cut off a subject that touches the frame edge', () => {
      const edge = json(
        tool(
          'fix',
          f('clean.png'),
          f('edge.jpg'),
          '--angle',
          '2.5',
          '--subject',
          '0.3,0.0,0.7,1.0',
          '--aspect',
          '3:2',
          '--no-denoise',
          '--no-color',
          '--json',
        ),
      );
      expect(edge.warnings.join(' ')).toMatch(/STRAIGHTENING CUT THE SUBJECT.*px off its (top|bottom)/);
      expect(edge.subject_cut.top).toBeGreaterThan(5);
      expect(edge.subject_cut.bottom).toBeGreaterThan(5);
      const crop = edge.steps.find((x: string) => x.startsWith('crop:')) as string;
      expect(crop).toMatch(/partly cut by straightening/);
      expect(crop).not.toMatch(/given and kept/);
      // a subject well inside the frame is not reported as cut
      const mid = json(
        tool(
          'fix',
          f('clean.png'),
          f('mid.jpg'),
          '--angle',
          '2.5',
          '--subject',
          '0.3,0.3,0.7,0.7',
          '--aspect',
          '3:2',
          '--no-denoise',
          '--no-color',
          '--json',
        ),
      );
      expect(mid.warnings.join(' ')).not.toMatch(/CUT THE SUBJECT/);
      expect(mid.subject_cut).toBeUndefined();
      expect(mid.steps.find((x: string) => x.startsWith('crop:'))).toMatch(/given and kept/);
    });

    it('says when it could not trust the tilt, and still finishes the other steps', () => {
      make('flat', f('flat.png'));
      const r = tool('fix', f('flat.png'), f('flat-fixed.jpg'), '--size', '800x800');
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/straighten: skipped/);
      expect(r.stdout).toMatch(/WARNING: NOT STRAIGHTENED/);
      expect(r.stdout).toMatch(/WARNING: subject GUESSED/);
    });

    it('refuses (exit 2) when the shape cannot keep the subject', () => {
      const r = tool(
        'fix',
        f('clean.png'),
        f('nope2.jpg'),
        '--aspect',
        '9:16',
        '--subject',
        '0.05,0.1,0.95,0.9',
      );
      expect(r.status).toBe(2);
      expect(existsSync(f('nope2.jpg'))).toBe(false);
    });
  });

  describe('measure.py', () => {
    it('reports tilt, light, clipping, noise, size and SSIM against a reference', () => {
      const m = JSON.parse(tool('measure', f('clean.png'), f('clean.png'), '--json').stdout);
      expect(m).toMatchObject({ width: 1200, height: 800, aspect: '3:2', ssim: 1 });
      for (const k of [
        'tilt',
        'gray_world_error',
        'mean_luma',
        'clipped_highlights',
        'clipped_shadows',
        'noise',
      ])
        expect(m).toHaveProperty(k);
    });
  });

  describe('missing packages', () => {
    const BLOCKED = `
import sys, runpy, importlib.abc
block = set(sys.argv[1].split(","))
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in block:
            raise ModuleNotFoundError("No module named " + repr(name), name=name)
sys.meta_path.insert(0, Block())
script = sys.argv[2]
sys.argv = [script] + sys.argv[3:]
runpy.run_path(script, run_name="__main__")
`;
    it.each(['straighten', 'color', 'denoise_sharpen', 'crop', 'measure', 'fix'])(
      '%s.py names the install line, not a traceback',
      (name) => {
        for (const hidden of ['PIL', 'numpy']) {
          const r = spawnSync(
            python,
            ['-I', '-c', BLOCKED, hidden, join(scripts, `${name}.py`), f('clean.png'), f('x.png')],
            { encoding: 'utf8' },
          );
          expect(r.status).not.toBe(0);
          expect(r.stderr).not.toMatch(/Traceback/);
          expect(r.stderr).toContain('python3 -m pip install pillow numpy');
        }
      },
    );
  });

  describe('SKILL.md', () => {
    const md = readFileSync(join(scripts, '../SKILL.md'), 'utf8');
    it('starts with the fast path', () => {
      const body = md.split(/^---$/m)[2] ?? '';
      expect(body.trimStart().split('\n').slice(0, 3).join('\n')).toMatch(
        /^# Editing photos\n\n## FAST PATH/,
      );
    });
    it('gives the install line in every code block that runs one of the scripts', () => {
      const blocks = [...md.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
      const running = blocks.filter((b) =>
        /scripts\/(straighten|color|denoise_sharpen|crop|measure|fix)\.py/.test(b),
      );
      expect(running.length).toBeGreaterThan(2);
      for (const b of running) expect(b).toContain('python3 -m pip install pillow numpy');
    });
  });
});
