// SPDX-License-Identifier: AGPL-3.0-only
// A server with an owner and directors, and the three ways to reach it: this computer, the hosted listener with a
// session cookie, and the remote MCP route with a key. Shared by the writing, posts and publishing tests.
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewInvite, NewKey } from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseArgs } from '../src/config.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

export const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
export const PASS = 'a long and private passphrase';

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

export interface Harness {
  srv: Running;
  dir: string;
  /** The hosted listener: never this computer. */
  remote: string;
  /** Requests as this computer (the owner, no sign-in). */
  local: (path: string, method?: string, body?: unknown) => Promise<Response>;
  /** Requests through the hosted listener as a signed-in person. */
  as: (cookie: string | undefined, path: string, method?: string, body?: unknown) => Promise<Response>;
  /** The owner's id (made on this computer) and a cookie for them on the hosted listener. */
  owner: { name: string; cookie: string };
  /** Invites and signs in a director. */
  director: (name: string) => Promise<{ name: string; cookie: string }>;
  /** A key for a person's agent, and an MCP client on the hosted listener holding it. */
  mcpFor: (person: string) => Promise<Client>;
  close: () => Promise<void>;
}

export const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

export const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((x) => /^(__Host-hildegard|hildegard_session)=[^;]+/.test(x))
    ?.split(';')[0];

export async function boot(
  prefix: string,
  opts: { owner?: boolean; now?: () => number } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), `hg-${prefix}-`));
  const srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hostPort: await freePort(), hfClientId: null },
    {
      fakeTickMs: 10,
      ...(opts.now ? { now: opts.now } : {}),
      secrets: memoryStore(),
      hubToken: join(dir, 'no-hf-token'),
      exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
    },
  );
  const remote = srv.hostedUrl()!;
  const local: Harness['local'] = (path, method = 'GET', body) =>
    fetch(srv.url + path, {
      method,
      headers: method === 'GET' ? {} : H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const as: Harness['as'] = (cookie, path, method = 'GET', body) =>
    fetch(remote + path, {
      method,
      headers: { ...(method === 'GET' ? {} : H), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let owner = { name: 'Alex', cookie: '' };
  if (opts.owner !== false) {
    const made = await local('/api/people/owner', 'POST', { name: 'Alex', passphrase: PASS });
    if (made.status !== 201) throw new Error(`owner: ${made.status}`);
    const signed = await as(undefined, '/api/auth/signin', 'POST', { name: 'Alex', passphrase: PASS });
    owner = { name: 'Alex', cookie: cookieFrom(signed)! };
  }
  const director: Harness['director'] = async (name) => {
    const invite = (await (
      await as(owner.cookie, '/api/people/invites', 'POST', { role: 'director' })
    ).json()) as NewInvite;
    const accepted = await as(
      undefined,
      `/api/auth/invite/${invite.url.split('#/invite/')[1]}/accept`,
      'POST',
      {
        name,
        passphrase: PASS,
      },
    );
    if (accepted.status !== 201) throw new Error(`director ${name}: ${accepted.status}`);
    return { name, cookie: cookieFrom(accepted)! };
  };
  const clients: Client[] = [];
  const mcpFor: Harness['mcpFor'] = async (person) => {
    const res = await local('/api/auth/keys', 'POST', { name: `${person}’s agent`, person });
    const { key } = (await res.json()) as NewKey;
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${remote}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  return {
    srv,
    dir,
    remote,
    local,
    as,
    owner,
    director,
    mcpFor,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await srv.close();
    },
  };
}

/** A request sent exactly as written (no URL clean-up of `..` or `%2e`), as an attacker's client would. */
export function raw(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: u.port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
