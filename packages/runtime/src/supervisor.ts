// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { layout, type RuntimeInfo, readRuntime } from './install.ts';

export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

export interface RuntimeState {
  status: RuntimeStatus;
  /** comfy-api-proxy's URL, which the engine talks to. */
  url: string | null;
  /** Why it stopped, in words, when it keeps failing. */
  error: string | null;
}

/** A free port on loopback, chosen by the OS, so Hildegard never collides with a ComfyUI the owner runs themselves. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/**
 * Runs the ComfyUI Hildegard installed, and comfy-api-proxy in front of it, on loopback ports only. Restarts either
 * one if it exits, backing off up to 30 seconds, and stops both when Hildegard stops.
 */
/**
 * How ComfyUI should treat memory on this GPU. Where the GPU shares the computer's memory (DGX Spark), reading
 * weights through mmap and then copying them "to the GPU" holds each model twice, and dynamic VRAM offloads into the
 * same memory it frees: both are turned off, as NVIDIA's forum setups for Spark do.
 */
export function comfyMemoryArgs(info: Pick<RuntimeInfo, 'backend' | 'unified' | 'gpu'>): string[] {
  // Installs from before 0.1.11 didn't note `unified`; the GB10 is the one NVIDIA part that shares memory so far.
  const shared = info.unified || /\bGB10\b/i.test(info.gpu);
  return info.backend === 'cuda' && shared ? ['--disable-mmap', '--disable-dynamic-vram'] : [];
}

/**
 * Where each Hildegard process notes the ComfyUI and proxy it started, one file per process (`<pid>.json`), so a
 * later start can find any that a crash, a kill or a failed start left behind. POSIX only: on Windows nothing is
 * noted or reaped, and only Node's exit event takes the children down.
 */
export const pidDir = (dataDir: string) => join(dataDir, 'comfyui-pids');
export const pidFile = (dataDir: string, owner = process.pid) => join(pidDir(dataDir), `${owner}.json`);

/** A note: who wrote it and the children it started, each with its start time, so a reused number can't pass. */
export interface PidNote {
  /** 2: start times read with ps pinned to the C locale and UTC. Notes without it used the writer's own. */
  v?: 2;
  started: string | null;
  pids: Array<{ pid: number; started: string | null }>;
}

/**
 * When a process started, as the OS keeps it: what tells a process from a later one given the same number. Linux
 * reads /proc/<pid>/stat (start time in clock ticks since boot); macOS asks ps. Null when it isn't running or can't
 * be read.
 */
export function processStart(pid: number, pinned = true): string | null {
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The name (field 2) is in parentheses and may hold spaces; field 22 is the 20th after it.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    } catch {
      return null;
    }
  }
  // ps formats lstart in the reader's locale and time zone: pin both, so every reader writes the same string.
  // (Unpinned reads only match notes written before the pin.)
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: pinned ? { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } : process.env,
  });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, under another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Whether the process a note names still runs: the same number, started at the same moment. */
export function sameProcess(
  pid: number,
  started: string | null,
  startOf: (pid: number) => string | null = processStart,
  /** For a note from before the pin: the start time as its writer read it, in this shell's locale and zone. */
  startOfThen?: (pid: number) => string | null,
): boolean {
  if (!exists(pid)) return false;
  const now = startOf(pid);
  // A start time this computer can't read (or a note without one) can't prove a reuse: count it as the same.
  if (now === null || started === null || now === started) return true;
  return !!startOfThen && startOfThen(pid) === started;
}

/** A process's command line, or null when it isn't running or can't be read (Windows). */
export function commandLine(pid: number): string | null {
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() || null;
    } catch {
      return null;
    }
  }
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * Stops the ComfyUI and comfy-api-proxy that earlier Hildegard processes in this folder left running, once those
 * processes are gone: one that crashed, was killed, or failed partway through starting. A Hildegard still running
 * keeps its own. A child is stopped only when it is the very process noted (same start time) and runs this folder's
 * Python. Returns the ones it stopped.
 */
