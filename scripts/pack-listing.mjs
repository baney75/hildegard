// SPDX-License-Identifier: AGPL-3.0-only
// Prepares what the owner submits to AI app stores, so submitting is pressing a button:
//
//   node scripts/pack-listing.mjs <out> [--extras <dir>] [--version <x.y.z>]
//
// - <out>: the Claude directory's plugin, a skills-only tree (no MCP server) in the shape claude.ai/directory/manage
//   validates. CI publishes it to its own public repository (.github/workflows/listing.yml).
// - <extras>/hildegard-openai.zip: the same craft as an OpenAI plugin, for OpenAI's plugin directory.
// - <extras>/grok-bot/: the skills as per-skill zips and one combined zip, for Grok Bot's private skills.
// - <extras>/listing-fields.md: every field to paste into each store's form, filled in from the files above.
//
// docs/listings.md is the owner's checklist; scripts/check-listing.mjs checks every rule the stores state.
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icons, skillNames, tree, zip } from './pack-skills.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export const SITE = 'https://dbaney.com/hildegard/';
export const URLS = {
  website: SITE,
  privacy: `${SITE}privacy/`,
  terms: `${SITE}terms/`,
  support: 'https://github.com/baney75/hildegard/issues',
  docs: 'https://github.com/baney75/hildegard/blob/main/docs/chatbots.md',
  source: 'https://github.com/baney75/hildegard',
  /** The public repository the Claude directory reads; the owner creates it, CI fills it. */
  listingRepo: 'https://github.com/baney75/hildegard-plugin',
};

/** What claude.ai/directory/manage checks (the owner's research of 2026-11-07), as numbers the validator uses. */
export const CLAUDE_LIMITS = { files: 512, fileBytes: 256 * 1024, readmeWords: 40 };

/** What OpenAI's plugin directory limits (developers.openai.com/plugins/deploy/submission). */
export const OPENAI_LIMITS = {
  name: 64,
  displayName: 30,
  shortDescription: 30,
  longDescription: 4000,
  capabilities: 20,
  capability: 120,
  defaultPrompts: 3,
  defaultPrompt: 128,
  logoBytes: 5 * 1024 * 1024,
  contrast: 2,
};

/**
 * The Claude listing: skills only, named for the craft. Anthropic's policy (4B) excludes software that makes
 * images, video or audio with AI models, so the skills about making media with Hildegard's models (film, art, sound)
 * and the two about running the app (cloud, setup) stay out; the rest are craft: writing and design, editing,
 * models drawn in code, parts to print. Named hildegard-craft, not hildegard, so the full plugin can keep its name
 * if Anthropic grants the exception (docs/listings.md has the letter).
 */
export const CLAUDE = {
  name: 'hildegard-craft',
  skills: [
    'hildegard',
    'hildegard-3d',
    'hildegard-craft',
    'hildegard-loop',
    'hildegard-openscad',
    'hildegard-photo-edit',
    'hildegard-print',
    'hildegard-video-edit',
    'hildegard-web',
  ],
  description:
    'Craft skills for serious creative work: writing, web and interface design, photo and video editing, recording cleanup, 3D models and parts to print drawn in code, and a make, check, refine loop. Instructions only.',
  keywords: [
    'craft',
    'writing',
    'web-design',
    'video-editing',
    'photo-editing',
    '3d-printing',
    'openscad',
    'design',
  ],
  /** One plain line per skill for the README, written without the word the policy turns on. */
  lines: {
    hildegard:
      'the method for serious work in any form: a short interview, research, drafts, contact sheets, blind critique and checks. Covers writing (fiction, essays, papers in APA, Chicago or MLA), storyboards, image and video editing, color, dialogue cleanup, and music and sound made in code.',
    'hildegard-3d':
      'models for screens and for printing, built in code and checked view by view for size and watertight meshes.',
    'hildegard-craft':
      'the bar every other skill holds: brief, lint the prompt, review against a rubric, decide whether the work is fit to hand over.',
    'hildegard-loop':
      'draft, render, critique, refine: how to keep improving a piece in rounds until it passes its own checks.',
    'hildegard-openscad':
      'exact, parametric parts in OpenSCAD code (brackets, enclosures, knobs, clips, gears, threads), checked and measured.',
    'hildegard-photo-edit':
      'professional photo editing with ImageMagick: straighten, white balance, exposure, color, sharpen, export.',
    'hildegard-print':
      'working parts to 3D print: sized from a photo or listing, fits checked, sliced, handed over with a print sheet.',
    'hildegard-video-edit':
      'professional video editing with FFmpeg: cut, trim, grade, caption, reframe, mix and finish, then check the result.',
    'hildegard-web':
      'websites and app screens as real HTML and CSS, checked at phone, tablet and desktop width in light and dark, with eight finished templates.',
  },
};

