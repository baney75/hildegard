// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-motion's first loudness pass reads audio-only inputs, so its filter must count them from 0, and a pass that
// fails must say so instead of quietly rendering with dynamic normalization.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const scripts = resolve(import.meta.dirname, '../../../skills/hildegard-motion/scripts');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let dir: string;

const CODE = `
import json, pathlib, sys, types
sys.path.insert(0, sys.argv[1])
import motion
m = types.SimpleNamespace(audio=[{"file": p} for p in sys.argv[2:]], base_dir=pathlib.Path("."))
out = {"first": motion.audio_filter(m, 2.0)[0][0][:6]}
try:
    out["measured"] = motion.measure_loudness(m, 2.0, -14.0)
except SystemExit as e:
    out["stopped"] = str(e)
print(json.dumps(out))
`;
const measure = (...files: string[]) =>
  JSON.parse(execFileSync(python, ['-I', '-c', CODE, scripts, ...files], { encoding: 'utf8' })) as {
    first: string;
    measured?: { input_i: string } | null;
    stopped?: string;
  };

describe.skipIf(!hasFfmpeg)('motion.py loudness measurement', { timeout: 60_000 }, () => {
  const tone = (name: string, hz: number) => {
    const out = join(dir, name);
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${hz}:duration=2`,
      out,
    ]);
    return out;
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'motion-loudness-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('measures one track', () => {
    expect(Number(measure(tone('a.wav', 440)).measured?.input_i)).toBeLessThan(0);
  });

  it('measures two tracks', () => {
    expect(Number(measure(tone('b.wav', 440), tone('c.wav', 660)).measured?.input_i)).toBeLessThan(0);
  });

  it('keeps counting from 1 for the render, where input 0 is the picture', () => {
    expect(measure(tone('d.wav', 440)).first).toBe('[1:a]a');
  });

  it('stops with a plain reason when the measurement fails', () => {
    const bad = join(dir, 'bad.wav');
    writeFileSync(bad, 'this is not audio');
    expect(measure(bad).stopped).toMatch(/loudness/i);
  });
});
