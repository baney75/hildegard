// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hildegard is its own OAuth 2.1 authorization server, so a chatbot that lives on someone else's servers (claude.ai,
 * ChatGPT) can use this Hildegard's MCP once it is at a public link. Following the MCP authorization spec
 * (2026-07-28): protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), apps identified by a
 * metadata document they publish (CIMD) or by registering (RFC 7591), PKCE S256 only, `iss` on every response
 * (RFC 9207), tokens bound to this MCP address (RFC 8707), and refresh tokens that rotate.
 *
 * Approving is signing in: the person types their own name and passphrase on Hildegard's page, never the chatbot's,
 * and the chatbot then acts as them, with their role.
 */
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Ctx, clientKey, type HgEnv, originOf } from './access.ts';
import { GrantError, type Grants, SCOPE } from './grants.ts';
import { Limiter, type People } from './people.ts';

/** What an OAuth client says about itself, from its metadata document or its registration. */
export interface ClientInfo {
  id: string;
  name: string;
  redirectUris: string[];
  /** Where its name came from: a document at its own https address can't be faked; a registration can. */
  verified: boolean;
}

/** Fetches an app's client metadata document. Tests give a stand-in. */
export type FetchMetadata = (url: string) => Promise<unknown>;

// ── Addresses ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Addresses no metadata document may live at: this computer, the LAN, the tailnet (100.64/10) and the like. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]!);
  return (
    v6 === '::' ||
    v6 === '::1' ||
    /^f[cd]/.test(v6) ||
    /^fe[89ab]/.test(v6) ||
    /^ff/.test(v6) ||
    v6.startsWith('64:ff9b:') ||
    v6.startsWith('2001:db8')
  );
}

