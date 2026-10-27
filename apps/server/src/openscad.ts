// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenSCAD: code-CAD that an agent writes as text and Hildegard renders into a mesh, so a model loop can take the
 * source itself and every round stays a small, named edit to one parametric file. OpenSCAD is a separate program
 * (GPL-2.0-or-later) that Hildegard finds on this computer and runs; it is never linked or shipped with Hildegard.
 *
 * Source from an agent is untrusted, and OpenSCAD can read other files: `include <…>` and `use <…>` take any path,
 * and `import()`, `surface()` and older built-ins read meshes, images and data. So two walls stand in front of it.
 *
 * First, every .scad file of a round is read here, cut into tokens as OpenSCAD's own lexer cuts them, in one pass,
 * and held to these rules: an include or use names a .scad file by a relative path (never absolute, never `..`), from
 * the folder of the file that names it, inside the round or (only in a sandbox) a library; an import or surface names
 * one plain string, a file the round itself carries (a data file only in a sandbox, since OpenSCAD's parsers for
 * meshes and images run on what the agent sent); and no other built-in may read a file by name.
 *
 * Second, OpenSCAD runs sandboxed where this computer can (sandbox-exec on macOS, bubblewrap on Linux): no network; it
 * reads only the system, its own files, fonts, the libraries and the round; and it writes only in the round, through
 * its own private home and temp folder there. Hildegard moves the mesh out. Without a sandbox, a round is .scad files of
 * its own and nothing else. Either way it runs one render at a time, its files capped in size (and on Linux its memory),
 * with one time budget for the round, counted while it runs, an environment of only what it needs, and its whole
 * process tree stopped at the deadline. What it says comes back with this computer's paths taken out.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir, platform, tmpdir, totalmem } from 'node:os';
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
   * Whether OpenSCAD runs sandboxed here. Only then may a round include libraries (their code isn't read here, and a
   * library module could pass a caller's path to a file reader) or import data files (an STL, DXF, SVG or image goes
   * through OpenSCAD's parsers for them, which have had memory bugs). Unsandboxed, a round is .scad files only.
   */
  sandboxed: boolean;
}

/** Most source a round may hold, and the deepest nesting, so reading it stays quick and linear. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TOKENS = 1_000_000;
const MAX_DEPTH = 256;

/**
 * Checks every file of a round against the rules above. `files` maps each path in the round (forward slashes) to
 * its text. Returns the problems, one line each; none means it may run. One pass over each file's tokens.
 */
