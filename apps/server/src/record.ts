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
 * An interview is a link with questions. The page shows one at a time; on Next it sends that answer's sound on its
 * own (`answer`), so the agent asking can hear it while the person goes on, and the agent may add a follow-up
 * (`ask`). Those don't use the link up: only the full recording at the end does, with a chapter for each question.
 * An interview runs longer than one take, so its link starts with an hour and each answer or follow-up moves the end
 * to 30 minutes past it, never past 4 hours from when it was made: 30 questions at two or three minutes each is 60 to
 * 90 minutes, and an idle link still closes 30 minutes after the last thing that happened, as a plain one does.
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
/** What the page records from: the camera, the screen, the screen with the camera in a bubble, or sound only. */
export type RecordSource = 'camera' | 'screen' | 'screen+camera' | 'voice';
export const SOURCES: readonly RecordSource[] = ['camera', 'screen', 'screen+camera', 'voice'];
/** The kind of recording a source makes. */
export const kindOf = (s: RecordSource): RecordKind => (s === 'voice' ? 'voice' : 'video');

/** The teleprompter's text, at most. */
export const MAX_SCRIPT = 20_000;
/** Questions a link may start with, and how many it may hold with follow-ups. */
export const MAX_QUESTIONS = 30;
export const MAX_ASKED = 60;
/** One question, at most. */
export const MAX_QUESTION = 500;
/** Chapters one recording may have. */
export const MAX_CHAPTERS = 200;
/** An interview's link: an hour to start, 30 minutes past each answer or follow-up, never past 4 hours. */
export const INTERVIEW_MINUTES = { start: 60, slide: 30, most: 240 };

/** A point in a recording, in seconds from its start, and what begins there. */
export interface Chapter {
  at: number;
  title: string;
}
/** One answer in an interview, sent on Next: its sound is a recording of its own (`media`). */
export interface Answer {
  index: number;
  question: string;
  /** Seconds into the full recording where the question was put. */
  at: number;
  media: string;
  receivedAt: string;
  /** The transcription job for it, when Hildegard can transcribe. */
  job: string | null;
}