const DANGEROUS_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'ws:',
  'wss:',
  'ftp:',
]);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where an app may ask to be sent back: https, this computer over http (RFC 8252), or an app's own scheme. */
export function redirectAllowed(uri: string): boolean {
  if (uri.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK_NAMES.has(u.hostname);
  return !DANGEROUS_SCHEMES.has(u.protocol);
}

/** Exactly as registered, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== 'http:' || !LOOPBACK_NAMES.has(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return (
        u.protocol === 'http:' &&
        u.hostname === a.hostname &&
        u.pathname === a.pathname &&
        u.search === a.search
      );
    } catch {
      return false;
    }
  });
}

/** A short plain name an app gives itself: no control characters, at most 60 characters. */
const cleanClientName = (raw: unknown, fallback: string) => {
  const n =
    typeof raw === 'string'
      ? raw
          .replace(/[\p{Cc}\p{Cf}]/gu, '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  return (n || fallback).slice(0, 60);
};

/**
 * Fetches a client metadata document over https from a public address only, at most 16 KB, without following
 * redirects. The address is checked as it is resolved for the connection itself, so a name can't change its answer
 * between the check and the request.
 */
export const fetchMetadata: FetchMetadata = (url) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || (u.port && u.port !== '443') || isIP(u.hostname.replace(/^\[|\]$/g, '')))
      return reject(new Error('A client id must be an https address on a name, on port 443.'));
    const req = request(
      u,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        timeout: 5000,
        lookup: (host, _opts, cb) => {
          lookup(host, { all: true })
            .then((addrs) => {
              const ok = addrs.find((a) => !privateAddress(a.address));
              if (!ok || addrs.some((a) => privateAddress(a.address)))
                return cb(new Error(`${host} isn’t a public address.`), '', 4);
              cb(null, ok.address, ok.family);
            })
            .catch((e: Error) => cb(e, '', 4));
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`The client's metadata answered ${res.statusCode}.`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 16_384) {
            req.destroy();
            reject(new Error('The client’s metadata is over 16 KB.'));
          } else chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('The client’s metadata isn’t JSON.'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The client’s metadata didn’t answer in time.')));
    req.on('error', reject);
    req.end();
  });

// ── The consent page ────────────────────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Hildegard's own colours, inline: the page must work before the Studio's files load, and with none of them. */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${esc(title)} · Hildegard</title><style>
:root{--bg:#14110f;--card:#1d1916;--ink:#f3ede4;--muted:#b8ad9d;--line:#3a332c;--accent:#e8b86a;--green:#7fa47a;--bad:#e58a76}
@media (prefers-color-scheme:light){:root{--bg:#f4efe6;--card:#fffdf8;--ink:#1d1916;--muted:#625a50;--line:#ddd3c4;--accent:#8a5a14;--green:#3f6b3a;--bad:#a8402c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 "Source Sans 3",system-ui,sans-serif;padding:16px}
main{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font:600 1.6rem/1.2 "Cormorant Garamond",Georgia,serif;margin:0 0 8px}p{margin:0 0 14px;color:var(--muted)}strong{color:var(--ink)}
ul{margin:0 0 18px;padding-left:1.2rem;color:var(--muted)}label{display:block;font-size:.9rem;margin:12px 0 4px}
input{width:100%;font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font:600 1rem/1 inherit;padding:12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.go{background:var(--green);border-color:var(--green);color:#fff}.err{color:var(--bad);margin-top:12px}.small{font-size:.85rem}code{font-family:"DM Mono",ui-monospace,monospace;font-size:.85em}
</style><main>${body}</main></html>`;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Pending {
  client: ClientInfo;
  redirectUri: string;
  state: string | null;
  challenge: string;
  resource: string;
  issuer: string;
  expiresAt: number;
}

export interface OAuthDeps {
  grants: Grants;
  people: People;
  /** Wrong passphrases, counted as signing in counts them. */
  limited: (c: Ctx, keys: string[]) => Response | null;
  failed: (keys: string[]) => void;
  perName: Limiter;
  fetchMetadata?: FetchMetadata;
  now?: () => number;
}

/** Cross-origin is fine for the endpoints an app calls itself: they carry no cookie, and every answer is no-store. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '600',
};

export function oauthRoutes(app: Hono<HgEnv>, deps: OAuthDeps) {
  const { grants, people } = deps;
  const now = deps.now ?? Date.now;
  const getMetadata = deps.fetchMetadata ?? fetchMetadata;
  const pending = new Map<string, Pending>();
  const metadataCache = new Map<string, { info: ClientInfo; until: number }>();
  /** Registrations per address: an app registers once, so a flood is someone filling the list. */
  const registrations: Limiter = new Limiter(20, 3600_000);

  const cors = (c: Ctx) => {
    for (const [k, v] of Object.entries(CORS)) c.header(k, v);
    c.header('cache-control', 'no-store');
  };
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
  ])
    app.options(path, (c) => {
      cors(c);
      return c.body(null, 204);
    });

  const resourceMeta = (c: Ctx) => {
    cors(c);
    const origin = originOf(c);
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Hildegard',
      resource_documentation: 'https://github.com/baney75/hildegard/blob/main/docs/agents.md',
    });
  };
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

  const serverMeta = (c: Ctx) => {
    cors(c);
    const issuer = originOf(c);
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  };
  app.get('/.well-known/oauth-authorization-server', serverMeta);
  app.get('/.well-known/oauth-authorization-server/mcp', serverMeta);

  const oauthError = (c: Ctx, status: 400 | 401 | 429, error: string, description: string) => {
    cors(c);
    return c.json({ error, error_description: description }, status);
  };

  // ── Registration (RFC 7591) ──────────────────────────────────────────────────────────────────────────────
  const Registration = z.object({
    redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
    client_name: z.string().max(400).optional(),
    token_endpoint_auth_method: z.string().max(60).optional(),
    grant_types: z.array(z.string().max(60)).max(5).optional(),
    response_types: z.array(z.string().max(60)).max(5).optional(),
  });
  app.post('/oauth/register', async (c) => {
    const key = `register:${clientKey(c)}`;
    if (registrations.wait(key))
      return oauthError(
        c,
        429,
        'temporarily_unavailable',
        'Too many registrations from here. Try again later.',
      );
    const body = Registration.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return oauthError(c, 400, 'invalid_client_metadata', 'Give redirect_uris, as a list.');
    const m = body.data;
    if (m.token_endpoint_auth_method && m.token_endpoint_auth_method !== 'none')
      return oauthError(
        c,
        400,
        'invalid_client_metadata',
        'Hildegard registers public clients only: token_endpoint_auth_method "none", with PKCE.',
      );
    if (m.grant_types?.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))
      return oauthError(
        c,
        400,
        'invalid_client_metadata',
        'Only authorization_code and refresh_token are offered.',
      );
    if (m.response_types?.some((r) => r !== 'code'))
      return oauthError(c, 400, 'invalid_client_metadata', 'Only the code response type is offered.');
    const bad = m.redirect_uris.find((u) => !redirectAllowed(u));
    if (bad)
      return oauthError(
        c,
        400,
        'invalid_redirect_uri',
        'A redirect_uri must be https, http on this computer (localhost), or an app’s own scheme.',
      );
    try {
      registrations.fail(key);
      const client = grants.register(cleanClientName(m.client_name, 'An AI app'), m.redirect_uris);
      cors(c);
      return c.json(
        {
          client_id: client.id,
          client_id_issued_at: Math.floor(client.createdAt / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        201,
      );
    } catch (e) {
      if (e instanceof GrantError) return oauthError(c, 400, e.code, e.message);
      throw e;
    }
  });

  /** An app by its id: a metadata document at its https address (fetched, cached an hour), or a registration. */
  const clientFor = async (id: string): Promise<ClientInfo | string> => {
    if (id.startsWith('https://')) {
      const hit = metadataCache.get(id);
      if (hit && hit.until > now()) return hit.info;
      let doc: unknown;
      try {
        doc = await getMetadata(id);
      } catch (e) {
        return `Hildegard couldn’t read this app’s details at ${id}: ${(e as Error).message}`;
      }
      const d = z
        .object({
          client_id: z.string(),
          client_name: z.string().optional(),
          redirect_uris: z.array(z.string()),
        })
        .safeParse(doc);
      if (!d.success || d.data.client_id !== id)
        return 'This app’s details don’t name it as itself, so Hildegard can’t trust them.';
      const uris = d.data.redirect_uris.filter(redirectAllowed);
      if (!uris.length) return 'This app gives no redirect address Hildegard can send you back to.';
      const info: ClientInfo = {
        id,
        name: cleanClientName(d.data.client_name, new URL(id).hostname),
        redirectUris: uris,
        verified: true,
      };
      if (metadataCache.size > 200) metadataCache.clear();
      metadataCache.set(id, { info, until: now() + 3600_000 });
      return info;
    }
    const reg = grants.client(id);
    if (!reg) return 'Hildegard doesn’t know this app. Remove the connector and add it again.';
    return { id: reg.id, name: reg.name, redirectUris: reg.redirectUris, verified: false };
  };

  const consent = (c: Ctx, requestId: string, p: Pending, error?: string, name = '') => {
    const back = (() => {
      try {
        const u = new URL(p.redirectUri);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//`;
      } catch {
        return p.redirectUri;
      }
    })();
    const who = people.hasOwner()
      ? ''
      : '<p class="err">This Hildegard has no owner account yet. On the computer it runs on, run <code>hildegard host owner</code>, then try again.</p>';
    c.header('cache-control', 'no-store');
    c.header(
      'content-security-policy',
      // No form-action: browsers apply it to the redirect back to the app as well.
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    return c.html(
      page(
        `Connect ${p.client.name}`,
        `<h1>Connect ${esc(p.client.name)}?</h1>
<p><strong>${esc(p.client.name)}</strong>${p.client.verified ? '' : ' (as it calls itself)'} wants to use this Hildegard as you, and will return to <strong>${esc(back)}</strong>.</p>
<ul><li>It can direct shots, follow and cancel takes, and export films, on your GPU.</li><li>It sees the films you see, and does only what your role here allows.</li><li>You can disconnect it any time in Settings › Sharing, or with <code>hildegard host keys</code>.</li></ul>
<form method="post" action="/oauth/authorize" autocomplete="on">
<input type="hidden" name="request" value="${esc(requestId)}">
<label for="n">Your name here</label><input id="n" name="name" autocomplete="username" required maxlength="40" value="${esc(name)}">
<label for="p">Your passphrase</label><input id="p" name="passphrase" type="password" autocomplete="current-password" required maxlength="256">
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}${who}
<div class="row"><button name="decision" value="deny" formnovalidate>Don’t allow</button><button class="go" name="decision" value="allow">Allow</button></div>
</form><p class="small" style="margin-top:16px">Only type your passphrase here, at this Hildegard’s own address, never into a chatbot.</p>`,
      ),
      error ? 401 : 200,
    );
  };

  const errorPage = (c: Ctx, message: string, status: 400 | 404 | 429 = 400) => {
    c.header('cache-control', 'no-store');
    c.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    return c.html(page('Can’t connect', `<h1>Can’t connect</h1><p>${esc(message)}</p>`), status);
  };

  /** Back to the app with an error, once its redirect is known to be its own (RFC 6749 §4.1.2.1). */
  const redirectWith = (c: Ctx, uri: string, params: Record<string, string | null>) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    c.header('cache-control', 'no-store');
    return c.redirect(u.toString(), 303);
  };

  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    if (!q.client_id || q.client_id.length > 2000)
      return errorPage(c, 'This link is missing the app’s client_id.');
    const client = await clientFor(q.client_id);
    if (typeof client === 'string') return errorPage(c, client);
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : '');
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
      return errorPage(
        c,
        'This app asked to be sent back somewhere it didn’t register, so Hildegard stopped here.',
      );
    const issuer = originOf(c);
    const state = q.state ?? null;
    const fail = (error: string, description: string) =>
      redirectWith(c, redirectUri, { error, error_description: description, state, iss: issuer });
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code.');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? ''))
      return fail('invalid_request', 'PKCE with code_challenge_method S256 is required.');
    const resource = `${issuer}/mcp`;
    if (q.resource && q.resource.replace(/\/$/, '') !== resource && q.resource.replace(/\/$/, '') !== issuer)
      return fail('invalid_target', `This server is ${resource}.`);
    if (q.scope && !q.scope.split(' ').every((s) => s === SCOPE || s === ''))
      return fail('invalid_scope', `The only scope is ${SCOPE}.`);
    for (const [k, p] of pending) if (p.expiresAt <= now()) pending.delete(k);
    if (pending.size > 500)
      return errorPage(c, 'Too many sign-ins are waiting here. Try again in a few minutes.', 429);
    const requestId = randomUUID();
    const p: Pending = {
      client,
      redirectUri,
      state,
      challenge: q.code_challenge!,
      resource,
      issuer,
      expiresAt: now() + 10 * 60_000,
    };
    pending.set(requestId, p);
    return consent(c, requestId, p);
  });

  app.post('/oauth/authorize', async (c) => {
    // A form on this page posts here; nothing else may, so another site can't approve on someone's behalf.
    const origin = c.req.header('origin');
    if (origin && origin !== originOf(c))
      return errorPage(c, 'This approval came from another site, so Hildegard refused it.');
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const field = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const requestId = field('request');
    const p = pending.get(requestId);
    if (!p || p.expiresAt <= now())
      return errorPage(c, 'This sign-in has expired. Start again from the app you were connecting.');
    if (field('decision') !== 'allow') {
      pending.delete(requestId);
      return redirectWith(c, p.redirectUri, {
        error: 'access_denied',
        error_description: 'The person said no.',
        state: p.state,
        iss: p.issuer,
      });
    }
    const name = field('name').slice(0, 200);
    const keys = [`client:${clientKey(c)}`, `name:${name.trim().toLocaleLowerCase()}`];
    const refused = deps.limited(c, keys);
    if (refused) return consent(c, requestId, p, 'Too many tries. Wait a few minutes, then try again.', name);
    const signed = await people.signIn(name, field('passphrase').slice(0, 1024));
    if (!signed) {
      deps.failed(keys);
      return consent(c, requestId, p, 'That name and passphrase don’t match.', name);
    }
    // A sign-in made only to approve this app: its session isn't needed.
    people.signOut(signed.token);
    deps.perName.clear(keys[1]!);
    pending.delete(requestId);
    const code = grants.issueCode({
      clientId: p.client.id,
      clientName: p.client.name,
      redirectUri: p.redirectUri,
      challenge: p.challenge,
      personId: signed.person.id,
      resource: p.resource,
    });
    return redirectWith(c, p.redirectUri, { code, state: p.state, iss: p.issuer });
  });

  // ── Tokens ────────────────────────────────────────────────────────────────────────────────────────────────
  /** Bad tries at the token endpoint, per address: codes and refresh tokens are unguessable, so few are needed. */
  const tokenFails: Limiter = new Limiter(30, 15 * 60_000);
  app.post('/oauth/token', async (c) => {
    const key = `token:${clientKey(c)}`;
    if (tokenFails.wait(key))
      return oauthError(c, 429, 'temporarily_unavailable', 'Too many bad tries. Wait a while.');
    const type = c.req.header('content-type') ?? '';
    const form: Record<string, unknown> = type.includes('application/json')
      ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
      : await c.req.parseBody().catch(() => ({}));
    const f = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).slice(0, 4096) : '');
    const resource = f('resource') ? f('resource').replace(/\/$/, '') : undefined;
    const mine = `${originOf(c)}/mcp`;
    // An app may name the server by its origin or its MCP address; both mean this one.
    const target = resource === originOf(c) ? mine : resource;
    try {
      let tokens: ReturnType<Grants['refresh']>;
      if (f('grant_type') === 'authorization_code') {
        if (!f('client_id') || !f('code') || !f('redirect_uri') || !f('code_verifier'))
          return oauthError(
            c,
            400,
            'invalid_request',
            'Give code, redirect_uri, client_id and code_verifier.',
          );
        tokens = grants.exchange({
          code: f('code'),
          clientId: f('client_id'),
          redirectUri: f('redirect_uri'),
          verifier: f('code_verifier'),
          resource: target,
        });
      } else if (f('grant_type') === 'refresh_token') {
        if (!f('client_id') || !f('refresh_token'))
          return oauthError(c, 400, 'invalid_request', 'Give refresh_token and client_id.');
        tokens = grants.refresh({ token: f('refresh_token'), clientId: f('client_id'), resource: target });
      } else return oauthError(c, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
      tokenFails.clear(key);
      cors(c);
      c.header('pragma', 'no-cache');
      return c.json(tokens);
    } catch (e) {
      if (e instanceof GrantError) {
        tokenFails.fail(key);
        return oauthError(c, 400, e.code, e.message);
      }
      throw e;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    if (typeof form.token === 'string') grants.revokeToken(form.token);
    cors(c);
    // Always 200, so revoking says nothing about whether a token was real (RFC 7009 §2.2).
    return c.body(null, 200);
  });
}
