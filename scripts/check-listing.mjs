// SPDX-License-Identifier: AGPL-3.0-only
// Checks the store listings against the rules each store states, so a rule that would hold a submission fails here:
//
//   node scripts/check-listing.mjs                        build both into a temp folder and check them
//   node scripts/check-listing.mjs <tree> [openai.zip]    check a tree (and a zip) that pack-listing.mjs made
//
// The Claude directory's plugin: skills only, under 512 files, no file over 256 KiB, no binary but its icon, no
// .gitattributes (a git-lfs filter makes validation fail), the required manifest fields, a LICENSE, a README of 40+
// words with no claim that the plugin makes media. OpenAI's: every field within its limit, the four URLs, a logo.
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
  CLAUDE,
  CLAUDE_LIMITS,
  contrastOnWhite,
  frontmatter,
  OPENAI_LIMITS,
  packListing,
} from './pack-listing.mjs';
import { skillNames } from './pack-skills.mjs';

const TEXT = new Set([
  '.md',
  '.txt',
  '.py',
  '.json',
  '.toml',
  '.yml',
  '.yaml',
  '.css',
  '.html',
  '.svg',
  '.js',
  '.mjs',
]);
const MANIFEST_KEYS = new Set([
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'icon',
  'documentationUrl',
  'supportUrl',
  'privacyPolicyUrl',
  'termsOfServiceUrl',
  'keywords',
]);
/** Folders and files that would make a skills-only plugin something else. */
const NOT_SKILLS_ONLY = ['.mcp.json', 'hooks', 'agents', 'commands', 'bin', 'mcp', 'monitors', 'themes'];
/** Words that claim the plugin makes images, video or audio with AI models (Anthropic policy 4B). */
const GENERATION_CLAIM =
  /\b(generat\w+|text[- ]to[- ](image|video|speech|music)|ai[- ](image|video|music|voice|art)|diffusion|voice[- ]clon\w+|deepfake)/i;
