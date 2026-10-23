// SPDX-License-Identifier: AGPL-3.0-only
/**
 * People who use this Hildegard from another device: the owner, and those the owner invites. Requests from this
 * computer itself never sign in. Passphrases are kept as scrypt hashes; invite links and session cookies are random
 * 256-bit tokens kept only as SHA-256 hashes, in files only the owner's account can read.
 */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PendingInvite, Person, Role } from '@hildegard/presets';

export class PeopleError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: PeopleError['status'], message: string) {
    super(message);
    this.name = 'PeopleError';
    this.status = status;
  }
}

// ── Passphrases ─────────────────────────────────────────────────────────────────────────────────────────────────

/** scrypt at N=2^15, r=8, p=1: about 32 MB and a tenth of a second per guess, OWASP's floor for it. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
export const PASSPHRASE_MIN = 10;
const PASSPHRASE_MAX = 256;

const derive = (pass: string, salt: Buffer, N: number, r: number, p: number, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(pass.normalize('NFC'), salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/** `scrypt$N$r$p$salt$hash`, salt and hash in base64url. The parameters travel with it, so they can rise later. */
export async function hashPassphrase(pass: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pass, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join(
    '$',
  );
}

/** Whether `pass` matches `stored`, compared in constant time. Anything malformed simply doesn't match. */
export async function verifyPassphrase(pass: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // Bounds keep a damaged file from asking for gigabytes.
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 20 || R < 1 || R > 32 || P < 1 || P > 16)
    return false;
  const want = Buffer.from(hash, 'base64url');
  if (want.length < 16 || want.length > 64) return false;
  const got = await derive(pass, Buffer.from(salt, 'base64url'), N, R, P, want.length);
  return timingSafeEqual(got, want);
}

/** One sentence on what is wrong with a new passphrase, or null when it will do. */
export function passphraseProblem(pass: string): string | null {
  const n = [...pass].length;
  if (n < PASSPHRASE_MIN)
    return `Use a passphrase of at least ${PASSPHRASE_MIN} characters. A few words you’ll remember work well.`;
  if (n > PASSPHRASE_MAX) return `Keep the passphrase under ${PASSPHRASE_MAX} characters.`;
  return null;
}

/** Letters, digits, spaces, dots, dashes and underscores; 1 to 40 of them. */
export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
export function cleanName(raw: string): string {
  const n = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(n))
    throw new PeopleError(400, 'Give a name of up to 40 letters, digits, spaces, dots or dashes.');
  return n;
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** 32 random bytes, base64url: an invite link's secret, or a session cookie. */
const newToken = () => randomBytes(32).toString('base64url');
/** Tokens are random, so one SHA-256 is enough: there is nothing to guess that a slow hash would protect. */
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Constant-time lookup: every entry is compared, so timing says nothing about how close a guess was. */
function findByHash<T extends { hash: string }>(token: string, list: readonly T[]): T | undefined {
  if (!TOKEN_RE.test(token)) return undefined;
  const h = Buffer.from(hashOf(token), 'hex');
  let found: T | undefined;
  for (const x of list) {
    const b = Buffer.from(x.hash, 'hex');
    if (b.length === h.length && timingSafeEqual(b, h)) found = x;
  }
  return found;
}

// ── Rate limits ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Counts failures per key in a sliding window. Successes clear a key; the map forgets idle keys. */
export class Limiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until `key` may try again; 0 when it may now. */
  wait(key: string): number {
    const list = this.recent(key);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.limit]! + this.windowMs - this.now()) / 1000));
  }

  fail(key: string) {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    // Keep memory bounded however many addresses knock.
    if (this.hits.size > 10_000) for (const k of [...this.hits.keys()].slice(0, 1000)) this.hits.delete(k);
  }

  clear(key: string) {
    this.hits.delete(key);
  }
}

