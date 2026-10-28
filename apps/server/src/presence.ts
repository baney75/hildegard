// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What opportunistic sharing sees of someone else wanting this computer, beyond the GPU's use and the load (busy.ts):
 * the owner at the keyboard, and other programs holding GPU memory (a language model server waiting for requests
 * holds gigabytes and uses no compute, so its GPU use alone says nothing). Either one holds paired devices' renders,
 * and stops one that is rendering; it goes back in line and starts again by itself once the computer is free.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** How long since the owner last typed or moved the mouse, in seconds; null when this computer can't say. */
export type IdleSource = () => Promise<number | null>;
/** Other programs using a lot of GPU memory, by name; null when this computer can't say. */
export type GpuSource = () => Promise<string[] | null>;

/** How long after the owner's last input the computer counts as theirs. */
export const AWAY_AFTER_MINUTES = 3;
/** GPU memory another program must hold before it counts: more than a desktop or a browser uses. */
const OTHER_GPU_MIB = 1024;

const plain = (s: string) => s.replace(/[^\p{L}\p{N} ._+-]+/gu, '').slice(0, 40);

/**
 * Why paired renders should wait now, in a sentence, or null. The owner is "here" from their last input until
 * AWAY_AFTER_MINUTES have passed; another program on the GPU counts while it holds the memory.
 */
export function presenceReason(idleSec: number | null, others: string[] | null): string | null {
  if (others?.length)
    return `${others.length === 1 ? plain(others[0]!) : `${others.length} other programs`} ${others.length === 1 ? 'is' : 'are'} using the GPU.`;
  if (idleSec !== null && idleSec < AWAY_AFTER_MINUTES * 60) return 'Someone is using this computer.';
  return null;
}

export class Presence {
  private readonly idle: IdleSource;
  private readonly gpu: GpuSource;
  private readonly now: () => number;
  /** The owner said they're away (or back) through an idle hook (Omarchy's panel), until it expires. */
  private told: { away: boolean; until: number } | null = null;
  /** The look in progress, which a second caller shares rather than starting another. */
  private looking: Promise<string | null> | null = null;
  /** Whether this computer can tell when someone uses it; false on a headless box, where only the GPU counts. */
  sees: boolean | null = null;

  constructor(opts: { idle?: IdleSource; gpu?: GpuSource; now?: () => number } = {}) {
    this.idle = opts.idle ?? (async () => null);
    this.gpu = opts.gpu ?? (async () => null);
    this.now = opts.now ?? Date.now;
  }

  /**
   * The owner says they're away or back, from an idle hook (Hyprland has no idle clock to ask). It holds until the
   * next word, or `minutes`, a day unless given.
   */
  tell(away: boolean, minutes = 1440) {
    this.told = { away, until: this.now() + minutes * 60_000 };
  }

  /** Why someone else wants this computer now, or null. Callers at the same time share one look. */
  reason(): Promise<string | null> {
    this.looking ??= this.look().finally(() => {
      this.looking = null;
    });
    return this.looking;
  }

  private async look(): Promise<string | null> {
    if (this.told && this.now() > this.told.until) this.told = null;
    const [idle, others] = await Promise.all([
      this.told
        ? Promise.resolve(this.told.away ? Number.POSITIVE_INFINITY : 0)
        : this.idle().catch(() => null),
      this.gpu().catch(() => null),
    ]);
    this.sees = idle !== null;
    return presenceReason(idle, others);
  }
}

// ── Seeing the owner: each system's own idle clock ─────────────────────────────────────────────────────────────

type Exec = (cmd: string, args: string[]) => Promise<string | null>;
const exec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 1500, windowsHide: true }, (err, out) =>
      resolve(err ? null : out),
    );
  });

/** macOS: IOKit's HIDIdleTime, in nanoseconds. */
export function parseMacIdle(out: string | null): number | null {
  const m = out && /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
  return m ? Number(m[1]) / 1e9 : null;
}

/** GNOME's Mutter answers "(uint64 1234,)", in milliseconds; xprintidle prints milliseconds. */
export function parseMillis(out: string | null): number | null {
  const m = out && /(\d+)/.exec(out.replace(/uint64/, ''));
  return m ? Number(m[1]) / 1000 : null;
}

/** systemd-logind: IdleHint=yes with IdleSinceHint in microseconds since the epoch; no means someone is there. */
export function parseLogind(out: string | null, nowMs: number): number | null {
  if (!out) return null;
  const hint = /IdleHint=(yes|no)/.exec(out)?.[1];
  if (!hint) return null;
  if (hint === 'no') return 0;
  const since = Number(/IdleSinceHint=(\d+)/.exec(out)?.[1] ?? 0);
  return since > 0 ? Math.max(0, nowMs / 1000 - since / 1e6) : Number.POSITIVE_INFINITY;
}

/**
 * The idle clock of the desktop Hildegard runs under, tried in order, and the first that answers is kept. A server
 * with no one signed in has none: there only another program on the GPU counts.
 */
