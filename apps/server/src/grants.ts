// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What lets an AI app on another device use this Hildegard's MCP, always as one person and with that person's role:
 *
 * - a **key** (`hgk_…`), made on this computer or by someone signed in, for apps on their own devices;
 * - a **chatbot grant**, made when someone approves a chatbot (claude.ai, ChatGPT) on Hildegard's own OAuth 2.1
 *   sign-in page: short-lived access tokens (`hga_…`) and rotating refresh tokens (`hgr_…`).
 *
 * Every token is 256 random bits, kept only as a SHA-256 hash, in a file only the owner's account can read. Removing a
 * person ends all of theirs; a new passphrase ends their chatbot grants, since those were won with the old one.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentGrant } from '@hildegard/presets';

export class GrantError extends Error {
  /** The OAuth error code (RFC 6749 §5.2) when it comes from the token endpoint. */
  readonly code: string;
  readonly status: 400 | 401 | 403 | 404 | 409;
  constructor(status: GrantError['status'], code: string, message: string) {
    super(message);
    this.name = 'GrantError';
    this.status = status;
    this.code = code;
  }
}

export const GRANT = {
  accessMs: 3600_000,
  refreshMs: 30 * 24 * 3600_000,
  codeMs: 60_000,
  /** Keys last until revoked unless given days; at most a year when they are. */
  keyMaxDays: 365,
  /** Apps that registered themselves (RFC 7591) and are kept; the oldest unused go first past this. */
  maxClients: 200,
  maxGrants: 500,
};

export type TokenKind = 'key' | 'access' | 'refresh' | 'code';
const PREFIX: Record<TokenKind, string> = { key: 'hgk_', access: 'hga_', refresh: 'hgr_', code: 'hgo_' };
const TOKEN_RE = /^hg[karo]_[A-Za-z0-9_-]{43}$/;
const newToken = (kind: TokenKind) => PREFIX[kind] + randomBytes(32).toString('base64url');
/** Tokens are random, so one SHA-256 is enough, and looking one up by its hash says nothing about the token. */
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const looksLikeToken = (t: string, kind?: TokenKind) =>
  TOKEN_RE.test(t) && (!kind || t.startsWith(PREFIX[kind]));

interface StoredToken {
  hash: string;
  kind: 'access' | 'refresh';
  expiresAt: number;
  /** A refresh token that was swapped for a new one. Seeing it again means it leaked: the grant ends. */
  usedAt?: number;
}
interface StoredGrant {
  id: string;
  personId: string;
  name: string;
  kind: 'key' | 'chatbot';
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  /** key: the key's hash. */
  keyHash?: string;
  /** chatbot: the OAuth client, and the MCP address its tokens are good for (RFC 8707). */
  clientId?: string;
  resource?: string;
  tokens?: StoredToken[];
}
/** An app that registered itself (RFC 7591). Apps that publish a metadata document (CIMD) are never stored. */
export interface StoredClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
}
interface GrantsFile {
  version: 1;
  grants: StoredGrant[];
  clients: StoredClient[];
}
interface Code {
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  personId: string;
  resource: string;
  expiresAt: number;
  /** Set once exchanged: a second try means the code was stolen, and the grant it made ends. */
  grantId?: string;
}

export interface Tokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export const SCOPE = 'hildegard';

