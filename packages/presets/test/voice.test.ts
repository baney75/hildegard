// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileParagraph,
  controlState,
  defaultPresetsDir,
  engineSettings,
  loadCatalog,
  loadSafety,
  loadVoiceCatalog,
  parseScript,
  parseVoiceCatalog,
  SpeakRequest,
  sampleQuality,
  spokenText,
  VoiceSettings,
  voiceHue,
} from '../src/index.ts';

const { lock } = loadCatalog();
const vc = loadVoiceCatalog(undefined, lock);
const toml = readFileSync(join(defaultPresetsDir(), 'voices.toml'), 'utf8');
const model = (id: string) => vc.models.find((m) => m.id === id)!;

describe('voice catalog', () => {
  it('loads the shipped models, voices and tags', () => {
    expect(vc.models.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        'kokoro-82m',
        'chatterbox-multilingual',
        'qwen3-tts-design',
        'qwen3-tts-clone',
        'whisper-small',
      ]),
    );
    expect(vc.voices.length).toBeGreaterThanOrEqual(20);
    expect(vc.tags.find((t) => t.id === 'whispers')?.group).toBe('delivery');
  });

  it('only ships licenses that allow commercial use', () => {
    for (const m of vc.models) expect(['Apache-2.0', 'MIT']).toContain(m.license);
  });

  it('every clone-capable model downloads the speaker check with it', () => {
    expect(vc.consent.encoder.repo).toBe('ResembleAI/chatterbox');
    expect(vc.consent.sameSpeaker).toBeGreaterThanOrEqual(0.7);
  });

  it('refuses a voice whose Kokoro file is not in the model', () => {
    const bad = toml.replace('preset = "af_bella"', 'preset = "af_nobody"');
    expect(() => parseVoiceCatalog(bad)).toThrow(/voices\/af_nobody\.pt/);
  });

  it('refuses a file path that climbs out of the repo', () => {
    const bad = toml.replace('path = "config.json", size = 2351', 'path = "voices/../../x", size = 2351');
    expect(() => parseVoiceCatalog(bad)).toThrow();
  });

  it('refuses a sexual model, as the video catalog does', () => {
    const bad = toml.replace(
      'blurb = "Small, quick and clear.',
      'blurb = "Erotic ASMR. Small, quick and clear.',
    );
    expect(() => parseVoiceCatalog(bad, undefined, loadSafety())).toThrow(/refused/);
  });
});

describe('scripts', () => {
  it('splits words, tags and pauses, and never speaks a tag', () => {
    const parts = parseScript('Hello [whispers] there [pause 0.5s] friend [nonsense] [PAUSE 200ms]', vc.tags);
    expect(parts).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'tag', id: 'whispers', known: true },
      { kind: 'text', text: ' there ' },
      { kind: 'pause', seconds: 0.5 },
      { kind: 'text', text: ' friend ' },
      { kind: 'tag', id: 'nonsense', known: false },
      { kind: 'text', text: ' ' },
      { kind: 'pause', seconds: 0.2 },
    ]);
    expect(spokenText('Hello [whispers] there [pause] friend', vc.tags)).toBe('Hello there friend');
  });

  it('keeps unclosed and doubled brackets as words', () => {
    expect(spokenText('a [ex', vc.tags)).toBe('a [ex');
    expect(spokenText('[[1] is a footnote', vc.tags)).toBe('[1] is a footnote');
    expect(parseScript('[pause 999s]', vc.tags)).toEqual([{ kind: 'pause', seconds: 10 }]);
  });

  it('compiles a paragraph into segments with direction, lift and pauses', () => {
    const segs = compileParagraph(
      {
        text: '[whispers] They said no. [pause 0.5s] [laughs softly] She built one anyway.',
        direction: 'warm',
        language: 'en',
      },
      vc.tags,
    );
    expect(segs).toEqual([
      { text: 'They said no.', language: 'en', instruct: 'warm; whispering, hushed', lift: -0.2, pause: 0.5 },
      { text: 'She built one anyway.', language: 'en', instruct: 'warm; with a soft laugh', lift: 0.2 },
    ]);
  });

  it('a pause with no words before it lengthens the last one', () => {
    const segs = compileParagraph({ text: 'One. [pause 1s] [pause 1s] Two.', language: 'en' }, vc.tags);
    expect(segs.map((s) => s.pause)).toEqual([2, undefined]);
  });
});

describe('requests and controls', () => {
  it('fills settings and refuses an empty script', () => {
    const r = SpeakRequest.parse({ paragraphs: [{ text: 'Hi' }], voice: 'kokoro-heart' });
    expect(r.settings).toEqual(VoiceSettings.parse({}));
    expect(() => SpeakRequest.parse({ paragraphs: [{ text: '  ' }], voice: 'kokoro-heart' })).toThrow();
    expect(() => SpeakRequest.parse({ paragraphs: [], voice: 'kokoro-heart' })).toThrow();
  });

  it('greys out what a model cannot do, and names one that can', () => {
    const k = controlState(model('kokoro-82m'), 'expressiveness', vc.models);
    expect(k).toEqual({ enabled: false, why: 'Kokoro doesn’t support this. Chatterbox does.' });
    expect(controlState(model('chatterbox-multilingual'), 'expressiveness', vc.models).enabled).toBe(true);
  });

  it('maps sliders into Chatterbox’s own settings, within its ranges', () => {
    const cb = model('chatterbox-multilingual');
    const calm = engineSettings(cb, VoiceSettings.parse({ expressiveness: 0 }));
    const wild = engineSettings(cb, VoiceSettings.parse({ expressiveness: 1 }), 1);
    expect(calm.exaggeration).toBe(0.25);
    expect(wild.exaggeration).toBe(1.5);
    expect(wild.cfg).toBeLessThan(calm.cfg!);
    expect(engineSettings(model('kokoro-82m'), VoiceSettings.parse({ speed: 1.2 }))).toEqual({ speed: 1.2 });
  });

  it('gives each voice a stable hue', () => {
    expect(voiceHue('kokoro-heart')).toBe(voiceHue('kokoro-heart'));
    expect(voiceHue('a')).not.toBe(voiceHue('b'));
  });
});

describe('sample quality', () => {
  it('says what to change, one thing at a time', () => {
    expect(sampleQuality({ peakDb: -3, snrDb: 40, clipping: 0 })).toEqual({
      level: 'ok',
      noise: 'ok',
      tip: null,
    });
    expect(sampleQuality({ peakDb: 0, snrDb: 40, clipping: 0.01 })).toMatchObject({
      level: 'clipped',
      tip: /back from the mic/,
    });
    expect(sampleQuality({ peakDb: -30, snrDb: 40, clipping: 0 })).toMatchObject({
      level: 'quiet',
      tip: /closer/,
    });
    expect(sampleQuality({ peakDb: -6, snrDb: 12, clipping: 0 })).toMatchObject({
      level: 'ok',
      noise: 'noisy',
      tip: /quieter room/,
    });
  });
});
