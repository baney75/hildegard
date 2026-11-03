// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChoirState, loadVoiceCatalog } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directorMay } from '../src/access.ts';
import { localCapabilities } from '../src/capabilities.ts';
import { parseArgs } from '../src/config.ts';
import { LlmError, LocalModels, onThisComputer } from '../src/llm.ts';
import { type Running, startServer } from '../src/server.ts';
import {
  FAKE_HEARD,
  localLlm,
  pickTalkModel,
  type TalkDeps,
  TalkError,
  type TalkFiles,
  type TalkTurnResult,
  talkReadiness,
  talkTurn,
} from '../src/talk.ts';
import type { TalkStatus } from '../src/talk-routes.ts';
import { wavBytes } from '../src/voice-engine.ts';
import { memoryStore } from './helpers.ts';

/** A second of tone, as a browser would upload it. */
const recording = () => {
  const s = new Float32Array(24000);
  for (let i = 0; i < s.length; i++) s[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 24000);
  return wavBytes(s, 24000);
};

const files = (): TalkFiles & { saved: Uint8Array[] } => {
  const saved: Uint8Array[] = [];
  return {
    saved,
    save: async (b) => {
      saved.push(b);
      return `/tmp/talk-${saved.length}.wav`;
    },
    find: (id) => `/tmp/${id}`,
    url: (p) => `/media/voice/${p.split('/').pop()}`,
    read: async () => new Uint8Array([1, 2, 3]),
  };
};

