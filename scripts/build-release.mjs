// SPDX-License-Identifier: AGPL-3.0-only
// Builds Hildegard's release archives, one per platform, and the install scripts with every hash written in.
//
//   pnpm --filter @hildegard/studio build && node scripts/build-release.mjs [out-dir]
//   node scripts/build-release.mjs --payload <dir> --target <os-cpu>
//
// Each archive holds hildegard.mjs (the CLI, server and MCP server in one file), the built Studio, the presets, the
// film-look node, the licenses, and the OS keychain module for that platform. With --payload it writes one target's
// files, unpacked, to <dir> and stops there: what the Hildegard app (apps/desktop) carries inside it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildOmarchy } from './build-omarchy.mjs';
import { packSkills } from './pack-skills.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flagValue = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const payload = flagValue('--payload');
const out = payload ?? argv[0] ?? join(root, 'dist', 'release');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { version: keyring } = JSON.parse(
  readFileSync(join(root, 'apps', 'server', 'node_modules', '@napi-rs', 'keyring', 'package.json'), 'utf8'),
);
const NODE = '24.21.0';
const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
const payloadTarget = flagValue('--target');
if (payload && !TARGETS.includes(payloadTarget)) {
  console.error(`Name the platform with --target, one of: ${TARGETS.join(', ')}`);
  process.exit(1);
}
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

const studio = join(root, 'apps', 'studio', 'dist');
if (!existsSync(join(studio, 'index.html'))) {
  console.error('Build the Studio first: pnpm --filter @hildegard/studio build');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
const stage = payload ? out : join(out, 'stage');
mkdirSync(stage, { recursive: true });

// One file for the CLI, server and MCP server. The banner tells the code where its files are, before any of it runs.
await build({
  entryPoints: [join(root, 'apps', 'cli', 'src', 'main.ts')],
  outfile: join(stage, 'hildegard.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@napi-rs/keyring'],
  legalComments: 'eof',
  minifySyntax: true,
  banner: {
    js: [
      `// Hildegard ${version}. AGPL-3.0-only. Source: https://github.com/baney75/hildegard${commit ? `/tree/${commit}` : ''}`,
      "import { createRequire as __hgRequire } from 'node:module';",
      "import { fileURLToPath as __hgPath } from 'node:url';",
      "import { dirname as __hgDir, join as __hgJoin } from 'node:path';",
      'const require = __hgRequire(import.meta.url);',
      'process.env.HILDEGARD_ENTRY ??= __hgPath(import.meta.url);',
      // Always this bundle's own folder: a value inherited from another version (one updating to this) would be wrong.
      'process.env.HILDEGARD_RESOURCES = __hgDir(__hgPath(import.meta.url));',
      "process.env.HILDEGARD_PRESETS_DIR = __hgJoin(process.env.HILDEGARD_RESOURCES, 'presets');",
      commit
        ? `process.env.HILDEGARD_COMMIT = ${JSON.stringify(commit)};`
        : 'delete process.env.HILDEGARD_COMMIT;',
    ].join('\n'),
  },
  logLevel: 'warning',
});

const copy = (from, to, filter) => cpSync(join(root, from), join(stage, to), { recursive: true, filter });
copy('apps/studio/dist', 'studio');
copy('presets', 'presets');
for (const node of ['hildegard_look', 'hildegard_guard'])
  copy(`comfy-nodes/${node}`, `comfy-nodes/${node}`, (s) => !/__pycache__|\.pyc$|test_\w+\.py$/.test(s));
// The voice engine and the pinned packages each of its environments installs; its tests stay behind.
copy('voice-engine', 'voice-engine', (s) => !/__pycache__|\.pyc$|[\\/]tests([\\/]|$)|\.pytest_cache/.test(s));
copy('packages/comfy/fixtures', 'fixtures');
copy('tools/export_film.py', 'tools/export_film.py');
copy('tools/poster.py', 'tools/poster.py');
copy('tools/review_media.py', 'tools/review_media.py');
copy('tools/review_mesh.py', 'tools/review_mesh.py');
copy('tools/review_web.js', 'tools/review_web.js');
copy('skills', 'skills');
copy('deploy/runpod/boot.sh', 'deploy/runpod/boot.sh');
copy('licenses', 'licenses');
for (const f of ['LICENSE', 'LICENSE-APACHE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md']) copy(f, f);
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify({ name: 'hildegard', version, private: true, type: 'module', license: 'AGPL-3.0-only', dependencies: { '@napi-rs/keyring': keyring } }, null, 2)}\n`,
);

// The keychain module's build for that platform only; npm picks it by the flags, so this runs anywhere.
const keychainFor = (dir, t) => {
  const [os, cpu] = t.split('-');
  execFileSync(
    'npm',
    [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--no-package-lock',
      `--os=${os}`,
      `--cpu=${cpu}`,
      ...(os === 'linux' ? ['--libc=glibc'] : []),
    ],
    { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' },
  );
};

if (payload) {
  keychainFor(stage, payloadTarget);
  console.log(`Hildegard ${version} for ${payloadTarget} in ${stage}`);
  process.exit(0);
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sums = {};
for (const t of TARGETS) {
  const name = `hildegard-${version}-${t}`;
  const dir = join(out, name);
  cpSync(stage, dir, { recursive: true });
  keychainFor(dir, t);
  const archive = join(out, `${name}.tar.gz`);
  // macOS tar (bsdtar) would add Apple xattr headers (com.apple.provenance) that GNU tar warns about on every
  // install; COPYFILE_DISABLE drops the AppleDouble files and --no-xattrs the pax headers.
  const noXattrs = process.platform === 'darwin' ? ['--no-xattrs'] : [];
  execFileSync('tar', [...noXattrs, '-czf', archive, '-C', out, name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  rmSync(dir, { recursive: true, force: true });
  sums[t] = sha(archive);
}
rmSync(stage, { recursive: true, force: true });

// Node.js for each platform, by the hashes nodejs.org publishes for this release.
const shasums = await (await fetch(`https://nodejs.org/dist/v${NODE}/SHASUMS256.txt`)).text();
const nodeFile = (t) => {
  const [os, cpu] = t.split('-');
  return os === 'win32' ? `node-v${NODE}-win-${cpu}.zip` : `node-v${NODE}-${os}-${cpu}.tar.gz`;
};
const nodeSums = Object.fromEntries(
  TARGETS.map((t) => {
    const line = shasums.split('\n').find((l) => l.endsWith(`  ${nodeFile(t)}`));
    if (!line) throw new Error(`nodejs.org lists no ${nodeFile(t)}`);
    return [t, line.split(/\s+/)[0]];
  }),
);

