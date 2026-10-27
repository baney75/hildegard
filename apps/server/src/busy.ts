// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { cpus, loadavg } from 'node:os';

/** GPU use, in percent, that means something other than Hildegard is on the GPU while Hildegard renders nothing. */
export const GPU_BUSY_PERCENT = 30;
/** One-minute load per core that means the computer is busy with other work. */
export const LOAD_BUSY_PER_CORE = 0.8;

/**
 * Whether this computer is busy with something other than Hildegard, from what it reports: the GPU's use (NVIDIA only;
 * null when unknown) and the one-minute load average per core (0 on Windows, which doesn't report one). Asked only
 * while Hildegard renders nothing here, so any GPU use is someone else's.
 */
export function busyFrom(s: { gpuPercent: number | null; load1: number; cores: number }): boolean {
  if (s.gpuPercent !== null && s.gpuPercent >= GPU_BUSY_PERCENT) return true;
  return s.cores > 0 && s.load1 / s.cores >= LOAD_BUSY_PER_CORE;
}

/** The busiest NVIDIA GPU's use in percent, or null without one (or without nvidia-smi). */
export function nvidiaPercent(run: typeof execFile = execFile): Promise<number | null> {
  return new Promise((resolve) => {
    run(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^\d+(\.\d+)?$/.test(l))
          .map(Number);
        resolve(v.length ? Math.max(...v) : null);
      },
    );
  });
}

/** Is something other than Hildegard using this computer now? */
export async function hostBusy(): Promise<boolean> {
  return busyFrom({ gpuPercent: await nvidiaPercent(), load1: loadavg()[0] ?? 0, cores: cpus().length });
}
