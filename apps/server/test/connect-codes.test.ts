// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectCode, GrantsResponse, NewInvite, PeopleResponse } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE_LIMITS, CODE_RE, CODE_TTL_MS, hashCode } from '../src/codes.ts';
import { parseArgs } from '../src/config.ts';
import { challengeOf } from '../src/grants.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const PASS = 'a long and private passphrase';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-0123456789';
const REDIRECT = 'https://chat.example/oauth/callback';
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

let srv: Running;
let remote: string;
let t = Date.now();
const running: Running[] = [];

async function start(limits = { perName: 50, perClient: 1000 }) {
  const hostPort = await freePort();
  const s = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-cc-'))]), port: 0, hostPort },
    {
      fakeTickMs: 20,
      secrets: memoryStore(),
      exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
      limits,
      now: () => t,
    },
  );
  running.push(s);
  expect(
    (
      await fetch(`${s.url}/api/people/owner`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
      })
    ).status,
  ).toBe(201);
  return s;
}

const local = (s: Running, path: string, method = 'POST', body?: unknown) =>
  fetch(s.url + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (base: string, path: string, init: RequestInit & { cookie?: string; xff?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      ...H,
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.xff ? { 'x-forwarded-for': init.xff } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
const signIn = async (base: string, name: string) => {
  const res = await at(base, '/api/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ name, passphrase: PASS }),
  });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
};

beforeAll(async () => {
  srv = await start();
  remote = srv.hostedUrl()!;
}, 30_000);
afterAll(async () => {
  for (const s of running) await s.close();
});

/** A chatbot's side: register, open the approval page, and (given a decision) post to it. */
async function chatbot(base: string) {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Chat Example', redirect_uris: [REDIRECT] }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const url = `${base}/oauth/authorize?${form({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challengeOf(VERIFIER),
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${base}/mcp`,
  })}`;
  const open = async () => {
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    return { html, request: /name="request" value="([^"]+)"/.exec(html)![1]! };
  };
  const post = (request: string, fields: Record<string, string>, xff?: string) =>
    fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { ...FORM, origin: base, ...(xff ? { 'x-forwarded-for': xff } : {}) },
      body: form({ request, decision: 'allow', ...fields }),
      redirect: 'manual',
    });
  const tokens = async (location: string) => {
    const code = new URL(location).searchParams.get('code')!;
    return fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: FORM,
      body: form({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: `${base}/mcp`,
      }),
    });
  };
  return { clientId, open, post, tokens };
}

describe('making a connect code', () => {
  it('is for owners: this computer and a signed-in owner, never a director or a stranger', async () => {
    const mine = await local(srv, '/api/auth/codes');
    expect(mine.status).toBe(201);
    const c = (await mine.json()) as ConnectCode;
    expect(c.code).toMatch(CODE_RE);
    expect(c.person.name).toBe('Ada');
    expect(Date.parse(c.expiresAt) - t).toBe(CODE_TTL_MS);
    // Only its hash is kept.
    const file = readFileSync(join(srv.config.dataDir, 'people', 'connect-codes.json'), 'utf8');
    expect(file).not.toContain(c.code);
    expect(file).toContain(hashCode(c.code));

    // A stranger through the link: no.
    expect((await at(remote, '/api/auth/codes', { method: 'POST' })).status).toBe(403);
    // The owner signed in through the link: yes, and the link’s address comes with it.
    const owner = await signIn(remote, 'Ada');
    const viaLink = await at(remote, '/api/auth/codes', { method: 'POST', cookie: owner });
    expect(viaLink.status).toBe(201);
    // A director: no.
    const inv = (await (
      await at(remote, '/api/people/invites', { method: 'POST', cookie: owner, body: '{}' })
    ).json()) as NewInvite;
    const token = inv.url.split('/#/invite/')[1]!;
    await at(remote, `/api/auth/invite/${token}/accept`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Hilde', passphrase: PASS }),
    });
    const hilde = await signIn(remote, 'Hilde');
    const denied = await at(remote, '/api/auth/codes', { method: 'POST', cookie: hilde });
    expect(denied.status).toBe(403);
  });
});

