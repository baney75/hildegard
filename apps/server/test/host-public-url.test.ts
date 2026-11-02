// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync } from 'node:fs';
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
