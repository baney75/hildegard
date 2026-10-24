// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthState, HostState, NewInvite, PeopleResponse, Snapshot, Take } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import type { Exec } from '../src/host.ts';
import { SESSION } from '../src/people.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const PASS = 'a long and private passphrase';
/** Ada’s passphrase once she has changed it. */
const NEW = 'symphonia harmoniae caelestium';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
}

/** A stand-in `tailscale`: signed in as studio.tail1234.ts.net, doing whatever `serve` and `funnel` are told. */
function fakeTailscale() {
  const calls: string[][] = [];
  let fail: string | null = null;
  const run: Exec = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'status')
      return {
        ok: true,
        out: JSON.stringify({
          BackendState: 'Running',
          Self: {
            DNSName: 'studio.tail1234.ts.net.',
            TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
          },
        }),
      };
    if (args[0] === 'serve' && args[1] === 'status') return { ok: true, out: '{}' };
    if (fail) return { ok: false, out: fail };
    return { ok: true, out: '' };
  };
  return {
    run,
    calls,
    failWith: (out: string | null) => {
      fail = out;
    },
  };
}

let srv: Running;
let ts: ReturnType<typeof fakeTailscale>;
/** Requests through the link, as Tailscale Serve forwards them: nothing there is this computer. */
let remote: string;

const here = (path: string, init: RequestInit = {}) => fetch(srv.url + path, init);
const there = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  fetch(remote + path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(init.cookie ? { cookie: init.cookie } : {}) },
  });
const send = (path: string, method: string, body: unknown, cookie?: string, base = remote) =>
  fetch(base + path, {
    method,
    headers: { ...H, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
/** The session cookie a response set, ready to send back. */
const cookieFrom = (res: Response) => {
  const c = res.headers.getSetCookie().find((x) => /^(__Host-hildegard|hildegard_session)=[^;]+/.test(x));
  return c?.split(';')[0];
};
const signIn = async (name: string, passphrase = PASS) => {
  const res = await send('/api/auth/signin', 'POST', { name, passphrase });
  expect(res.status, `sign in as ${name}`).toBe(200);
  return cookieFrom(res)!;
};
const request = (prompt: string) => ({
  prompt,
  rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
  format: { quality: 'draft', seconds: 3 },
});

let owner: string;
/** The owner signed in on another device too. */
let secondDevice: string;
let director: string;
let directorId: string;

beforeAll(async () => {
  ts = fakeTailscale();
  const hostPort = await freePort();
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-host-'))]), port: 0, hostPort },
    { fakeTickMs: 25, secrets: memoryStore(), exec: ts.run, limits: { perName: 4, perClient: 1000 } },
  );
  remote = srv.hostedUrl()!;
  await until(() => srv.scheduler.engineState().online);
}, 30_000);
afterAll(() => srv.close());

describe('before anyone signs in', () => {
  it('keeps everything but the Studio’s sign-in behind a session', async () => {
    expect((await there('/api/health')).status).toBe(200);
    const me = (await (await there('/api/auth/me')).json()) as AuthState;
    expect(me).toEqual({ local: false, person: null, owner: false });
    for (const p of [
      '/api/snapshot',
      '/api/events',
      '/api/catalog',
      '/api/people',
      '/api/host',
      '/media/x.mp4',
    ])
      expect((await there(p)).status, p).toBe(401);
    expect((await send('/api/projects', 'POST', {})).status).toBe(401);
    expect((await send('/api/models/wan-2-2-ti2v-5b/install', 'POST', { acceptLicense: true })).status).toBe(
      401,
    );
  });

  it('leaves this computer exactly as it was: no sign-in, every power', async () => {
    expect((await (await here('/api/auth/me')).json()) as AuthState).toMatchObject({
      local: true,
      person: null,
    });
    expect((await here('/api/snapshot')).status).toBe(200);
    expect((await send('/api/projects', 'POST', {}, undefined, srv.url)).status).toBe(201);
  });

  it('treats anything a proxy forwarded as coming from elsewhere, even on loopback', async () => {
    for (const h of ['x-forwarded-for', 'forwarded', 'tailscale-user-login'])
      expect((await here('/api/snapshot', { headers: { [h]: '100.64.0.9' } })).status, h).toBe(401);
  });

  it('never puts the paired-device API behind the link', async () => {
    expect((await there('/api/node/info', { headers: { authorization: 'Bearer x' } })).status).toBe(404);
  });

  it('makes the owner account only on this computer', async () => {
    expect((await send('/api/people/owner', 'POST', { name: 'Donovan', passphrase: PASS })).status).toBe(401);
    const short = await send(
      '/api/people/owner',
      'POST',
      { name: 'Donovan', passphrase: 'short' },
      undefined,
      srv.url,
    );
    expect(short.status).toBe(400);
    const res = await send(
      '/api/people/owner',
      'POST',
      { name: 'Donovan', passphrase: PASS },
      undefined,
      srv.url,
    );
    expect(res.status).toBe(201);
    expect(((await (await there('/api/auth/me')).json()) as AuthState).owner).toBe(true);
  });
});

describe('signing in', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie, Secure over HTTPS', async () => {
    const res = await send('/api/auth/signin', 'POST', { name: 'donovan', passphrase: PASS });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().join('\n');
    expect(set).toMatch(
      /^hildegard_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/m,
    );
    expect(set).not.toMatch(/Secure/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    owner = cookieFrom(res)!;
    const me = (await (await there('/api/auth/me', { cookie: owner })).json()) as AuthState;
    expect(me.person).toMatchObject({ name: 'Donovan', role: 'owner' });

    const https = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: { ...H, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ name: 'Donovan', passphrase: PASS }),
    });
    expect(https.headers.getSetCookie().join('\n')).toMatch(
      /^__Host-hildegard=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/m,
    );
    secondDevice = cookieFrom(https)!;
  });

  it('says nothing about which half was wrong, and slows down guessing', async () => {
    const wrong = () =>
      send('/api/auth/signin', 'POST', { name: 'Donovan', passphrase: 'not the passphrase' });
    const unknown = await send('/api/auth/signin', 'POST', { name: 'Nobody', passphrase: PASS });
    expect(unknown.status).toBe(401);
    const bad = await wrong();
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual(await unknown.json());
    // Four failures for one account in 15 minutes, then it waits, even with the right passphrase.
    await wrong();
    await wrong();
    await wrong();
    const blocked = await send('/api/auth/signin', 'POST', { name: 'Donovan', passphrase: PASS });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // A session already signed in is not affected.
    expect((await there('/api/snapshot', { cookie: owner })).status).toBe(200);
  });

  it('refuses sign-in posts from other sites, as every write', async () => {
    const res = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Donovan', passphrase: PASS }),
    });
    expect(res.status).toBe(403);
    const cross = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: { ...H, origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'Donovan', passphrase: PASS }),
    });
    expect(cross.status).toBe(403);
  });
});

