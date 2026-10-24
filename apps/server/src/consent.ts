// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Living consent: a voice is cloned only from someone who, just now and in their own voice, said they agree.
 *
 * 1. Hildegard makes a fresh consent line with the speaker's name and four random words. It lasts ten minutes, so a
 *    recording made earlier, or one made by AI from earlier words, can't say it.
 * 2. The speaker reads it aloud, here or on their own phone through a link.
 * 3. Before anything is made: Whisper must hear the line (every random word, and most of the rest); the recording
 *    must not carry Hildegard's AI watermark; and every sample to clone from must be the same voice as the one that
 *    said the line, by a speaker fingerprint.
 * 4. The result is a certificate this install signs (Ed25519), holding hashes of the consent recording and every
 *    sample. Revoking it deletes the voice's reference audio, so nothing more can be made with it.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomInt,
  sign,
  verify,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Short, common, unmistakable words: no homophones, nothing Whisper spells two ways. */
const WORDS = (
  'amber anchor apple arrow autumn badger basket beacon blanket bramble breeze bridge candle canyon carpet castle ' +
  'cedar chapel cherry cinder clover cobalt comet copper cotton cradle crystal dolphin dragon ember falcon feather ' +
  'fiddle forest fossil garden ginger glacier granite harbor harvest hazel helmet honey island ivory jasmine jungle ' +
  'kettle ladder lantern lemon linen lobster magnet maple marble meadow mirror mitten monkey mountain mustard needle ' +
  'nickel noodle oatmeal ocean olive orbit orchard oyster paddle panther parrot pebble pepper pickle pigeon pillow ' +
  'planet pocket pumpkin puzzle quarry rabbit radish raven ribbon river rocket saddle salmon satchel shadow silver ' +
  'spider spinach squirrel sunset tablet thunder timber tomato trumpet tulip tunnel turtle velvet violin walnut ' +
  'walrus whistle willow window winter zebra'
).split(' ');

export interface ConsentLine {
  text: string;
  /** The random words: every one must be heard. */
  challenge: string[];
}

/** A fresh consent line for this speaker. */
export function consentLine(speaker: string, pick: (n: number) => number = randomInt): ConsentLine {
  const pool = [...WORDS];
  const challenge: string[] = [];
  for (let i = 0; i < 4; i++) challenge.push(pool.splice(pick(pool.length), 1)[0]!);
  return {
    text: `My name is ${speaker}. I agree that Hildegard may make a copy of my voice. ${challenge.join(' ')}.`,
    challenge,
  };
}

/** Lower case, letters and digits only, one word apart. */
export const words = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * How much of the line was heard, in order, 0 to 1 (the longest common run of words over the line's length), and
 * which random words were missing.
 */
export function heardLine(line: ConsentLine, heard: string): { score: number; missing: string[] } {
  const a = words(line.text);
  const b = words(heard);
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  const got = new Set(b);
  return {
    score: a.length ? dp[a.length]![b.length]! / a.length : 0,
    missing: line.challenge.filter((w) => !got.has(w)),
  };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** What the certificate says. Every field is signed. */
export interface CertificateBody {
  v: 1;
  kind: 'hildegard-voice-consent';
  voice: string;
  speaker: string;
  relation: 'self' | 'agreed' | 'licensed';
  line: string;
  /** How it was recorded: in the Studio, or on the speaker's own device through a link. */
  via: 'here' | 'link';
  recordedAt: string;
  until: string | null;
  consentSha256: string;
  samplesSha256: string[];
  /** Lowest likeness of a sample to the consent recording, and how sure Whisper was of the line. */
  match: number;
  heard: number;
  /** The install that checked and signed it: the SHA-256 of its public key. */
  install: string;
  issuedAt: string;
}

export interface Certificate {
  body: CertificateBody;
  /** Ed25519 over the body's JSON, base64url. */
  signature: string;
  /** This install's public key, PEM, so anyone can check it. */
  publicKey: string;
}

/** This install's signing key, made once and kept in its data folder (readable by the owner only). */
export class ConsentSigner {
  private readonly key: KeyObject;
  readonly publicKey: string;
  readonly fingerprint: string;

  constructor(dataDir: string) {
    const file = join(dataDir, 'voice', 'consent-key.pem');
    let key: KeyObject | null = null;
    try {
      key = createPrivateKey(readFileSync(file, 'utf8'));
      if (key.asymmetricKeyType !== 'ed25519') key = null;
    } catch {}
    if (!key) {
      key = generateKeyPairSync('ed25519').privateKey;
      mkdirSync(join(dataDir, 'voice'), { recursive: true, mode: 0o700 });
      writeFileSync(file, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    this.key = key;
    this.publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
    this.fingerprint = createHash('sha256')
      .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
      .digest('hex');
  }

  sign(body: Omit<CertificateBody, 'install' | 'issuedAt' | 'v' | 'kind'>): Certificate {
    const full: CertificateBody = {
      v: 1,
      kind: 'hildegard-voice-consent',
      ...body,
      install: this.fingerprint,
      issuedAt: new Date().toISOString(),
    };
    return {
      body: full,
      signature: sign(null, Buffer.from(JSON.stringify(full)), this.key).toString('base64url'),
      publicKey: this.publicKey,
    };
  }
}

/** Whether a certificate's signature holds for its own public key, and whether that key is this install's. */
export function checkCertificate(c: Certificate, ours?: string): { valid: boolean; ours: boolean } {
  try {
    const key = createPublicKey(c.publicKey);
    const valid = verify(
      null,
      Buffer.from(JSON.stringify(c.body)),
      key,
      Buffer.from(c.signature, 'base64url'),
    );
    const fp = createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    return { valid: valid && fp === c.body.install, ours: valid && fp === ours };
  } catch {
    return { valid: false, ours: false };
  }
}

export const newToken = () => randomBytes(24).toString('base64url');
