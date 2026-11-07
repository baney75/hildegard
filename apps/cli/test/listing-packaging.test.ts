// SPDX-License-Identifier: AGPL-3.0-only
// The listing generator's guards (scripts/pack-listing.mjs, scripts/check-listing.mjs): it replaces only a folder it
// made itself, both packages carry the license files their notices name, a logo must really be an image, and the
// privacy page lists what the skills reach for.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  MARKER,
  MARKER_TEXT,
  packClaude,
  packListing,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/pack-listing.mjs';
// @ts-expect-error: plain JavaScript, run by Node with no build
import { zip } from '../../../scripts/pack-skills.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

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

describe('packing into a folder (the generator only ever replaces its own output)', () => {
  const fresh = () => mkdtempSync(join(tmpdir(), 'hg-out-'));
  // The refusals run against a throwaway repository, never this checkout: a guard that failed would delete what is
  // in it (the old one did), so it holds a canary and nothing else.
  const fake = fresh();
  for (const d of ['.claude-plugin', 'apps/cli', 'skills', 'scripts', 'dist'])
    mkdirSync(join(fake, d), { recursive: true });
  writeFileSync(join(fake, '.claude-plugin', 'plugin.json'), '{"name":"hildegard"}');
  writeFileSync(join(fake, 'canary.txt'), 'alive');
  const refused = (out: string) => {
    let message = '';
    try {
      packClaude(out, '9.9.9', fake);
    } catch (e) {
      message = (e as Error).message;
    }
    return message;
  };
  const intact = () => {
    expect(readFileSync(join(fake, 'canary.txt'), 'utf8')).toBe('alive');
    expect(existsSync(join(fake, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(fake, 'apps', 'cli'))).toBe(true);
  };

  it('writes a marker and the tree into a new folder, and replaces it on the next build', () => {
    const out = join(fresh(), 'plugin');
    packClaude(out, '9.9.9');
    expect(readFileSync(join(out, MARKER), 'utf8')).toBe(MARKER_TEXT);
    writeFileSync(join(out, 'stale.txt'), 'old');
    packClaude(out, '9.9.10');
    expect(existsSync(join(out, 'stale.txt'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe(
      '9.9.10',
    );
    expect(checkClaudeTree(out)).toEqual([]);
  });

  it('takes an empty folder and a build folder under dist/ in the repository', () => {
    const empty = fresh();
    packClaude(empty, '9.9.9');
    expect(existsSync(join(empty, MARKER))).toBe(true);
    const inDist = join(root, 'dist', `listing-test-${process.pid}`);
    try {
      packClaude(inDist, '9.9.9');
      expect(existsSync(join(inDist, MARKER))).toBe(true);
    } finally {
      rmSync(inDist, { recursive: true, force: true });
    }
  });

  it('refuses the repository root, "." from it, and everything above it', () => {
    expect(refused(fake)).toContain('repository');
    const cwd = process.cwd();
    try {
      process.chdir(fake);
      expect(refused('.')).toContain('repository');
    } finally {
      process.chdir(cwd);
    }
    expect(refused(dirname(fake))).toContain('repository');
    intact();
  });

  it('refuses any folder inside the repository except one under dist/', () => {
    for (const p of ['apps', 'skills', '.claude-plugin', 'dist', 'scripts/new-folder'])
      expect(refused(join(fake, p)), p).toContain('inside the repository');
    expect(existsSync(join(fake, 'scripts', 'new-folder'))).toBe(false);
    intact();
  });

  it('refuses a folder that holds a plugin.json but not the marker (the full plugin the old guard overwrote)', () => {
    const full = fresh();
    mkdirSync(join(full, '.claude-plugin'));
    writeFileSync(join(full, '.claude-plugin', 'plugin.json'), '{"name":"hildegard"}');
    writeFileSync(join(full, 'keep.txt'), 'mine');
    expect(refused(full)).toContain('wasn’t made by this script');
    expect(readFileSync(join(full, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('refuses a folder with other files, one with the wrong marker, a git checkout and a file', () => {
    const other = fresh();
    writeFileSync(join(other, 'notes.txt'), 'mine');
    expect(refused(other)).toContain('wasn’t made by this script');
    const wrong = fresh();
    writeFileSync(join(wrong, MARKER), 'someone else');
    writeFileSync(join(wrong, 'keep.txt'), 'mine');
    expect(refused(wrong)).toContain('wasn’t made by this script');
    expect(existsSync(join(wrong, 'keep.txt'))).toBe(true);
    const git = fresh();
    mkdirSync(join(git, '.git'));
    expect(refused(git)).toContain('git checkout');
    const gitMarked = fresh();
    packClaude(gitMarked, '9.9.9');
    mkdirSync(join(gitMarked, '.git'));
    expect(refused(gitMarked)).toContain('git checkout');
    const file = join(fresh(), 'a-file');
    writeFileSync(file, 'x');
    expect(refused(file)).toContain('is a file');
  });

  it('follows a link, so one that points into the repository is refused', () => {
    const link = join(fresh(), 'link');
    symlinkSync(fake, link);
    expect(refused(link)).toContain('repository');
    const under = join(fresh(), 'under');
    symlinkSync(join(fake, 'apps'), under);
    expect(refused(join(under, 'cli'))).toContain('inside the repository');
    expect(existsSync(join(fake, 'apps', 'cli', MARKER))).toBe(false);
    intact();
  });
});

describe('license files in the packages', () => {
  it('puts LICENSE-APACHE in the OpenAI zip and the Claude tree', () => {
    const b = build();
    const z = unzip(readFileSync(b.zip)) as Map<string, Buffer>;
    expect(z.get('LICENSE-APACHE')?.toString()).toBe(read('LICENSE-APACHE'));
    expect(z.get('THIRD_PARTY_NOTICES.md')?.toString()).toContain('LICENSE-APACHE');
    expect(readFileSync(join(b.tree, 'LICENSE-APACHE'), 'utf8')).toBe(read('LICENSE-APACHE'));
  });

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

describe('the privacy page and the skills', () => {
  const html = read('site/privacy/index.html').toLowerCase();
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    );
  const all = files('skills')
    .filter((f) => /\.(md|py|html|css|svg|js|json|toml)$/.test(f))
    .map((f) => [f, read(f)] as const);

  it('names the model download and every package a skill tells you to install', () => {
    // Anything a skill says to `pip install` is a download from pypi.org that the page must list.
    const packages = new Set<string>();
    for (const [, body] of all)
      for (const m of body.matchAll(/pip3? install ([^\n`(),;]+)/g))
        for (const t of m[1]!.trim().split(/\s+/)) if (/^[A-Za-z][\w.-]*$/.test(t)) packages.add(t);
    expect([...packages].sort()).toEqual(
      ['bpy', 'librosa', 'onnxruntime', 'pronouncing', 'rembg', 'scikit-image', 'soundfile'].sort(),
    );
    for (const p of packages) expect(html, `pip install ${p}`).toContain(p.toLowerCase());
    expect(html).toContain('danielgatis/rembg');
    expect(html).toContain('files.pythonhosted.org');
    expect(html).toContain('registry.npmjs.org');
    expect(all.some(([, b]) => b.includes('@fontsource'))).toBe(true);
    expect(html).toContain('@fontsource');
    for (const [f, b] of all)
      for (const m of b.matchAll(/\b(?:npm|pnpm|yarn) (?:i|install|add) ([^\n`(),;]+)/g))
        expect(html, `${f}: ${m[0]}`).toContain(m[1]!.trim().split(/\s+/)[0]!.toLowerCase());
  });

  it('names every host a skill file links to, and no helper script opens a connection', () => {
    // Hosts that are text in an example or a citation format, not something a skill reaches.
    const text = new Set(['www.w3.org', 'doi.org', 'example.com', 'shop.example', 'tern.example']);
    const hosts = new Set<string>();
    for (const [, body] of all)
      for (const m of body.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) if (!text.has(m[1]!)) hosts.add(m[1]!);
    for (const h of hosts) expect(html, h).toContain(h.toLowerCase());
    for (const [f, body] of all.filter(([f]) => f.endsWith('.py')))
      expect(body, f).not.toMatch(
        /^\s*(?:import|from)\s+(?:urllib|http|socket|requests|httpx|ftplib|smtplib|aiohttp|websockets|ssl|webbrowser)\b/m,
      );
  });

  it('is right that the page templates load nothing from another site', () => {
    for (const [f, body] of all.filter(([f]) => f.startsWith(join('skills', 'hildegard-web', 'templates'))))
      expect(body, f).not.toMatch(
        /(?:src|href)\s*=\s*["']https?:|url\(\s*["']?https?:|@import\s+(?:url\()?["']?https?:/i,
      );
  });
});
