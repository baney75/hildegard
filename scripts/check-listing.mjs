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
/** Bytes of a PNG: signature, an IHDR first, an IEND last. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

/** Width and height of a PNG, a JPEG or a WebP, from its bytes, or null when the bytes are none of those. */
export function rasterSize(buf) {
  if (buf.length >= 33 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const iend = buf.subarray(buf.length - 12);
    if (buf.readUInt32BE(8) !== 13 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    if (iend.readUInt32BE(0) !== 0 || iend.subarray(4, 8).toString('latin1') !== 'IEND') return null;
    return { format: 'PNG', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let at = 2;
    while (at + 4 <= buf.length) {
      if (buf[at] !== 0xff) return null;
      const m = buf[at + 1];
      if (m === 0xff) {
        at++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        at += 2;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return null;
      const len = buf.readUInt16BE(at + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (at + 9 > buf.length) return null;
        return { format: 'JPEG', height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) };
      }
      at += 2 + len;
    }
    return null;
  }
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    const kind = buf.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X')
      return { format: 'WebP', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8L' && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { format: 'WebP', width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ' && buf.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])))
      return { format: 'WebP', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** The root element's name and attributes of an XML text, or an error string when it isn't well formed. */
export function xmlRoot(src) {
  const body = src.replace(/^\uFEFF/, '');
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<(\/)?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/)?>/g;
  const stack = [];
  let root = null;
  let last = 0;
  for (const m of body.matchAll(token)) {
    const gap = body.slice(last, m.index);
    if (/</.test(gap)) return 'a stray “<”';
    if (!stack.length && gap.trim()) return 'text outside the root element';
    last = m.index + m[0].length;
    const [, close, name, attrs, selfClose] = m;
    if (!name) continue;
    if (close) {
      if (stack.pop() !== name) return `</${name}> closes nothing`;
      continue;
    }
    if (!stack.length) {
      if (root) return 'more than one root element';
      root = {
        name,
        attrs: Object.fromEntries(
          [...(attrs ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [
            a[1],
            a[2] ?? a[3],
          ]),
        ),
      };
    }
    if (!selfClose) stack.push(name);
  }
  if (/</.test(body.slice(last))) return 'a stray “<”';
  if (body.slice(last).trim() && !stack.length) return 'text outside the root element';
  if (stack.length) return `<${stack.at(-1)}> is never closed`;
  return root ?? 'no root element';
}

/** Width and height of an SVG's text, from its viewBox or width and height; null when it states none. */
function svgSize(attrs) {
  const num = (v) => (/^\s*([\d.]+)\s*(px)?\s*$/.test(v ?? '') ? Number.parseFloat(v) : null);
  const vb = (attrs.viewBox ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite)) return { width: vb[2], height: vb[3] };
  const [width, height] = [num(attrs.width), num(attrs.height)];
  return width && height ? { width, height } : null;
}

/** Problems with an image file's bytes: it must really be a PNG, JPEG, WebP or SVG, square, and in size range. */
export function checkImage(
  buf,
  label,
  { min = OPENAI_LIMITS.logoMinPx, max = OPENAI_LIMITS.logoMaxPx } = {},
) {
  const raster = rasterSize(buf);
  let size = raster;
  let format = raster?.format;
  if (!raster) {
    if (!isText(buf)) return [`${label} isn’t a PNG, JPEG, WebP or SVG image (its bytes are none of those)`];
    const root = xmlRoot(buf.toString('utf8'));
    if (typeof root === 'string') return [`${label} isn’t a PNG, JPEG, WebP or SVG image (as XML: ${root})`];
    if (root.name !== 'svg' && !root.name.endsWith(':svg'))
      return [`${label} isn’t a PNG, JPEG, WebP or SVG image (its root element is <${root.name}>)`];
    format = 'SVG';
    size = svgSize(root.attrs);
    if (!size) return [`${label}: the SVG states no size (a viewBox, or a width and height)`];
  }
  const bad = [];
  if (size.width <= 0 || size.height <= 0) bad.push(`${label}: the ${format} has no size`);
  else if (Math.abs(size.width - size.height) > (format === 'SVG' ? 1e-6 : 0))
    bad.push(`${label} isn’t square (${size.width} by ${size.height})`);
  else if (format !== 'SVG' && (size.width < min || size.width > max))
    bad.push(`${label} is ${size.width} px square; it needs ${min} to ${max}`);
  return bad;
}

/**
 * The license files a package's README and notices point at (“LICENSE”, “LICENSE-APACHE”), as problems when the
 * package doesn't carry one. has(name) says whether the package has that file.
 */
export function checkLicenseFiles(texts, has) {
  const bad = [];
  for (const [from, body] of Object.entries(texts))
    for (const ref of new Set(body.match(/\bLICENSE(?:-[A-Z0-9]+)?\b/g) ?? []))
      if (!has(ref)) bad.push(`${from} refers to ${ref}, which isn’t in the package`);
  if (has('LICENSE-APACHE') && !has('LICENSE-APACHE', /Apache License/))
    bad.push('LICENSE-APACHE isn’t the Apache License text');
  return bad;
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
  bad.push(
    ...checkLicenseFiles(
      Object.fromEntries(
        ['README.md', 'THIRD_PARTY_NOTICES.md']
          .filter((f) => existsSync(join(dir, f)))
          .map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
      ),
      (name, re) => {
        const f = join(dir, name);
        return existsSync(f) && (!re || re.test(readFileSync(f, 'utf8')));
      },
    ),
  );

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
      bad.push(...checkImage(readFileSync(join(dir, icon)), 'the icon'));
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
    else bad.push(...checkImage(logo, 'the logo'));
    const icon = files.get((ui.composerIcon ?? '').replace(/^\.\//, ''));
    if (!icon) bad.push(`interface.composerIcon ${ui.composerIcon} isn’t in the plugin`);
    else bad.push(...checkImage(icon, 'the composer icon'));
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
  bad.push(
    ...checkLicenseFiles(
      Object.fromEntries(
        ['README.md', 'THIRD_PARTY_NOTICES.md']
          .filter((f) => files.has(f))
          .map((f) => [f, files.get(f).toString('utf8')]),
      ),
      (name, re) => files.has(name) && (!re || re.test(files.get(name).toString('utf8'))),
    ),
  );
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
