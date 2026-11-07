// SPDX-License-Identifier: AGPL-3.0-only
// Keeps the files that several skills need in each of those skills, from one source each, so every skill still works
// when it is uploaded alone (one zip per skill for claude.ai and ChatGPT, see scripts/pack-skills.mjs):
//
//   node scripts/sync-skill-shared.mjs           copy every source in skills/SHARED.json into the skills that list it
//   node scripts/sync-skill-shared.mjs --check   change nothing; exit 1 when a copy is missing or differs from its source
//
// skills/SHARED.json is { about, copies: [{ source, to?, skills: [folder, ...] }] }. `source` is a path from the
// repository root, `to` the folder inside each skill (default "scripts"). Edit the source, never a copy:
// scripts/check-skills.mjs fails when a copy differs, and the standalone test (packages/agents/test) packs each skill
// alone and fails when something it names is missing.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The copies the manifest asks for, as { source, dest, skill }, with the paths from the repository root. */
export function copies(repo = root) {
  const file = join(repo, 'skills', 'SHARED.json');
  const problems = [];
  const out = [];
  if (!existsSync(file)) return { copies: out, problems };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { copies: out, problems: [`skills/SHARED.json is not JSON: ${e.message}`] };
  }
  const seen = new Set();
  for (const [i, c] of (manifest.copies ?? []).entries()) {
    const at = `skills/SHARED.json copies[${i}]`;
    const to = c.to ?? 'scripts';
    if (
      typeof c.source !== 'string' ||
      /^\/|\\|\.\.|^[A-Za-z]:/.test(c.source) ||
      !existsSync(join(repo, c.source))
    ) {
      problems.push(`${at}: source "${c.source}" is not a file in the repository`);
      continue;
    }
    if (typeof to !== 'string' || /^\/|\\|\.\.|^[A-Za-z]:/.test(to)) {
      problems.push(`${at}: "to" must be a folder inside the skill`);
      continue;
    }
    if (!Array.isArray(c.skills) || c.skills.length === 0) {
      problems.push(`${at}: skills must list at least one skill folder`);
      continue;
    }
    for (const skill of c.skills) {
      if (!statSync(join(repo, 'skills', String(skill), 'SKILL.md'), { throwIfNoEntry: false })?.isFile()) {
        problems.push(`${at}: "${skill}" is not a skill folder`);
        continue;
      }
      const dest = posix.join('skills', skill, to, basename(c.source));
      if (dest === c.source) {
        problems.push(`${at}: ${dest} is its own source; list only the skills that need a copy`);
        continue;
      }
      if (seen.has(dest)) problems.push(`${at}: ${dest} is listed twice`);
      seen.add(dest);
      out.push({ source: c.source, dest, skill });
    }
  }
  return { copies: out, problems };
}

/** Problems with the copies: each one missing or different from its source. Reads only. */
export function drift(repo = root) {
  const { copies: list, problems } = copies(repo);
  for (const { source, dest } of list) {
    const want = readFileSync(join(repo, source));
    const at = join(repo, dest);
    if (!existsSync(at)) problems.push(`${dest} is missing: run node scripts/sync-skill-shared.mjs`);
    else if (!readFileSync(at).equals(want))
      problems.push(
        `${dest} differs from ${source}: change the source, then run node scripts/sync-skill-shared.mjs`,
      );
  }
  return problems;
}

/** Copies every source over its destinations. Returns the destinations it wrote. */
export function sync(repo = root) {
  const { copies: list, problems } = copies(repo);
  if (problems.length) throw new Error(problems.join('\n'));
  const wrote = [];
  for (const { source, dest } of list) {
    const want = readFileSync(join(repo, source));
    const at = join(repo, dest);
    if (existsSync(at) && readFileSync(at).equals(want)) continue;
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, want);
    wrote.push(dest);
  }
  return wrote;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = drift();
    if (problems.length) {
      console.error(problems.map((p) => `  ${p}`).join('\n'));
      process.exit(1);
    }
    console.log('Every shared skill file matches its source.');
  } else {
    const wrote = sync();
    console.log(
      wrote.length ? wrote.map((w) => `wrote ${w}`).join('\n') : 'Every shared skill file is up to date.',
    );
  }
}
