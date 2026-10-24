// SPDX-License-Identifier: AGPL-3.0-only
// Puts what the Hildegard app carries inside it where the Tauri build expects it:
//   src-tauri/payload/          the release for this platform, unpacked (hildegard.mjs, the Studio, presets, …)
//   src-tauri/binaries/hildegard-node-<target triple>[.exe]   Node.js, the same version and hash the installers use
//
//   pnpm --filter @hildegard/studio build && node apps/desktop/scripts/prepare-bundle.mjs [--target <rust triple>]
//
// Without --target it prepares for this computer (rustc's host triple).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const root = join(here, '..', '..');
const tauri = join(here, 'src-tauri');
const argv = process.argv.slice(2);
const triple =
  (argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : undefined) ??
  /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];

/** Rust's name for a platform, and the release's. */
const TARGETS = {
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-pc-windows-msvc': 'win32-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
};
const target = triple ? TARGETS[triple] : undefined;
if (!target) {
  console.error(
    `There's no Hildegard app for ${triple ?? 'this computer'}. One of: ${Object.keys(TARGETS).join(', ')}`,
  );
  process.exit(1);
}

// The release for this platform, from the same script that builds the installers' archives.
execFileSync(
  process.execPath,
  [join(root, 'scripts', 'build-release.mjs'), '--payload', join(tauri, 'payload'), '--target', target],
  { stdio: 'inherit' },
);

// Node.js: the version build-release.mjs pins, checked against the hashes nodejs.org publishes for it.
const NODE = /const NODE = '([\d.]+)'/.exec(
  readFileSync(join(root, 'scripts', 'build-release.mjs'), 'utf8'),
)?.[1];
if (!NODE) throw new Error('build-release.mjs names no Node.js version');
const [os, cpu] = target.split('-');
const windows = os === 'win32';
const file = windows ? `node-v${NODE}-win-${cpu}.zip` : `node-v${NODE}-${os}-${cpu}.tar.gz`;
const cache = join(here, '.cache');
mkdirSync(cache, { recursive: true });
const archive = join(cache, file);
const sums = await (await fetch(`https://nodejs.org/dist/v${NODE}/SHASUMS256.txt`)).text();
const want = sums
  .split('\n')
  .find((l) => l.endsWith(`  ${file}`))
  ?.split(/\s+/)[0];
if (!want) throw new Error(`nodejs.org lists no ${file}`);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
if (!existsSync(archive) || sha(archive) !== want) {
  console.log(`Getting ${file}…`);
  const res = await fetch(`https://nodejs.org/dist/v${NODE}/${file}`);
  if (!res.ok) throw new Error(`Couldn't download ${file}: HTTP ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const got = sha(archive);
  if (got !== want) {
    rmSync(archive);
    throw new Error(`${file} didn't match its checksum (expected ${want}, got ${got}).`);
  }
}

// Only the node binary: it carries everything it needs. bsdtar (macOS, and Windows' own tar.exe, as install.ps1
// uses) reads .zip too; the GNU tar that a Unix shell on Windows puts first on PATH doesn't.
const unpacked = join(cache, `node-v${NODE}-${target}`);
rmSync(unpacked, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
const inside = windows ? `node-v${NODE}-win-${cpu}/node.exe` : `node-v${NODE}-${os}-${cpu}/bin/node`;
const tar =
  process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', archive, '-C', unpacked, inside]);
const bin = join(tauri, 'binaries');
mkdirSync(bin, { recursive: true });
const dest = join(bin, `hildegard-node-${triple}${windows ? '.exe' : ''}`);
copyFileSync(join(unpacked, inside), dest);
chmodSync(dest, 0o755);
rmSync(unpacked, { recursive: true, force: true });
console.log(`Node.js ${NODE} for ${triple} in ${dest}`);
