// SPDX-License-Identifier: AGPL-3.0-only
// tools/export_film.py on its own, with clips made here: silent ones, at two sizes, as Wan 2.2 renders them.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportPython, makePoster } from '../src/export.ts';

const script = fileURLToPath(new URL('../../../tools/export_film.py', import.meta.url));
const py = exportPython(mkdtempSync(join(tmpdir(), 'hg-py-')));
const python = (code: string, ...args: string[]) =>
  execFileSync(py, ['-I', '-c', code, ...args], { encoding: 'utf8' });

// A silent H.264 clip: `seconds` long at 24 fps, w×h.
const clip = (path: string, w: number, h: number, seconds: number) =>
  python(
    `import sys, av, numpy as np
path, w, h, s = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
with av.open(path, "w") as c:
    v = c.add_stream("libx264", rate=24); v.width, v.height, v.pix_fmt = w, h, "yuv420p"
    for i in range(round(s * 24)):
        f = av.VideoFrame.from_ndarray(np.full((h, w, 3), i % 255, np.uint8), format="rgb24")
        for p in v.encode(f): c.mux(p)
    for p in v.encode(): c.mux(p)`,
    path,
    String(w),
    String(h),
    String(seconds),
  );

describe('export_film.py', () => {
  it('gives a silent film a sound track, and sizes it by its sharpest take', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-export-'));
    const draft = join(dir, 'draft.mp4');
    const final = join(dir, 'final.mp4');
    clip(draft, 864, 480, 1);
    clip(final, 1248, 704, 1);
    const out = join(dir, 'film.mp4');
    const spec = join(dir, 'spec.json');
    writeFileSync(spec, JSON.stringify({ out, inputs: [draft, final], title: 'T', comment: 'C' }));
    const lines = execFileSync(py, ['-I', script, spec], { encoding: 'utf8' }).trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, seconds: 2 });

    const info = JSON.parse(
      python(
        `import sys, json, av
c = av.open(sys.argv[1]); v = c.streams.video[0]
print(json.dumps({"types": [s.type for s in c.streams], "w": v.codec_context.width, "h": v.codec_context.height,
  "audio": float(c.streams.audio[0].duration * c.streams.audio[0].time_base) if c.streams.audio else 0}))`,
        out,
      ),
    );
    expect(info.types).toEqual(['video', 'audio']);
    expect([info.w, info.h]).toEqual([1248, 704]);
    expect(info.audio).toBeCloseTo(2, 1);
  }, 60_000);
});

describe('poster.py', () => {
  it('makes a full-size poster from a finished take, and reports failure for a broken one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-poster-'));
    const video = join(dir, 'take.mp4');
    clip(video, 1248, 704, 1);
    const jpg = join(dir, 'take.jpg');
    expect(await makePoster(dir, video, jpg)).toBe(true);
    expect(
      python('import sys; from PIL import Image; print(*Image.open(sys.argv[1]).size)', jpg).trim(),
    ).toBe('1248 704');
    writeFileSync(join(dir, 'broken.mp4'), 'not a video');
    expect(await makePoster(dir, join(dir, 'broken.mp4'), join(dir, 'broken.jpg'))).toBe(false);
  }, 60_000);
});
