// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Short one-time codes, `HG-XXXX-XXXX`: something a person types, instead of pasting a long blob or a passphrase.
 * Crockford base32 (no I, L, O or U), 40 random bits, good for 10 minutes and once. Only the SHA-256 of a code is
 * kept, with its expiry. Forty bits is guessable by someone who can try without limit, so every place that takes a
 * code counts the wrong ones (per source, and for the whole device) and stops: see `CODE_LIMITS`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_TTL_MS = 10 * 60_000;
/** The canonical form: `HG-` and two groups of four. */
export const CODE_RE = /^HG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * Wrong tries allowed in 15 minutes: per source address, and across every source (so a spread-out guesser is
 * stopped too). The global cap means someone can lock out enrolling for 15 minutes with 60 bad guesses; a code that
 * is already valid works until then, and enrolling is the only thing that stops, never anything already paired.
 */
export const CODE_LIMITS = { perSource: 5, global: 60, windowMs: 15 * 60_000 } as const;

/** A fresh code: 5 random bytes, as eight 5-bit symbols. */
export function newCode(bytes: (n: number) => Buffer = randomBytes): string {
  const b = bytes(5);
  let bits = 0n;
  for (const x of b) bits = (bits << 8n) | BigInt(x);
  let s = '';
  for (let i = 7; i >= 0; i--) s += CODE_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `HG-${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * What was typed, as the canonical code, or null when it can't be one. Case, spaces and dashes don't matter, and
 * Crockford's look-alikes are read as what they stand for (O as 0, I and L as 1); the `HG` may be left off.
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  let s = raw
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.startsWith('HG') && s.length === 10) s = s.slice(2);
  if (s.length !== 8 || ![...s].every((ch) => CODE_ALPHABET.includes(ch))) return null;
  return `HG-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** What a code looks like, to tell a short code from a long `hgc1_` one. */
export const looksLikeCode = (raw: string) =>
  normalizeCode(raw.trim()) !== null && !/^hgc1_/i.test(raw.trim());

export const hashCode = (canonical: string) => createHash('sha256').update(canonical, 'utf8').digest('hex');

interface Stored<T> {
  hash: string;
  expiresAt: number;
  data: T;
}

/**
 * The live codes of one kind. Kept in memory and in a 0600 file next to the rest of the data, as hashes. Taking a code
 * deletes it in the same synchronous step that finds it, so two redemptions at once can't both win; nothing here
 * waits on a lock or a file before answering "is this live".
 */
export class CodeBook<T> {
  private codes: Stored<T>[];
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly file: string | null;
  private readonly max: number;

  constructor(opts: { file?: string; now?: () => number; ttlMs?: number; max?: number } = {}) {
    this.file = opts.file ?? null;
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? CODE_TTL_MS;
    this.max = opts.max ?? 20;
    this.codes = [];
    if (this.file)
      try {
        const j = JSON.parse(readFileSync(this.file, 'utf8')) as { codes?: Stored<T>[] };
        if (Array.isArray(j.codes))
          this.codes = j.codes.filter(
            (c) => typeof c?.hash === 'string' && typeof c.expiresAt === 'number' && c.expiresAt > this.now(),
          );
      } catch {}
  }

  private prune() {
    const t = this.now();
    this.codes = this.codes.filter((c) => c.expiresAt > t);
  }

  private persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ codes: this.codes }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** A new code for `data`. The oldest live code goes when there are too many. */
  mint(data: T): { code: string; expiresAt: number } {
    this.prune();
    const code = newCode();
    const expiresAt = this.now() + this.ttl;
    this.codes.push({ hash: hashCode(code), expiresAt, data });
    while (this.codes.length > this.max) this.codes.shift();
    this.persist();
    return { code, expiresAt };
  }

  /** Whether `code` is live, without using it. */
  live(code: string | null): boolean {
    if (!code) return false;
    const h = hashCode(code);
    const t = this.now();
    return this.codes.some((c) => c.hash === h && c.expiresAt > t);
  }

  /** Use `code`: what it was minted for, or null when it is wrong, used or expired. Good once. */
  take(code: string | null): T | null {
    if (!code) return null;
    const h = hashCode(code);
    const t = this.now();
    const i = this.codes.findIndex((c) => c.hash === h);
    if (i < 0) return null;
    const [c] = this.codes.splice(i, 1);
    this.persist();
    return c!.expiresAt > t ? c!.data : null;
  }

  /** Forget every code (sharing stopped, say). */
  clear() {
    this.codes = [];
    this.persist();
  }
}