describe('invites and roles', () => {
  it('invites a director with a link that works once', async () => {
    const res = await send('/api/people/invites', 'POST', { role: 'director' }, owner);
    expect(res.status).toBe(201);
    const { url, invite } = (await res.json()) as NewInvite;
    expect(invite.role).toBe('director');
    const token = url.split('#/invite/')[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await (await there(`/api/auth/invite/${token}`)).json()).toMatchObject({ role: 'director' });

    const accepted = await send(`/api/auth/invite/${token}/accept`, 'POST', {
      name: 'Ada',
      passphrase: PASS,
    });
    expect(accepted.status).toBe(201);
    director = cookieFrom(accepted)!;
    const me = (await accepted.json()) as AuthState;
    directorId = me.person!.id;
    expect(me.person).toMatchObject({ name: 'Ada', role: 'director' });

    const again = await send(`/api/auth/invite/${token}/accept`, 'POST', { name: 'Eve', passphrase: PASS });
    expect(again.status).toBe(404);
    expect((await there(`/api/auth/invite/${token}`)).status).toBe(404);
    const list = (await (await there('/api/people', { cookie: owner })).json()) as PeopleResponse;
    expect(list.people.map((p) => [p.name, p.role])).toEqual([
      ['Donovan', 'owner'],
      ['Ada', 'director'],
    ]);
    expect(list.invites).toEqual([]);
  });

  it('never lets a director touch models, devices, settings, people or the computer', async () => {
    const tries: Array<[string, string, unknown?]> = [
      ['POST', '/api/models/wan-2-2-ti2v-5b/install', { acceptLicense: true }],
      ['POST', '/api/models/wan-2-2-ti2v-5b/cancel'],
      ['POST', '/api/choir/use', { name: 'local' }],
      ['POST', '/api/choir/invite', {}],
      ['POST', '/api/hf/token', { token: 'hf_xxxxxxxxxxxxxxxxxxxxxxxx' }],
      ['POST', '/api/hf/unlink'],
      ['POST', '/api/hf/import'],
      ['POST', '/api/engine/pause'],
      ['POST', '/api/people/invites', { role: 'owner' }],
      ['PATCH', `/api/people/${directorId}`, { role: 'owner' }],
      ['POST', '/api/host', {}],
      ['POST', '/api/system/stop'],
      ['POST', '/api/agents/cursor/connect'],
    ];
    for (const [method, path, body] of tries)
      expect((await send(path, method, body, director)).status, `${method} ${path}`).toBe(403);
    for (const p of ['/api/people', '/api/host', '/api/agents', '/api/hf', '/api/choir'])
      expect((await there(p, { cookie: director })).status, p).toBe(403);
  });

  it('keeps each director’s films to themselves and the owner, and names whose take is whose', async () => {
    const mine = await send(
      '/api/shots',
      'POST',
      { request: request('A heron lifts off the marsh') },
      director,
    );
    expect(mine.status).toBe(201);
    const { project, shot, takes } = (await mine.json()) as {
      project: { id: string; owner?: string };
      shot: { id: string };
      takes: Take[];
    };
    expect(project.owner).toBe(directorId);
    expect(takes[0]!.by).toEqual({ id: directorId, name: 'Ada' });

    const theirs = await send('/api/shots', 'POST', { request: request('The owner’s own shot') }, owner);
    const o = (await theirs.json()) as { project: { id: string }; shot: { id: string }; takes: Take[] };
    expect(o.takes[0]!.by).toMatchObject({ name: 'Donovan' });

    const snap = (await (await there('/api/snapshot', { cookie: director })).json()) as Snapshot;
    expect(snap.projects.map((p) => p.id)).toEqual([project.id]);
    expect(snap.takes.every((t) => t.projectId === project.id)).toBe(true);
    expect(snap.engine.url).toBe('');
    const all = (await (await there('/api/snapshot', { cookie: owner })).json()) as Snapshot;
    expect(all.projects.map((p) => p.id)).toEqual(expect.arrayContaining([project.id, o.project.id]));

    // Someone else's film, shot and take don't exist, as far as a director can tell.
    expect((await there(`/api/shots/${o.shot.id}`, { cookie: director })).status).toBe(404);
    expect(
      (await send(`/api/projects/${o.project.id}`, 'PATCH', { title: 'Mine now' }, director)).status,
    ).toBe(404);
    expect((await send(`/api/projects/${o.project.id}/export`, 'POST', {}, director)).status).toBe(404);
    expect(
      (await send('/api/shots', 'POST', { projectId: o.project.id, request: request('x') }, director)).status,
    ).toBe(404);
    expect(
      (await send('/api/shots', 'POST', { shotId: o.shot.id, request: request('x') }, director)).status,
    ).toBe(404);
    expect((await send(`/api/takes/${o.takes[0]!.id}/cancel`, 'POST', {}, director)).status).toBe(404);
    expect((await send(`/api/takes/${o.takes[0]!.id}`, 'DELETE', undefined, director)).status).toBe(404);
    expect((await send(`/api/shots/${o.shot.id}`, 'DELETE', undefined, director)).status).toBe(404);

    await until(() => [takes[0]!, o.takes[0]!].every((t) => srv.store.takes.get(t.id)?.status === 'done'));
    expect((await there(`/media/${o.takes[0]!.id}.mp4`, { cookie: director })).status).toBe(404);
    expect((await there(`/media/${o.takes[0]!.id}.jpg`, { cookie: director })).status).toBe(404);
    expect((await there(`/media/${takes[0]!.id}.mp4`, { cookie: director })).status).toBe(200);
    expect((await there(`/media/${o.takes[0]!.id}.mp4`, { cookie: owner })).status).toBe(200);
    // Paths on the host computer are for agents on it, never for people elsewhere.
    const got = (await (await there(`/api/shots/${shot.id}`, { cookie: director })).json()) as {
      files: Record<string, string>;
    };
    expect(got.files).toEqual({});
  });

  it('streams a director only their own takes', async () => {
    const ac = new AbortController();
    const res = await there('/api/events', { cookie: director, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await send('/api/shots', 'POST', { request: request('Owner only, again') }, owner);
    const mine = (await (
      await send('/api/shots', 'POST', { request: request('Ada’s second') }, director)
    ).json()) as {
      takes: Take[];
    };
    let text = '';
    await until(async () => {
      text += new TextDecoder().decode((await reader.read()).value);
      return text.includes(`"id":"${mine.takes[0]!.id}"`) && text.includes('"status":"done"');
    });
    ac.abort();
    expect(text).not.toContain('Owner only, again');
    expect(text).not.toContain('The owner’s own shot');
  });

  it('lets the owner change a role, and refuses to leave no owner', async () => {
    const r = await send(`/api/people/${directorId}`, 'PATCH', { role: 'owner' }, owner);
    expect(r.status).toBe(200);
    expect((await there('/api/people', { cookie: director })).status).toBe(200);
    expect((await send(`/api/people/${directorId}`, 'PATCH', { role: 'director' }, owner)).status).toBe(200);
    expect((await there('/api/people', { cookie: director })).status).toBe(403);
    const list = (await (await here('/api/people')).json()) as PeopleResponse;
    const me = list.people.find((p) => p.name === 'Donovan')!;
    expect((await send(`/api/people/${me.id}`, 'DELETE', undefined, owner)).status).toBe(409);
  });

  it('cancels an invite before it is used', async () => {
    const { url, invite } = (await (
      await send('/api/people/invites', 'POST', { role: 'owner' }, owner)
    ).json()) as NewInvite;
    expect((await send(`/api/people/invites/${invite.id}`, 'DELETE', undefined, owner)).status).toBe(200);
    const token = url.split('#/invite/')[1]!;
    expect((await there(`/api/auth/invite/${token}`)).status).toBe(404);
    expect((await send('/api/people/invites', 'POST', { role: 'director', hours: 0 }, owner)).status).toBe(
      400,
    );
  });
});

describe('a director’s waiting takes', () => {
  const shot = async (cookie: string | undefined, takes = 1, base = remote) =>
    send('/api/shots', 'POST', { request: { ...request('A lantern in the reeds'), takes } }, cookie, base);

  it('lets only the owner change the limit, within 1 to 100', async () => {
    expect(
      ((await (await there('/api/people', { cookie: owner })).json()) as PeopleResponse).directorQueue,
    ).toBe(3);
    expect((await send('/api/people/settings', 'PATCH', { directorQueue: 5 }, director)).status).toBe(403);
    for (const bad of [0, 101, 1.5, '3'])
      expect(
        (await send('/api/people/settings', 'PATCH', { directorQueue: bad }, owner)).status,
        `${bad}`,
      ).toBe(400);
    const res = await send('/api/people/settings', 'PATCH', { directorQueue: 2 }, owner);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PeopleResponse).directorQueue).toBe(2);
  });

  it('stops a director at the limit with a clear message; owners and this computer have none', async () => {
    const settled = () =>
      [...srv.store.takes.values()].every((t) => t.status !== 'queued' && t.status !== 'running');
    await until(settled);
    // Paused, nothing finishes, so everything asked for stays waiting.
    expect((await send('/api/engine/pause', 'POST', {}, undefined, srv.url)).status).toBe(200);
    try {
      const greedy = await shot(director, 4);
      expect(greedy.status).toBe(429);
      expect(((await greedy.json()) as { error: string }).error).toBe(
        'You can have 2 takes waiting at once here. Ask for up to 2 at a time.',
      );
      const first = await shot(director);
      expect(first.status).toBe(201);
      const firstTake = ((await first.json()) as { takes: Take[] }).takes[0]!;

      const many = await shot(director, 2);
      expect(many.status).toBe(429);
      expect(await many.json()).toEqual({
        error:
          'You can have 2 takes waiting at once here, and you have 1. Ask for one more take, or wait for one to finish.',
        code: 'queue',
      });
      expect((await shot(director)).status).toBe(201);
      const full = await shot(director);
      expect(full.status).toBe(429);
      expect(((await full.json()) as { error: string }).error).toBe(
        'You can have 2 takes waiting at once here, and you have 2. Wait for one to finish, or cancel one.',
      );

      // Owners, signed in or at this computer, aren't counted or stopped.
      for (let i = 0; i < 3; i++) expect((await shot(owner, 2)).status).toBe(201);
      expect((await shot(undefined, 4, srv.url)).status).toBe(201);
      expect((await shot(director)).status).toBe(429);

      // Canceling one makes room; retrying a canceled take counts as asking again.
      expect((await send(`/api/takes/${firstTake.id}/cancel`, 'POST', {}, director)).status).toBe(200);
      expect((await shot(director)).status).toBe(201);
      const retry = await send(`/api/takes/${firstTake.id}/retry`, 'POST', {}, director);
      expect(retry.status).toBe(429);
      expect(((await retry.json()) as { code: string }).code).toBe('queue');
    } finally {
      await send('/api/people/settings', 'PATCH', { directorQueue: 3 }, owner);
      await send('/api/engine/resume', 'POST', {}, undefined, srv.url);
    }
    await until(settled, 60_000);
  }, 90_000);
});