/** The OpenAI directory takes every skill: it has no rule against media work. */
export const OPENAI_URLS = {
  websiteURL: URLS.website,
  supportURL: URLS.support,
  privacyPolicyURL: URLS.privacy,
  termsOfServiceURL: URLS.terms,
};

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pretty = (o) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const text = (s) => Buffer.from(s);

export const repoVersion = (repo = root) => json(join(repo, 'package.json')).version;

/** name, description, from a SKILL.md's frontmatter. */
export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** The README that goes with the Claude listing. */
export function claudeReadme(skills = CLAUDE.skills) {
  const list = skills.map((s) => `- **${s}**: ${CLAUDE.lines[s]}`).join('\n');
  return `# Hildegard Craft

${CLAUDE.description}

These are skills for Claude: plain instructions and a few small helper scripts that Claude reads when your request
matches. They teach the habits of a careful maker: interview before drafting, look at the real thing, check it
against measurements and a rubric, and refine until it passes. The plugin has no server, hook or background process,
and its own scripts open no network connection.

## What is in it

${list}

## How to use it

Install the plugin from Claude's directory, or in Claude Code:

\`\`\`text
/plugin marketplace add baney75/hildegard-plugin
/plugin install hildegard-craft@hildegard-craft
\`\`\`

Then ask for the work in plain words. Claude loads the skill that fits:

- "Edit my photo: straighten the horizon, fix the white balance, export for the web."
- "Cut these clips into a 30-second teaser with captions and check the audio levels."
- "Design a replacement knob I can 3D print, 40 mm wide, and check it fits."
- "Build a one-page site for my bakery at phone and desktop width, light and dark."
- "Draft a five-page essay in APA, then critique it as a hostile reader would."

To name a skill yourself, type its name after the plugin's, such as \`/hildegard-craft:hildegard-web\`.

## Good to know

- The skills work on their own. Some mention Hildegard, a separate free open-source app that runs on your own
  computers. It is not part of this plugin and nothing here needs it; where a skill names one of its tools, use your own.
- A few skills use programs you may already have, such as FFmpeg, ImageMagick, OpenSCAD or Blender. They are not
  included. One helper script (cutout.py) needs the rembg library (from pypi.org), which downloads its own model from
  github.com the first time you run it. A few skills suggest installing other Python packages and fonts the same way.
  Everything that can reach the network is listed at ${URLS.privacy}. Claude runs commands only with the permission you have set.
- Privacy: ${URLS.privacy}. Terms: ${URLS.terms}. Support and bug reports: ${URLS.support}.

## License

AGPL-3.0-only (see LICENSE). The site templates inside hildegard-web are Apache-2.0 (LICENSE-APACHE).
Source: ${URLS.source} (skills/ there is what this plugin carries).
`;
}

/** THIRD_PARTY_NOTICES.md for a skills-only tree: what is and is not inside. */
export function claudeNotices() {
  return `# Third-party notices

This plugin contains instructions, small Python helper scripts and HTML/CSS/SVG templates, all written for Hildegard
(https://github.com/baney75/hildegard). It bundles no third-party code, fonts, models or binaries.

- Instructions and helper scripts: AGPL-3.0-only (LICENSE).
- The site templates under skills/hildegard-web/templates: Apache-2.0 (LICENSE-APACHE), as each file's SPDX line says.

The skills tell Claude how to use programs that are not included and are not part of this plugin: FFmpeg
(LGPL-2.1-or-later or GPL-2.0-or-later, by build), ImageMagick (ImageMagick License), OpenSCAD (GPL-2.0-or-later),
Blender (GPL-3.0-or-later) and, for one script, rembg (MIT). You install them yourself and they stay under their own licenses.

The app these skills come from lists its own dependencies in
https://github.com/baney75/hildegard/blob/main/THIRD_PARTY_NOTICES.md.
`;
}