const https = (u) => typeof u === 'string' && /^https:\/\/[^\s/]+\.[^\s/]+/.test(u);
const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Whether bytes are text: valid UTF-8 with no NUL. */
function isText(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Every file under dir, as [posix path, lstat], and any symlink found. */
function walk(dir) {
  const files = [];
  const links = [];
  (function go(d) {
    for (const name of readdirSync(d)) {
      if (name === '.git' && d === dir) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(dir, p).split(sep).join('/');
      if (st.isSymbolicLink()) links.push(rel);
      else if (st.isDirectory()) go(p);
      else files.push([rel, st]);
    }
  })(dir);
  return { files, links };
}

/** Problems with the Claude directory's plugin tree at dir; empty when it passes. */
export function checkClaudeTree(dir) {
  const bad = [];
  const { files, links } = walk(dir);
  for (const l of links) bad.push(`${l}: symlinks are not allowed`);
  if (files.length > CLAUDE_LIMITS.files)
    bad.push(`${files.length} files; the directory holds a plugin over ${CLAUDE_LIMITS.files}`);
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    bad.push('.claude-plugin/plugin.json is missing or isn’t JSON');
  }
  const icon = manifest?.icon?.replace(/^\.\//, '');
  for (const [rel, st] of files) {
    const base = rel.split('/').pop();
    if (base === '.gitattributes' || base === '.gitmodules')
      bad.push(`${rel}: a ${base} (git-lfs filter rules) makes the portal’s validation fail`);
    if (st.size > CLAUDE_LIMITS.fileBytes)
      bad.push(`${rel}: ${st.size} bytes; the limit is ${CLAUDE_LIMITS.fileBytes}`);
    const buf = readFileSync(join(dir, rel));
    if (buf.subarray(0, 60).toString('latin1').startsWith('version https://git-lfs'))
      bad.push(`${rel}: a git-lfs pointer`);
    if (!isText(buf) && rel !== icon) bad.push(`${rel}: a binary file; only the icon may be one`);
    if (rel.startsWith('skills/') && !TEXT.has(extname(rel).toLowerCase()))
      bad.push(`${rel}: only text files belong in a skill (${extname(rel) || 'no extension'})`);
  }
  for (const n of NOT_SKILLS_ONLY)
    if (existsSync(join(dir, n))) bad.push(`${n}: a skills-only plugin has none`);
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md'])
    if (!existsSync(join(dir, f))) bad.push(`${f} is missing`);
  if (
    existsSync(join(dir, 'LICENSE')) &&
    !/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(readFileSync(join(dir, 'LICENSE'), 'utf8'))
  )
    bad.push('LICENSE isn’t the AGPL text');

  if (manifest) {
    for (const k of Object.keys(manifest))
      if (!MANIFEST_KEYS.has(k)) bad.push(`plugin.json: ${k} isn’t a field of a skills-only listing`);
    if (manifest.name !== CLAUDE.name) bad.push(`plugin.json: name is ${manifest.name}, not ${CLAUDE.name}`);
    if (!SEMVER.test(manifest.version ?? '')) bad.push('plugin.json: version isn’t x.y.z');
    if (!manifest.description || manifest.description.length > 400)
      bad.push('plugin.json: description is missing or past 400 characters');
    if (manifest.license !== 'AGPL-3.0-only') bad.push('plugin.json: license isn’t AGPL-3.0-only');
    if (!manifest.author?.name) bad.push('plugin.json: author.name is missing');
    for (const k of [
      'homepage',
      'repository',
      'documentationUrl',
      'supportUrl',
      'privacyPolicyUrl',
      'termsOfServiceUrl',
    ])
      if (!https(manifest[k])) bad.push(`plugin.json: ${k} must be an https URL`);
    if (!icon || !existsSync(join(dir, icon))) bad.push('plugin.json: icon names no file');
    else {
      const png = readFileSync(join(dir, icon));
      if (png.subarray(1, 4).toString() !== 'PNG') bad.push('the icon isn’t a PNG');
      else if (png.readUInt32BE(16) !== png.readUInt32BE(20)) bad.push('the icon isn’t square');
    }
    const prose = [manifest.description, ...(manifest.keywords ?? [])].join(' ');
    if (GENERATION_CLAIM.test(prose))
      bad.push(`plugin.json: claims media generation (${GENERATION_CLAIM.exec(prose)[0]})`);
  }

  const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
  const words = readme.split(/\s+/).filter(Boolean).length;
  if (words < CLAUDE_LIMITS.readmeWords)
    bad.push(`README.md has ${words} words; it needs ${CLAUDE_LIMITS.readmeWords}`);
  if (GENERATION_CLAIM.test(readme))
    bad.push(`README.md claims media generation (${GENERATION_CLAIM.exec(readme)[0]})`);
  if (!/how to use/i.test(readme)) bad.push('README.md has no “How to use” section');

  const present = existsSync(join(dir, 'skills')) ? readdirSync(join(dir, 'skills')).sort() : [];
  const want = [...CLAUDE.skills].sort();
  for (const s of present)
    if (!want.includes(s)) bad.push(`skills/${s}: not a craft skill of this listing (policy 4B)`);
  for (const s of want) if (!present.includes(s)) bad.push(`skills/${s} is missing`);
  for (const s of present) {
    const f = join(dir, 'skills', s, 'SKILL.md');
    if (!existsSync(f)) {
      bad.push(`skills/${s}/SKILL.md is missing`);
      continue;
    }
    const fm = frontmatter(readFileSync(f, 'utf8'));
    if (fm.name !== s) bad.push(`skills/${s}: frontmatter name is ${fm.name}`);
    if (!fm.description || fm.description.length > 200)
      bad.push(`skills/${s}: description is missing or past 200 characters`);
  }
  return bad;
}

/** The entries of a zip, from its central directory. */
export function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
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

/** Problems with an OpenAI plugin manifest (a parsed .codex-plugin/plugin.json) and the files it names. */
export function checkOpenAIManifest(m, files = new Map()) {
  const bad = [];
  const L = OPENAI_LIMITS;
  const ui = m.interface ?? {};
  const max = (label, v, n) => {
    if (typeof v !== 'string' || !v) bad.push(`${label} is missing`);
    else if (v.length > n) bad.push(`${label} is ${v.length} characters; the limit is ${n}`);
  };
  max('name', m.name, L.name);
  max('description', m.description, L.longDescription);
  max('interface.displayName', ui.displayName, L.displayName);
  max('interface.shortDescription', ui.shortDescription, L.shortDescription);
  max('interface.longDescription', ui.longDescription, L.longDescription);
  if (!ui.category) bad.push('interface.category is missing');
  if (!Array.isArray(ui.capabilities) || !ui.capabilities.length)
    bad.push('interface.capabilities is missing');
  else {
    if (ui.capabilities.length > L.capabilities)
      bad.push(`interface.capabilities has ${ui.capabilities.length} items; the limit is ${L.capabilities}`);
    for (const c of ui.capabilities)
      if (typeof c !== 'string' || c.length > L.capability)
        bad.push(`interface.capabilities: “${String(c).slice(0, 20)}…” is past ${L.capability} characters`);
  }
  if (!Array.isArray(ui.defaultPrompt) || !ui.defaultPrompt.length)
    bad.push('interface.defaultPrompt is missing');
  else {
    if (ui.defaultPrompt.length > L.defaultPrompts)
      bad.push(
        `interface.defaultPrompt has ${ui.defaultPrompt.length} prompts; the limit is ${L.defaultPrompts}`,
      );
    for (const p of ui.defaultPrompt)
      if (typeof p !== 'string' || p.length > L.defaultPrompt)
        bad.push(
          `interface.defaultPrompt: “${String(p).slice(0, 20)}…” is past ${L.defaultPrompt} characters`,
        );
  }
  for (const k of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'])
    if (!https(ui[k])) bad.push(`interface.${k} must be an https URL`);
  if (!/^#[0-9a-f]{6}$/i.test(ui.brandColor ?? '')) bad.push('interface.brandColor isn’t a #rrggbb color');
  else if (contrastOnWhite(ui.brandColor) < L.contrast)
    bad.push(
      `interface.brandColor ${ui.brandColor} has ${contrastOnWhite(ui.brandColor).toFixed(1)}:1 contrast on white; it needs ${L.contrast}:1`,
    );
  if (m.mcpServers || m.hooks || m.apps)
    bad.push('the directory takes no local MCP server, hooks or apps in a skills-only plugin');
  if (m.skills !== './skills/') bad.push('skills must be ./skills/');
  const logo = files.get((ui.logo ?? '').replace(/^\.\//, ''));
  if (files.size) {
    if (!logo) bad.push(`interface.logo ${ui.logo} isn’t in the plugin`);
    else if (logo.length > L.logoBytes) bad.push('the logo is past 5 MiB');
    else if (logo.subarray(1, 4).toString() === 'PNG' && logo.readUInt32BE(16) !== logo.readUInt32BE(20))
      bad.push('the logo isn’t square');
    if (!files.has((ui.composerIcon ?? '').replace(/^\.\//, '')))
      bad.push(`interface.composerIcon ${ui.composerIcon} isn’t in the plugin`);
  }
  return bad;
}

/** Problems with hildegard-openai.zip (its bytes). */
export function checkOpenAIZip(buf, skills = skillNames()) {
  const files = unzip(buf);
  const bad = [];
  const raw = files.get('.codex-plugin/plugin.json');
  if (!raw) return ['.codex-plugin/plugin.json is missing'];
  bad.push(...checkOpenAIManifest(JSON.parse(raw.toString()), files));
  for (const s of skills) if (!files.has(`skills/${s}/SKILL.md`)) bad.push(`skills/${s}/SKILL.md is missing`);
  for (const n of files.keys()) {
    if (n.includes('.gitattributes') || NOT_SKILLS_ONLY.some((x) => n === x || n.startsWith(`${x}/`)))
      bad.push(`${n}: not allowed in a skills-only plugin`);
    if (n.startsWith('skills/') && !TEXT.has(extname(n).toLowerCase()) && !/SCAN-ALLOW$/.test(n))
      bad.push(`${n}: only text files belong in a skill`);
  }
  if (!files.has('LICENSE')) bad.push('LICENSE is missing');
  return bad;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let [tree, zipPath] = process.argv.slice(2);
  let tmp = null;
  if (!tree) {
    tmp = mkdtempSync(join(tmpdir(), 'hg-listing-'));
    tree = join(tmp, 'plugin');
    packListing(tree, join(tmp, 'extras'));
    zipPath = join(tmp, 'extras', 'hildegard-openai.zip');
  }
  const problems = [
    ...checkClaudeTree(tree).map((p) => `claude: ${p}`),
    ...(zipPath ? checkOpenAIZip(readFileSync(zipPath)).map((p) => `openai: ${p}`) : []),
  ];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('Listings pass: the Claude plugin tree and the OpenAI zip meet every stated rule.');
}
