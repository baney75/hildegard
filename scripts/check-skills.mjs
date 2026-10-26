// Checks every file in skills/ for the shapes of an attack (mcp/src/skill-scan.ts): a skill is instructions agents
// follow on their owners' computers, so a change to one is reviewed like code. A finding marked block fails, unless
// skills/SCAN-ALLOW names that exact line, which only the owner may change (CODEOWNERS); findings marked review are
// listed with --verbose, for the reviewer. No symlinks, and nothing but text. `node scripts/check-skills.mjs` exits 1 on a problem.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSkillText } from '../mcp/src/skill-scan.ts';

const dir = fileURLToPath(new URL('../skills', import.meta.url));
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
const lineId = (s) => createHash('sha256').update(s.trim()).digest('hex').slice(0, 16);

/** "<path> <rule> <line hash>  # why it is fine" per line. */
const allowFile = join(dir, 'SCAN-ALLOW');
const allowed = new Set(
  existsSync(allowFile)
    ? readFileSync(allowFile, 'utf8')
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
    : [],
);

const problems = [];
const reviews = [];
const used = new Set();
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const rel = relative(dir, p).split(sep).join('/');
    const st = lstatSync(p);
    if (st.isSymbolicLink()) problems.push(`skills/${rel}: symlinks are not allowed in skills`);
    else if (st.isDirectory()) {
      if (name !== '__pycache__') walk(p);
    } else if (rel === 'SCAN-ALLOW') continue;
    else if (!TEXT.has(extname(name).toLowerCase()))
      problems.push(`skills/${rel}: only text files belong in a skill (${extname(name) || 'no extension'})`);
    else {
      const text = readFileSync(p, 'utf8');
      const lines = text.split(/\r?\n/);
      for (const f of scanSkillText(text)) {
        const key = `${rel} ${f.id} ${lineId(lines[f.line - 1] ?? '')}`;
        if (f.severity === 'review') reviews.push(`skills/${rel}:${f.line} ${f.id}: ${f.why}`);
        else if (allowed.has(key)) used.add(key);
        else
          problems.push(
            `skills/${rel}:${f.line} ${f.id}: ${f.why} ${f.excerpt}\n    allow it, after reading it, with this line in skills/SCAN-ALLOW: ${key}`,
          );
      }
    }
  }
})(dir);
for (const a of allowed)
  if (!used.has(a)) problems.push(`skills/SCAN-ALLOW: "${a}" matches nothing; remove it`);

if (process.argv.includes('--verbose')) for (const r of reviews) console.log(r);
if (problems.length) {
  console.error(`Skills check failed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Skills check passed (${reviews.length} lines for a reviewer to look at: --verbose lists them).`);