export function vetScad(files: Map<string, string>, opts: VetOptions): string[] {
  const problems: string[] = [];
  /** A path as OpenSCAD resolves it from the file that names it: that file's own folder, and nowhere else. */
  const from = (caller: string, p: string) => {
    const dir = posix.dirname(caller);
    return posix.normalize(dir === '.' ? p : `${dir}/${p}`);
  };
  let size = 0;
  for (const [name, src] of files) {
    if (/\.scad$/i.test(name) && !name.endsWith('.scad'))
      problems.push(`${name}: name OpenSCAD files with a lowercase .scad.`);
    if (name.endsWith('.scad')) size += src.length;
  }
  if (size > MAX_SOURCE_BYTES)
    return [`The round’s OpenSCAD source is over ${MAX_SOURCE_BYTES / 1024 / 1024} MB. Send less.`];
  for (const [name, src] of files) {
    if (!name.endsWith('.scad')) continue;
    const toks = tokenize(src);
    if (toks.length > MAX_TOKENS) {
      problems.push(`${name}: too long to read. Split it into smaller files.`);
      continue;
    }
    /** Open brackets, innermost last; a call's records the function or module it calls, and import's its arguments. */
    const stack: Array<{ callee: string | null; args: Tok[][] | null; line: number }> = [];
    const reader = (v: string) => v === 'import' || v === 'surface';
    const close = (f: { callee: string | null; args: Tok[][] | null; line: number }) => {
      if (!f.args || !f.callee) return;
      const isFile = (a: Tok[]) => a[0]?.t === 'id' && a[0].v === 'file' && a[1]?.v === '=';
      const named = f.args.filter(isFile);
      const positional = f.args.filter((a) => a.length && !(a[0]?.t === 'id' && a[1]?.v === '='));
      if (named.length + (positional.length ? 1 : 0) !== 1) {
        problems.push(
          `${name}, line ${f.line}: give ${f.callee} its file once, as the first argument or as file = "…", not both.`,
        );
        return;
      }
      const fileArg = named.length ? named[0]!.slice(2) : positional[0]!;
      const lit = fileArg.length === 1 && fileArg[0]!.t === 'str' ? fileArg[0]!.v : null;
      if (lit === null)
        problems.push(
          `${name}, line ${f.line}: ${f.callee} needs the file as a plain string, such as ${f.callee}("logo.svg"), not a variable or an expression.`,
        );
      else if (!safeRelative(lit) || !files.has(from(name, lit)))
        problems.push(
          `${name}, line ${f.line}: ${f.callee}("${lit}") must name a file sent with this round, beside the .scad that reads it or in a folder under it.`,
        );
      else if (!opts.sandboxed && !lit.endsWith('.scad'))
        problems.push(
          `${name}, line ${f.line}: ${f.callee}("${lit}") reads a data file, which Hildegard does only where OpenSCAD runs sandboxed, and it can’t be here. Model it in OpenSCAD instead, or export the mesh yourself and send that.`,
        );
      // Its other strings are layer and id names: none may look like a path.
      const own = new Set(fileArg);
      for (const arg of f.args)
        for (const x of arg)
          if (!own.has(x) && x.t === 'str' && /[/\\:~]|\.\./.test(x.v))
            problems.push(
              `${name}, line ${x.line}: ${f.callee} takes one file; “${x.v}” looks like another.`,
            );
    };
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k]!;
      const prev = toks[k - 1];
      if (tk.t === 'inc') {
        const p = tk.v;
        const where = `${name}, line ${tk.line}: ${tk.kw} <${p.replace(/[\r\n\t]/g, ' ')}>`;
        if (!tk.closed) problems.push(`${where} has no closing >.`);
        else if (!safeRelative(p))
          problems.push(
            `${where} reaches outside the round. Include files the round carries, or a library by its own path (${tk.kw} <BOSL2/std.scad>).`,
          );
        else if (!p.endsWith('.scad'))
          problems.push(`${where}: ${tk.kw} only OpenSCAD files, named .scad. Read data with import().`);
        else if (!files.has(from(name, p)) && !opts.sandboxed)
          problems.push(
            `${where}: no such file in the round, and libraries can’t be used here, since OpenSCAD can’t be sandboxed on this computer. Send the library’s files with the round, beside the .scad that includes them.`,
          );
      } else if (tk.t === 'id') {
        if (tk.v === 'include' || tk.v === 'use')
          problems.push(
            `${name}, line ${tk.line}: write ${tk.v} as ${tk.v} <file.scad>; Hildegard doesn’t take ${tk.v} as a name.`,
          );
        else if (FILE_READERS.test(tk.v))
          problems.push(
            `${name}, line ${tk.line}: ${tk.v} reads files by name; Hildegard runs only import() and surface() for that.`,
          );
        else if (reader(tk.v) && !(toks[k + 1]?.t === 'p' && toks[k + 1]!.v === '('))
          problems.push(
            `${name}, line ${tk.line}: ${tk.v} can only be called, with the file as a plain string, such as ${tk.v}("logo.svg").`,
          );
        else if (
          tk.v === 'file' &&
          toks[k + 1]?.v === '=' &&
          prev?.t === 'p' &&
          (prev.v === '(' || prev.v === ',')
        ) {
          const f = stack.at(-1);
          if (f && f.callee !== null && !reader(f.callee) && !FILE_READERS.test(f.callee))
            problems.push(
              `${name}, line ${tk.line}: ${f.callee}(file = …) reads a file by name; Hildegard runs only import() and surface() for that.`,
            );
        }
      }
      // Brackets: every token inside an import's or surface's own brackets goes to its arguments, split at its commas.
      const open = tk.t === 'p' && '([{'.includes(tk.v);
      const shut = tk.t === 'p' && ')]}'.includes(tk.v);
      if (!open && !shut && !(tk.t === 'p' && tk.v === ',' && stack.at(-1)?.args)) {
        for (const f of stack) if (f.args) f.args.at(-1)!.push(tk);
      } else if (tk.t === 'p' && tk.v === ',') {
        const top = stack.at(-1)!;
        for (const f of stack) if (f.args && f !== top) f.args.at(-1)!.push(tk);
        top.args!.push([]);
      }
      if (open) {
        for (const f of stack) if (f.args) f.args.at(-1)!.push(tk);
        if (stack.length >= MAX_DEPTH) {
          problems.push(`${name}, line ${tk.line}: brackets nested deeper than ${MAX_DEPTH}.`);
          break;
        }
        const callee = tk.v === '(' && prev?.t === 'id' ? prev.v : null;
        stack.push({ callee, args: callee && reader(callee) ? [[]] : null, line: prev?.line ?? tk.line });
      } else if (shut) {
        const f = stack.pop();
        if (f) close(f);
        for (const g of stack) if (g.args) g.args.at(-1)!.push(tk);
      }
    }
    // An import left open at the end of the file is still checked.
    for (const f of stack.reverse()) close(f);
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

