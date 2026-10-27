// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { cpus, loadavg, platform } from 'node:os';

/** GPU use, in percent, that means something other than Hildegard is on the GPU while Hildegard renders nothing. */
export const GPU_BUSY_PERCENT = 30;
/** One-minute load per core that means the computer is busy with other work. */
export const LOAD_BUSY_PER_CORE = 0.8;

/**
 * What this computer can tell about being busy: GPU use and load (NVIDIA), load only (Linux and macOS without NVIDIA),
 * nothing (Windows without NVIDIA, which reports no load), or that nvidia-smi is there but not answering, such as
 * after a driver update without a restart, which holds paired renders until it answers.
 */
export type BusyCheck = 'gpu+load' | 'load' | 'none' | 'gpu-unknown';

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

/** nvidia-smi's exit codes for "no driver loaded" (9) and "the GPU it asked about isn't there" (6). */
const NO_NVIDIA_EXIT = new Set([6, 9]);

/** The nvidia-smi still running from an earlier ask, if it never finished: a wedged driver. */
let stuck: { exitCode: number | null } | null = null;
/** The ask under way, which anyone else asking now shares, so only one nvidia-smi ever runs at a time. */
let asking: Promise<number | null> | null = null;

/**
 * The busiest NVIDIA GPU's use in percent, or null when there is none to watch: no nvidia-smi, no driver or GPU, or a
 * GPU that reports no use figure (MIG, some vGPUs). On a computer known to render on NVIDIA (`nvidia`), a missing
 * nvidia-smi or one that finds no GPU means it can't be read, not that there is none. Throws GpuUnknown when it can't
 * be read, fails otherwise, times out, or an earlier one is still stuck. Callers asking at the same time share one
 * nvidia-smi, so at most one ever waits on a wedged driver.
 */
export function nvidiaPercent(run: typeof execFile = execFile, nvidia = false): Promise<number | null> {
  if (asking) return asking;
  const ask = new Promise<number | null>((resolve, reject) => {
    if (stuck && stuck.exitCode === null)
      return reject(new GpuUnknown('nvidia-smi is still stuck from before.'));
    stuck = null;
    // A wedged driver can leave nvidia-smi stuck where no signal ends it, and then no answer would ever come: give up
    // on it after 3.5 s, whatever the process does.
    const deadline = setTimeout(() => {
      // Only one that outlived its deadline counts as stuck; one still running inside it is just slow.
      if (child && child.exitCode === null) stuck = child;
      reject(new GpuUnknown('nvidia-smi didn’t answer in time.'));
    }, 3500);
    deadline.unref?.();
    let child: { exitCode: number | null } | undefined;
    child = run(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        clearTimeout(deadline);
        if (child && stuck === child) stuck = null;
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || (typeof code === 'number' && NO_NVIDIA_EXIT.has(code)))
          return nvidia
            ? reject(new GpuUnknown('This computer has an NVIDIA GPU nvidia-smi can’t read.'))
            : resolve(null);
        if (err) return reject(new GpuUnknown(err.message));
        const v = String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^\d+(\.\d+)?$/.test(l))
          .map(Number);
        // Answered, but with no figure ("[N/A]"): watch the load alone.
        resolve(v.length ? Math.max(...v) : null);
      },
    ) as { exitCode: number | null } | undefined;
  });
  asking = ask;
  const done = () => {
    if (asking === ask) asking = null;
  };
  ask.then(done, done);
  return ask;
}

/** Is something other than Hildegard using this computer now? Unknown counts as yes. */
export async function hostBusy(nvidia = false): Promise<boolean> {
  try {
    return busyFrom({
      gpuPercent: await nvidiaPercent(execFile, nvidia),
      load1: loadavg()[0] ?? 0,
      cores: cpus().length,
    });
  } catch {
    return true;
  }
}

/** Which check hostBusy can make on this computer. */
export async function busyCheck(
  os: NodeJS.Platform = platform(),
  run: typeof execFile = execFile,
  nvidia = false,
): Promise<BusyCheck> {
  const gpu = await nvidiaPercent(run, nvidia).then(
    (p): BusyCheck | null => (p === null ? null : 'gpu+load'),
    (): BusyCheck => 'gpu-unknown',
  );
  return gpu ?? (os === 'win32' ? 'none' : 'load');
}