export function reapStale(
  dataDir: string,
  command: (pid: number) => string | null = commandLine,
  startOf: (pid: number) => string | null = processStart,
): number[] {
  if (process.platform === 'win32') return [];
  let files: string[];
  try {
    files = readdirSync(pidDir(dataDir));
  } catch {
    return [];
  }
  const python = layout(dataDir).python;
  const stopped: number[] = [];
  for (const f of files) {
    const owner = Number(/^(\d+)\.json$/.exec(f)?.[1]);
    if (!Number.isInteger(owner) || owner === process.pid) continue;
    let note: Partial<PidNote> = {};
    try {
      note = JSON.parse(readFileSync(join(pidDir(dataDir), f), 'utf8'));
    } catch {}
    const then = note.v === 2 ? undefined : (pid: number) => processStart(pid, false);
    if (sameProcess(owner, typeof note.started === 'string' ? note.started : null, startOf, then)) continue;
    for (const child of Array.isArray(note.pids) ? note.pids : []) {
      const pid = child?.pid;
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      if (!sameProcess(pid, typeof child.started === 'string' ? child.started : null, startOf, then))
        continue;
      if (!command(pid)?.includes(python)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        stopped.push(pid);
      } catch {}
    }
    rmSync(join(pidDir(dataDir), f), { force: true });
  }
  return stopped;
}

export class ComfyRuntime {
  readonly dataDir: string;
  private readonly onChange: (s: RuntimeState) => void;
  private procs: ChildProcess[] = [];
  /** Children a restart told to stop that haven't yet: killed outright after five seconds, or when Hildegard exits. */
  private readonly dying = new Set<ChildProcess>();
  private stopping = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private ports: [comfy: number, proxy: number] | null = null;
  /**
   * Kills ComfyUI and the proxy whenever Hildegard's process exits through Node's exit event (a return, a crash,
   * process.exit). A signal Node has no handler for yet, or SIGKILL, skips it; the next start reaps those.
   */
  private readonly onExit = () => {
    for (const p of [...this.procs, ...this.dying])
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  };
  state: RuntimeState = { status: 'stopped', url: null, error: null };

  constructor(opts: { dataDir: string; onChange?: (s: RuntimeState) => void }) {
    this.dataDir = opts.dataDir;
    this.onChange = opts.onChange ?? (() => {});
  }

  /** ComfyUI's own address (not the proxy's), while it runs: for asking it to free GPU memory. */
  comfyUrl(): string | null {
    return this.ports && this.state.status !== 'stopped' ? `http://127.0.0.1:${this.ports[0]}` : null;
  }

  /** The processes it runs, so a GPU watcher can tell them from other programs. */
  pids(): number[] {
    return this.procs.flatMap((p) => (p.pid && p.exitCode === null ? [p.pid] : []));
  }

  /** Notes every child still running, dying ones too, for a later start to reap if this process is killed. */
  private note() {
    if (process.platform === 'win32') return;
    const pids = [...this.procs, ...this.dying].flatMap((p) =>
      p.pid && p.exitCode === null && p.signalCode === null
        ? [{ pid: p.pid, started: processStart(p.pid) }]
        : [],
    );
    const note: PidNote = { v: 2, started: processStart(process.pid), pids };
    writeFileSync(pidFile(this.dataDir), JSON.stringify(note), { mode: 0o600 });
  }

  /** Whether `hildegard install` has finished here. */
  static installed(dataDir: string): boolean {
    return readRuntime(dataDir) !== null;
  }

