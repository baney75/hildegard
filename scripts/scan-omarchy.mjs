// SPDX-License-Identifier: AGPL-3.0-only
// Runs the Omarchy plugin marketplace's own Automated Security Baseline on the plugin as baney75/omarchy-hildegard
// will carry it, and fails unless the only thing it reports is the installer (Set up), which a maintainer reviews
// once. A finding (such as running a download) would cost the listing its "Snapshot verified" and its one-command
// install, so CI catches it here first.
//
//   git clone https://github.com/omacom/omarchy-plugin-marketplace <dir> && node scripts/scan-omarchy.mjs <dir>
import { lstatSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOmarchy } from './build-omarchy.mjs';

const [marketplace] = process.argv.slice(2);
if (!marketplace) {
  console.error('usage: node scripts/scan-omarchy.mjs <checkout of omacom/omarchy-plugin-marketplace>');
  process.exit(1);
}
const { buildSecurityBaseline } = await import(
  pathToFileURL(join(marketplace, 'scripts', 'security-baseline-analysis.mjs')).href
);

// The plugin, built around this checkout's install.sh with stand-in hashes, as a release would build it.
const tmp = mkdtempSync(join(tmpdir(), 'hildegard-omarchy-scan-'));
const source = readFileSync(fileURLToPath(new URL('../install/install.sh', import.meta.url)), 'utf8');
writeFileSync(
  join(tmp, 'install.sh'),
  source
    .replaceAll('@VERSION@', '0.0.0')
    .replaceAll('@NODE@', '24.0.0')
    .replace(/@[A-Z_a-z0-9]+@/g, '0'.repeat(64)),
);
const { dir } = buildOmarchy(join(tmp, 'install.sh'), tmp);

const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p);
    else {
      const buf = readFileSync(p);
      files.push({
        path: relative(dir, p),
        mode: st.mode & 0o111 ? '100755' : '100644',
        binary: buf.includes(0),
        size: buf.length,
        content: buf.toString('utf8'),
      });
    }
  }
})(dir);

const repo = 'baney75/omarchy-hildegard';
const result = buildSecurityBaseline({
  repository: repo,
  repoUrl: `https://github.com/${repo}`,
  commitSha: '0'.repeat(40),
  files,
});
const where = (evidence) => evidence.map((e) => `${e.path}:${e.line}`).join(', ');
const problems = [
  ...result.findings.map((f) => `finding ${f.ruleId} (${f.title}) at ${where(f.evidence)}`),
  ...result.capabilities
    .filter((c) => c.id !== 'installer')
    .map((c) => `capability ${c.id} at ${where(c.evidence)}`),
];
if (problems.length) {
  console.error(`The marketplace baseline says ${result.outcome}:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(
  `Marketplace baseline: ${result.outcome}, ${result.capabilities.map((c) => c.id).join(', ') || 'nothing'} to review`,
);
