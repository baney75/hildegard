// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { type Backend, detectGpu, type Gpu, type Probe, systemProbe } from './gpu.ts';
import { COMFYUI, PROXY, PYTHON, UV } from './pins.ts';

export type StepStatus = 'done' | 'skipped' | 'needs-owner' | 'failed';

/** One thing the installer did or needs. Agents read these from `--json`; people read the titles. */
export interface Step {
  id: string;
  title: string;
  status: StepStatus;
  /** A plain sentence for the owner. */
  detail: string;
  /** For needs-owner: the exact command the owner (or their agent, with their OK) should run. */
  command?: string;
}

export interface Layout {
  dataDir: string;
  comfyDir: string;
  /** The Python environment ComfyUI runs in. */
  venv: string;
  python: string;
  tools: string;
  logs: string;
  downloads: string;
  /** What's installed, written last: its presence means ComfyUI is ready to run. */
  manifest: string;
}

const win = process.platform === 'win32';
/** Windows' own bsdtar, by path: Git for Windows can put GNU tar first on PATH, which reads `C:` as a remote host. */
const tar = win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

export function layout(dataDir: string): Layout {
  const venv = join(dataDir, 'python');
  return {
    dataDir,
    comfyDir: join(dataDir, 'comfyui'),
    venv,
    python: win ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python'),
    tools: join(dataDir, 'tools'),
    logs: join(dataDir, 'logs'),
    downloads: join(dataDir, 'downloads'),
    manifest: join(dataDir, 'runtime.json'),
  };
}

export interface RuntimeInfo {
  comfyui: string;
  backend: Backend;
  torchBackend: string | null;
  gpu: string;
  /** The GPU shares the computer's memory (DGX Spark): ComfyUI starts with what suits that. */
  unified?: boolean;
  torch: string;
  installedAt: string;
}

export function readRuntime(dataDir: string): RuntimeInfo | null {
  try {
    return JSON.parse(readFileSync(layout(dataDir).manifest, 'utf8')) as RuntimeInfo;
  } catch {
    return null;
  }
}

/** A file shipped with Hildegard (the repo in development, the release folder when installed). */
export function resource(rel: string): string {
  const shipped = process.env.HILDEGARD_RESOURCES;
  if (shipped && existsSync(join(shipped, rel))) return join(shipped, rel);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, rel))) return join(dir, rel);
    const up = dirname(dir);
    if (up === dir) throw new Error(`Hildegard's ${rel} is missing. Reinstall Hildegard.`);
    dir = up;
  }
}

export interface InstallOptions {
  dataDir: string;
  gpu?: Gpu;
  /** Install the CPU build even when there's a GPU (tests, CI). */
  cpu?: boolean;
  onStep?(step: Step): void;
  /** Each line of output from uv and the downloads, for a progress display. */
  onLog?(line: string): void;
  fetchFn?: typeof fetch;
}

/**
 * Installs ComfyUI, its Python, PyTorch for this GPU, comfy-api-proxy and Hildegard's film-look node, all inside
 * Hildegard's data folder. Needs no admin rights. Safe to run again: it repairs and updates in place, and skips what
 * is already right.
 */
