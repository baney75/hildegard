// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenSCAD: code-CAD that an agent writes as text and Hildegard renders into a mesh, so a model loop can take the
 * source itself and every round stays a small, named edit to one parametric file. OpenSCAD is a separate program
 * (GPL-2.0-or-later) that Hildegard finds on this computer and runs; it is never linked or shipped with Hildegard.
 *
 * Source from an agent is untrusted, and OpenSCAD can read other files: `include <…>` and `use <…>` take any path,
 * and `import()` and `surface()` read meshes, images and data. So before it runs, every file of a round is read here
 * and held to these rules: an include or use names a file inside the round or a library (a relative path, never
 * absolute, never `..`), and an import or surface names, as a plain string, a file the round itself carries. OpenSCAD
 * then runs in a fresh folder holding only the round's files, with a time limit, no secrets in its environment, and
 * the libraries on this computer (BOSL2 and the rest) as its only library path. It can't run programs or open the
 * network, and nothing it writes leaves that folder but the mesh.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, join, posix } from 'node:path';

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
  if (os === 'linux') found.push('/var/lib/flatpak/exports/bin/org.openscad.OpenSCAD');
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
  | { t: 'str'; v: string; raw: string; line: number }
  | { t: 'inc'; kw: 'include' | 'use'; v: string; line: number }
  | { t: 'p'; v: string; line: number };

/** OpenSCAD's tokens, enough to find every file it would open: comments dropped, strings kept whole. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
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
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let raw = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          raw += src[j]! + src[j + 1]!;
          j += 2;
        } else {
          if (src[j] === '\n') line++;
          raw += src[j++];
        }
      }
      out.push({ t: 'str', v: raw, raw, line });
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      if (word === 'include' || word === 'use') {
        let k = j;
        while (k < n && /[ \t]/.test(src[k]!)) k++;
        if (src[k] === '<') {
          const end = src.indexOf('>', k + 1);
          const stop = end < 0 ? n : end;
          out.push({ t: 'inc', kw: word, v: src.slice(k + 1, stop), line });
          i = stop + 1;
          continue;
        }
      }
      out.push({ t: 'id', v: word, line });
      i = j;
    } else {
      out.push({ t: 'p', v: c, line });
      i++;
    }
  }
  return out;
}

/** A path inside the round or a library: relative, forward slashes, no `..`, no drive, no escapes, no `~`. */
export function safeRelative(p: string): boolean {
  if (!p || p.length > 300) return false;
  if (/[\\:\0~]/.test(p) || p.startsWith('/')) return false;
  return !p.split('/').some((s) => s === '..');
}

/**
 * Checks every file of a round against the rules above. `files` maps each path in the round (forward slashes) to
 * its text. Returns the problems, one line each; none means it may run.
 */
export function vetScad(files: Map<string, string>): string[] {
  const problems: string[] = [];
  const has = (from: string, p: string) => {
    const dir = posix.dirname(from);
    const full = posix.normalize(dir === '.' ? p : `${dir}/${p}`);
    return files.has(full) || files.has(p);
  };
  for (const [name, src] of files) {
    if (!name.endsWith('.scad')) continue;
    const toks = tokenize(src);
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k]!;
      if (tk.t === 'inc') {
        if (!safeRelative(tk.v.trim()))
          problems.push(
            `${name}, line ${tk.line}: ${tk.kw} <${tk.v}> reaches outside the round. Include files the round carries, or a library by its own path (${tk.kw} <BOSL2/std.scad>).`,
          );
        continue;
      }
      if (tk.t !== 'id' || (tk.v !== 'import' && tk.v !== 'surface')) continue;
      if (toks[k + 1]?.t !== 'p' || toks[k + 1]!.v !== '(') {
        problems.push(
          `${name}, line ${tk.line}: ${tk.v} can only be called, with the file as a plain string, such as ${tk.v}("logo.svg").`,
        );
        continue;
      }
      // The arguments, split at top-level commas.
      const args: Tok[][] = [[]];
      let depth = 0;
      let j = k + 2;
      for (; j < toks.length; j++) {
        const a = toks[j]!;
        if (a.t === 'p' && '([{'.includes(a.v)) depth++;
        if (a.t === 'p' && ')]}'.includes(a.v)) {
          if (depth === 0) break;
          depth--;
        }
        if (a.t === 'p' && a.v === ',' && depth === 0) args.push([]);
        else args.at(-1)!.push(a);
      }
      const named = args.find((a) => a[0]?.t === 'id' && a[0].v === 'file' && a[1]?.v === '=');
      const fileArg = named ? named.slice(2) : args.find((a) => !(a[0]?.t === 'id' && a[1]?.v === '='));
      const lit = fileArg?.length === 1 && fileArg[0]!.t === 'str' ? fileArg[0]!.v : null;
      if (lit === null)
        problems.push(
          `${name}, line ${tk.line}: ${tk.v} needs the file as a plain string, such as ${tk.v}("logo.svg"), not a variable or an expression.`,
        );
      else if (!safeRelative(lit) || !has(name, lit))
        problems.push(
          `${name}, line ${tk.line}: ${tk.v}("${lit}") must name a file sent with this round (send a folder or a ZIP with it beside the .scad).`,
        );
      k = j;
    }
  }
  return problems;
}