  async start(): Promise<string> {
    this.stopping = false;
    const info = readRuntime(this.dataDir);
    if (!info) throw new Error('ComfyUI isn’t installed. Run `hildegard install`.');
    const L = layout(this.dataDir);
    mkdirSync(L.logs, { recursive: true });
    // Whatever an earlier run here left behind holds memory and GPU memory and serves nothing: stop it first.
    reapStale(this.dataDir);
    // Same ports across restarts, so the URL stays put; fresh ones if a restart keeps failing (something took them).
    if (!this.ports || this.failures % 3 === 2) this.ports = [await freePort(), await freePort()];
    const [comfyPort, proxyPort] = this.ports;
    const url = `http://127.0.0.1:${proxyPort}`;
    // Stopped while finding ports: start nothing that nobody would stop.
    if (this.stopping) return url;
    process.removeListener('exit', this.onExit);
    process.on('exit', this.onExit);
    this.set({ status: this.failures ? 'restarting' : 'starting', url, error: null });

    const launch = (name: string, args: string[], cwd: string) => {
      const fd = openSync(join(L.logs, `${name}.log`), 'a');
      const child = spawn(L.python, args, {
        cwd,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      closeSync(fd);
      child.on('exit', (code, signal) => this.exited(child, name, code, signal));
      child.on('error', () => {
        // One that never started (no pid) will never send exit: forget it now.
        if (!child.pid) this.dying.delete(child);
        this.exited(child, name, null, null);
      });
      this.procs.push(child);
    };
    try {
      launch(
        'comfyui',
        [
          'main.py',
          '--listen',
          '127.0.0.1',
          '--port',
          String(comfyPort),
          '--disable-auto-launch',
          '--preview-method',
          'auto',
          ...(info.backend === 'cpu' ? ['--cpu'] : []),
          ...comfyMemoryArgs(info),
        ],
        L.comfyDir,
      );
      launch(
        'comfy-api-proxy',
        [
          '-m',
          'comfy_api_proxy.cli',
          'run',
          '--comfyui',
          `http://127.0.0.1:${comfyPort}`,
          '--port',
          String(proxyPort),
          '--comfyui-base-dir',
          L.comfyDir,
        ],
        L.comfyDir,
      );
    } catch (e) {
      // Half started is worse than not started: nothing would watch the half that runs.
      for (const p of this.procs) if (p.exitCode === null) p.kill('SIGKILL');
      this.procs = [];
      throw e;
    }
    // Best effort: without the note, only a SIGKILL of Hildegard would leave these behind.
    try {
      mkdirSync(pidDir(this.dataDir), { recursive: true });
      this.note();
    } catch {}
    void this.watchReady(comfyPort);
    return url;
  }

  /** Marks the runtime running once ComfyUI answers; the first start can take a minute while it loads. */
  private async watchReady(port: number) {
    const procs = this.procs;
    for (let i = 0; i < 600 && procs === this.procs && !this.stopping; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/system_stats`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          this.failures = 0;
          this.set({ ...this.state, status: 'running', error: null });
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private exited(child: ChildProcess, name: string, code: number | null, signal: NodeJS.Signals | null) {
    // A child of an earlier start, ending late, says nothing about the ones running now.
    if (this.stopping || this.timer || !this.procs.includes(child)) return;
    // One half down takes the other with it, then both come back together on fresh ports. One that ignores SIGTERM
    // gets SIGKILL after five seconds, as in stop().
    for (const p of this.procs) {
      if (!p.pid || p.exitCode !== null || p.signalCode !== null) continue;
      this.dying.add(p);
      p.once('exit', () => {
        this.dying.delete(p);
        // The note names only children still running, so a number reused later isn't taken for this one.
        if (!this.stopping)
          try {
            this.note();
          } catch {}
      });
      setTimeout(() => {
        if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      }, 5000).unref();
      p.kill();
    }
    this.procs = [];
    this.failures++;
    const wait = Math.min(30_000, 1000 * 2 ** (this.failures - 1));
    this.set({
      status: this.failures >= 5 ? 'failed' : 'restarting',
      url: this.state.url,
      error: `${name === 'comfyui' ? 'ComfyUI' : 'comfy-api-proxy'} stopped (${signal ?? `exit ${code}`}). See ${join(layout(this.dataDir).logs, `${name}.log`)}.`,
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopping)
        void this.start().catch((e) => this.set({ ...this.state, status: 'failed', error: String(e) }));
    }, wait);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all(
      [...this.procs, ...this.dying].map(
        (p) =>
          new Promise<void>((resolve) => {
            if (!p.pid || p.exitCode !== null || p.signalCode !== null) return resolve();
            const force = setTimeout(() => p.kill('SIGKILL'), 5000);
            p.once('exit', () => {
              clearTimeout(force);
              resolve();
            });
            p.kill();
          }),
      ),
    );
    this.procs = [];
    process.removeListener('exit', this.onExit);
    try {
      rmSync(pidFile(this.dataDir), { force: true });
    } catch {}
    this.set({ status: 'stopped', url: null, error: null });
  }

  private set(s: RuntimeState) {
    this.state = s;
    this.onChange(s);
  }
}
