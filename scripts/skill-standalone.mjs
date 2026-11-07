// SPDX-License-Identifier: AGPL-3.0-only
// Does each skill work when it is the only one there? claude.ai and ChatGPT take one skill folder per zip
// (scripts/pack-skills.mjs writes skill-<name>.zip), so a skill that points at another skill's file, a script it does not
// carry, or a Hildegard tool with no way around it is broken for the people who upload it alone.
//
//   node scripts/skill-standalone.mjs [--json]    pack every skill, open each zip on its own, print the problems (exit 1)
//
// `standaloneProblems` is what packages/agents/test/skills-standalone.test.ts runs in CI. It reads one skill's zip
// entries and reports: a link or a scripts/, references/ or templates/ path the skill names that is not inside the zip;
// a path out of the folder (`../`) or into another skill (`skills/<name>`); a script that another skill ships and this
// one names without carrying; a description over 200 characters or with ": " in it; a SKILL.md of 500 lines or more;
// a SKILL.md that names a script needing Pillow, numpy or PyAV and never gives the install line; a SKILL.md that sends
// the reader to "the <other> skill's check list" (or reference, template, script), which is not in this zip; and a
// SKILL.md that names a Hildegard tool and never says what to do "Without Hildegard".
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { packSkills, skillNames } from './pack-skills.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const TEXT = /\.(md|txt|py|json|toml|ya?ml|css|html|svg|js|mjs)$/i;
/** The line a SKILL.md gives for the Python packages its scripts import: Python alone does not carry them. */
export const INSTALL_LINE = 'python3 -m pip install pillow numpy av';
/** The bundled scripts that need a package Python does not ship (Pillow, numpy, PyAV). */
export const NEEDS_PACKAGES = [
  'review_media.py',
  'review_mesh.py',
  'contact_sheet.py',
  'animatic.py',
  'cutout.py',
  'figure_rig.py',
  'print_kit.py',
  'mesh_kit.py',
];
const SPECIAL = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

/** The entries of a zip, by reading its central directory: name -> bytes. */
export function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory');
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

/** The names of Hildegard's MCP tools, read from the server's source so a new tool is covered without an edit here. */
export function mcpToolNames(repo = root) {
  const names = new Set();
  const dir = join(repo, 'mcp', 'src');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/registerTool\(\s*'([a-z][a-z0-9_]*)'/g)) names.add(m[1]);
  }
  return names;
}

/** The basenames of every script that ships in some skill's scripts/ folder, across the zips. */
export function shippedScripts(zips) {
  const out = new Set();
  for (const files of zips.values())
    for (const name of files.keys()) {
      const m = name.match(/^[^/]+\/scripts\/([^/]+)$/);
      if (m) out.add(m[1]);
    }
  return out;
}

/** Whether a Hildegard tool is named in the text: a name with an underscore anywhere, a one-word name only in backticks. */
function namesTool(text, tools) {
  for (const t of tools) {
    const re = t.includes('_')
      ? new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`)
      : new RegExp(`\`${t}[\` {]`);
    if (re.test(text)) return t;
  }
  return null;
}

/**
 * The problems that stop one skill from working alone. `files` is the skill's zip: entry name -> bytes, every name
 * starting `<skill>/`. `others` is shippedScripts() of all the zips; `tools` the MCP tool names.
 */
