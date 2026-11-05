// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintProse, type ProseLint } from '@hildegard/craft';
import type { NewInvite } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directorMay } from '../src/access.ts';
import { parseArgs } from '../src/config.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const PASS = 'a long and private passphrase';
const STOCK = 'We will delve into the realm of it — and it is robust.';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

let srv: Running;
let dir: string;
let remote: string;
const lint = (base: string, body: unknown, cookie?: string, raw = false) =>
  fetch(`${base}/api/writing/lint`, {
    method: 'POST',
    headers: { ...H, ...(cookie ? { cookie } : {}) },
    body: raw ? (body as string) : JSON.stringify(body),
  });
const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((x) => /^(__Host-hildegard|hildegard_session)=[^;]+/.test(x))
    ?.split(';')[0];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hg-writing-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hostPort: await freePort(), hfClientId: null },
    { fakeTickMs: 10, secrets: memoryStore(), hubToken: join(dir, 'no-hf-token') },
  );
  remote = srv.hostedUrl()!;
});
afterAll(() => srv.close());

describe('POST /api/writing/lint', () => {
  it('answers with the same lint the package gives', async () => {
    const res = await lint(srv.url, { text: STOCK });
    expect(res.status).toBe(200);
    const got = (await res.json()) as ProseLint;
    expect(got).toEqual(lintProse(STOCK));
    expect(got.ok).toBe(false);
    expect(got.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['stock-words', 'dashes']));
    expect(got.findings[0]!.matches[0]).toMatchObject({ line: 1, column: expect.any(Number) });
  });

  it('passes plain words', async () => {
    const got = (await (
      await lint(srv.url, { text: 'A plain sentence about a red barn.' })
    ).json()) as ProseLint;
    expect(got).toMatchObject({ ok: true, words: 7, findings: [] });
  });

  it('refuses a body that is not text, and text past the limit', async () => {
    for (const body of [{}, { text: 4 }, { text: null }, []])
      expect((await lint(srv.url, body)).status).toBe(400);
    expect((await lint(srv.url, '{nope', undefined, true)).status).toBe(400);
    expect((await lint(srv.url, { text: 'a'.repeat(200_001) })).status).toBe(400);
    expect((await lint(srv.url, { text: 'a '.repeat(100_000) })).status).toBe(200);
    expect((await lint(srv.url, { text: 'a'.repeat(2_100_000) })).status).toBe(413);
  });

  it('reads nothing and writes nothing', async () => {
    const before = readdirSync(dir).sort();
    await lint(srv.url, { text: STOCK });
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('is open to a signed-in director, and to no one who has not signed in', async () => {
    expect(directorMay('POST', '/api/writing/lint')).toBe(true);
    expect(directorMay('GET', '/api/writing/lint')).toBe(false);

    expect((await lint(remote, { text: STOCK })).status).toBe(401);

    expect(
      (
        await fetch(`${srv.url}/api/people/owner`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ name: 'Alex', passphrase: PASS }),
        })
      ).status,
    ).toBe(201);
    const signed = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Alex', passphrase: PASS }),
    });
    const owner = cookieFrom(signed)!;
    const invite = (await (
      await fetch(`${remote}/api/people/invites`, {
        method: 'POST',
        headers: { ...H, cookie: owner },
        body: JSON.stringify({ role: 'director' }),
      })
    ).json()) as NewInvite;
    const accepted = await fetch(`${remote}/api/auth/invite/${invite.url.split('#/invite/')[1]}/accept`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    const director = cookieFrom(accepted)!;

    const res = await lint(remote, { text: STOCK }, director);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(lintProse(STOCK));
  });
});
