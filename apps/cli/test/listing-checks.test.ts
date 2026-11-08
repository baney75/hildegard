// SPDX-License-Identifier: AGPL-3.0-only
// scripts/check-listing.mjs: a logo or icon must really be an image (PNG, JPEG, WebP or SVG, square, in range), and a
// README or notice that names a license file the package lacks fails the check.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkClaudeTree,
  checkImage,
  checkLicenseFiles,
  checkOpenAIManifest,
  checkOpenAIZip,
  unzip,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/check-listing.mjs';
import {
  packListing,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/pack-listing.mjs';
// @ts-expect-error: plain JavaScript, run by Node with no build
import { zip } from '../../../scripts/pack-skills.mjs';

const root = join(import.meta.dirname, '..', '..', '..');

function build() {
  const tmp = mkdtempSync(join(tmpdir(), 'hg-listing-'));
  const tree = join(tmp, 'plugin');
  const extras = join(tmp, 'extras');
  packListing(tree, extras, '9.9.9');
  return { tmp, tree, extras, zip: join(extras, 'hildegard-openai.zip') };
}

const icon = readFileSync(join(root, '.claude-plugin', 'icon.png'));
const png = (w: number, h: number) => {
  const b = Buffer.from(icon);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([
      0xff,
      0xc0,
      0,
      17,
      8,
      h >> 8,
      h & 255,
      w >> 8,
      w & 255,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]),
    Buffer.from([0xff, 0xd9]),
  ]);
const webpX = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0);
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8);
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const webpL = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0);
  b.write('WEBPVP8L', 8);
  b[20] = 0x2f;
  b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
};
const svg = (attrs: string, body = '<circle r="4"/>') =>
  Buffer.from(
    `<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>\n`,
  );

describe('license files in the packages', () => {
  it('fails a zip or a tree whose notices name a license file that is not in the package', () => {
    const b = build();
    const z = unzip(readFileSync(b.zip)) as Map<string, Buffer>;
    expect(checkOpenAIZip(readFileSync(b.zip))).toEqual([]);
    z.delete('LICENSE-APACHE');
    const without = zip([...z.entries()]);
    expect(checkOpenAIZip(without).join('\n')).toContain(
      'refers to LICENSE-APACHE, which isn’t in the package',
    );
    rmSync(join(b.tree, 'LICENSE-APACHE'));
    expect(checkClaudeTree(b.tree).join('\n')).toContain(
      'refers to LICENSE-APACHE, which isn’t in the package',
    );
    const wrong = build();
    writeFileSync(join(wrong.tree, 'LICENSE-APACHE'), 'not a license');
    expect(checkClaudeTree(wrong.tree).join('\n')).toContain('isn’t the Apache License text');
  });

  it('reads a reference of any LICENSE-NAME', () => {
    expect(
      checkLicenseFiles({ 'a.md': 'see LICENSE-MIT and LICENSE' }, (n: string) => n === 'LICENSE'),
    ).toEqual(['a.md refers to LICENSE-MIT, which isn’t in the package']);
  });
});

describe('the logo and the icon must really be images', () => {
  const bad = (buf: Buffer) => (checkImage(buf, 'logo') as string[]).join('\n');

  it('accepts a square PNG, JPEG, WebP (lossless and extended) and SVG in range', () => {
    expect(checkImage(icon, 'logo')).toEqual([]);
    expect(checkImage(jpeg(256, 256), 'logo')).toEqual([]);
    expect(checkImage(webpX(256, 256), 'logo')).toEqual([]);
    expect(checkImage(webpL(256, 256), 'logo')).toEqual([]);
    expect(checkImage(svg('viewBox="0 0 24 24"'), 'logo')).toEqual([]);
    expect(checkImage(svg('width="64px" height="64"'), 'logo')).toEqual([]);
  });

  it('rejects a text file, a Markdown file, random bytes and a PNG cut short or with its signature changed', () => {
    expect(bad(readFileSync(join(root, 'README.md')))).toContain('isn’t a PNG, JPEG, WebP or SVG');
    expect(bad(Buffer.from('PNG but not'))).toContain('isn’t a PNG, JPEG, WebP or SVG');
    expect(bad(Buffer.from([1, 2, 3, 4, 5]))).toContain('isn’t a PNG, JPEG, WebP or SVG');
    expect(bad(icon.subarray(0, 40))).toContain('isn’t a PNG, JPEG, WebP or SVG');
    expect(bad(Buffer.concat([Buffer.from([0]), icon.subarray(1)]))).toContain('isn’t a PNG');
  });

  it('rejects an SVG that is not XML, has no svg root, is unclosed, or states no size', () => {
    expect(bad(Buffer.from('<html><body></body></html>'))).toContain('root element is <html>');
    expect(bad(Buffer.from('<svg viewBox="0 0 8 8"><g></svg>'))).toContain('closes nothing');
    expect(bad(Buffer.from('<svg viewBox="0 0 8 8"><g>'))).toContain('never closed');
    expect(bad(Buffer.from('hello <svg viewBox="0 0 8 8"/>'))).toContain('outside the root');
    expect(bad(Buffer.from('<svg viewBox="0 0 8 8"/><svg viewBox="0 0 8 8"/>'))).toContain(
      'more than one root',
    );
    expect(bad(svg(''))).toContain('states no size');
  });

  it('rejects a non-square image of any format and a size out of range', () => {
    for (const b of [
      png(512, 256),
      jpeg(300, 200),
      webpX(300, 200),
      webpL(300, 200),
      svg('viewBox="0 0 24 12"'),
    ])
      expect(bad(b)).toContain('isn’t square');
    expect(bad(png(16, 16))).toContain('needs 64 to 4096');
    expect(bad(png(8192, 8192))).toContain('needs 64 to 4096');
    expect(bad(png(0, 0))).toContain('no size');
  });

  it('fails the OpenAI manifest check when the logo is a text file or a wide PNG', () => {
    const b = build();
    const z = unzip(readFileSync(b.zip)) as Map<string, Buffer>;
    const m = JSON.parse(z.get('.codex-plugin/plugin.json')!.toString());
    const logo = m.interface.logo.replace(/^\.\//, '');
    expect(checkOpenAIManifest(m, z)).toEqual([]);
    z.set(logo, readFileSync(join(root, 'README.md')));
    expect(checkOpenAIManifest(m, z).join('\n')).toContain('the logo isn’t a PNG, JPEG, WebP or SVG');
    z.set(logo, png(512, 256));
    expect(checkOpenAIManifest(m, z).join('\n')).toContain('the logo isn’t square');
    z.set(logo, icon);
    z.set(m.interface.composerIcon.replace(/^\.\//, ''), Buffer.from('not an image'));
    expect(checkOpenAIManifest(m, z).join('\n')).toContain('the composer icon isn’t a PNG');
  });

  it('fails the Claude tree whose icon is a text file', () => {
    const t = build().tree;
    writeFileSync(join(t, '.claude-plugin', 'icon.png'), 'just words, not a picture');
    expect(checkClaudeTree(t).join('\n')).toContain('the icon isn’t a PNG, JPEG, WebP or SVG');
  });
});