export async function installRuntime(opts: InstallOptions): Promise<Step[]> {
  const L = layout(opts.dataDir);
  for (const d of [L.dataDir, L.logs, L.downloads, L.tools]) mkdirSync(d, { recursive: true });
  const logFile = join(L.logs, 'install.log');
  appendFileSync(logFile, `\n=== ${new Date().toISOString()} hildegard install\n`);
  const log = (line: string) => {
    appendFileSync(logFile, `${line}\n`);
    opts.onLog?.(line);
  };
  const steps: Step[] = [];
  const record = (s: Step) => {
    steps.push(s);
    log(`[${s.status}] ${s.title}: ${s.detail}`);
    opts.onStep?.(s);
    return s;
  };

  const detected = opts.gpu ?? detectGpu();
  const gpu: Gpu = opts.cpu
    ? { backend: 'cpu', name: detected.name, vramGb: detected.vramGb, torchBackend: 'cpu' }
    : detected;
  record({
    id: 'gpu',
    title: 'Find the GPU',
    status: 'done',
    detail:
      gpu.backend === 'cpu'
        ? (gpu.note ?? 'Using the CPU build.')
        : `${gpu.name}${gpu.vramGb ? `, ${gpu.vramGb} GB` : ''}.${gpu.note ? ` ${gpu.note}` : ''}`,
  });

  try {
    // uv
    let uv = findUv(L);
    if (uv) record({ id: 'uv', title: 'Get uv', status: 'skipped', detail: `Using ${uv}.` });
    else {
      uv = await downloadUv(L, opts.fetchFn ?? fetch, log);
      record({ id: 'uv', title: 'Get uv', status: 'done', detail: `Installed uv ${UV.version}.` });
    }

    // ComfyUI
    const marker = join(L.comfyDir, '.hildegard-comfyui');
    if (existsSync(join(L.comfyDir, 'main.py')) && readText(marker) === COMFYUI.version)
      record({
        id: 'comfyui',
        title: 'Get ComfyUI',
        status: 'skipped',
        detail: `ComfyUI ${COMFYUI.version} is here.`,
      });
    else {
      await installComfy(L, opts.fetchFn ?? fetch, log);
      writeFileSync(marker, COMFYUI.version);
      record({
        id: 'comfyui',
        title: 'Get ComfyUI',
        status: 'done',
        detail: `Installed ComfyUI ${COMFYUI.version}.`,
      });
    }

    // Python
    if (existsSync(L.python))
      record({
        id: 'python',
        title: 'Set up Python',
        status: 'skipped',
        detail: 'The Python environment is here.',
      });
    else {
      await run(uv, ['venv', '--managed-python', '--python', PYTHON, L.venv], { log, env: uvEnv(L) });
      record({
        id: 'python',
        title: 'Set up Python',
        status: 'done',
        detail: `Made a Python ${PYTHON} environment.`,
      });
    }

    // PyTorch, ComfyUI's requirements and the proxy, in one resolve so the GPU build of torch is the one that stays.
    // uv counts any torch as satisfied, so a CPU build from before the GPU was found would stay: reinstall it then.
    const installedTorch = await run(L.python, ['-c', 'import torch; print(torch.__version__)'], {
      log,
    }).then(
      (v) => v.trim(),
      () => null,
    );
    const rebuild = installedTorch !== null && torchMismatch(installedTorch, gpu.torchBackend);
    const pkgArgs = [
      'pip',
      'install',
      '--python',
      L.python,
      ...TORCH,
      '-r',
      join(L.comfyDir, 'requirements.txt'),
      PROXY,
      ...(gpu.torchBackend ? ['--torch-backend', gpu.torchBackend] : []),
      ...(rebuild ? TORCH.flatMap((p) => ['--reinstall-package', p]) : []),
    ];
    const out = await run(uv, pkgArgs, { log, env: uvEnv(L) });
    record({
      id: 'packages',
      title: 'Install PyTorch and ComfyUI’s packages',
      // uv says "Audited" or "Checked" N packages when nothing changed, depending on its version.
      status:
        /^(Audited|Checked) \d+ packages?/m.test(out) && !/^(Installed|Uninstalled) \d+/m.test(out)
          ? 'skipped'
          : 'done',
      detail: `PyTorch for ${gpu.backend === 'cpu' ? 'the CPU' : gpu.backend.toUpperCase()}${gpu.torchBackend && gpu.torchBackend !== 'cpu' ? ` (${gpu.torchBackend})` : ''}, ComfyUI’s packages and ${PROXY.replace('==', ' ')}.`,
    });

    // Hildegard's own ComfyUI nodes: the film look, and the safety check every take passes
    for (const node of ['hildegard_look', 'hildegard_guard']) {
      const dest = join(L.comfyDir, 'custom_nodes', node);
      rmSync(dest, { recursive: true, force: true });
      cpSync(resource(join('comfy-nodes', node)), dest, {
        recursive: true,
        filter: (src) => !/__pycache__|test_\w+\.py$/.test(src),
      });
    }
    record({
      id: 'film-look',
      title: 'Add the film look and the safety check',
      status: 'done',
      detail: 'Installed Hildegard’s film-look and safety-check nodes.',
    });

    // Check PyTorch sees the GPU
    const probe = (
      await run(
        L.python,
        [
          '-c',
          'import torch, comfy_api_proxy; mps = getattr(torch.backends, "mps", None); ' +
            'print(torch.__version__, torch.cuda.is_available() or bool(mps and mps.is_available()))',
        ],
        { log },
      )
    )
      .trim()
      .split(/\s+/);
    const [torchVersion = '?', usable] = probe;
    if (gpu.backend !== 'cpu' && usable !== 'True') {
      record({
        id: 'check',
        title: 'Check the GPU works',
        status: 'needs-owner',
        detail: `PyTorch ${torchVersion} can't use the ${gpu.name}. ${
          torchVersion.endsWith('+cpu')
            ? 'It’s the CPU build. Run `hildegard install` again to put the GPU build in.'
            : gpu.backend === 'cuda'
              ? 'Update the NVIDIA driver, restart, then run `hildegard install` again.'
              : 'Check the GPU driver is loaded, then run `hildegard install` again.'
        }`,
        command: 'hildegard install --yes --json',
      });
      return steps;
    }
    record({
      id: 'check',
      title: 'Check the GPU works',
      status: 'done',
      detail: `PyTorch ${torchVersion} ${gpu.backend === 'cpu' ? 'runs on the CPU' : `uses the ${gpu.name}`}.`,
    });

    const info: RuntimeInfo = {
      comfyui: COMFYUI.version,
      backend: gpu.backend,
      torchBackend: gpu.torchBackend,
      gpu: gpu.name,
      ...(gpu.unified ? { unified: true } : {}),
      torch: torchVersion,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(L.manifest, `${JSON.stringify(info, null, 2)}\n`);
  } catch (e) {
    record({
      id: 'error',
      title: 'Install',
      status: 'failed',
      detail: `${(e as Error).message} The full log is in ${logFile}.`,
    });
  }
  return steps;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/** A uv of the pinned version: another version resolves packages differently, so it's passed over for our own. */
export function findUv(L: Layout, probe: Pick<Probe, 'run'> = systemProbe): string | null {
  const ours = join(L.tools, win ? 'uv.exe' : 'uv');
  for (const c of [process.env.HILDEGARD_UV, ours, 'uv'])
    if (c && probe.run(c, ['--version'])?.trim().split(/\s+/, 2).join(' ') === `uv ${UV.version}`) return c;
  return null;
}

export async function downloadUv(
  L: Layout,
  fetchFn: typeof fetch,
  log: (l: string) => void,
): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const asset = UV.assets[key];
  if (!asset)
    throw new Error(`uv has no build for ${key}. Install uv yourself (https://docs.astral.sh/uv/).`);
  const [file, sha] = asset;
  const archive = join(L.downloads, file);
  await download(UV.url(file), archive, sha, fetchFn, log);
  const tmp = mkdtempSync(join(L.downloads, 'uv-'));
  await run(tar, ['-xmf', archive, '-C', tmp], { log });
  const name = win ? 'uv.exe' : 'uv';
  // The Unix archives hold a folder named after the target; the Windows zip holds the binaries at the top.
  const inner = win ? join(tmp, name) : join(tmp, file.replace(/\.tar\.gz$/, ''), name);
  const dest = join(L.tools, name);
  rmSync(dest, { force: true });
  renameSync(inner, dest);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(archive, { force: true });
  return dest;
}

async function installComfy(L: Layout, fetchFn: typeof fetch, log: (l: string) => void): Promise<void> {
  const archive = join(L.downloads, `ComfyUI-${COMFYUI.version}.tar.gz`);
  await download(COMFYUI.url, archive, COMFYUI.sha256, fetchFn, log);
  const tmp = mkdtempSync(join(L.downloads, 'comfyui-'));
  await run(tar, ['-xmzf', archive, '-C', tmp], { log });
  // Over the top of any earlier version: models, custom nodes, inputs and outputs stay.
  cpSync(join(tmp, COMFYUI.root), L.comfyDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  rmSync(archive, { force: true });
}

/** Downloads to a file, refusing it unless its SHA-256 matches. */
export async function download(
  url: string,
  dest: string,
  sha256: string,
  fetchFn: typeof fetch,
  log: (l: string) => void,
): Promise<void> {
  log(`download ${url}`);
  const res = await fetchFn(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${url} (HTTP ${res.status}).`);
  const hash = createHash('sha256');
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(part));
  const got = hash.digest('hex');
  if (got !== sha256) {
    rmSync(part, { force: true });
    throw new Error(
      `${url} didn't match its pinned hash (expected ${sha256}, got ${got}). Nothing was installed.`,
    );
  }
  renameSync(part, dest);
}

/**
 * uv's download cache and the Python it fetches live in Hildegard's own folder, not the user's profile: on a
 * Windows PC installed to D:, PyTorch's few GB would otherwise still land on a nearly full C:. uv links each Python
 * version to its minor version, which an exFAT or FAT32 drive can't hold, so there the Python (about 100 MB) goes in
 * the user's profile instead.
 */
export const uvEnv = (L: Layout): NodeJS.ProcessEnv => ({
  UV_CACHE_DIR: join(L.dataDir, 'cache', 'uv'),
  UV_PYTHON_INSTALL_DIR: holdsLinks(L.tools) ? join(L.tools, 'python') : profilePython(),
});

const profilePython = () =>
  win
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Hildegard-python')
    : join(homedir(), '.local', 'share', 'hildegard-python');

const linkChecks = new Map<string, boolean>();
/** Whether this folder's drive can hold a link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
export function holdsLinks(dir: string): boolean {
  const known = linkChecks.get(dir);
  if (known !== undefined) return known;
  mkdirSync(dir, { recursive: true });
  const probe = mkdtempSync(join(dir, 'link-'));
  let ok = true;
  try {
    mkdirSync(join(probe, 'to'));
    symlinkSync(join(probe, 'to'), join(probe, 'from'), 'junction');
  } catch {
    ok = false;
  }
  rmSync(probe, { recursive: true, force: true });
  linkChecks.set(dir, ok);
  return ok;
}

/** Runs a program, logging its output; resolves with stdout and stderr, rejects with the tail of the output. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; log?: (l: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    // Output arrives in chunks that can end mid-line; log whole lines only, each stream on its own.
    const reader = () => {
      let partial = '';
      return {
        take: (b: Buffer) => {
          const s = b.toString();
          out += s;
          const lines = (partial + s).split(/\r?\n/);
          partial = lines.pop()!;
          for (const line of lines) if (line.trim()) opts.log?.(line);
        },
        flush: () => {
          if (partial.trim()) opts.log?.(partial);
          partial = '';
        },
      };
    };
    const stdout = reader();
    const stderr = reader();
    child.stdout.on('data', stdout.take);
    child.stderr.on('data', stderr.take);
    child.on('error', (e) =>
      reject(new Error(`${cmd} couldn't start: ${(e as NodeJS.ErrnoException).code ?? e.message}.`)),
    );
    child.on('close', (code) => {
      stdout.flush();
      stderr.flush();
      if (code === 0) resolve(out);
      else {
        const tail = out.trim().split(/\r?\n/).slice(-6).join('\n');
        reject(new Error(`${[cmd, ...args.slice(0, 2)].join(' ')} failed (exit ${code}):\n${tail}\n`));
      }
    });
  });
}

const TORCH = ['torch', 'torchvision', 'torchaudio'];

/**
 * Whether the installed PyTorch is a different build from the one this GPU wants: a `+cpu` torch on a CUDA card, a
 * `+cu126` on a card that now takes cu130, and so on. Builds without a local tag (macOS, plain PyPI) match only a
 * backend uv doesn't tag either.
 */
export function torchMismatch(version: string, torchBackend: string | null): boolean {
  if (!torchBackend) return false;
  const tag = version.split('+')[1] ?? null;
  if (torchBackend === 'cpu') return tag !== null && tag !== 'cpu';
  return tag !== torchBackend;
}
