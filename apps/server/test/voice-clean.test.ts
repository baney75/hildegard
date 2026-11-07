// SPDX-License-Identifier: AGPL-3.0-only
// tools/voice_clean.py and the voice-over in tools/export_film.py, on clips made here and measured by a separate meter
// (test/fixtures/audio_check.py: BS.1770 in numpy), so neither grades itself.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, exportScript, info, make, measure, py, runTool, voiceCleanScript } from './audio.ts';

const dir = mkdtempSync(join(tmpdir(), 'hg-clean-'));
const f = (name: string) => join(dir, name);
const clean = (
  src: string,
  out: string,
  extra: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
) => {
  const spec = `${out}.spec.json`;
  writeFileSync(spec, JSON.stringify({ src, out, ...extra }));
  return runTool(voiceCleanScript, spec, env);
};

describe('voice_clean.py', () => {
  it('brings noisy speech to the loudness target with the true peak under the ceiling, as a separate meter reads it', () => {
    make('speech', f('noisy.wav'), '10', '3');
    const before = measure(f('noisy.wav'));
    // The recording starts quiet and peaky, with hum and hiss: nowhere near the target.
    expect(Math.abs(before.lufs - -16)).toBeGreaterThan(3);
    const r = clean(f('noisy.wav'), f('clean.wav'));
    expect(r).toMatchObject({ ok: true, backend: 'pyav' });
    const after = measure(f('clean.wav'));
    expect(Math.abs(after.lufs - -16)).toBeLessThanOrEqual(1);
    expect(after.true_peak).toBeLessThanOrEqual(-1.5);
    expect(after.seconds).toBeCloseTo(10, 1);
    // What it reports is what the other meter finds.
    expect(Math.abs((r.lufs as number) - after.lufs)).toBeLessThan(0.5);
    expect(Math.abs((r.true_peak as number) - after.true_peak)).toBeLessThan(0.5);
    // The hum is gone: 60 Hz was 20 dB or so above the hiss, and now sits far under the speech.
    const hum = (file: string) => check<{ db: number }>('band', file, '60', '0', '10').db;
    expect(hum(f('clean.wav')) - hum(f('noisy.wav'))).toBeLessThan(-12);
  }, 60_000);

  it('takes other targets, and refuses ones that make no sense', () => {
    make('speech', f('t.wav'), '8', '5');
    expect(clean(f('t.wav'), f('t-23.wav'), { target_lufs: -23, peak: -3 })).toMatchObject({ ok: true });
    const m = measure(f('t-23.wav'));
    expect(Math.abs(m.lufs - -23)).toBeLessThanOrEqual(1);
    expect(m.true_peak).toBeLessThanOrEqual(-3);
    expect(clean(f('t.wav'), f('bad.wav'), { target_lufs: 3 })).toMatchObject({ ok: false });
    expect(clean(f('t.wav'), f('bad.wav'), { peak: 4 })).toMatchObject({ ok: false });
  }, 60_000);

  it('cleans the sound of a video and keeps its picture as it was (mp4 and webm)', () => {
    for (const ext of ['mp4', 'webm']) {
      make('video', f(`v.${ext}`), '6', '2');
      const r = clean(f(`v.${ext}`), f(`v-clean.${ext}`));
      expect(r, ext).toMatchObject({ ok: true });
      const i = info(f(`v-clean.${ext}`));
      expect(i.types.sort(), ext).toEqual(['audio', 'video']);
      expect(i.audio_seconds, ext).toBeCloseTo(6, 0);
      const m = measure(f(`v-clean.${ext}`));
      expect(Math.abs(m.lufs - -16), ext).toBeLessThanOrEqual(1);
      expect(m.true_peak, ext).toBeLessThanOrEqual(-1.5);
      // The picture is copied, not re-encoded: the same codec and the same frame count.
      const frames = (p: string) =>
        execFileSync(
          py,
          [
            '-I',
            '-c',
            'import sys, av\nc = av.open(sys.argv[1]); v = c.streams.video[0]\nprint(v.codec_context.name, sum(1 for p in c.demux(v) if p.size))',
            p,
          ],
          { encoding: 'utf8' },
        ).trim();
      expect(frames(f(`v-clean.${ext}`)), ext).toBe(frames(f(`v.${ext}`)));
    }
  }, 120_000);

  it('does its work with an ffmpeg on PATH when this PyAV lacks the filters, and says so plainly with neither', () => {
    make('speech', f('ff.wav'), '8', '7');
    let ffmpeg = true;
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
      ffmpeg = false;
    }
    if (ffmpeg) {
      const r = clean(f('ff.wav'), f('ff-clean.wav'), {}, { HILDEGARD_CLEAN_BACKEND: 'ffmpeg' });
      expect(r).toMatchObject({ ok: true, backend: 'ffmpeg' });
      const m = measure(f('ff-clean.wav'));
      expect(Math.abs(m.lufs - -16)).toBeLessThanOrEqual(1);
      expect(m.true_peak).toBeLessThanOrEqual(-1.5);
    }
    const none = clean(f('ff.wav'), f('none.wav'), {}, { HILDEGARD_CLEAN_BACKEND: 'ffmpeg', PATH: dir });
    expect(none).toMatchObject({ ok: false });
    expect(String(none.error)).toMatch(/neither a PyAV with them nor ffmpeg/);
  }, 90_000);

  it('says what is wrong with a file that is silent, has no sound, or is not media at all', () => {
    // Digital silence.
    execFileSync(py, [
      '-I',
      '-c',
      'import sys, av, numpy as np\nfrom fractions import Fraction\nc = av.open(sys.argv[1], "w", format="wav"); s = c.add_stream("pcm_s16le", rate=48000, layout="mono")\nfr = av.AudioFrame.from_ndarray(np.zeros((1, 48000), np.int16), format="s16", layout="mono"); fr.sample_rate = 48000; fr.pts = 0; fr.time_base = Fraction(1, 48000)\nfor p in s.encode(fr): c.mux(p)\nfor p in s.encode(): c.mux(p)\nc.close()',
      f('silent.wav'),
    ]);
    expect(clean(f('silent.wav'), f('o.wav'))).toMatchObject({
      ok: false,
      error: 'There’s no speech in that recording.',
    });
    writeFileSync(f('junk.wav'), 'this is not audio');
    expect(clean(f('junk.wav'), f('o.wav'))).toMatchObject({
      ok: false,
      error: 'Hildegard couldn’t read that recording.',
    });
  }, 60_000);

  it('writes the sound and the picture of a long clip in time order, past the muxer’s 10 s hold (mp4 and webm)', () => {
    for (const ext of ['mp4', 'webm']) {
      make('video', f(`long.${ext}`), '20', '2');
      const r = clean(f(`long.${ext}`), f(`long-clean.${ext}`));
      expect(r, ext).toMatchObject({ ok: true });
      const i = info(f(`long-clean.${ext}`));
      expect(i.types.sort(), ext).toEqual(['audio', 'video']);
      expect(Math.abs((i.seconds ?? 0) - 20), ext).toBeLessThan(0.1);
      expect(Math.abs(i.audio_seconds - 20), ext).toBeLessThan(0.1);
      // In file order the two never sit more than half a second apart; all the picture first would be ~10 s.
      expect(check<{ max_gap: number }>('gaps', f(`long-clean.${ext}`)).max_gap, ext).toBeLessThan(0.5);
    }
  }, 120_000);

  it('works on the speech clip in the repo’s fixtures', () => {
    copyFileSync(
      fileURLToPath(new URL('./fixtures/talk/lighthouse.wav', import.meta.url)),
      f('lighthouse.wav'),
    );
    const r = clean(f('lighthouse.wav'), f('lighthouse-clean.wav'));
    expect(r).toMatchObject({ ok: true });
    const m = measure(f('lighthouse-clean.wav'));
    expect(Math.abs(m.lufs - -16)).toBeLessThanOrEqual(1);
    expect(m.true_peak).toBeLessThanOrEqual(-1.5);
  }, 60_000);
});

