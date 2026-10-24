// Writes latest.json, which the app's updater reads from releases/latest/download/, from the signed app files in a
// release folder. Each kind of install gets its own entry, so the AppImage updates to an AppImage and the .msi to an
// .msi. The .deb gets none: the system's package manager updates it.
//   node scripts/updater-manifest.mjs <release dir> <tag>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag] = process.argv.slice(2);
if (!dir || !/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  console.error('usage: node scripts/updater-manifest.mjs <release dir> <tag like v0.1.5>');
  process.exit(1);
}
const files = readdirSync(dir);
const kinds = {
  'darwin-aarch64-app': /^Hildegard\.app\.tar\.gz$/,
  'linux-x86_64-appimage': /_amd64\.AppImage$/,
  'windows-x86_64-nsis': /_x64-setup\.exe$/,
  'windows-x86_64-msi': /_x64_en-US\.msi$/,
};
const platforms = {};
for (const [kind, re] of Object.entries(kinds)) {
  // The versioned file, not the copy under a version-free name for the install page.
  const name = files.find((f) => re.test(f) && files.includes(`${f}.sig`));
  if (!name) {
    console.error(`${dir} has no signed file for ${kind}`);
    process.exit(1);
  }
  platforms[kind] = {
    signature: readFileSync(join(dir, `${name}.sig`), 'utf8').trim(),
    url: `https://github.com/baney75/hildegard/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}
const manifest = { version: tag.slice(1), pub_date: new Date().toISOString(), platforms };
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json offers ${tag} to ${Object.keys(platforms).join(', ')}`);