/**
 * Only what OpenSCAD needs from Hildegard's environment, never anything else, so no secret can reach it. In a sandbox
 * its home and temp folder are `private`, a folder in the round, since the real ones are hidden from it.
 */
export function scadEnv(
  env: NodeJS.ProcessEnv,
  libraries: string[],
  os = platform(),
  private_?: string,
): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|LANG|LC_\w+|TMPDIR|FONTCONFIG_\w+|XDG_\w+)$/;
  const win = /^(SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PATHEXT|COMSPEC)$/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k) || (os === 'win32' && win.test(k))) out[k] = v;
  out.OPENSCADPATH = libraries.join(delimiter);
  if (private_) {
    for (const k of Object.keys(out)) if (k.startsWith('XDG_')) delete out[k];
    out.HOME = private_;
    out.TMPDIR = private_;
  }
  return out;
}

// ── The sandbox ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Sandbox {
  kind: 'sandbox-exec' | 'bwrap';
  /** The program to run and its arguments, wrapping OpenSCAD's. */
  wrap: (cmd: string, args: string[]) => { cmd: string; args: string[] };
}

export interface SandboxPlan {
  /** The round's own folder: the one place OpenSCAD reads and writes as it likes. */
  round: string;
  /** Read only: the library folders, and OpenSCAD's own files. */
  read: string[];
  /** Never even looked at: the owner's home and Hildegard's data, apart from the folders above. */
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
const within = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** What macOS's own programs and libraries need to read, and nothing of anyone's. */
const MAC_SYSTEM = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library/Fonts',
  '/Library/Apple/System',
  '/private/var/db/timezone',
  '/private/var/db/dyld',
  '/private/var/select',
  '/dev',
];

/**
 * The macOS sandbox profile: no network; reads only of the system, OpenSCAD's own files, fonts, the libraries and the
 * round; writes only in the round. The last rule that matches wins, so each line narrows or reopens the ones above.
 */
export function seatbeltProfile(plan: SandboxPlan): string {
  const round = real(plan.round);
  const read = plan.read.map(real);
  const hide = plan.hide.map(real);
  const fonts = real(join(homedir(), 'Library', 'Fonts'));
  const sub = (ps: string[]) => ps.map((p) => `(subpath ${sbString(p)})`).join(' ');
  // Looking up an allowed folder stats each folder above it, so those, and only those, may be looked at in the hidden.
  const above = new Set<string>();
  for (const p of [round, ...read, fonts])
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) above.add(d);
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-read*)',
    '(allow file-read-metadata)',
    ...(hide.length ? [`(deny file-read-metadata ${sub(hide)})`] : []),
    ...(above.size
      ? [`(allow file-read-metadata ${[...above].map((p) => `(literal ${sbString(p)})`).join(' ')})`]
      : []),
    `(allow file-read* ${sub([...MAC_SYSTEM, ...read, fonts])} (literal "/") (literal "/private/etc/localtime"))`,
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    `(allow file-read* file-write* ${sub([round])})`,
  ].join('\n');
}

