// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJoinCode } from '../src/choir.ts';
import { parseArgs } from '../src/config.ts';
import type { SecretStore } from '../src/hf.ts';
import { type Running, startServer } from '../src/server.ts';
import { FAKE_HEARD, TalkError, type TalkTurnResult } from '../src/talk.ts';
import { remoteLlm, remoteStt, remoteTts } from '../src/talk-remote.ts';
import { memoryStore } from './helpers.ts';

/** A staged recording and what it says: invented words, for the stand-in engine to "hear" on the worker. */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'talk', 'lighthouse.wav');
const LINE = readFileSync(`${FIXTURE}.txt`, 'utf8').trim();
const H = { 'x-hildegard': '1' };
/** Words the safety check refuses, as in voice.test.ts. */
const BLOCKED = 'explicit porn scene';

const memorySecrets = () => {
  const stores = new Map<string, SecretStore>();
  return (account: string) => {
    if (!stores.has(account)) stores.set(account, memoryStore());
    return stores.get(account)!;
  };
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const offline = {
  fetch: (async () => {
    throw new Error('offline');
  }) as typeof fetch,
  env: {},
  localAi: { gateways: async () => [], key: () => null },
};
const start = (dir: string) =>
  startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hfClientId: null },
    {
      fakeTickMs: 25,
      secrets: memoryStore(),
      choirSecrets: memorySecrets(),
      hubToken: join(dir, 'no-hf-token'),
      llm: offline,
    },
  );

let worker: Running;
let primary: Running;
let shareUrl: string;
let token: string;
let name: string;

beforeAll(async () => {
  worker = await start(mkdtempSync(join(tmpdir(), 'hg-talk-worker-')));
  primary = await start(mkdtempSync(join(tmpdir(), 'hg-talk-primary-')));
  const invite = await fetch(`${worker.url}/api/choir/invite`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    // The long hgc1_ code is made only on request since short codes (#95); this test pairs with it directly.
    body: JSON.stringify({ url: `http://127.0.0.1:${await freePort()}`, long: true }),
  });
  expect(invite.status).toBe(200);
  const { code, url } = (await invite.json()) as { code: string; url: string };
  shareUrl = url;
  ({ token, name } = parseJoinCode(code));
  const joined = await fetch(`${primary.url}/api/choir/join`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(joined.status).toBe(201);
  // The worker keeps a recording it is sent under its SHA-256; the stand-in engine hears the sidecar next to it.
  const bytes = readFileSync(FIXTURE);
  const voiceDir = join(worker.config.dataDir, 'media', 'voice');
  mkdirSync(voiceDir, { recursive: true });
  writeFileSync(join(voiceDir, `${createHash('sha256').update(bytes).digest('hex')}.wav.txt`), LINE);
}, 30_000);
afterAll(async () => {
  await primary?.close();
  await worker?.close();
});

const turn = (fields: Record<string, string>) => {
  const form = new FormData();
  form.set('audio', new Blob([readFileSync(FIXTURE)], { type: 'audio/wav' }), 'turn.wav');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return fetch(`${primary.url}/api/talk/turn`, { method: 'POST', headers: H, body: form });
};