export function systemIdle(run: Exec = exec, platform = process.platform): IdleSource {
  if (platform === 'darwin')
    return async () => parseMacIdle(await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']));
  if (platform === 'win32') return windowsIdle();
  const tries: Array<() => Promise<number | null>> = [
    async () =>
      parseMillis(
        await run('gdbus', [
          'call',
          '--session',
          '--dest',
          'org.gnome.Mutter.IdleMonitor',
          '--object-path',
          '/org/gnome/Mutter/IdleMonitor/Core',
          '--method',
          'org.gnome.Mutter.IdleMonitor.GetIdletime',
        ]),
      ),
    // X11 only: under Wayland it would see XWayland's apps alone.
    async () => (process.env.WAYLAND_DISPLAY ? null : parseMillis(await run('xprintidle', []))),
    async () => {
      const id = process.env.XDG_SESSION_ID;
      return id
        ? parseLogind(
            await run('loginctl', ['show-session', id, '-p', 'IdleHint', '-p', 'IdleSinceHint']),
            Date.now(),
          )
        : null;
    },
  ];
  let found: (() => Promise<number | null>) | null = null;
  let nextLook = 0;
  return async () => {
    if (found) return found();
    // None answered: look again in a minute, since a desktop can start after Hildegard does.
    if (Date.now() < nextLook) return null;
    for (const t of tries) {
      const v = await t();
      if (v !== null) {
        found = t;
        return v;
      }
    }
    nextLook = Date.now() + 60_000;
    return null;
  };
}

/**
 * Windows: GetLastInputInfo, from one PowerShell kept running (starting one each time takes a second). It sees the
 * signed-in desktop when Hildegard runs in it, as the app does; started as a service it sees nothing.
 */
function windowsIdle(): IdleSource {
  let child: ChildProcess | null = null;
  let last: { sec: number; at: number } | null = null;
  const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class HgIdle { [StructLayout(LayoutKind.Sequential)] struct L { public uint s; public uint t; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l);
public static double Sec() { var l = new L(); l.s = 8; if (!GetLastInputInfo(ref l)) return -1;
return ((uint)Environment.TickCount - l.t) / 1000.0; } }
'@
while ($true) { [Console]::Out.WriteLine([HgIdle]::Sec()); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1500 }`;
  const startChild = () => {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.unref();
    let buf = '';
    child.stdout?.on('data', (b: Buffer) => {
      buf += b.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop()!;
      const v = Number(lines.at(-1));
      if (Number.isFinite(v) && v >= 0) last = { sec: v, at: Date.now() };
    });
    child.on('exit', () => {
      child = null;
    });
  };
  return async () => {
    if (!child) startChild();
    return last && Date.now() - last.at < 6000 ? last.sec + (Date.now() - last.at) / 1000 : null;
  };
}

// ── Other programs on the GPU ──────────────────────────────────────────────────────────────────────────────────

/**
 * nvidia-smi's compute processes: pid, name, MiB. Ours are left out by pid, ComfyUI's and the voice workers' alike,
 * along with anything under Hildegard's own process; what's left with more than a desktop's worth of memory counts.
 */
export function parseComputeApps(out: string | null, ours: (pid: number) => boolean): string[] | null {
  if (out === null) return null;
  const names: string[] = [];
  for (const line of out.trim().split(/\r?\n/)) {
    const [pid, name, mib] = line.split(',').map((s) => s.trim());
    const p = Number(pid);
    if (!Number.isInteger(p) || p <= 0 || ours(p)) continue;
    // Memory reads [N/A] on some systems (and per process under WSL): then any compute program counts.
    const m = Number(mib);
    if (Number.isFinite(m) && m < OTHER_GPU_MIB) continue;
    names.push((name ?? '').split(/[\\/]/).pop() || 'Another program');
  }
  return names;
}

/** Whether `pid` is this server or runs under it (ComfyUI, comfy-api-proxy, the voice workers), on Linux. */
export function underUs(pid: number, read: (p: string) => string | null, self = process.pid): boolean {
  for (let p = pid, hops = 0; p > 1 && hops < 32; hops++) {
    if (p === self) return true;
    // /proc/<pid>/stat: "pid (name) state ppid ...", where the name may hold spaces and parentheses.
    const stat = read(`/proc/${p}/stat`);
    const ppid = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) : Number.NaN;
    if (!Number.isInteger(ppid)) return false;
    p = ppid;
  }
  return false;
}

/**
 * Linux only: elsewhere there's no /proc to tell Hildegard's own processes by (Windows' venv python.exe is a
 * launcher whose child holds the GPU), so other programs' GPU memory isn't watched there; GPU use still is (busy.ts).
 */
export function nvidiaOthers(
  run: Exec = exec,
  extra: () => number[] = () => [],
  platform = process.platform,
): GpuSource {
  if (platform !== 'linux') return async () => null;
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  return async () => {
    const out = await run('nvidia-smi', [
      '--query-compute-apps=pid,process_name,used_memory',
      '--format=csv,noheader,nounits',
    ]);
    const mine = new Set(extra());
    return parseComputeApps(out, (pid) => mine.has(pid) || underUs(pid, read));
  };
}

/**
 * The GPU-memory source for a server: only with the ComfyUI Hildegard runs itself, whose processes it can leave out.
 * One started apart (--comfy) is no process of Hildegard's, and would count as another program on the GPU.
 */
export function gpuSourceFor(
  fake: boolean,
  runtime: { pids(): number[] } | null,
  others: typeof nvidiaOthers = nvidiaOthers,
): GpuSource | undefined {
  if (fake || !runtime) return undefined;
  return others(undefined, () => runtime.pids());
}
