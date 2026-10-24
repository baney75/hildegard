// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hildegard's MCP over HTTP (Streamable HTTP, stateless), at `/mcp`. On this computer it needs nothing, like the
 * rest of the server; from anywhere else it needs a bearer token: a key, or a chatbot's OAuth token. The tools are
 * the same ones `hildegard mcp` serves on stdio, calling this server in-process as the person the token belongs to,
 * so every check a person meets in the Studio applies to their agents too.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { type Ctx, clientKey, fromThisComputer, type HgEnv, originOf, type Who } from './access.ts';
import type { Grants } from './grants.ts';
import { Limiter } from './people.ts';

/** How long a link to a video or still from an MCP result opens without signing in. */
export const LINK_HOURS = 24;

/**
 * Signs links to media files, so a chatbot can open the video it made without a session. A link names one file and
 * an expiry, under a key kept in the data folder (0600), so links survive a restart and nobody can make their own.
 */
export class MediaSigner {
  private readonly key: Buffer;
  private readonly now: () => number;
  constructor(opts: { dataDir: string; now?: () => number }) {
    this.now = opts.now ?? Date.now;
    const file = join(opts.dataDir, 'people', 'media-link.key');
    let key: Buffer | null = null;
    try {
      key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
    } catch {}
    if (key?.length !== 32) {
      key = randomBytes(32);
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(file, key.toString('base64url'), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    this.key = key;
  }

  private mac(path: string, exp: number) {
    return createHmac('sha256', this.key).update(`${path}\n${exp}`).digest();
  }

  /** `/media/<file>` → `/media/<file>?exp=…&sig=…`. */
  sign(path: string, hours = LINK_HOURS): string {
    const exp = Math.floor(this.now() / 1000) + hours * 3600;
    const [bare, query] = path.split('?', 2) as [string, string | undefined];
    const extra = query ? `&${query}` : '';
    return `${bare}?exp=${exp}&sig=${this.mac(bare, exp).toString('base64url')}${extra}`;
  }

  verify(path: string, exp: string | undefined, sig: string | undefined): boolean {
    if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
    const e = Number(exp);
    if (e * 1000 <= this.now()) return false;
    return timingSafeEqual(this.mac(path, e), Buffer.from(sig, 'base64url'));
  }
}

export interface RemoteMcpDeps {
  grants: Grants;
  signer: MediaSigner;
  /** The app itself, to call in-process as the person asking. */
  fetch: (r: Request, env: HgEnv['Bindings']) => Response | Promise<Response>;
  /** Requests a minute each key or chatbot may make. */
  perMinute?: number;
}

/** What to tell an app without a token: where to sign in (RFC 9728 §5.1). */
const challenge = (c: Ctx, error?: string) => {
  const meta = `${originOf(c)}/.well-known/oauth-protected-resource/mcp`;
  c.header(
    'www-authenticate',
    `Bearer resource_metadata="${meta}", scope="hildegard"${error ? `, error="${error}"` : ''}`,
  );
};

export function remoteMcpRoutes(app: Hono<HgEnv>, deps: RemoteMcpDeps) {
  const { grants, signer } = deps;
  const perGrant = new Limiter(deps.perMinute ?? 240, 60_000);
  const badTokens = new Limiter(30, 15 * 60_000);

  const handle = async (c: Ctx) => {
    let as: Who;
    let agentName: string | undefined;
    const origin = originOf(c);
    if (fromThisComputer(c)) as = { kind: 'local' };
    else {
      const key = `mcp:${clientKey(c)}`;
      const wait = badTokens.wait(key);
      if (wait) {
        c.header('retry-after', String(wait));
        return c.json({ error: 'Too many bad tokens from here. Wait a while.' }, 429);
      }
      const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
      const auth = m ? grants.authenticate(m[1]!, `${origin}/mcp`) : null;
      if (!auth) {
        if (m) badTokens.fail(key);
        challenge(c, m ? 'invalid_token' : undefined);
        return c.json(
          {
            error: m
              ? 'That token isn’t good here: it was revoked, has expired, or is for another address.'
              : 'Sign in first: this Hildegard’s MCP needs a key or a chatbot’s sign-in from other devices.',
          },
          401,
        );
      }
      const g = `grant:${auth.grant.id}`;
      const slow = perGrant.wait(g);
      if (slow) {
        c.header('retry-after', String(slow));
        return c.json({ error: 'That’s a lot of calls at once. Wait a moment.' }, 429);
      }
      perGrant.fail(g);
      as = { kind: 'person', person: auth.person, session: g };
      agentName = auth.grant.name;
    }
    if (c.req.method !== 'POST') {
      // Stateless: no stream to open, no session to end (MCP 2026-07-28 has no protocol sessions).
      c.header('allow', 'POST');
      return c.json({ error: 'Send MCP messages with POST.' }, 405);
    }
    const local = as.kind === 'local';
    const client = new HildegardClient(origin, ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      return deps.fetch(new Request(`http://127.0.0.1${u.pathname}${u.search}`, init), { as });
    }) as typeof fetch);
    const server = createMcpServer(client, {
      agentName,
      remote: local ? undefined : { link: (path) => `${origin}${signer.sign(path)}` },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    c.req.raw.signal.addEventListener('abort', () => void server.close(), { once: true });
    const res = await transport.handleRequest(c.req.raw);
    res.headers.set('cache-control', 'no-store');
    return res;
  };
  app.on(['POST', 'GET', 'DELETE'], '/mcp', handle);
}
