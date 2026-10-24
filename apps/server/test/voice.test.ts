// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import {
  type ConsentSessionView,
  loadVoiceCatalog,
  type MarkCheck,
  type ServerEvent,
  type Voice,
  type VoiceCatalog,
  type VoiceJob,
  type VoiceModelState,
  type VoiceState,
  type VoiceUse,
} from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directorMay, eventFilter, open } from '../src/access.ts';
import { parseArgs } from '../src/config.ts';
import { type Certificate, checkCertificate } from '../src/consent.ts';
import { type Running, startServer } from '../src/server.ts';
import { FakeVoiceEngine, wavBytes, wavSeconds } from '../src/voice-engine.ts';
import { fakeFetch, memoryStore } from './helpers.ts';

const BYTES = Buffer.from('voice weights '.repeat(512));
const SHA = createHash('sha256').update(BYTES).digest('hex');
const H = { 'x-hildegard': '1', 'content-type': 'application/json' };

/** The real catalog, with every file a small one the stand-in Hugging Face serves. */
function tinyCatalog(): VoiceCatalog {
  const real = loadVoiceCatalog();
  const tiny = (path: string) => ({ repo: 'org/tiny-voice', path, size: BYTES.length, gated: false });
  return {
    ...real,
    consent: { ...real.consent, encoder: tiny('ve.safetensors') },
    models: real.models.map((m) => ({ ...m, files: m.files.map((f) => tiny(`${m.id}/${f.path}`)) })),
  };
}

const hub = fakeFetch([
  [
    'HEAD /org/tiny-voice/resolve/',
    () =>
      new Response(null, {
        status: 302,
        headers: {
          'x-repo-commit': 'b'.repeat(40),
          'x-linked-etag': `"${SHA}"`,
          'x-linked-size': String(BYTES.length),
        },
      }),
  ],
  ['GET /org/tiny-voice/resolve/', () => new Response(BYTES, { status: 200 })],
]);

let srv: Running;
let dataDir: string;
let engine: FakeVoiceEngine;
const api = (path: string, init: RequestInit = {}) => fetch(srv.url + path, init);
const post = (path: string, body?: unknown) =>
  api(path, { method: 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const raw = (path: string, bytes: Uint8Array) =>
  api(path, {
    method: 'POST',
    headers: { 'x-hildegard': '1', 'content-type': 'audio/wav' },
    body: Buffer.from(bytes),
  });

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out');
}
const state = async () => (await (await api('/api/voice')).json()) as VoiceState;
const job = async (id: string) => (await (await api(`/api/voice/jobs/${id}`)).json()) as VoiceJob;
async function finished(id: string): Promise<VoiceJob> {
  let j = await job(id);
  await until(async () => {
    j = await job(id);
    return j.status !== 'queued' && j.status !== 'running';
  });
  return j;
}
/** A recording of `seconds` of sound, as a browser would upload it. */
const recording = (seconds: number, f = 180) => {
  const s = new Float32Array(Math.round(seconds * 24000));
  for (let i = 0; i < s.length; i++) s[i] = 0.2 * Math.sin((2 * Math.PI * f * i) / 24000);
  return wavBytes(s, 24000);
};
const install = async (id: string) => {
  const r = await post(`/api/voice/models/${id}/install`, { acceptLicense: true });
  expect(r.status).toBe(202);
  await until(async () => (await state()).models.find((m) => m.id === id)!.installed);
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hg-voice-'));
  engine = new FakeVoiceEngine();
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dataDir]), port: 0, hfClientId: null },
    {
      fakeTickMs: 25,
      secrets: memoryStore(),
      hubToken: join(dataDir, 'no-hf-token'),
      voiceCatalog: tinyCatalog(),
      voiceEngine: engine,
      modelFetch: hub,
      // No language model runs here, whatever the computer running the tests has.
      llm: {
        fetch: (async () => {
          throw new Error('offline');
        }) as typeof fetch,
        env: {},
        localAi: { gateways: async () => [], key: () => null },
      },
    },
  );
  await until(() => srv.scheduler.engineState().online);
});
afterAll(() => srv.close());