describe('one turn, with every step a port', () => {
  it('hears, answers and speaks, in that order, with what each step gave the next', async () => {
    const calls: string[] = [];
    const deps: TalkDeps = {
      stt: {
        transcribe: async (path, language) => {
          calls.push(`stt ${path} ${language}`);
          return { text: '  What time is it?  ' };
        },
      },
      llm: {
        complete: async (messages) => {
          calls.push(`llm ${messages.map((m) => m.role).join(',')} ${messages.at(-1)!.content}`);
          return 'Nearly supper.';
        },
      },
      tts: {
        speak: async (text) => {
          calls.push(`tts ${text}`);
          return { path: '/tmp/reply.wav', contentType: 'audio/wav' };
        },
      },
    };
    const f = files();
    const r = await talkTurn(deps, f, { audio: new Uint8Array([9, 9]), language: 'en' });
    expect(calls).toEqual([
      'stt /tmp/talk-1.wav en',
      'llm system,user What time is it?',
      'tts Nearly supper.',
    ]);
    expect(r).toEqual({
      transcript: 'What time is it?',
      replyText: 'Nearly supper.',
      audio: { contentType: 'audio/wav', url: '/media/voice/reply.wav' },
      route: { stt: 'local', llm: 'local', tts: 'local' },
    } satisfies TalkTurnResult);
    // An earlier upload goes by its id, and audio nobody serves comes back as bytes.
    const r2 = await talkTurn(deps, { ...f, url: () => null }, { audio: { uploadId: 'abc.wav' } });
    expect(calls.at(-3)).toBe('stt /tmp/abc.wav undefined');
    expect(r2.audio).toEqual({ contentType: 'audio/wav', bytes: new Uint8Array([1, 2, 3]) });
  });

  it('stops before answering when nothing was heard', async () => {
    let answered = false;
    const deps: TalkDeps = {
      stt: { transcribe: async () => ({ text: ' ' }) },
      llm: {
        complete: async () => {
          answered = true;
          return 'x';
        },
      },
      tts: { speak: async () => ({ path: '/x', contentType: 'audio/wav' }) },
    };
    await expect(talkTurn(deps, files(), { audio: new Uint8Array([1]) })).rejects.toBeInstanceOf(TalkError);
    expect(answered).toBe(false);
  });

  it('answers with a stand-in, and says so, when no language model runs here', async () => {
    const none = {
      state: async () => ({ endpoints: [], use: null }),
      pick: async () => {
        throw new LlmError(404, 'No local model is running.');
      },
      chat: async () => ({ content: 'unused' }),
    };
    const reply = await localLlm(none).complete([{ role: 'user', content: 'Hello' }]);
    expect(reply).toMatch(/stand-in answer/);
    expect(reply).toMatch(/You said: “Hello”/);
    // The owner's chosen model that is there but fails is an error, not a stand-in.
    const broken = localLlm({
      ...none,
      state: async () => ({
        endpoints: [
          {
            id: 'ollama',
            runtime: 'ollama',
            name: 'Ollama',
            url: 'http://127.0.0.1:11434/v1',
            online: false,
            models: [],
            custom: false,
            keyed: false,
            error: 'nothing there',
          },
        ],
        use: { endpoint: 'ollama', model: 'qwen3:8b' },
      }),
      pick: async () => {
        throw new LlmError(502, 'Ollama isn’t answering.');
      },
    });
    await expect(broken.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(/isn’t answering/);
  });
});

describe('the model Talk answers with', () => {
  const REMOTE = 'http://10.0.0.9:8000/v1';
  const LLAMA = 'http://127.0.0.1:8080/v1';
  /** The owner's endpoint on another computer, and llama.cpp here when `local` is on. */
  const models = (local: boolean) => {
    const chats: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${REMOTE}/models`) return Response.json({ data: [{ id: 'far-70b' }] });
      if (local && url === `${LLAMA}/models`) return Response.json({ data: [{ id: 'llama-4-scout-q4' }] });
      if (local && url === 'http://127.0.0.1:8080/props')
        return Response.json({ default_generation_settings: {} });
      if (url.endsWith('/chat/completions')) {
        chats.push(url);
        return Response.json({ choices: [{ message: { role: 'assistant', content: `From ${url}` } }] });
      }
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const llm = new LocalModels({
      dataDir: mkdtempSync(join(tmpdir(), 'hg-talk-llm-')),
      secrets: () => memoryStore(),
      fetch: fetchFn,
      env: {},
      localAi: { gateways: async () => [], key: () => null },
    });
    return { llm, chats };
  };

  it('knows which endpoints are on this computer', () => {
    const at = (url: string, custom = true, id = 'custom-x') => onThisComputer({ id, url, custom });
    expect(at('http://127.0.0.1:9000/v1')).toBe(true);
    expect(at('http://localhost:9000/v1')).toBe(true);
    expect(at('http://[::1]:9000/v1')).toBe(true);
    expect(at(REMOTE)).toBe(false);
    expect(at('https://api.openai.com/v1')).toBe(false);
    expect(at('http://localhost.example.com/v1')).toBe(false);
    expect(at('http://172.18.0.2:12434/v1', false, 'local-ai-1')).toBe(true);
    // An owner's endpoint doesn't pass as Local AI by its id.
    expect(at('http://172.18.0.2:12434/v1', true, 'local-ai-1')).toBe(false);
  });

  it('never asks the owner’s endpoint on another computer, even when it is their choice', async () => {
    const { llm, chats } = models(false);
    await llm.add('Desk', REMOTE);
    await llm.use('Desk');
    // It would answer: the generic pick would choose it.
    expect((await llm.pick()).endpoint.url).toBe(REMOTE);
    expect(await pickTalkModel(llm)).toBeNull();
    const reply = await localLlm(llm).complete([{ role: 'user', content: 'Hello' }]);
    expect(reply).toMatch(/stand-in answer/);
    expect(chats).toEqual([]);
    // Nor does this computer claim it can run that model.
    const caps = await localCapabilities({ fake: false, gpu: () => null, llm: () => llm.state() });
    expect(caps.llm).toEqual([]);
  });

  it('answers with the model here instead, when there is one', async () => {
    const { llm, chats } = models(true);
    await llm.add('Desk', REMOTE);
    await llm.use('Desk');
    expect(await pickTalkModel(llm)).toMatchObject({ endpoint: { url: LLAMA }, model: 'llama-4-scout-q4' });
    const reply = await localLlm(llm).complete([{ role: 'user', content: 'Hello' }]);
    expect(reply).toBe(`From ${LLAMA}/chat/completions`);
    expect(chats).toEqual([`${LLAMA}/chat/completions`]);
    const caps = await localCapabilities({ fake: false, gpu: () => null, llm: () => llm.state() });
    expect(caps.llm.map((m) => m.model)).toEqual(['llama-4-scout-q4']);
  });
});

describe('when Talk is ready', () => {
  const catalog = loadVoiceCatalog();
  const stt = { stt: ['whisper-small'] };

  it('needs the model Talk’s own voice speaks with, not just any speaking model', () => {
    const chatterbox = catalog.models.find((m) => m.id !== 'kokoro-82m' && m.can.includes('speak'))!;
    const usable = (id: string) => id === 'whisper-small' || id === chatterbox.id;
    const r = talkReadiness({ engine: true, caps: stt, catalog, usable });
    expect(r.ready).toBe(false);
    expect(r.problem).toMatch(/Kokoro/);
    expect(r.problem).not.toMatch(/Whisper/);
    const both = talkReadiness({ engine: true, caps: { stt: [] }, catalog, usable });
    expect(both.problem).toBe('Talk needs Whisper and Kokoro. Install them in Voice › Models.');
  });

  it('is ready with Whisper, Kokoro and the speech engine', () => {
    const usable = (id: string) => id === 'whisper-small' || id === 'kokoro-82m';
    expect(talkReadiness({ engine: true, caps: stt, catalog, usable })).toEqual({
      ready: true,
      problem: null,
    });
    expect(talkReadiness({ engine: false, caps: stt, catalog, usable }).problem).toMatch(/voice engine/);
  });
});

describe('Talk on the stand-in GPU', () => {
  let srv: Running;
  const H = { 'x-hildegard': '1' };
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hg-talk-'));
    srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', dataDir]), port: 0, hfClientId: null },
      {
        fakeTickMs: 25,
        secrets: memoryStore(),
        hubToken: join(dataDir, 'no-hf-token'),
        llm: {
          fetch: (async () => {
            throw new Error('offline');
          }) as typeof fetch,
          env: {},
          localAi: { gateways: async () => [], key: () => null },
        },
      },
    );
  });
  afterAll(() => srv.close());

  it('says it is ready, with this computer’s capabilities', async () => {
    const s = (await (await fetch(`${srv.url}/api/talk`)).json()) as TalkStatus;
    expect(s).toMatchObject({ ready: true, fake: true, problem: null, llm: { runtime: 'stub' } });
    expect(s.capabilities).toMatchObject({
      mic: true,
      speaker: true,
      stt: ['whisper-small'],
      compute: 'interactive',
    });
    expect(s.capabilities.tts).toContain('kokoro-82m');
    // The Studio reads the same claim from choir state, without a second schema.
    const choir = (await (await fetch(`${srv.url}/api/choir`)).json()) as ChoirState;
    expect(choir.capabilities).toEqual(s.capabilities);
  });

  it('runs a whole turn from a recording, with no network and no Python', async () => {
    const form = new FormData();
    form.set('audio', new Blob([recording()], { type: 'audio/wav' }), 'turn.wav');
    const res = await fetch(`${srv.url}/api/talk/turn`, { method: 'POST', headers: H, body: form });
    expect(res.status).toBe(200);
    const r = (await res.json()) as TalkTurnResult;
    expect(r.transcript).toBe(FAKE_HEARD);
    expect(r.replyText).toBe(`You said: “${FAKE_HEARD}”`);
    expect(r.route).toEqual({ stt: 'local', llm: 'local', tts: 'local' });
    expect(r.audio.contentType).toBe('audio/wav');
    expect(r.audio.url).toMatch(/^\/media\/voice\/[a-f0-9]+\.wav$/);
    const audio = await fetch(srv.url + r.audio.url!);
    expect(audio.status).toBe(200);
    const bytes = Buffer.from(await audio.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('is the owner’s: a director reaches none of it', () => {
    expect(directorMay('GET', '/api/talk')).toBe(false);
    expect(directorMay('POST', '/api/talk/turn')).toBe(false);
  });

  it('refuses what isn’t a recording', async () => {
    const form = new FormData();
    form.set('audio', new Blob([new Uint8Array(200)]), 'x.bin');
    const res = await fetch(`${srv.url}/api/talk/turn`, { method: 'POST', headers: H, body: form });
    expect(res.status).toBe(415);
    const none = await fetch(`${srv.url}/api/talk/turn`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(none.status).toBe(400);
    const missing = await fetch(`${srv.url}/api/talk/turn`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: `${'0'.repeat(64)}.wav` }),
    });
    expect(missing.status).toBe(404);
  });
});