for (const script of ['install.sh', 'install.ps1']) {
  let text = readFileSync(join(root, 'install', script), 'utf8')
    .replaceAll('@VERSION@', version)
    .replaceAll('@NODE@', NODE);
  for (const t of TARGETS) {
    const k = t.replace('-', '_');
    text = text.replaceAll(`@APP_SHA_${k}@`, sums[t]).replaceAll(`@NODE_SHA_${k}@`, nodeSums[t]);
  }
  // macOS's /bin/sh is bash 3.2, which can read a UTF-8 byte after $NAME as part of the name.
  if (script === 'install.sh' && /[^\t\n -~]/.test(text)) throw new Error('install.sh must be ASCII only');
  if (/@[A-Z_0-9a-z]+@/.test(text))
    throw new Error(`${script} has a placeholder left: ${text.match(/@[A-Z_0-9a-z]+@/)[0]}`);
  writeFileSync(join(out, script), text);
}

// The install page, ready for a static host (see site/README.md). It is not a release asset and has no checksum.
cpSync(join(root, 'site'), join(out, 'site'), { recursive: true, filter: (s) => !s.endsWith('README.md') });

// The skills for apps that take an upload: hildegard.plugin (the Claude app, Cowork) and one zip per skill (claude.ai,
// ChatGPT).
const packed = packSkills(out, version).map((f) => basename(f));

// The Omarchy plugin, carrying this release's install.sh, for baney75/omarchy-hildegard to follow.
const omarchy = basename(buildOmarchy(join(out, 'install.sh'), out).archive);

const lines = Object.entries(sums).map(([t, s]) => `${s}  hildegard-${version}-${t}.tar.gz`);
for (const s of ['install.sh', 'install.ps1', omarchy, ...packed]) lines.push(`${sha(join(out, s))}  ${s}`);
writeFileSync(join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`);
console.log(`Hildegard ${version} release in ${out}:\n${lines.join('\n')}`);