describe('a Talk turn on a paired device', () => {
  it('hears, answers and speaks there, and plays here', async () => {
    const t0 = performance.now();
    const res = await turn({ device: name });
    const ms = Math.round(performance.now() - t0);
    expect(res.status).toBe(200);
    const r = (await res.json()) as TalkTurnResult;
    console.log(`remote Talk turn: ${ms} ms (stand-in engines)`);
    // Only the worker has the sidecar: this computer's own engine would have heard FAKE_HEARD.
    expect(r.transcript).toBe(LINE);
    expect(r.replyText).toBe(`You said: “${LINE}”`);
    expect(r.route).toEqual({ stt: 'remote', llm: 'remote', tts: 'remote' });
    expect(r.audio.url).toMatch(/^\/media\/voice\/[a-f0-9]{64}\.wav$/);
    const audio = await fetch(primary.url + r.audio.url!);
    expect(audio.status).toBe(200);
    const bytes = Buffer.from(await audio.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(120_000);
  });

  it('runs here when no device is named', async () => {
    const r = (await (await turn({})).json()) as TalkTurnResult;
    expect(r.transcript).toBe(FAKE_HEARD);
    expect(r.route).toEqual({ stt: 'local', llm: 'local', tts: 'local' });
  });

  it('sends only Talk uploads: a consent recording or a voice preview is refused, as it is here', async () => {
    // Both files exist on this computer, so only the name check stands between them and the other device.
    const voiceDir = join(primary.config.dataDir, 'media', 'voice');
    mkdirSync(voiceDir, { recursive: true });
    for (const f of ['c-session1.wav', 'p-voice1.wav'])
      writeFileSync(join(voiceDir, f), readFileSync(FIXTURE));
    for (const uploadId of ['c-session1.wav', 'p-voice1.wav', '../voice/refs/v1.wav'])
      for (const device of [name, undefined]) {
        const res = await fetch(`${primary.url}/api/talk/turn`, {
          method: 'POST',
          headers: { ...H, 'content-type': 'application/json' },
          body: JSON.stringify({ uploadId, ...(device ? { device } : {}) }),
        });
        expect(res.status, `${uploadId} ${device ? 'there' : 'here'}`).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('upload');
      }
  });

  it('refuses a turn on another device whose words are sexual', async () => {
    // A recording the worker's stand-in engine "hears" as blocked words.
    const bytes = Buffer.from(readFileSync(FIXTURE));
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
    writeFileSync(
      join(
        worker.config.dataDir,
        'media',
        'voice',
        `${createHash('sha256').update(bytes).digest('hex')}.wav.txt`,
      ),
      BLOCKED,
    );
    const form = new FormData();
    form.set('audio', new Blob([bytes], { type: 'audio/wav' }), 'turn.wav');
    form.set('device', name);
    const res = await fetch(`${primary.url}/api/talk/turn`, { method: 'POST', headers: H, body: form });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('content_blocked');
  });

  it('refuses a device this computer hasn’t joined', async () => {
    const res = await turn({ device: 'nowhere' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('device');
  });
});

describe('Talk with a second serving device', () => {
  /** A second worker, joined under its own name, that "hears" a different line in the same recording. */
  const SECOND = 'second-server';
  const SECOND_LINE = 'Cut the storm scene down to three shots.';
  let second: Running;

  beforeAll(async () => {
    second = await start(mkdtempSync(join(tmpdir(), 'hg-talk-second-')));
    const invite = await fetch(`${second.url}/api/choir/invite`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${await freePort()}` }),
    });
    const { code } = (await invite.json()) as { code: string };
    const joined = await fetch(`${primary.url}/api/choir/join`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: SECOND }),
    });
    expect(joined.status).toBe(201);
    const voiceDir = join(second.config.dataDir, 'media', 'voice');
    mkdirSync(voiceDir, { recursive: true });
    writeFileSync(
      join(voiceDir, `${createHash('sha256').update(readFileSync(FIXTURE)).digest('hex')}.wav.txt`),
      SECOND_LINE,
    );
  }, 30_000);
  afterAll(async () => {
    await second?.close();
  });

  it('runs each turn on the device it names, switching between the two', async () => {
    expect(SECOND).not.toBe(name);
    for (const [device, heard] of [
      [name, LINE],
      [SECOND, SECOND_LINE],
      [name, LINE],
    ] as const) {
      const res = await turn({ device });
      expect(res.status, device).toBe(200);
      const r = (await res.json()) as TalkTurnResult;
      expect(r.transcript, device).toBe(heard);
      expect(r.route).toEqual({ stt: 'remote', llm: 'remote', tts: 'remote' });
    }
  });

  it('lists both devices as able to talk', async () => {
    const res = await fetch(`${primary.url}/api/choir`, { headers: H });
    const s = (await res.json()) as { devices: Array<{ name: string; online: boolean }> };
    expect(s.devices.map((d) => d.name).sort()).toEqual([name, SECOND].sort());
    expect(s.devices.every((d) => d.online)).toBe(true);
  });
});

describe('Talk on /api/node', () => {
  const node = (path: string, init: RequestInit, key: string | null = token) =>
    fetch(`${shareUrl}/api/node/${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
    });
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('transcribes, completes and speaks for a paired device', async () => {
    const heard = await node('transcribe?language=en', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: readFileSync(FIXTURE),
    });
    expect(heard.status).toBe(200);
    expect(await heard.json()).toEqual({ text: LINE });

    const answer = await node('complete', json({ messages: [{ role: 'user', content: 'Hello there' }] }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ text: 'You said: “Hello there”' });

    const said = await node('speak', json({ text: 'A light on the rocks.' }));
    expect(said.status).toBe(200);
    expect(said.headers.get('content-type')).toBe('audio/wav');
    expect(
      Buffer.from(await said.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe('RIFF');
  });

  it('refuses a missing or wrong key on every Talk route', async () => {
    for (const key of [null, 'A'.repeat(43)])
      for (const [path, init] of [
        ['transcribe', { method: 'POST', body: readFileSync(FIXTURE) }],
        ['complete', json({ messages: [{ role: 'user', content: 'Hi' }] })],
        ['speak', json({ text: 'Hi' })],
      ] as const) {
        const res = await node(path, init, key);
        expect(res.status, `${path} with ${key ? 'a wrong' : 'no'} key`).toBe(401);
      }
  });

  it('refuses to answer sexual words', async () => {
    for (const messages of [
      [{ role: 'user', content: BLOCKED }],
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'assistant', content: BLOCKED },
        { role: 'user', content: 'Go on.' },
      ],
    ]) {
      const res = await node('complete', json({ messages }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('content_blocked');
    }
    await expect(
      remoteLlm({ url: shareUrl, token: () => token, name }).complete([{ role: 'user', content: BLOCKED }]),
    ).rejects.toMatchObject({ code: 'content_blocked', status: 400 });
  });

  it('refuses what isn’t a turn, and voices it doesn’t lend', async () => {
    expect((await node('transcribe', { method: 'POST', body: new Uint8Array() })).status).toBe(400);
    expect((await node('transcribe', { method: 'POST', body: new Uint8Array(200).fill(7) })).status).toBe(
      415,
    );
    expect((await node('complete', json({ messages: [] }))).status).toBe(400);
    expect((await node('speak', json({ text: '' }))).status).toBe(400);
    const cloned = await node('speak', json({ text: 'Hi', voice: 'my-own-voice' }));
    expect(cloned.status).toBe(400);
    expect(((await cloned.json()) as { code: string }).code).toBe('voice');
  });

  it('asks for the key on this computer’s own listener too', async () => {
    // The hosted listener (a Tailscale link) answers 404 for all of /api/node; host.test.ts covers that.
    const res = await fetch(`${worker.url}/api/node/complete`, {
      ...json({ messages: [{ role: 'user', content: 'Hi' }] }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });
});

describe('the remote adapters', () => {
  const o = () => ({ url: shareUrl, token: () => token, name });

  it('say they are remote, and work on their own', async () => {
    const stt = remoteStt(o());
    expect([stt.where, remoteLlm(o()).where, remoteTts(o()).where]).toEqual(['remote', 'remote', 'remote']);
    const wav = join(mkdtempSync(join(tmpdir(), 'hg-talk-')), 'a.wav');
    writeFileSync(wav, readFileSync(FIXTURE));
    expect(await stt.transcribe(wav)).toEqual({ text: LINE });
    const said = await remoteTts(o()).speak('Keep the lamp lit.');
    expect(said.contentType).toBe('audio/wav');
    expect(readFileSync(said.path).subarray(0, 4).toString()).toBe('RIFF');
  });

  it('say plainly when the key is gone or refused', async () => {
    await expect(
      remoteLlm({ ...o(), token: () => null }).complete([{ role: 'user', content: 'Hi' }]),
    ).rejects.toMatchObject({ code: 'remote_key', status: 409 });
    const refused = remoteLlm({ ...o(), token: () => 'B'.repeat(43) }).complete([
      { role: 'user', content: 'Hi' },
    ]);
    await expect(refused).rejects.toBeInstanceOf(TalkError);
    await expect(refused).rejects.toMatchObject({ code: 'remote_refused' });
  });
});
