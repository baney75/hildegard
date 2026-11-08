// SPDX-License-Identifier: AGPL-3.0-only
// The bundled checkers need Pillow, numpy or PyAV. When one is missing they say so in one plain line with the install
// command, not a traceback, and a check imports only what it uses: a still image needs no PyAV.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const INSTALL = 'python3 -m pip install pillow numpy av';
let dir: string;

// Runs a script as __main__ with the named top-level packages made unimportable, as on a machine without them.
const BLOCKED = `
import sys, runpy, importlib.abc
block = set(filter(None, sys.argv[1].split(",")))
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in block:
            raise ModuleNotFoundError("No module named " + repr(name), name=name)
sys.meta_path.insert(0, Block())
script = sys.argv[2]
sys.argv = [script] + sys.argv[3:]
runpy.run_path(script, run_name="__main__")
`;

const runBlocked = (script: string, hidden: string[], ...args: string[]) =>
  spawnSync(python, ['-I', '-c', BLOCKED, hidden.join(','), script, ...args], { encoding: 'utf8' });
const ffmpeg = (...args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

describe.skipIf(!hasFfmpeg)('review_media.py with a package missing', () => {
  const script = join(root, 'tools/review_media.py');
  let still: string;
  let video: string;
  let sound: string;
  const spec = (path: string) => {
    const file = join(dir, `${path.split('/').pop()}.json`);
    writeFileSync(file, JSON.stringify({ path }));
    return file;
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'missing-'));
    still = join(dir, 'still.png');
    video = join(dir, 'clip.mp4');
    sound = join(dir, 'tone.wav');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=640x640', '-frames:v', '1', still);
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2', '-pix_fmt', 'yuv420p', video);
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', sound);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('checks a still image without PyAV', () => {
    const r = runBlocked(script, ['av'], spec(still));
    expect(r.stderr).not.toMatch(/Traceback/);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, kind: 'image' });
  });

  for (const [what, hidden, file, name] of [
    ['a still image', 'PIL', () => still, 'Pillow'],
    ['a still image', 'numpy', () => still, 'numpy'],
    ['a video', 'av', () => video, 'PyAV'],
    ['a video', 'numpy', () => video, 'numpy'],
    ['a sound', 'av', () => sound, 'PyAV'],
  ] as const) {
    it(`says what to install when ${hidden} is missing for ${what}`, () => {
      const r = runBlocked(script, [hidden], spec(file()));
      expect(r.status).toBe(1);
      expect(r.stderr).not.toMatch(/Traceback/);
      const out = JSON.parse(r.stdout);
      expect(out.ok).toBe(false);
      expect(out.error).toContain(name);
      expect(out.error).toContain(INSTALL);
      // One plain line on stderr too, for a person running it by hand.
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain(INSTALL);
    });
  }
});

describe.skipIf(!hasFfmpeg)('the other checkers with a package missing', () => {
  const cases: [string, string, string[]][] = [
    ['tools/review_mesh.py', 'numpy', ['x.json']],
    ['tools/review_mesh.py', 'PIL', ['x.json']],
    ['skills/hildegard/scripts/contact_sheet.py', 'PIL', ['out.png', 'a.png']],
  ];
  for (const [file, hidden, args] of cases)
    it(`${file} says what to install when ${hidden} is missing`, () => {
      const r = runBlocked(join(root, file), [hidden], ...args);
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toMatch(/Traceback/);
      expect(r.stderr + r.stdout).toContain('pip install');
    });
});