// ── People ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface StoredPerson {
  id: string;
  name: string;
  role: Role;
  pass: string;
  createdAt: string;
}
interface StoredInvite extends PendingInvite {
  hash: string;
}
interface StoredSession {
  hash: string;
  personId: string;
  /** When this token was issued; a session's first token was issued when its person signed in. */
  issuedAt: number;
  signedInAt: number;
  lastSeenAt: number;
  /** Set when a newer token replaced this one: it still works for a moment, for requests already on their way. */
  replacedAt: number | null;
}
interface PeopleFile {
  version: 1;
  people: StoredPerson[];
  invites: StoredInvite[];
}

/** A session lasts 30 days from sign-in, or 7 days without use. Its token changes every hour it is used. */
export const SESSION = {
  maxMs: 30 * 24 * 3600_000,
  idleMs: 7 * 24 * 3600_000,
  rotateMs: 3600_000,
  graceMs: 60_000,
};
export const INVITE_HOURS = { default: 72, max: 24 * 30 };

export interface Signed {
  person: { id: string; name: string; role: Role };
  /** The session's id: its token's hash, never the token. */
  session: string;
  /** A fresh token to send back as the cookie, when this one was due to change. */
  rotated: string | null;
}

/** Save JSON only the owner can read, atomically. */
function save(path: string, data: unknown) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
function load<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** A hash to check unknown names against, so a wrong name takes as long as a wrong passphrase. */
let decoy: Promise<string> | null = null;

export class People {
  private readonly file: string;
  private readonly sessionsFile: string;
  private data: PeopleFile;
  private sessions: StoredSession[];
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private lastSessionSave = 0;

  constructor(opts: { dataDir: string; now?: () => number }) {
    const dir = join(opts.dataDir, 'people');
    this.file = join(dir, 'people.json');
    this.sessionsFile = join(dir, 'sessions.json');
    this.now = opts.now ?? Date.now;
    this.data = load<PeopleFile>(this.file, { version: 1, people: [], invites: [] });
    this.sessions = load<{ sessions: StoredSession[] }>(this.sessionsFile, { sessions: [] }).sessions;
  }

  /** Called after anyone is removed, signs out or changes role, so open event streams check again. */
  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private changed() {
    for (const l of this.listeners) l();
  }

  private persist() {
    save(this.file, this.data);
  }
  private persistSessions() {
    this.lastSessionSave = this.now();
    save(this.sessionsFile, { sessions: this.sessions });
  }

  hasOwner(): boolean {
    return this.data.people.some((p) => p.role === 'owner');
  }

