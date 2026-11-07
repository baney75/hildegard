// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recording from any chat. A chat can't reliably use the microphone itself, so it asks Hildegard for a link
 * (`makeLink`) and shows it. The person opens that link on a device with a microphone or camera, records on Hildegard's
 * own page, listens or watches it back, and sends it. The link is the credential, so:
 *
 *  - the token is 256 random bits and only its SHA-256 is kept (`<data>/record/recordings.json`, 0600), so a copy of
 *    that file opens nothing;
 *  - it lasts 30 minutes and takes one upload; a refused file (wrong type, too big) doesn't use it up;
 *  - it belongs to the person who asked for it, and so does what comes of it: nobody else is told it exists (the
 *    owner of this Hildegard and this computer see everything, as they do for films; a director sees only their own);
 *  - it is never written to a log, and never comes back from anything but the call that made it.
 *
 * What arrives is stored under `<media>/recordings/<person>/<id>.<ext>`, with an id of its own. Cleaning it
 * (`record-clean.ts`) makes a second recording from it, never replacing the first.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sniffAudio } from './voice.ts';

export type RecordKind = 'voice' | 'video';

/** How long a link works. */
export const LINK_MINUTES = 30;
/** The most one upload may be: sound only, or camera and sound. */
export const MAX_BYTES: Record<RecordKind, number> = { voice: 100 * 1024 * 1024, video: 500 * 1024 * 1024 };
/** A person's links waiting to be used, at most; the oldest goes when they ask for more. */
const MAX_PENDING = 20;
/** Unused links stay on file this long past their end, so the page can say "expired" instead of "unknown". */
const KEEP_EXPIRED_MS = 24 * 3600_000;

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const ID_RE = /^rec_[0-9a-f]{16}$/;
const OWNER_RE = /^[A-Za-z0-9-]{1,64}$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const newId = () => `rec_${randomBytes(8).toString('hex')}`;

