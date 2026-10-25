// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loops: an agent makes something, Hildegard renders and measures it, the agent critiques what it sees, changes one
 * thing and sends it again, until it passes or the rounds run out. A 3D model is the first kind (the agent models in
 * Blender, OpenSCAD or code; Hildegard checks the mesh and draws a turntable), and images, video and sound use the same
 * loop with the media checks. A kind is a renderer and a rubric, so more kinds plug in the same way.
 *
 * The loop is what keeps an agent honest: it can't send round two before it has answered the rubric about round one,
 * and every answer must point at a view or a check. Hildegard keeps every round, so the owner can see how the work got
 * where it is and pick another. It only ever reads bytes it was sent (never a path an agent names), and only reads
 * them as data: models as geometry, never as scripts. A web page is the one kind that runs: Hildegard opens it in a
 * browser shut off from the network and from every file but the round's own (web-review.ts).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describeReview, describeRubric, type Judged, type Review, rubric } from '@hildegard/craft';
import { z } from 'zod';
import type { WebSpec } from './web-review.ts';
import { unzipTo, ZipError } from './zip.ts';

export type LoopKind = 'model' | 'image' | 'video' | 'audio' | 'web';
export const LOOP_KINDS: LoopKind[] = ['model', 'image', 'video', 'audio', 'web'];

/** The file formats each kind takes, by extension. */
export const FORMATS: Record<LoopKind, string[]> = {
  model: ['glb', 'gltf', 'stl', 'obj', 'ply'],
  image: ['png', 'jpg', 'webp'],
  video: ['mp4'],
  audio: ['wav', 'flac', 'mp3', 'ogg'],
  web: ['html', 'zip'],
};

