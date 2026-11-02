// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Where the runtime notes the processes it started, so a later start can find any a crash left behind. */
export const pidFile = (dataDir: string) => join(dataDir, 'comfyui.pids');

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
 * Stops the ComfyUI and comfy-api-proxy an earlier Hildegard in this folder left running: one that crashed, was
 * killed, or failed partway through starting. Only a process whose command line runs this folder's Python is
 * stopped, so a reused process number is left alone. Returns the ones it stopped.
 */
export function reapStale(dataDir: string, command: (pid: number) => string | null = commandLine): number[] {
  const file = pidFile(dataDir);
  let pids: unknown;
  try {
    pids = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const python = layout(dataDir).python;
  const stopped: number[] = [];
  for (const pid of Array.isArray(pids) ? pids : []) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    if (!command(pid)?.includes(python)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      stopped.push(pid);
    } catch {}
  }
  rmSync(file, { force: true });
  return stopped;
}

export class ComfyRuntime {
  readonly dataDir: string;
  private readonly onChange: (s: RuntimeState) => void;
  private procs: ChildProcess[] = [];
  private stopping = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private ports: [comfy: number, proxy: number] | null = null;
  /** Kills ComfyUI and the proxy when Hildegard's process ends any way but SIGKILL: they never outlive it. */
  private readonly onExit = () => {
    for (const p of this.procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
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
    process.removeListener('exit', this.onExit);
    process.on('exit', this.onExit);
    // Same ports across restarts, so the URL stays put; fresh ones if a restart keeps failing (something took them).
    if (!this.ports || this.failures % 3 === 2) this.ports = [await freePort(), await freePort()];
    const [comfyPort, proxyPort] = this.ports;
    const url = `http://127.0.0.1:${proxyPort}`;
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
      child.on('exit', (code, signal) => this.exited(name, code, signal));
      child.on('error', () => this.exited(name, null, null));
      this.procs.push(child);
    };
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
    writeFileSync(pidFile(this.dataDir), JSON.stringify(this.pids()), { mode: 0o600 });
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

  private exited(name: string, code: number | null, signal: NodeJS.Signals | null) {
    if (this.stopping || this.timer) return;
    // One half down takes the other with it, then both come back together on fresh ports.
    for (const p of this.procs) if (p.exitCode === null) p.kill();
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
      this.procs.map(
        (p) =>
          new Promise<void>((resolve) => {
            if (p.exitCode !== null || p.signalCode !== null) return resolve();
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
    rmSync(pidFile(this.dataDir), { force: true });
    this.set({ status: 'stopped', url: null, error: null });
  }

  private set(s: RuntimeState) {
    this.state = s;
    this.onChange(s);
  }
}