export class RecordError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 502;
  readonly code: string;
  constructor(status: RecordError['status'], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Entry {
  id: string;
  /** 'local' (this computer) or the person's id. */
  owner: string;
  kind: RecordKind;
  purpose: string | null;
  filmId: string | null;
  createdAt: string;
  /** SHA-256 of the link's token; null for a recording made from another (cleaned) or brought in. */
  hash: string | null;
  expiresAt: number | null;
  state: 'pending' | 'received';
  /** Relative to the recordings folder: `<owner>/<id>.<ext>`. */
  file: string | null;
  bytes: number | null;
  seconds: number | null;
  receivedAt: string | null;
  /** The recording this one was cleaned from. */
  from: string | null;
  clean: { lufs: number; truePeak: number; targetLufs: number; peak: number; backend: string } | null;
}

/** What a recording looks like to the person who owns it. Never the token, never the link. */
export interface RecordingView {
  id: string;
  kind: RecordKind;
  purpose: string | null;
  filmId: string | null;
  status: 'pending' | 'received' | 'expired';
  expiresAt: string | null;
  receivedAt: string | null;
  seconds: number | null;
  bytes: number | null;
  /** Under /media, for the Studio and for signed links. Null until it arrives. */
  url: string | null;
  from: string | null;
  clean: Entry['clean'];
}

/** What the page behind a link may know: what is asked of the person, and whether it still can be done. */
export interface LinkView {
  kind: RecordKind;
  purpose: string | null;
  expiresAt: string;
  state: 'pending' | 'received';
  maxBytes: number;
}

export interface MediaInfo {
  seconds: number;
  audio: boolean;
  video: boolean;
}

/** The video containers a browser or phone writes. */
export function sniffVideo(b: Uint8Array): 'webm' | 'mp4' | 'mov' | null {
  const at = (o: number, s: string) => [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (at(4, 'ftyp')) return at(8, 'qt  ') ? 'mov' : 'mp4';
  return null;
}

/** The file type of a recording by its first bytes, or null. A voice is audio; a video may be a camera's container. */
export function sniffRecording(b: Uint8Array, kind: RecordKind | 'auto'): string | null {
  const audio = kind === 'video' ? null : sniffAudio(b);
  if (audio) return audio;
  if (kind === 'voice') return null;
  return sniffVideo(b);
}

interface FileShape {
  version: 1;
  entries: Entry[];
}

export interface RecordOptions {
  dataDir: string;
  mediaDir: string;
  now?: () => number;
  /** What a file holds and how long it is; null when that can't be read here (no Python). */
  probe?: (file: string) => Promise<MediaInfo | null>;
  /** Smaller caps than MAX_BYTES, for tests. */
  maxBytes?: Partial<Record<RecordKind, number>>;
}

export class RecordStore {
  private readonly file: string;
  private readonly root: string;
  private readonly now: () => number;
  private readonly probe: (file: string) => Promise<MediaInfo | null>;
  private readonly max: Record<RecordKind, number>;
  private entries: Entry[] = [];
  /** Links an upload is in the middle of: a second upload at the same moment is refused. */
  private readonly busy = new Set<string>();

  constructor(opts: RecordOptions) {
    this.now = opts.now ?? Date.now;
    this.probe = opts.probe ?? (async () => null);
    this.max = { ...MAX_BYTES, ...opts.maxBytes };
    this.root = join(opts.mediaDir, 'recordings');
    const dir = join(opts.dataDir, 'record');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.root, { recursive: true });
    this.file = join(dir, 'recordings.json');
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      if (Array.isArray(j.entries)) this.entries = j.entries.filter((e) => ID_RE.test(e?.id));
    } catch {}
  }

  private persist() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries } satisfies FileShape), {
      mode: 0o600,
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  private prune() {
    const t = this.now();
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => e.state === 'received' || e.expiresAt === null || e.expiresAt + KEEP_EXPIRED_MS > t,
    );
    if (this.entries.length !== before) this.persist();
  }

  /** The absolute path of a received recording. */
  path(e: Entry): string | null {
    return e.file ? join(this.root, e.file) : null;
  }

  /** The URL under /media of a received recording. */
  url(e: Entry): string | null {
    return e.file ? `/media/recordings/${e.file}` : null;
  }

  // ── Links ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** A fresh link for `owner`. The token comes back here once and is kept only as its hash. */
  makeLink(
    owner: string,
    o: { kind: RecordKind; purpose?: string | null; filmId?: string | null },
  ): { id: string; token: string; expiresAt: number } {
    if (!OWNER_RE.test(owner)) throw new RecordError(400, 'owner', 'Who is asking?');
    this.prune();
    const mine = this.entries.filter((e) => e.owner === owner && e.state === 'pending' && e.hash);
    while (mine.length >= MAX_PENDING) this.entries.splice(this.entries.indexOf(mine.shift()!), 1);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + LINK_MINUTES * 60_000;
    const purpose =
      o.purpose
        ?.replace(/\p{Cc}+/gu, ' ')
        .trim()
        .slice(0, 200) || null;
    const e: Entry = {
      id: newId(),
      owner,
      kind: o.kind,
      purpose,
      filmId: o.filmId ?? null,
      createdAt: new Date(this.now()).toISOString(),
      hash: sha256(token),
      expiresAt,
      state: 'pending',
      file: null,
      bytes: null,
      seconds: null,
      receivedAt: null,
      from: null,
      clean: null,
    };
    this.entries.push(e);
    this.persist();
    return { id: e.id, token, expiresAt };
  }

  /** The entry a token opens, with whether it can still be used: live, used, expired, or null when nobody knows it. */
  find(token: string): { entry: Entry; link: 'live' | 'used' | 'expired' } | null {
    if (!TOKEN_RE.test(token)) return null;
    const h = Buffer.from(sha256(token), 'hex');
    const entry = this.entries.find((e) => {
      const mine = e.hash ? Buffer.from(e.hash, 'hex') : null;
      return mine?.length === h.length && timingSafeEqual(mine, h);
    });
    if (!entry) return null;
    if (entry.state === 'received') return { entry, link: 'used' };
    return { entry, link: (entry.expiresAt ?? 0) <= this.now() ? 'expired' : 'live' };
  }

  /** Whether the page for a token may be shown: 404 for a token nobody knows, 410 for one that ran out. */
  gate(token: string): 'ok' | 'unknown' | 'expired' {
    const f = this.find(token);
    if (!f) return 'unknown';
    return f.link === 'expired' ? 'expired' : 'ok';
  }

  /** What the page behind a link shows. */
  link(token: string): LinkView {
    const f = this.find(token);
    if (!f) throw new RecordError(404, 'unknown', 'This link doesn’t work. Ask for a new one.');
    if (f.link === 'expired')
      throw new RecordError(
        410,
        'expired',
        'This link has run out. Ask for a new one; each works for 30 minutes.',
      );
    const e = f.entry;
    return {
      kind: e.kind,
      purpose: e.purpose,
      expiresAt: new Date(e.expiresAt!).toISOString(),
      state: e.state,
      maxBytes: this.max[e.kind],
    };
  }

  // ── Receiving ──────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The upload a link was made for. `body` is the request's bytes, read as they arrive and refused as soon as they
   * go over the cap or their first bytes aren't the right kind of file, so a big or wrong file never fills the disk.
   */
  async receive(
    token: string,
    body: ReadableStream<Uint8Array> | null,
    declared?: number,
  ): Promise<RecordingView> {
    const f = this.find(token);
    if (!f) throw new RecordError(404, 'unknown', 'This link doesn’t work. Ask for a new one.');
    const e = f.entry;
    if (f.link === 'expired')
      throw new RecordError(
        410,
        'expired',
        'This link has run out. Ask for a new one; each works for 30 minutes.',
      );
    if (f.link === 'used' || this.busy.has(e.id))
      throw new RecordError(409, 'used', 'This link has been used already. Ask for a new one.');
    this.busy.add(e.id);
    try {
      const stored = await this.store(e.owner, e.id, e.kind, body, declared);
      Object.assign(e, stored, { state: 'received', receivedAt: new Date(this.now()).toISOString() });
      this.persist();
      return this.view(e);
    } finally {
      this.busy.delete(e.id);
    }
  }

  /** A recording brought in from somewhere else (an agent's file), for cleaning or a film. */
  async import(
    owner: string,
    kind: RecordKind | 'auto',
    body: ReadableStream<Uint8Array> | null,
    declared?: number,
  ): Promise<RecordingView> {
    if (!OWNER_RE.test(owner)) throw new RecordError(400, 'owner', 'Who is asking?');
    const id = newId();
    const stored = await this.store(owner, id, kind, body, declared);
    const e: Entry = {
      id,
      owner,
      kind: stored.kind,
      purpose: null,
      filmId: null,
      createdAt: new Date(this.now()).toISOString(),
      hash: null,
      expiresAt: null,
      state: 'received',
      file: stored.file,
      bytes: stored.bytes,
      seconds: stored.seconds,
      receivedAt: new Date(this.now()).toISOString(),
      from: null,
      clean: null,
    };
    this.entries.push(e);
    this.persist();
    return this.view(e);
  }

  /** Writes the bytes, checks them, and says where they went. Nothing is left behind when it refuses. */
  private async store(
    owner: string,
    id: string,
    asked: RecordKind | 'auto',
    body: ReadableStream<Uint8Array> | null,
    declared?: number,
  ): Promise<{ kind: RecordKind; file: string; bytes: number; seconds: number | null }> {
    const cap = this.max[asked === 'auto' ? 'video' : asked];
    const sizeError = () =>
      new RecordError(
        413,
        'size',
        asked === 'video'
          ? 'Video up to 500 MB. Record a shorter one.'
          : asked === 'voice'
            ? 'Voice recordings up to 100 MB. Record a shorter one.'
            : 'Recordings up to 500 MB (100 MB for sound only).',
      );
    if (declared !== undefined && declared > cap) throw sizeError();
    if (!body) throw new RecordError(400, 'empty', 'That recording is empty.');
    const dir = join(this.root, owner);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${id}.part`);
    const fh = await open(tmp, 'w', 0o600);
    let size = 0;
    let ext: string | null = null;
    let head = new Uint8Array(0);
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > cap) throw sizeError();
        if (!ext) {
          const joined = new Uint8Array(head.length + value.length);
          joined.set(head);
          joined.set(value, head.length);
          head = joined;
          // The first bytes decide the type; wait for a dozen before judging.
          if (head.length >= 12) {
            ext = sniffRecording(head, asked);
            if (!ext) throw this.notRecording(asked);
          }
        }
        await fh.write(value);
      }
      if (!size) throw new RecordError(400, 'empty', 'That recording is empty.');
      if (!ext) {
        ext = sniffRecording(head, asked);
        if (!ext) throw this.notRecording(asked);
      }
    } catch (err) {
      // Past the cap there is no point reading on. For a wrong kind of file the caller reads a modest rest of the
      // body before answering, so the answer reaches the sender instead of a closed socket.
      if (err instanceof RecordError && err.status === 413) await reader.cancel().catch(() => {});
      else reader.releaseLock();
      await fh.close().catch(() => {});
      await rm(tmp, { force: true });
      throw err;
    }
    await fh.close();
    const name = `${owner}/${id}.${ext}`;
    const dest = join(this.root, name);
    renameSync(tmp, dest);
    const info = await this.probe(dest).catch(() => null);
    // What a file holds settles what kind of recording it is. A voice has no picture; a video has one.
    let kind: RecordKind = asked === 'auto' ? (info?.video ? 'video' : 'voice') : asked;
    let refuse: string | null = null;
    if (info) {
      if (!info.audio && !info.video) refuse = 'Hildegard couldn’t read that recording.';
      else if (asked === 'voice' && info.video)
        refuse = 'That recording has a picture. A voice-over is sound only.';
      else if (asked === 'video' && !info.video)
        refuse = 'That recording has no picture. Record it with the camera.';
      else if (kind === 'video' && !info.video) kind = 'voice';
    }
    if (refuse) {
      rmSync(dest, { force: true });
      throw new RecordError(415, 'type', refuse);
    }
    return { kind, file: name, bytes: size, seconds: info?.seconds ?? null };
  }

  private notRecording(kind: RecordKind | 'auto') {
    return new RecordError(
      415,
      'type',
      kind === 'voice'
        ? 'That isn’t a sound recording. Use WAV, MP3, M4A, OGG, FLAC or WebM.'
        : 'That isn’t a recording Hildegard can use. Use WebM or MP4 for video, WAV, MP3, M4A, OGG, FLAC or WebM for sound.',
    );
  }

  // ── What is on file ────────────────────────────────────────────────────────────────────────────────────────

  get(id: string): Entry | undefined {
    return ID_RE.test(id) ? this.entries.find((e) => e.id === id) : undefined;
  }

  /** The recording a file under /media/recordings belongs to. */
  byFile(rel: string): Entry | undefined {
    return this.entries.find((e) => e.file === rel);
  }

  view(e: Entry): RecordingView {
    const expired = e.state === 'pending' && (e.expiresAt ?? 0) <= this.now();
    return {
      id: e.id,
      kind: e.kind,
      purpose: e.purpose,
      filmId: e.filmId,
      status: e.state === 'received' ? 'received' : expired ? 'expired' : 'pending',
      expiresAt: e.expiresAt === null ? null : new Date(e.expiresAt).toISOString(),
      receivedAt: e.receivedAt,
      seconds: e.seconds,
      bytes: e.bytes,
      url: this.url(e),
      from: e.from,
      clean: e.clean,
    };
  }

  /** A cleaned copy of `source`, as its own recording. */
  addCleaned(
    source: Entry,
    out: { file: string; bytes: number; seconds: number; clean: NonNullable<Entry['clean']> },
    id: string,
  ): Entry {
    const e: Entry = {
      id,
      owner: source.owner,
      kind: source.kind,
      purpose: source.purpose,
      filmId: source.filmId,
      createdAt: new Date(this.now()).toISOString(),
      hash: null,
      expiresAt: null,
      state: 'received',
      file: out.file,
      bytes: out.bytes,
      seconds: out.seconds,
      receivedAt: new Date(this.now()).toISOString(),
      from: source.id,
      clean: out.clean,
    };
    this.entries.push(e);
    this.persist();
    return e;
  }

  /** The folder a person's recordings go in. */
  dir(owner: string): string {
    const d = join(this.root, owner);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  exists(e: Entry): boolean {
    const p = this.path(e);
    return !!p && existsSync(p);
  }

  newId = newId;
}
