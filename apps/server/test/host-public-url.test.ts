// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostState } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import type { Exec } from '../src/host.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const PASS = 'a long and private passphrase';
const DOOR = 'https://hildegard.example.com';

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

/** A stand-in `tailscale` that records every call, so the tests can prove `serve` and `funnel` are never made. */
const calls: string[][] = [];
const tailscale: Exec = async (_cmd, args) => {
  calls.push(args);
  if (args[0] === 'status')
    return {
      ok: true,
      out: JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] },
      }),
    };
  if (args[0] === 'serve' && args[1] === 'status') return { ok: true, out: '{}' };
  return { ok: true, out: '' };
};

let srv: Running;
let hosted: string;

/**
 * A request with its own Host header, as a tunnel or proxy forwards it (fetch can't set Host). `base` is the listener
 * to send it to: the hosted one by default.
 */
function asHost(
  host: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; base?: string } = {},
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const u = new URL(`${opts.base ?? hosted}${path}`);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: { host, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
const local = (path: string, body?: unknown) =>
  fetch(srv.url + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) });

beforeAll(async () => {
  const hostPort = await freePort();
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-door-'))]), port: 0, hostPort },
    { fakeTickMs: 25, secrets: memoryStore(), exec: tailscale },
  );
  hosted = srv.hostedUrl()!;
  await until(() => srv.scheduler.engineState().online);
}, 30_000);
afterAll(() => srv.close());

