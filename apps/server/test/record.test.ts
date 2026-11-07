// SPDX-License-Identifier: AGPL-3.0-only
// Recording from any chat: the one-time link, the page behind it, the upload, whose recording is whose (over REST and
// the MCP), cleaning, and a voice-over in a film. The cleaning and the mix are measured in voice-clean.test.ts;
// here the same code runs behind the routes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportState, NewKey, Project, Take } from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { ID_RE, RecordError, RecordStore, sniffRecording, sniffVideo, TOKEN_RE } from '../src/record.ts';
import { type Running, startServer } from '../src/server.ts';
import { make, measure } from './audio.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const RAW = { 'x-hildegard': '1', 'content-type': 'application/octet-stream' };
const PASS = 'a long and private passphrase';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
async function until(fn: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
}

const work = mkdtempSync(join(tmpdir(), 'hg-record-'));
const dataDir = join(work, 'data');
const uiDir = join(work, 'ui');
let skew = 0;
let srv: Running;
let remote: string;
/** Every token this file made, to look for in the logs at the end. */
const tokens: string[] = [];
const logged: string[] = [];

const local = (path: string, method = 'GET', body?: unknown) =>
  fetch(srv.url + path, {
    method,
    headers: method === 'GET' ? {} : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const there = (cookie: string | null, path: string, method = 'GET', body?: unknown) =>
  fetch(remote + path, {
    method,
    headers: { ...(method === 'GET' ? {} : H), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A signed-in person on another device. */
async function director(name: string): Promise<string> {
  const inv = (await (await local('/api/people/invites', 'POST', { role: 'director' })).json()) as {
    url: string;
  };
  const accept = await fetch(`${remote}/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name, passphrase: PASS }),
  });
  expect(accept.status).toBe(201);
  const res = await fetch(`${remote}/api/auth/signin`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name, passphrase: PASS }),
  });
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
}

type Link = {
  id: string;
  token: string;
  path: string;
  url: string;
  viaLink: boolean;
  expiresAt: string;
  localOnly: boolean;
};
async function link(
  who: string | null,
  kind: 'voice' | 'video' = 'voice',
  extra: Record<string, unknown> = {},
): Promise<Link> {
  const res = who
    ? await there(who, '/api/record/links', 'POST', { kind, ...extra })
    : await local('/api/record/links', 'POST', { kind, ...extra });
  expect(res.status).toBe(201);
  const l = (await res.json()) as Link;
  tokens.push(l.token);
  return l;
}
/** The person on the record page: only the token, no sign-in, through the link as another device reaches it. */
const send = (token: string, bytes: Uint8Array | string) =>
  fetch(`${remote}/api/record/${token}`, { method: 'POST', headers: RAW, body: bytes });

const speech = (name: string, seconds = 5, seed = 1) => {
  make('speech', join(work, name), String(seconds), String(seed));
  return readFileSync(join(work, name));
};

beforeAll(async () => {
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Studio</title><div id="root"></div>');
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  const hostPort = await freePort();
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dataDir, '--ui', uiDir]), port: 0, hostPort },
    {
      fakeTickMs: 20,
      secrets: memoryStore(),
      exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
      limits: { perName: 50, perClient: 1000 },
      now: () => Date.now() + skew,
    },
  );
  remote = srv.hostedUrl()!;
  expect((await local('/api/people/owner', 'POST', { name: 'Ada', passphrase: PASS })).status).toBe(201);
  await until(() => srv.scheduler.engineState().online);
}, 30_000);
afterAll(() => srv.close());

describe('the link', () => {
  it('is 256 random bits, good once for 30 minutes, and kept on disk only as its hash', async () => {
    const l = await link(null, 'voice', { purpose: 'Read the opening line' });
    expect(l.token).toMatch(TOKEN_RE);
    expect(l.id).toMatch(ID_RE);
    expect(l.url).toBe(`${srv.url}/record/${l.token}`);
    expect(l.viaLink).toBe(false);
    expect(l.localOnly).toBe(true);
    const minutes = (Date.parse(l.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);
    expect(new Set([(await link(null)).token, (await link(null)).token, l.token]).size).toBe(3);

    const file = readFileSync(join(dataDir, 'record', 'recordings.json'), 'utf8');
    expect(file).not.toContain(l.token);
    expect(file).toContain(sha(l.token));
    expect(file).toContain('Read the opening line');
    // Only the owner can read it, and nothing but a hash is in it.
    expect(JSON.parse(file).entries.every((e: { token?: string }) => e.token === undefined)).toBe(true);
  });

  it('is made only by someone signed in, for their own use', async () => {
    expect((await there(null, '/api/record/links', 'POST', { kind: 'voice' })).status).toBe(401);
    const bad = await local('/api/record/links', 'POST', { kind: 'podcast' });
    expect(bad.status).toBe(400);
    const nofilm = await local('/api/record/links', 'POST', { kind: 'voice', filmId: 'nope' });
    expect(nofilm.status).toBe(404);
  });

  it('is the only credential: the page and its upload need no sign-in, and nothing else does', async () => {
    const l = await link(null);
    // Through the link, as another device reaches it, with no cookie.
    const info = await fetch(`${remote}/api/record/${l.token}`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ kind: 'voice', state: 'pending', maxBytes: 100 * 1024 * 1024 });
    // What the page learns does not include who made the link, or any id.
    expect(
      Object.keys((await (await fetch(`${remote}/api/record/${l.token}`)).json()) as object).sort(),
    ).toEqual(['expiresAt', 'kind', 'maxBytes', 'purpose', 'state']);
    for (const [path, method] of [
      [`/api/record/${l.id}`, 'GET'],
      ['/api/record/status', 'POST'],
      ['/api/record/links', 'POST'],
      ['/api/record/imports', 'POST'],
      [`/api/record/${l.id}/clean`, 'POST'],
      ['/api/record/clean/rcj_0000000000000000', 'GET'],
      [`/media/recordings/local/${l.id}.wav`, 'GET'],
    ] as const) {
      const res = await fetch(remote + path, {
        method,
        headers: method === 'GET' ? {} : H,
        body: method === 'GET' ? undefined : '{}',
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('the page behind a link', () => {
  it('is the Studio for a live link, 404 for one nobody made, and 410 once it has run out', async () => {
    const l = await link(null);
    const ok = await fetch(`${remote}${l.path}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('<div id="root">');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    for (const bad of [
      `/record/${'A'.repeat(43)}`,
      '/record/short',
      `/record/${l.token.slice(0, 42)}x`,
      '/record/',
    ]) {
      const res = await fetch(remote + bad);
      expect(res.status, bad).toBe(404);
      expect(await res.text(), bad).not.toContain('<div id="root">');
    }
    skew = 31 * 60_000;
    try {
      const gone = await fetch(`${remote}${l.path}`);
      expect(gone.status).toBe(410);
      expect(await gone.text()).toContain('This link has run out');
      expect((await fetch(`${remote}/api/record/${l.token}`)).status).toBe(410);
      expect((await send(l.token, speech('late.wav'))).status).toBe(410);
    } finally {
      skew = 0;
    }
    // A link that never existed is not "run out": it is unknown.
    expect((await fetch(`${remote}/api/record/${'B'.repeat(43)}`)).status).toBe(404);
  });
});

describe('the upload', () => {
  it('takes one recording per link, and the second is refused', async () => {
    const l = await link(null);
    const wav = speech('one.wav', 4);
    const first = await send(l.token, wav);
    expect(first.status).toBe(200);
    // The phone learns only that it arrived.
    expect(await first.json()).toEqual({ received: true });
    const again = await send(l.token, wav);
    expect(again.status).toBe(409);
    expect((await (await local(`/api/record/${l.id}`)).json()) as { status: string }).toMatchObject({
      status: 'received',
    });
    // Two at once: one wins.
    const l2 = await link(null);
    const both = await Promise.all([send(l2.token, wav), send(l2.token, wav)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('checks what the bytes are, not what they are called, and a refused file leaves the link usable', async () => {
    const voice = await link(null, 'voice');
    for (const [what, bytes] of [
      ['text', 'Hello, this is not a recording at all.'],
      ['a PNG', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')],
      ['a script', '#!/bin/sh\nrm -rf /\n'],
    ] as const) {
      const res = await send(voice.token, bytes);
      expect(res.status, what).toBe(415);
      expect(((await res.json()) as { code: string }).code).toBe('type');
    }
    expect((await send(voice.token, '')).status).toBe(400);
    // Nothing was kept, and the link still works.
    expect(readdirSync(join(dataDir, 'media', 'recordings', 'local')).some((f) => f.includes('.part'))).toBe(
      false,
    );
    expect((await send(voice.token, speech('ok.wav', 3))).status).toBe(200);

    // A video link wants a picture: sound alone is refused.
    const video = await link(null, 'video');
    const wavForVideo = await send(video.token, speech('sound.wav', 3));
    expect(wavForVideo.status).toBe(415);
    make('video', join(work, 'clip.mp4'), '3', '2');
    const clip = readFileSync(join(work, 'clip.mp4'));
    expect((await send(video.token, clip)).status).toBe(200);
    const done = (await (await local(`/api/record/${video.id}`)).json()) as {
      kind: string;
      seconds: number;
      url: string;
    };
    expect(done).toMatchObject({ kind: 'video' });
    expect(done.seconds).toBeCloseTo(3, 0);
    expect(done.url).toMatch(/^\/media\/recordings\/local\/rec_[0-9a-f]{16}\.mp4$/);

    // A voice link wants sound only: a video, though a real media file, is refused.
    const voice2 = await link(null, 'voice');
    const res = await send(voice2.token, clip);
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toMatch(/picture/);
    expect((await send(voice2.token, speech('after.wav', 3))).status).toBe(200);
  }, 60_000);

  it('takes the audio/mp4 an iPhone records, whatever brand its ftyp carries, and still refuses a picture', async () => {
    // Safari's MediaRecorder writes AAC in an MP4 with no picture; its brand is iso5, mp42 or M4A, not always M4A.
    for (const brand of ['iso5', 'mp42', 'M4A ']) {
      make('m4a', join(work, `phone-${brand.trim()}.m4a`), '3', brand);
      const bytes = readFileSync(join(work, `phone-${brand.trim()}.m4a`));
      expect(bytes.subarray(4, 12).toString('latin1'), brand).toBe(`ftyp${brand}`);
      expect(sniffRecording(bytes, 'voice'), brand).toBe('m4a');
      const l = await link(null, 'voice');
      expect((await send(l.token, bytes)).status, brand).toBe(200);
      const got = (await (await local(`/api/record/${l.id}`)).json()) as {
        status: string;
        kind: string;
        seconds: number;
      };
      expect(got, brand).toMatchObject({ status: 'received', kind: 'voice' });
      expect(got.seconds).toBeCloseTo(3, 0);
    }
    // The same container with a picture in it is a video, and a voice link refuses it.
    make('video', join(work, 'phone-video.mp4'), '3', '2');
    const l = await link(null, 'voice');
    const res = await send(l.token, readFileSync(join(work, 'phone-video.mp4')));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toMatch(/picture/);
  }, 60_000);

  it('refuses a recording over the cap before reading it: 100 MB for sound, 500 MB for video', async () => {
    const tooBig = (token: string, length: number) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(`${remote}/api/record/${token}`);
        const req = httpRequest(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: { ...RAW, 'content-length': String(length) },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
            req.destroy();
          },
        );
        req.on('error', reject);
        req.write(Buffer.from('RIFF'));
      });
    const v = await link(null, 'voice');
    expect(await tooBig(v.token, 100 * 1024 * 1024 + 1)).toBe(413);
    const m = await link(null, 'video');
    expect(await tooBig(m.token, 500 * 1024 * 1024 + 1)).toBe(413);
    // Under the cap, the same link still takes a recording.
    expect((await send(v.token, speech('cap.wav', 3))).status).toBe(200);
  });

  it('reports what arrived: pending, then received with its length and where it is, then expired for one never sent', async () => {
    const l = await link(null);
    expect(await (await local(`/api/record/${l.id}`)).json()).toMatchObject({
      status: 'pending',
      url: null,
      seconds: null,
    });
    expect(await (await local('/api/record/status', 'POST', { token: l.token })).json()).toMatchObject({
      id: l.id,
      status: 'pending',
    });
    await send(l.token, speech('status.wav', 6));
    const r = (await (await local(`/api/record/${l.id}`)).json()) as {
      status: string;
      seconds: number;
      url: string;
      file: string;
      bytes: number;
    };
    expect(r.status).toBe('received');
    expect(r.seconds).toBeCloseTo(6, 1);
    expect(existsSync(r.file)).toBe(true);
    expect(r.file).toBe(join(dataDir, 'media', 'recordings', 'local', `${l.id}.wav`));
    expect((await local(r.url)).headers.get('content-type')).toBe('audio/wav');
    // The status never carries the link.
    expect(JSON.stringify(r)).not.toContain(l.token);

    const gone = await link(null);
    skew = 31 * 60_000;
    try {
      expect(await (await local(`/api/record/${gone.id}`)).json()).toMatchObject({ status: 'expired' });
    } finally {
      skew = 0;
    }
  });
});

describe('whose recording it is', () => {
  it('stays with the person who asked: another director gets "no such recording" over REST, and so does a stranger', async () => {
    const hilde = await director('Hilde');
    const otto = await director('Otto');
    const l = await link(hilde, 'voice', { purpose: 'Hilde’s narration' });
    expect((await send(l.token, speech('hilde.wav', 4))).status).toBe(200);

    const mine = await there(hilde, `/api/record/${l.id}`);
    expect(mine.status).toBe(200);
    const view = (await mine.json()) as { status: string; url: string; file: string | null; purpose: string };
    expect(view).toMatchObject({ status: 'received', purpose: 'Hilde’s narration' });
    // Where the file is on this computer is for someone at this computer, not a person on another device.
    expect(view.file).toBeNull();
    expect((await there(hilde, view.url)).status).toBe(200);

    // Otto asks for it by id, by the link's token, to clean it, for its file: all "no such recording".
    for (const res of [
      await there(otto, `/api/record/${l.id}`),
      await there(otto, '/api/record/status', 'POST', { token: l.token }),
      await there(otto, `/api/record/${l.id}/clean`, 'POST', {}),
      await there(otto, view.url),
    ])
      expect(res.status).toBe(404);
    // Another person's token on the page route is still the page's business (the token is the credential there),
    // but it shows nothing of the recording once sent.
    const page = (await (await there(otto, `/api/record/${l.token}`)).json()) as Record<string, unknown>;
    expect(page.state).toBe('received');
    expect(page.id).toBeUndefined();
    // A cleaning job belongs to whoever started it.
    const job = (await (await there(hilde, `/api/record/${l.id}/clean`, 'POST', {})).json()) as {
      id: string;
    };
    expect((await there(hilde, `/api/record/clean/${job.id}`)).status).toBe(200);
    expect((await there(otto, `/api/record/clean/${job.id}`)).status).toBe(404);
    // And a voice-over in a film: Otto can't use Hilde's recording, whatever film it is.
    const film = (await (
      await there(otto, '/api/projects', 'POST', { title: 'Otto’s film' })
    ).json()) as Project;
    const use = await there(otto, `/api/projects/${film.id}/export`, 'POST', {
      voiceover: { mediaId: l.id },
    });
    expect(use.status).toBe(404);
    expect(((await use.json()) as { error: string }).error).toMatch(/No such recording/);
    // The owner of this Hildegard, and this computer, see everyone's, as they do films.
    expect((await local(`/api/record/${l.id}`)).status).toBe(200);
    expect((await local(view.url)).status).toBe(200);
    // Nobody signed in sees nothing.
    expect((await there(null, view.url)).status).toBe(401);
    // And a director can't make a link for a film that isn't theirs.
    const ownersFilm = (await (
      await local('/api/projects', 'POST', { title: 'Ada’s film' })
    ).json()) as Project;
    expect(
      (await there(otto, '/api/record/links', 'POST', { kind: 'voice', filmId: ownersFilm.id })).status,
    ).toBe(404);
  }, 60_000);
});

describe('over the MCP', () => {
  const textOf = (r: CallToolResult) =>
    r.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  async function mcpAt(base: string, token?: string) {
    const client = new Client({ name: 'test-chatbot', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
      }),
    );
    return client;
  }
  const keyFor = async (person: string) => {
    const res = await local('/api/auth/keys', 'POST', { name: `${person}’s agent`, person });
    expect(res.status).toBe(201);
    return ((await res.json()) as NewKey).key;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown>) =>
    (await c.callTool({ name, arguments: args })) as CallToolResult;

  it('gives a chat the link and the words to show, and each person’s agent sees only its own person’s recordings', async () => {
    await director('Greta');
    await director('Hans');
    const greta = await mcpAt(remote, await keyFor('Greta'));
    const hans = await mcpAt(remote, await keyFor('Hans'));
    try {
      const made = await call(greta, 'record_link', { kind: 'voice', purpose: 'The opening narration' });
      expect(made.isError).toBeFalsy();
      const text = textOf(made);
      const url = /Link for a voice recording: (\S+)/.exec(text)![1]!;
      const token = url.split('/record/')[1]!;
      tokens.push(token);
      // The link points where the app reached Hildegard, and the words say what to do and how long it lasts.
      expect(url.startsWith(`${remote}/record/`)).toBe(true);
      expect(token).toMatch(TOKEN_RE);
      expect(text).toMatch(/Tap Record/);
      expect(text).toMatch(/works once and ends in 30 minutes/);
      const id = /Recording id: (rec_[0-9a-f]{16})/.exec(text)![1]!;

      expect(textOf(await call(greta, 'recording_status', { id }))).toMatch(/^Pending/);
      expect((await send(token, speech('mcp.wav', 5))).status).toBe(200);
      const got = textOf(await call(greta, 'recording_status', { id }));
      expect(got).toMatch(/Received: media id rec_[0-9a-f]{16}, a voice recording, 5\.0 seconds/);
      expect(got).toContain(`Next: clean_voice with media_id ${id}`);
      // By token works too, for whoever made it.
      expect(textOf(await call(greta, 'recording_status', { token }))).toMatch(/^Received/);
      // The file opens from the signed link, with no sign-in, and is the recording.
      const signed = /Link \(opens without signing in, for a day\): (\S+)/.exec(got)![1]!;
      const file = await fetch(signed);
      expect(file.status).toBe(200);
      expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(100_000);

      // Hans's agent: the same id, the same token, cleaning it: "No such recording", as if it did not exist.
      for (const r of [
        await call(hans, 'recording_status', { id }),
        await call(hans, 'recording_status', { token }),
        await call(hans, 'clean_voice', { media_id: id }),
      ]) {
        expect(r.isError).toBe(true);
        expect(textOf(r)).toMatch(/No such recording/);
      }
      // Neither's text carries a token they weren't given.
      expect(textOf(await call(hans, 'record_link', { kind: 'video' }))).not.toContain(token);
    } finally {
      await greta.close();
      await hans.close();
    }
  }, 60_000);

  it('cleans a recording from its media id or a path', async () => {
    const c = await mcpAt(srv.url);
    try {
      const made = textOf(await call(c, 'record_link', { kind: 'voice', purpose: 'Narration' }));
      const url = /Link for a voice recording: (\S+)/.exec(made)![1]!;
      expect(url.startsWith(`${srv.url}/record/`)).toBe(true);
      expect(made).toMatch(/opens only on the computer Hildegard runs on/);
      const token = url.split('/record/')[1]!;
      tokens.push(token);
      const id = /Recording id: (rec_\w+)/.exec(made)![1]!;
      await send(token, speech('narration.wav', 8, 6));

      const cleaned = textOf(await call(c, 'clean_voice', { media_id: id, target_lufs: -16, peak: -1.5 }));
      expect(cleaned).toMatch(
        /^Cleaned: media id rec_[0-9a-f]{16}, 8\.0 seconds, -1[56]\.\d LUFS, true peak -\d\.\d dBTP/,
      );
      const path = /File: (\S+\.wav)/.exec(cleaned)![1]!;
      const m = measure(path);
      expect(Math.abs(m.lufs - -16)).toBeLessThanOrEqual(1);
      expect(m.true_peak).toBeLessThanOrEqual(-1.5);

      // A recording on disk, by path.
      const byPath = textOf(await call(c, 'clean_voice', { source_path: join(work, 'narration.wav') }));
      expect(byPath).toMatch(/^Cleaned: media id rec_/);
      const bad = await call(c, 'clean_voice', { source_path: join(work, 'nope.wav') });
      expect(bad.isError).toBe(true);
      const both = await call(c, 'clean_voice', { media_id: id, source_path: join(work, 'narration.wav') });
      expect(both.isError).toBe(true);
    } finally {
      await c.close();
    }
  }, 120_000);
});

describe('cleaning, behind the route', () => {
  it('runs as a job and returns a new recording with the loudness and true peak it measured, leaving the original', async () => {
    const l = await link(null);
    await send(l.token, speech('job.wav', 10, 3));
    const start = await local(`/api/record/${l.id}/clean`, 'POST', { target_lufs: -18, peak: -2 });
    expect(start.status).toBe(202);
    let job = (await start.json()) as {
      id: string;
      status: string;
      recording: { id: string; clean: { lufs: number; truePeak: number } } | null;
      error: string | null;
    };
    await until(async () => {
      job = (await (await local(`/api/record/clean/${job.id}`)).json()) as typeof job;
      return job.status !== 'running';
    }, 60_000);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    const out = job.recording!;
    expect(out.id).not.toBe(l.id);
    expect(Math.abs(out.clean.lufs - -18)).toBeLessThanOrEqual(1);
    expect(out.clean.truePeak).toBeLessThanOrEqual(-2);
    const file = ((await (await local(`/api/record/${out.id}`)).json()) as { file: string; from: string })
      .file;
    const m = measure(file);
    expect(Math.abs(m.lufs - -18)).toBeLessThanOrEqual(1);
    expect(m.true_peak).toBeLessThanOrEqual(-2);
    // The original is still there, unchanged.
    expect(
      measure(((await (await local(`/api/record/${l.id}`)).json()) as { file: string }).file).lufs,
    ).toBeLessThan(-19);
    // Targets that make no sense are refused.
    expect((await local(`/api/record/${l.id}/clean`, 'POST', { target_lufs: 3 })).status).toBe(400);
    expect((await local(`/api/record/${l.id}/clean`, 'POST', { peak: 5 })).status).toBe(400);
    // A recording that has not arrived can't be cleaned.
    const pending = await link(null);
    expect((await local(`/api/record/${pending.id}/clean`, 'POST', {})).status).toBe(409);
  }, 90_000);
});

describe('a voice-over in a film', () => {
  it('mixes a recording of yours over the film and keeps the film’s length; a recording that isn’t yours is refused', async () => {
    const film = (await (await local('/api/projects', 'POST', { title: 'Voiced' })).json()) as Project;
    const made = await local('/api/shots', 'POST', {
      projectId: film.id,
      request: {
        prompt: 'The beam sweeps the fog',
        rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
        format: { quality: 'draft', seconds: 3 },
        takes: 1,
      },
    });
    const takes = ((await made.json()) as { takes: Take[] }).takes;
    await until(async () => {
      const t = (await (await local(`/api/shots/${takes[0]!.shotId}`)).json()) as { takes: Take[] };
      return t.takes.every((x) => x.status === 'done');
    }, 30_000);

    const exportFilm = async (body?: unknown) => {
      const res = await local(`/api/projects/${film.id}/export`, 'POST', body);
      if (res.status !== 202) return res;
      let e = (await res.json()) as ExportState;
      await until(async () => {
        e = (await (await local(`/api/exports/${e.id}`)).json()) as ExportState;
        return e.status !== 'running';
      }, 60_000);
      return e as ExportState & { file: string };
    };
    const plain = (await exportFilm()) as ExportState & { file: string };
    expect(plain.status).toBe('done');

    const l = await link(null);
    await send(l.token, speech('over.wav', 3, 8));
    for (const bad of [
      { voiceover: { mediaId: 'rec_0000000000000000' } },
      { voiceover: { mediaId: l.id, duckDb: 99 } },
      { voiceover: { mediaId: l.id, startSeconds: -1 } },
      { voiceover: { mediaId: 7 } },
    ]) {
      const res = (await exportFilm(bad)) as Response;
      expect([400, 404], JSON.stringify(bad)).toContain(res.status);
    }
    // A link not yet used is not a recording.
    const pending = await link(null);
    expect(((await exportFilm({ voiceover: { mediaId: pending.id } })) as Response).status).toBe(404);

    const mixed = (await exportFilm({ voiceover: { mediaId: l.id, startSeconds: 0.5 } })) as ExportState & {
      file: string;
    };
    expect(mixed).toMatchObject({ status: 'done', error: null });
    expect(mixed.seconds).toBe(plain.seconds);
    const m = measure(mixed.file);
    expect(Math.abs(m.lufs - -14)).toBeLessThanOrEqual(1);
    expect(m.seconds).toBeCloseTo(plain.seconds ?? 0, 1);
    // An export that follows with no voice-over is the plain film again.
    const again = (await exportFilm()) as ExportState & { file: string };
    expect(again.status).toBe('done');

    // The same through the MCP: by media id, and by a path on this computer.
    const c = new Client({ name: 'test-chatbot', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    try {
      const byId = (await c.callTool({
        name: 'export_film',
        arguments: { film_id: film.id, voiceover: { media_id: l.id, start_seconds: 0.5, duck_db: 10 } },
      })) as CallToolResult;
      const said = byId.content.map((x) => (x as { text: string }).text).join('\n');
      expect(byId.isError, said).toBeFalsy();
      expect(said).toMatch(/with the voice-over/);
      const out = /at (\S+\.mp4)\./.exec(said)![1]!;
      expect(Math.abs(measure(out).lufs - -14)).toBeLessThanOrEqual(1);
      const byPath = (await c.callTool({
        name: 'export_film',
        arguments: { film_id: film.id, voiceover: { path: join(work, 'over.wav') } },
      })) as CallToolResult;
      expect(byPath.isError).toBeFalsy();
      const both = (await c.callTool({
        name: 'export_film',
        arguments: { film_id: film.id, voiceover: { path: join(work, 'over.wav'), media_id: l.id } },
      })) as CallToolResult;
      expect(both.isError).toBe(true);

      // A plain export of the film is running: a voice-over export does not join it, or say it has the voice. It is
      // refused, with nothing imported, and works once the plain one is done.
      const files = () => readdirSync(join(dataDir, 'media', 'recordings', 'local')).length;
      const started = await local(`/api/projects/${film.id}/export`, 'POST');
      expect(started.status).toBe(202);
      const plainRun = (await started.json()) as ExportState;
      const before = files();
      for (const voiceover of [{ path: join(work, 'over.wav') }, { media_id: l.id }]) {
        const refused = (await c.callTool({
          name: 'export_film',
          arguments: { film_id: film.id, voiceover },
        })) as CallToolResult;
        const why = refused.content.map((x) => (x as { text: string }).text).join('\n');
        expect(refused.isError, why).toBe(true);
        expect(why).toMatch(/already exporting.*again after it finishes/);
        expect(why).not.toMatch(/Exported/);
      }
      // The refusals came while it was still going, and left no recording behind.
      expect(((await (await local(`/api/exports/${plainRun.id}`)).json()) as ExportState).status).toBe(
        'running',
      );
      expect(files()).toBe(before);
      await until(
        async () =>
          ((await (await local(`/api/exports/${plainRun.id}`)).json()) as ExportState).status === 'done',
        60_000,
      );
      const afterwards = (await c.callTool({
        name: 'export_film',
        arguments: { film_id: film.id, voiceover: { media_id: l.id } },
      })) as CallToolResult;
      expect(afterwards.isError).toBeFalsy();
    } finally {
      await c.close();
    }
  }, 120_000);
});

describe('the store on its own', () => {
  const stream = (...parts: Uint8Array[]) => new Response(Buffer.concat(parts)).body;
  const wavHead = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
  const fresh = (now: () => number, extra: Partial<ConstructorParameters<typeof RecordStore>[0]> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'hg-store-'));
    return new RecordStore({
      dataDir: join(root, 'data'),
      mediaDir: join(root, 'media'),
      now,
      probe: async () => ({ seconds: 1.5, audio: true, video: false }),
      ...extra,
    });
  };

  it('lasts 30 minutes to the second, once, and never stores the token', async () => {
    let t = 1_000_000;
    const s = fresh(() => t);
    const { token, id, expiresAt } = s.makeLink('local', { kind: 'voice' });
    expect(expiresAt - t).toBe(30 * 60_000);
    expect(s.gate(token)).toBe('ok');
    t += 30 * 60_000 - 1;
    expect(s.link(token).kind).toBe('voice');
    t += 1;
    expect(s.gate(token)).toBe('expired');
    expect(() => s.link(token)).toThrow(expect.objectContaining({ status: 410 }));
    await expect(s.receive(token, stream(wavHead, Buffer.alloc(2000)))).rejects.toMatchObject({
      status: 410,
    });
    expect(s.view(s.get(id)!).status).toBe('expired');
    expect(s.gate('x'.repeat(43))).toBe('unknown');
    expect(s.gate('')).toBe('unknown');
  });

  it('keeps no token anywhere in its files', async () => {
    let t = 5_000_000;
    const s = fresh(() => t);
    const { token } = s.makeLink('local', { kind: 'voice' });
    await s.receive(token, stream(wavHead, Buffer.alloc(2000)));
    const root = (s as unknown as { file: string }).file;
    const seen: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        if (n.isDirectory()) walk(p);
        else seen.push(readFileSync(p, 'latin1'));
      }
    };
    walk(join(root, '..', '..', '..'));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.some((x) => x.includes(token))).toBe(false);
    expect(seen.some((x) => x.includes(sha(token)))).toBe(true);
    t += 1;
  });

  it('stops reading at the cap, counted as bytes arrive, and leaves nothing behind or used up', async () => {
    const s = fresh(() => 1, { maxBytes: { voice: 1000 } });
    const { token } = s.makeLink('local', { kind: 'voice' });
    const over = stream(wavHead, Buffer.alloc(600), Buffer.alloc(600));
    await expect(s.receive(token, over)).rejects.toBeInstanceOf(RecordError);
    await expect(s.receive(token, stream(wavHead, Buffer.alloc(1200)))).rejects.toMatchObject({
      status: 413,
    });
    expect(readdirSync(join((s as unknown as { root: string }).root, 'local'))).toEqual([]);
    await expect(s.receive(token, stream(wavHead, Buffer.alloc(100)))).resolves.toMatchObject({
      status: 'received',
    });
  });

  it('keeps the link an upload is streaming through when 21 more are made meanwhile', async () => {
    const s = fresh(() => 1);
    const { token, id } = s.makeLink('local', { kind: 'voice' });
    let finish!: () => void;
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(wavHead);
        c.enqueue(Buffer.alloc(2000));
        finish = () => c.close();
      },
    });
    const upload = s.receive(token, slow);
    const busy = (s as unknown as { busy: Set<string> }).busy;
    await until(() => busy.has(id));
    // The owner's agent, looping on record_link, goes past the 20 links one person may have waiting.
    for (let i = 0; i < 21; i++) s.makeLink('local', { kind: 'voice' });
    finish();
    await expect(upload).resolves.toMatchObject({ id, status: 'received' });
    expect(s.get(id)).toBeDefined();
    expect(s.view(s.get(id)!).status).toBe('received');
    // It is on disk, so a restart finds it too.
    const file = JSON.parse(readFileSync((s as unknown as { file: string }).file, 'utf8')) as {
      entries: { id: string; state: string }[];
    };
    expect(file.entries.find((e) => e.id === id)?.state).toBe('received');
  });

  it('still has the entry for an upload that outlasts the days an unused link is kept', async () => {
    let t = 1_000;
    const s = fresh(() => t);
    const { token, id } = s.makeLink('local', { kind: 'voice' });
    let finish!: () => void;
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(wavHead);
        c.enqueue(Buffer.alloc(2000));
        finish = () => c.close();
      },
    });
    const upload = s.receive(token, slow);
    await until(() => (s as unknown as { busy: Set<string> }).busy.has(id));
    t += 30 * 60_000 + 24 * 3600_000 + 1;
    s.makeLink('local', { kind: 'voice' });
    finish();
    await expect(upload).resolves.toMatchObject({ id, status: 'received' });
    expect(s.get(id)).toBeDefined();
  });

  it('recognizes recordings by their first bytes', () => {
    const b = (hex: string) => Uint8Array.from(Buffer.from(hex.padEnd(32, '0'), 'hex'));
    const ascii = (s: string) => Uint8Array.from(Buffer.from(s.padEnd(16, '\0')));
    expect(sniffRecording(ascii('RIFF\0\0\0\0WAVE'), 'voice')).toBe('wav');
    expect(sniffRecording(b('1a45dfa3'), 'voice')).toBe('webm');
    expect(sniffRecording(b('1a45dfa3'), 'video')).toBe('webm');
    expect(sniffRecording(ascii('OggS'), 'voice')).toBe('ogg');
    expect(sniffRecording(ascii('fLaC'), 'voice')).toBe('flac');
    expect(sniffRecording(ascii('ID3'), 'voice')).toBe('mp3');
    expect(sniffRecording(ascii('\0\0\0\x18ftypisom'), 'video')).toBe('mp4');
    expect(sniffRecording(ascii('\0\0\0\x14ftypqt  '), 'video')).toBe('mov');
    expect(sniffVideo(ascii('\0\0\0\x14ftypM4A '))).toBe('mp4');
    // A wav is not a video; a PNG, text and HTML are neither.
    expect(sniffRecording(ascii('RIFF\0\0\0\0WAVE'), 'video')).toBeNull();
    for (const x of [b('89504e470d0a1a0a'), ascii('<html>'), ascii('MZ'), ascii('')])
      for (const k of ['voice', 'video', 'auto'] as const) expect(sniffRecording(x, k)).toBeNull();
  });

  it('keeps a person’s links to a limit, dropping the oldest', () => {
    const s = fresh(() => 1);
    const first = s.makeLink('local', { kind: 'voice' });
    for (let i = 0; i < 25; i++) s.makeLink('local', { kind: 'voice' });
    expect(s.gate(first.token)).toBe('unknown');
    const other = s.makeLink('someone-else', { kind: 'voice' });
    expect(s.gate(other.token)).toBe('ok');
  });
});

describe('what the logs hold', () => {
  it('has no link’s token in anything the server or its tools printed', () => {
    expect(tokens.length).toBeGreaterThan(15);
    const text = logged.join('\n');
    for (const t of tokens) expect(text).not.toContain(t);
  });
});
