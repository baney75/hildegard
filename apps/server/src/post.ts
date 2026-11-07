// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post: prepares a finished film or image for each platform the person names. For each one Hildegard makes the file in
 * the platform's own shape and loudness (tools/export_post.py), a thumbnail, and the title and caption written from the
 * facts the person gave, and puts them in a "Ready to post" folder. It never posts: it holds no platform account, key
 * or address, and makes no request to any platform. The person presses Post, on the site, in the Hildegard app's own
 * window for it or in their browser.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type Catalog,
  composeText,
  POST_LUFS,
  POST_TRUE_PEAK,
  type PostFacts,
  type PostFile,
  type PostPlatformId,
  type PostRequest,
  type PostSourceRef,
  type PostState,
  type PostTarget,
  planPost,
  slug,
} from '@hildegard/presets';
import { resource } from '@hildegard/runtime';
import { chosenTakes, type Exporter, exportPython } from './export.ts';
import type { Store } from './store.ts';

export class PostError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

/** What tools/export_post.py reports for one file. */
export interface MadeFile {
  width: number;
  height: number;
  seconds: number | null;
  bytes: number;
  lufs: number | null;
  true_peak: number | null;
  trimmed: boolean;
  text_box: [number, number, number, number] | null;
}

export interface PostSpec {
  kind: 'video' | 'image';
  input: string;
  out: string;
  thumbnail: string | null;
  title: string;
  comment: string;
  fit: 'blur' | 'crop';
  text: string | null;
  lufs: number;
  true_peak: number;
  target: PostTarget;
}

export type PostRunner = (spec: PostSpec) => Promise<MadeFile>;

