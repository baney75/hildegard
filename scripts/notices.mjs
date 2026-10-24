// SPDX-License-Identifier: AGPL-3.0-only
// Writes THIRD_PARTY_NOTICES.md (repo) and apps/studio/public/THIRD_PARTY_NOTICES.txt (shipped with the UI) from
// every production dependency's own license file, plus code adapted into Hildegard's own files and the fonts' OFL notices. Run after changing dependencies:
//   node scripts/notices.mjs          write the files
//   node scripts/notices.mjs --check  fail if they are out of date (CI)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const list = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
);

// Platform-specific native builds carry the same license as their parent package; list each package once.
const packages = Object.entries(list)
  .flatMap(([license, pkgs]) => pkgs.map((p) => ({ ...p, license })))
  .filter((p) => !/^@napi-rs\/keyring-/.test(p.name))
  .sort((a, b) => a.name.localeCompare(b.name));

const licenseText = (dir) => {
  const files = readdirSync(dir);
  const f = files.find((x) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(x));
  if (f) return readFileSync(join(dir, f), 'utf8').trim();
  // A package under two licenses (MIT OR Apache-2.0, say) ships one file for each, like LICENSE-MIT.
  const each = files.filter((x) => /^licen[cs]e-[\w.-]+$/i.test(x) && !/\.spdx$/i.test(x)).sort();
  return each.length ? each.map((x) => readFileSync(join(dir, x), 'utf8').trim()).join('\n\n') : null;
};

const fonts = [
  [
    'Hildegard Sans',
    'a subset of Source Sans 3, renamed as its Reserved Font Name requires',
    'SourceSans3-OFL.txt',
  ],
  [
    'Hildegard Uncial',
    'a subset of Uncial Antiqua, renamed as its Reserved Font Name requires',
    'UncialAntiqua-OFL.txt',
  ],
  ['Cormorant Garamond', 'a subset', 'CormorantGaramond-OFL.txt'],
  ['DM Mono', 'a subset', 'DMMono-OFL.txt'],
];

// Code adapted into Hildegard's own files, with each file naming its source.
const vendored = [
  [
    'Chatterbox voice encoder',
    'https://github.com/resemble-ai/chatterbox',
    'voice-engine/hildegard_voice/speaker.py follows its speaker encoder.',
    'Chatterbox-MIT.txt',
  ],
  [
    'Real-Time-Voice-Cloning',
    'https://github.com/CorentinJ/Real-Time-Voice-Cloning',
    'Chatterbox’s speaker encoder, and so voice-engine/hildegard_voice/speaker.py, is adapted from it.',
    'Real-Time-Voice-Cloning-MIT.txt',
  ],
];

let out = `# Third-party notices

Hildegard includes the following software and fonts. Each is used under its own license, reproduced below.
Model weights are not included: each is downloaded from its publisher under that model's license.

`;
for (const p of packages) {
  const text = licenseText(p.paths[0]);
  if (!text) throw new Error(`${p.name} has no license file; add its notice by hand`);
  out += `## ${p.name} ${p.versions.join(', ')} (${p.license})\n\n${p.homepage ? `${p.homepage}\n\n` : ''}\`\`\`\n${text}\n\`\`\`\n\n`;
}
for (const [name, url, what, file] of vendored) {
  const text = readFileSync(join(root, 'licenses/code', file), 'utf8').trim();
  out += `## Code: ${name} (MIT)\n\n${url}\n\n${what}\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
}
for (const [name, what, file] of fonts) {
  const text = readFileSync(join(root, 'licenses/fonts', file), 'utf8').trim();
  out += `## Font: ${name} (OFL-1.1)\n\n${name} is ${what}.\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
}

const targets = [
  join(root, 'THIRD_PARTY_NOTICES.md'),
  join(root, 'apps/studio/public/THIRD_PARTY_NOTICES.txt'),
];
if (process.argv.includes('--check')) {
  const stale = targets.filter((t) => !existsSync(t) || readFileSync(t, 'utf8') !== out);
  if (stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run node scripts/notices.mjs`);
    process.exit(1);
  }
} else {
  for (const t of targets) writeFileSync(t, out);
  console.log(`Wrote notices for ${packages.length} packages and ${fonts.length} fonts.`);
}
