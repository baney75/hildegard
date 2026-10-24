// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Consent for characters based on real people. Hildegard draws a real person only from photos they took of
 * themselves, live, on a one-time link, as they agreed in their own words; nobody else's photos of them ever count.
 *
 *  1. Whoever makes the character asks for a link (`start`): a fresh 256-bit token, kept only as its SHA-256, good for
 *     24 hours and for one answer.
 *  2. The person opens it on their own phone or computer, reads what they are agreeing to, types their name and takes
 *     three photos with the camera there (facing, turned, in profile). The page can't take a file instead.
 *  3. `give` keeps the photos as the character's references and signs a record (Ed25519, this install's own key) of
 *     who agreed, to what, when, and the SHA-256 of each photo. The person gets a second one-time token to take it
 *     back; using it, or the maker's own Revoke, stops the character at once and deletes the photos.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long a consent link works. */
export const CONSENT_HOURS = 24;
/** Photos the person takes: facing the camera, turned three-quarters, and in profile. */
export const CONSENT_PHOTOS = ['portrait', 'three-quarter', 'profile'] as const;
/** Each photo, at most. A phone camera frame as JPEG is well under this. */
export const MAX_CONSENT_PHOTO = 10 * 1024 * 1024;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** What the person agrees to, in full, as the page shows it and the record keeps it. */
export function statement(o: { person: string; maker: string; character: string }): string {
  return (
    `I’m ${o.person}. These photos are of me, taken just now, and I agree that ${o.maker} may use my likeness ` +
    `for the character “${o.character}” in Hildegard, to make pictures and videos. I can take this back at any ` +
    'time with the link Hildegard gives me, and then the character stops at once.'
  );
}

export interface ConsentRecord {
  kind: 'hildegard-likeness-consent';
  version: 1;
  id: string;
  character: { id: string; name: string };
  maker: string;
  person: string;
  statement: string;
  /** SHA-256 of each photo, in CONSENT_PHOTOS order. */
  photos: string[];
  givenAt: string;
  /** SHA-256 of the install's public key (DER), so a record names the key that signed it. */
  key: string;
}

export interface SignedConsent {
  record: ConsentRecord;
  /** Ed25519 over the record's canonical JSON, base64. */
  signature: string;
  /** The public key, PEM, so anyone holding the record can check it. */
  publicKey: string;
  revokedAt: string | null;
}

interface Pending {
  hash: string;
  characterId: string;
  character: string;
  maker: string;
  expiresAt: string;
}

interface Given {
  /** SHA-256 of the person's own revoke token. */
  revokeHash: string;
  characterId: string;
  consent: SignedConsent;
}

interface FileShape {
  version: 1;
  pending: Pending[];
  given: Given[];
}

/** JSON with sorted keys, so the same record always signs to the same bytes. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Whether a signed consent is intact: its signature checks out under the key it carries, and names that key. */
export function checkConsent(c: SignedConsent): boolean {
  try {
    const key = createPublicKey(c.publicKey);
    if (sha256(key.export({ type: 'spki', format: 'der' })) !== c.record.key) return false;
    return verify(null, Buffer.from(canonical(c.record)), key, Buffer.from(c.signature, 'base64'));
  } catch {
    return false;
  }
}

export class LikenessError extends Error {
  readonly status: 400 | 404 | 409 | 410;
  constructor(message: string, status: 400 | 404 | 409 | 410) {
    super(message);
    this.status = status;
  }
}

/** Consent links and signed records, in `<data>/likeness/` (0600). */
export class Likeness {
  private readonly dir: string;
  private readonly file: string;
  private readonly key: KeyObject;
  private readonly publicPem: string;
  private readonly keyId: string;
  private state: FileShape;
  private readonly now: () => number;