describe('host --public-url: the owner’s own HTTPS front door', () => {
  it('needs the owner account first, with the same 409 as the other routes', async () => {
    const res = await local('/api/host', { via: 'custom', url: DOOR });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fix: 'hildegard host owner' });
    expect(((await (await fetch(`${srv.url}/api/host`)).json()) as HostState).on).toBe(false);
  });

  it('refuses addresses that aren’t an https origin on a public name', async () => {
    expect((await local('/api/people/owner', { name: 'Ada', passphrase: PASS })).status).toBe(201);
    const bad = [
      'http://hildegard.example.com',
      'hildegard.example.com',
      'https://hildegard.example.com/mcp',
      'https://hildegard.example.com/?x=1',
      'https://hildegard.example.com/#top',
      'https://hildegard.example.com?',
      'https://user:pw@hildegard.example.com',
      'https://100.64.0.1',
      'https://127.0.0.1:8443',
      'https://[::1]',
      'https://localhost',
      'https://hildegard',
      'https://studio.example.ts.net',
      'https://studio.example.ts.net:8443',
      'https://ts.net',
      'https://printer.local',
      'https://hildegard.example.com:99999',
      '',
    ];
    for (const url of bad) {
      const res = await local('/api/host', { via: 'custom', url });
      expect(res.status, url).toBe(400);
      expect(((await res.json()) as { error: string }).error, url).toBeTruthy();
    }
    const state = (await (await fetch(`${srv.url}/api/host`)).json()) as HostState;
    expect(state.on).toBe(false);
    expect(calls.filter((a) => a[0] === 'serve' || a[0] === 'funnel')).toEqual([]);
  });

  it('answers to the public name on the hosted listener only while the route is on', async () => {
    expect((await asHost('hildegard.example.com', '/api/health')).status).toBe(421);

    const res = await local('/api/host', { via: 'custom', url: `${DOOR}/` });
    expect(res.status).toBe(200);
    expect((await res.json()) as HostState).toMatchObject({
      on: true,
      via: 'custom',
      url: DOOR,
      problem: null,
    });
    // No tailscale serve or funnel call, ever.
    expect(calls.filter((a) => a[0] === 'serve' || a[0] === 'funnel')).toEqual([]);

    expect((await asHost('hildegard.example.com', '/api/health')).status).toBe(200);
    expect((await asHost('HILDEGARD.example.com', '/api/health')).status).toBe(200);
    // Another name, or this name with a port the door doesn't have, is still refused.
    expect((await asHost('other.example.com', '/api/health')).status).toBe(421);
    expect((await asHost('hildegard.example.com:8443', '/api/health')).status).toBe(421);
    // The tailnet name isn't this route's.
    expect((await asHost('studio.example.ts.net', '/api/health')).status).toBe(421);
  });

  it('puts the public URL in the OAuth metadata, the issuer, the resource and the challenge', async () => {
    // Behind a Cloudflare tunnel: it sends x-forwarded-proto: https.
    const viaTunnel = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' };
    const pr = json(
      await asHost('hildegard.example.com', '/.well-known/oauth-protected-resource', {
        headers: viaTunnel,
      }),
    );
    expect(pr.resource).toBe(`${DOOR}/mcp`);
    expect(pr.authorization_servers).toEqual([DOOR]);
    const prMcp = json(
      await asHost('hildegard.example.com', '/.well-known/oauth-protected-resource/mcp', {
        headers: viaTunnel,
      }),
    );
    expect(prMcp.resource).toBe(`${DOOR}/mcp`);
    const as = json(
      await asHost('hildegard.example.com', '/.well-known/oauth-authorization-server', {
        headers: viaTunnel,
      }),
    );
    expect(as.issuer).toBe(DOOR);
    expect(as.authorization_endpoint).toBe(`${DOOR}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${DOOR}/oauth/token`);
    // A proxy that doesn't send x-forwarded-proto (Caddy sends it; others may not): same Host, still https.
    const bare = json(await asHost('hildegard.example.com', '/.well-known/oauth-authorization-server'));
    expect(bare.issuer).toBe(DOOR);
    // And with a plain-http claim, the configured URL still wins.
    const plain = json(
      await asHost('hildegard.example.com', '/.well-known/oauth-authorization-server', {
        headers: { 'x-forwarded-proto': 'http' },
      }),
    );
    expect(plain.issuer).toBe(DOOR);
    // An app that hasn't signed in is told where to, by the public URL.
    const challenge = await asHost('hildegard.example.com', '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(challenge.status).toBe(401);
    expect(String(challenge.headers['www-authenticate'])).toContain(
      `resource_metadata="${DOOR}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('signs in through the door with a __Host- cookie, and refuses other sites', async () => {
    const res = await asHost('hildegard.example.com', '/api/auth/signin', {
      method: 'POST',
      headers: { ...H, origin: DOOR },
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    expect(res.status).toBe(200);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join('\n');
    expect(cookie).toMatch(/__Host-hildegard=[^;]+/);
    expect(cookie).toMatch(/Secure/);
    const evil = await asHost('hildegard.example.com', '/api/auth/signin', {
      method: 'POST',
      headers: { ...H, origin: 'https://evil.example.org' },
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    expect(evil.status).toBe(403);
  });

  it('points invites at the public URL', async () => {
    const owner = await asHost('hildegard.example.com', '/api/auth/signin', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    const cookie = ([] as string[])
      .concat(owner.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const inv = await asHost('hildegard.example.com', '/api/people/invites', {
      method: 'POST',
      headers: { ...H, cookie },
      body: '{}',
    });
    expect(inv.status).toBe(201);
    expect((json(inv) as { url: string }).url).toMatch(/^https:\/\/hildegard\.example\.com\/#\/invite\//);
  });

  it('does not trust the public name on the loopback listener: no hosted treatment, no https', async () => {
    // The same Host and headers, sent to this computer’s own listener (not the hosted one).
    const viaTunnel = { 'x-forwarded-proto': 'https' };
    for (const path of ['/.well-known/oauth-authorization-server', '/api/health', '/api/snapshot']) {
      const r = await asHost('hildegard.example.com', path, { headers: viaTunnel, base: srv.url });
      expect(r.status, path).toBe(421);
      expect(r.body, path).not.toContain(DOOR);
    }
    // Even with proxy headers or from the metadata path, nothing on loopback says the public URL.
    const meta = await asHost('hildegard.example.com', '/.well-known/oauth-protected-resource', {
      base: srv.url,
    });
    expect(meta.status).toBe(421);
    // This computer is still this computer, by its own Host.
    const me = await fetch(`${srv.url}/api/snapshot`);
    expect(me.status).toBe(200);
    const meta2 = json(await asHost('127.0.0.1', '/.well-known/oauth-protected-resource', { base: srv.url }));
    expect(String(meta2.resource)).toMatch(/^http:\/\/127\.0\.0\.1\/mcp$/);
  });

  it('keeps the hosted listener’s other names as they were: no https without the door or the header', async () => {
    expect((await asHost('127.0.0.1', '/api/health')).status).toBe(200);
    const inner = json(await asHost('127.0.0.1', '/.well-known/oauth-authorization-server'));
    expect(String(inner.issuer)).toBe(`http://127.0.0.1`);
  });

  it('takes a :443 the proxy adds for a door without a port, and refuses other schemes and mismatched origins', async () => {
    const meta = json(await asHost('hildegard.example.com:443', '/.well-known/oauth-authorization-server'));
    expect(meta.issuer).toBe(DOOR);
    const post = (host: string, origin: string) =>
      asHost(host, '/api/auth/signin', {
        method: 'POST',
        headers: { ...H, origin },
        body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
      });
    expect((await post('hildegard.example.com', DOOR)).status).toBe(200);
    // Plain http on the same name is not the door’s origin.
    expect((await post('hildegard.example.com', 'http://hildegard.example.com')).status).toBe(403);
    // Another Host on the hosted listener, with the door as its Origin, is cross-origin.
    expect((await post('127.0.0.1', DOOR)).status).toBe(403);
    // And so is the door’s name as an Origin on this computer’s own listener.
    const here = await asHost('127.0.0.1', '/api/auth/signin', {
      method: 'POST',
      base: srv.url,
      headers: { ...H, origin: DOOR },
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    expect(here.status).toBe(403);
  });

  it('turns off cleanly: the name is removed and answers 421 again', async () => {
    const off = await local('/api/host/off');
    expect(off.status).toBe(200);
    expect((await off.json()) as HostState).toMatchObject({ on: false, url: null });
    expect((await asHost('hildegard.example.com', '/api/health')).status).toBe(421);
    expect(
      (
        await asHost('hildegard.example.com', '/.well-known/oauth-authorization-server', {
          headers: { 'x-forwarded-proto': 'https' },
        })
      ).status,
    ).toBe(421);
    expect(calls.filter((a) => a[0] === 'serve' || a[0] === 'funnel')).toEqual([]);
  });

  it('comes back after a restart without asking Tailscale for anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-door-restart-'));
    const make = async () => {
      const hostPort = await freePort();
      const log: string[][] = [];
      const run: Exec = async (c, a, t) => {
        log.push(a);
        return tailscale(c, a, t);
      };
      const s = await startServer(
        { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hostPort },
        { fakeTickMs: 25, secrets: memoryStore(), exec: run },
      );
      return { s, log };
    };
    const first = await make();
    try {
      await fetch(`${first.s.url}/api/people/owner`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
      });
      const on = await fetch(`${first.s.url}/api/host`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ via: 'custom', url: 'https://hg.example.org:8443' }),
      });
      expect(((await on.json()) as HostState).url).toBe('https://hg.example.org:8443');
    } finally {
      await first.s.close();
    }
    const again = await make();
    try {
      const h = (await (await fetch(`${again.s.url}/api/host`)).json()) as HostState;
      expect(h).toMatchObject({ on: true, via: 'custom', url: 'https://hg.example.org:8443' });
      await until(() => again.s.hostedUrl() !== null);
      // With a port, the Host carries it.
      const ok = await asHost('hg.example.org:8443', '/api/health', { base: again.s.hostedUrl()! });
      expect(ok.status).toBe(200);
      const meta = json(
        await asHost('hg.example.org:8443', '/.well-known/oauth-protected-resource', {
          base: again.s.hostedUrl()!,
        }),
      );
      expect(meta.resource).toBe('https://hg.example.org:8443/mcp');
      expect((await asHost('hg.example.org', '/api/health', { base: again.s.hostedUrl()! })).status).toBe(
        421,
      );
      expect(again.log.filter((a) => a[0] === 'serve' || a[0] === 'funnel')).toEqual([]);
    } finally {
      await again.s.close();
    }
  }, 30_000);

  it('stops Tailscale forwarding when the route moves from Serve to the door', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-door-switch-'));
    const hostPort = await freePort();
    const log: string[][] = [];
    const run: Exec = async (c, a, t) => {
      log.push(a);
      return tailscale(c, a, t);
    };
    const s = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hostPort },
      { fakeTickMs: 25, secrets: memoryStore(), exec: run },
    );
    try {
      const post = (body: unknown) =>
        fetch(`${s.url}/api/host`, { method: 'POST', headers: H, body: JSON.stringify(body) });
      await fetch(`${s.url}/api/people/owner`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
      });
      expect((await post({})).status).toBe(200);
      expect(log).toContainEqual(['serve', '--bg', '--https=443', s.hostedUrl()]);
      expect((await post({ via: 'custom', url: DOOR })).status).toBe(200);
      expect(log).toContainEqual(['serve', '--https=443', 'off']);
      // The tailnet name is no longer this link’s.
      expect((await asHost('studio.example.ts.net', '/api/health', { base: s.hostedUrl()! })).status).toBe(
        421,
      );
      expect((await asHost('hildegard.example.com', '/api/health', { base: s.hostedUrl()! })).status).toBe(
        200,
      );
    } finally {
      await s.close();
    }
  }, 30_000);
});