/** Runs tools/export_post.py on Hildegard's own Python. */
export function pythonRunner(dataDir: string): PostRunner {
  return async (spec) => {
    const script = resource(join('tools', 'export_post.py'));
    const specFile = `${spec.out}.json`;
    writeFileSync(specFile, JSON.stringify(spec));
    try {
      const child = spawn(exportPython(dataDir), ['-I', script, specFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const exited = new Promise<number>((r) => {
        child.once('error', () => r(-1));
        child.once('close', (c) => r(c ?? -1));
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      let made: (MadeFile & { ok?: boolean; error?: string }) | null = null;
      for await (const line of createInterface({ input: child.stdout })) {
        try {
          const m = JSON.parse(line) as MadeFile & { ok?: boolean; error?: string; stage?: string };
          if (m.ok !== undefined) made = m;
        } catch {}
      }
      const code = await exited;
      if (code === 0 && made?.ok) return made;
      const noPython =
        code === -1 || /No module named|ModuleNotFoundError/.test(`${made?.error ?? ''}${stderr}`);
      if (stderr) console.error(`Post ${spec.target.id} failed:\n${stderr}`);
      throw new Error(
        noPython
          ? 'Preparing a post uses the Python that `hildegard install` sets up. Run `hildegard install`, then try again.'
          : (made?.error ?? 'Preparing the file failed. The server log has the details.'),
      );
    } finally {
      rmSync(specFile, { force: true });
    }
  };
}

export interface PosterOptions {
  store: Store;
  catalog: Catalog;
  exporter: Exporter;
  mediaDir: string;
  /** The folder the "Ready to post" folders go in. */
  readyDir: string;
  /** Written into each file, so what Hildegard made stays labeled as AI-generated wherever it goes. */
  credit: string;
  run: PostRunner;
  onChange?: (p: PostState) => void;
}

interface Resolved {
  kind: 'video' | 'image';
  path: string;
  title: string;
  projectId: string | null;
  width: number;
  height: number;
  models: string[];
}

const MANIFEST = 'post.json';

export class Poster {
  private readonly posts = new Map<string, PostState>();
  private readonly opts: PosterOptions;

  constructor(opts: PosterOptions) {
    this.opts = opts;
    this.load();
  }

  /** The folders already made, so ticked-off posts survive a restart. A post that was being made when Hildegard stopped is failed. */
  private load() {
    if (!existsSync(this.opts.readyDir)) return;
    for (const dir of readdirSync(this.opts.readyDir)) {
      try {
        const p = JSON.parse(readFileSync(join(this.opts.readyDir, dir, MANIFEST), 'utf8')) as PostState;
        if (p.status === 'running') {
          p.status = 'failed';
          p.error = 'Hildegard stopped while this was being prepared. Prepare it again.';
          for (const f of p.files) if (f.status === 'queued' || f.status === 'running') f.status = 'failed';
        }
        this.posts.set(p.id, p);
      } catch {}
    }
  }

  list(): PostState[] {
    return [...this.posts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): PostState | undefined {
    return this.posts.get(id);
  }

  folder(p: PostState): string {
    return join(this.opts.readyDir, `${slug(p.title)}-${p.id.slice(0, 6)}`);
  }

  /** The absolute path of one of a post's files, or null for a name it doesn't have. */
  filePath(p: PostState, name: string): string | null {
    const known = p.files.some((f) => f.file === name || f.thumbnail === name || f.words === name);
    const path = join(this.folder(p), name);
    return known && existsSync(path) ? path : null;
  }

  /** The newest finished file for a platform, for taking to its site. */
  latestFor(platform: PostPlatformId): { post: PostState; file: PostFile } | null {
    for (const post of this.list())
      for (const file of post.files)
        if (file.platform === platform && file.status === 'done' && file.file) return { post, file };
    return null;
  }

  setPosted(id: string, target: string, posted: boolean): PostState {
    const p = this.posts.get(id);
    const f = p?.files.find((x) => x.target === target);
    if (!p || !f) throw new PostError('No such post', 404);
    f.posted = posted;
    this.save(p);
    return p;
  }

  private resolve(ref: PostSourceRef): Resolved {
    const { store, exporter, mediaDir, catalog } = this.opts;
    const mediaPath = (url: string) => join(mediaDir, url.replace(/^\/media\//, ''));
    const modelName = (id: string) => catalog.models.find((m) => m.id === id)?.name ?? id;
    if (ref.kind === 'export') {
      const e = exporter.get(ref.id);
      if (!e) throw new PostError('No such export', 404);
      if (e.status !== 'done' || !existsSync(exporter.file(e)))
        throw new PostError('That export isn’t finished yet.', 409);
      const takes = chosenTakes(store, e.projectId).filter((t) => e.takeIds.includes(t.id));
      const big = takes.reduce((a, t) => (t.width * t.height > a.width * a.height ? t : a), takes[0]!);
      return {
        kind: 'video',
        path: exporter.file(e),
        title: e.title,
        projectId: e.projectId,
        width: big?.width ?? 1920,
        height: big?.height ?? 1080,
        models: [...new Set(takes.map((t) => modelName(t.model)))],
      };
    }
    if (ref.kind === 'take') {
      const t = store.takes.get(ref.id);
      if (!t) throw new PostError('No such take', 404);
      if (t.status !== 'done' || !t.video) throw new PostError('That take isn’t finished yet.', 409);
      const path = mediaPath(t.video);
      if (!existsSync(path)) throw new PostError('That take’s file is missing.', 409);
      return {
        kind: 'video',
        path,
        title: store.projects.get(t.projectId)?.title ?? store.shots.get(t.shotId)?.title ?? 'Film',
        projectId: t.projectId,
        width: t.width,
        height: t.height,
        models: [modelName(t.model)],
      };
    }
    const s = store.stills.get(ref.id);
    if (!s) throw new PostError('No such image', 404);
    if (s.status !== 'done' || !s.image) throw new PostError('That image isn’t finished yet.', 409);
    const path = mediaPath(s.image);
    if (!existsSync(path)) throw new PostError('That image’s file is missing.', 409);
    return {
      kind: 'image',
      path,
      title: s.summary || 'Image',
      projectId: null,
      width: s.width,
      height: s.height,
      models: [modelName(s.model)],
    };
  }

  /** Starts preparing; the returned state fills in as each file finishes. */
  prepare(req: PostRequest): PostState {
    const src = this.resolve(req.source);
    if ([...this.posts.values()].some((p) => p.status === 'running' && p.source.id === req.source.id))
      throw new PostError('This is already being prepared.', 409);
    const plan = planPost(req.platforms, src, { youtube4k: req.youtube4k, formats: req.formats });
    if (!plan.targets.length)
      throw new PostError(plan.skipped.map((s) => s.why).join(' ') || 'Pick a platform to post to.', 400);

    const facts: PostFacts = {
      title: req.facts.title?.trim() || src.title,
      about: req.facts.about,
      tags: req.facts.tags,
      link: req.facts.link,
      disclose: req.facts.disclose,
    };
    const notes: string[] = [];
    const files: PostFile[] = plan.targets.map((t) => {
      const text = composeText(facts, t);
      notes.push(...text.notes);
      return {
        target: t.id,
        platform: t.platform,
        label: t.label,
        kind: src.kind,
        status: 'queued',
        file: null,
        thumbnail: null,
        words: null,
        text,
        width: null,
        height: null,
        seconds: null,
        bytes: null,
        lufs: null,
        truePeak: null,
        trimmed: false,
        textBox: null,
        posted: false,
        error: null,
      };
    });
    const post: PostState = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      source: req.source,
      projectId: src.projectId,
      title: facts.title,
      status: 'running',
      files,
      skipped: plan.skipped,
      notes,
      error: null,
      createdAt: new Date().toISOString(),
      folder: null,
    };
    this.posts.set(post.id, post);
    mkdirSync(this.folder(post), { recursive: true });
    this.save(post);
    void this.run(post, src, plan.targets, req, facts);
    return post;
  }

  private save(p: PostState) {
    const dir = this.folder(p);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${MANIFEST}.part`);
    writeFileSync(tmp, JSON.stringify({ ...p, folder: null }, null, 2));
    renameSync(tmp, join(dir, MANIFEST));
    this.opts.onChange?.(p);
  }

  private async run(
    post: PostState,
    src: Resolved,
    targets: PostTarget[],
    req: PostRequest,
    facts: PostFacts,
  ) {
    const dir = this.folder(post);
    const base = slug(post.title);
    const models = src.models.join(' and ') || 'Hildegard';
    const comment = `AI-generated ${src.kind}, made with ${models}. ${this.opts.credit}`;
    const onScreen = req.onScreenText?.trim() || null;
    for (const target of targets) {
      const f = post.files.find((x) => x.target === target.id)!;
      f.status = 'running';
      this.save(post);
      const stem = `${base}-${target.id}`;
      const out = join(dir, `${stem}.${src.kind === 'video' ? 'mp4' : 'jpg'}`);
      const thumb = src.kind === 'video' ? join(dir, `${stem}-thumbnail.jpg`) : null;
      try {
        const made = await this.opts.run({
          kind: src.kind,
          input: src.path,
          out,
          thumbnail: thumb,
          title: facts.title,
          comment,
          fit: req.fit ?? 'blur',
          text: onScreen,
          lufs: POST_LUFS,
          true_peak: POST_TRUE_PEAK,
          target,
        });
        const words = `${stem}.txt`;
        writeFileSync(join(dir, words), wordsFile(f.label, f.text.title, f.text.caption));
        Object.assign(f, {
          status: 'done',
          file: `${stem}.${src.kind === 'video' ? 'mp4' : 'jpg'}`,
          thumbnail: thumb && existsSync(thumb) ? `${stem}-thumbnail.jpg` : null,
          words,
          width: made.width,
          height: made.height,
          seconds: made.seconds,
          bytes: made.bytes,
          lufs: made.lufs,
          truePeak: made.true_peak,
          trimmed: made.trimmed,
          textBox: made.text_box,
        });
        if (made.trimmed && target.maxSeconds)
          post.notes.push(
            `${target.label}: cut to its first ${target.maxSeconds} seconds, the longest it takes.`,
          );
      } catch (e) {
        f.status = 'failed';
        f.error = (e as Error).message;
      }
      this.save(post);
    }
    const done = post.files.filter((f) => f.status === 'done').length;
    post.status = done ? 'done' : 'failed';
    if (!done) post.error = post.files[0]?.error ?? 'Nothing could be prepared.';
    this.save(post);
  }
}

/** The text file kept beside a platform's video: what to paste, in the order the platform asks for it. */
export function wordsFile(label: string, title: string | null, caption: string): string {
  return `${label}\n\n${title ? `Title\n${title}\n\n` : ''}${title ? 'Description' : 'Caption'}\n${caption}\n`;
}

/** Shows a file (or opens a folder) in the computer's file manager. Never waits for it, and a failure is no one's problem. */
export function revealInFolder(path: string, platform: NodeJS.Platform = process.platform) {
  // The end-to-end tests run on someone's own desktop: they must not open its file manager.
  if (process.env.HILDEGARD_NO_REVEAL) return;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') [cmd, args] = ['open', ['-R', path]];
  else if (platform === 'win32') [cmd, args] = ['explorer.exe', [`/select,${path}`]];
  else [cmd, args] = ['xdg-open', [statSync(path).isDirectory() ? path : dirname(path)]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
      .on('error', () => {})
      .unref();
  } catch {}
}
