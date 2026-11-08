// SPDX-License-Identifier: AGPL-3.0-only
// The store listings (scripts/pack-listing.mjs): the Claude directory's skills-only tree, OpenAI's zip, Grok Bot's skill
// zips, and the validator (scripts/check-listing.mjs) that holds each to the rules the stores state.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkClaudeTree,
  checkOpenAIManifest,
  checkOpenAIZip,
  unzip,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/check-listing.mjs';
import {
  CLAUDE,
  OPENAI_LIMITS,
  OPENAI_URLS,
  openaiManifest,
  packListing,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/pack-listing.mjs';
// @ts-expect-error: plain JavaScript, run by Node with no build
import { skillNames } from '../../../scripts/pack-skills.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function build() {
  const tmp = mkdtempSync(join(tmpdir(), 'hg-listing-'));
  const tree = join(tmp, 'plugin');
  const extras = join(tmp, 'extras');
  packListing(tree, extras, '9.9.9');
  return { tmp, tree, extras, zip: join(extras, 'hildegard-openai.zip') };
}

describe('the Claude directory listing', () => {
  const b = build();
  const manifest = JSON.parse(readFileSync(join(b.tree, '.claude-plugin', 'plugin.json'), 'utf8'));

  it('passes every rule the directory states', () => {
    expect(checkClaudeTree(b.tree)).toEqual([]);
  });

  it('is skills only, named for the craft, with every URL the directory asks for', () => {
    expect(manifest.name).toBe('hildegard-craft');
    expect(manifest.version).toBe('9.9.9');
    expect(manifest.license).toBe('AGPL-3.0-only');
    expect(manifest.mcpServers).toBeUndefined();
    for (const k of ['documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl'])
      expect(manifest[k], k).toMatch(/^https:\/\//);
  });

  it('keeps the skills that make media with AI models out of the listing (policy 4B)', () => {
    for (const s of [
      'hildegard-film',
      'hildegard-art',
      'hildegard-sound',
      'hildegard-cloud',
      'hildegard-setup',
    ])
      expect(CLAUDE.skills).not.toContain(s);
    for (const s of CLAUDE.skills) expect(skillNames()).toContain(s);
    for (const s of CLAUDE.skills) expect(CLAUDE.lines[s], s).toBeTruthy();
  });

  it('copies each skill’s files byte for byte', () => {
    for (const s of CLAUDE.skills)
      expect(readFileSync(join(b.tree, 'skills', s, 'SKILL.md'), 'utf8')).toBe(read(`skills/${s}/SKILL.md`));
  });

  it('fails a tree with a .gitattributes, a big file, a binary, a hook, a short README or a generation claim', () => {
    const t = build().tree;
    expect(checkClaudeTree(t)).toEqual([]);
    writeFileSync(join(t, '.gitattributes'), '*.mp4 filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(t, 'skills', 'hildegard', 'big.md'), 'x'.repeat(256 * 1024 + 1));
    writeFileSync(join(t, 'skills', 'hildegard', 'clip.bin'), Buffer.from([0, 1, 2, 3]));
    mkdirSync(join(t, 'hooks'));
    writeFileSync(join(t, 'README.md'), 'Too short to list.');
    const bad = checkClaudeTree(t).join('\n');
    expect(bad).toContain('.gitattributes');
    expect(bad).toContain('big.md');
    expect(bad).toContain('clip.bin: a binary file');
    expect(bad).toContain('hooks');
    expect(bad).toContain('README.md has 4 words');

    const g = build().tree;
    writeFileSync(
      join(g, 'README.md'),
      `This plugin can generate images and video. How to use it: ask. ${'word '.repeat(60)}`,
    );
    expect(checkClaudeTree(g).join('\n')).toContain('claims media generation');
  });

  it('fails more than 512 files, a missing field, an http URL, a skill from outside the list and a pointer file', () => {
    const t = build().tree;
    mkdirSync(join(t, 'skills', 'hildegard', 'many'));
    for (let i = 0; i < 520; i++) writeFileSync(join(t, 'skills', 'hildegard', 'many', `f${i}.md`), 'x');
    const m = JSON.parse(readFileSync(join(t, '.claude-plugin', 'plugin.json'), 'utf8'));
    delete m.privacyPolicyUrl;
    m.termsOfServiceUrl = 'http://example.com/terms';
    m.mcpServers = {};
    writeFileSync(join(t, '.claude-plugin', 'plugin.json'), JSON.stringify(m));
    mkdirSync(join(t, 'skills', 'hildegard-film'));
    writeFileSync(
      join(t, 'skills', 'hildegard-film', 'SKILL.md'),
      '---\nname: hildegard-film\ndescription: x\n---\n',
    );
    writeFileSync(
      join(t, 'skills', 'hildegard', 'video.mp4'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 1\n',
    );
    const bad = checkClaudeTree(t).join('\n');
    expect(bad).toContain('files; the directory holds a plugin over 512');
    expect(bad).toContain('privacyPolicyUrl must be an https URL');
    expect(bad).toContain('termsOfServiceUrl must be an https URL');
    expect(bad).toContain('mcpServers');
    expect(bad).toContain('hildegard-film');
    expect(bad).toContain('git-lfs pointer');
  });
});

describe('the OpenAI zip', () => {
  const b = build();
  const buf = readFileSync(b.zip);
  const files = unzip(buf) as Map<string, Buffer>;
  const m = JSON.parse(files.get('.codex-plugin/plugin.json')!.toString());

  it('passes every limit and carries every skill, the logo and no MCP server', () => {
    expect(checkOpenAIZip(buf)).toEqual([]);
    for (const s of skillNames()) expect(files.has(`skills/${s}/SKILL.md`)).toBe(true);
    expect(m.mcpServers).toBeUndefined();
    expect(m.version).toBe('9.9.9');
  });

  it('fills the four URLs the directory requires', () => {
    for (const [k, v] of Object.entries(OPENAI_URLS)) expect(m.interface[k]).toBe(v);
  });

  it('keeps each field within its limit, and the checker fails each one past it', () => {
    const L = OPENAI_LIMITS;
    const ui = m.interface;
    expect(m.name.length).toBeLessThanOrEqual(L.name);
    expect(ui.displayName.length).toBeLessThanOrEqual(L.displayName);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(L.shortDescription);
    expect(ui.longDescription.length).toBeLessThanOrEqual(L.longDescription);
    expect(ui.capabilities.length).toBeLessThanOrEqual(L.capabilities);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(L.defaultPrompts);
    for (const p of ui.defaultPrompt) expect(p.length).toBeLessThanOrEqual(L.defaultPrompt);

    const over = (patch: (x: typeof m) => void) => {
      const c = structuredClone(m);
      patch(c);
      return checkOpenAIManifest(c).join('\n');
    };
    expect(over((c) => (c.name = 'n'.repeat(65)))).toContain('name is 65');
    expect(over((c) => (c.interface.displayName = 'd'.repeat(31)))).toContain('displayName is 31');
    expect(over((c) => (c.interface.shortDescription = 's'.repeat(31)))).toContain('shortDescription is 31');
    expect(over((c) => (c.interface.longDescription = 'l'.repeat(4001)))).toContain(
      'longDescription is 4001',
    );
    expect(over((c) => (c.interface.capabilities = Array.from({ length: 21 }, () => 'Read')))).toContain(
      '21 items',
    );
    expect(over((c) => (c.interface.capabilities = ['c'.repeat(121)]))).toContain('past 120');
    expect(over((c) => (c.interface.defaultPrompt = ['a', 'b', 'c', 'd']))).toContain('4 prompts');
    expect(over((c) => (c.interface.defaultPrompt = ['p'.repeat(129)]))).toContain('past 128');
    expect(over((c) => (c.interface.brandColor = '#ffee00'))).toContain('contrast on white');
    expect(over((c) => delete c.interface.privacyPolicyURL)).toContain('privacyPolicyURL');
    expect(over((c) => delete c.interface.termsOfServiceURL)).toContain('termsOfServiceURL');
    expect(over((c) => delete c.interface.supportURL)).toContain('supportURL');
    expect(over((c) => delete c.interface.websiteURL)).toContain('websiteURL');
    expect(over((c) => (c.mcpServers = { hildegard: {} }))).toContain('no local MCP server');
  });

  it('is built from the Codex manifest the repository already tests', () => {
    expect(openaiManifest('1.2.3').interface.displayName).toBe(
      JSON.parse(read('.codex-plugin/plugin.json')).interface.displayName,
    );
  });
});

describe('the Grok Bot skills', () => {
  const b = build();
  const dir = join(b.extras, 'grok-bot');

  it('has one zip per skill with its folder at the top, and a combined zip of all of them', () => {
    for (const s of skillNames()) {
      const z = unzip(readFileSync(join(dir, `${s}.zip`))) as Map<string, Buffer>;
      expect(z.has(`${s}/SKILL.md`), s).toBe(true);
      expect([...z.keys()].every((n) => n.startsWith(`${s}/`))).toBe(true);
    }
    const all = unzip(readFileSync(join(dir, 'hildegard-skills.zip'))) as Map<string, Buffer>;
    for (const s of skillNames()) expect(all.has(`${s}/SKILL.md`), s).toBe(true);
  });
});

describe('the pasteable fields', () => {
  it('name every store’s fields and are written beside the packages', () => {
    const b = build();
    const f = readFileSync(join(b.extras, 'listing-fields.md'), 'utf8');
    for (const t of ['claude.ai/directory/manage', 'OpenAI', 'grok.com/connectors', 'Grok Bot', CLAUDE.name])
      expect(f).toContain(t);
    expect(f).not.toMatch(/[–—]/);
  });
});

describe('the privacy and terms pages', () => {
  for (const page of ['privacy', 'terms']) {
    it(`${page}/ is the approved text: no draft banner, no blank for the owner, indexable, with a contact`, () => {
      const html = read(`site/${page}/index.html`);
      expect(html).not.toMatch(/class="draft"|DRAFT|\(draft\)/);
      expect(html).not.toContain('[Owner');
      expect(html).not.toContain('noindex');
      expect(html).toContain('https://github.com/baney75/hildegard/issues');
      expect(html).toContain('mailto:support@dbaney.com');
      expect(html).toContain('Last updated: November 7, 2026');
      expect(html).not.toMatch(/[–—]/);
    });
  }

  it('are linked from the install page footer', () => {
    const html = read('site/index.html');
    expect(html).toContain('<a href="privacy/">Privacy</a>');
    expect(html).toContain('<a href="terms/">Terms</a>');
  });

  it('names the hosts of the app’s outbound connections', () => {
    const html = read('site/privacy/index.html');
    for (const host of [
      'github.com',
      'huggingface.co',
      'pypi.org',
      'tailscale',
      'cloudflare',
      'runpod',
      'figma.com',
      'api.github.com',
    ])
      expect(html.toLowerCase(), host).toContain(host);
  });
});

describe('the Grok guides', () => {
  it('give the fewest steps, with the public link, the connector path and the skills over MCP', () => {
    const g = read('docs/grok.md');
    for (const t of [
      'hildegard tunnel',
      'grok.com/connectors',
      'New Connector',
      'Custom',
      'list_skills',
      'read_skill',
    ])
      expect(g).toContain(t);
    const bot = read('docs/grok-bot.md');
    for (const t of ['hildegard-skills.zip', 'list_skills', 'Streamable HTTP']) expect(bot).toContain(t);
    expect(g + bot).not.toMatch(/[–—]/);
  });
});