const SKIP_NAMES = /(^|\/)(SCAN-ALLOW)$/;

/** Every file of the Claude listing, as [path, bytes]. */
export function claudeEntries(version, repo = root) {
  const known = skillNames(join(repo, 'skills'));
  for (const s of CLAUDE.skills)
    if (!known.includes(s)) throw new Error(`The listing names a skill that doesn't exist: ${s}`);
  const base = json(join(repo, '.claude-plugin', 'plugin.json'));
  const manifest = {
    name: CLAUDE.name,
    version,
    description: CLAUDE.description,
    author: base.author,
    homepage: URLS.website,
    repository: URLS.listingRepo,
    license: 'AGPL-3.0-only',
    icon: base.icon,
    documentationUrl: URLS.docs,
    supportUrl: URLS.support,
    privacyPolicyUrl: URLS.privacy,
    termsOfServiceUrl: URLS.terms,
    keywords: CLAUDE.keywords,
  };
  const entries = [
    ['.claude-plugin/plugin.json', pretty(manifest)],
    [
      '.claude-plugin/marketplace.json',
      pretty({
        name: CLAUDE.name,
        owner: base.author,
        metadata: { description: 'Hildegard’s craft skills for Claude, skills only.' },
        plugins: [
          {
            name: CLAUDE.name,
            source: './',
            description: CLAUDE.description,
            category: 'creative',
            homepage: URLS.website,
          },
        ],
      }),
    ],
    ...icons(repo, [manifest.icon]),
    ['README.md', text(claudeReadme())],
    ['LICENSE', readFileSync(join(repo, 'LICENSE'))],
    ['LICENSE-APACHE', readFileSync(join(repo, 'LICENSE-APACHE'))],
    ['THIRD_PARTY_NOTICES.md', text(claudeNotices())],
  ];
  for (const s of CLAUDE.skills)
    entries.push(...tree(join(repo, 'skills', s), `skills/${s}/`).filter(([n]) => !SKIP_NAMES.test(n)));
  return entries;
}

/** The file this script writes into every tree it makes. Only a folder that is empty or holds this is ever replaced. */
export const MARKER = '.hildegard-listing-generated';
export const MARKER_TEXT =
  'Written by scripts/pack-listing.mjs. This folder is replaced on every build; keep nothing here.\n';
/** The one folder of the repository a listing may be built into (it is ignored by git). */
export const BUILD_DIR = 'dist';

/** The real path of p, following links for the part that exists, so a link can't carry a build into the repository. */
function realish(p) {
  const rest = [];
  let at = resolve(p);
  while (!existsSync(at)) {
    rest.unshift(at.slice(dirname(at).length + 1));
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return join(realpathSync(at), ...rest);
}

const inside = (child, parent) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * Why out can't take a listing, or null. A listing replaces everything in its folder, so it goes only into a folder
 * that is new, empty or marked as this script's own: never the repository, a parent of it, a git checkout, or a folder
 * of a full plugin. Inside the repository only a build folder under dist/ will do.
 */
export function refuseOutput(out, repo = root) {
  const dir = realish(out);
  const home = realish(repo);
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) return `${dir} is a file, not a folder.`;
  if (inside(home, dir))
    return `${dir} is the repository or a folder that holds it; a build folder under ${join(home, BUILD_DIR)} is the only place inside it.`;
  if (inside(dir, home)) {
    const r = relative(home, dir).split(sep);
    if (r[0] !== BUILD_DIR || r.length < 2)
      return `${dir} is inside the repository; build into a folder under ${join(home, BUILD_DIR)} (such as ${join(home, BUILD_DIR, 'listing')}).`;
  }
  if (existsSync(join(dir, '.git'))) return `${dir} is a git checkout; pick a new folder.`;
  const names = readdirOrEmpty(dir);
  if (names.length === 0) return null;
  let marked = false;
  try {
    marked = readFileSync(join(dir, MARKER), 'utf8') === MARKER_TEXT;
  } catch {}
  return marked
    ? null
    : `${dir} isn’t empty and wasn’t made by this script (it has no ${MARKER} file); pick a new folder.`;
}

