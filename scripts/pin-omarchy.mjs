// Pins the Omarchy plugin's Set up to a Hildegard release: writes the release's version and its install.sh's
// SHA-256 into omarchy/release.env, from the SHA256SUMS that scripts/build-release.mjs wrote.
//   node scripts/pin-omarchy.mjs dist/release
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [releaseDir] = process.argv.slice(2);
if (!releaseDir) {
  console.error('usage: node scripts/pin-omarchy.mjs <release dir with SHA256SUMS>');
  process.exit(1);
}
const sums = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8');
const sha = sums.match(/^([0-9a-f]{64}) {2}install\.sh$/m)?.[1];
const version = sums.match(/ {2}hildegard-(\d+\.\d+\.\d+)-[\w-]+\.tar\.gz$/m)?.[1];
if (!sha || !version) {
  console.error(`${releaseDir}/SHA256SUMS names no install.sh or no release archive`);
  process.exit(1);
}
const file = fileURLToPath(new URL('../omarchy/release.env', import.meta.url));
const text = readFileSync(file, 'utf8')
  .replace(/^HILDEGARD_VERSION=.*$/m, `HILDEGARD_VERSION=${version}`)
  .replace(/^INSTALL_SH_SHA256=.*$/m, `INSTALL_SH_SHA256=${sha}`);
writeFileSync(file, text);
console.log(`omarchy/release.env now installs Hildegard ${version} (install.sh ${sha})`);