const SAY: Record<string, string> = { gltf: 'glTF', jpg: 'JPEG', webp: 'WebP', zip: 'a ZIP of the site' };
/** "GLB, glTF, STL, OBJ or PLY". */
const formatList = (k: LoopKind) => {
  const n = FORMATS[k].map((f) => SAY[f] ?? f.toUpperCase());
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} or ${n.at(-1)}` : n[0]!;
};

export class LoopError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 501;
  readonly code: string;
  constructor(status: LoopError['status'], code: string, message: string) {
    super(message);
    this.name = 'LoopError';
    this.status = status;
    this.code = code;
  }
}

export const Brief = z.object({
  /** Who it is for and where it goes. */
  for: z.string().trim().min(3).max(400),
  /** What it is, in one or two sentences. */
  what: z.string().trim().min(3).max(1000),
  /** Three specifics that make it this piece and not the average one. */
  specifics: z.array(z.string().trim().min(2).max(300)).min(1).max(8),
  constraints: z.string().trim().max(1000).optional(),
  /** Qualities to learn from (not names to copy). */
  references: z.string().trim().max(1000).optional(),
});
export type Brief = z.infer<typeof Brief>;

const Mm = z.tuple([
  z.number().positive().max(10_000),
  z.number().positive().max(10_000),
  z.number().positive().max(10_000),
]);
export const Target = z.object({
  /** A model meant for a 3D printer: millimetres, watertight, a base, fits the bed. */
  print: z.boolean().optional(),
  sizeMm: Mm.optional(),
  bedMm: Mm.optional(),
  maxTriangles: z.number().int().positive().max(50_000_000).optional(),
  /** Which axis is up in the files, when not the format's usual one (y for GLB and glTF, z for STL and PLY). */
  up: z.enum(['y', 'z']).optional(),
  /** Images, video and sound: hold it to the final bar, not a draft's. */
  final: z.boolean().optional(),
  /** Video and sound: the length asked for, in seconds. */
  seconds: z.number().positive().max(3600).optional(),
  /** Video: whether it should have sound. */
  audio: z.boolean().optional(),
  /** Web: the pages to check, as paths inside the site (index.html by default), the first leading the sheet. */
  pages: z
    .array(
      z
        .string()
        .trim()
        .regex(
          /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\w./ -]{1,200}\.html?$/,
          'A page is a path to an .html file inside the site.',
        ),
    )
    .min(1)
    .max(5)
    .optional(),
  /** Web: the brief asks for a dark theme that follows the visitor's setting. */
  dark: z.boolean().optional(),
});
export type Target = z.infer<typeof Target>;

export const StartLoop = z.object({
  kind: z.enum(LOOP_KINDS as [LoopKind, ...LoopKind[]]),
  title: z.string().trim().min(1).max(120),
  brief: Brief,
  target: Target.optional(),
  maxRounds: z.number().int().min(1).max(12).optional(),
  agent: z.string().trim().min(1).max(60).optional(),
});

export const Critique = z.object({
  answers: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(40),
        answer: z.enum(['yes', 'no']),
        /** The view, frame, time or check that shows it. */
        evidence: z.string().trim().min(3).max(600),
      }),
    )
    .min(1)
    .max(40),
  /** The one thing the next round changes. Needed unless every answer is yes. */
  change: z.string().trim().min(3).max(1000).optional(),
});
export type Critique = z.infer<typeof Critique>;

export interface Round {
  n: number;
  at: string;
  /** The file, in this loop's folder. */
  file: string;
  format: string;
  bytes: number;
  /** What the agent changed in this round, in its words. */
  note: string;
  review: Review & { summary: string };
  /** The turntable or contact sheet, in this loop's folder, if one was drawn. */
  sheet: string | null;
  critique: (Critique & { at: string; verdict: Verdict }) | null;
}

export type Verdict = 'ready' | 'revise' | 'stop';

export interface Loop {
  id: string;
  kind: LoopKind;
  title: string;
  brief: Brief;
  target: Target;
  maxRounds: number;
  agent: string;
  status: 'open' | 'done' | 'stopped';
  createdAt: string;
  updatedAt: string;
  rounds: Round[];
  /** The round the agent (or owner) chose to deliver. */
  chosen: number | null;
  /** The honest closing note: what it is, and what still fails. */
  note: string | null;
}

/** A model of a sculpture takes more rounds to get right than a shot, which is re-rendered rather than rebuilt. */
export const DEFAULT_ROUNDS: Record<LoopKind, number> = { model: 6, image: 3, video: 3, audio: 3, web: 5 };

const MAX_BYTES: Record<LoopKind, number> = {
  model: 256 * 1024 * 1024,
  image: 40 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  web: 100 * 1024 * 1024,
};

export const JUDGED: Record<LoopKind, Judged> = {
  model: 'model',
  image: 'image',
  video: 'video',
  audio: 'music',
  web: 'web',
};

/** Reads what a file is from its first bytes, so a name or a claimed format never decides how it is parsed. */
export function sniff(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 4) return null;
  if (ascii(0, 4) === 'glTF') return 'glb';
  if (ascii(0, 4) === 'PK\x03\x04' || ascii(0, 4) === 'PK\x05\x06') return 'zip';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'mp3';
  if (b.length > 12 && ascii(4, 8) === 'ftyp') return 'mp4';
  if (ascii(0, 3) === 'ply') return 'ply';
  if (b.length >= 84) {
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
    if (84 + n * 50 === b.length) return 'stl';
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 4096)).trimStart();
  if (/^(\ufeff)?\s*(<!--[\s\S]*?-->\s*)*<(!doctype html|html|head|body)[\s>]/i.test(head)) return 'html';
  if (/^solid[\s\S]*facet/i.test(head)) return 'stl';
  if (/^\{[\s\S]*"asset"/.test(head)) return 'gltf';
  if (/^(#[^\n]*\n|\s|o |g |mtllib [^\n]*\n|s [^\n]*\n)*v\s+-?[\d.]/.test(head)) return 'obj';
  return null;
}

export interface LoopDeps {
  /** Where loops keep their rounds: one folder each. */
  dir: string;
  /** Checks a 3D model; absent when Python can't run here. */
  reviewModel?: (spec: {
    path: string;
    sheet: string;
    print?: boolean;
    size_mm?: [number, number, number];
    bed_mm?: [number, number, number];
    max_triangles?: number;
    up?: 'y' | 'z';
  }) => Promise<Review>;
  /** Renders and checks a web page; absent when this computer has no Chromium-family browser. */
  reviewWeb?: (spec: WebSpec) => Promise<Review>;
  /** Checks an image, video or sound; absent when Python can't run here. */
  reviewMedia?: (spec: {
    path: string;
    sheet: string;
    final?: boolean;
    seconds?: number;
    audio?: boolean;
  }) => Promise<Review>;
  now?: () => Date;
}

export class Loops {
  private readonly loops = new Map<string, Loop>();
  private readonly busy = new Set<string>();
  private readonly deps: LoopDeps;
  private readonly now: () => Date;

  constructor(deps: LoopDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    mkdirSync(deps.dir, { recursive: true });
    for (const d of readdirSync(deps.dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !/^[a-f0-9]{16}$/.test(d.name)) continue;
      try {
        const l = JSON.parse(readFileSync(join(deps.dir, d.name, 'loop.json'), 'utf8')) as Loop;
        this.loops.set(l.id, l);
      } catch {}
    }
  }

  private save(l: Loop) {
    l.updatedAt = this.now().toISOString();
    const file = join(this.deps.dir, l.id, 'loop.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(l, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  list(): Loop[] {
    return [...this.loops.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Loop {
    const l = this.loops.get(id);
    if (!l) throw new LoopError(404, 'no_loop', 'No such loop.');
    return l;
  }

  /** A file of a loop's, by its name in the loop's folder; null if it isn't one of the loop's. */
  file(id: string, name: string): string | null {
    const l = this.loops.get(id);
    if (!l) return null;
    if (!l.rounds.some((r) => r.file === name || r.sheet === name)) return null;
    const path = join(this.deps.dir, l.id, name);
    return existsSync(path) ? path : null;
  }

  start(input: z.infer<typeof StartLoop>): Loop {
    const ready =
      input.kind === 'model'
        ? this.deps.reviewModel
        : input.kind === 'web'
          ? this.deps.reviewWeb
          : this.deps.reviewMedia;
    if (!ready)
      throw new LoopError(
        501,
        'no_checks',
        input.kind === 'web'
          ? 'Pages can’t be checked on this computer: Hildegard needs Chrome, Chromium, Edge or Brave to open them. Install one, or set HILDEGARD_CHROME to its path.'
          : 'Checks can’t run on this computer: Hildegard has no Python with numpy here.',
      );
    const at = this.now().toISOString();
    const l: Loop = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      kind: input.kind,
      title: input.title,
      brief: input.brief,
      target: input.target ?? {},
      maxRounds: input.maxRounds ?? DEFAULT_ROUNDS[input.kind],
      agent: input.agent ?? 'agent',
      status: 'open',
      createdAt: at,
      updatedAt: at,
      rounds: [],
      chosen: null,
      note: null,
    };
    mkdirSync(join(this.deps.dir, l.id), { recursive: true });
    this.loops.set(l.id, l);
    this.save(l);
    return l;
  }

  /** A new round: the bytes are checked, rendered and kept. */
  async submit(id: string, bytes: Uint8Array, note: string): Promise<Round> {
    const l = this.get(id);
    if (l.status !== 'open') throw new LoopError(409, 'closed', 'This loop is finished. Start a new one.');
    const last = l.rounds.at(-1);
    if (last && !last.critique)
      throw new LoopError(
        409,
        'critique_first',
        `Critique round ${last.n} first: look at its sheet and answer its questions with loop_critique. Then send the next round.`,
      );
    if (last?.critique?.verdict === 'stop' || l.rounds.length >= l.maxRounds)
      throw new LoopError(
        409,
        'no_rounds',
        `That was the last of ${l.maxRounds} rounds. Finish the loop with the best round, and say plainly what still fails.`,
      );
    if (bytes.length > MAX_BYTES[l.kind])
      throw new LoopError(413, 'size', `Files up to ${MAX_BYTES[l.kind] / 1024 / 1024} MB for this kind.`);
    if (!bytes.length) throw new LoopError(400, 'empty', 'That file is empty.');
    const format = sniff(bytes);
    if (!format || !FORMATS[l.kind].includes(format))
      throw new LoopError(
        415,
        'format',
        `Send ${l.kind === 'model' ? 'a 3D model' : l.kind === 'video' ? 'a video' : l.kind === 'web' ? 'a web page' : `an ${l.kind} file`} as ${formatList(l.kind)}.`,
      );
    if (this.busy.has(l.id))
      throw new LoopError(409, 'busy', 'A round of this loop is being checked. Wait for it.');
    this.busy.add(l.id);
    const n = l.rounds.length + 1;
    const file = `round-${n}.${format}`;
    const sheet = `round-${n}.sheet.jpg`;
    const dir = join(this.deps.dir, l.id);
    try {
      writeFileSync(join(dir, file), bytes);
      let review: Review;
      try {
        review =
          l.kind === 'web'
            ? await this.deps.reviewWeb!(this.site(l, n, format, bytes, join(dir, sheet)))
            : l.kind === 'model'
              ? await this.deps.reviewModel!({
                  path: join(dir, file),
                  sheet: join(dir, sheet),
                  print: l.target.print,
                  size_mm: l.target.sizeMm,
                  bed_mm: l.target.bedMm,
                  max_triangles: l.target.maxTriangles,
                  up: l.target.up,
                })
              : await this.deps.reviewMedia!({
                  path: join(dir, file),
                  sheet: join(dir, sheet),
                  final: l.target.final,
                  seconds: l.target.seconds,
                  audio: l.kind === 'audio' ? true : l.target.audio,
                });
      } catch (e) {
        rmSync(join(dir, file), { force: true });
        rmSync(join(dir, `round-${n}`), { recursive: true, force: true });
        if (e instanceof LoopError) throw e;
        throw new LoopError(422, 'unreadable', `Hildegard couldn’t read that file: ${(e as Error).message}`);
      }
      const round: Round = {
        n,
        at: this.now().toISOString(),
        file,
        format,
        bytes: bytes.length,
        note: note.trim().slice(0, 1000),
        review: { ...review, summary: describeReview(review) },
        sheet: existsSync(join(dir, sheet)) ? sheet : null,
        critique: null,
      };
      l.rounds.push(round);
      this.save(l);
      return round;
    } finally {
      this.busy.delete(l.id);
    }
  }

  /** Lays a web round out as a site in its own folder (a page, or a ZIP unpacked) and names the pages to check. */
  private site(l: Loop, n: number, format: string, bytes: Uint8Array, sheet: string): WebSpec {
    const site = join(this.deps.dir, l.id, `round-${n}`);
    rmSync(site, { recursive: true, force: true });
    mkdirSync(site, { recursive: true });
    let files: string[];
    if (format === 'zip') {
      try {
        files = unzipTo(bytes, site);
      } catch (e) {
        if (e instanceof ZipError) throw new LoopError(422, 'zip', e.message);
        throw e;
      }
    } else {
      writeFileSync(join(site, 'index.html'), bytes);
      files = ['index.html'];
    }
    const html = files.filter((f) => /\.html?$/i.test(f));
    const pages = l.target.pages?.map((p) => posix.normalize(p)) ?? [
      html.includes('index.html')
        ? 'index.html'
        : (html.sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? ''),
    ];
    const missing = pages.filter((p) => !html.includes(p));
    if (!html.length) throw new LoopError(422, 'no_page', 'That ZIP has no HTML page in it.');
    if (missing.length)
      throw new LoopError(
        422,
        'no_page',
        `The site has no ${missing.join(' or ')}. Its pages: ${html.slice(0, 10).join(', ')}.`,
      );
    return { dir: site, pages, sheet, final: l.target.final, dark: l.target.dark };
  }

  /**
   * The agent's critique of a round: every rubric question answered, each pointing at its evidence. The verdict says
   * what comes next: ready to finish, revise (and what to change), or stop (no rounds left).
   */
  critique(id: string, n: number, input: Critique): { round: Round; verdict: Verdict; next: string } {
    const l = this.get(id);
    if (l.status !== 'open') throw new LoopError(409, 'closed', 'This loop is finished.');
    const round = l.rounds.find((r) => r.n === n);
    if (!round) throw new LoopError(404, 'no_round', `This loop has no round ${n}.`);
    if (round !== l.rounds.at(-1)) throw new LoopError(409, 'not_latest', 'Critique the latest round.');
    const questions = rubric(JUDGED[l.kind]);
    const given = new Map(input.answers.map((a) => [a.id, a]));
    const missing = questions.filter((q) => !given.has(q.id)).map((q) => q.id);
    if (missing.length)
      throw new LoopError(422, 'unanswered', `Answer every question; missing: ${missing.join(', ')}.`);
    const unknown = input.answers.filter((a) => !questions.some((q) => q.id === a.id)).map((a) => a.id);
    if (unknown.length) throw new LoopError(422, 'unknown', `No such questions: ${unknown.join(', ')}.`);
    const no = questions.filter((q) => given.get(q.id)!.answer === 'no');
    const failing = round.review.checks.filter((c) => c.status === 'fail');
    const ready = !no.length && round.review.passed;
    if (!ready && !input.change)
      throw new LoopError(422, 'change', 'Name the one thing the next round changes (change).');
    const roundsLeft = l.maxRounds - l.rounds.length;
    const verdict: Verdict = ready ? 'ready' : roundsLeft > 0 ? 'revise' : 'stop';
    round.critique = { ...input, at: this.now().toISOString(), verdict };
    this.save(l);
    const next =
      verdict === 'ready'
        ? `Round ${n} passes every check and every question. Finish the loop with round ${n} (loop_finish), or make one more round if you can still name something to improve.`
        : verdict === 'revise'
          ? [
              `Revise: change one thing (${input.change}), then send round ${n + 1}. ${roundsLeft} round${roundsLeft === 1 ? '' : 's'} left.`,
              ...failing.map((c) => `- check ${c.id} fails: ${c.detail}`),
              ...no.map((q) => `- ${q.id}: ${q.fix}`),
            ].join('\n')
          : `No rounds left. Finish the loop with the best round and tell your user plainly what still fails: ${[...failing.map((c) => c.id), ...no.map((q) => q.id)].join(', ')}.`;
    return { round, verdict, next };
  }

  finish(id: string, n: number, note: string): Loop {
    const l = this.get(id);
    if (l.status !== 'open') throw new LoopError(409, 'closed', 'This loop is already finished.');
    const round = l.rounds.find((r) => r.n === n);
    if (!round) throw new LoopError(404, 'no_round', `This loop has no round ${n}.`);
    if (!round.critique)
      throw new LoopError(409, 'critique_first', `Critique round ${n} before you deliver it.`);
    l.status = 'done';
    l.chosen = n;
    l.note = note.trim().slice(0, 2000);
    this.save(l);
    return l;
  }

  stop(id: string): Loop {
    const l = this.get(id);
    if (l.status === 'open') {
      l.status = 'stopped';
      this.save(l);
    }
    return l;
  }

  remove(id: string) {
    const l = this.get(id);
    this.loops.delete(l.id);
    rmSync(join(this.deps.dir, l.id), { recursive: true, force: true });
  }

  /** The questions to answer about a round, with the round's numbers to answer them by. */
  static questions(kind: LoopKind): string {
    return describeRubric(JUDGED[kind]);
  }
}