/** How long a link works. */
export const LINK_MINUTES = 30;
/** The most one upload may be: sound only, or camera and sound. */
export const MAX_BYTES: Record<RecordKind, number> = { voice: 100 * 1024 * 1024, video: 500 * 1024 * 1024 };
/** What one person may bring in (not record by link) in a day, so no one can fill the disk for everyone else. */
export interface ImportLimits {
  perDay: number;
  bytesPerDay: number;
}
export const IMPORT_LIMITS: ImportLimits = { perDay: 20, bytesPerDay: 5 * 1024 ** 3 };
/** The limits, with the owner's own from HILDEGARD_RECORD_IMPORTS_PER_DAY and HILDEGARD_RECORD_IMPORT_GB_PER_DAY. */
export function importLimits(env: NodeJS.ProcessEnv = process.env): ImportLimits {
  const n = Number(env.HILDEGARD_RECORD_IMPORTS_PER_DAY);
  const gb = Number(env.HILDEGARD_RECORD_IMPORT_GB_PER_DAY);
  return {
    perDay: Number.isInteger(n) && n > 0 ? n : IMPORT_LIMITS.perDay,
    bytesPerDay: gb > 0 && Number.isFinite(gb) ? Math.floor(gb * 1024 ** 3) : IMPORT_LIMITS.bytesPerDay,
  };
}
const DAY_MS = 24 * 3600_000;
const human = (n: number) =>
  n >= 1024 ** 3 ? `${+(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;

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
  /** What the page may record from; missing on links made before there was a choice (the kind's own). */
  sources?: RecordSource[] | null;
  /** Teleprompter text the page shows. */
  script?: string | null;
  /** An interview's questions, follow-ups included, in the order they are put. */
  questions?: string[] | null;
  answers?: Answer[];
  chapters?: Chapter[] | null;
  /** For an answer's sound: the interview link it belongs to. */
  answerOf?: string | null;
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
  chapters: Chapter[];
  /** For an interview: how many questions, and how many were answered. */
  interview: { questions: number; answered: number } | null;
}

/** What the page behind a link may know: what is asked of the person, and whether it still can be done. */
export interface LinkView {
  kind: RecordKind;
  purpose: string | null;
  expiresAt: string;
  state: 'pending' | 'received';
  maxBytes: number;
  sources: RecordSource[];
  script: string | null;
  /** Every question so far, follow-ups included; the page polls for new ones. */
  questions: string[];
  answered: number;
  /** Most one answer's sound may be. */
  maxAnswerBytes: number;
}

/** Plain text from a person or an agent: no control characters but line breaks, trimmed and capped. */
const tidy = (s: string | null | undefined, max: number, lines = false): string | null =>
  (lines
    ? s
        ?.replace(/\r\n?/g, '\n')
        .replace(/[^\P{Cc}\n\t]+/gu, ' ')
        .trim()
    : s?.replace(/\p{Cc}+/gu, ' ').trim()
  )?.slice(0, max) || null;

/** Chapters as given, checked: times in order within the recording, titles plain and short. */
export function tidyChapters(list: unknown): Chapter[] {
  if (!Array.isArray(list)) throw new RecordError(400, 'chapters', 'Chapters are a list.');
  if (list.length > MAX_CHAPTERS)
    throw new RecordError(400, 'chapters', `A recording has at most ${MAX_CHAPTERS} chapters.`);
  const out: Chapter[] = [];
  for (const c of list as { at?: unknown; title?: unknown }[]) {
    const at = Number(c?.at);
    const title = tidy(typeof c?.title === 'string' ? c.title : '', MAX_QUESTION);
    if (!Number.isFinite(at) || at < 0 || at > 24 * 3600 || !title)
      throw new RecordError(400, 'chapters', 'Each chapter has a time in seconds and a title.');
    out.push({ at: Math.round(at * 100) / 100, title });
  }
  return out.sort((a, b) => a.at - b.at);
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
  /** What a file holds and how long it is; null when that can't be asked here (no Python), a RecordError when it was read and refused. */
  probe?: (file: string) => Promise<MediaInfo | null>;
  /** Smaller caps than MAX_BYTES, for tests. */
  maxBytes?: Partial<Record<RecordKind, number>>;
  /** Smaller or larger limits on what one person brings in each day (see `importLimits`). */
  imports?: Partial<ImportLimits>;
}

export class RecordStore {
  private readonly file: string;
  private readonly root: string;
  private readonly now: () => number;
  private readonly probe: (file: string) => Promise<MediaInfo | null>;
  private readonly max: Record<RecordKind, number>;
  private readonly limits: ImportLimits;
  /** Imports in the middle of arriving, per person: they count against the day before they are on file. */
  private readonly arriving = new Map<string, { n: number; bytes: number }>();
  private entries: Entry[] = [];
  /** Links an upload is in the middle of: a second upload at the same moment is refused. */
  private readonly busy = new Set<string>();

  constructor(opts: RecordOptions) {
    this.now = opts.now ?? Date.now;
    this.probe = opts.probe ?? (async () => null);
    this.max = { ...MAX_BYTES, ...opts.maxBytes };
    this.limits = { ...IMPORT_LIMITS, ...opts.imports };
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
    o: {
      kind?: RecordKind;
      purpose?: string | null;
      filmId?: string | null;
      sources?: RecordSource[] | null;
      script?: string | null;
      questions?: string[] | null;
    },
  ): { id: string; token: string; expiresAt: number } {
    if (!OWNER_RE.test(owner)) throw new RecordError(400, 'owner', 'Who is asking?');
    const sources = o.sources?.length ? [...new Set(o.sources)] : null;
    if (sources?.some((s) => !SOURCES.includes(s)))
      throw new RecordError(400, 'sources', 'Sources are camera, screen, screen+camera or voice.');
    // Sound only and a picture are two kinds of recording; one link makes one kind.
    const kinds = new Set(sources?.map(kindOf));
    if (kinds.size > 1)
      throw new RecordError(400, 'sources', 'Ask for voice on its own, or for sources with a picture.');
    const kind = o.kind ?? (sources ? kindOf(sources[0]!) : 'voice');
    if (sources && kindOf(sources[0]!) !== kind)
      throw new RecordError(
        400,
        'sources',
        kind === 'voice' ? 'A voice recording is sound only.' : 'A video needs a picture source.',
      );
    if ((o.script?.length ?? 0) > MAX_SCRIPT)
      throw new RecordError(400, 'script', `A script is at most ${MAX_SCRIPT} characters.`);
    if ((o.questions?.length ?? 0) > MAX_QUESTIONS)
      throw new RecordError(400, 'questions', `An interview starts with at most ${MAX_QUESTIONS} questions.`);
    const questions = (o.questions ?? []).map((q) => tidy(q, MAX_QUESTION)).filter((q): q is string => !!q);
    this.prune();
    // A link an upload is streaming through stays, however many are made meanwhile.
    const mine = this.entries.filter(
      (e) => e.owner === owner && e.state === 'pending' && e.hash && !this.busy.has(e.id),
    );
    while (mine.length >= MAX_PENDING) this.entries.splice(this.entries.indexOf(mine.shift()!), 1);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + (questions.length ? INTERVIEW_MINUTES.start : LINK_MINUTES) * 60_000;
    const purpose = tidy(o.purpose, 200);
    const e: Entry = {
      id: newId(),
      owner,
      kind,
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
      sources,
      script: tidy(o.script, MAX_SCRIPT, true),
      questions: questions.length ? questions : null,
      answers: [],
      chapters: null,
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
      sources: e.sources?.length ? e.sources : [e.kind === 'voice' ? 'voice' : 'camera'],
      script: e.script ?? null,
      questions: e.questions ?? [],
      answered: e.answers?.length ?? 0,
      maxAnswerBytes: this.max.voice,
    };
  }

  // ── Interviews ─────────────────────────────────────────────────────────────────────────────────────────────

  /** An interview's link stays open while it is in use: 30 minutes past now, never past its last hour. */
  private extend(e: Entry) {
    if (e.expiresAt === null) return;
    const most = Date.parse(e.createdAt) + INTERVIEW_MINUTES.most * 60_000;
    e.expiresAt = Math.max(e.expiresAt, Math.min(most, this.now() + INTERVIEW_MINUTES.slide * 60_000));
  }

  /** A live interview link by id, for the person who made it (the routes check who that is). */
  private live(id: string): Entry {
    const e = this.get(id);
    if (!e?.hash) throw new RecordError(404, 'missing', 'No such recording.');
    if (!e.questions) throw new RecordError(409, 'interview', 'That link isn’t an interview.');
    if (e.state === 'received')
      throw new RecordError(409, 'used', 'That interview is over: its recording was sent.');
    if ((e.expiresAt ?? 0) <= this.now())
      throw new RecordError(410, 'expired', 'That interview’s link ran out. Make a new one.');
    return e;
  }

  /** A follow-up question for a live interview; the page picks it up the next time it looks. */
  ask(id: string, question: string): { index: number; questions: string[] } {
    const e = this.live(id);
    const q = tidy(question, MAX_QUESTION);
    if (!q) throw new RecordError(400, 'question', 'Ask a question.');
    if (e.questions!.length >= MAX_ASKED)
      throw new RecordError(409, 'full', `An interview holds at most ${MAX_ASKED} questions.`);
    e.questions!.push(q);
    this.extend(e);
    this.persist();
    return { index: e.questions!.length - 1, questions: [...e.questions!] };
  }

  /**
   * One answer's sound, sent on Next. It must be the next question's, it is checked like any recording, and it
   * counts against the day's bytes of the person who made the link. It doesn't use the link up.
   */
  async answer(
    token: string,
    o: { index: number; at: number },
    body: ReadableStream<Uint8Array> | null,
    declared?: number,
  ): Promise<{ entry: Entry; answer: Answer; segment: Entry }> {
    const f = this.find(token);
    if (!f) throw new RecordError(404, 'unknown', 'This link doesn’t work. Ask for a new one.');
    if (f.link === 'expired')
      throw new RecordError(410, 'expired', 'This link has run out. Ask for a new one.');
    if (f.link === 'used') throw new RecordError(409, 'used', 'This interview has been sent already.');
    const e = f.entry;
    if (!e.questions) throw new RecordError(409, 'interview', 'This link isn’t an interview.');
    if (!e.answers) e.answers = [];
    const answers = e.answers;
    const key = `${e.id}#answer`;
    if (this.busy.has(key)) throw new RecordError(409, 'busy', 'The last answer is still arriving.');
    if (!Number.isInteger(o.index) || o.index < 0 || o.index >= e.questions.length)
      throw new RecordError(400, 'index', 'There is no such question.');
    if (o.index !== answers.length)
      throw new RecordError(409, 'answered', 'That question has its answer already.');
    const at = Number.isFinite(o.at) && o.at >= 0 ? Math.round(o.at * 100) / 100 : 0;
    const room = this.limits.bytesPerDay - this.used(e.owner).bytes;
    const byteQuota = () =>
      new RecordError(
        429,
        'quota',
        `You can bring in ${human(this.limits.bytesPerDay)} of recordings a day. Try again tomorrow.`,
      );
    if (room <= 0 || (declared !== undefined && declared > room)) throw byteQuota();
    this.busy.add(key);
    const cap = this.max.voice;
    const hold = Math.min(
      room,
      declared !== undefined && Number.isFinite(declared) ? Math.min(declared, cap) : cap,
    );
    const live = this.arriving.get(e.owner) ?? { n: 0, bytes: 0 };
    // An answer holds its room in the day while it arrives, but isn't one of the day's imports.
    this.arriving.set(e.owner, { n: live.n, bytes: live.bytes + hold });
    const id = newId();
    try {
      const stored = await this.store(e.owner, id, 'voice', body, declared, { room, error: byteQuota });
      const segment: Entry = {
        id,
        owner: e.owner,
        kind: 'voice',
        purpose: e.questions[o.index]!,
        filmId: e.filmId,
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
        answerOf: e.id,
      };
      const answer: Answer = {
        index: o.index,
        question: e.questions[o.index]!,
        at,
        media: id,
        receivedAt: segment.receivedAt!,
        job: null,
      };
      this.entries.push(segment);
      answers.push(answer);
      this.extend(e);
      this.persist();
      return { entry: e, answer, segment };
    } finally {
      this.busy.delete(key);
      this.release(e.owner, 0, hold);
    }
  }

  /** An upload that was arriving is done, kept or refused: its hold on the day goes. */
  private release(owner: string, n: number, bytes: number) {
    const now = this.arriving.get(owner);
    if (!now) return;
    const left = { n: now.n - n, bytes: now.bytes - bytes };
    if (left.n <= 0 && left.bytes <= 0) this.arriving.delete(owner);
    else this.arriving.set(owner, { n: Math.max(0, left.n), bytes: Math.max(0, left.bytes) });
  }

  /** Which transcription job an answer has. */
  setAnswerJob(linkId: string, index: number, job: string | null) {
    const a = this.get(linkId)?.answers?.find((x) => x.index === index);
    if (!a) return;
    a.job = job;
    this.persist();
  }

  /** Chapters for a link's recording, sent before it. */
  chaptersByLink(token: string, list: unknown): Chapter[] {
    const f = this.find(token);
    if (!f) throw new RecordError(404, 'unknown', 'This link doesn’t work. Ask for a new one.');
    if (f.link === 'expired')
      throw new RecordError(410, 'expired', 'This link has run out. Ask for a new one.');
    if (f.link === 'used') throw new RecordError(409, 'used', 'This link has been used already.');
    f.entry.chapters = tidyChapters(list);
    this.persist();
    return f.entry.chapters;
  }

  /** Chapters for a recording already kept (one made in the Studio). */
  setChapters(e: Entry, list: unknown): Chapter[] {
    if (e.state !== 'received' || e.answerOf)
      throw new RecordError(409, 'chapters', 'Chapters go on a recording that has arrived.');
    e.chapters = tidyChapters(list);
    this.persist();
    return e.chapters;
  }

  /** The answers' own recordings, in order. */
  answersOf(e: Entry): { answer: Answer; segment: Entry | undefined }[] {
    return (e.answers ?? []).map((answer) => ({ answer, segment: this.get(answer.media) }));
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
      // No chapters sent with it: an interview's come from where each question was put.
      if (!e.chapters?.length && e.answers?.length)
        e.chapters = e.answers.map((a) => ({ at: a.at, title: a.question }));
      // Pruned meanwhile (an upload that outlasted its link and the days kept): the recording still has an entry.
      if (!this.entries.includes(e)) this.entries.push(e);
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
    const live = this.arriving.get(owner) ?? { n: 0, bytes: 0 };
    const used = this.used(owner);
    const room = this.limits.bytesPerDay - used.bytes;
    if (used.n >= this.limits.perDay)
      throw new RecordError(
        429,
        'quota',
        `You can bring in ${this.limits.perDay} recordings a day. Try again tomorrow.`,
      );
    const cap = this.max[kind === 'auto' ? 'video' : kind];
    const byteQuota = () =>
      new RecordError(
        429,
        'quota',
        `You can bring in ${human(this.limits.bytesPerDay)} of recordings a day. Try again tomorrow.`,
      );
    if (room <= 0 || (declared !== undefined && declared > room)) throw byteQuota();
    // An upload of unknown length may be as long as the cap, and holds that much of the day while it arrives.
    const hold = declared !== undefined && Number.isFinite(declared) ? Math.min(declared, cap) : cap;
    this.arriving.set(owner, { n: live.n + 1, bytes: live.bytes + hold });
    const id = newId();
    let stored: Awaited<ReturnType<RecordStore['store']>>;
    try {
      stored = await this.store(owner, id, kind, body, declared, { room, error: byteQuota });
    } finally {
      this.release(owner, 1, hold);
    }
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

  /**
   * What a person brought in over the last 24 hours, with what is arriving now. Owners and directors alike have the
   * day; the owner of this Hildegard raises it for all. An interview's answers count in its bytes, not its number:
   * one interview of 30 questions would otherwise be a day's worth.
   */
  private used(owner: string): { n: number; bytes: number } {
    const since = this.now() - DAY_MS;
    const done = this.entries.filter(
      (e) =>
        e.owner === owner && e.hash === null && e.from === null && Date.parse(e.receivedAt ?? '') > since,
    );
    const live = this.arriving.get(owner) ?? { n: 0, bytes: 0 };
    return {
      n: done.filter((e) => !e.answerOf).length + live.n,
      bytes: done.reduce((t, e) => t + (e.bytes ?? 0), 0) + live.bytes,
    };
  }

  /** Writes the bytes, checks them, and says where they went. Nothing is left behind when it refuses. */
  private async store(
    owner: string,
    id: string,
    asked: RecordKind | 'auto',
    body: ReadableStream<Uint8Array> | null,
    declared?: number,
    quota?: { room: number; error: () => RecordError },
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
        if (quota && size > quota.room) throw quota.error();
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
      if (err instanceof RecordError && (err.status === 413 || err.code === 'quota'))
        await reader.cancel().catch(() => {});
      else reader.releaseLock();
      await fh.close().catch(() => {});
      await rm(tmp, { force: true });
      throw err;
    }
    await fh.close();
    const name = `${owner}/${id}.${ext}`;
    const dest = join(this.root, name);
    renameSync(tmp, dest);
    // A probe that can't be asked (null, or a failure of its own) leaves the file as it came; one that read the file
    // and refused it is a refusal, and the link is not used up.
    let info: MediaInfo | null;
    try {
      info = await this.probe(dest);
    } catch (err) {
      if (!(err instanceof RecordError)) info = null;
      else {
        rmSync(dest, { force: true });
        throw err;
      }
    }
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

  /** Every recording that has arrived, newest first, but an interview's answers. Callers filter by who may see them. */
  list(): Entry[] {
    return this.entries
      .filter((e) => e.state === 'received' && !e.answerOf)
      .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
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
      chapters: e.chapters ?? [],
      interview: e.questions ? { questions: e.questions.length, answered: e.answers?.length ?? 0 } : null,
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
