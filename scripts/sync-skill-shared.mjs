// SPDX-License-Identifier: AGPL-3.0-only
// Keeps the files that several skills need in each of those skills, from one source each, so every skill still works
// when it is uploaded alone (one zip per skill for claude.ai and ChatGPT, see scripts/pack-skills.mjs):
//
//   node scripts/sync-skill-shared.mjs           copy every source in skills/SHARED.json into the skills that list it
//   node scripts/sync-skill-shared.mjs --check   change nothing; exit 1 when a copy is missing, differs from its source,
//                                                or is left over from an entry the manifest no longer has
//
// skills/SHARED.json is { about, copies: [{ source, to?, skills: [folder, ...] }] }. `source` is a path from the
// repository root, `to` the folder inside each skill (default "scripts"). Edit the source, never a copy:
// scripts/check-skills.mjs fails when a copy differs, and the standalone test (packages/agents/test) packs each skill
// alone and fails when something it names is missing.
//
// skills/SHARED.lock.json is written by the sync and lists every copy it made, with the hash of the bytes it wrote. A
// copy whose entry left the manifest is removed by the next sync and is a problem for --check until then, so it cannot
// keep shipping stale. Only a file that still holds the bytes the sync wrote is removed: one that was edited by hand
// (a copy forked into its own version) is kept and dropped from the lock, and a file that is now a source is never
// removed, whatever the lock says. Hashes and comparisons read CRLF as LF in a text file, so a Windows checkout that
// changed the line endings is neither drift nor a hand edit.
//
// No link anywhere in a source or destination path is followed: a source or a destination that is a link, or sits under
// a folder that is one, is refused, and a copy is written to a temporary file next to its destination and renamed.
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Whether `path` is a real path inside `dir`, links followed. */
function inside(dir, path) {
  try {
    const rel = relative(realpathSync(dir), realpathSync(path));
    return (
      rel !== '' &&
      rel !== '..' &&
      !rel.startsWith(`..${sep}`) &&
      !/^[A-Za-z]:/.test(rel) &&
      !rel.startsWith(sep)
    );
  } catch {
    return false;
  }
}

/**
 * Why `rel` (slash-separated, from the repository root) cannot be read or written as a plain file, or '' when it can:
 * every part that exists is looked at without following links, so a link anywhere on the way is refused.
 */
function pathProblem(repo, rel) {
  const parts = rel.split('/');
  let cur = repo;
  for (const [i, part] of parts.entries()) {
    cur = join(cur, part);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return '';
    const here = parts.slice(0, i + 1).join('/');
    if (st.isSymbolicLink()) return `${here} is a link`;
    if (i < parts.length - 1 && !st.isDirectory()) return `${here} is not a folder`;
    if (i === parts.length - 1 && !st.isFile()) return `${here} is not a regular file`;
  }
  return '';
}

/** Whether the nearest existing folder above `rel` really lies inside `skills/<skill>` (links followed). */
function stays(repo, skill, rel) {
  let dir = dirname(join(repo, rel));
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    const base = realpathSync(join(repo, 'skills', skill));
    const r = relative(base, realpathSync(dir));
    return (
      r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r))
    );
  } catch {
    return false;
  }
}

