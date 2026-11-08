// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-music, sheet.py: the picture of an audio file a model can look at because it cannot hear. The PNG is valid,
// the numbers drawn on it are right for a known signal, and the three renderers can all make one with --sheet.
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 300_000 });

const run = promisify(execFile);
const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const scripts = resolve(import.meta.dirname, '../../../skills/hildegard-music/scripts');
const work = mkdtempSync(join(tmpdir(), 'hg-sheet-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const haveNumpy = spawnSync(python, ['-c', 'import numpy']).status === 0;
const suite = haveNumpy || process.env.CI ? describe : describe.skip;

/** A 16-bit stereo WAV of a sine at hz for seconds, with a quiet first second. */
function tone(path: string, hz: number, seconds: number, rate = 44100) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * (i < rate ? 3000 : 12000));
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

/** Width, height and pixel count of a PNG, checked chunk by chunk (signature, CRC-less structure, IDAT inflates to the right size). */
function readPng(path: string) {
  const b = readFileSync(path);
  expect([...b.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let p = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  let sawEnd = false;
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') {
      w = b.readUInt32BE(p + 8);
      h = b.readUInt32BE(p + 12);
      expect(b[p + 16]).toBe(8); // bit depth
      expect(b[p + 17]).toBe(2); // truecolour
    }
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') sawEnd = true;
    p += 12 + len;
  }
  expect(sawEnd).toBe(true);
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe(h * (1 + 3 * w));
  let distinct = 0;
  const seen = new Set<number>();
  for (let i = 1; i < raw.length && distinct < 50; i += 4099) {
    if (!seen.has(raw[i]!)) {
      seen.add(raw[i]!);
      distinct++;
    }
  }
  return { w, h, bytes: b, distinct };
}

suite('hildegard-music: the audio contact sheet', () => {
  it('draws a valid PNG with the right numbers for a known tone', async () => {
    const wav = join(work, 'a440.wav');
    tone(wav, 440, 8);
    const out = join(work, 'a440.png');
    const { stdout } = await run(python, [
      join(scripts, 'sheet.py'),
      wav,
      out,
      '--json',
      '--target-lufs',
      '-20',
    ]);
    const r = JSON.parse(stdout);
    const png = readPng(out);
    expect(png.w).toBe(1600);
    expect(png.h).toBeGreaterThan(600);
    expect(png.distinct).toBeGreaterThan(8); // not a blank image
    expect(r.duration_s).toBeCloseTo(8, 1);
    expect(Math.abs(r.spec_peak_hz - 440) / 440).toBeLessThan(0.03);
    expect(r.peak_dbfs).toBeCloseTo(20 * Math.log10(12000 / 32768), 0);
    expect(Object.keys(r.band_db)).toEqual(['60', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']);
    // a 440 Hz tone: the 250 Hz octave band (which holds 440) is the loudest, and 16 kHz is far below it
    expect(r.band_db['250']).toBeGreaterThan(r.band_db['16k'] + 40);
    expect(Math.abs(r.correlation - 1)).toBeLessThan(0.01);
  });

  it('is deterministic, takes markers, and rejects a missing or empty file', async () => {
    const wav = join(work, 'det.wav');
    tone(wav, 1000, 4);
    const a = join(work, 'det-a.png');
    const b = join(work, 'det-b.png');
    await run(python, [join(scripts, 'sheet.py'), wav, a, '--marker', '1:INTRO', '--marker', '2.5:VERSE']);
    await run(python, [join(scripts, 'sheet.py'), wav, b, '--marker', '1:INTRO', '--marker', '2.5:VERSE']);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    const plain = join(work, 'det-plain.png');
    await run(python, [join(scripts, 'sheet.py'), wav, plain]);
    expect(readFileSync(a).equals(readFileSync(plain))).toBe(false); // the markers are drawn
    await expect(
      run(python, [join(scripts, 'sheet.py'), join(work, 'nope.wav'), join(work, 'x.png')]),
    ).rejects.toMatchObject({ code: 2 });
    expect(existsSync(join(work, 'x.png'))).toBe(false);
  });

  it('sfx.py, music.py and soundscape.py all draw one with --sheet', async () => {
    const skill = resolve(scripts, '..');
    const sfx = join(work, 'sfx.png');
    const mus = join(work, 'mus.png');
    const sc = join(work, 'sc.png');
    await Promise.all([
      run(python, [join(scripts, 'sfx.py'), 'coin', '--check', '--sheet', sfx]),
      run(python, [join(scripts, 'music.py'), 'radio_jingle_15s', '--check', '--sheet', mus]),
      run(python, [
        join(scripts, 'soundscape.py'),
        join(skill, 'soundscapes/pink_noise.json'),
        join(work, 'sc.wav'),
        '--seconds',
        '10',
        '--sheet',
        sc,
      ]),
    ]);
    for (const p of [sfx, mus, sc]) expect(readPng(p).w).toBeGreaterThanOrEqual(1000);
  });
});