  list(): Person[] {
    this.prune();
    return this.data.people.map((p) => {
      const mine = this.sessions.filter((s) => s.personId === p.id && !s.replacedAt);
      const seen = Math.max(0, ...mine.map((s) => s.lastSeenAt));
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        createdAt: p.createdAt,
        lastSeenAt: seen ? new Date(seen).toISOString() : null,
        sessions: mine.length,
      };
    });
  }

  invites(): PendingInvite[] {
    this.prune();
    return this.data.invites.map(({ hash: _, ...i }) => i);
  }

  get(id: string) {
    const p = this.data.people.find((x) => x.id === id);
    return p ? { id: p.id, name: p.name, role: p.role } : undefined;
  }

  private byName(name: string) {
    const n = name.toLocaleLowerCase();
    return this.data.people.find((p) => p.name.toLocaleLowerCase() === n);
  }

  /** Drop expired invites and sessions. */
  private prune() {
    const t = this.now();
    const invites = this.data.invites.filter((i) => Date.parse(i.expiresAt) > t);
    if (invites.length !== this.data.invites.length) {
      this.data.invites = invites;
      this.persist();
    }
    const live = this.sessions.filter((s) => this.alive(s, t));
    if (live.length !== this.sessions.length) {
      this.sessions = live;
      this.persistSessions();
    }
  }

  private alive(s: StoredSession, t: number) {
    return (
      t - s.signedInAt < SESSION.maxMs &&
      t - s.lastSeenAt < SESSION.idleMs &&
      (s.replacedAt === null || t - s.replacedAt < SESSION.graceMs) &&
      this.data.people.some((p) => p.id === s.personId)
    );
  }

  /**
   * The owner's account, made on this computer. With no owner yet it creates one; given an owner's name it sets a
   * new passphrase and signs them out everywhere, which is how a forgotten passphrase is replaced.
   */
  async setOwner(rawName: string, pass: string) {
    const name = cleanName(rawName);
    const problem = passphraseProblem(pass);
    if (problem) throw new PeopleError(400, problem);
    const existing = this.byName(name);
    if (existing && existing.role !== 'owner')
      throw new PeopleError(409, `${existing.name} is a director here. Choose another name for the owner.`);
    if (!existing && this.hasOwner())
      throw new PeopleError(
        409,
        `This Hildegard already has an owner, ${this.data.people.find((p) => p.role === 'owner')!.name}. Give that name to set a new passphrase, or invite another owner from Settings › People.`,
      );
    const hash = await hashPassphrase(pass);
    if (existing) {
      existing.pass = hash;
      this.sessions = this.sessions.filter((s) => s.personId !== existing.id);
      this.persistSessions();
      this.persist();
      this.changed();
      return { id: existing.id, name: existing.name, role: existing.role, created: false };
    }
    const p: StoredPerson = { id: randomUUID(), name, role: 'owner', pass: hash, createdAt: this.iso() };
    this.data.people.push(p);
    this.persist();
    return { id: p.id, name: p.name, role: p.role, created: true };
  }

  private iso(t = this.now()) {
    return new Date(t).toISOString();
  }

  invite(role: Role, hours: number = INVITE_HOURS.default): { invite: PendingInvite; token: string } {
    if (!Number.isFinite(hours) || hours <= 0 || hours > INVITE_HOURS.max)
      throw new PeopleError(400, `An invite lasts from an hour to ${INVITE_HOURS.max / 24} days.`);
    this.prune();
    const token = newToken();
    const t = this.now();
    const invite: PendingInvite = {
      id: randomUUID(),
      role,
      createdAt: this.iso(t),
      expiresAt: this.iso(t + hours * 3600_000),
    };
    this.data.invites.push({ ...invite, hash: hashOf(token) });
    this.persist();
    return { invite, token };
  }

  /** The invite behind a link, while it can still be used. */
  checkInvite(token: string): PendingInvite | null {
    this.prune();
    const i = findByHash(token, this.data.invites);
    if (!i) return null;
    const { hash: _, ...pub } = i;
    return pub;
  }

  cancelInvite(id: string) {
    const before = this.data.invites.length;
    this.data.invites = this.data.invites.filter((i) => i.id !== id);
    if (this.data.invites.length === before) throw new PeopleError(404, 'That invite is gone already.');
    this.persist();
  }

  /** Use an invite: once only. Makes the person and signs them in. */
  async acceptInvite(token: string, rawName: string, pass: string) {
    const name = cleanName(rawName);
    const problem = passphraseProblem(pass);
    if (problem) throw new PeopleError(400, problem);
    const hash = await hashPassphrase(pass);
    // Checked again after the slow hash, so two tabs racing with one link can't both get in.
    this.prune();
    const invite = findByHash(token, this.data.invites);
    if (!invite) throw new PeopleError(404, 'This invite has been used or has expired. Ask for a new one.');
    if (this.byName(name))
      throw new PeopleError(409, `Someone here is already called ${name}. Choose another name.`);
    this.data.invites = this.data.invites.filter((i) => i !== invite);
    const p: StoredPerson = { id: randomUUID(), name, role: invite.role, pass: hash, createdAt: this.iso() };
    this.data.people.push(p);
    this.persist();
    return { person: { id: p.id, name: p.name, role: p.role }, token: this.startSession(p.id) };
  }

  /** A session token for a correct name and passphrase, or null. Unknown names cost as much time as known ones. */
  async signIn(name: string, pass: string): Promise<{ person: Signed['person']; token: string } | null> {
    const p = this.byName(name.normalize('NFC').replace(/\s+/g, ' ').trim());
    if (!p) {
      decoy ??= hashPassphrase(randomBytes(16).toString('hex'));
      await verifyPassphrase(pass, await decoy);
      return null;
    }
    if (!(await verifyPassphrase(pass, p.pass))) return null;
    // A sign-in always starts a fresh session, so a token planted before it is worth nothing.
    return { person: { id: p.id, name: p.name, role: p.role }, token: this.startSession(p.id) };
  }

  private startSession(personId: string): string {
    this.prune();
    const token = newToken();
    const t = this.now();
    this.sessions.push({
      hash: hashOf(token),
      personId,
      issuedAt: t,
      signedInAt: t,
      lastSeenAt: t,
      replacedAt: null,
    });
    this.persistSessions();
    return token;
  }

  /** Who a session cookie belongs to, rotating it when it is due. */
  authenticate(token: string): Signed | null {
    const s = findByHash(token, this.sessions);
    const t = this.now();
    if (!s || !this.alive(s, t)) return null;
    const p = this.data.people.find((x) => x.id === s.personId)!;
    let rotated: string | null = null;
    let session = s.hash;
    if (!s.replacedAt && t - s.issuedAt >= SESSION.rotateMs) {
      rotated = newToken();
      s.replacedAt = t;
      session = hashOf(rotated);
      this.sessions.push({ ...s, hash: session, issuedAt: t, lastSeenAt: t, replacedAt: null });
      this.persistSessions();
    } else if (t - s.lastSeenAt > 60_000) {
      s.lastSeenAt = t;
      // Last-seen times are worth a write a minute at most.
      if (t - this.lastSessionSave > 60_000) this.persistSessions();
    }
    return { person: { id: p.id, name: p.name, role: p.role }, session, rotated };
  }

  /** Whether a session (by its id) still stands, and as whom: event streams ask after every change. */
  session(id: string): Signed['person'] | null {
    const s = this.sessions.find((x) => x.hash === id);
    if (!s || !this.alive(s, this.now())) return null;
    return this.get(s.personId) ?? null;
  }

  signOut(token: string) {
    const s = findByHash(token, this.sessions);
    if (!s) return;
    // Its replacement, if it was just rotated, goes with it.
    const linked = new Set(
      this.sessions
        .filter((x) => x.personId === s.personId && x.signedInAt === s.signedInAt)
        .map((x) => x.hash),
    );
    this.sessions = this.sessions.filter((x) => !linked.has(x.hash));
    this.persistSessions();
    this.changed();
  }

  setRole(id: string, role: Role, by: string | null) {
    const p = this.data.people.find((x) => x.id === id);
    if (!p) throw new PeopleError(404, 'There’s no one like that here.');
    if (p.id === by) throw new PeopleError(409, 'You can’t change your own role.');
    if (
      p.role === 'owner' &&
      role !== 'owner' &&
      this.data.people.filter((x) => x.role === 'owner').length === 1
    )
      throw new PeopleError(409, `${p.name} is the only owner. Make someone else an owner first.`);
    p.role = role;
    this.persist();
    this.changed();
    return this.get(id)!;
  }

  /** Remove someone: their account and every session, at once. Their films stay, for the owner. */
  revoke(id: string, by: string | null) {
    const p = this.data.people.find((x) => x.id === id);
    if (!p) throw new PeopleError(404, 'There’s no one like that here.');
    if (p.id === by) throw new PeopleError(409, 'You can’t remove yourself. Sign out instead.');
    if (p.role === 'owner' && this.data.people.filter((x) => x.role === 'owner').length === 1)
      throw new PeopleError(
        409,
        `${p.name} is the only owner. To change the passphrase, run \`hildegard host owner\` on this computer.`,
      );
    this.data.people = this.data.people.filter((x) => x !== p);
    this.sessions = this.sessions.filter((s) => s.personId !== id);
    this.persist();
    this.persistSessions();
    this.changed();
    return { id: p.id, name: p.name };
  }

  /** Find someone by name, for the command line. */
  find(name: string) {
    const p = this.byName(name.trim());
    return p ? this.get(p.id)! : undefined;
  }
}