/** Writes through a temporary file in the same folder, then renames it over `at`. */
function writeFileAtomic(at, data) {
  mkdirSync(dirname(at), { recursive: true });
  const tmp = join(dirname(at), `.${basename(at)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: 'wx' });
    renameSync(tmp, at);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const LOCK = 'skills/SHARED.lock.json';

/**
 * The bytes as they are compared and hashed: a text file (no NUL byte) with CRLF read as LF, so a Windows checkout that
 * rewrote the line endings of a source, a copy or both still matches the lock committed from Linux or macOS. A file
 * with a NUL byte is binary and is left as it is.
 */
function canon(bytes) {
  if (bytes.includes(0)) return bytes;
  const text = bytes.toString('latin1');
  return text.includes('\r\n') ? Buffer.from(text.replaceAll('\r\n', '\n'), 'latin1') : bytes;
}

/** Whether two files hold the same content, line endings aside. */
const same = (a, b) => canon(a).equals(canon(b));

const sha = (bytes) => createHash('sha256').update(canon(bytes)).digest('hex');

/** The copies the last sync wrote: { entries, hashes, problem }. entries is null when there is no lock yet. */
function readLock(repo) {
  const bad = pathProblem(repo, LOCK);
  if (bad) return { entries: null, hashes: {}, problem: `${LOCK}: ${bad}` };
  const file = join(repo, LOCK);
  if (!existsSync(file)) return { entries: null, hashes: {}, problem: '' };
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    const entries = lock.copies;
    if (!Array.isArray(entries) || entries.some((e) => typeof e !== 'string'))
      throw new Error('copies must list paths');
    const hashes = {};
    for (const [k, v] of Object.entries(lock.hashes ?? {}))
      if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) hashes[k] = v;
    return { entries, hashes, problem: '' };
  } catch (e) {
    return {
      entries: null,
      hashes: {},
      problem: `${LOCK} is not a lock file: ${e.message}; run node scripts/sync-skill-shared.mjs`,
    };
  }
}

/** A path a lock may name for removal: a file in a skill folder, never SKILL.md or a way out. */
const removable = (repo, e) =>
  /^skills\/[a-z0-9-]+\/[^\\]+$/.test(e) &&
  !e.split('/').includes('..') &&
  basename(e) !== 'SKILL.md' &&
  pathProblem(repo, e) === '' &&
  lstatSync(join(repo, e), { throwIfNoEntry: false })?.isFile() === true;

/** What to do with a lock entry the manifest no longer lists: 'source' (it is one now), 'remove', 'hand-edited' or 'gone'. */
function orphanFate(repo, e, sources, hashes) {
  if (!lstatSync(join(repo, e), { throwIfNoEntry: false })) return 'gone';
  if (sources.has(e)) return 'source';
  if (!removable(repo, e)) return 'gone';
  return hashes[e] && sha(readFileSync(join(repo, e))) === hashes[e] ? 'remove' : 'hand-edited';
}

/** The text of the lock for `list`: every copy the sync keeps, with the hash of its bytes. */
function lockText(repo, list) {
  const hashes = {};
  for (const { source, dest } of list) hashes[dest] = sha(readFileSync(join(repo, source)));
  const copies = Object.keys(hashes).sort();
  return `${JSON.stringify(
    {
      about:
        'Written by node scripts/sync-skill-shared.mjs: every copy it made from skills/SHARED.json, with the hash of the bytes it wrote. A copy that leaves the manifest is removed by the next sync unless it was edited by hand or is now a source. Do not edit.',
      copies,
      hashes: Object.fromEntries(copies.map((d) => [d, hashes[d]])),
    },
    null,
    2,
  )}\n`;
}

/** The copies the manifest asks for, as { source, dest, skill }, with the paths from the repository root. */
export function copies(repo = root) {
  const file = join(repo, 'skills', 'SHARED.json');
  const problems = [];
  const out = [];
  if (!existsSync(file)) return { copies: out, problems, sources: new Set() };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      copies: out,
      problems: [`skills/SHARED.json is not JSON: ${e.message}`],
      sources: new Set(),
    };
  }
  const seen = new Set();
  const sources = new Set();
  for (const [i, c] of (manifest.copies ?? []).entries()) {
    const at = `skills/SHARED.json copies[${i}]`;
    const to = c.to ?? 'scripts';
    if (
      typeof c.source !== 'string' ||
      /^\/|\\|\.\.|^[A-Za-z]:/.test(c.source) ||
      !existsSync(join(repo, c.source)) ||
      !inside(repo, join(repo, c.source)) ||
      pathProblem(repo, c.source) ||
      !statSync(join(repo, c.source)).isFile()
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
      // A plain folder name directly under skills/: never a path, never a link out.
      const folder = join(repo, 'skills', String(skill));
      if (
        typeof skill !== 'string' ||
        !/^[a-z0-9-]+$/.test(skill) ||
        !lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() ||
        !inside(join(repo, 'skills'), folder) ||
        !statSync(join(folder, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()
      ) {
        problems.push(`${at}: "${skill}" is not a skill folder`);
        continue;
      }
      const dest = posix.join('skills', skill, to, basename(c.source));
      if (dest === c.source) {
        problems.push(`${at}: ${dest} is its own source; list only the skills that need a copy`);
        continue;
      }
      // Nothing the copy is written through may be a link: not the skill's folders, not the file itself.
      const through = pathProblem(repo, dest);
      if (through || !stays(repo, skill, dest)) {
        problems.push(
          `${at}: ${dest} cannot be written: ${through || 'it resolves outside its skill folder'}`,
        );
        continue;
      }
      if (seen.has(dest)) problems.push(`${at}: ${dest} is listed twice`);
      seen.add(dest);
      out.push({ source: c.source, dest, skill });
      sources.add(c.source);
    }
  }
  return { copies: out, problems, sources };
}

/** Problems with the copies: each one missing or different from its source, or left over. Reads only. */
export function drift(repo = root) {
  const { copies: list, problems, sources } = copies(repo);
  const manifestOk = problems.length === 0;
  for (const { source, dest } of list) {
    const want = readFileSync(join(repo, source));
    const at = join(repo, dest);
    if (!existsSync(at)) problems.push(`${dest} is missing: run node scripts/sync-skill-shared.mjs`);
    else if (!same(readFileSync(at), want))
      problems.push(
        `${dest} differs from ${source}: change the source, then run node scripts/sync-skill-shared.mjs`,
      );
  }
  if (manifestOk && existsSync(join(repo, 'skills', 'SHARED.json'))) {
    const { entries, hashes, problem } = readLock(repo);
    const now = new Set(list.map((c) => c.dest));
    if (problem) problems.push(problem);
    const stale = (entries ?? []).filter((e) => !now.has(e));
    for (const e of stale) {
      const fate = orphanFate(repo, e, sources, hashes);
      if (fate === 'remove')
        problems.push(
          `${e} is an orphaned copy: skills/SHARED.json no longer lists it. Run node scripts/sync-skill-shared.mjs to remove it`,
        );
      else if (fate === 'hand-edited')
        problems.push(
          `${e} is no longer shared and was changed by hand: delete it or keep it, then run node scripts/sync-skill-shared.mjs to drop it from the lock (the sync does not delete it)`,
        );
    }
    if (
      problems.length === 0 &&
      now.size > 0 &&
      (entries === null ||
        stale.length > 0 ||
        readFileSync(join(repo, LOCK), 'utf8') !== lockText(repo, list))
    )
      problems.push(`${LOCK} is out of date: run node scripts/sync-skill-shared.mjs`);
  }
  return problems;
}

/** Copies every source over its destinations and removes the copies the manifest dropped. Returns { wrote, removed, kept }. */
export function syncAll(repo = root) {
  const { copies: list, problems, sources } = copies(repo);
  if (problems.length) throw new Error(problems.join('\n'));
  const wrote = [];
  const removed = [];
  const kept = [];
  for (const { source, dest } of list) {
    const want = readFileSync(join(repo, source));
    const at = join(repo, dest);
    if (existsSync(at) && same(readFileSync(at), want)) continue;
    writeFileAtomic(at, want);
    wrote.push(dest);
  }
  if (existsSync(join(repo, 'skills', 'SHARED.json'))) {
    const now = new Set(list.map((c) => c.dest));
    const { entries, hashes, problem } = readLock(repo);
    if (problem && entries === null && pathProblem(repo, LOCK)) throw new Error(problem);
    for (const e of entries ?? []) {
      if (now.has(e)) continue;
      const fate = orphanFate(repo, e, sources, hashes);
      if (fate === 'remove') {
        rmSync(join(repo, e));
        removed.push(e);
      } else if (fate === 'hand-edited') kept.push(e);
    }
    const lock = lockText(repo, list);
    if (!existsSync(join(repo, LOCK)) || readFileSync(join(repo, LOCK), 'utf8') !== lock)
      writeFileAtomic(join(repo, LOCK), lock);
  }
  return { wrote, removed, kept };
}

/** Copies every source over its destinations. Returns the destinations it wrote. */
export const sync = (repo = root) => syncAll(repo).wrote;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = drift();
    if (problems.length) {
      console.error(problems.map((p) => `  ${p}`).join('\n'));
      process.exit(1);
    }
    console.log('Every shared skill file matches its source.');
  } else {
    const { wrote, removed, kept } = syncAll();
    const lines = [
      ...wrote.map((w) => `wrote ${w}`),
      ...removed.map((r) => `removed ${r}`),
      ...kept.map((k) => `kept ${k}: no longer shared and changed by hand, so it is not deleted`),
    ];
    console.log(lines.length ? lines.join('\n') : 'Every shared skill file is up to date.');
  }
}