/** Writes the Claude listing into out, replacing a tree this script made before and refusing any other folder. */
export function packClaude(out, version = repoVersion(), repo = root) {
  const refused = refuseOutput(out, repo);
  if (refused) throw new Error(refused);
  // Everything is read before anything is removed, so a failure leaves the old tree whole.
  const entries = [...claudeEntries(version, repo), [MARKER, text(MARKER_TEXT)]];
  const dir = realish(out);
  for (const n of readdirOrEmpty(dir)) rmSync(join(dir, n), { recursive: true, force: true });
  for (const [name, data] of entries) {
    const to = join(dir, ...name.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data);
  }
  return dir;
}

function readdirOrEmpty(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

/** The OpenAI manifest: the Codex plugin's, with the four URLs the directory requires. */
export function openaiManifest(version, repo = root) {
  const m = json(join(repo, '.codex-plugin', 'plugin.json'));
  m.version = version;
  m.interface = { ...m.interface, ...OPENAI_URLS };
  return m;
}

/** hildegard-openai.zip's entries: every skill, no MCP server, no hooks. */
export function openaiEntries(version, repo = root) {
  const m = openaiManifest(version, repo);
  return [
    ['.codex-plugin/plugin.json', pretty(m)],
    ...icons(repo, [m.interface.composerIcon, m.interface.logo]),
    ['README.md', readFileSync(join(repo, 'plugin', 'README.md'))],
    ['LICENSE', readFileSync(join(repo, 'LICENSE'))],
    ['LICENSE-APACHE', readFileSync(join(repo, 'LICENSE-APACHE'))],
    ['THIRD_PARTY_NOTICES.md', text(claudeNotices())],
    ...tree(join(repo, 'skills'), 'skills/').filter(([n]) => !SKIP_NAMES.test(n)),
  ];
}

/**
 * Grok Bot takes a private skill as a folder with a SKILL.md. Its docs name no upload format, so this writes each skill
 * as its own zip (the folder at the top, like claude.ai's) and one combined zip with every folder at the top.
 */
export function grokBotFiles(repo = root) {
  const out = [];
  const all = [];
  for (const s of skillNames(join(repo, 'skills'))) {
    const files = tree(join(repo, 'skills', s), `${s}/`).filter(([n]) => !SKIP_NAMES.test(n));
    out.push([`${s}.zip`, zip(files)]);
    all.push(...files);
  }
  out.push(['hildegard-skills.zip', zip(all)]);
  return out;
}

export const contrastOnWhite = (hex) => {
  const c = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05);
};