describe('changing your own passphrase', () => {
  it('needs the current one, and ends every other session of yours but not this one', async () => {
    const laptop = await signIn('Ada');
    const phone = await signIn('Ada');
    const wrong = await send(
      '/api/auth/passphrase',
      'POST',
      { current: 'not my passphrase', next: NEW },
      laptop,
    );
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: 'That isn’t your current passphrase.' });
    expect(
      (await send('/api/auth/passphrase', 'POST', { current: PASS, next: 'short' }, laptop)).status,
    ).toBe(400);
    expect((await send('/api/auth/passphrase', 'POST', { current: PASS }, laptop)).status).toBe(400);
    expect((await there('/api/snapshot', { cookie: phone })).status).toBe(200);

    const ok = await send('/api/auth/passphrase', 'POST', { current: PASS, next: NEW }, laptop);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(((await ok.json()) as AuthState).person).toMatchObject({ name: 'Ada', role: 'director' });
    expect((await there('/api/snapshot', { cookie: laptop })).status).toBe(200);
    for (const c of [phone, director]) expect((await there('/api/snapshot', { cookie: c })).status).toBe(401);
    // The owner's sessions are their own.
    expect((await there('/api/snapshot', { cookie: owner })).status).toBe(200);
    expect((await send('/api/auth/signin', 'POST', { name: 'Ada', passphrase: PASS })).status).toBe(401);
    director = await signIn('Ada', NEW);
  });

  it('is for people who signed in; this computer has none of its own', async () => {
    const res = await send('/api/auth/passphrase', 'POST', { current: PASS, next: NEW }, undefined, srv.url);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/hildegard host owner/);
    expect((await send('/api/auth/passphrase', 'POST', { current: PASS, next: NEW })).status).toBe(401);
  });
});

