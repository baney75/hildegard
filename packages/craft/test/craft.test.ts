// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeRubric, describeReview, lintPrompt, type Review, reviewMedia, rubric } from '../src/index.ts';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const script = resolve(import.meta.dirname, '../../../tools/review_media.py');
let dir: string;

/** Test media made with PyAV, as CI has it for the export tests: a moving picture with sound, and broken ones. */
const MAKE = `
import sys, av, numpy as np
from fractions import Fraction
out, kind = sys.argv[1], sys.argv[2]
W, H, FPS, N = 640, 360, 24, 72
with av.open(out, "w", format="mp4") as c:
    v = c.add_stream("libx264", rate=FPS); v.width, v.height, v.pix_fmt = W, H, "yuv420p"
    a = c.add_stream("aac", rate=48000, layout="stereo") if kind in ("good", "loud") else None
    y, x = np.mgrid[0:H, 0:W]
    for i in range(N):
        if kind == "black":
            img = np.zeros((H, W, 3), np.uint8)
        elif kind == "flicker":
            img = np.full((H, W, 3), 200 if i % 2 else 50, np.uint8)
        elif kind == "neon":
            img = np.zeros((H, W, 3), np.uint8); img[..., 0] = 255; img[..., 2] = ((x + i * 4) % 255).astype(np.uint8)
        else:
            base = ((x + i * 6) % W) / W * 0.6 + (y / H) * 0.3 + 0.05
            img = np.stack([base * 0.9, base * 0.8, base * 0.7], -1)
            img = (np.clip(img, 0, 1) * 255).astype(np.uint8)
        f = av.VideoFrame.from_ndarray(img, format="rgb24")
        for p in v.encode(f): c.mux(p)
    for p in v.encode(): c.mux(p)
    if a:
        amp = 0.99 if kind == "loud" else 0.1
        t = np.arange(48000 * N // FPS) / 48000
        s = np.clip(np.sin(2 * np.pi * 220 * t) * (1.6 if kind == "loud" else 1) * amp, -1, 1).astype(np.float32)
        for k in range(0, len(s), 1024):
            chunk = np.stack([s[k:k+1024], s[k:k+1024]])
            fr = av.AudioFrame.from_ndarray(chunk, format="fltp", layout="stereo"); fr.sample_rate = 48000
            fr.pts = k; fr.time_base = Fraction(1, 48000)
            for p in a.encode(fr): c.mux(p)
        for p in a.encode(): c.mux(p)
`;

const make = (kind: string) => {
  const out = join(dir, `${kind}.mp4`);
  execFileSync(python, ['-I', join(dir, 'make.py'), out, kind]);
  return out;
};
const status = (r: Review, id: string) => r.checks.find((c) => c.id === id)?.status;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hg-craft-'));
  writeFileSync(join(dir, 'make.py'), MAKE);
});