describe('voice models', () => {
  it('lists the built-in voices, and asks for each license before anything downloads', async () => {
    const s = await state();
    expect(s.voices.find((v) => v.id === 'kokoro-heart')).toMatchObject({
      kind: 'builtin',
      model: 'kokoro-82m',
    });
    expect(s.models.every((m) => !m.installed && !m.licenseAccepted)).toBe(true);
    const r = await post('/api/voice/speak', { paragraphs: [{ text: 'Hello.' }], voice: 'kokoro-heart' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('model_missing');
    const lic = await post('/api/voice/models/chatterbox-multilingual/install');
    expect(lic.status).toBe(409);
    // Cloning brings Whisper, for the consent check: its license is shown with the model's.
    expect(await lic.json()).toMatchObject({
      code: 'license',
      license: 'MIT',
      also: [{ id: 'whisper-small' }],
    });
    expect(hub.calls).toHaveLength(0);
  });

  it('installs a model that clones with the transcriber and the speaker check', async () => {
    await install('kokoro-82m');
    await install('chatterbox-multilingual');
    const s = await state();
    const by = (id: string) => s.models.find((m) => m.id === id) as VoiceModelState;
    expect(by('whisper-small')).toMatchObject({ installed: true, licenseAccepted: true, ready: true });
    expect(readFileSync(join(dataDir, 'voice', 'models', 'consent', 've.safetensors'))).toEqual(BYTES);
    expect(by('qwen3-tts-design').installed).toBe(false);
  });
});

describe('speaking', () => {
  it('speaks a script with tags and pauses as one watermarked clip, and never says a tag', async () => {
    const r = await post('/api/voice/speak', {
      paragraphs: [{ text: 'Hello [whispers] there [pause 0.5s] friend.' }, { text: 'A second paragraph.' }],
      voice: 'kokoro-heart',
      seed: 3,
    });
    expect(r.status).toBe(202);
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j).toMatchObject({
      status: 'done',
      voice: 'kokoro-heart',
      model: 'kokoro-82m',
      seed: 3,
      error: null,
    });
    expect(j.segments).toHaveLength(2);
    const said = engine.calls.filter((c) => c.op === 'speak').at(-1)!;
    expect((said.args.segments as Array<{ text: string }>).map((s) => s.text)).toEqual([
      'Hello there',
      'friend.',
      'A second paragraph.',
    ]);
    expect(said.args.voice).toEqual({ kind: 'preset', name: 'af_heart' });
    const clip = await api(j.audio[0]!);
    expect(clip.headers.get('content-type')).toBe('audio/wav');
    expect(wavSeconds(new Uint8Array(await clip.arrayBuffer()))).toBeCloseTo(j.seconds!, 2);
  });

  it('gives each paragraph its own voice, in one file', async () => {
    const before = engine.calls.length;
    const r = await post('/api/voice/speak', {
      paragraphs: [{ text: 'One voice.' }, { text: 'Another voice.', voice: 'kokoro-michael' }],
      voice: 'kokoro-heart',
    });
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j.status).toBe('done');
    expect(j.segments![1]!.start).toBeGreaterThanOrEqual(j.segments![0]!.end);
    expect(engine.calls.slice(before).map((c) => c.op)).toEqual(['speak', 'speak', 'dub']);
  });

  it('refuses sexual scripts, a voice that doesn’t exist, and a language the model doesn’t speak', async () => {
    const sexual = await post('/api/voice/speak', {
      paragraphs: [{ text: 'explicit porn scene' }],
      voice: 'kokoro-heart',
    });
    expect(sexual.status).toBe(400);
    expect(((await sexual.json()) as { code: string }).code).toBe('content_blocked');
    expect((await post('/api/voice/speak', { paragraphs: [{ text: 'Hi' }], voice: 'nobody' })).status).toBe(
      404,
    );
    const lang = await post('/api/voice/speak', {
      paragraphs: [{ text: 'Hallo' }],
      voice: 'kokoro-heart',
      language: 'de',
    });
    expect(lang.status).toBe(400);
    expect(((await lang.json()) as { error: string }).error).toMatch(/Chatterbox does/);
  });

  it('a failure says what happened and what to do, and the next job runs', async () => {
    const r = await post('/api/voice/speak', {
      paragraphs: [{ text: 'Too big [[fail:oom]' }],
      voice: 'kokoro-heart',
    });
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j.status).toBe('failed');
    expect(j.error).toMatchObject({ code: 'out_of_memory', hint: expect.stringMatching(/GPU/) });
    const next = await post('/api/voice/speak', { paragraphs: [{ text: 'Fine.' }], voice: 'kokoro-heart' });
    expect((await finished(((await next.json()) as VoiceJob).id)).status).toBe('done');
  });

  it('waits for a video render to finish rather than share the GPU, and lets go of it before the next', async () => {
    engine.delayMs = 0;
    const released = engine.released;
    const shot = (await (
      await post('/api/shots', {
        request: {
          prompt: 'A lighthouse keeper climbs the stairs',
          rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
          format: { quality: 'draft', seconds: 3 },
        },
      })
    ).json()) as { takes: Array<{ id: string }> };
    const takeId = shot.takes[0]!.id;
    await until(() => srv.store.takes.get(takeId)!.status === 'running');
    expect(engine.released).toBeGreaterThan(released);
    const r = await post('/api/voice/speak', {
      paragraphs: [{ text: 'After the take.' }],
      voice: 'kokoro-heart',
    });
    const id = ((await r.json()) as VoiceJob).id;
    await new Promise((res) => setTimeout(res, 100));
    if (srv.store.takes.get(takeId)!.status === 'running') expect((await job(id)).status).toBe('queued');
    const j = await finished(id);
    const take = srv.store.takes.get(takeId)!;
    expect(take.status).toBe('done');
    expect(Date.parse(j.startedAt!)).toBeGreaterThanOrEqual(Date.parse(take.finishedAt!));
  });

  it('keeps the queue in order and cancels a waiting job', async () => {
    engine.delayMs = 80;
    const a = (await (
      await post('/api/voice/speak', { paragraphs: [{ text: 'one two three' }], voice: 'kokoro-heart' })
    ).json()) as VoiceJob;
    const b = (await (
      await post('/api/voice/speak', {
        paragraphs: [{ text: 'four' }],
        voice: 'kokoro-heart',
        agent: 'Claude',
      })
    ).json()) as VoiceJob;
    expect(b.source).toEqual({ kind: 'agent', name: 'Claude' });
    expect(b.priority).toBe('agent');
    expect((await post(`/api/voice/jobs/${b.id}/cancel`)).status).toBe(200);
    expect((await finished(b.id)).status).toBe('canceled');
    expect((await finished(a.id)).status).toBe('done');
    engine.delayMs = 0;
  });

  it('deleting a job removes it and its clip, and tells the Studio it’s gone', async () => {
    const seen: ServerEvent[] = [];
    const off = srv.store.on((e) => seen.push(e));
    const j = (await (
      await post('/api/voice/speak', { paragraphs: [{ text: 'gone soon' }], voice: 'kokoro-heart' })
    ).json()) as VoiceJob;
    const done = await finished(j.id);
    expect((await api(`/api/voice/jobs/${j.id}`, { method: 'DELETE', headers: H })).status).toBe(200);
    off();
    expect((await api(done.audio[0]!)).status).toBe(404);
    expect((await api(`/api/voice/jobs/${j.id}`)).status).toBe(404);
    expect(seen.at(-1)).toEqual({ type: 'removed', kind: 'voice-job', id: j.id });
  });
});