describe('export_film.py with a voice-over', () => {
  // Two 4 s clips with a steady 6 kHz tone for sound, 8 s in all; the voice is 8 s of noisy speech made clean first.
  const film = (name: string, voiceover: Record<string, unknown> | null) => {
    const spec = f(`${name}.json`);
    writeFileSync(
      spec,
      JSON.stringify({
        out: f(`${name}.mp4`),
        inputs: [f('c1.mp4'), f('c2.mp4')],
        title: 'T',
        comment: 'C',
        ...(voiceover ? { voiceover } : {}),
      }),
    );
    return runTool(exportScript, spec);
  };

  it('mixes the voice over the film at -14 LUFS, ducks the film while it speaks, and keeps the film’s length', () => {
    make('film', f('c1.mp4'), '4', '0.2', '6000');
    make('film', f('c2.mp4'), '4', '0.2', '6000');
    make('speech', f('vo-raw.wav'), '6', '4');
    expect(clean(f('vo-raw.wav'), f('vo.wav'))).toMatchObject({ ok: true });

    const plain = film('plain', null);
    expect(plain).toMatchObject({ ok: true, seconds: 8 });
    const withVoice = film('mixed', { path: f('vo.wav'), start_seconds: 1 });
    expect(withVoice).toMatchObject({ ok: true, seconds: 8 });

    // Loudness, as the separate meter reads the file: -14 LUFS within one LU.
    const m = measure(f('mixed.mp4'));
    expect(Math.abs(m.lufs - -14)).toBeLessThanOrEqual(1);
    expect(m.true_peak).toBeLessThanOrEqual(-1);
    // The film's own sound (the 6 kHz tone; the voice has none up there) is at least 8 dB lower while the voice
    // speaks (1 to 7 s) than outside it, and the same length as before.
    const tone = (t0: string, t1: string) => check<{ db: number }>('band', f('mixed.mp4'), '6000', t0, t1).db;
    const outside = Math.max(tone('0.1', '0.8'), tone('7.4', '7.95'));
    const during = tone('2', '6');
    expect(outside - during).toBeGreaterThanOrEqual(8);
    expect(info(f('mixed.mp4')).audio_seconds).toBeCloseTo(info(f('plain.mp4')).audio_seconds, 1);
    expect(info(f('mixed.mp4')).seconds).toBeCloseTo(8, 1);
    // Without the voice-over the film is untouched: its tone reads the same everywhere.
    const steady = (t0: string, t1: string) =>
      check<{ db: number }>('band', f('plain.mp4'), '6000', t0, t1).db;
    expect(Math.abs(steady('0.1', '0.8') - steady('2', '6'))).toBeLessThan(1);
  }, 120_000);

  it('follows duck_db and gain_db', () => {
    const shallow = film('shallow', { path: f('vo.wav'), start_seconds: 1, duck_db: 3 });
    expect(shallow).toMatchObject({ ok: true });
    const tone = (name: string, t0: string, t1: string) =>
      check<{ db: number }>('band', f(`${name}.mp4`), '6000', t0, t1).db;
    const dip = (name: string) =>
      Math.max(tone(name, '0.1', '0.8'), tone(name, '7.4', '7.95')) - tone(name, '2', '6');
    expect(dip('shallow')).toBeLessThan(dip('mixed'));
    expect(dip('shallow')).toBeLessThan(6);
  }, 120_000);

  it('pads a short voice and trims a long one to the film’s length, and refuses one that starts after the film', () => {
    make('speech', f('long.wav'), '12', '9');
    const trimmed = film('trimmed', { path: f('long.wav'), start_seconds: 0 });
    expect(trimmed).toMatchObject({ ok: true, seconds: 8 });
    expect(info(f('trimmed.mp4')).audio_seconds).toBeCloseTo(8, 1);
    // The 6 s voice started at 5 s runs past the end of the 8 s film, and is cut there.
    const late = film('late', { path: f('vo.wav'), start_seconds: 5 });
    expect(late).toMatchObject({ ok: true, seconds: 8 });
    expect(info(f('late.mp4')).audio_seconds).toBeCloseTo(8, 1);
    const after = film('after', { path: f('vo.wav'), start_seconds: 9 });
    expect(after).toMatchObject({ ok: false, error: 'The voice-over starts after the film ends.' });
  }, 120_000);

  it('lays a voice over takes with no sound, or sound shorter than their picture, and keeps the sound as long as the picture', () => {
    make('speech', f('v2-raw.wav'), '2', '6');
    expect(clean(f('v2-raw.wav'), f('v2.wav'))).toMatchObject({ ok: true });
    const frame = 1 / 24;
    const level = (file: string, t0: string, t1: string) => check<{ db: number }>('level', file, t0, t1).db;
    const one = (name: string, inputs: string[]) => {
      const spec = f(`${name}.json`);
      writeFileSync(
        spec,
        JSON.stringify({
          out: f(`${name}.mp4`),
          inputs,
          voiceover: { path: f('v2.wav'), start_seconds: 1 },
        }),
      );
      return runTool(exportScript, spec);
    };
    // A take with no audio track at all (a Wan take), then one whose tone stops at 1 s, in a 4 s picture.
    make('silent', f('nosound.mp4'), '4');
    make('film', f('shortsound.mp4'), '4', '0.2', '6000', '1');
    for (const [name, take] of [
      ['nosound', f('nosound.mp4')],
      ['shortsound', f('shortsound.mp4')],
    ] as const) {
      expect(one(`vo-${name}`, [take]), name).toMatchObject({ ok: true, seconds: 4 });
      const i = info(f(`vo-${name}.mp4`));
      expect(Math.abs(i.audio_seconds - 4), name).toBeLessThanOrEqual(frame);
      expect(Math.abs((i.seconds ?? 0) - 4), name).toBeLessThanOrEqual(frame);
      // The voice is at its place: 1 s to 3 s. Before it and after it the film has no sound (for the short sound, its
      // tone ended at 1 s and was padded with silence).
      const speaking = level(f(`vo-${name}.mp4`), '1.2', '2.8');
      expect(speaking, name).toBeGreaterThan(-40);
      expect(level(f(`vo-${name}.mp4`), '3.3', '3.9'), name).toBeLessThan(speaking - 30);
      if (name === 'nosound')
        expect(level(f(`vo-${name}.mp4`), '0.1', '0.9'), name).toBeLessThan(speaking - 30);
    }
    // And two takes in a row, the first with no sound and the second with, stay in step.
    expect(one('vo-mixed', [f('nosound.mp4'), f('shortsound.mp4')])).toMatchObject({ ok: true, seconds: 8 });
    expect(Math.abs(info(f('vo-mixed.mp4')).audio_seconds - 8)).toBeLessThanOrEqual(frame);
  }, 180_000);
});
