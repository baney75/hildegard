// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sites: the owner's websites as folders Hildegard keeps, so a design can start from a template, a Figma file, a
 * pen.dev file or a site that's already live, be edited by any linked AI app or on the canvas, and go through the web
 * loop from where it stands. Each site is a folder of files under the data directory with a site.json beside it; only
 * paths that pass safeName go in, and a site is held to the same limits as a site sent to a loop.
 *
 * A site's pages are previewed at /preview/<id>/<key>/…: the key is a random secret per site, so a page can be framed
 * by the Studio without a session cookie, and the page runs sandboxed, in an origin of its own, cut off from the API.
 */
import { randomBytes } from 'node:crypto';
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
import { dirname, join, relative, sep } from 'node:path';
import { zip } from '@hildegard/mcp';
import { safeName } from './zip.ts';

export type SiteSource = 'template' | 'figma' | 'pen' | 'url' | 'files' | 'empty';

export interface Site {
  id: string;
  title: string;
  source: { kind: SiteSource; from: string | null };
  createdAt: string;
  updatedAt: string;
  /** The secret part of the preview address. */
  previewKey: string;
  /** An image of the design to hold the site to (a Figma frame, a screenshot), and the width it was drawn at. */
  reference: { file: string; width: number } | null;
  /** What the import couldn't carry over, and what's left to do. */
  notes: string[];
}

export interface SiteView extends Site {
  pages: string[];
  files: number;
  bytes: number;
}

export class SiteError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 422 | 501 | 502;
  readonly code: string;
  constructor(status: SiteError['status'], code: string, message: string) {
    super(message);
    this.name = 'SiteError';
    this.status = status;
    this.code = code;
  }
}

export const SITE_LIMITS = { files: 2000, bytes: 200 * 1024 * 1024, file: 50 * 1024 * 1024 };
const ID = /^[a-f0-9]{12}$/;

