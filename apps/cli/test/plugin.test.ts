// SPDX-License-Identifier: AGPL-3.0-only
// The repository as a Claude Code plugin and marketplace, its MCP launcher, and the skill packs for apps that take an
// upload (scripts/pack-skills.mjs).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain JavaScript, run by Node with no build
import { answer, findHildegard, installText } from '../../../plugin/mcp.mjs';
// @ts-expect-error: plain JavaScript, run by Node with no build
import { packSkills, skillNames } from '../../../scripts/pack-skills.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

/** The entries of a zip, by reading its central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const local = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    out.set(name, inflateRawSync(buf.subarray(local, local + size)));
    at += 46 + nameLen + extra;
  }
  return out;
}

describe('the Claude Code plugin', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');

  it('is a marketplace of one plugin, the repository itself', () => {
    expect(market.name).toBe('hildegard');
    expect(market.owner.name).toBeTruthy();
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({ name: 'hildegard', source: './' });
    expect(plugin.name).toBe('hildegard');
  });

  it('carries the release version', () => {
    expect(plugin.version).toBe(json('package.json').version);
  });

  it('starts its MCP server from a file in the repository, with no build', () => {
    const server = plugin.mcpServers.hildegard;
    expect(server.command).toBe('node');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code fills in the variable, not JavaScript
    expect(server.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/plugin/mcp.mjs']);
    expect(existsSync(join(root, 'plugin', 'mcp.mjs'))).toBe(true);
  });

  it('has no top-level bin folder, which the Claude app and claude.ai refuse in a plugin', () => {
    expect(existsSync(join(root, 'bin'))).toBe(false);
  });

  it('ships an icon the plugin directory accepts', () => {
    const png = readFileSync(join(root, '.claude-plugin', 'icon.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    expect(statSync(join(root, '.claude-plugin', 'icon.png')).size).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('the plugin’s MCP launcher', () => {
  it('finds Hildegard by HILDEGARD_BIN, then PATH, then where the installer puts it', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    if (process.platform === 'win32') return;
    expect(
      findHildegard(
        { HILDEGARD_BIN: '/opt/h/hildegard', PATH: '/usr/bin' },
        '/home/d',
        has(['/opt/h/hildegard']),
      ),
    ).toBe('/opt/h/hildegard');
    expect(findHildegard({ PATH: '/usr/bin:/x/bin' }, '/home/d', has(['/x/bin/hildegard']))).toBe(
      '/x/bin/hildegard',
    );
    expect(findHildegard({ PATH: '/usr/bin' }, '/home/d', has(['/home/d/.local/bin/hildegard']))).toBe(
      '/home/d/.local/bin/hildegard',
    );
    expect(findHildegard({ PATH: '/usr/bin' }, '/home/d', has([]))).toBeNull();
  });

  it('answers as a stand-in that says how to install Hildegard', () => {
    const init = answer({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(answer({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const tools = answer({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['hildegard_install']);
    const call = answer(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hildegard_install' } },
      'linux',
    );
    expect(call.result.content[0].text).toContain('install.sh | sh');
    expect(installText('win32')).toContain('install.ps1 | iex');
    expect(answer({ jsonrpc: '2.0', id: 4, method: 'nope' }).error.code).toBe(-32601);
  });

  it('speaks MCP over stdio when Hildegard isn’t installed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-plugin-'));
    const child = spawn(process.execPath, [join(root, 'plugin', 'mcp.mjs')], {
      env: { PATH: '', HOME: home, USERPROFILE: home, LOCALAPPDATA: home },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    const lines = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[1].result.tools[0].name).toBe('hildegard_install');
  });
});

describe('the skill packs', () => {
  const out = mkdtempSync(join(tmpdir(), 'hg-pack-'));
  const files: string[] = packSkills(out, '9.9.9');

  it('makes a .plugin with every skill and no MCP server', () => {
    const z = unzip(readFileSync(join(out, 'hildegard.plugin')));
    const manifest = JSON.parse(z.get('.claude-plugin/plugin.json')!.toString());
    expect(manifest.version).toBe('9.9.9');
    expect(manifest.mcpServers).toBeUndefined();
    expect(z.has('README.md')).toBe(true);
    for (const name of skillNames()) expect(z.has(`skills/${name}/SKILL.md`)).toBe(true);
    expect([...z.keys()].some((n) => n.startsWith('bin/') || n.includes('__pycache__'))).toBe(false);
    expect(z.get('skills/hildegard/SKILL.md')!.toString()).toBe(
      readFileSync(join(root, 'skills', 'hildegard', 'SKILL.md'), 'utf8'),
    );
  });

  it('makes one zip per skill, with the skill’s folder at the top', () => {
    expect(files).toHaveLength(skillNames().length + 1);
    const z = unzip(readFileSync(join(out, 'skill-hildegard-3d.zip')));
    expect([...z.keys()].sort()).toEqual(['hildegard-3d/SKILL.md', 'hildegard-3d/scripts/mesh_kit.py']);
    expect([...unzip(readFileSync(join(out, 'skill-hildegard-print.zip'))).keys()].sort()).toEqual([
      'hildegard-print/SKILL.md',
      'hildegard-print/references/measuring.md',
      'hildegard-print/references/parts-and-fits.md',
      'hildegard-print/scripts/print_kit.py',
    ]);
    // The web skill carries its templates, so an app with only the skill can start from one.
    const web = [...unzip(readFileSync(join(out, 'skill-hildegard-web.zip'))).keys()].sort();
    expect(web.slice(0, 2)).toEqual(['hildegard-web/SKILL.md', 'hildegard-web/references/tokens.css']);
    for (const t of ['atelier', 'gathering', 'hearth', 'journal', 'ledger', 'manual', 'parish', 'practice'])
      for (const f of ['index.html', 'styles.css', 'template.json'])
        expect(web).toContain(`hildegard-web/templates/${t}/${f}`);
  });

  it('writes the same bytes for the same files', () => {
    const again = mkdtempSync(join(tmpdir(), 'hg-pack-'));
    packSkills(again, '9.9.9');
    expect(
      readFileSync(join(again, 'hildegard.plugin')).equals(readFileSync(join(out, 'hildegard.plugin'))),
    ).toBe(true);
  });
});