describe('prompt lint', () => {
  it('passes a specific, sentence-shaped prompt', () => {
    const r = lintPrompt(
      'An old fisherman in a yellow oilskin hauls a crab pot over the rail at dawn while spray hits the deck and gulls wheel behind him.',
    );
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails quality boosters and tag salad, and says what to write instead', () => {
    const r = lintPrompt('beautiful woman, 8k, masterpiece, trending on artstation, cinematic, epic, hdr');
    expect(r.ok).toBe(false);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toContain('quality-words');
    expect(ids).toContain('tag-salad');
    expect(ids).toContain('too-thin');
    const boost = r.findings.find((f) => f.id === 'quality-words')!;
    expect(boost.match).toEqual(expect.arrayContaining(['8k', 'masterpiece', 'trending on artstation', 'cinematic']));
    expect(boost.fix).toMatch(/Delete them/);
  });

  it('matches whole words only', () => {
    // "epicentre" isn't "epic"; "ammonite" isn't a focal length.
    const r = lintPrompt(
      'A geologist kneels at the epicentre of a dry riverbed and brushes dust from an ammonite while the wind lifts her hair.',
    );
    expect(r.findings).toEqual([]);
  });

  it('warns on camera words, negation, several beats and named artists', () => {
    const r = lintPrompt(
      'Shot on 35mm film with a 50mm lens: a woman with no umbrella walks to the bus stop, then waits, then boards, in the style of Gregory Crewdson.',
    );
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['camera-in-prompt', 'negation', 'too-many-beats', 'named-artist']));
    expect(r.ok).toBe(true); // only warnings: choices the agent may make on purpose
    expect(lintPrompt('Shot on 35mm film, a woman walks to the bus stop in the rain at night alone.', 'video', false).findings.map((f) => f.id)).not.toContain('camera-in-prompt');
  });

  it('catches stock phrases in words, and lyric clichés in songs', () => {
    expect(lintPrompt('Delve into a tapestry of sound that will elevate your journey.', 'words').ok).toBe(false);
    const song = lintPrompt('Verse about chasing dreams into the night, with fire in my soul.', 'music');
    expect(song.findings.map((f) => f.id)).toContain('lyric-cliches');
    expect(lintPrompt('Plain words about the harbour wall and the 6:40 ferry.', 'words').ok).toBe(true);
  });
});

describe('rubric', () => {
  it('asks the questions that fit the medium, always including looking and consent', () => {
    const ids = (m: Parameters<typeof rubric>[0]) => rubric(m).map((q) => q.id);
    expect(ids('image')).toEqual(expect.arrayContaining(['anatomy', 'text', 'looked', 'people']));
    expect(ids('image')).not.toContain('one-action');
    expect(ids('video')).toContain('stable');
    expect(ids('sequence')).toEqual(expect.arrayContaining(['continuity', 'cut', 'clean']));
    expect(ids('voice')).toContain('consent');
    for (const m of ['image', 'video', 'sequence', 'music', 'voice', 'words'] as const)
      for (const q of rubric(m)) expect(q.fix.length).toBeGreaterThan(10);
    expect(describeRubric('video')).toMatch(/^Answer each/);
  });
});

describe('media review', () => {
  it('passes a clean moving shot with sound, and draws a contact sheet', async () => {
    const sheet = join(dir, 'good.jpg');
    const r = await reviewMedia(python, script, { path: make('good'), sheet, seconds: 3, audio: true });
    expect(r.kind).toBe('video');
    expect(r.info).toMatchObject({ width: 640, height: 360, frames: 72, audio: true, sheet: true });
    expect(r.passed).toBe(true);
    expect(status(r, 'loudness')).toBeDefined();
    expect(existsSync(sheet)).toBe(true);
    expect(describeReview(r)).toMatch(/^Technical checks passed/);
  });

  it('fails black frames, flicker, pushed colour and clipping', async () => {
    expect(status(await reviewMedia(python, script, { path: make('black') }), 'black_frames')).toBe('fail');
    expect(status(await reviewMedia(python, script, { path: make('flicker') }), 'flicker')).toBe('fail');
    const neon = await reviewMedia(python, script, { path: make('neon'), final: true });
    expect(status(neon, 'colour')).toBe('fail');
    expect(status(neon, 'size')).toBe('fail'); // 360 is under the final bar of 720
    const loud = await reviewMedia(python, script, { path: make('loud'), audio: true });
    expect(status(loud, 'clipping')).toBe('fail');
    expect(describeReview(loud)).toMatch(/FAIL clipping/);
  });

  it('fails when the brief asked for sound and there is none', async () => {
    const r = await reviewMedia(python, script, { path: make('flicker'), audio: true });
    expect(status(r, 'sound')).toBe('fail');
  });

  it('says plainly when the file is not media', async () => {
    const bad = join(dir, 'notes.mp4');
    writeFileSync(bad, 'not a video');
    await expect(reviewMedia(python, script, { path: bad })).rejects.toThrow();
  });
});