/** What Linux programs need beyond /usr to start and draw text, and nothing else. */
const LINUX_ETC = [
  '/var/cache/fontconfig',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/alternatives',
  '/etc/fonts',
  '/etc/localtime',
  '/etc/xdg',
];

/**
 * bubblewrap's arguments: an empty, read-only root holding only the system's programs and libraries, fonts, the
 * libraries and OpenSCAD; the round writable, and its private folder as /tmp; no network, no other processes.
 */
export function bwrapArgs(plan: SandboxPlan, lstat: (p: string) => 'dir' | 'link' | null = kindOf): string[] {
  const args: string[] = ['--ro-bind', '/usr', '/usr'];
  for (const d of ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32']) {
    const k = lstat(d);
    if (k === 'link') args.push('--symlink', readlinkOr(d), d);
    else if (k === 'dir') args.push('--ro-bind', d, d);
  }
  for (const e of LINUX_ETC) args.push('--ro-bind-try', e, e);
  args.push('--dev', '/dev', '--proc', '/proc');
  for (const r of plan.read) args.push('--ro-bind-try', r, r);
  const priv = join(plan.round, PRIVATE);
  args.push(
    '--bind',
    plan.round,
    plan.round,
    '--bind',
    priv,
    '/tmp',
    '--remount-ro',
    '/',
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--chdir',
    plan.round,
  );
  return args;
}
function kindOf(p: string): 'dir' | 'link' | null {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}
function readlinkOr(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return p;
  }
}

/** The round's private folder: OpenSCAD's home and temp folder in the sandbox. */
const PRIVATE = '.openscad-home';

let bwrapWorks: boolean | null = null;

/**
 * How OpenSCAD runs sandboxed on this computer: sandbox-exec on macOS, bubblewrap on Linux when it's installed and
 * the kernel lets it make namespaces. Null where neither works (Windows, Linux without bubblewrap), and for an
 * OpenSCAD whose own files sit in a hidden folder outside an app bundle, or an AppImage: then a round may only be
 * .scad files of its own.
 */
