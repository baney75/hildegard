// SPDX-License-Identifier: AGPL-3.0-only
// An interview by link: the link's sources, script and questions; each answer sent on Next; a follow-up from the agent;
// where it stands, for the person who made it only; chapters on the recording; the limits; and over the MCP.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewKey } from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { INTERVIEW_MINUTES, MAX_ASKED, RecordStore, tidyChapters } from '../src/record.ts';
import { type Running, startServer } from '../src/server.ts';
import { make } from './audio.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const RAW = { 'x-hildegard': '1', 'content-type': 'application/octet-stream' };
const PASS = 'a long and private passphrase';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const work = mkdtempSync(join(tmpdir(), 'hg-interview-'));
const dataDir = join(work, 'data');
const uiDir = join(work, 'ui');
let srv: Running;
let remote: string;
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
async function director(name: string): Promise<string> {
  const inv = (await (await local('/api/people/invites', 'POST', { role: 'director' })).json()) as {
    url: string;
  };
  await fetch(`${remote}/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name, passphrase: PASS }),
  });
  const res = await fetch(`${remote}/api/auth/signin`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name, passphrase: PASS }),
  });
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
}

type Link = { id: string; token: string; url: string; expiresAt: string };
async function link(body: Record<string, unknown>, who: string | null = null): Promise<Link> {
  const res = who
    ? await there(who, '/api/record/links', 'POST', body)
    : await local('/api/record/links', 'POST', body);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  const l = (await res.json()) as Link;
  tokens.push(l.token);
  return l;
}
/** The page, by token alone, through the link as another device reaches it. */
const page = (token: string) => fetch(`${remote}/api/record/${token}`);
const answer = (token: string, index: number, at: number, bytes: Uint8Array) =>
  fetch(`${remote}/api/record/${token}/answers?index=${index}&at=${at}`, {
    method: 'POST',
    headers: RAW,
    body: bytes,
  });
const send = (token: string, bytes: Uint8Array) =>
  fetch(`${remote}/api/record/${token}`, { method: 'POST', headers: RAW, body: bytes });
const speech = (name: string, seconds = 2, seed = 1) => {
  make('speech', join(work, name), String(seconds), String(seed));
  return readFileSync(join(work, name));
};
type Interview = {
  status: string;
  questions: string[];
  current: { index: number; question: string } | null;
  answers: {
    index: number;
    question: string;
    at: number;
    mediaId: string;
    url: string | null;
    file: string | null;
    transcript: string | null;
  }[];
  chapters: { at: number; title: string }[];
};

beforeAll(async () => {
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Studio</title><div id="root"></div>');
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  srv = await startServer(
    {
      ...parseArgs(['--fake-gpu', '--data', dataDir, '--ui', uiDir]),
      port: 0,
      hostPort: await freePort(),
    },
    {
      fakeTickMs: 20,
      secrets: memoryStore(),
      exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
      limits: { perName: 50, perClient: 1000 },
    },
  );
  remote = srv.hostedUrl()!;
  expect((await local('/api/people/owner', 'POST', { name: 'Ada', passphrase: PASS })).status).toBe(201);
}, 30_000);
afterAll(() => srv.close());

describe('a link with sources, a script and questions', () => {
  it('keeps what the agent asked for and shows it to the page, and nothing more', async () => {
    const l = await link({
      sources: ['screen+camera', 'camera'],
      script: 'Line one.\n\nLine two, after a pause.',
      questions: ['What are you making?', '  Who is it for?  '],
      purpose: 'A short interview',
    });
    const v = (await (await page(l.token)).json()) as Record<string, unknown>;
    expect(v).toMatchObject({
      kind: 'video',
      sources: ['screen+camera', 'camera'],
      script: 'Line one.\n\nLine two, after a pause.',
      questions: ['What are you making?', 'Who is it for?'],
      answered: 0,
      maxAnswerBytes: 100 * 1024 * 1024,
    });
    // An interview's link starts with an hour.
    const minutes = (Date.parse(l.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(INTERVIEW_MINUTES.start - 1);
    expect(minutes).toBeLessThanOrEqual(INTERVIEW_MINUTES.start);
    // A plain link is as it was.
    const plain = (await (await page((await link({ kind: 'voice' })).token)).json()) as Record<
      string,
      unknown
    >;
    expect(plain).toMatchObject({ kind: 'voice', sources: ['voice'], script: null, questions: [] });
  });

  it('refuses what one link can’t do, and what is too long', async () => {
    for (const [body, field] of [
      [{ sources: ['voice', 'camera'] }, 'sources'],
      [{ kind: 'voice', sources: ['camera'] }, 'sources'],
      [{ sources: ['radio'] }, undefined],
      [{ kind: 'video', script: 'x'.repeat(20_001) }, undefined],
      [{ kind: 'voice', questions: Array.from({ length: 31 }, (_, i) => `Q${i}`) }, undefined],
      [{ kind: 'voice', questions: ['x'.repeat(501)] }, undefined],
      [{}, 'kind'],
    ] as const) {
      const res = await local('/api/record/links', 'POST', body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      if (field === 'sources') expect(((await res.json()) as { code: string }).code).toBe('sources');
    }
  });
});

describe('an interview', () => {
  it('takes each answer on Next, a follow-up from the agent, and says where it stands', async () => {
    const l = await link({ sources: ['voice'], questions: ['What is your film about?', 'Who made it?'] });
    const status = async () => (await (await local(`/api/record/${l.id}/interview`)).json()) as Interview;
    expect((await status()).current).toEqual({ index: 0, question: 'What is your film about?' });

    // The first answer, by token alone, as sound of its own.
    const a0 = await answer(l.token, 0, 0, speech('a0.wav', 2, 1));
    expect(a0.status).toBe(200);
    expect(await a0.json()).toEqual({ received: true, index: 0 });
    // Out of order, again, or past the end: refused, and the link still works.
    expect((await answer(l.token, 0, 0, speech('a0b.wav'))).status).toBe(409);
    expect((await answer(l.token, 5, 0, speech('a5.wav'))).status).toBe(400);
    expect((await answer(l.token, 1, 0, Buffer.from('not a recording at all, just words'))).status).toBe(415);

    let s = await status();
    expect(s.current).toEqual({ index: 1, question: 'Who made it?' });
    expect(s.answers).toHaveLength(1);
    expect(s.answers[0]).toMatchObject({ index: 0, question: 'What is your film about?', at: 0 });
    expect(s.answers[0]!.mediaId).toMatch(/^rec_[0-9a-f]{16}$/);
    // The interviewer can hear it: this computer has its path, and the file opens.
    expect(s.answers[0]!.file).toMatch(/\.wav$/);
    expect((await local(s.answers[0]!.url!)).status).toBe(200);
    // An answer isn't listed with the person's recordings: the whole interview will be.
    const listed = (await (await local('/api/record')).json()) as { recordings: { id: string }[] };
    expect(listed.recordings.map((r) => r.id)).not.toContain(s.answers[0]!.mediaId);

    // A follow-up: the page sees it the next time it looks.
    const ask = await local(`/api/record/${l.id}/ask`, 'POST', { question: 'What surprised you?' });
    expect(ask.status).toBe(200);
    expect(await ask.json()).toMatchObject({
      index: 2,
      questions: expect.arrayContaining(['What surprised you?']),
    });
    expect(((await (await page(l.token)).json()) as { questions: string[] }).questions).toEqual([
      'What is your film about?',
      'Who made it?',
      'What surprised you?',
    ]);
    expect((await answer(l.token, 1, 12.5, speech('a1.wav', 2, 2))).status).toBe(200);
    expect((await answer(l.token, 2, 20.25, speech('a2.wav', 2, 3))).status).toBe(200);
    s = await status();
    expect(s.current).toBeNull();
    expect(s.answers.map((a) => a.at)).toEqual([0, 12.5, 20.25]);

    // The full recording at the end; with no chapters sent, each question is one where it was put.
    expect((await send(l.token, speech('full.wav', 6, 4))).status).toBe(200);
    s = await status();
    expect(s.status).toBe('received');
    expect(s.chapters).toEqual([
      { at: 0, title: 'What is your film about?' },
      { at: 12.5, title: 'Who made it?' },
      { at: 20.25, title: 'What surprised you?' },
    ]);
    const rec = (await (await local(`/api/record/${l.id}`)).json()) as {
      chapters: unknown[];
      interview: unknown;
    };
    expect(rec.chapters).toHaveLength(3);
    expect(rec.interview).toEqual({ questions: 3, answered: 3 });
    // Over: no more answers, no more questions, and the link is used.
    expect((await answer(l.token, 3, 0, speech('late.wav'))).status).toBe(409);
    expect((await local(`/api/record/${l.id}/ask`, 'POST', { question: 'One more?' })).status).toBe(409);
    expect((await send(l.token, speech('again.wav'))).status).toBe(409);
  }, 60_000);

  it('takes chapters the page sends before the recording, in order', async () => {
    const l = await link({ kind: 'voice', questions: ['One?'] });
    const ch = await fetch(`${remote}/api/record/${l.token}/chapters`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        chapters: [
          { at: 4.2, title: 'Second' },
          { at: 0, title: 'First\u0007' },
        ],
      }),
    });
    expect(ch.status).toBe(200);
    expect((await send(l.token, speech('ch.wav', 6))).status).toBe(200);
    const rec = (await (await local(`/api/record/${l.id}`)).json()) as { chapters: unknown[] };
    expect(rec.chapters).toEqual([
      { at: 0, title: 'First' },
      { at: 4.2, title: 'Second' },
    ]);
    expect(() => tidyChapters([{ at: -1, title: 'x' }])).toThrow();
    expect(() => tidyChapters([{ at: 1, title: '' }])).toThrow();
    expect(() => tidyChapters(Array.from({ length: 201 }, () => ({ at: 0, title: 'x' })))).toThrow();
  }, 30_000);

  it('puts chapters on a recording kept in the Studio, by its id', async () => {
    const kept = await fetch(`${srv.url}/api/record/imports?kind=voice`, {
      method: 'POST',
      headers: RAW,
      body: speech('kept.wav', 3),
    });
    const { id } = (await kept.json()) as { id: string };
    const res = await local(`/api/record/${id}/chapters`, 'POST', {
      chapters: [{ at: 1, title: 'The middle' }],
    });
    expect(res.status).toBe(200);
    expect(((await (await local(`/api/record/${id}`)).json()) as { chapters: unknown[] }).chapters).toEqual([
      { at: 1, title: 'The middle' },
    ]);
  });

  it('answers ask and status only to whoever made it: a token, nobody and someone else get nothing', async () => {
    const greta = await director('Greta');
    const hans = await director('Hans');
    const l = await link({ kind: 'voice', questions: ['Hello?'] }, greta);
    // Greta, signed in, may.
    expect((await there(greta, `/api/record/${l.id}/interview`)).status).toBe(200);
    expect((await there(greta, `/api/record/${l.id}/ask`, 'POST', { question: 'And then?' })).status).toBe(
      200,
    );
    // Nobody signed in: the id isn't enough.
    expect((await there(null, `/api/record/${l.id}/interview`)).status).toBe(401);
    expect((await there(null, `/api/record/${l.id}/ask`, 'POST', { question: 'x?' })).status).toBe(401);
    // The token, in place of the id, opens neither, signed in or not.
    for (const who of [null, greta]) {
      expect([401, 404]).toContain((await there(who, `/api/record/${l.token}/interview`)).status);
      expect([401, 404]).toContain(
        (await there(who, `/api/record/${l.token}/ask`, 'POST', { question: 'x?' })).status,
      );
    }
    // Hans: as if it didn't exist.
    expect((await there(hans, `/api/record/${l.id}/interview`)).status).toBe(404);
    expect((await there(hans, `/api/record/${l.id}/ask`, 'POST', { question: 'x?' })).status).toBe(404);
    // A plain link isn't an interview.
    const plain = await link({ kind: 'voice' }, greta);
    expect((await there(greta, `/api/record/${plain.id}/ask`, 'POST', { question: 'x?' })).status).toBe(409);
  }, 30_000);
});

describe('the store on its own: time and limits', () => {
  const stream = (b: Uint8Array) => new Response(b).body;
  const wav = (n: number) =>
    Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(n)]);
  const fresh = (now: () => number, extra: Partial<ConstructorParameters<typeof RecordStore>[0]> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'hg-istore-'));
    return new RecordStore({
      dataDir: join(root, 'data'),
      mediaDir: join(root, 'media'),
      now,
      probe: async () => ({ seconds: 1, audio: true, video: false }),
      ...extra,
    });
  };

  it('keeps an interview open 30 minutes past each answer or follow-up, never past 4 hours', async () => {
    let t = 10_000_000;
    const s = fresh(() => t);
    const qs = Array.from({ length: 30 }, (_, i) => `Question ${i + 1}?`);
    const { token, id, expiresAt } = s.makeLink('local', { kind: 'voice', questions: qs });
    expect(expiresAt - t).toBe(60 * 60_000);
    // 50 minutes in, an answer: the end moves to 30 minutes from then.
    t += 50 * 60_000;
    await s.answer(token, { index: 0, at: 0 }, stream(wav(2000)));
    expect(s.get(id)!.expiresAt).toBe(t + 30 * 60_000);
    // A follow-up does the same.
    t += 20 * 60_000;
    s.ask(id, 'And then?');
    expect(s.get(id)!.expiresAt).toBe(t + 30 * 60_000);
    // Answers every 25 minutes keep it open, until 4 hours from when it was made.
    for (let i = 1; i < 10; i++) {
      t += 25 * 60_000;
      if (s.gate(token) !== 'ok') break;
      await s.answer(token, { index: i, at: i * 60 }, stream(wav(2000)));
    }
    expect(s.get(id)!.expiresAt).toBeLessThanOrEqual(10_000_000 + 4 * 3600_000);
    t = 10_000_000 + 4 * 3600_000;
    expect(s.gate(token)).toBe('expired');
    // A plain link never moves.
    const plain = s.makeLink('local', { kind: 'voice' });
    expect(() => s.ask(plain.id, 'x?')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('holds at most 60 questions with follow-ups', () => {
    const s = fresh(() => 1);
    const { id } = s.makeLink('local', { kind: 'voice', questions: ['1?'] });
    for (let i = 1; i < MAX_ASKED; i++) s.ask(id, `${i}?`);
    expect(() => s.ask(id, 'One too many?')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('counts each answer against the size cap and the day’s bytes, but not the day’s number', async () => {
    const t = 50_000_000;
    const s = fresh(() => t, {
      maxBytes: { voice: 10_000 },
      imports: { perDay: 2, bytesPerDay: 20_000 },
    });
    const { token } = s.makeLink('local', { kind: 'voice', questions: ['A?', 'B?', 'C?', 'D?'] });
    // Over the size cap for sound: refused, and the question is still open.
    await expect(s.answer(token, { index: 0, at: 0 }, stream(wav(12_000)))).rejects.toMatchObject({
      status: 413,
    });
    await s.answer(token, { index: 0, at: 0 }, stream(wav(8000)));
    await s.answer(token, { index: 1, at: 5 }, stream(wav(8000)));
    // 16 kB of 20 kB used: the third would go past the day's bytes.
    await expect(s.answer(token, { index: 2, at: 9 }, stream(wav(8000)))).rejects.toMatchObject({
      status: 429,
      code: 'quota',
    });
    // Two answers aren't two of the day's imports, but their bytes count against an import.
    await expect(s.import('local', 'voice', stream(wav(2000)))).resolves.toBeTruthy();
    await expect(s.import('local', 'voice', stream(wav(8000)))).rejects.toMatchObject({ status: 429 });
  });
});

describe('over the MCP', () => {
  const textOf = (r: CallToolResult) =>
    r.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  const call = async (c: Client, name: string, args: Record<string, unknown>) =>
    (await c.callTool({ name, arguments: args })) as CallToolResult;
  async function mcpAt(base: string, token?: string) {
    const client = new Client({ name: 'test-chatbot', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
      }),
    );
    return client;
  }

  it('makes an interview link, adds a follow-up, and reports answers and chapters', async () => {
    const c = await mcpAt(srv.url);
    try {
      const made = await call(c, 'record_link', {
        sources: ['camera', 'screen+camera'],
        script: 'Say hello first.',
        questions: ['What are you building?', 'Why now?'],
        purpose: 'A short interview',
      });
      expect(made.isError).toBeFalsy();
      const text = textOf(made);
      expect(text).toMatch(/Link for a video with sound: (\S+)/);
      expect(text).toMatch(/interview of 2 questions/);
      expect(text).toMatch(/interview_status/);
      expect(text).toMatch(/answer each question and tap Next/);
      const url = /Link for a video with sound: (\S+)/.exec(text)![1]!;
      const token = url.split('/record/')[1]!;
      tokens.push(token);
      const id = /Recording id: (rec_[0-9a-f]{16})/.exec(text)![1]!;
      const v = (await (await page(token)).json()) as { sources: string[]; script: string };
      expect(v.sources).toEqual(['camera', 'screen+camera']);
      expect(v.script).toBe('Say hello first.');

      expect(textOf(await call(c, 'interview_status', { id }))).toMatch(
        /^In progress: on question 1 of 2: “What are you building\?”/,
      );
      expect((await answer(token, 0, 0, speech('m0.wav', 2, 7))).status).toBe(200);
      const st = textOf(await call(c, 'interview_status', { id }));
      expect(st).toMatch(/on question 2 of 2/);
      // Each answer: its transcript when Hildegard can make one, else its media id and what to do with it.
      expect(st).toMatch(
        /Answer 1 \(“What are you building\?”, at 0:00[^)]*\): (.+|transcribing; ask again shortly\. Media id rec_|no transcript .*Media id rec_[0-9a-f]{16}.*give it to transcribe)/,
      );

      const asked = await call(c, 'interview_ask', { id, question: 'What would you change?' });
      expect(asked.isError).toBeFalsy();
      expect(textOf(asked)).toMatch(/Added as question 3 of 3/);
      expect(((await (await page(token)).json()) as { questions: string[] }).questions).toHaveLength(3);
      // Someone else's id, or the token in its place: nothing.
      const wrong = await call(c, 'interview_ask', { id: token, question: 'x?' });
      expect(wrong.isError).toBe(true);

      await answer(token, 1, 8, speech('m1.wav', 2, 8));
      await answer(token, 2, 15, speech('m2.wav', 2, 9));
      make('video', join(work, 'iv.mp4'), '4');
      const full = readFileSync(join(work, 'iv.mp4'));
      expect((await send(token, full)).status).toBe(200);
      const got = textOf(await call(c, 'recording_status', { id }));
      expect(got).toMatch(/^Received/);
      expect(got).toContain(
        'Chapters:\n- 0:00 What are you building?\n- 0:08 Why now?\n- 0:15 What would you change?',
      );
      expect(textOf(await call(c, 'interview_status', { id }))).toMatch(
        /^Received: the full recording arrived/,
      );
    } finally {
      await c.close();
    }
  }, 60_000);

  it('an agent signed in as one person can’t follow another’s interview', async () => {
    await director('Ida');
    const res = await local('/api/auth/keys', 'POST', { name: 'Ida’s agent', person: 'Ida' });
    expect(res.status).toBe(201);
    const key: string | null = ((await res.json()) as NewKey).key;
    const owner = await mcpAt(srv.url);
    try {
      const made = textOf(await call(owner, 'record_link', { kind: 'voice', questions: ['Ready?'] }));
      const id = /Recording id: (rec_[0-9a-f]{16})/.exec(made)![1]!;
      tokens.push(/record\/([A-Za-z0-9_-]{43})/.exec(made)![1]!);
      if (key) {
        const ida = await mcpAt(remote, key);
        try {
          const r = await call(ida, 'interview_status', { id });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toMatch(/No such recording/);
        } finally {
          await ida.close();
        }
      }
    } finally {
      await owner.close();
    }
  }, 30_000);
});

describe('what the logs hold', () => {
  it('has no link’s token in anything the server or its tools printed', () => {
    expect(tokens.length).toBeGreaterThan(6);
    const text = logged.join('\n');
    for (const t of tokens) expect(text).not.toContain(t);
  });
});
