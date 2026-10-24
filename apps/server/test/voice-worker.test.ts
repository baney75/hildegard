// SPDX-License-Identifier: AGPL-3.0-only
/** The bridge to the real Python worker, running its stand-in model: needs a Python with numpy and soundfile. */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalVoiceEngine, VoiceEngineError, wavSeconds } from '../src/voice-engine.ts';

const dir = mkdtempSync(join(tmpdir(), 'hg-worker-'));
const python = process.platform === 'win32' ? 'python' : 'python3';
const engine = new LocalVoiceEngine({
  dataDir: dir,
  engineDir: resolve(import.meta.dirname, '../../../voice-engine'),
  python: () => process.env.HILDEGARD_TEST_PYTHON ?? python,
  ready: (env) => env === 'speech',
  env: { HILDEGARD_VOICE_FAKE_MARK: '1' },
  idleMs: 60_000,
});
afterAll(() => engine.close());
const FAKE = { engine: 'fake', dir: '' };

describe('LocalVoiceEngine', () => {
  it('speaks through the worker, with progress', async () => {
    const out = join(dir, 'a.wav');
    const progress: number[] = [];
    const r = await engine.call<{ seconds: number; segments: unknown[] }>(
      'speech',
      'speak',
      {
        model: FAKE,
        voice: { name: 'af_heart' },
        segments: [{ text: 'one two three' }, { text: 'four five', pause: 0.3 }],
        out,
      },
      { onProgress: (p) => progress.push(p.done) },
    );
    expect(progress).toEqual([1, 2]);
    expect(r.segments).toHaveLength(2);
    expect(wavSeconds(readFileSync(out))).toBeCloseTo(r.seconds, 1);
  }, 60_000);

  it('passes on the worker’s error, and keeps going', async () => {
    const e = await engine
      .call('speech', 'speak', {
        model: FAKE,
        voice: {},
        segments: [{ text: 'x [fail:oom]' }],
        out: join(dir, 'b.wav'),
      })
      .catch((x) => x);
    expect(e).toBeInstanceOf(VoiceEngineError);
    expect((e as VoiceEngineError).code).toBe('out_of_memory');
    await engine.call('speech', 'speak', {
      model: FAKE,
      voice: {},
      segments: [{ text: 'fine' }],
      out: join(dir, 'c.wav'),
    });
    expect(existsSync(join(dir, 'c.wav'))).toBe(true);
  }, 60_000);

  it('stops a request by ending its worker; the next call starts a fresh one', async () => {
    const abort = new AbortController();
    const long = engine.call(
      'speech',
      'speak',
      {
        model: FAKE,
        voice: {},
        segments: Array.from({ length: 300 }, () => ({ text: 'many words '.repeat(40) })),
        out: join(dir, 'd.wav'),
      },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 300);
    await expect(long).rejects.toMatchObject({ code: 'canceled' });
    await engine.call('speech', 'speak', {
      model: FAKE,
      voice: {},
      segments: [{ text: 'again' }],
      out: join(dir, 'e.wav'),
    });
    expect(existsSync(join(dir, 'e.wav'))).toBe(true);
  }, 60_000);

  it('says how to install an environment that isn’t set up', async () => {
    await expect(engine.call('chatterbox', 'hello', {})).rejects.toMatchObject({ code: 'not_installed' });
  });
});