/** The paste-ready fields for each store, as Markdown. */
export function listingFields(version, repo = root) {
  const oa = openaiManifest(version, repo);
  const ui = oa.interface;
  const code = (s) => `\`${s}\``;
  const block = (s) => `\`\`\`text\n${s}\n\`\`\``;
  return `# Listing fields, version ${version}

Generated by \`node scripts/pack-listing.mjs\`. docs/listings.md says where each goes. All three pages named below are
DRAFTS until the owner approves them: ${URLS.privacy} and ${URLS.terms}.

## Anthropic: claude.ai/directory/manage, Plugin bundle

| Field | Value |
| --- | --- |
| Source | https://github.com/baney75/hildegard-plugin (public; CI fills it from this repository) |
| Plugin name | ${code(CLAUDE.name)} |
| Version | ${version} |
| Homepage | ${URLS.website} |
| Documentation | ${URLS.docs} |
| Support | ${URLS.support} |
| Privacy policy | ${URLS.privacy} |
| Terms of service | ${URLS.terms} |
| License | AGPL-3.0-only |
| Skills | ${CLAUDE.skills.join(', ')} |

Description (one line):

${block(CLAUDE.description)}

## OpenAI: Codex and ChatGPT plugin directory

Upload \`hildegard-openai.zip\`. It is skills only: no MCP server, no hooks.

| Field | Value | Limit |
| --- | --- | --- |
| name | ${code(oa.name)} | ${OPENAI_LIMITS.name} |
| displayName | ${ui.displayName} | ${OPENAI_LIMITS.displayName} (${ui.displayName.length}) |
| shortDescription | ${ui.shortDescription} | ${OPENAI_LIMITS.shortDescription} (${ui.shortDescription.length}) |
| category | ${ui.category} | one of the directory's fixed names |
| capabilities | ${ui.capabilities.join(', ')} | ${OPENAI_LIMITS.capabilities} of ${OPENAI_LIMITS.capability} |
| brandColor | ${ui.brandColor} | ${contrastOnWhite(ui.brandColor).toFixed(1)}:1 on white, needs ${OPENAI_LIMITS.contrast}:1 |
| websiteURL | ${ui.websiteURL} | |
| supportURL | ${ui.supportURL} | |
| privacyPolicyURL | ${ui.privacyPolicyURL} | |
| termsOfServiceURL | ${ui.termsOfServiceURL} | |

Default prompts (up to ${OPENAI_LIMITS.defaultPrompts}, ${OPENAI_LIMITS.defaultPrompt} characters each):

${block(ui.defaultPrompt.join('\n'))}

Long description (${ui.longDescription.length} of ${OPENAI_LIMITS.longDescription}):

${block(ui.longDescription)}

## xAI Grok: grok.com/connectors

No store. Each person adds Hildegard as a custom connector: New Connector, Custom, then the MCP URL that
\`hildegard tunnel\` or \`hildegard host --funnel --json\` prints (\`mcpUrl\`). Steps: docs/grok.md.

${block('Name: Hildegard\nURL:  https://<your-name>.<your-tailnet>.ts.net/mcp   (your own public address)\nAuth: OAuth, sign in on Hildegard’s page')}

## Grok Bot

Files in \`grok-bot/\`: ${skillNames(join(repo, 'skills')).length} per-skill zips and \`hildegard-skills.zip\`. Steps: docs/grok-bot.md.

${block('Add a custom MCP server named "hildegard" at https://<your-address>/mcp (Streamable HTTP, OAuth).\nI will sign in on its page myself. Then call list_skills and read the "hildegard" skill before you make anything.')}
`;
}

/** Builds everything. Returns the paths written. */
export function packListing(out, extras, version = repoVersion(), repo = root) {
  const tree_ = packClaude(out, version, repo);
  mkdirSync(extras, { recursive: true });
  const openai = join(extras, 'hildegard-openai.zip');
  writeFileSync(openai, zip(openaiEntries(version, repo)));
  const grok = join(extras, 'grok-bot');
  mkdirSync(grok, { recursive: true });
  const written = [tree_, openai];
  const sums = [];
  for (const [name, data] of grokBotFiles(repo)) {
    writeFileSync(join(grok, name), data);
    written.push(join(grok, name));
    sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
  }
  // The same files give the same bytes, so a bot that pins a snapshot can check these.
  writeFileSync(join(grok, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  written.push(join(grok, 'SHA256SUMS'));
  const fields = join(extras, 'listing-fields.md');
  writeFileSync(fields, listingFields(version, repo));
  written.push(fields);
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = (n) => {
    const i = args.indexOf(n);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const extras = flag('--extras');
  const version = flag('--version');
  const out = args[0];
  if (!out) {
    console.error('Usage: node scripts/pack-listing.mjs <out> [--extras <dir>] [--version <x.y.z>]');
    process.exit(2);
  }
  try {
    for (const f of packListing(out, extras ?? `${resolve(out)}-extras`, version ?? repoVersion()))
      console.log(f);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
