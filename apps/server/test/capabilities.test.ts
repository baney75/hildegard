// SPDX-License-Identifier: AGPL-3.0-only
import { type DeviceCapabilities, type LlmState, loadVoiceCatalog } from '@hildegard/presets';
import { describe, expect, it } from 'vitest';
import { Capabilities, localCapabilities, readCapabilities, STUB_LLM } from '../src/capabilities.ts';
import { type NodeInfo, RemoteEngine } from '../src/remote-engine.ts';
import { fakeFetch } from './helpers.ts';

const catalog = loadVoiceCatalog();
const good: DeviceCapabilities = {
  mic: true,
  speaker: true,
  stt: ['whisper-small'],
  tts: ['kokoro-82m'],
  llm: [{ runtime: 'ollama', model: 'qwen3:8b', vramGb: null }],
  gpu: { name: 'NVIDIA GeForce RTX 4080', vramGb: 16 },
  compute: 'interactive',
};

describe('the capability schema', () => {
  it('takes a well-formed claim', () => {
    expect(Capabilities.parse(good)).toEqual(good);
    expect(readCapabilities({ ...good, gpu: null, compute: 'batch' })).toMatchObject({
      gpu: null,
      compute: 'batch',
    });
  });

  it('refuses a bad compute, a non-array stt, and other wrong shapes', () => {
    expect(Capabilities.safeParse({ ...good, compute: 'turbo' }).success).toBe(false);
    expect(Capabilities.safeParse({ ...good, stt: 'whisper-small' }).success).toBe(false);
    expect(Capabilities.safeParse({ ...good, tts: [1] }).success).toBe(false);
    expect(Capabilities.safeParse({ ...good, mic: 'yes' }).success).toBe(false);
    expect(Capabilities.safeParse({ ...good, llm: [{ runtime: 'ollama', model: 'x' }] }).success).toBe(false);
    expect(Capabilities.safeParse({ ...good, gpu: { name: 'x', vramGb: -1 } }).success).toBe(false);
    const { compute: _c, ...noCompute } = good;
    expect(Capabilities.safeParse(noCompute).success).toBe(false);
    expect(readCapabilities(undefined)).toBeNull();
    expect(readCapabilities({ ...good, stt: 'whisper-small' })).toBeNull();
  });
});

describe('this computer’s capabilities', () => {
  it('advertises the stand-in models with the fake GPU', async () => {
    const caps = await localCapabilities({
      fake: true,
      gpu: () => ({ name: 'Stand-in GPU', vramGb: null }),
      voice: { catalog, usable: () => true },
    });
    expect(Capabilities.parse(caps)).toEqual(caps);
    expect(caps).toMatchObject({ mic: true, speaker: true, compute: 'interactive', llm: [STUB_LLM] });
    expect(caps.stt).toEqual(['whisper-small']);
    expect(caps.tts).toContain('kokoro-82m');
    expect(caps.tts).not.toContain('whisper-small');
  });

  it('lists only usable voice models, and the language models running here', async () => {
    const llm: LlmState = {
      use: null,
      endpoints: [
        {
          id: 'ollama',
          runtime: 'ollama',
          name: 'Ollama',
          url: 'http://127.0.0.1:11434/v1',
          online: true,
          custom: false,
          keyed: false,
          error: null,
          models: [{ id: 'qwen3:8b', size: null, context: null, loaded: true }],
        },
        {
          id: 'lm-studio',
          runtime: 'lm-studio',
          name: 'LM Studio',
          url: 'http://127.0.0.1:1234/v1',
          online: false,
          custom: false,
          keyed: false,
          error: 'nothing there',
          models: [{ id: 'gone', size: null, context: null, loaded: null }],
        },
      ],
    };
    const caps = await localCapabilities({
      fake: false,
      gpu: () => null,
      voice: { catalog, usable: (id) => id === 'kokoro-82m' },
      llm: async () => llm,
    });
    expect(caps).toEqual({
      mic: true,
      speaker: true,
      stt: [],
      tts: ['kokoro-82m'],
      llm: [{ runtime: 'ollama', model: 'qwen3:8b', vramGb: null }],
      gpu: null,
      compute: 'interactive',
    });
    // Nobody answering is no models, not an error.
    const none = await localCapabilities({
      fake: false,
      gpu: () => null,
      llm: async () => {
        throw new Error('offline');
      },
    });
    expect(none.llm).toEqual([]);
    expect(none.stt).toEqual([]);
  });
});

describe('a paired device’s claim', () => {
  const base: NodeInfo = {
    id: 'a'.repeat(32),
    name: 'spark',
    version: '0.1.13',
    gpu: null,
    online: true,
    fake: true,
    models: [],
    queue: 0,
    accepting: true,
  };
  const engineSaying = (info: unknown) =>
    new RemoteEngine({
      name: 'spark',
      url: 'http://100.64.0.2:7341',
      token: () => 'k'.repeat(43),
      fetch: fakeFetch([['GET /api/node/info', () => Response.json(info)]]),
    });

  it('is optional: an older device without one still reads', async () => {
    const info = await engineSaying(base).info();
    expect(info.capabilities).toBeUndefined();
    expect(info.name).toBe('spark');
  });

  it('is kept when well formed, and dropped when not', async () => {
    expect((await engineSaying({ ...base, capabilities: good }).info()).capabilities).toEqual(good);
    const bad = await engineSaying({ ...base, capabilities: { ...good, compute: 'turbo' } }).info();
    expect(bad.capabilities).toBeUndefined();
    expect(bad.online).toBe(true);
  });
});
