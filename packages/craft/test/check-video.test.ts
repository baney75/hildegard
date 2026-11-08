// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-video-edit's check_video.py: a true peak over the ceiling is a FIX, and cuts are counted from the picture,
// so one moving shot is not many cuts.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'skills/hildegard-video-edit/scripts/check_video.py');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let dir: string;

const ffmpeg = (...args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const check = (file: string, ...args: string[]) =>
  spawnSync(python, ['-I', script, file, ...args], { encoding: 'utf8' });
const cuts = (file: string) => Number(check(file).stdout.match(/cuts or transitions: (\d+)/)?.[1]);
const loudness = (file: string) => Number(check(file).stdout.match(/loudness: (-?[\d.]+) LUFS/)?.[1]);

describe.skipIf(!hasFfmpeg)('check_video.py', { timeout: 120_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-video-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  describe('true peak', () => {
    const withSound = (name: string, gain: number) => {
      const out = join(dir, name);
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30:duration=3',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3:sample_rate=48000',
        '-af',
        `volume=${gain}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        out,
      );
      return out;
    };

    it('says FIX when the loudness is on target but the true peak is over the ceiling', () => {
      const hot = withSound('hot.mp4', 7.9); // a full-scale sine: peaks at about -0.1 dBFS
      const target = Math.round(loudness(hot));
      const r = check(hot, '--lufs', String(target));
      expect(r.stdout).toMatch(/loudness: .* LUFS {2}OK/);
      expect(r.stdout).toMatch(/true peak: .*dBTP.*FIX/);
      expect(r.stdout).toMatch(/RESULT: FIX/);
      expect(r.status).toBe(1);
    });

    it('passes a peak under the ceiling, and --peak moves the ceiling', () => {
      const ok = withSound('ok.mp4', 3.9); // about -6 dBFS
      const target = Math.round(loudness(ok));
      const r = check(ok, '--lufs', String(target));
      expect(r.stdout).toMatch(/true peak: .*dBTP.* OK/);
      expect(r.status, r.stdout).toBe(0);
      expect(check(ok, '--lufs', String(target), '--peak', '-9').status).toBe(1);
    });
  });

  describe('cuts', () => {
    const clip = (name: string, source: string) => {
      const out = join(dir, name);
      ffmpeg('-f', 'lavfi', '-i', source, '-t', '2', '-pix_fmt', 'yuv420p', '-r', '30', out);
      return out;
    };
    const join6 = (name: string, files: string[]) => {
      const list = join(dir, `${name}.txt`);
      writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
      const out = join(dir, name);
      ffmpeg('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out);
      return out;
    };

    it('counts 0 for one ten-second pan with the camera moving on and off', () => {
      const pan = join(dir, 'pan.mp4');
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        "testsrc2=size=640x360:rate=30:duration=10,crop=500:300:x='70+60*sin(t*5)':y='30+30*cos(t*7)'",
        '-pix_fmt',
        'yuv420p',
        pan,
      );
      expect(cuts(pan)).toBe(0);
      const r = check(pan, '--cuts', '5');
      expect(r.stdout).toMatch(/cuts or transitions: 0 {2}FIX/);
      expect(r.status).toBe(1);
    });

    it('counts 0 for a smooth grayscale ramp, however many histogram bins it crosses', () => {
      const ramp = join(dir, 'ramp.mp4');
      // RGB 32 to 223 over ten seconds: five bin boundaries, one continuous change.
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        "color=c=black:size=640x360:rate=30:duration=10,format=yuv420p,geq=lum='32+19.1*T':cb=128:cr=128",
        '-pix_fmt',
        'yuv420p',
        ramp,
      );
      expect(cuts(ramp)).toBe(0);
      expect(check(ramp, '--cuts', '5').stdout).toMatch(/cuts or transitions: 0 {2}FIX/);
    });

    it('counts 0 for a long zoom, and for a fast scroll', () => {
      const zoom = join(dir, 'zoom.mp4');
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'mandelbrot=size=640x360:rate=30,trim=duration=10',
        '-pix_fmt',
        'yuv420p',
        zoom,
      );
      expect(cuts(zoom)).toBe(0);
      const scroll = join(dir, 'scroll.mp4');
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=30:duration=10,scroll=horizontal=0.05',
        '-pix_fmt',
        'yuv420p',
        scroll,
      );
      expect(cuts(scroll)).toBe(0);
    });

    it('counts 5 for six different clips cut together', () => {
      const sources = [
        'testsrc=size=640x360:rate=30',
        'smptebars=size=640x360:rate=30',
        'color=c=0x204080:size=640x360:rate=30',
        'mandelbrot=size=640x360:rate=30',
        'rgbtestsrc=size=640x360:rate=30',
        'life=size=640x360:rate=30:mold=10:ratio=0.1:death_color=#C83232:life_color=#00ff00',
      ];
      const six = join6(
        'six.mp4',
        sources.map((s, i) => clip(`c${i}.mp4`, s)),
      );
      expect(cuts(six)).toBe(5);
      expect(check(six, '--cuts', '5').stdout).toMatch(/cuts or transitions: 5 {2}OK/);
    });

    it('counts a cut between two shots of the same colours', () => {
      const a = clip('same.mp4', 'testsrc=size=640x360:rate=30');
      const b = join(dir, 'same-flipped.mp4');
      ffmpeg('-i', a, '-vf', 'hflip', b);
      expect(cuts(join6('mirror.mp4', [a, b, a]))).toBe(2);
    });

    it('counts crossfades, as cut_reel makes them', () => {
      const [a = '', b = '', c = ''] = [
        'testsrc=size=640x360:rate=30',
        'smptebars=size=640x360:rate=30',
        'mandelbrot=size=640x360:rate=30',
      ].map((s, i) => clip(`x${i}.mp4`, s));
      const out = join(dir, 'fade.mp4');
      ffmpeg(
        '-i',
        a,
        '-i',
        b,
        '-i',
        c,
        '-filter_complex',
        '[0][1]xfade=transition=fade:duration=0.4:offset=1.6[v];[v][2]xfade=transition=fade:duration=0.4:offset=3.2',
        '-pix_fmt',
        'yuv420p',
        out,
      );
      expect(cuts(out)).toBe(2);
    });
  });
  describe.skipIf(process.platform === 'win32')('an analysis ffmpeg could not run', () => {
    // A stand-in ffmpeg first on PATH: the real one, except where `broken` matches the arguments.
    const stub = (name: string, broken: string, body: string) => {
      const bin = join(dir, name);
      mkdirSync(bin, { recursive: true });
      const real = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
      const file = join(bin, 'ffmpeg');
      writeFileSync(file, `#!/bin/sh\ncase "$*" in *${broken}*) ${body};; esac\nexec "${real}" "$@"\n`);
      chmodSync(file, 0o755);
      return bin;
    };
    const withStub = (bin: string, file: string) =>
      spawnSync(python, ['-I', script, file], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      });
    const clip = () => {
      const out = join(dir, 'plain.mp4');
      ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', '-pix_fmt', 'yuv420p', out);
      return out;
    };

    it('is a FIX when blackdetect is missing, not "no black frames"', () => {
      const bin = stub('no-blackdetect', 'blackdetect', 'echo "No such filter: blackdetect" >&2; exit 1');
      const r = withStub(bin, clip());
      expect(r.stdout).toMatch(/black frames: not checked {2}FIX: .*blackdetect did not run/);
      expect(r.stdout).not.toMatch(/none over half a second/);
      expect(r.stdout).toMatch(/RESULT: FIX/);
      expect(r.status).toBe(1);
    });

    it('is a FIX when ffmpeg exits 0 but never finished its run', () => {
      const bin = stub('silent', 'blackdetect', 'exit 0');
      const r = withStub(bin, clip());
      expect(r.stdout).toMatch(/black frames: not checked {2}FIX/);
      expect(r.status).toBe(1);
    });

    it('still passes an honest clip with the real ffmpeg', () => {
      const r = spawnSync(python, ['-I', script, clip()], { encoding: 'utf8' });
      expect(r.stdout).toMatch(/black frames: none over half a second {2}OK/);
    });
  });
});
