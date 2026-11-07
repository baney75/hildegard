// SPDX-License-Identifier: AGPL-3.0-only
// The listing generator (scripts/pack-listing.mjs) replaces only a folder it made itself, the OpenAI package carries
// the Apache license its notices name, and the privacy page lists what the skills reach for. Every refusal runs
// against a throwaway repository: a guard that failed would delete what is in it, as the old one did.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  unzip,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/check-listing.mjs';
import {
  MARKER,
  packClaude,
  packListing,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/pack-listing.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fresh = () => mkdtempSync(join(tmpdir(), 'hg-out-'));

describe('packing into a folder (the generator only ever replaces its own output)', () => {
  // sandbox/repo is the stand-in for this checkout; the sandbox is its parent. Nothing real is in reach.
  const sandbox = fresh();
  const fake = join(sandbox, 'repo');
  for (const d of ['.claude-plugin', 'apps/cli', 'dist']) mkdirSync(join(fake, d), { recursive: true });
  writeFileSync(join(fake, '.claude-plugin', 'plugin.json'), '{"name":"hildegard"}');
  writeFileSync(join(fake, 'canary.txt'), 'alive');
  const refused = (out: string) => {
    try {
      packClaude(out, '9.9.9', fake);
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };
  const intact = () => {
    expect(readFileSync(join(fake, 'canary.txt'), 'utf8')).toBe('alive');
    expect(existsSync(join(fake, 'apps', 'cli'))).toBe(true);
  };

  it('refuses the repository, "." from it and the folder above it', () => {
    expect(refused(fake)).toContain('repository');
    const cwd = process.cwd();
    try {
      process.chdir(fake);
      expect(refused('.')).toContain('repository');
    } finally {
      process.chdir(cwd);
    }
    expect(refused(sandbox)).toContain('repository');
    expect(refused(join(fake, 'apps'))).toContain('inside the repository');
    intact();
  });

  it('refuses a folder with a plugin.json but no marker, and a git checkout', () => {
    const full = fresh();
    mkdirSync(join(full, '.claude-plugin'));
    writeFileSync(join(full, '.claude-plugin', 'plugin.json'), '{"name":"hildegard"}');
    expect(refused(full)).toContain('wasn’t made by this script');
    expect(existsSync(join(full, '.claude-plugin', 'plugin.json'))).toBe(true);
    const git = fresh();
    mkdirSync(join(git, '.git'));
    expect(refused(git)).toContain('git checkout');
  });

  it('follows a link, so one that points into the repository is refused', () => {
    const link = join(fresh(), 'link');
    symlinkSync(fake, link);
    expect(refused(link)).toContain('repository');
    intact();
  });

  it('replaces its own marked output and nothing else in it', () => {
    const out = join(fresh(), 'plugin');
    packClaude(out, '9.9.9');
    expect(existsSync(join(out, MARKER))).toBe(true);
    writeFileSync(join(out, 'stale.txt'), 'old');
    packClaude(out, '9.9.10');
    expect(existsSync(join(out, 'stale.txt'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe(
      '9.9.10',
    );
  });
});

describe('the OpenAI package', () => {
  it('carries LICENSE-APACHE, the license its notices name', () => {
    const extras = join(fresh(), 'extras');
    packListing(join(fresh(), 'plugin'), extras, '9.9.9');
    const z = unzip(readFileSync(join(extras, 'hildegard-openai.zip'))) as Map<string, Buffer>;
    expect(z.get('LICENSE-APACHE')?.toString()).toBe(read('LICENSE-APACHE'));
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