describe('approving a chatbot with a connect code', () => {
  it('offers a code beside the name and passphrase, and says to type only your own', async () => {
    const bot = await chatbot(remote);
    const { html } = await bot.open();
    expect(html).toContain('Sign in with your name and passphrase');
    expect(html).toContain('Use a connect code');
    expect(html).toContain('name="code"');
    expect(html).toMatch(/Only type a code you made yourself for this connection/);
  });

  it('approves as the owner who made it, once, and the grant says so', async () => {
    const minted = (await (await local(srv, '/api/auth/codes')).json()) as ConnectCode;
    const bot = await chatbot(remote);
    const { request } = await bot.open();
    const ok = await bot.post(request, { code: minted.code.toLowerCase() });
    expect(ok.status).toBe(303);
    const back = new URL(ok.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    const tok = await bot.tokens(ok.headers.get('location')!);
    expect(tok.status).toBe(200);
    const access = ((await tok.json()) as { access_token: string }).access_token;
    expect(access).toMatch(/^hga_/);
    const grants = (await (await local(srv, '/api/auth/grants', 'GET')).json()) as GrantsResponse;
    const mine = grants.grants.find((g) => g.kind === 'chatbot' && g.name === 'Chat Example');
    expect(mine).toMatchObject({ person: { name: 'Ada' }, approval: 'code' });
    // The same code does nothing a second time: the page says so and the request stays open for another try.
    const bot2 = await chatbot(remote);
    const again = await bot2.open();
    const reused = await bot2.post(again.request, { code: minted.code });
    expect(reused.status).toBe(401);
    expect(await reused.text()).toMatch(/isn’t good/);
    // A passphrase still works on that same request, and says it came by passphrase.
    const viaPass = await bot2.post(again.request, { name: 'Ada', passphrase: PASS });
    expect(viaPass.status).toBe(303);
    expect((await bot2.tokens(viaPass.headers.get('location')!)).status).toBe(200);
    const g2 = (await (await local(srv, '/api/auth/grants', 'GET')).json()) as GrantsResponse;
    expect(g2.grants.find((g) => g.kind === 'chatbot')?.approval).toBe('passphrase');
  });

  it('refuses a wrong, malformed or expired code', async () => {
    const bot = await chatbot(remote);
    const { request } = await bot.open();
    for (const code of ['HG-0000-0000', 'nonsense', 'hgc1_abcdefgh', 'HG-ZZZZ-ZZZZ']) {
      const r = await bot.post(request, { code });
      expect(r.status, code).toBe(401);
      expect(r.headers.get('location')).toBeNull();
    }
    // Expired: made, then left past its ten minutes while the request waits.
    const minted = (await (await local(srv, '/api/auth/codes')).json()) as ConnectCode;
    t += 6 * 60_000;
    const late = await chatbot(remote);
    const lateReq = await late.open();
    t += 5 * 60_000;
    const expired = await late.post(lateReq.request, { code: minted.code });
    expect(expired.status).toBe(401);
    expect(await expired.text()).toMatch(/isn’t good/);
  });

  it('refuses a code whose maker is no longer an owner', async () => {
    const adaCookie = await signIn(remote, 'Ada');
    const inv = (await (
      await at(remote, '/api/people/invites', {
        method: 'POST',
        cookie: adaCookie,
        body: JSON.stringify({ role: 'owner' }),
      })
    ).json()) as NewInvite;
    await at(remote, `/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Bob', passphrase: PASS }),
    });
    const bobCookie = await signIn(remote, 'Bob');
    const minted = (await (
      await at(remote, '/api/auth/codes', { method: 'POST', cookie: bobCookie })
    ).json()) as ConnectCode;
    expect(minted.person.name).toBe('Bob');
    // A code made by a second owner approves as that owner.
    const second = (await (
      await at(remote, '/api/auth/codes', { method: 'POST', cookie: bobCookie })
    ).json()) as ConnectCode;
    const bot = await chatbot(remote);
    const open = await bot.open();
    const approved = await bot.post(open.request, { code: second.code });
    expect(approved.status).toBe(303);
    expect((await bot.tokens(approved.headers.get('location')!)).status).toBe(200);
    expect(
      ((await (await local(srv, '/api/auth/grants', 'GET')).json()) as GrantsResponse).grants[0]?.person.name,
    ).toBe('Bob');
    // Demoted before the code is used: nothing to approve as.
    const people = (await (await at(remote, '/api/people', { cookie: adaCookie })).json()) as PeopleResponse;
    const bob = people.people.find((p) => p.name === 'Bob')!;
    expect(
      (
        await at(remote, `/api/people/${bob.id}`, {
          method: 'PATCH',
          cookie: adaCookie,
          body: JSON.stringify({ role: 'director' }),
        })
      ).status,
    ).toBe(200);
    const bot2 = await chatbot(remote);
    const open2 = await bot2.open();
    const refused = await bot2.post(open2.request, { code: minted.code });
    expect(refused.status).toBe(401);
  });
});

describe('wrong connect codes and the limits', () => {
  it('count with wrong passphrases for the same address', async () => {
    const s = await start({ perName: 50, perClient: 3 });
    const base = s.hostedUrl()!;
    const bot = await chatbot(base);
    const { request } = await bot.open();
    const from = '203.0.113.7';
    // Two wrong passphrases and one wrong code: that address has used its three.
    expect((await bot.post(request, { name: 'Ada', passphrase: 'wrong wrong wrong' }, from)).status).toBe(
      401,
    );
    expect((await bot.post(request, { name: 'Ada', passphrase: 'wrong wrong wrong' }, from)).status).toBe(
      401,
    );
    expect((await bot.post(request, { code: 'HG-0000-0000' }, from)).status).toBe(401);
    const minted = (await (await local(s, '/api/auth/codes')).json()) as ConnectCode;
    // Now even a valid code from that address waits...
    const blocked = await bot.post(request, { code: minted.code }, from);
    expect(blocked.status).toBe(401);
    expect(await blocked.text()).toMatch(/Too many tries/);
    // ...while another address, with the same code, is fine: the code wasn’t spent by the refusal.
    const fine = await bot.post(request, { code: minted.code }, '198.51.100.2');
    expect(fine.status).toBe(303);
  });

  it('hold back only an address that already missed once, after the global cap, until the window passes', async () => {
    const s = await start({ perName: 50, perClient: 10_000 });
    const base = s.hostedUrl()!;
    const bot = await chatbot(base);
    const { request } = await bot.open();
    for (let i = 0; i < CODE_LIMITS.global; i++)
      await bot.post(request, { code: 'HG-0000-0000' }, `10.1.${Math.floor(i / 200)}.${i % 200}`);
    // An address that never missed is not held back by other people's guessing, and its code works.
    const minted = (await (await local(s, '/api/auth/codes')).json()) as ConnectCode;
    const clean = await bot.post(request, { code: minted.code }, '192.0.2.250');
    expect(clean.status).toBe(303);
    // One that has missed once is: its next try, a valid code included, waits.
    const bot2 = await chatbot(base);
    const second = await bot2.open();
    const again = (await (await local(s, '/api/auth/codes')).json()) as ConnectCode;
    expect((await bot2.post(second.request, { code: 'HG-1111-1111' }, '192.0.2.240')).status).toBe(401);
    const blocked = await bot2.post(second.request, { code: again.code }, '192.0.2.240');
    expect(blocked.status).toBe(401);
    expect(await blocked.text()).toMatch(/Too many tries/);
    // The page still takes a passphrase: the cap is for codes only.
    const pass = await bot2.post(second.request, { name: 'Ada', passphrase: PASS }, '192.0.2.251');
    expect(pass.status).toBe(303);
  });
});

describe('who a connect code is for', () => {
  const addOwner = async (s: Running, name: string) => {
    const base = s.hostedUrl()!;
    const ada = await signIn(base, 'Ada');
    const inv = (await (
      await at(base, '/api/people/invites', {
        method: 'POST',
        cookie: ada,
        body: JSON.stringify({ role: 'owner' }),
      })
    ).json()) as NewInvite;
    await at(base, `/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
      method: 'POST',
      body: JSON.stringify({ name, passphrase: PASS }),
    });
  };

  it('with no session and several owners, asks whose it is and lists them', async () => {
    const s = await start();
    // One owner: this computer means them.
    expect(((await (await local(s, '/api/auth/codes')).json()) as ConnectCode).person.name).toBe('Ada');
    await addOwner(s, 'Bob');
    const unsure = await local(s, '/api/auth/codes');
    expect(unsure.status).toBe(409);
    const j = (await unsure.json()) as { error: string; owners: string[] };
    expect(j.owners.sort()).toEqual(['Ada', 'Bob']);
    expect(j.error).toContain('--as');
    const bob = await local(s, '/api/auth/codes', 'POST', { person: 'bob' });
    expect(bob.status).toBe(201);
    expect(((await bob.json()) as ConnectCode).person.name).toBe('Bob');
    expect((await local(s, '/api/auth/codes', 'POST', { person: 'Nobody' })).status).toBe(404);
  });
});

describe('connect codes that outlive what they were made for', () => {
  it('fail after their owner’s passphrase changes', async () => {
    const s = await start();
    const minted = (await (await local(s, '/api/auth/codes')).json()) as ConnectCode;
    const keep = (await (await local(s, '/api/auth/codes')).json()) as ConnectCode;
    const changed = await local(s, '/api/people/owner', 'POST', {
      name: 'Ada',
      passphrase: 'a different long private passphrase',
    });
    expect(changed.status).toBeLessThan(300);
    const base = s.hostedUrl()!;
    const bot = await chatbot(base);
    const { request } = await bot.open();
    for (const code of [minted.code, keep.code]) {
      const r = await bot.post(request, { code }, '198.51.100.9');
      expect(r.status).toBe(401);
      expect(await r.text()).toMatch(/isn’t good/);
    }
    // A code made after the change works.
    const fresh = (await (await local(s, '/api/auth/codes')).json()) as ConnectCode;
    expect((await bot.post(request, { code: fresh.code }, '198.51.100.10')).status).toBe(303);
  });
});
