// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Packs a site's folder as a ZIP, so a coding agent can send a whole website to a loop with one file_path. Only
 * regular files are packed (never links, which could point anywhere on this computer), and dotfiles, node_modules
 * and version-control folders stay behind.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export class PackError extends Error {}

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', '__MACOSX']);

/** The files under `dir`, relative and with forward slashes, within the limits. */
export function siteFiles(dir: string, limits = { files: 2000, bytes: 200 * 1024 * 1024 }) {
  const out: { name: string; path: string }[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const path = join(d, e.name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        total += st.size;
        if (out.length >= limits.files) throw new PackError(`A site up to ${limits.files} files.`);
        if (total > limits.bytes) throw new PackError(`A site up to ${limits.bytes / 1024 / 1024} MB.`);
        out.push({ name: relative(dir, path).split(sep).join('/'), path });
      }
    }
  };
  walk(dir);
  return out;
}

/** A ZIP of the given files (deflated where it helps). */
export function zip(entries: { name: string; data: Uint8Array }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const packed = deflateRawSync(data);
    const store = packed.length >= data.length;
    const body = store ? data : packed;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** A site's folder, packed. */
export function zipFolder(dir: string): Buffer {
  const files = siteFiles(dir);
  if (!files.some((f) => /\.html?$/i.test(f.name))) throw new PackError(`There’s no HTML page in ${dir}.`);
  return zip(files.map((f) => ({ name: f.name, data: readFileSync(f.path) })));
}
