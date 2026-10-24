// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrantsResponse, NewKey, Snapshot } from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { challengeOf } from '../src/grants.ts';
import { privateAddress, redirectAllowed, redirectMatches } from '../src/oauth.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const PASS = 'a long and private passphrase';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-0123456789';
const REDIRECT = 'https://chat.example/oauth/callback';

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

let srv: Running;
/** Through the link, as Tailscale forwards it: never this computer. */
let remote: string;
const docs = new Map<string, unknown>();

const local = (path: string, method = 'GET', body?: unknown) =>
  fetch(srv.url + path, {
    method,
    headers: method === 'GET' ? {} : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** An MCP client at `base`/mcp, with a bearer token when given one. */
async function mcpAt(base: string, token?: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test-chatbot', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    }),
  );
  return client;
}
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

const rawMcp = (base: string, token?: string, extra: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
    }),
  });

const newKey = async (name: string, person?: string) => {
  const res = await local('/api/auth/keys', 'POST', { name, ...(person ? { person } : {}) });
  expect(res.status).toBe(201);
  return (await res.json()) as NewKey;
};

beforeAll(async () => {
  const hostPort = await freePort();
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-rmcp-'))]), port: 0, hostPort },
    {
      fakeTickMs: 20,
      secrets: memoryStore(),
      exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
      limits: { perName: 5, perClient: 1000 },
      fetchMetadata: async (url) => {
        if (!docs.has(url)) throw new Error('not found');
        return docs.get(url);
      },
    },
  );
  remote = srv.hostedUrl()!;
  expect((await local('/api/people/owner', 'POST', { name: 'Ada', passphrase: PASS })).status).toBe(201);
  await until(() => srv.scheduler.engineState().online);
}, 30_000);
afterAll(() => srv.close());

describe('addresses and redirects', () => {
  it('refuses metadata documents on this computer, the LAN and the tailnet', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '100.101.102.103',
      '172.20.0.1',
      '192.168.1.5',
      '169.254.1.1',
      '::1',
      'fd7a:115c::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ])
      expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['160.79.104.10', '8.8.8.8', '2606:4700::1111'])
      expect(privateAddress(ip), ip).toBe(false);
  });
  it('lets apps come back only to https, this computer, or their own scheme', () => {
    expect(redirectAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectAllowed('http://localhost:33418/callback')).toBe(true);
    expect(redirectAllowed('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true);
    for (const bad of [
      'http://evil.example/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'https://a.example/cb#x',
      'file:///etc/passwd',
    ])
      expect(redirectAllowed(bad), bad).toBe(false);
    expect(redirectMatches(['http://127.0.0.1:1000/cb'], 'http://127.0.0.1:5555/cb')).toBe(true);
    expect(redirectMatches(['http://127.0.0.1:1000/cb'], 'http://127.0.0.1:5555/other')).toBe(false);
    expect(redirectMatches(['https://a.example/cb'], 'https://a.example/cb2')).toBe(false);
  });
});

