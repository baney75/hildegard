// Checks the Omarchy plugin against the rules its marketplace review applies: a well-formed manifest whose entry
// points exist, no symlinks or binaries, no root or service-manager commands, no piping downloads into a shell,
// and backend scripts that are executable and parse. `node scripts/check-omarchy.mjs` exits 1 on any problem.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../omarchy', import.meta.url));
const problems = [];
const problem = (file, msg) => problems.push(`${file}: ${msg}`);

const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) problem(relative(dir, p), 'symlinks are not allowed');
    else if (st.isDirectory()) walk(p);
    else files.push(relative(dir, p));
  }
})(dir);

// ── Manifest ──────────────────────────────────────────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const KINDS = { 'bar-widget': 'barWidget' };
if (manifest.schemaVersion !== 1) problem('manifest.json', 'schemaVersion must be 1');
if (!/^[a-z0-9]+(\.[a-z0-9-]+){2,}$/.test(manifest.id ?? ''))
  problem('manifest.json', 'id must be reverse-DNS');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) problem('manifest.json', 'version must be x.y.z');
for (const key of ['name', 'author', 'license', 'description'])
  if (typeof manifest[key] !== 'string' || !manifest[key].trim())
    problem('manifest.json', `${key} is required`);
if (!Array.isArray(manifest.kinds) || !manifest.kinds.length) problem('manifest.json', 'kinds is required');
for (const kind of manifest.kinds ?? []) {
  const entry = KINDS[kind];
  if (!entry) {
    problem('manifest.json', `unknown kind ${kind}`);
    continue;
  }
  const file = manifest.entryPoints?.[entry];
  if (!file || !files.includes(file))
    problem('manifest.json', `entryPoints.${entry} must name a file in the plugin`);
}
const bar = manifest.barWidget;
if (manifest.kinds?.includes('bar-widget')) {
  if (!bar?.displayName) problem('manifest.json', 'barWidget.displayName is required');
  if (!['left', 'center', 'right'].includes(bar?.defaultSection))
    problem('manifest.json', 'barWidget.defaultSection must be left, center or right');
}
const pkg = JSON.parse(readFileSync(join(dir, '../package.json'), 'utf8'));
if (manifest.license !== pkg.license)
  problem('manifest.json', `license should match Hildegard's (${pkg.license})`);

// ── Every file ────────────────────────────────────────────────────────────────────────────────────────────────
const FORBIDDEN = [
  [/\b(sudo|pkexec|doas)\b/, 'needs no root'],
  [/\bsystemctl\b/, 'leaves services alone'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/, 'never pipes a download into a shell'],
  [/\bchmod\s+[0-7]*7[0-7]{0,2}\s/, 'does not make files world-writable'],
  // The README may tell people what to add to their own config; the code may not touch it.
  [/~\/\.config\/(hypr|waybar|omarchy\/(?!plugins))/, "does not edit the user's config", /\.md$/],
];
for (const file of files) {
  const buf = readFileSync(join(dir, file));
  if (buf.includes(0)) {
    problem(file, 'binaries are not allowed');
    continue;
  }
  const text = buf.toString('utf8');
  // Tests may name what they check for; the plugin's own files may not.
  if (!file.startsWith('test/'))
    for (const [re, why, except] of FORBIDDEN)
      if (!except?.test(file) && re.test(text)) problem(file, `matches ${re}: the plugin ${why}`);
  if (/\r/.test(text)) problem(file, 'use LF line endings');
}

// ── Backend scripts ───────────────────────────────────────────────────────────────────────────────────────────
for (const file of files.filter((f) => f.startsWith('bin/'))) {
  const p = join(dir, file);
  const text = readFileSync(p, 'utf8');
  if (process.platform !== 'win32' && !(statSync(p).mode & 0o111)) problem(file, 'must be executable');
  if (!text.startsWith('#!/bin/bash\n')) problem(file, 'must start with #!/bin/bash');
  if (!/^# omarchy:summary=.+/m.test(text)) problem(file, 'needs an "# omarchy:summary=" line');
  if (!/^set -euo pipefail$/m.test(text)) problem(file, 'needs set -euo pipefail');
  try {
    execFileSync('bash', ['-n', p], { stdio: 'pipe' });
  } catch (e) {
    problem(file, `bash -n: ${String(e.stderr).trim()}`);
  }
}

// ── The release pin ───────────────────────────────────────────────────────────────────────────────────────────
const pin = Object.fromEntries(
  readFileSync(join(dir, 'release.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')),
);
if (pin.HILDEGARD_VERSION && !/^\d+\.\d+\.\d+$/.test(pin.HILDEGARD_VERSION))
  problem('release.env', 'HILDEGARD_VERSION must be x.y.z');
if (pin.INSTALL_SH_SHA256 && !/^[0-9a-f]{64}$/.test(pin.INSTALL_SH_SHA256))
  problem('release.env', 'INSTALL_SH_SHA256 must be a SHA-256');
if (!pin.HILDEGARD_VERSION !== !pin.INSTALL_SH_SHA256) problem('release.env', 'set both or neither');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Omarchy plugin OK: ${manifest.id} ${manifest.version}, ${files.length} files`);
