// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenSCAD: code-CAD that an agent writes as text and Hildegard renders into a mesh, so a model loop can take the
 * source itself and every round stays a small, named edit to one parametric file. OpenSCAD is a separate program
 * (GPL-2.0-or-later) that Hildegard finds on this computer and runs; it is never linked or shipped with Hildegard.
 *
 * Source from an agent is untrusted, and OpenSCAD can read other files: `include <…>` and `use <…>` take any path,
 * and `import()`, `surface()` and older built-ins read meshes, images and data. So two walls stand in front of it.
 *
 * First, every .scad file of a round is read here, cut into tokens as OpenSCAD's own lexer cuts them, and held to
 * these rules: an include or use names a .scad file by a relative path (never absolute, never `..`), from the folder
 * of the file that names it, inside the round or (only in a sandbox) a library; an import or surface names one plain
 * string, a file the round itself carries; and no other built-in may read a file by name.
 *
 * Second, OpenSCAD runs sandboxed where this computer can (sandbox-exec on macOS, bubblewrap on Linux): no network,
 * the owner's home and Hildegard's data hidden but for the round and the libraries, and nothing written outside the
 * round. Library code isn't read here, so a round may include libraries only inside the sandbox. It runs in the round's
 * own folder, one render at a time, with one time limit for the round, an environment of only what it needs, and its
 * whole process group stopped at the deadline. What it says comes back with this computer's paths taken out.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

export interface OpenScad {
  path: string;
  /** "2021.01", or a snapshot's date, such as "2025.08.17". */
  version: string;
  /** The arguments that pick the Manifold geometry engine, when this build has it ([] when it's the default or absent). */
  manifoldArgs: string[];
  /** Whether this build renders with Manifold, which is many times faster than CGAL on booleans. */
  manifold: boolean;
}

export interface ScadLibrary {
  name: string;
  dir: string;
}

export class ScadError extends Error {
  /** What OpenSCAD said, line by line, when it ran. */
  readonly log: string[];
  constructor(message: string, log: string[] = []) {
    super(message);
    this.name = 'ScadError';
    this.log = log;
  }
}

const NAMES = ['openscad', 'openscad-nightly'];

/** Where OpenSCAD may be on this computer: HILDEGARD_OPENSCAD, then the usual installs, then PATH. */
export function openScadCandidates(env: NodeJS.ProcessEnv = process.env, os = platform()): string[] {
  const found: string[] = [];
  if (env.HILDEGARD_OPENSCAD) return [env.HILDEGARD_OPENSCAD];
  if (os === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')])
      found.push(
        join(root, 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'),
        join(root, 'OpenSCAD-Nightly.app', 'Contents', 'MacOS', 'OpenSCAD'),
      );
  } else if (os === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean) as string[])
      found.push(
        join(root, 'OpenSCAD', 'openscad.com'),
        join(root, 'OpenSCAD', 'openscad.exe'),
        join(root, 'OpenSCAD (Nightly)', 'openscad.com'),
        join(root, 'OpenSCAD (Nightly)', 'openscad.exe'),
      );
  }
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const n of NAMES) found.push(join(dir, os === 'win32' ? `${n}.exe` : n));
  return found;
}

const probed = new Map<string, OpenScad | null>();