  constructor(dataDir: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.dir = join(dataDir, 'likeness');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.file = join(this.dir, 'consent.json');
    const keyFile = join(this.dir, 'signing-key.pem');
    if (!existsSync(keyFile)) {
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    this.key = createPrivateKey(readFileSync(keyFile));
    const pub = createPublicKey(this.key);
    this.publicPem = pub.export({ type: 'spki', format: 'pem' }).toString();
    this.keyId = sha256(pub.export({ type: 'spki', format: 'der' }));
    try {
      this.state = JSON.parse(readFileSync(this.file, 'utf8')) as FileShape;
    } catch {
      this.state = { version: 1, pending: [], given: [] };
    }
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private prune() {
    const now = this.now();
    this.state.pending = this.state.pending.filter((p) => Date.parse(p.expiresAt) > now);
  }

  private find(token: string): Pending | undefined {
    if (!TOKEN_RE.test(token)) return undefined;
    this.prune();
    const h = Buffer.from(sha256(token), 'hex');
    return this.state.pending.find((p) => timingSafeEqual(Buffer.from(p.hash, 'hex'), h));
  }

  /** A new link for a character; any earlier link for it stops working. The token is shown once, never stored. */
  start(o: { characterId: string; character: string; maker: string }): { token: string; expiresAt: string } {
    this.prune();
    this.state.pending = this.state.pending.filter((p) => p.characterId !== o.characterId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now() + CONSENT_HOURS * 3600_000).toISOString();
    this.state.pending.push({ hash: sha256(token), expiresAt, ...o });
    this.save();
    return { token, expiresAt };
  }

  /** What a link asks, for the page the person opens; null when it is unknown, used or expired. */
  lookup(token: string): { characterId: string; character: string; maker: string; expiresAt: string } | null {
    const p = this.find(token);
    return p
      ? { characterId: p.characterId, character: p.character, maker: p.maker, expiresAt: p.expiresAt }
      : null;
  }

  /** The person said no: the link stops working. */
  decline(token: string): string {
    const p = this.find(token);
    if (!p) throw new LikenessError('This link has expired or was already used.', 410);
    this.state.pending = this.state.pending.filter((x) => x !== p);
    this.save();
    return p.characterId;
  }

  /**
   * The person agreed and took their photos: sign the record. Returns it with the token they keep to take it back.
   * The caller has checked the photos are images and keeps them as the character's references.
   */
  give(
    token: string,
    person: string,
    photos: Buffer[],
  ): { consent: SignedConsent; revokeToken: string; characterId: string } {
    const p = this.find(token);
    if (!p) throw new LikenessError('This link has expired or was already used.', 410);
    const name = person.trim();
    if (!name || name.length > 80 || /[\n\r]/.test(name))
      throw new LikenessError('Type your name as you use it.', 400);
    if (photos.length !== CONSENT_PHOTOS.length)
      throw new LikenessError(`Take all ${CONSENT_PHOTOS.length} photos.`, 400);
    if (new Set(photos.map((b) => sha256(b))).size !== photos.length)
      throw new LikenessError('Take each photo fresh: these are the same picture more than once.', 400);
    const record: ConsentRecord = {
      kind: 'hildegard-likeness-consent',
      version: 1,
      id: randomBytes(8).toString('hex'),
      character: { id: p.characterId, name: p.character },
      maker: p.maker,
      person: name,
      statement: statement({ person: name, maker: p.maker, character: p.character }),
      photos: photos.map((b) => sha256(b)),
      givenAt: new Date(this.now()).toISOString(),
      key: this.keyId,
    };
    const consent: SignedConsent = {
      record,
      signature: sign(null, Buffer.from(canonical(record)), this.key).toString('base64'),
      publicKey: this.publicPem,
      revokedAt: null,
    };
    const revokeToken = randomBytes(32).toString('base64url');
    this.state.pending = this.state.pending.filter((x) => x !== p);
    // One consent stands per character: a new one replaces what came before.
    this.state.given = this.state.given.filter((g) => g.characterId !== p.characterId || g.consent.revokedAt);
    this.state.given.push({ revokeHash: sha256(revokeToken), characterId: p.characterId, consent });
    this.save();
    return { consent, revokeToken, characterId: p.characterId };
  }

  /** The signed record a character's consent rests on, revoked or not. */
  record(characterId: string): SignedConsent | null {
    const all = this.state.given.filter((g) => g.characterId === characterId);
    return (all.find((g) => !g.consent.revokedAt) ?? all.at(-1))?.consent ?? null;
  }

  /** Take consent back: by the person's own token, or by the character's id for its maker. */
  revoke(by: { token: string } | { characterId: string }): string | null {
    let g: Given | undefined;
    if ('token' in by) {
      if (!TOKEN_RE.test(by.token)) return null;
      const h = Buffer.from(sha256(by.token), 'hex');
      g = this.state.given.find((x) => timingSafeEqual(Buffer.from(x.revokeHash, 'hex'), h));
    } else g = this.state.given.find((x) => x.characterId === by.characterId && !x.consent.revokedAt);
    // Waiting links for it stop too.
    if ('characterId' in by)
      this.state.pending = this.state.pending.filter((p) => p.characterId !== by.characterId);
    if (!g) {
      this.save();
      return null;
    }
    g.consent.revokedAt ??= new Date(this.now()).toISOString();
    this.save();
    return g.characterId;
  }

  /** Forget everything about a deleted character but the fact that consent was taken back. */
  forget(characterId: string) {
    this.state.pending = this.state.pending.filter((p) => p.characterId !== characterId);
    for (const g of this.state.given)
      if (g.characterId === characterId) g.consent.revokedAt ??= new Date(this.now()).toISOString();
    this.save();
  }
}