describe('voice over MCP', () => {
  let mcp: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await mcp.callTool({ name, arguments: args })) as CallToolResult;
  const textOf = (r: CallToolResult) =>
    r.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');

  beforeAll(async () => {
    const server = createMcpServer(new HildegardClient(srv.url));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    mcp = new Client({ name: 'test-agent', version: '1.0.0' });
    await mcp.connect(b);
  });
  afterAll(() => mcp.close());

  it('lists voices, models and script tags in words a small model can act on', async () => {
    const t = textOf(await call('list_voices'));
    expect(t).toMatch(/- kokoro-heart: Heart \(builtin\), en/);
    expect(t).toMatch(/- kokoro-82m: Kokoro, Apache-2\.0\. Can speak; \d+ languages\. installed\./);
    expect(t).toMatch(/Tags for scripts.*whispers/);
  });

  it('speaks a script and says where the clip is, labelled with the agent', async () => {
    const r = await call('speak', {
      script: 'First paragraph.\n\n[whispers] Second one.',
      voice: 'kokoro-heart',
      include_audio: true,
    });
    expect(r.isError).toBeFalsy();
    const path = /Audio: (\S+\.wav)/.exec(textOf(r))![1]!;
    expect(readFileSync(path).subarray(0, 4).toString()).toBe('RIFF');
    expect(r.content.some((c) => c.type === 'audio')).toBe(true);
    const j = (await state()).jobs.find((x) => path.includes(x.id))!;
    expect(j.source).toEqual({ kind: 'agent', name: 'test-agent' });
    expect(j.segments).toHaveLength(2);
  });

  it('shows the license terms first, and of the models a model brings', async () => {
    const t = textOf(await call('install_voice_model', { model: 'qwen3-tts-clone' }));
    expect(t).toMatch(/comes under the Apache-2\.0/);
    expect(t).toMatch(/accept_license: true/);
    expect((await state()).models.find((m) => m.id === 'qwen3-tts-clone')!.licenseAccepted).toBe(false);
  });

  it('can’t clone a voice, and says how the person does it', async () => {
    const t = textOf(await call('clone_voice'));
    expect(t).toMatch(/can’t be done from here/);
    expect(t).toMatch(/#\/voice\/clone/);
  });

  it('says what went wrong in words', async () => {
    const r = await call('speak', { script: 'Hello', voice: 'nobody' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no voice nobody/);
  });
});

describe('living consent', () => {
  let voiceId = '';

  async function session(speaker = 'Ada'): Promise<ConsentSessionView> {
    const r = await post('/api/voice/consent', { speaker, relation: 'self' });
    expect(r.status).toBe(201);
    return (await r.json()) as ConsentSessionView;
  }
  async function upload(bytes: Uint8Array) {
    const r = await raw('/api/voice/uploads', bytes);
    expect(r.status).toBe(201);
    return (await r.json()) as { name: string; seconds: number };
  }
  async function check(id: string): Promise<ConsentSessionView> {
    const r = await post(`/api/voice/consent/${id}/check`);
    expect(r.status).toBe(202);
    expect((await finished(((await r.json()) as VoiceJob).id)).status).toBe('done');
    return (await (await api(`/api/voice/consent/${id}`)).json()) as ConsentSessionView;
  }

  it('writes a fresh line with the speaker’s name and four random words', async () => {
    const a = await session();
    const b = await session();
    expect(a.line).toMatch(
      /^My name is Ada\. I agree that Hildegard may make a copy of my voice\. \w+ \w+ \w+ \w+\.$/,
    );
    expect(a.line).not.toBe(b.line);
    expect(Date.parse(a.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('clones only after the line is heard, live, from the same person as every sample', async () => {
    const s = await session();
    expect((await post(`/api/voice/consent/${s.id}/check`)).status).toBe(409);
    expect((await raw(`/api/voice/consent/${s.id}/recording`, recording(5))).status).toBe(200);
    const sample = await upload(recording(8, 220));
    const added = (await (
      await post(`/api/voice/consent/${s.id}/samples`, { names: [sample.name] })
    ).json()) as ConsentSessionView;
    expect(added.samples).toHaveLength(1);
    expect(added.samples[0]!.quality).toEqual({ level: 'ok', noise: 'ok', tip: null });
    const v = await check(s.id);
    expect(v.check).toMatchObject({
      ok: true,
      heard: { ok: true, missing: [] },
      live: { ok: true },
      speaker: { ok: true, lowest: 1 },
      length: { ok: true },
      why: [],
    });
    const made = await post(`/api/voice/consent/${s.id}/finish`, { name: 'Ada' });
    expect(made.status).toBe(201);
    const voice = (await made.json()) as Voice;
    voiceId = voice.id;
    expect(voice).toMatchObject({
      kind: 'clone',
      model: 'chatterbox-multilingual',
      consent: { speaker: 'Ada', status: 'active' },
    });
    const cert = JSON.parse(voice.consent!.certificate) as Certificate;
    expect(checkCertificate(cert, cert.body.install)).toEqual({ valid: true, ours: true });
    expect(cert.body.samplesSha256).toHaveLength(1);
    // Changing a word breaks it.
    expect(checkCertificate({ ...cert, body: { ...cert.body, speaker: 'Bob' } }).valid).toBe(false);
    expect(readFileSync(join(dataDir, 'voice', 'consent-key.pem'), 'utf8')).toMatch(/PRIVATE KEY/);
    expect(await (await api('/api/voice/consent-key')).text()).toBe(cert.publicKey);
  });

  it('speaks in a consented voice, and writes down every use', async () => {
    const r = await post('/api/voice/speak', {
      paragraphs: [{ text: 'Hello from Ada.' }],
      voice: voiceId,
      agent: 'Claude',
    });
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j.status).toBe('done');
    expect(engine.calls.filter((c) => c.op === 'speak').at(-1)!.args.voice).toMatchObject({ kind: 'clone' });
    const uses = (await (await api(`/api/voice/voices/${voiceId}/uses`)).json()) as VoiceUse[];
    expect(uses[0]).toMatchObject({ job: j.id, by: 'Claude', kind: 'speak' });
    expect(uses[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recognises its own clips, byte for byte and by watermark', async () => {
    const r = await post('/api/voice/speak', { paragraphs: [{ text: 'Is this ours?' }], voice: voiceId });
    const j = await finished(((await r.json()) as VoiceJob).id);
    const ours = await upload(new Uint8Array(await (await api(j.audio[0]!)).arrayBuffer()));
    const found = (await (await post('/api/voice/check', { source: ours.name })).json()) as MarkCheck;
    expect(found).toMatchObject({ verdict: 'ours', job: { id: j.id, voice: voiceId } });
    const theirs = await upload(recording(2, 300));
    expect(
      ((await (await post('/api/voice/check', { source: theirs.name })).json()) as MarkCheck).verdict,
    ).toBe('no');
  });

  it('refuses samples from someone else', async () => {
    const s = await session();
    await raw(`/api/voice/consent/${s.id}/recording`, recording(5));
    const other = await upload(recording(9, 260));
    writeFileSync(
      join(dataDir, 'media', 'voice', `d-${other.name.replace(/\.wav$/, '')}.wav.speaker`),
      'someone else',
    );
    await post(`/api/voice/consent/${s.id}/samples`, { names: [other.name] });
    const v = await check(s.id);
    expect(v.check!.ok).toBe(false);
    expect(v.check!.speaker.ok).toBe(false);
    expect(v.check!.why).toContain(
      'These clips aren’t from the person who gave consent. Use recordings of Ada only.',
    );
    expect((await post(`/api/voice/consent/${s.id}/finish`, { name: 'Not Ada' })).status).toBe(409);
  });

  it('refuses a consent recording made by AI, and one that doesn’t say the line', async () => {
    const s = await session();
    await raw(`/api/voice/consent/${s.id}/recording`, recording(12));
    writeFileSync(join(dataDir, 'media', 'voice', `c-${s.id}.wav.marked`), '');
    writeFileSync(join(dataDir, 'media', 'voice', `c-${s.id}.wav.txt`), 'My name is Ada. I agree.');
    const v = await check(s.id);
    expect(v.check).toMatchObject({ ok: false, live: { ok: false }, heard: { ok: false } });
    expect(v.check!.heard.missing).toHaveLength(4);
    expect(v.check!.why[0]).toMatch(/made by AI/);
  });

  it('asks for enough speech', async () => {
    const s = await session();
    await raw(`/api/voice/consent/${s.id}/recording`, recording(4));
    const v = await check(s.id);
    expect(v.check).toMatchObject({ ok: false, length: { ok: false, need: 10 } });
  });

  it('lets the speaker record on their own phone through a link that only takes the recording', async () => {
    const s = srv.voice.startConsent(
      { speaker: 'Grace', relation: 'agreed' },
      'https://hildegard.example.ts.net',
    );
    expect(s.link).toBe(`https://hildegard.example.ts.net/#/consent/${s.token}`);
    const seen = (await (await api(`/api/consent/${s.token}`)).json()) as Record<string, unknown>;
    expect(seen).toEqual({ speaker: 'Grace', line: s.line, expiresAt: s.expiresAt, recorded: false });
    const r = await raw(`/api/consent/${s.token}/recording`, recording(5));
    expect(await r.json()).toEqual({ recorded: true });
    expect(srv.voice.session(s.id).recording?.via).toBe('link');
    expect((await api('/api/consent/not-a-token')).status).toBe(410);
    // Directors and people who aren't signed in reach the link and nothing else of voice.
    expect(open('GET', `/api/consent/${s.token}`)).toBe(true);
    expect(open('POST', `/api/consent/${s.token}/recording`)).toBe(true);
    expect(open('GET', '/api/voice')).toBe(false);
    expect(directorMay('POST', `/api/consent/${s.token}/recording`)).toBe(true);
    expect(directorMay('GET', '/api/voice')).toBe(false);
    expect(directorMay('POST', '/api/voice/speak')).toBe(false);
  });

  it('revoking deletes the reference audio, so the voice can’t speak again; the record stays', async () => {
    const r = await post(`/api/voice/voices/${voiceId}/revoke`);
    expect(((await r.json()) as Voice).consent!.status).toBe('revoked');
    const again = await post('/api/voice/speak', { paragraphs: [{ text: 'Once more.' }], voice: voiceId });
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: string }).error).toMatch(/revoked/);
    expect(
      ((await (await api(`/api/voice/voices/${voiceId}/uses`)).json()) as VoiceUse[]).length,
    ).toBeGreaterThan(0);
    expect((await api(`/api/voice/voices/${voiceId}`, { method: 'DELETE', headers: H })).status).toBe(200);
    expect(readFileSync(join(dataDir, 'voice', 'revoked', `${voiceId}.json`), 'utf8')).toMatch(
      /hildegard-voice-consent/,
    );
  });
});

describe('who sees voice', () => {
  it('sends voice events to the owner only', () => {
    const f = eventFilter(() => undefined, new Set());
    const e = { type: 'voices' as const, voices: [] };
    expect(f({ kind: 'local' }, e)).toEqual(e);
    expect(f({ kind: 'person', person: { id: 'o', name: 'O', role: 'owner' }, session: 's' }, e)).toEqual(e);
    expect(
      f({ kind: 'person', person: { id: 'd', name: 'D', role: 'director' }, session: 's' }, e),
    ).toBeNull();
  });
});

describe('design, speech to speech, transcripts and dubbing', () => {
  it('designs three candidates from words and keeps one as a voice', async () => {
    const no = await post('/api/voice/design', {
      description: 'a weathered baritone, slow and kind',
      text: 'Welcome home.',
    });
    expect(no.status).toBe(409);
    await install('qwen3-tts-design');
    await install('qwen3-tts-clone');
    const r = await post('/api/voice/design', {
      description: 'a weathered baritone, slow and kind',
      text: 'Welcome home.',
      seed: 9,
    });
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j).toMatchObject({ status: 'done', model: 'qwen3-tts-design' });
    expect(j.audio).toHaveLength(3);
    const kept = await post(`/api/voice/design/${j.id}/keep`, { candidate: 2, name: 'Keeper' });
    expect(kept.status).toBe(201);
    const v = (await kept.json()) as Voice;
    // Later speech clones from the chosen candidate, so the voice stays the same from line to line.
    expect(v).toMatchObject({
      kind: 'designed',
      name: 'Keeper',
      model: 'qwen3-tts-clone',
      description: 'a weathered baritone, slow and kind',
    });
    const s = await post('/api/voice/speak', { paragraphs: [{ text: 'Same voice again.' }], voice: v.id });
    expect((await finished(((await s.json()) as VoiceJob).id)).status).toBe('done');
    expect(engine.calls.filter((c) => c.op === 'speak').at(-1)!.args.voice).toMatchObject({
      kind: 'clone',
      refText: 'Welcome home.',
    });
  });

  it('says a recording again in another voice', async () => {
    const up = (await (await raw('/api/voice/uploads', recording(3))).json()) as { name: string };
    const r = await post('/api/voice/convert', { source: up.name, voice: 'kokoro-heart' });
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j).toMatchObject({ status: 'done', model: 'chatterbox-multilingual', voice: 'kokoro-heart' });
    // A built-in voice reads a line once, to be the reference.
    expect(
      readFileSync(join(dataDir, 'voice', 'refs', 'builtin-kokoro-heart.wav'))
        .subarray(0, 4)
        .toString(),
    ).toBe('RIFF');
  });

  it('transcribes with word timings', async () => {
    const bytes = recording(3);
    const up = (await (await raw('/api/voice/uploads', bytes)).json()) as { name: string };
    writeFileSync(
      join(dataDir, 'media', 'voice', `d-${up.name.replace(/\.wav$/, '')}.wav.txt`),
      'the quick brown fox',
    );
    const r = await post('/api/voice/transcribe', { source: up.name });
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j.transcript!.segments[0]!.words.map((w) => w.word)).toEqual(['the', 'quick', 'brown', 'fox']);
  });

  it('dubs given lines into their slots over the original', async () => {
    const up = (await (await raw('/api/voice/uploads', recording(6, 140))).json()) as { name: string };
    const r = await post('/api/voice/dub', {
      source: up.name,
      language: 'es',
      voice: 'chatterbox-default',
      lines: [
        { start: 0.5, end: 2, text: 'Hola.' },
        { start: 3, end: 5, text: 'Hasta luego.' },
      ],
    });
    expect(r.status).toBe(202);
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j.status).toBe('done');
    const dub = engine.calls.filter((c) => c.op === 'dub').at(-1)!.args;
    expect(dub.lines).toMatchObject([
      { start: 0.5, seconds: 1.5 },
      { start: 3, seconds: 2 },
    ]);
    expect(String(dub.bed)).toMatch(/d-[0-9a-f]{64}\.wav$/);
  });

  it('asks for a translation when no local model can make one', async () => {
    const up = (await (await raw('/api/voice/uploads', recording(2, 150))).json()) as { name: string };
    writeFileSync(
      join(dataDir, 'media', 'voice', `d-${up.name.replace(/\.wav$/, '')}.wav.txt`),
      'good morning',
    );
    const r = await post('/api/voice/dub', { source: up.name, language: 'es', voice: 'chatterbox-default' });
    const j = await finished(((await r.json()) as VoiceJob).id);
    expect(j.status).toBe('failed');
    expect(j.error!.message).toMatch(/No local model is running.*give the translated lines yourself/);
  });

  it('refuses a file that isn’t audio', async () => {
    const r = await raw('/api/voice/uploads', new TextEncoder().encode('<html>not audio</html>'));
    expect(r.status).toBe(415);
  });
});

describe('the stand-in GPU', () => {
  it('counts every voice model as installed and speaks without downloading anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-voice-standin-'));
    const fetched: string[] = [];
    const s = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hfClientId: null },
      {
        fakeTickMs: 25,
        secrets: memoryStore(),
        hubToken: join(dir, 'no-hf-token'),
        modelFetch: (async (u: string | URL | Request) => {
          fetched.push(String(u));
          throw new Error('offline');
        }) as typeof fetch,
      },
    );
    try {
      const st = (await (await fetch(`${s.url}/api/voice`)).json()) as VoiceState;
      expect(st.models.every((m) => m.installed && m.missingBytes === 0)).toBe(true);
      const r = await fetch(`${s.url}/api/voice/speak`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ paragraphs: [{ text: 'Hello there.' }], voice: st.voices[0]!.id }),
      });
      expect(r.status).toBe(202);
      const id = ((await r.json()) as VoiceJob).id;
      let j: VoiceJob | null = null;
      await until(async () => {
        j = (await (await fetch(`${s.url}/api/voice/jobs/${id}`)).json()) as VoiceJob;
        return j.status === 'done';
      });
      expect(fetched).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
