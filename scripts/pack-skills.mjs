// SPDX-License-Identifier: AGPL-3.0-only
// Packs Hildegard's skills for the apps that take an upload rather than a folder:
//
//   node scripts/pack-skills.mjs [out-dir] [version]
//
// - hildegard.plugin: every skill, as a Claude plugin for the Claude app and Cowork (Settings › Plugins › Upload).
//   It carries no MCP server: those apps link Hildegard as a connector (docs/chatbots.md).
// - hildegard-codex.zip: every skill, as a Codex plugin for OpenAI's plugin directory (platform.openai.com/plugins ›
//   Upload plugin), which takes skills-only plugins; Codex links Hildegard's tools with `hildegard connect codex`.
// - skill-<name>.zip: one skill each, for claude.ai (Settings › Capabilities › Skills) and ChatGPT (Skills ›
//   Upload), which take one skill folder per zip.
//
// The zips are written here with no dependencies, and are the same bytes for the same files: entries in name order,
// with a fixed date.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = /(^|[\\/])(__pycache__|\.pytest_cache|\.DS_Store)([\\/]|$)|\.pyc$/;

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A zip of [name, bytes] entries, deflated. 1 January 2026, 00:00, as the DOS date of every entry. */
export function zip(entries) {
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const n = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    local.push(head, n, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(0x0314, 4); // made by Unix, so the permissions below are read
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += 30 + n.length + packed.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** Every file under dir, as [path inside the zip, bytes], with `prefix` before each path. */
function tree(dir, prefix) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (SKIP.test(p)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.push([`${prefix}${relative(dir, p).split(sep).join('/')}`, readFileSync(p)]);
    }
  };
  walk(dir);
  return out;
}

export function skillNames(skills = join(root, 'skills')) {
  return readdirSync(skills)
    .filter((n) => statSync(join(skills, n, 'SKILL.md'), { throwIfNoEntry: false })?.isFile())
    .sort();
}

/** Writes hildegard.plugin, hildegard-codex.zip and skill-<name>.zip into out, and returns their paths. */
export function packSkills(out, version, repo = root) {
  const skills = join(repo, 'skills');
  const manifest = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
  delete manifest.mcpServers;
  manifest.version = version;
  const plugin = [
    ['.claude-plugin/plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['.claude-plugin/icon.png', readFileSync(join(repo, '.claude-plugin', 'icon.png'))],
    ['README.md', readFileSync(join(repo, 'plugin', 'README.md'))],
    ['LICENSE', readFileSync(join(repo, 'LICENSE'))],
    ...tree(skills, 'skills/'),
  ];
  const codex = JSON.parse(readFileSync(join(repo, '.codex-plugin', 'plugin.json'), 'utf8'));
  codex.version = version;
  const codexPlugin = [
    ['.codex-plugin/plugin.json', Buffer.from(`${JSON.stringify(codex, null, 2)}\n`)],
    ...plugin.filter(([name]) => name !== '.claude-plugin/plugin.json'),
  ];
  mkdirSync(out, { recursive: true });
  const written = [join(out, 'hildegard.plugin'), join(out, 'hildegard-codex.zip')];
  writeFileSync(written[0], zip(plugin));
  writeFileSync(written[1], zip(codexPlugin));
  for (const name of skillNames(skills)) {
    const file = join(out, `skill-${name}.zip`);
    writeFileSync(file, zip(tree(join(skills, name), `${name}/`)));
    written.push(file);
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? join(root, 'dist', 'skills');
  const version = process.argv[3] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  for (const f of packSkills(out, version)) console.log(f);
}