describe('signing out and removing people', () => {
  it('signs out: the cookie is cleared and the session is gone', async () => {
    const extra = secondDevice;
    expect((await there('/api/snapshot', { cookie: extra })).status).toBe(200);
    const res = await send('/api/auth/signout', 'POST', {}, extra);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join('\n')).toMatch(/hildegard_session=; Max-Age=0/);
    expect((await there('/api/snapshot', { cookie: extra })).status).toBe(401);
    expect((await there('/api/snapshot', { cookie: owner })).status).toBe(200);
  });

  it('removes a director: every session ends, open streams too', async () => {
    const second = await signIn('Ada', NEW);
    const ac = new AbortController();
    const stream = await there('/api/events', { cookie: second, signal: ac.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    expect((await send(`/api/people/${directorId}`, 'DELETE', undefined, owner)).status).toBe(200);
    // The stream ends on its own.
    let done = false;
    while (!done) done = (await reader.read()).done;
    for (const c of [director, second])
      expect((await there('/api/snapshot', { cookie: c })).status).toBe(401);
    expect((await send('/api/auth/signin', 'POST', { name: 'Ada', passphrase: NEW })).status).toBe(401);
    // Their films stay, for the owner.
    const snap = (await (await there('/api/snapshot', { cookie: owner })).json()) as Snapshot;
    expect(snap.projects.some((p) => p.owner === directorId)).toBe(true);
  });
});

describe('host mode', () => {
  it('turns the link on only from this computer', async () => {
    expect((await send('/api/host', 'POST', {}, owner)).status).toBe(403);
    expect((await send('/api/host/off', 'POST', {}, owner)).status).toBe(403);
    // The owner signed in elsewhere may look.
    expect((await there('/api/host', { cookie: owner })).status).toBe(200);
  });

  it('asks Tailscale Serve for HTTPS on the tailnet, and answers to the link’s name', async () => {
    // Through the link, the Host is the link's name: fetch can't send another Host, so this asks by hand.
    const { request: req } = await import('node:http');
    const asLink = () =>
      new Promise<number>((resolve) => {
        const u = new URL(`${remote}/api/auth/me`);
        req(
          { host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'studio.tail1234.ts.net' } },
          (r) => resolve(r.statusCode!),
        ).end();
      });
    expect(await asLink()).toBe(421);
    const res = await send('/api/host', 'POST', {}, undefined, srv.url);
    expect(res.status).toBe(200);
    const state = (await res.json()) as HostState;
    expect(state).toMatchObject({
      on: true,
      via: 'tailscale',
      url: 'https://studio.tail1234.ts.net',
      problem: null,
    });
    expect(ts.calls).toContainEqual(['serve', '--bg', '--https=443', remote]);
    expect(await asLink()).toBe(200);
    // An invite now points at the link.
    const { url } = (await (await send('/api/people/invites', 'POST', {}, owner)).json()) as NewInvite;
    expect(url).toMatch(/^https:\/\/studio\.tail1234\.ts\.net\/#\/invite\/[A-Za-z0-9_-]{43}$/);
  });

  it('goes on the public internet only when asked by name, and turns off cleanly', async () => {
    const res = await send('/api/host', 'POST', { via: 'funnel' }, undefined, srv.url);
    expect(res.status).toBe(200);
    expect(ts.calls).toContainEqual(['serve', '--https=443', 'off']);
    expect(ts.calls).toContainEqual(['funnel', '--bg', '--https=443', remote]);
    expect(((await res.json()) as HostState).via).toBe('funnel');
    const off = (await (await send('/api/host/off', 'POST', {}, undefined, srv.url)).json()) as HostState;
    expect(off).toMatchObject({ on: false, url: null });
    expect(ts.calls).toContainEqual(['funnel', '--https=443', 'off']);
  });

  it('says what the owner must do when Tailscale refuses', async () => {
    ts.failWith(
      'Access denied: serve config denied\nUse sudo tailscale serve, or tailscale set --operator=$USER',
    );
    let res = await send('/api/host', 'POST', {}, undefined, srv.url);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fix: expect.stringContaining('--operator=$USER') });
    ts.failWith(
      'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/serve?node=abc\n',
    );
    res = await send('/api/host', 'POST', {}, undefined, srv.url);
    expect(await res.json()).toMatchObject({ fix: 'https://login.tailscale.com/f/serve?node=abc' });
    ts.failWith(null);
  });

  it('answers over plain HTTP only on a Tailscale address', async () => {
    for (const address of ['0.0.0.0', '192.168.1.20', '8.8.8.8', '127.0.0.1']) {
      const res = await send('/api/host', 'POST', { via: 'address', address }, undefined, srv.url);
      expect(res.status, address).toBe(400);
    }
  });
});

describe('session rotation', () => {
  it('sends the new token on any response, a streamed file included', async () => {
    const { takes } = (await (
      await send('/api/shots', 'POST', { request: request('Rotation') }, owner)
    ).json()) as {
      takes: Take[];
    };
    await until(() => srv.store.takes.get(takes[0]!.id)?.status === 'done');
    const saved = SESSION.rotateMs;
    SESSION.rotateMs = 0;
    try {
      const res = await there(`/media/${takes[0]!.id}.jpg`, { cookie: owner });
      expect(res.status).toBe(200);
      const next = cookieFrom(res);
      expect(next).toMatch(/^hildegard_session=[A-Za-z0-9_-]{43}$/);
      expect(next).not.toBe(owner);
      owner = next!;
    } finally {
      SESSION.rotateMs = saved;
    }
    expect((await there('/api/snapshot', { cookie: owner })).status).toBe(200);
  });
});