export function standaloneProblems(skill, files, others = new Set(), tools = new Set()) {
  const problems = [];
  const bad = (file, msg) => problems.push(`${skill}: ${file}: ${msg}`);
  const prefix = `${skill}/`;
  for (const name of files.keys())
    if (!name.startsWith(prefix))
      bad(name, `is outside the ${skill}/ folder, so an upload alone would not find it`);
  const entry = files.get(`${prefix}SKILL.md`);
  if (!entry) return [...problems, `${skill}: no SKILL.md at the top of the folder`];
  const skillMd = entry.toString('utf8');

  // Frontmatter: name = folder; a description agents can match and plain YAML can hold.
  const head = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const name = head.match(/^name:\s*(.+?)\s*$/m)?.[1];
  const description = head.match(/^description:\s*(.+?)\s*$/m)?.[1] ?? '';
  if (name !== skill) bad('SKILL.md', `name "${name}" is not the folder name`);
  if (description.length < 80 || description.length > 200)
    bad('SKILL.md', `description is ${description.length} characters; it must be 80 to 200`);
  if (description.includes(': ')) bad('SKILL.md', 'description has ": " in it, which plain YAML cannot hold');
  if (skillMd.split('\n').length >= 500)
    bad('SKILL.md', `has ${skillMd.split('\n').length} lines; it must stay under 500`);

  const has = (path) => files.has(`${prefix}${path}`);
  for (const [file, bytes] of files) {
    if (!TEXT.test(file)) continue;
    const rel = file.slice(prefix.length);
    const text = bytes.toString('utf8');
    const isMd = /\.md$/i.test(file);
    if (isMd) {
      for (const m of text.matchAll(/\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g)) {
        const target = m[1].split('#')[0];
        if (!target || SPECIAL.test(target)) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
        if (resolved.startsWith('../') || resolved === '..') bad(rel, `link ${m[1]} leaves the skill folder`);
        else if (!has(resolved)) bad(rel, `link ${m[1]} points at a file that is not in the skill`);
      }
      if (/(?:^|[\s("'`])\.\.\//.test(text))
        bad(rel, 'names a path with ../, which is outside the skill folder');
      if (/(?:^|[\s("'`/])skills\/[a-z0-9-]+\//.test(text))
        bad(rel, 'names a path into skills/<name>/; point at another skill by name only');
    }
    for (const m of text.matchAll(
      /(?<![\w/.-])((?:scripts|references|templates|docs)\/[A-Za-z0-9_][\w.-]*(?:\/[A-Za-z0-9_][\w.-]*)*)/g,
    )) {
      const path = m[1].replace(/[.-]+$/, '');
      if (/^[*<{$]/.test(text.slice(m.index + m[0].length))) continue; // a glob or a placeholder, not a file
      if (!has(path)) bad(rel, `names ${path}, which is not in the skill`);
    }
    if (isMd) {
      // A file of the repository's root (THIRD_PARTY_NOTICES.md, AGENTS.md) is not in the zip either.
      for (const m of text.matchAll(/(?<![\w/.-])([A-Z][A-Z0-9_]*\.md)\b/g))
        if (!has(m[1]))
          bad(rel, `names ${m[1]}, a file of the Hildegard repository that is not in the skill`);
    }
    if (isMd)
      for (const m of text.matchAll(/(?<![\w/.-])([A-Za-z0-9_-]+\.(?:py|mjs|sh))\b/g)) {
        const base = m[1];
        if (others.has(base) && !has(`scripts/${base}`))
          bad(
            rel,
            `names ${base}, a script another skill ships; add it to skills/SHARED.json for this skill`,
          );
      }
  }

  // A script that imports Pillow, numpy or PyAV: the SKILL.md gives the install line, since "Python and FFmpeg" is not enough.
  const packaged = NEEDS_PACKAGES.find((n) =>
    new RegExp(`(?<![A-Za-z0-9_-])${n.replace('.', '\\.')}`).test(skillMd),
  );
  if (packaged && !skillMd.includes(INSTALL_LINE))
    bad(
      'SKILL.md',
      `names ${packaged}, which needs Python packages, but never gives the line \`${INSTALL_LINE}\``,
    );

  // "Go through the hildegard-web skill's check list": a file of another skill is not in this zip, so it is not here.
  for (const m of skillMd.matchAll(
    /(hildegard(?:-[a-z0-9]+)*)[*`]*\s+skill[’']s\s+(check ?list|checks|references?|templates?|scripts?)/gi,
  ))
    if (m[1] !== skill)
      bad(
        'SKILL.md',
        `sends the reader to the ${m[1]} skill's ${m[2]}, which is not in this zip; bundle it or write it here`,
      );

  // A Hildegard tool needs a way around it: "With Hildegard linked: <tool>. Without Hildegard: <steps>."
  const tool = namesTool(
    skillMd +
      [...files]
        .filter(([n]) => /\.md$/.test(n))
        .map(([, b]) => b.toString('utf8'))
        .join('\n'),
    tools,
  );
  if (tool && !/without hildegard/i.test(skillMd))
    bad('SKILL.md', `names the Hildegard tool ${tool} but never says what to do "Without Hildegard"`);
  return problems;
}

/** Packs the skills into a temporary folder and returns skill name -> its zip's entries. */
export function packedSkills(repo = root) {
  const out = mkdtempSync(join(tmpdir(), 'hg-skill-zips-'));
  try {
    packSkills(out, '0.0.0', repo);
    const zips = new Map();
    for (const skill of skillNames(join(repo, 'skills')))
      zips.set(skill, unzip(readFileSync(join(out, `skill-${skill}.zip`))));
    return zips;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Every problem across every skill, each opened alone. */
export function allStandaloneProblems(repo = root) {
  const zips = packedSkills(repo);
  const others = shippedScripts(zips);
  const tools = mcpToolNames(repo);
  return [...zips].flatMap(([skill, files]) => standaloneProblems(skill, files, others, tools));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = allStandaloneProblems();
  if (process.argv.includes('--json')) console.log(JSON.stringify(problems, null, 2));
  else if (problems.length) console.error(`Skills alone:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  else console.log('Every skill works alone: nothing it names is missing from its zip.');
  process.exit(problems.length ? 1 : 0);
}
