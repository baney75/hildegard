// SPDX-License-Identifier: AGPL-3.0-only
// Builds the Omarchy plugin as baney75/omarchy-hildegard carries it: the omarchy/ folder, plus the release's own
// install.sh as share/install.sh, its version and SHA-256 written into release.env and manifest.json. Set up runs
// that installer from inside the plugin, so no script is downloaded and run, and the marketplace reviews the very code
// that installs Hildegard. Writes <out>/omarchy-hildegard/ and <out>/hildegard-omarchy-<version>.tar.gz, which the
// mirror's own workflow (.github/workflows/follow-hildegard.yml there) unpacks over itself.
//
//   node scripts/build-omarchy.mjs <dir with a built install.sh> [out-dir]
//
// scripts/build-release.mjs calls buildOmarchy() for every release.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'omarchy-hildegard';

export function buildOmarchy(installSh, out) {
  const text = readFileSync(installSh, 'utf8');
  const version = text.match(/^VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
  if (!version) throw new Error(`${installSh} names no VERSION; is it a built install.sh?`);
  if (/@[A-Z_0-9a-z]+@/.test(text))
    throw new Error(`${installSh} still has placeholders; build the release first`);

  const dir = join(out, NAME);
  rmSync(dir, { recursive: true, force: true });
  // The backend tests start a Hildegard server from this repo, so they stay here; the model tests travel.
  cpSync(join(root, 'omarchy'), dir, {
    recursive: true,
    filter: (s) => !s.endsWith('backend.test.mjs'),
  });
  mkdirSync(join(dir, 'share'), { recursive: true });
  writeFileSync(join(dir, 'share', 'install.sh'), text);
  chmodSync(join(dir, 'share', 'install.sh'), 0o644);

  const sha = createHash('sha256').update(text).digest('hex');
  const env = readFileSync(join(dir, 'release.env'), 'utf8')
    .replace(/^HILDEGARD_VERSION=.*$/m, `HILDEGARD_VERSION=${version}`)
    .replace(/^INSTALL_SH_SHA256=.*$/m, `INSTALL_SH_SHA256=${sha}`);
  writeFileSync(join(dir, 'release.env'), env);

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.version = version;
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  execFileSync(process.execPath, [join(root, 'scripts', 'check-omarchy.mjs'), dir], { stdio: 'inherit' });

  const archive = join(out, `hildegard-omarchy-${version}.tar.gz`);
  const noXattrs = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
  execFileSync('tar', [...noXattrs, '-czf', archive, '-C', out, NAME], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return { dir, archive, version, sha };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [from, out = from] = process.argv.slice(2);
  if (!from) {
    console.error('usage: node scripts/build-omarchy.mjs <dir with a built install.sh> [out-dir]');
    process.exit(1);
  }
  const { dir, archive, version, sha } = buildOmarchy(join(from, 'install.sh'), out);
  console.log(`Omarchy plugin for Hildegard ${version} (install.sh ${sha}):\n  ${dir}\n  ${archive}`);
}
