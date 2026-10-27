// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { cpus, loadavg, platform } from 'node:os';

/** GPU use, in percent, that means something other than Hildegard is on the GPU while Hildegard renders nothing. */
export const GPU_BUSY_PERCENT = 30;
/** One-minute load per core that means the computer is busy with other work. */
export const LOAD_BUSY_PER_CORE = 0.8;

/**
 * What this computer can tell about being busy: GPU use and load (NVIDIA), load only (Linux and macOS without NVIDIA),
 * or nothing (Windows without NVIDIA, which reports no load).
 */
export type BusyCheck = 'gpu+load' | 'load' | 'none';

/**
 * Whether this computer is busy with something other than Hildegard, from what it reports: the GPU's use (NVIDIA only;
 * null without one) and the one-minute load average per core (0 on Windows, which doesn't report one). Asked only
 * while Hildegard renders nothing here, so any GPU use is someone else's. Only compute is counted: Hildegard's own
 * ComfyUI keeps models in GPU memory between renders, so memory in use says nothing about anyone else.
 */
export function busyFrom(s: { gpuPercent: number | null; load1: number; cores: number }): boolean {
  if (s.gpuPercent !== null && s.gpuPercent >= GPU_BUSY_PERCENT) return true;
  return s.cores > 0 && s.load1 / s.cores >= LOAD_BUSY_PER_CORE;
}

/** Raised when nvidia-smi is there but didn't answer: a busy or stuck driver, so treat the GPU as in use. */
export class GpuUnknown extends Error {}

/**
 * The busiest NVIDIA GPU's use in percent, or null when there is no NVIDIA GPU (no nvidia-smi). Throws GpuUnknown when
 * nvidia-smi fails, times out or answers nothing usable.
 */
export function nvidiaPercent(run: typeof execFile = execFile): Promise<number | null> {
  return new Promise((resolve, reject) => {
    run(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(null);
        if (err) return reject(new GpuUnknown(err.message));
        const v = String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^\d+(\.\d+)?$/.test(l))
          .map(Number);
        if (!v.length) return reject(new GpuUnknown('nvidia-smi gave no GPU use.'));
        resolve(Math.max(...v));
      },
    );
  });
}

/** Is something other than Hildegard using this computer now? Unknown counts as yes. */
export async function hostBusy(): Promise<boolean> {
  try {
    return busyFrom({ gpuPercent: await nvidiaPercent(), load1: loadavg()[0] ?? 0, cores: cpus().length });
  } catch {
    return true;
  }
}

/** Which check hostBusy can make on this computer. */
export async function busyCheck(
  os: NodeJS.Platform = platform(),
  run: typeof execFile = execFile,
): Promise<BusyCheck> {
  const gpu = await nvidiaPercent(run).then(
    (p) => p !== null,
    () => true,
  );
  if (gpu) return 'gpu+load';
  return os === 'win32' ? 'none' : 'load';
}