describe('host --public-url: guarding the door', () => {
  const clients: Running[] = [];
  const start = async (args: string[], limits?: { perName: number; perClient: number }, dir?: string) => {
    const hostPort = await freePort();
    const s = await startServer(
      {
        ...parseArgs(['--fake-gpu', '--data', dir ?? mkdtempSync(join(tmpdir(), 'hg-door-')), ...args]),
        port: 0,
        hostPort,
      },
      { fakeTickMs: 25, secrets: memoryStore(), exec: tailscale, ...(limits ? { limits } : {}) },
    );
    clients.push(s);
    return s;
  };
  const api = (s: Running, path: string, body: unknown = {}) =>
    fetch(s.url + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const withOwner = async (s: Running) => {
    expect((await api(s, '/api/people/owner', { name: 'Ada', passphrase: PASS })).status).toBe(201);
  };
  const signin = (s: Running, headers: Record<string, string>, passphrase = 'wrong wrong wrong') =>
    asHost('hildegard.example.com', '/api/auth/signin', {
      base: s.hostedUrl()!,
      method: 'POST',
      headers: { ...H, ...headers },
      body: JSON.stringify({ name: 'Ada', passphrase }),
    });
  afterAll(async () => {
    for (const s of clients) await s.close();
  });

  it('counts sign-in tries by the proxy’s own X-Forwarded-For entry, not the leading ones a client can make up', async () => {
    const s = await start([], { perName: 1000, perClient: 3 });
    await withOwner(s);
    expect((await api(s, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    // Different spoofed leading entries, the same entry appended by the proxy: one address, so the fourth is refused.
    const seen: number[] = [];
    for (let i = 0; i < 5; i++)
      seen.push((await signin(s, { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.7` })).status);
    expect(seen).toEqual([401, 401, 401, 429, 429]);
    // A different address at the proxy is a different bucket.
    expect((await signin(s, { 'x-forwarded-for': '10.0.0.1, 198.51.100.8' })).status).toBe(401);
    // No header at all: the socket’s own address, still one bucket.
    for (let i = 0; i < 3; i++) await signin(s, {});
    expect((await signin(s, {})).status).toBe(429);
  });

  it('caps guesses at one account whatever the address', async () => {
    const s = await start([], { perName: 3, perClient: 1000 });
    await withOwner(s);
    expect((await api(s, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) seen.push((await signin(s, { 'x-forwarded-for': `203.0.113.${i}` })).status);
    expect(seen).toEqual([401, 401, 401, 429, 429]);
    // Even the right passphrase waits, from yet another address.
    expect((await signin(s, { 'x-forwarded-for': '203.0.113.99' }, PASS)).status).toBe(429);
  });

  it('keeps the Tailscale routes’ first-entry address', async () => {
    const s = await start([], { perName: 1000, perClient: 2 });
    await withOwner(s);
    expect((await api(s, '/api/host')).status).toBe(200);
    const via = (xff: string) =>
      asHost('studio.example.ts.net', '/api/auth/signin', {
        base: s.hostedUrl()!,
        method: 'POST',
        headers: { ...H, 'x-forwarded-for': xff },
        body: JSON.stringify({ name: 'Ada', passphrase: 'wrong wrong wrong' }),
      });
    expect([(await via('100.64.0.9')).status, (await via('100.64.0.9')).status]).toEqual([401, 401]);
    expect((await via('100.64.0.9')).status).toBe(429);
    expect((await via('100.64.0.10')).status).toBe(401);
  });

  it('refuses a name that is also in --allow-host, and never serves it on the Studio’s listener, on or off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-door-allow-'));
    const s1 = await start([], undefined, dir);
    await withOwner(s1);
    expect((await api(s1, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    await s1.close();
    clients.splice(clients.indexOf(s1), 1);

    // The door is on and its name is also listed: Hildegard won’t start, and says why.
    await expect(
      startServer(
        {
          ...parseArgs(['--fake-gpu', '--data', dir, '--allow-host', 'Hildegard.Example.com:7341']),
          port: 0,
        },
        { fakeTickMs: 25, secrets: memoryStore(), exec: tailscale },
      ),
    ).rejects.toThrow(/front door.*allow-host/);

    // The same name spelled with a trailing dot, or in capitals, is the same name.
    await expect(
      startServer(
        { ...parseArgs(['--fake-gpu', '--data', dir, '--allow-host', 'HILDEGARD.example.com.']), port: 0 },
        { fakeTickMs: 25, secrets: memoryStore(), exec: tailscale },
      ),
    ).rejects.toThrow(/front door.*allow-host/);

    // Without the list, then off: the name stays refused after off, even when it is listed on the next start.
    const s2 = await start([], undefined, dir);
    await until(() => s2.hostedUrl() !== null);
    expect((await asHost('hildegard.example.com', '/api/health', { base: s2.hostedUrl()! })).status).toBe(
      200,
    );
    expect((await api(s2, '/api/host/off')).status).toBe(200);
    await s2.close();
    clients.splice(clients.indexOf(s2), 1);

    const s2b = await start(['--allow-host', 'hildegard.example.com.'], undefined, dir);
    const names = [
      'hildegard.example.com',
      'hildegard.example.com.',
      'hildegard.example.com.:8080',
      'hildegard.example.com:8080',
      'Hildegard.Example.com:443',
    ];
    for (const n of names) {
      expect((await asHost(n, '/api/health', { base: s2b.url })).status, `studio ${n}`).toBe(421);
      expect((await asHost(n, '/api/health', { base: s2b.hostedUrl()! })).status, `hosted ${n}`).toBe(421);
    }
    expect((await asHost('127.0.0.1', '/api/health', { base: s2b.url })).status).toBe(200);
    // Its Origin is not allowed to write to this computer’s own listener either.
    const write = await asHost('127.0.0.1', '/api/projects', {
      base: s2b.url,
      method: 'POST',
      headers: { ...H, origin: DOOR },
      body: '{}',
    });
    expect(write.status).toBe(403);
    expect(
      (
        await asHost('127.0.0.1', '/api/projects', {
          base: s2b.url,
          method: 'POST',
          headers: { ...H, origin: 'https://hildegard.example.com.' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    // Turning the route on again is refused while the name is listed.
    const again = await api(s2b, '/api/host', { via: 'custom', url: DOOR });
    expect(again.status).toBe(409);
    await s2b.close();
    clients.splice(clients.indexOf(s2b), 1);

    // On, and not listed: served on the hosted listener with its exact Host, and on no other.
    const s2c = await start([], undefined, dir);
    expect((await api(s2c, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    expect((await asHost('hildegard.example.com', '/api/health', { base: s2c.hostedUrl()! })).status).toBe(
      200,
    );
    expect(
      (await asHost('hildegard.example.com:8080', '/api/health', { base: s2c.hostedUrl()! })).status,
    ).toBe(421);
    expect((await asHost('hildegard.example.com', '/api/health', { base: s2c.url })).status).toBe(421);
    // Turning the route on is refused while the name is listed.
    const dir2 = mkdtempSync(join(tmpdir(), 'hg-door-allow2-'));
    const s3 = await start(['--allow-host', 'Hildegard.Example.com:7341'], undefined, dir2);
    await withOwner(s3);
    const res = await api(s3, '/api/host', { via: 'custom', url: DOOR });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/allow-host/);
    expect(((await (await fetch(`${s3.url}/api/host`)).json()) as HostState).on).toBe(false);
  });

  it('refuses the saved door’s name on the Studio’s listener, until a different door is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-door-swap-'));
    const A = 'https://a.example.com';
    const B = 'https://b.example.com';
    const s1 = await start([], undefined, dir);
    await withOwner(s1);
    expect((await api(s1, '/api/host', { via: 'custom', url: A })).status).toBe(200);
    expect((await api(s1, '/api/host', { via: 'custom', url: B })).status).toBe(200);
    await s1.close();
    clients.splice(clients.indexOf(s1), 1);

    // B is the saved door. A was replaced, so it may be listed for the Studio’s own listener, as it always could.
    const s2 = await start(['--allow-host', 'a.example.com'], undefined, dir);
    expect((await asHost('a.example.com', '/api/health', { base: s2.url })).status).toBe(200);
    expect((await asHost('b.example.com', '/api/health', { base: s2.hostedUrl()! })).status).toBe(200);
    await s2.close();
    clients.splice(clients.indexOf(s2), 1);

    // To use B’s name for the Studio again: set a different door, or take `door` out of host.json while stopped.
    await expect(
      startServer(
        { ...parseArgs(['--fake-gpu', '--data', dir, '--allow-host', 'b.example.com']), port: 0 },
        { fakeTickMs: 25, secrets: memoryStore(), exec: tailscale },
      ),
    ).rejects.toThrow(/front door/);
    const file = join(dir, 'host.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete saved.door;
    writeFileSync(file, JSON.stringify(saved));
    const s3 = await start(['--allow-host', 'b.example.com'], undefined, dir);
    expect((await asHost('b.example.com', '/api/health', { base: s3.url })).status).toBe(200);
  });

  it('reads a door that an older build turned off as off, when the build comes forward again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-door-roundtrip-'));
    const file = join(dir, 'host.json');
    const s = await start([], undefined, dir);
    await withOwner(s);
    expect((await api(s, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    await s.close();
    clients.splice(clients.indexOf(s), 1);

    // An older build's off(): `this.save(f ? { ...f, on: false } : null)`, with f the whole parsed file.
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(parsed.on).toBe(0);
    writeFileSync(file, JSON.stringify({ ...parsed, on: false }, null, 2));

    const back = await start([], undefined, dir);
    expect(((await (await fetch(`${back.url}/api/host`)).json()) as HostState).on).toBe(false);
    expect((await asHost('hildegard.example.com', '/api/health', { base: back.hostedUrl()! })).status).toBe(
      421,
    );
    // The name is still the saved door’s, off; and the file says so for the next start.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ on: false, door: { url: DOOR, on: false } });
    await back.close();
    clients.splice(clients.indexOf(back), 1);

    // An older build that only ran and stopped, never turning anything off, leaves the door on.
    const kept = mkdtempSync(join(tmpdir(), 'hg-door-roundtrip2-'));
    const s2 = await start([], undefined, kept);
    await withOwner(s2);
    expect((await api(s2, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    await s2.close();
    clients.splice(clients.indexOf(s2), 1);
    const raw = readFileSync(join(kept, 'host.json'), 'utf8');
    writeFileSync(join(kept, 'host.json'), JSON.stringify(JSON.parse(raw)));
    const s3 = await start([], undefined, kept);
    expect(((await (await fetch(`${s3.url}/api/host`)).json()) as HostState).on).toBe(true);
  });

  it('saves the door where builds from before it read "off", and reads the first version’s file', async () => {
    // What a build before the door did with host.json: `saved?.on ? saved : null`, and routes by `via`.
    const before = (file: string) => {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        on?: boolean;
        via?: string;
        httpsPort?: number;
      };
      const f = saved?.on ? saved : null;
      return { on: !!f, via: f?.via ?? null, tailscaleCalls: f?.httpsPort ? 1 : 0 };
    };
    const dir = mkdtempSync(join(tmpdir(), 'hg-door-disk-'));
    const file = join(dir, 'host.json');
    const s = await start([], undefined, dir);
    await withOwner(s);
    expect((await api(s, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    expect(before(file)).toEqual({ on: false, via: null, tailscaleCalls: 0 });
    const on = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(on).toMatchObject({ on: 0, door: { url: DOOR, on: true } });
    expect(on).not.toHaveProperty('via');
    expect(on).not.toHaveProperty('url');
    expect(((await (await fetch(`${s.url}/api/host`)).json()) as HostState).via).toBe('custom');
    // Off: the name is remembered, switched off.
    expect((await api(s, '/api/host/off')).status).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ on: false, door: { url: DOOR, on: false } });
    // Back to Serve: a route in the old fields, with the door still remembered off.
    expect((await api(s, '/api/host')).status).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      on: true,
      via: 'tailscale',
      door: { url: DOOR, on: false },
    });
    await s.close();
    clients.splice(clients.indexOf(s), 1);

    // A host.json written by the first version of the door (`via: 'custom'`) still works, and is written again.
    const old = mkdtempSync(join(tmpdir(), 'hg-door-old-'));
    writeFileSync(join(old, 'host.json'), JSON.stringify({ on: true, via: 'custom', url: DOOR }));
    const s2 = await start([], undefined, old);
    const st = (await (await fetch(`${s2.url}/api/host`)).json()) as HostState;
    expect(st).toMatchObject({ on: true, via: 'custom', url: DOOR });
    expect(JSON.parse(readFileSync(join(old, 'host.json'), 'utf8'))).toEqual({
      on: 0,
      door: { url: DOOR, on: true },
    });
    expect(before(join(old, 'host.json')).on).toBe(false);
    await until(() => s2.hostedUrl() !== null);
    expect((await asHost('hildegard.example.com', '/api/health', { base: s2.hostedUrl()! })).status).toBe(
      200,
    );
    // And one that was off keeps the name.
    const off = mkdtempSync(join(tmpdir(), 'hg-door-old2-'));
    writeFileSync(join(off, 'host.json'), JSON.stringify({ on: false, via: 'custom', url: DOOR }));
    const s3 = await start(['--allow-host', 'hildegard.example.com'], undefined, off);
    expect((await asHost('hildegard.example.com', '/api/health', { base: s3.url })).status).toBe(421);
    expect(JSON.parse(readFileSync(join(off, 'host.json'), 'utf8'))).toEqual({
      on: false,
      door: { url: DOOR, on: false },
    });
  });

  it('keeps the old Serve route recorded when Tailscale is down or won’t turn it off', async () => {
    let down = false;
    let refuse: string | null = null;
    const log: string[][] = [];
    const run: Exec = async (c, a, t) => {
      log.push(a);
      if (down && a[0] === 'status') return { ok: false, out: '' };
      if (refuse && a.includes('off')) return { ok: false, out: refuse };
      return tailscale(c, a, t);
    };
    const hostPort = await freePort();
    const s = await startServer(
      {
        ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-door-sw-'))]),
        port: 0,
        hostPort,
      },
      { fakeTickMs: 25, secrets: memoryStore(), exec: run },
    );
    clients.push(s);
    await withOwner(s);
    const state = async () => (await (await fetch(`${s.url}/api/host`)).json()) as HostState;
    expect((await api(s, '/api/host')).status).toBe(200);

    // Tailscale unreachable: refused before anything is saved.
    down = true;
    let res = await api(s, '/api/host', { via: 'custom', url: DOOR });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fix: 'tailscale up' });
    down = false;
    expect(await state()).toMatchObject({ on: true, via: 'tailscale', url: 'https://studio.example.ts.net' });

    // Tailscale refuses to turn it off: refused, and still recorded as Serve.
    refuse =
      'Access denied: serve config denied\nUse sudo tailscale serve, or tailscale set --operator=$USER';
    res = await api(s, '/api/host', { via: 'custom', url: DOOR });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fix: expect.stringContaining('--operator=$USER') });
    refuse = 'something odd happened';
    res = await api(s, '/api/host', { via: 'custom', url: DOOR });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing changed/);
    expect(await state()).toMatchObject({ on: true, via: 'tailscale' });
    expect((await asHost('hildegard.example.com', '/api/health', { base: s.hostedUrl()! })).status).toBe(421);

    // Once it works, the switch goes through, and the old port was still known to turn off.
    refuse = null;
    log.length = 0;
    expect((await api(s, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    expect(log).toContainEqual(['serve', '--https=443', 'off']);
  });

  it('starts the hosted listener on its own for the door, and closes it again when off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-door-nohp-'));
    const s = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
      { fakeTickMs: 25, secrets: memoryStore(), exec: tailscale },
    );
    clients.push(s);
    expect(s.hostedUrl()).toBeNull();
    await withOwner(s);
    expect((await api(s, '/api/host', { via: 'custom', url: DOOR })).status).toBe(200);
    await until(() => s.hostedUrl() !== null);
    const hosted = s.hostedUrl()!;
    expect((await asHost('hildegard.example.com', '/api/health', { base: hosted })).status).toBe(200);
    expect((await api(s, '/api/host/off')).status).toBe(200);
    await until(() => s.hostedUrl() === null);
    await expect(fetch(`${hosted}/api/health`)).rejects.toThrow();
  });
});