export function findSandbox(plan: SandboxPlan, os = platform()): Sandbox | null {
  for (const r of plan.read) if (/\.appimage$/i.test(r)) return null;
  if (os === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const profile = seatbeltProfile(plan);
    return {
      kind: 'sandbox-exec',
      wrap: (cmd, args) => ({ cmd: '/usr/bin/sandbox-exec', args: ['-p', profile, cmd, ...args] }),
    };
  }
  if (os === 'linux') {
    if (bwrapWorks === null) {
      const dir = mkdtempSync(join(tmpdir(), 'hg-bwrap-'));
      mkdirSync(join(dir, PRIVATE));
      const r = spawnSync('bwrap', [...bwrapArgs({ round: dir, read: [], hide: [] }), 'true'], {
        timeout: 10_000,
        stdio: 'ignore',
      });
      rmSync(dir, { recursive: true, force: true });
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

/**
 * OpenSCAD's own files, for the sandbox to read: its real .app bundle on macOS; nothing more for a system install
 * (/usr, which the sandbox reads anyway); otherwise its real folder. Null when it can't be sandboxed: an AppImage, or a
 * program in a hidden folder (~/bin, ~/Downloads) outside a bundle, since reopening that folder would show the owner's
 * files. Then it runs without one, and a round may only be .scad files of its own.
 */
export function ownFiles(path: string, hide: string[] = [homedir()]): string[] | null {
  const p = real(path);
  if (/\.appimage$/i.test(p)) return null;
  const app = /^(.*?\.app)(?:[\\/]|$)/.exec(p);
  if (app) return [app[1]!];
  if (['/usr', '/bin', '/sbin'].some((d) => within(p, d))) return [];
  if (hide.some((h) => within(p, real(h)))) return null;
  return [dirname(p)];
}

/** The sandbox OpenSCAD at `scadPath` would run in on this computer, or null. */
export function sandboxKind(
  scadPath: string,
  hide: string[] = [homedir()],
  os = platform(),
): Sandbox['kind'] | null {
  const own = ownFiles(scadPath, hide);
  return own ? (findSandbox({ round: tmpdir(), read: own, hide: [] }, os)?.kind ?? null) : null;
}

/** Whether OpenSCAD runs sandboxed here, so a round may include libraries and import data files. */
export function canSandbox(scadPath: string, hide?: string[], os = platform()): boolean {
  return sandboxKind(scadPath, hide, os) !== null;
}

// ── Running it ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Paths in what OpenSCAD says are this computer's: the round's own become round-relative, a library's become
 * `<library>/…`, and any other becomes `<path>`. Known folders are replaced as written first, so a space in one
 * doesn't leave half of it.
 */
export function scrubPaths(
  text: string,
  round: string,
  libraries: string[],
  hidden: string[] = [homedir()],
): string {
  const roots = [
    ...[round, real(round)].map((r) => ({ from: r, to: '' })),
    ...libraries.flatMap((l) => [l, real(l)].map((r) => ({ from: r, to: '<library>' }))),
    ...hidden.flatMap((h) => [h, real(h)].map((r) => ({ from: r, to: '<path>' }))),
  ]
    .filter((r) => r.from.length > 1)
    .sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const r of roots) {
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${esc}(?:[\\\\/]|(?![\\w.-]))`, 'g'), (m) =>
      r.to === '' ? '' : `${r.to}${/[\\/]$/.test(m) ? '/' : ''}`,
    );
  }
  const name = (p: string) => {
    const abs = resolve(round, p);
    for (const r of roots) {
      if (r.to === '<path>') continue;
      const rel = relative(r.from, abs);
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        const tail = rel.split(sep).join('/');
        return r.to ? `${r.to}/${tail}` : tail || '.';
      }
    }
    return '<path>';
  };
  return out
    .replace(/(?<![\w.\-/\\<>])(?:[A-Za-z]:[\\/]|\/|(?:\.\.[\\/])+)[^\s"'<>,;)]*/g, (m) => name(m))
    .replace(/"<path>"/g, '<path>');
}

/** One OpenSCAD at a time on this computer: renders wait their turn rather than share the CPU and memory. */
let queue: Promise<void> = Promise.resolve();
let waiting = 0;
/** Renders that may wait for their turn; more are turned away as busy. */
export const MAX_WAITING = 6;
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (waiting >= MAX_WAITING)
    throw new ScadError(
      'OpenSCAD is busy with other rounds on this computer. Send this one again in a few minutes.',
    );
  waiting++;
  const prev = queue;
  let done!: () => void;
  queue = new Promise<void>((r) => {
    done = r;
  });
  try {
    await prev;
  } finally {
    waiting--;
  }
  try {
    return await fn();
  } finally {
    done();
  }
}

/** A round's time: every render of it takes from the same budget, counted only while OpenSCAD runs. */
export interface ScadBudget {
  ms: number;
}

/**
 * Renders `main` in `dir` (the round's own folder) to `out` as binary STL, in the sandbox when this computer has one.
 * OpenSCAD writes inside the round and Hildegard moves the mesh to `out`. Throws ScadError with OpenSCAD's message
 * when it can't: a syntax error, an empty or flat result, too big, or out of time (`budget`, which it takes from).
 */
export function renderScad(
  scad: OpenScad,
  dir: string,
  main: string,
  out: string,
  libraries: string[],
  opts: {
    part?: string;
    budget?: ScadBudget;
    sandbox?: Sandbox | null;
    hide?: string[];
    maxBytes?: number;
  } = {},
): Promise<ScadRender> {
  if (opts.part !== undefined && !PART.test(opts.part))
    return Promise.reject(new ScadError(`“${opts.part}” isn’t a part name.`));
  if (!safeRelative(main) || main.includes('/'))
    return Promise.reject(new ScadError(`“${main}” can’t be the main file.`));
  const budget = opts.budget ?? { ms: scadTimeoutMs() };
  const hide = opts.hide ?? [homedir()];
  const cap = opts.maxBytes ?? MAX_MESH_BYTES;
  const scrub = (t: string) => scrubPaths(t, dir, libraries, hide);
  return slot(
    () =>
      new Promise<ScadRender>((resolvePromise, reject) => {
        const limit = Math.round(scadTimeoutMs() / 1000);
        const tooLong = () =>
          new ScadError(
            `OpenSCAD took longer than the round’s ${limit} s. Lower $fn while blocking out, avoid minkowski() and hull() over many children, and render one part at a time.`,
          );
        if (budget.ms <= 0) return reject(tooLong());
        const priv = join(dir, PRIVATE);
        mkdirSync(priv, { recursive: true });
        // Written inside the round, the one place the sandbox lets it write, then moved to `out` from here.
        const inside = join(dir, `.render-${randomBytes(6).toString('hex')}.stl`);
        const args = [
          ...scad.manifoldArgs,
          ...(opts.part !== undefined ? ['-D', `part="${opts.part}"`] : []),
          '-o',
          inside,
          '--export-format',
          'binstl',
          // `./`, so a file's name is never read as an option.
          `./${main}`,
        ];
        const own = ownFiles(scad.path, hide);
        const sandbox =
          opts.sandbox === undefined
            ? own && findSandbox({ round: dir, read: [...libraries, ...own], hide })
            : opts.sandbox;
        const windows = platform() === 'win32';
        // Files it writes stop growing past the cap, and on Linux it gets at most most of the memory.
        const limits = windows
          ? null
          : [
              `ulimit -f ${Math.ceil((cap + 64 * 1024 * 1024) / 512)} 2>/dev/null`,
              ...(platform() === 'linux'
                ? [`ulimit -v ${Math.floor((totalmem() * 0.75) / 1024)} 2>/dev/null`]
                : []),
              'exec "$0" "$@"',
            ].join('; ');
        const inner = limits
          ? { cmd: '/bin/sh', args: ['-c', limits, scad.path, ...args] }
          : { cmd: scad.path, args };
        const run = sandbox ? sandbox.wrap(inner.cmd, inner.args) : inner;
        const started = Date.now();
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(run.cmd, run.args, {
            cwd: dir,
            env: scadEnv(process.env, libraries, platform(), sandbox ? priv : undefined),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // Its own process group, so stopping it stops everything it started.
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
          clearInterval(watch);
          budget.ms -= Date.now() - started;
          f();
        };
        const killAll = () => {
          try {
            if (windows && child.pid)
              spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
            else if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const fail = (e: ScadError) => {
          rmSync(inside, { force: true });
          reject(e);
        };
        const timer = setTimeout(() => {
          killAll();
          const log = readLog(scrub(text));
          // Settle now: a program it started may hold its output open, and 'close' never come.
          settle(() => fail(new ScadError(tooLong().message, [...log.errors, ...log.warnings].slice(0, 20))));
        }, budget.ms);
        // The mesh is watched as it's written, so a runaway export is stopped before it fills the disk.
        const tooBig = (size: number) =>
          new ScadError(
            `The mesh came out at ${Math.round(size / 1024 / 1024)} MB, over ${Math.round(cap / 1024 / 1024)} MB. Lower $fn, or simplify curved surfaces.`,
          );
        const watch = setInterval(() => {
          const size = existsSync(inside) ? statSync(inside).size : 0;
          if (size > cap) {
            killAll();
            settle(() => fail(tooBig(size)));
          }
        }, 500);
        child.once('error', (e) =>
          settle(() => fail(new ScadError(`Couldn’t run OpenSCAD: ${scrub(e.message)}`))),
        );
        child.once('close', (code) =>
          settle(() => {
            const log = readLog(scrub(text));
            const tail = [...log.errors, ...log.warnings].slice(0, 20);
            if (log.notSolid)
              return fail(
                new ScadError(
                  'The model is 2D. Extrude it (linear_extrude or rotate_extrude) to make a solid.',
                  tail,
                ),
              );
            if (log.empty)
              return fail(
                new ScadError(
                  'The model is empty: nothing is drawn at the top level (a module defined but never called, or a difference() that removes everything).',
                  tail,
                ),
              );
            const size = existsSync(inside) ? statSync(inside).size : 0;
            if (code !== 0 || log.errors.length || size < 84)
              return fail(
                new ScadError(
                  log.errors.length
                    ? `OpenSCAD stopped: ${log.errors.slice(0, 5).join(' | ')}`
                    : `OpenSCAD stopped (exit ${code}): ${scrub(text).trim().split('\n').slice(-3).join(' | ').slice(0, 600)}`,
                  tail,
                ),
              );
            if (size > cap) return fail(Object.assign(tooBig(size), { log: tail }));
            try {
              renameSync(inside, out);
            } catch {
              copyFileSync(inside, out);
              rmSync(inside, { force: true });
            }
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
 * Written a part at a time, so a big mesh never sits in memory as one string, and stopped (the file removed) as soon
 * as what it has written passes `maxBytes`.
 */
export function writePartsObj(
  out: string,
  parts: { name: string; stl: string }[],
  maxBytes = MAX_MESH_BYTES,
): number {
  const tooBig = () =>
    new ScadError(
      `The parts come to over ${Math.round(maxBytes / 1024 / 1024)} MB as one mesh. Lower $fn, or simplify curved surfaces.`,
    );
  let total = 0;
  for (const p of parts) total += statSync(p.stl).size;
  if (total > maxBytes) throw tooBig();
  const fd = openSync(out, 'w');
  let written = 0;
  const write = (t: string) => {
    written += Buffer.byteLength(t);
    if (written > maxBytes) throw tooBig();
    writeSync(fd, t);
  };
  try {
    write('# Rendered by Hildegard with OpenSCAD, one object per part\n');
    let base = 1;
    for (const p of parts) {
      const stl = readFileSync(p.stl);
      const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
      const n = stl.byteLength >= 84 ? dv.getUint32(80, true) : -1;
      if (n < 0 || 84 + n * 50 !== stl.byteLength)
        throw new ScadError(`OpenSCAD wrote part ${p.name} as a broken STL.`);
      write(`o ${p.name}\n`);
      const CHUNK = 20_000;
      for (let from = 0; from < n; from += CHUNK) {
        let chunk = '';
        for (let i = from; i < Math.min(n, from + CHUNK); i++) {
          const at = 84 + i * 50 + 12;
          for (let v = 0; v < 3; v++) {
            const x = dv.getFloat32(at + v * 12, true);
            const y = dv.getFloat32(at + v * 12 + 4, true);
            const z = dv.getFloat32(at + v * 12 + 8, true);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
              throw new ScadError(
                `Part ${p.name} has a point at infinity or not a number. Check the math that places it.`,
              );
            chunk += `v ${x} ${y} ${z}\n`;
          }
        }
        write(chunk);
      }
      for (let from = 0; from < n; from += CHUNK) {
        let chunk = '';
        for (let i = from; i < Math.min(n, from + CHUNK); i++) {
          const b = base + i * 3;
          chunk += `f ${b} ${b + 1} ${b + 2}\n`;
        }
        write(chunk);
      }
      base += n * 3;
    }
  } catch (e) {
    closeSync(fd);
    rmSync(out, { force: true });
    throw e;
  }
  closeSync(fd);
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