/** A path inside a site, checked; names starting with a dot are Hildegard's. */
export function sitePath(p: string): string {
  const s = safeName(p.replace(/^\.\//, ''));
  if (!s || s.split('/').some((part) => part.startsWith('.')))
    throw new SiteError(422, 'path', `“${p.slice(0, 80)}” isn’t a path inside the site.`);
  return s;
}

export class Sites {
  readonly dir: string;
  private readonly now: () => Date;
  constructor(dir: string, now = () => new Date()) {
    this.dir = dir;
    this.now = now;
    mkdirSync(dir, { recursive: true });
  }

  private meta(id: string) {
    return join(this.dir, id, 'site.json');
  }
  /** The folder that holds the site's files. */
  folder(id: string) {
    return join(this.dir, this.get(id).id, 'files');
  }

  private save(s: Site) {
    const tmp = `${this.meta(s.id)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(tmp, this.meta(s.id));
  }

  get(id: string): Site {
    if (!ID.test(id) || !existsSync(this.meta(id)))
      throw new SiteError(404, 'no_site', 'There’s no such site.');
    return JSON.parse(readFileSync(this.meta(id), 'utf8')) as Site;
  }

  view(id: string): SiteView {
    const s = this.get(id);
    const files = this.files(id);
    return {
      ...s,
      pages: files.filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path),
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    };
  }

  list(): SiteView[] {
    return readdirSync(this.dir)
      .filter((d) => ID.test(d) && existsSync(this.meta(d)))
      .map((d) => this.view(d))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Every file in the site, by path, with its size. */
  files(id: string): { path: string; bytes: number }[] {
    const root = join(this.dir, id, 'files');
    const out: { path: string; bytes: number }[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile())
          out.push({ path: relative(root, p).split(sep).join('/'), bytes: statSync(p).size });
      }
    };
    if (existsSync(root)) walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  create(input: {
    title: string;
    source: SiteSource;
    from?: string | null;
    files: Iterable<[string, Uint8Array | string]>;
    reference?: { data: Uint8Array; width: number } | null;
    notes?: string[];
  }): SiteView {
    const id = randomBytes(6).toString('hex');
    const at = this.now().toISOString();
    const root = join(this.dir, id);
    const site: Site = {
      id,
      title: input.title.trim().slice(0, 120) || 'Untitled site',
      source: { kind: input.source, from: input.from?.slice(0, 500) ?? null },
      createdAt: at,
      updatedAt: at,
      previewKey: randomBytes(18).toString('base64url'),
      reference: null,
      notes: (input.notes ?? []).map((n) => n.slice(0, 1000)).slice(0, 40),
    };
    mkdirSync(join(root, 'files'), { recursive: true });
    try {
      let count = 0;
      let total = 0;
      for (const [path, data] of input.files) {
        const p = sitePath(path);
        const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
        count++;
        total += buf.length;
        if (count > SITE_LIMITS.files)
          throw new SiteError(413, 'size', `A site up to ${SITE_LIMITS.files} files.`);
        if (buf.length > SITE_LIMITS.file || total > SITE_LIMITS.bytes)
          throw new SiteError(413, 'size', 'A site up to 200 MB, each file up to 50 MB.');
        const to = join(root, 'files', p);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, buf);
      }
      this.save(site);
      if (input.reference) this.setReference(id, input.reference.data, input.reference.width);
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      throw e;
    }
    return this.view(id);
  }

  read(id: string, path: string): Buffer {
    const file = join(this.folder(id), sitePath(path));
    if (!existsSync(file) || !statSync(file).isFile())
      throw new SiteError(404, 'no_file', `The site has no ${path.slice(0, 80)}.`);
    return readFileSync(file);
  }

  /** Writes one file (making its folders), within the site's limits. */
  write(id: string, path: string, data: Uint8Array | string): SiteView {
    const s = this.get(id);
    const p = sitePath(path);
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    if (buf.length > SITE_LIMITS.file) throw new SiteError(413, 'size', 'Files up to 50 MB.');
    const files = this.files(id);
    const old = files.find((f) => f.path === p);
    if (!old && files.length >= SITE_LIMITS.files)
      throw new SiteError(413, 'size', `A site up to ${SITE_LIMITS.files} files.`);
    if (files.reduce((n, f) => n + f.bytes, 0) - (old?.bytes ?? 0) + buf.length > SITE_LIMITS.bytes)
      throw new SiteError(413, 'size', 'A site up to 200 MB.');
    const to = join(this.folder(id), p);
    if (existsSync(to) && statSync(to).isDirectory()) throw new SiteError(409, 'folder', `${p} is a folder.`);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(`${to}.hg-tmp`, buf);
    renameSync(`${to}.hg-tmp`, to);
    this.touch(s);
    return this.view(id);
  }

  remove(id: string, path: string): SiteView {
    const s = this.get(id);
    const to = join(this.folder(id), sitePath(path));
    if (!existsSync(to)) throw new SiteError(404, 'no_file', `The site has no ${path.slice(0, 80)}.`);
    rmSync(to, { recursive: true, force: true });
    this.touch(s);
    return this.view(id);
  }

  /** Changes the title, or makes a new preview key (which retires every preview link given out). */
  update(id: string, patch: { title?: string; newPreviewKey?: boolean; notes?: string[] }): SiteView {
    const s = this.get(id);
    if (patch.title !== undefined) s.title = patch.title.trim().slice(0, 120) || s.title;
    if (patch.newPreviewKey) s.previewKey = randomBytes(18).toString('base64url');
    if (patch.notes) s.notes = patch.notes.map((n) => n.slice(0, 1000)).slice(0, 40);
    this.touch(s);
    return this.view(id);
  }

  delete(id: string) {
    this.get(id);
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  /** The image of the design (PNG or JPEG) and the width it was drawn at. */
  setReference(id: string, data: Uint8Array, width: number): SiteView {
    const s = this.get(id);
    const b = Buffer.from(data);
    const png = b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpg = b[0] === 0xff && b[1] === 0xd8;
    if (!png && !jpg) throw new SiteError(422, 'reference', 'The design’s image has to be a PNG or a JPEG.');
    if (b.length > 40 * 1024 * 1024) throw new SiteError(413, 'size', 'The design’s image up to 40 MB.');
    if (!(width >= 320 && width <= 3840))
      throw new SiteError(422, 'reference', 'Say the width the design was drawn at, 320 to 3840 pixels.');
    for (const old of ['reference.png', 'reference.jpg']) rmSync(join(this.dir, id, old), { force: true });
    const file = png ? 'reference.png' : 'reference.jpg';
    writeFileSync(join(this.dir, id, file), b);
    s.reference = { file, width: Math.round(width) };
    this.touch(s);
    return this.view(id);
  }

  referencePath(id: string): string | null {
    const s = this.get(id);
    return s.reference ? join(this.dir, id, s.reference.file) : null;
  }

  /** The site as a ZIP, to download or to send through a loop. */
  zip(id: string): Buffer {
    const root = this.folder(id);
    return zip(this.files(id).map((f) => ({ name: f.path, data: readFileSync(join(root, f.path)) })));
  }

  private touch(s: Site) {
    s.updatedAt = this.now().toISOString();
    this.save(s);
  }
}