/** Reads a build's version and whether it can render with Manifold, from `--version` and `--help`. */
export function probeOpenScad(path: string): OpenScad | null {
  if (probed.has(path)) return probed.get(path)!;
  const run = (arg: string) => {
    const r = spawnSync(path, [arg], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    return r.error ? null : `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  };
  const v = run('--version');
  const m = v ? /OpenSCAD version\s+(\S+)/i.exec(v) : null;
  let out: OpenScad | null = null;
  if (m) {
    const help = run('--help') ?? '';
    // Snapshots from late 2024 take --backend; earlier ones had Manifold as an experimental feature. From August
    // 2025 Manifold is the default, and --backend still picks it explicitly.
    const manifoldArgs = /--backend/.test(help)
      ? ['--backend', 'Manifold']
      : /\bmanifold\b/i.test(help)
        ? ['--enable', 'manifold']
        : [];
    out = { path, version: m[1]!, manifoldArgs, manifold: manifoldArgs.length > 0 };
  }
  probed.set(path, out);
  return out;
}

/** The OpenSCAD on this computer, or null. */
export function findOpenScad(env: NodeJS.ProcessEnv = process.env, os = platform()): OpenScad | null {
  for (const p of openScadCandidates(env, os)) {
    if (!existsSync(p)) continue;
    const o = probeOpenScad(p);
    if (o) return o;
  }
  return null;
}

/** The folders OpenSCAD looks in for libraries: Hildegard's own, then the user's OpenSCAD library folder. */
export function libraryDirs(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  os = platform(),
): string[] {
  const home = homedir();
  const user =
    os === 'darwin'
      ? join(home, 'Documents', 'OpenSCAD', 'libraries')
      : os === 'win32'
        ? join(env.USERPROFILE ?? home, 'Documents', 'OpenSCAD', 'libraries')
        : join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'OpenSCAD', 'libraries');
  const dirs = [join(dataDir, 'openscad', 'libraries'), user];
  for (const d of (env.OPENSCADPATH ?? '').split(delimiter).filter(Boolean)) dirs.push(d);
  if (os === 'linux') dirs.push('/usr/share/openscad/libraries');
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

/** The libraries installed in those folders, by their folder name (BOSL2, MCAD, NopSCADlib…). */
export function listLibraries(dirs: string[]): ScadLibrary[] {
  const out: ScadLibrary[] = [];
  for (const dir of dirs)
    try {
      for (const d of readdirSync(dir, { withFileTypes: true }))
        if (d.isDirectory() && !d.name.startsWith('.') && !out.some((l) => l.name === d.name))
          out.push({ name: d.name, dir: join(dir, d.name) });
    } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Reading source before it runs ─────────────────────────────────────────────────────────────────────────────

type Tok =
  | { t: 'id'; v: string; line: number }
  | { t: 'num'; v: string; line: number }
  | { t: 'str'; v: string; raw: string; line: number }
  | { t: 'inc'; kw: 'include' | 'use'; v: string; closed: boolean; line: number }
  | { t: 'p'; v: string; line: number };

const NUM = /\d*\.\d+(?:[eE][+-]?\d+)?|\d+\.\d*(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?/y;
const ID = /\$?[A-Za-z0-9_]+/y;
/** As OpenSCAD's lexer (lexer.l) starts an include or use: the word, then spaces, tabs, line breaks or `>`, then `<`. */
const INC = /(include|use)[ \t\r\n>]*</y;
const matchAt = (re: RegExp, src: string, i: number) => {
  re.lastIndex = i;
  return re.exec(src);
};

/**
 * OpenSCAD's tokens as its own lexer cuts them, enough to find every file it would open: comments dropped, strings
 * kept whole, and the longest match winning between a number, a name and an include, as flex does. So `1.5include<x>`
 * is a number and an include, and `x_include<y` is a name.
 */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const lines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src[k] === '\n') line++;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      lines(i, stop);
      i = stop;
    } else if (c === '"') {
      const at = line;
      let j = i + 1;
      let raw = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          raw += src[j]! + src[j + 1]!;
          j += 2;
        } else raw += src[j++];
      }
      lines(i, j);
      out.push({ t: 'str', v: raw, raw, line: at });
      i = j + 1;
    } else {
      const inc = matchAt(INC, src, i);
      const id = matchAt(ID, src, i);
      const num = /[\d.]/.test(c) ? matchAt(NUM, src, i) : null;
      if (inc && id && id[0] === inc[1]) {
        // An include or use: its path runs to the next `>`, as the lexer reads it.
        const at = line;
        const from = i + inc[0].length;
        const end = src.indexOf('>', from);
        const stop = end < 0 ? n : end;
        lines(i, stop);
        out.push({
          t: 'inc',
          kw: inc[1] as 'include' | 'use',
          v: src.slice(from, stop),
          closed: end >= 0,
          line: at,
        });
        i = stop + 1;
      } else if (id && (!num || id[0].length > num[0].length)) {
        out.push({ t: 'id', v: id[0], line });
        i += id[0].length;
      } else if (num) {
        out.push({ t: 'num', v: num[0], line });
        i += num[0].length;
      } else {
        out.push({ t: 'p', v: c, line });
        i++;
      }
    }
  }
  return out;
}

/** A path inside the round or a library: relative, forward slashes, no `..`, no drive, no escapes, no `~`. */
export function safeRelative(p: string): boolean {
  if (!p || p.length > 300) return false;
  if (/[\\:\0~\t\r\n]/.test(p) || p.startsWith('/') || p.startsWith('-')) return false;
  return !p.split('/').some((s) => s === '..' || s === '.' || s === '');
}

/** Built-ins that read a file by name, besides import() and surface(), in every OpenSCAD there has been. */
const FILE_READERS = /^(import_|dxf_)/;

export interface VetOptions {
  /**
   * Whether includes may reach the libraries on this computer. Only when OpenSCAD runs in a sandbox: library code
   * isn't read here, and a library module could pass a caller's path to import().
   */
  libraries: boolean;
}

/**
 * Checks every file of a round against the rules above. `files` maps each path in the round (forward slashes) to
 * its text. Returns the problems, one line each; none means it may run.
 */
export function vetScad(files: Map<string, string>, opts: VetOptions = { libraries: true }): string[] {
  const problems: string[] = [];
  /** A path as OpenSCAD resolves it from the file that names it: that file's own folder, and nowhere else. */
  const from = (caller: string, p: string) => {
    const dir = posix.dirname(caller);
    return posix.normalize(dir === '.' ? p : `${dir}/${p}`);
  };
  for (const name of files.keys())
    if (/\.scad$/i.test(name) && !name.endsWith('.scad'))
      problems.push(`${name}: name OpenSCAD files with a lowercase .scad.`);
  for (const [name, src] of files) {
    if (!name.endsWith('.scad')) continue;
    const toks = tokenize(src);
    // Every include and use, in a pass of its own, so nothing else in the file can hide one.
    for (const tk of toks) {
      if (tk.t === 'id' && (tk.v === 'include' || tk.v === 'use'))
        problems.push(
          `${name}, line ${tk.line}: write ${tk.v} as ${tk.v} <file.scad>; Hildegard doesn’t take ${tk.v} as a name.`,
        );
      if (tk.t !== 'inc') continue;
      const p = tk.v;
      const where = `${name}, line ${tk.line}: ${tk.kw} <${p.replace(/[\r\n\t]/g, ' ')}>`;
      if (!tk.closed) problems.push(`${where} has no closing >.`);
      else if (!safeRelative(p))
        problems.push(
          `${where} reaches outside the round. Include files the round carries, or a library by its own path (${tk.kw} <BOSL2/std.scad>).`,
        );
      else if (!p.endsWith('.scad'))
        problems.push(`${where}: ${tk.kw} only OpenSCAD files, named .scad. Read data with import().`);
      else if (!files.has(from(name, p)) && !opts.libraries)
        problems.push(
          `${where}: no such file in the round, and libraries can’t be used here, since OpenSCAD can’t be sandboxed on this computer. Send the library’s files with the round, beside the .scad that includes them.`,
        );
    }
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k]!;
      if (tk.t !== 'id') continue;
      if (FILE_READERS.test(tk.v)) {
        problems.push(
          `${name}, line ${tk.line}: ${tk.v} reads files by name; Hildegard runs only import() and surface() for that.`,
        );
        continue;
      }
      const call = toks[k + 1]?.t === 'p' && toks[k + 1]!.v === '(';
      const reader = tk.v === 'import' || tk.v === 'surface';
      if (!call) {
        if (reader)
          problems.push(
            `${name}, line ${tk.line}: ${tk.v} can only be called, with the file as a plain string, such as ${tk.v}("logo.svg").`,
          );
        continue;
      }
      // The arguments, split at top-level commas. Every token is still checked on its own above and below.
      const args: Tok[][] = [[]];
      let depth = 0;
      for (let j = k + 2; j < toks.length; j++) {
        const a = toks[j]!;
        if (a.t === 'p' && '([{'.includes(a.v)) depth++;
        if (a.t === 'p' && ')]}'.includes(a.v)) {
          if (depth === 0) break;
          depth--;
        }
        if (a.t === 'p' && a.v === ',' && depth === 0) args.push([]);
        else args.at(-1)!.push(a);
      }
      const isFile = (a: Tok[]) => a[0]?.t === 'id' && a[0].v === 'file' && a[1]?.v === '=';
      if (!reader) {
        if (args.some(isFile))
          problems.push(
            `${name}, line ${tk.line}: ${tk.v}(file = …) reads a file by name; Hildegard runs only import() and surface() for that.`,
          );
        continue;
      }
      const named = args.filter(isFile);
      const positional = args.filter((a) => a.length && !(a[0]?.t === 'id' && a[1]?.v === '='));
      if (named.length + (positional.length ? 1 : 0) !== 1) {
        problems.push(
          `${name}, line ${tk.line}: give ${tk.v} its file once, as the first argument or as file = "…", not both.`,
        );
        continue;
      }
      const fileArg = named.length ? named[0]!.slice(2) : positional[0]!;
      const lit = fileArg.length === 1 && fileArg[0]!.t === 'str' ? fileArg[0]!.v : null;
      if (lit === null)
        problems.push(
          `${name}, line ${tk.line}: ${tk.v} needs the file as a plain string, such as ${tk.v}("logo.svg"), not a variable or an expression.`,
        );
      else if (!safeRelative(lit) || !files.has(from(name, lit)))
        problems.push(
          `${name}, line ${tk.line}: ${tk.v}("${lit}") must name a file sent with this round, beside the .scad that reads it or in a folder under it.`,
        );
      // Its other strings are layer and id names: none may look like a path.
      const own = new Set(fileArg);
      for (const a of args)
        for (const x of a)
          if (!own.has(x) && x.t === 'str' && /[/\\:~]|\.\./.test(x.v))
            problems.push(`${name}, line ${x.line}: ${tk.v} takes one file; “${x.v}” looks like another.`);
    }
  }
  return problems;
}

/** The round's main file: main.scad, or the one .scad file at the top of the round. */
export function mainScad(names: string[]): string {
  const top = names.filter((n) => n.endsWith('.scad') && !n.includes('/') && !n.startsWith('-'));
  if (top.includes('main.scad')) return 'main.scad';
  if (top.length === 1) return top[0]!;
  if (!names.some((n) => n.endsWith('.scad')))
    throw new ScadError('That ZIP has no .scad file in it. Send OpenSCAD source, or a model as GLB or STL.');
  throw new ScadError(
    `Say which file to render: name it main.scad. The round has ${top.length ? top.join(', ') : 'no .scad file at its top'}.`,
  );
}

/** Reads OpenSCAD's own words for what went wrong, and what it echoed and warned. */
export function readLog(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  return {
    errors: lines.filter((l) => /^ERROR:/.test(l)).map((l) => l.replace(/^ERROR:\s*/, '')),
    warnings: lines.filter((l) => /^WARNING:/.test(l)).map((l) => l.replace(/^WARNING:\s*/, '')),
    echo: lines.filter((l) => /^ECHO:/.test(l)).map((l) => l.replace(/^ECHO:\s*/, '')),
    empty: lines.some((l) => /top level object is empty/i.test(l)),
    notSolid: lines.some((l) => /top level object is a 2D object/i.test(l)),
  };
}

export interface ScadRender {
  /** The mesh, as binary STL. */
  out: string;
  seconds: number;
  version: string;
  engine: 'Manifold' | 'CGAL';
  warnings: string[];
  echo: string[];
}

/** Rendered meshes Hildegard reads back: the most a model loop takes as a file. */
export const MAX_MESH_BYTES = 256 * 1024 * 1024;

/** Seconds a round may render for, from HILDEGARD_OPENSCAD_TIMEOUT: a number of seconds above 0, or 180. */
export function scadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HILDEGARD_OPENSCAD_TIMEOUT?.trim();
  const s = raw ? Number(raw) : Number.NaN;
  return (Number.isFinite(s) && s > 0 ? Math.min(s, 3600) : 180) * 1000;
}

/** Only what OpenSCAD needs from Hildegard's environment: never anything else, so no secret can reach it. */
export function scadEnv(env: NodeJS.ProcessEnv, libraries: string[], os = platform()): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|LANG|LC_\w+|TMPDIR|FONTCONFIG_\w+|XDG_\w+)$/;
  const win = /^(SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PATHEXT|COMSPEC)$/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k) || (os === 'win32' && win.test(k))) out[k] = v;
  out.OPENSCADPATH = libraries.join(delimiter);
  return out;
}

// ── The sandbox ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Sandbox {
  kind: 'sandbox-exec' | 'bwrap';
  /** The program to run and its arguments, wrapping OpenSCAD's. */
  wrap: (cmd: string, args: string[]) => { cmd: string; args: string[] };
}

export interface SandboxPlan {
  /** The round's own folder: the one place OpenSCAD writes. */
  round: string;
  /** Read only: the library folders, and OpenSCAD itself when it lives among hidden files. */
  read: string[];
  /** Hidden: the owner's home folder and Hildegard's data, apart from the folders above. */
  hide: string[];
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const sbString = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The macOS sandbox profile: no network, nothing read or written in the hidden folders but the round and libraries. */
export function seatbeltProfile(plan: SandboxPlan, tmp = tmpdir()): string {
  const round = real(plan.round);
  const read = plan.read.map(real);
  const hide = plan.hide.map(real);
  const fonts = join(homedir(), 'Library', 'Fonts');
  // Looking up an allowed folder stats each folder above it, so those, and only those, may be looked at.
  const above = new Set<string>();
  for (const p of [round, ...read, real(fonts)])
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) above.add(d);
  // The last rule that matches wins, so each line narrows or reopens what the lines above it said.
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath ${sbString(real(tmp))}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    ...(hide.length
      ? [`(deny file-read* file-write* ${hide.map((p) => `(subpath ${sbString(p)})`).join(' ')})`]
      : []),
    ...(above.size
      ? [`(allow file-read-metadata ${[...above].map((p) => `(literal ${sbString(p)})`).join(' ')})`]
      : []),
    `(allow file-read* ${[...read, real(fonts)].map((p) => `(subpath ${sbString(p)})`).join(' ')})`,
    `(allow file-read* file-write* (subpath ${sbString(round)}))`,
  ].join('\n');
}

/** bubblewrap's arguments: the system read only, a fresh home and data folder, the round writable, no network. */
export function bwrapArgs(plan: SandboxPlan): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const h of plan.hide) args.push('--tmpfs', h);
  for (const r of plan.read) args.push('--ro-bind', r, r);
  args.push(
    '--bind',
    plan.round,
    plan.round,
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--chdir',
    plan.round,
  );
  return args;
}

let bwrapWorks: boolean | null = null;

/**
 * How OpenSCAD runs sandboxed on this computer: sandbox-exec on macOS, bubblewrap on Linux when it's installed and
 * the kernel lets it make namespaces. Null where neither works (Windows, Linux without bubblewrap): then libraries are
 * off, and only a round's own vetted files run.
 */
export function findSandbox(plan: SandboxPlan, os = platform()): Sandbox | null {
  if (os === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const profile = seatbeltProfile(plan);
    return {
      kind: 'sandbox-exec',
      wrap: (cmd, args) => ({ cmd: '/usr/bin/sandbox-exec', args: ['-p', profile, cmd, ...args] }),
    };
  }
  if (os === 'linux') {
    if (bwrapWorks === null) {
      const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-net', '--die-with-parent', 'true'], {
        timeout: 10_000,
        stdio: 'ignore',
      });
      bwrapWorks = !r.error && r.status === 0;
    }
    if (bwrapWorks)
      return {
        kind: 'bwrap',
        wrap: (cmd, args) => ({ cmd: 'bwrap', args: [...bwrapArgs(plan), cmd, ...args] }),
      };
  }
  return null;
}

/** The folder OpenSCAD's own files are in: its .app bundle on macOS, or the folder of the program. */
export function installDir(path: string): string {
  const app = /^(.*?\.app)(?:[\\/]|$)/.exec(path);
  return app ? app[1]! : dirname(path);
}

/** The sandbox OpenSCAD runs in on this computer, or null. */
export function sandboxKind(os = platform()): Sandbox['kind'] | null {
  return findSandbox({ round: tmpdir(), read: [], hide: [] }, os)?.kind ?? null;
}

/** Whether a sandbox is there to run OpenSCAD in, so includes may reach libraries. */
export function canSandbox(os = platform()): boolean {
  return sandboxKind(os) !== null;
}

// ── Running it ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Paths in what OpenSCAD says are this computer's: the round's own become round-relative, a library's become
 * `<library>/…`, and any other becomes `<path>`.
 */
export function scrubPaths(text: string, round: string, libraries: string[]): string {
  const roots = [
    ...[round, real(round)].map((r) => ({ from: r, to: '' })),
    ...libraries.flatMap((l) => [l, real(l)].map((r) => ({ from: r, to: '<library>/' }))),
  ].sort((a, b) => b.from.length - a.from.length);
  const name = (p: string) => {
    const abs = resolve(round, p);
    for (const r of roots) {
      const rel = relative(r.from, abs);
      if (!rel.startsWith('..') && !isAbsolute(rel)) return `${r.to}${rel.split(sep).join('/')}` || '.';
    }
    return '<path>';
  };
  return text
    .replace(/(?<![\w.\-/\\])(?:[A-Za-z]:[\\/]|\/|(?:\.\.[\\/])+)[^\s"'<>,;)]*/g, (m) => name(m))
    .replace(/"<path>"/g, '<path>');
}

/** One OpenSCAD at a time on this computer: renders wait their turn rather than share the CPU and memory. */
let queue: Promise<void> = Promise.resolve();
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  const prev = queue;
  let done!: () => void;
  queue = new Promise<void>((r) => {
    done = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    done();
  }
}

/**
 * Renders `main` in `dir` (the round's own folder) to `out` as binary STL, in the sandbox when this computer has one.
 * Throws ScadError with OpenSCAD's message when it can't: a syntax error, an empty or flat result, too big, or not done
 * by `deadline` (milliseconds since the epoch).
 */
export function renderScad(
  scad: OpenScad,
  dir: string,
  main: string,
  out: string,
  libraries: string[],
  opts: {
    part?: string;
    deadline?: number;
    sandbox?: Sandbox | null;
    hide?: string[];
    maxBytes?: number;
  } = {},
): Promise<ScadRender> {
  if (opts.part !== undefined && !PART.test(opts.part))
    return Promise.reject(new ScadError(`“${opts.part}” isn’t a part name.`));
  if (!safeRelative(main) || main.includes('/'))
    return Promise.reject(new ScadError(`“${main}” can’t be the main file.`));
  const deadline = opts.deadline ?? Date.now() + scadTimeoutMs();
  const scrub = (t: string) => scrubPaths(t, dir, libraries);
  return slot(
    () =>
      new Promise<ScadRender>((resolvePromise, reject) => {
        const timeoutMs = deadline - Date.now();
        const limit = Math.round(scadTimeoutMs() / 1000);
        const tooLong = () =>
          new ScadError(
            `OpenSCAD took longer than the round’s ${limit} s. Lower $fn while blocking out, avoid minkowski() and hull() over many children, and render one part at a time.`,
          );
        if (timeoutMs <= 0) return reject(tooLong());
        const args = [
          ...scad.manifoldArgs,
          ...(opts.part !== undefined ? ['-D', `part="${opts.part}"`] : []),
          '-o',
          out,
          '--export-format',
          'binstl',
          // `./`, so a file's name is never read as an option.
          `./${main}`,
        ];
        const sandbox =
          opts.sandbox === undefined
            ? findSandbox({
                round: dir,
                read: [...libraries, installDir(scad.path)],
                hide: opts.hide ?? [homedir()],
              })
            : opts.sandbox;
        const run = sandbox ? sandbox.wrap(scad.path, args) : { cmd: scad.path, args };
        const started = Date.now();
        const windows = platform() === 'win32';
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(run.cmd, run.args, {
            cwd: dir,
            env: scadEnv(process.env, libraries),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // Its own process group, so a timeout stops everything it started.
            detached: !windows,
          });
        } catch (e) {
          return reject(new ScadError(`Couldn’t run OpenSCAD: ${scrub((e as Error).message)}`));
        }
        let text = '';
        const keep = (d: Buffer) => {
          text = (text + d.toString()).slice(-200_000);
        };
        child.stdout?.on('data', keep);
        child.stderr?.on('data', keep);
        let settled = false;
        const settle = (f: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          f();
        };
        const killAll = () => {
          try {
            if (!windows && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const timer = setTimeout(() => {
          killAll();
          const log = readLog(scrub(text));
          // Settle now: a program it started may hold its output open, and 'close' never come.
          settle(() =>
            reject(Object.assign(tooLong(), { log: [...log.errors, ...log.warnings].slice(0, 20) })),
          );
        }, timeoutMs);
        child.once('error', (e) =>
          settle(() => reject(new ScadError(`Couldn’t run OpenSCAD: ${scrub(e.message)}`))),
        );
        child.once('close', (code) =>
          settle(() => {
            const log = readLog(scrub(text));
            const tail = [...log.errors, ...log.warnings].slice(0, 20);
            if (log.notSolid)
              return reject(
                new ScadError(
                  'The model is 2D. Extrude it (linear_extrude or rotate_extrude) to make a solid.',
                  tail,
                ),
              );
            if (log.empty)
              return reject(
                new ScadError(
                  'The model is empty: nothing is drawn at the top level (a module defined but never called, or a difference() that removes everything).',
                  tail,
                ),
              );
            const size = existsSync(out) ? statSync(out).size : 0;
            if (code !== 0 || log.errors.length || size < 84)
              return reject(
                new ScadError(
                  log.errors.length
                    ? `OpenSCAD stopped: ${log.errors.slice(0, 5).join(' | ')}`
                    : `OpenSCAD stopped (exit ${code}): ${scrub(text).trim().split('\n').slice(-3).join(' | ').slice(0, 600)}`,
                  tail,
                ),
              );
            const cap = opts.maxBytes ?? MAX_MESH_BYTES;
            if (size > cap)
              return reject(
                new ScadError(
                  `The mesh came out at ${Math.round(size / 1024 / 1024)} MB, over ${Math.round(cap / 1024 / 1024)} MB. Lower $fn, or simplify curved surfaces.`,
                  tail,
                ),
              );
            resolvePromise({
              out,
              seconds: Math.round((Date.now() - started) / 100) / 10,
              version: scad.version,
              engine: usesManifold(scad) ? 'Manifold' : 'CGAL',
              warnings: log.warnings.slice(0, 30),
              echo: log.echo.slice(0, 50),
            });
          }),
        );
      }),
  );
}

/** Whether renders use Manifold: asked for, or a snapshot from 17 August 2025 on, where it is the default. */
export function usesManifold(scad: Pick<OpenScad, 'manifold' | 'version'>): boolean {
  if (scad.manifold) return true;
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(scad.version);
  return !!m && `${m[1]}${m[2]}${m[3]}` >= '20250817';
}

const PART = /^[A-Za-z0-9_-]{1,60}$/;

/**
 * The parts a model names at its top level, as `parts = ["lid", "box"];`, for a print whose parts fit together. Each
 * is rendered on its own with `part` set to its name (`-D part="lid"`), and the model draws only that part when
 * `part` names it (and every part when `part` is "all" or unset). Null when the model names no parts.
 */
export function declaredParts(src: string): string[] | null {
  const t = tokenize(src);
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const a = t[k]!;
    if (a.t === 'p' && (a.v === '{' || a.v === '(')) depth++;
    if (a.t === 'p' && (a.v === '}' || a.v === ')')) depth--;
    if (depth !== 0 || a.t !== 'id' || a.v !== 'parts' || t[k + 1]?.v !== '=' || t[k + 2]?.v !== '[')
      continue;
    const names: string[] = [];
    let j = k + 3;
    for (; j < t.length; j++) {
      const b = t[j]!;
      if (b.t === 'str') names.push(b.v);
      else if (b.t === 'p' && b.v === ',') continue;
      else break;
    }
    if (t[j]?.v !== ']') throw new ScadError('Write parts as a list of plain names: parts = ["lid", "box"];');
    const bad = names.filter((x) => !PART.test(x));
    if (bad.length) throw new ScadError(`Part names are letters, digits, - and _: not ${bad.join(', ')}.`);
    if (new Set(names).size !== names.length) throw new ScadError('Each part needs its own name.');
    if (names.length > 20) throw new ScadError('Up to 20 parts.');
    return names.length ? names : null;
  }
  return null;
}

/**
 * Named binary STL meshes (their paths) as one OBJ at `out`, one `o` object per part, as review_mesh.py reads parts.
 * Written a part at a time, so a big mesh never sits in memory as one string.
 */
export function writePartsObj(
  out: string,
  parts: { name: string; stl: string }[],
  maxBytes = MAX_MESH_BYTES,
): number {
  let total = 0;
  for (const p of parts) total += statSync(p.stl).size;
  if (total > maxBytes)
    throw new ScadError(
      `The parts came out at ${Math.round(total / 1024 / 1024)} MB together, over ${Math.round(maxBytes / 1024 / 1024)} MB. Lower $fn, or simplify curved surfaces.`,
    );
  const fd = openSync(out, 'w');
  try {
    writeSync(fd, '# Rendered by Hildegard with OpenSCAD, one object per part\n');
    let base = 1;
    for (const p of parts) {
      const stl = readFileSync(p.stl);
      const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
      const n = stl.byteLength >= 84 ? dv.getUint32(80, true) : -1;
      if (n < 0 || 84 + n * 50 !== stl.byteLength)
        throw new ScadError(`OpenSCAD wrote part ${p.name} as a broken STL.`);
      writeSync(fd, `o ${p.name}\n`);
      const CHUNK = 20_000;
      for (let from = 0; from < n; from += CHUNK) {
        let chunk = '';
        for (let i = from; i < Math.min(n, from + CHUNK); i++) {
          const at = 84 + i * 50 + 12;
          for (let v = 0; v < 3; v++)
            chunk += `v ${dv.getFloat32(at + v * 12, true)} ${dv.getFloat32(at + v * 12 + 4, true)} ${dv.getFloat32(at + v * 12 + 8, true)}\n`;
        }
        writeSync(fd, chunk);
      }
      for (let from = 0; from < n; from += CHUNK) {
        let chunk = '';
        for (let i = from; i < Math.min(n, from + CHUNK); i++) {
          const b = base + i * 3;
          chunk += `f ${b} ${b + 1} ${b + 2}\n`;
        }
        writeSync(fd, chunk);
      }
      base += n * 3;
    }
  } finally {
    closeSync(fd);
  }
  return statSync(out).size;
}

/** Reads a round's files as text, for vetScad; binary files (meshes, images) are kept by name with no text. */
export function readRound(dir: string, names: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of names) m.set(n, n.endsWith('.scad') ? readFileSync(join(dir, n), 'utf8') : '');
  return m;
}

/** True when text looks like OpenSCAD source rather than another format or prose. */
export function looksLikeScad(head: string): boolean {
  if (head.includes('\0')) return false;
  const code = head.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  return (
    /\b(include|use)\s*<[^>\n]+>/.test(code) ||
    /\b(module|function)\s+\w+\s*\(/.test(code) ||
    /\b(cube|sphere|cylinder|polyhedron|polygon|circle|square|linear_extrude|rotate_extrude|translate|rotate|scale|mirror|difference|union|intersection|hull|minkowski|offset|text|color)\s*\(/.test(
      code,
    )
  );
}