/** The round's main file: main.scad, or the one .scad file at the top of the round. */
export function mainScad(names: string[]): string {
  const top = names.filter((n) => n.endsWith('.scad') && !n.includes('/'));
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

const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|COOKIE|AUTH/i;

/**
 * Renders `main` in `dir` (the round's own folder) to `out` as binary STL. Throws ScadError with OpenSCAD's message
 * when it can't: a syntax error, an empty or flat result, or too long.
 */
export function renderScad(
  scad: OpenScad,
  dir: string,
  main: string,
  out: string,
  libraries: string[],
  opts: { part?: string; timeoutMs?: number } = {},
): Promise<ScadRender> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.HILDEGARD_OPENSCAD_TIMEOUT ?? 180) * 1000;
  if (opts.part !== undefined && !PART.test(opts.part))
    throw new ScadError(`“${opts.part}” isn’t a part name.`);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET.test(k)) env[k] = v;
  env.OPENSCADPATH = libraries.join(delimiter);
  const args = [
    ...scad.manifoldArgs,
    ...(opts.part !== undefined ? ['-D', `part="${opts.part}"`] : []),
    '-o',
    out,
    '--export-format',
    'binstl',
    main,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(scad.path, args, {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let text = '';
    const keep = (d: Buffer) => {
      text = (text + d.toString()).slice(-200_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(new ScadError(`Couldn’t run OpenSCAD (${scad.path}): ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const log = readLog(text);
      const tail = [...log.errors, ...log.warnings].slice(0, 20);
      if (timedOut)
        return reject(
          new ScadError(
            `OpenSCAD took longer than ${Math.round(timeoutMs / 1000)} s. Lower $fn while blocking out, avoid minkowski() and hull() over many children, and render one part at a time.`,
            tail,
          ),
        );
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
      if (code !== 0 || log.errors.length || !existsSync(out) || statSync(out).size < 84)
        return reject(
          new ScadError(
            log.errors.length
              ? `OpenSCAD stopped: ${log.errors.slice(0, 5).join(' | ')}`
              : `OpenSCAD stopped (exit ${code}): ${text.trim().split('\n').slice(-3).join(' | ').slice(0, 600)}`,
            tail,
          ),
        );
      resolve({
        out,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        version: scad.version,
        engine: usesManifold(scad) ? 'Manifold' : 'CGAL',
        warnings: log.warnings.slice(0, 30),
        echo: log.echo.slice(0, 50),
      });
    });
  });
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

/** Named binary STL meshes as one OBJ, one `o` object per part, as review_mesh.py reads parts. */
export function partsObj(parts: { name: string; stl: Uint8Array }[]): string {
  const out: string[] = ['# Rendered by Hildegard with OpenSCAD, one object per part'];
  let base = 1;
  for (const p of parts) {
    const dv = new DataView(p.stl.buffer, p.stl.byteOffset, p.stl.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 !== p.stl.byteLength)
      throw new ScadError(`OpenSCAD wrote part ${p.name} as a broken STL.`);
    out.push(`o ${p.name}`);
    const faces: string[] = [];
    for (let i = 0; i < n; i++) {
      const at = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++)
        out.push(
          `v ${dv.getFloat32(at + v * 12, true)} ${dv.getFloat32(at + v * 12 + 4, true)} ${dv.getFloat32(at + v * 12 + 8, true)}`,
        );
      faces.push(`f ${base} ${base + 1} ${base + 2}`);
      base += 3;
    }
    out.push(...faces);
  }
  return `${out.join('\n')}\n`;
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