function save(path: string, data: unknown) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** PKCE S256 (RFC 7636): base64url(SHA-256(verifier)). */
export const challengeOf = (verifier: string) =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export class Grants {
  private readonly file: string;
  private data: GrantsFile;
  private readonly now: () => number;
  private readonly person: (
    id: string,
  ) => { id: string; name: string; role: 'owner' | 'director' } | undefined;
  private readonly codes = new Map<string, Code>();
  private readonly byHash = new Map<string, StoredGrant>();
  private lastSave = 0;

  constructor(opts: {
    dataDir: string;
    person: Grants['person'];
    now?: () => number;
  }) {
    this.file = join(opts.dataDir, 'people', 'grants.json');
    this.now = opts.now ?? Date.now;
    this.person = opts.person;
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as GrantsFile;
      if (this.data.version !== 1 || !Array.isArray(this.data.grants)) throw new Error('unknown');
      this.data.clients ??= [];
    } catch {
      this.data = { version: 1, grants: [], clients: [] };
    }
    this.index();
  }

  private index() {
    this.byHash.clear();
    for (const g of this.data.grants) {
      if (g.keyHash) this.byHash.set(g.keyHash, g);
      for (const t of g.tokens ?? []) this.byHash.set(t.hash, g);
    }
  }

  private persist() {
    this.lastSave = this.now();
    save(this.file, this.data);
  }

  /** Drop what has expired, and everything of people no longer here. */
  prune() {
    const t = this.now();
    const before = JSON.stringify(this.data.grants);
    this.data.grants = this.data.grants.filter((g) => {
      if (!this.person(g.personId)) return false;
      if (g.expiresAt !== null && g.expiresAt <= t) return false;
      if (g.kind === 'chatbot') {
        g.tokens = (g.tokens ?? []).filter((x) => x.expiresAt > t);
        // Keep a used refresh token only for as long as it would have lasted, to catch a replay.
        return g.tokens.some((x) => x.kind === 'refresh' && !x.usedAt);
      }
      return true;
    });
    // An exchanged code is remembered ten minutes more, to catch a second use.
    for (const [k, c] of this.codes) if (c.expiresAt + (c.grantId ? 600_000 : 0) <= t) this.codes.delete(k);
    if (JSON.stringify(this.data.grants) !== before) {
      this.index();
      this.persist();
    }
  }

  private view(g: StoredGrant): AgentGrant {
    const p = this.person(g.personId);
    const refresh = (g.tokens ?? []).filter((x) => x.kind === 'refresh' && !x.usedAt);
    const expires = g.kind === 'key' ? g.expiresAt : Math.max(0, ...refresh.map((x) => x.expiresAt)) || null;
    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      person: { id: g.personId, name: p?.name ?? '?' },
      createdAt: new Date(g.createdAt).toISOString(),
      lastUsedAt: g.lastUsedAt ? new Date(g.lastUsedAt).toISOString() : null,
      expiresAt: expires ? new Date(expires).toISOString() : null,
    };
  }

  /** Everyone's (personId null), or one person's. Newest first. */
  list(personId: string | null): AgentGrant[] {
    this.prune();
    return this.data.grants
      .filter((g) => personId === null || g.personId === personId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => this.view(g));
  }

  get(id: string): AgentGrant | undefined {
    const g = this.data.grants.find((x) => x.id === id);
    return g ? this.view(g) : undefined;
  }

  private room() {
    this.prune();
    if (this.data.grants.length >= GRANT.maxGrants)
      throw new GrantError(
        409,
        'temporarily_unavailable',
        'There are too many keys and chatbots here. Revoke some first.',
      );
  }

  /** A key for an app on someone's own device. The key is returned this once and never kept. */
  newKey(personId: string, rawName: string, days: number | null = null): { grant: AgentGrant; key: string } {
    if (!this.person(personId))
      throw new GrantError(404, 'invalid_request', 'There’s no one like that here.');
    const name = rawName.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()'’-]{0,59}$/u.test(name))
      throw new GrantError(
        400,
        'invalid_request',
        'Name the key for the app and device it’s for, such as “Claude Code on my laptop”: up to 60 letters, digits, spaces and dots.',
      );
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > GRANT.keyMaxDays))
      throw new GrantError(
        400,
        'invalid_request',
        `A key lasts from 1 to ${GRANT.keyMaxDays} days, or until it’s revoked.`,
      );
    this.room();
    const key = newToken('key');
    const t = this.now();
    const g: StoredGrant = {
      id: randomUUID(),
      personId,
      name,
      kind: 'key',
      createdAt: t,
      lastUsedAt: null,
      expiresAt: days === null ? null : t + days * 24 * 3600_000,
      keyHash: hashOf(key),
    };
    this.data.grants.push(g);
    this.byHash.set(g.keyHash!, g);
    this.persist();
    return { grant: this.view(g), key };
  }

  revoke(id: string): AgentGrant {
    const g = this.data.grants.find((x) => x.id === id);
    if (!g) throw new GrantError(404, 'invalid_request', 'That key or chatbot is gone already.');
    const v = this.view(g);
    this.drop(g);
    return v;
  }

  private drop(g: StoredGrant) {
    this.data.grants = this.data.grants.filter((x) => x !== g);
    this.index();
    this.persist();
  }

  /** A new passphrase: chatbots approved with the old one must ask again. Keys stay. */
  endChatbots(personId: string) {
    const before = this.data.grants.length;
    this.data.grants = this.data.grants.filter((g) => !(g.personId === personId && g.kind === 'chatbot'));
    if (this.data.grants.length !== before) {
      this.index();
      this.persist();
    }
  }

  /**
   * Who a bearer token on /mcp belongs to. A chatbot's token works only at the MCP address it was issued for, so a
   * token won at one link is no good at another.
   */
  authenticate(
    token: string,
    resource: string,
  ): { grant: AgentGrant; person: { id: string; name: string; role: 'owner' | 'director' } } | null {
    if (!looksLikeToken(token, 'key') && !looksLikeToken(token, 'access')) return null;
    const h = hashOf(token);
    const g = this.byHash.get(h);
    if (!g) return null;
    const t = this.now();
    const person = this.person(g.personId);
    if (!person) return null;
    if (g.kind === 'key') {
      if (g.keyHash !== h || (g.expiresAt !== null && g.expiresAt <= t)) return null;
    } else {
      const tok = g.tokens?.find((x) => x.hash === h);
      if (tok?.kind !== 'access' || tok.expiresAt <= t || g.resource !== resource) return null;
    }
    if (!g.lastUsedAt || t - g.lastUsedAt > 60_000) {
      g.lastUsedAt = t;
      // Last-used times are worth a write a minute at most.
      if (t - this.lastSave > 60_000) this.persist();
    }
    return { grant: this.view(g), person };
  }

  // ── OAuth 2.1: clients, codes and tokens ───────────────────────────────────────────────────────────────────

  client(id: string): StoredClient | undefined {
    return this.data.clients.find((c) => c.id === id);
  }

  /** Dynamic Client Registration (RFC 7591), for apps without a metadata document. Public clients only. */
  register(name: string, redirectUris: string[]): StoredClient {
    const used = new Set(this.data.grants.map((g) => g.clientId));
    if (this.data.clients.length >= GRANT.maxClients) {
      // The oldest that never got a grant make room; if every one has, refuse.
      const idle = this.data.clients.filter((c) => !used.has(c.id)).sort((a, b) => a.createdAt - b.createdAt);
      if (!idle.length)
        throw new GrantError(
          400,
          'temporarily_unavailable',
          'Too many apps have registered here. Try again later.',
        );
      const gone = new Set(idle.slice(0, Math.max(1, idle.length >> 2)).map((c) => c.id));
      this.data.clients = this.data.clients.filter((c) => !gone.has(c.id));
    }
    const c: StoredClient = {
      id: `hgc_${randomBytes(16).toString('base64url')}`,
      name,
      redirectUris,
      createdAt: this.now(),
    };
    this.data.clients.push(c);
    this.persist();
    return c;
  }

  /** An authorization code (RFC 6749 §4.1), good once, for a minute. */
  issueCode(c: Omit<Code, 'expiresAt' | 'grantId'>): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(c.challenge))
      throw new GrantError(400, 'invalid_request', 'The code challenge must be S256.');
    this.prune();
    const code = newToken('code');
    this.codes.set(hashOf(code), { ...c, expiresAt: this.now() + GRANT.codeMs });
    return code;
  }

  private tokens(g: StoredGrant): Tokens {
    const t = this.now();
    const access = newToken('access');
    const refresh = newToken('refresh');
    const live = (g.tokens ?? []).filter((x) => x.expiresAt > t);
    // Spent refresh tokens are kept to catch a replay, the last twenty of them.
    const spent = live.filter((x) => x.usedAt).slice(-20);
    g.tokens = [
      ...live.filter((x) => !x.usedAt),
      ...spent,
      { hash: hashOf(access), kind: 'access', expiresAt: t + GRANT.accessMs },
      { hash: hashOf(refresh), kind: 'refresh', expiresAt: t + GRANT.refreshMs },
    ];
    this.index();
    this.persist();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: GRANT.accessMs / 1000,
      refresh_token: refresh,
      scope: SCOPE,
    };
  }

  /** The token request for a code: the same app, the same redirect, the verifier behind its challenge. */
  exchange(req: {
    code: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
    resource?: string;
  }): Tokens {
    const bad = (why: string) => new GrantError(400, 'invalid_grant', why);
    if (!looksLikeToken(req.code, 'code')) throw bad('That code isn’t one of Hildegard’s.');
    const key = hashOf(req.code);
    const c = this.codes.get(key);
    if (!c) throw bad('That code has expired or was never issued. Sign in again.');
    if (c.grantId) {
      // A code used twice was stolen on the way: end what the first use made (RFC 6749 §4.1.2).
      const g = this.data.grants.find((x) => x.id === c.grantId);
      if (g) this.drop(g);
      this.codes.delete(key);
      throw bad('That code was used already. Sign in again.');
    }
    if (c.expiresAt <= this.now()) {
      this.codes.delete(key);
      throw bad('That code has expired. Sign in again.');
    }
    if (c.clientId !== req.clientId) throw bad('That code was issued to another app.');
    if (c.redirectUri !== req.redirectUri)
      throw bad('The redirect_uri doesn’t match the one the code was issued for.');
    if (req.resource !== undefined && req.resource !== c.resource)
      throw new GrantError(400, 'invalid_target', 'That code is for another MCP address.');
    if (!VERIFIER_RE.test(req.verifier) || challengeOf(req.verifier) !== c.challenge)
      throw bad('The code_verifier doesn’t match the code challenge.');
    if (!this.person(c.personId)) throw bad('The person who approved this is no longer here.');
    this.room();
    const g: StoredGrant = {
      id: randomUUID(),
      personId: c.personId,
      name: c.clientName,
      kind: 'chatbot',
      createdAt: this.now(),
      lastUsedAt: null,
      expiresAt: null,
      clientId: c.clientId,
      resource: c.resource,
    };
    // Approving the same app again replaces its last grant, so reconnecting doesn't pile them up.
    this.data.grants = this.data.grants.filter(
      (x) => !(x.kind === 'chatbot' && x.personId === g.personId && x.clientId === g.clientId),
    );
    this.data.grants.push(g);
    // The code stays known until it would have expired, marked, so a second use is caught.
    c.grantId = g.id;
    return this.tokens(g);
  }

  /** A refresh token for a new pair. The old one is spent; using it again ends the grant (RFC 9700 §4.14). */
  refresh(req: { token: string; clientId: string; resource?: string }): Tokens {
    const bad = (why: string) => new GrantError(400, 'invalid_grant', why);
    if (!looksLikeToken(req.token, 'refresh')) throw bad('That refresh token isn’t one of Hildegard’s.');
    const h = hashOf(req.token);
    const g = this.byHash.get(h);
    const tok = g?.tokens?.find((x) => x.hash === h);
    if (!g || !tok || tok.kind !== 'refresh')
      throw bad('That refresh token has expired or was revoked. Sign in again.');
    if (tok.usedAt) {
      this.drop(g);
      throw bad('That refresh token was used already, so this connection has ended. Sign in again.');
    }
    if (tok.expiresAt <= this.now()) throw bad('That refresh token has expired. Sign in again.');
    if (g.clientId !== req.clientId) throw bad('That refresh token was issued to another app.');
    if (req.resource !== undefined && req.resource !== g.resource)
      throw new GrantError(400, 'invalid_target', 'That refresh token is for another MCP address.');
    if (!this.person(g.personId)) throw bad('The person who approved this is no longer here.');
    tok.usedAt = this.now();
    return this.tokens(g);
  }

  /** Token revocation (RFC 7009): a refresh token ends its grant; an access token ends just itself. */
  revokeToken(token: string) {
    if (!TOKEN_RE.test(token)) return;
    const h = hashOf(token);
    const g = this.byHash.get(h);
    if (g?.kind !== 'chatbot') return;
    const tok = g.tokens?.find((x) => x.hash === h);
    if (tok?.kind === 'refresh') this.drop(g);
    else if (tok) {
      g.tokens = g.tokens!.filter((x) => x !== tok);
      this.index();
      this.persist();
    }
  }
}
