// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reads a ZIP archive that came from anywhere (a website an agent sends to a loop), into a folder, without trusting a
 * byte of it: no path leaves the folder, no link is made, nothing is encrypted or spans disks, and the sizes it claims
 * are held to limits before anything is inflated (and while it is, so a small file can't expand into a huge one).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

export interface ZipLimits {
  files: number;
  bytes: number;
}
const LIMITS: ZipLimits = { files: 2000, bytes: 200 * 1024 * 1024 };

/** A safe relative path inside the archive, or null for one to refuse (absolute, `..`, a drive, odd characters). */
export function safeName(name: string): string | null {
  if (!name || name.length > 300 || name.includes('\\') || name.includes('\0')) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (
    !parts.length ||
    parts.some((p) => p === '..' || /[<>:"|?*]/.test(p) || [...p].some((ch) => ch.charCodeAt(0) < 32))
  )
    return null;
  return parts.join('/');
}

export interface Entry {
  name: string;
  data: Buffer;
}

/** The archive's files (directories and macOS litter left out). Throws ZipError on anything it won't read. */
export function readZip(bytes: Uint8Array, limits: ZipLimits = LIMITS): Entry[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new ZipError('That isn’t a ZIP archive, or it’s cut short.');
  const count = b.readUInt16LE(end + 10);
  const cdSize = b.readUInt32LE(end + 12);
  let at = b.readUInt32LE(end + 16);
  if (b.readUInt16LE(end + 4) !== 0 || count === 0xffff || at === 0xffffffff)
    throw new ZipError('This ZIP spans disks or uses ZIP64. Make an ordinary ZIP.');
  if (count > limits.files) throw new ZipError(`A site up to ${limits.files} files.`);
  if (at + cdSize > end) throw new ZipError('This ZIP’s directory is damaged.');
  const out: Entry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || b.readUInt32LE(at) !== 0x02014b50)
      throw new ZipError('This ZIP’s directory is damaged.');
    const flags = b.readUInt16LE(at + 8);
    const method = b.readUInt16LE(at + 10);
    const packed = b.readUInt32LE(at + 20);
    const size = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    const mode = b.readUInt32LE(at + 38) >>> 16;
    const local = b.readUInt32LE(at + 42);
    const raw = b.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (raw.endsWith('/') || raw.startsWith('__MACOSX/') || raw.split('/').at(-1) === '.DS_Store') continue;
    if (flags & 1) throw new ZipError('This ZIP is encrypted.');
    if ((mode & 0o170000) === 0o120000)
      throw new ZipError(`This ZIP holds a link (${raw}); send the files themselves.`);
    const name = safeName(raw);
    if (!name) throw new ZipError(`This ZIP has a path Hildegard won’t write: ${raw.slice(0, 80)}`);
    if (method !== 0 && method !== 8)
      throw new ZipError(`${name} is compressed in a way Hildegard doesn’t read.`);
    total += size;
    if (total > limits.bytes) throw new ZipError(`A site up to ${limits.bytes / 1024 / 1024} MB unpacked.`);
    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50)
      throw new ZipError('This ZIP is damaged.');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + packed > b.length) throw new ZipError('This ZIP is cut short.');
    const body = b.subarray(start, start + packed);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(body) : inflateRawSync(body, { maxOutputLength: Math.max(1, size) });
    } catch {
      throw new ZipError(`${name} in this ZIP is damaged, or bigger than it says.`);
    }
    if (data.length !== size) throw new ZipError(`${name} in this ZIP isn’t the size it says.`);
    out.push({ name, data });
  }
  return out;
}

/**
 * Unpacks into `dir` (which must be new or empty). A site zipped as one folder is unpacked from inside it, so its
 * index.html lands at the top. Returns the files' paths, relative to `dir`.
 */
export function unzipTo(bytes: Uint8Array, dir: string, limits?: ZipLimits): string[] {
  let entries = readZip(bytes, limits);
  if (!entries.length) throw new ZipError('This ZIP is empty.');
  const top = entries[0]!.name.split('/')[0]!;
  if (!entries.some((e) => !e.name.includes('/')) && entries.every((e) => e.name.startsWith(`${top}/`)))
    entries = entries.map((e) => ({ ...e, name: e.name.slice(top.length + 1) }));
  const root = resolve(dir);
  const names: string[] = [];
  for (const e of entries) {
    const path = resolve(root, e.name);
    if (!path.startsWith(root + sep))
      throw new ZipError(`This ZIP has a path Hildegard won’t write: ${e.name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, e.data, { flag: 'wx' });
    names.push(e.name);
  }
  return names;
}