describe('MCP over HTTP on this computer', { timeout: 30_000 }, () => {
  it('needs nothing, like the rest of the server here', async () => {
    const c = await mcpAt(srv.url);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain('direct_shot');
    expect(
      textOf((await c.callTool({ name: 'hildegard_status', arguments: {} })) as CallToolResult),
    ).toContain('stand-in GPU');
    await c.close();
  });
  it('refuses another site’s page in the browser', async () => {
    expect((await rawMcp(srv.url, undefined, { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('refuses a body that isn’t JSON, so a plain cross-site form can’t reach it', async () => {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(res.status).toBe(415);
  });
  it('answers only POST: there are no sessions or streams to open', async () => {
    expect((await fetch(`${srv.url}/mcp`)).status).toBe(405);
  });
});

describe('MCP over HTTP from other devices', { timeout: 30_000 }, () => {
  it('asks for a token, and says where to get one', async () => {
    const res = await rawMcp(remote);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${remote}/.well-known/oauth-protected-resource/mcp", scope="hildegard"`,
    );
    const bad = await rawMcp(remote, `hgk_${'A'.repeat(43)}`);
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('works with a key, labels takes with its name, and links videos instead of paths', async () => {
    const { key, grant } = await newKey('Claude Code on the laptop');
    expect(key).toMatch(/^hgk_[A-Za-z0-9_-]{43}$/);
    expect(grant.person.name).toBe('Ada');
    const c = await mcpAt(remote, key);
    const r = (await c.callTool({
      name: 'direct_shot',
      arguments: { prompt: 'A lighthouse keeper climbs the stairs', wait: true, seconds: 2 },
    })) as CallToolResult;
    const text = textOf(r);
    expect(text).toContain('done');
    const link = /Video: (\S+)/.exec(text)?.[1];
    expect(link).toMatch(new RegExp(`^${remote}/media/\\w+\\.mp4\\?exp=\\d+&sig=`));
    expect(text).not.toContain(srv.config.dataDir);
    // The link opens without signing in; the same file without its signature doesn't.
    expect((await fetch(link!)).status).toBe(200);
    expect((await fetch(link!.split('?')[0]!)).status).toBe(401);
    expect((await fetch(link!.replace(/sig=.{4}/, 'sig=AAAA'))).status).toBe(401);
    // The take is labelled with the key's name, not whatever the app calls itself.
    const { takes } = (await (await local('/api/snapshot')).json()) as Snapshot;
    expect(
      takes.some((t) => t.source.kind === 'agent' && t.source.name === 'Claude Code on the laptop'),
    ).toBe(true);
    await c.close();
  });

  it('takes start frames as data from afar, never as a path on this computer', async () => {
    const { key } = await newKey('Phone');
    const c = await mcpAt(remote, key);
    const byPath = (await c.callTool({
      name: 'direct_shot',
      arguments: { prompt: 'A door opens', start_frame_path: '/etc/hosts' },
    })) as CallToolResult;
    expect(byPath.isError).toBe(true);
    expect(textOf(byPath)).toContain('start_frame_data');
    // A 1×1 PNG.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const byData = (await c.callTool({
      name: 'direct_shot',
      arguments: { prompt: 'A door opens', start_frame_data: png },
    })) as CallToolResult;
    expect(byData.isError).toBeFalsy();
    await c.close();
  });

  it('stops working the moment a key is revoked', async () => {
    const { key, grant } = await newKey('Old desktop');
    expect((await rawMcp(remote, key)).status).toBe(200);
    expect((await local(`/api/auth/grants/${grant.id}`, 'DELETE')).status).toBe(200);
    expect((await rawMcp(remote, key)).status).toBe(401);
  });

  it('acts with the person’s role: a director’s agent can’t install models', async () => {
    const inv = (await (await local('/api/people/invites', 'POST', { role: 'director' })).json()) as {
      url: string;
    };
    const token = inv.url.split('/#/invite/')[1]!;
    const res = await fetch(`${remote}/api/auth/invite/${token}/accept`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Hilde', passphrase: PASS }),
    });
    expect(res.status).toBe(201);
    const { key } = await newKey('Hilde’s agent', 'Hilde');
    const c = await mcpAt(remote, key);
    const r = (await c.callTool({
      name: 'install_model',
      arguments: { model: 'wan-2-2-ti2v-5b', accept_license: true },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Only the owner');
    // And she sees her own keys only.
    const signin = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Hilde', passphrase: PASS }),
    });
    const cookie = signin.headers.getSetCookie()[0]!.split(';')[0]!;
    const mine = (await (
      await fetch(`${remote}/api/auth/grants`, { headers: { cookie } })
    ).json()) as GrantsResponse;
    expect(mine.grants.map((g) => g.person.name)).toEqual(['Hilde']);
    await c.close();
  });
});

describe('OAuth for chatbots', { timeout: 30_000 }, () => {
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

  async function register(redirect = REDIRECT) {
    const res = await fetch(`${remote}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Chat Example', redirect_uris: [redirect] }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }
  const authorizeUrl = (clientId: string, extra: Record<string, string> = {}) =>
    `${remote}/oauth/authorize?${form({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challengeOf(VERIFIER),
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${remote}/mcp`,
      ...extra,
    })}`;
  async function approve(clientId: string, passphrase = PASS) {
    const page = await fetch(authorizeUrl(clientId));
    expect(page.status).toBe(200);
    const html = await page.text();
    const requestId = /name="request" value="([^"]+)"/.exec(html)![1]!;
    return fetch(`${remote}/oauth/authorize`, {
      method: 'POST',
      headers: { ...FORM, origin: remote },
      body: form({ request: requestId, name: 'Ada', passphrase, decision: 'allow' }),
      redirect: 'manual',
    });
  }
  const tokenFor = (o: Record<string, string>) =>
    fetch(`${remote}/oauth/token`, { method: 'POST', headers: FORM, body: form(o) });

  it('publishes where to sign in', async () => {
    const pr = (await (await fetch(`${remote}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
      string,
      unknown
    >;
    expect(pr.resource).toBe(`${remote}/mcp`);
    expect(pr.authorization_servers).toEqual([remote]);
    const as = (await (await fetch(`${remote}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(as.issuer).toBe(remote);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('refuses registrations it can’t trust', async () => {
    const bad = await fetch(`${remote}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('never sends a code to an address the app didn’t register', async () => {
    const id = await register();
    const res = await fetch(authorizeUrl(id, { redirect_uri: 'https://attacker.example/cb' }), {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('signs in with the passphrase, then trades the code for tokens that work at /mcp', async () => {
    const id = await register();
    const page = await (await fetch(authorizeUrl(id))).text();
    expect(page).toContain('Chat Example');
    expect(page).toContain('(as it calls itself)');
    expect(page).toContain('chat.example');
    expect((await approve(id, 'not my passphrase')).status).toBe(401);
    const ok = await approve(id);
    expect(ok.status).toBe(303);
    const back = new URL(ok.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(remote);
    const code = back.searchParams.get('code')!;
    // The verifier must match the challenge.
    const wrong = await tokenFor({
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: REDIRECT,
      code_verifier: `${VERIFIER}x`,
    });
    expect(wrong.status).toBe(400);
    const res = await tokenFor({
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: `${remote}/mcp`,
    });
    // A wrong verifier doesn't spend the code: only its own app, with the right verifier, can.
    expect(res.status).toBe(200);
    const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(t.access_token).toMatch(/^hga_/);
    expect(t.expires_in).toBe(3600);
    const c = await mcpAt(remote, t.access_token);
    expect((await c.listTools()).tools.length).toBeGreaterThan(5);
    await c.close();
    // The token is for this address only: the same server under another name refuses it.
    const elsewhere = remote.replace('127.0.0.1', 'localhost');
    expect((await rawMcp(elsewhere, t.access_token)).status).toBe(401);
    // A code is good once; a second use ends what the first made.
    const again = await tokenFor({
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(again.status).toBe(400);
    expect((await rawMcp(remote, t.access_token)).status).toBe(401);
  });

  it('rotates refresh tokens, and ends the connection when a spent one comes back', async () => {
    const id = await register();
    const code = new URL((await approve(id)).headers.get('location')!).searchParams.get('code')!;
    const first = (await (
      await tokenFor({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json()) as { access_token: string; refresh_token: string };
    const second = await tokenFor({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: id,
    });
    expect(second.status).toBe(200);
    const t2 = (await second.json()) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(first.refresh_token);
    expect((await rawMcp(remote, t2.access_token)).status).toBe(200);
    const replay = await tokenFor({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: id,
    });
    expect(replay.status).toBe(400);
    expect((await rawMcp(remote, t2.access_token)).status).toBe(401);
  });

  it('trusts an app’s published metadata document, and only when it names itself', async () => {
    const id = 'https://app.example/oauth/client.json';
    docs.set(id, { client_id: id, client_name: 'Example Chat', redirect_uris: [REDIRECT] });
    const page = await (await fetch(authorizeUrl(id))).text();
    expect(page).toContain('Example Chat');
    expect(page).not.toContain('(as it calls itself)');
    const liar = 'https://liar.example/client.json';
    docs.set(liar, { client_id: 'https://app.example/oauth/client.json', redirect_uris: [REDIRECT] });
    expect((await fetch(authorizeUrl(liar))).status).toBe(400);
  });

  it('ends chatbots when the passphrase changes, and keeps keys', async () => {
    const { key } = await newKey('Workstation');
    const id = await register();
    const code = new URL((await approve(id)).headers.get('location')!).searchParams.get('code')!;
    const t = (await (
      await tokenFor({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json()) as { access_token: string };
    expect((await rawMcp(remote, t.access_token)).status).toBe(200);
    expect((await local('/api/people/owner', 'POST', { name: 'Ada', passphrase: PASS })).status).toBe(200);
    expect((await rawMcp(remote, t.access_token)).status).toBe(401);
    expect((await rawMcp(remote, key)).status).toBe(200);
  });

  it('refuses an approval posted from another site', async () => {
    const res = await fetch(`${remote}/oauth/authorize`, {
      method: 'POST',
      headers: { ...FORM, origin: 'https://evil.example' },
      body: form({ request: 'x', name: 'Ada', passphrase: PASS, decision: 'allow' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});
