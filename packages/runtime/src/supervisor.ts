// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { layout, readRuntime } from './install.ts';

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
export class ComfyRuntime {
  readonly dataDir: string;
  private readonly onChange: (s: RuntimeState) => void;
  private procs: ChildProcess[] = [];
  private stopping = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private ports: [comfy: number, proxy: number] | null = null;
  state: RuntimeState = { status: 'stopped', url: null, error: null };

  constructor(opts: { dataDir: string; onChange?: (s: RuntimeState) => void }) {
    this.dataDir = opts.dataDir;
    this.onChange = opts.onChange ?? (() => {});
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
    this.set({ status: 'stopped', url: null, error: null });
  }

  private set(s: RuntimeState) {
    this.state = s;
    this.onChange(s);
  }
}
