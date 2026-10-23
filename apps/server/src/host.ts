// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Host mode: this Hildegard at a link, for the owner on their other devices and the people they invite. With
 * Tailscale it asks `tailscale serve` (HTTPS on the tailnet) or, only when the owner says so, `tailscale funnel`
 * (HTTPS on the public internet) to forward to a listener of its own on 127.0.0.1, where every request must sign in.
 * Without either it can answer on this computer's Tailscale address. Neither ComfyUI nor the paired-device API is
 * ever behind the link.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostState } from '@hildegard/presets';
import { privateLink } from './choir.ts';

export class HostError extends Error {
  readonly status: 400 | 409 | 502;
  /** What the owner can do about it: a command, or a page to open. */
  readonly fix: string | null;
  constructor(status: HostError['status'], message: string, fix: string | null = null) {
    super(message);
    this.name = 'HostError';
    this.status = status;
    this.fix = fix;
  }
}

/** Runs a command without a shell; resolves with its output and whether it succeeded. */
export type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string }>;
export const exec: Exec = (cmd, args, timeoutMs = 20_000) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    );
  });

const tailscaleCmds = () =>
  process.platform === 'darwin'
    ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
    : ['tailscale'];

export interface Tailnet {
  /** The command that answered. */
  cmd: string;
  /** Full MagicDNS name, such as parish1.tail1234.ts.net, when MagicDNS is on. */
  dns: string | null;
  ip: string;
}

/** This computer on its tailnet, or null when Tailscale isn't installed, running or signed in. */
export async function tailnetSelf(run: Exec = exec): Promise<Tailnet | null> {
  for (const cmd of tailscaleCmds()) {
    const r = await run(cmd, ['status', '--json'], 5000);
    if (!r.ok && !r.out.startsWith('{')) continue;
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{'))) as {
        BackendState?: string;
        Self?: { DNSName?: string; TailscaleIPs?: string[] };
      };
      const ip = j.Self?.TailscaleIPs?.find((x) => /^100\./.test(x)) ?? j.Self?.TailscaleIPs?.[0];
      if (j.BackendState !== 'Running' || !ip) return null;
      const dns = (j.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
      return { cmd, ip, dns: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dns) ? dns : null };
    } catch {
      return null;
    }
  }
  return null;
}

/** The ports Tailscale Funnel may use; Serve uses the first that nothing else serves on. */
const HTTPS_PORTS = [443, 8443, 10000] as const;
const LOGIN_LINK = /https:\/\/login\.tailscale\.com\/\S+/;

interface HostFile {
  on: boolean;
  via: 'tailscale' | 'funnel' | 'address';
  /** The Tailscale HTTPS port, for Serve and Funnel. */
  httpsPort?: number;
  /** The address to answer on, for `address`. */
  address?: string;
  url: string;
}

export interface HostOptions {
  dataDir: string;
  /** Hildegard's own port: an `address` host answers on it. */
  port: () => number;
  /** The listener Serve and Funnel forward to. */
  hostPort: () => number;
  run?: Exec;
  onChange?: (s: HostState) => void;
  /** Whether the owner account exists. */
  owner: () => boolean;
}

export class Host {
  private readonly file: string;
  private saved: HostFile | null;
  private readonly run: Exec;
  private readonly opts: HostOptions;
  private tailnet: Tailnet | null = null;
  private tailnetAt = 0;
  problem: string | null = null;
  fix: string | null = null;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.run = opts.run ?? exec;
    this.file = join(opts.dataDir, 'host.json');
    try {
      this.saved = JSON.parse(readFileSync(this.file, 'utf8')) as HostFile;
    } catch {
      this.saved = null;
    }
  }

  private save(f: HostFile | null) {
    this.saved = f;
    mkdirSync(this.opts.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(f ?? { on: false }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** Tailscale here, asked at most every 15 seconds. */
  async tailscale(fresh = false): Promise<Tailnet | null> {
    if (fresh || Date.now() - this.tailnetAt > 15_000) {
      this.tailnet = await tailnetSelf(this.run);
      this.tailnetAt = Date.now();
    }
    return this.tailnet;
  }

  /** What the main app needs: whether a link is on, and the names it answers to. */
  current(): { on: boolean; via: HostFile['via'] | null; address: string | null; names: string[] } {
    const f = this.saved?.on ? this.saved : null;
    const names: string[] = [];
    if (f) {
      try {
        names.push(new URL(f.url).hostname.toLowerCase());
      } catch {}
    }
    if (this.tailnet?.dns) names.push(this.tailnet.dns);
    return {
      on: !!f,
      via: f?.via ?? null,
      address: f?.via === 'address' ? (f.address ?? null) : null,
      names,
    };
  }

  state(): HostState {
    const f = this.saved?.on ? this.saved : null;
    return {
      on: !!f,
      via: f?.via ?? null,
      url: f && !this.problem ? f.url : null,
      problem: this.problem,
      fix: this.fix,
      tailscale: {
        running: !!this.tailnet,
        name: this.tailnet?.dns ?? null,
        ip: this.tailnet?.ip ?? null,
      },
      owner: this.opts.owner(),
    };
  }

  private emit() {
    this.opts.onChange?.(this.state());
  }

  private target = () => `http://127.0.0.1:${this.opts.hostPort()}`;

  /** What Tailscale already serves on each HTTPS port of this machine. */
  private async served(ts: Tailnet): Promise<Map<number, string>> {
    const r = await this.run(ts.cmd, ['serve', 'status', '--json'], 8000);
    const out = new Map<number, string>();
    if (!r.ok) return out;
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{'))) as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
      };
      for (const [hostPort, web] of Object.entries(j.Web ?? {})) {
        const port = Number(hostPort.split(':').pop());
        const h = Object.values(web.Handlers ?? {})[0];
        out.set(port, h?.Proxy ?? h?.Path ?? h?.Text ?? 'something');
      }
    } catch {}
    return out;
  }

  /** Turn the link on. `via` defaults to Tailscale Serve; Funnel only ever when asked for by name. */
  async on(opts: { via?: 'tailscale' | 'funnel' | 'address'; address?: string } = {}): Promise<HostState> {
    if (!this.opts.owner())
      throw new HostError(
        409,
        'Make the owner account first, so you can sign in from your other devices.',
        'hildegard host owner',
      );
    const ts = await this.tailscale(true);
    const via = opts.via ?? (opts.address ? 'address' : 'tailscale');

    if (via === 'address') {
      const address = (opts.address ?? ts?.ip ?? '').replace(/^\[|\]$/g, '');
      if (!address)
        throw new HostError(
          409,
          'Tailscale isn’t running on this computer. Install it and sign in, then try again.',
          'tailscale up',
        );
      const bracket = address.includes(':') ? `[${address}]` : address;
      let u: URL;
      try {
        u = new URL(`http://${bracket}:${this.opts.port()}`);
      } catch {
        throw new HostError(400, 'That isn’t an address, like 100.101.102.103.');
      }
      if (!privateLink(u) || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        throw new HostError(
          400,
          'Hildegard answers over plain HTTP only on your Tailscale address, where WireGuard encrypts it, so passphrases never cross a network in the clear. For anything else, use Tailscale Serve or Funnel, which give it HTTPS.',
        );
      this.save({ on: true, via, address, url: u.origin });
      this.problem = null;
      this.fix = null;
      this.emit();
      return this.state();
    }

    if (!ts)
      throw new HostError(
        409,
        'Tailscale isn’t running on this computer. Install it from tailscale.com and sign in, then try again.',
        'tailscale up',
      );
    if (!ts.dns)
      throw new HostError(
        409,
        'Turn on MagicDNS and HTTPS certificates for your tailnet, so Hildegard gets a name and HTTPS.',
        'https://login.tailscale.com/admin/dns',
      );
    const busy = await this.served(ts);
    const mine = this.saved?.httpsPort;
    const port =
      mine && (!busy.has(mine) || busy.get(mine) === this.target())
        ? mine
        : HTTPS_PORTS.find((p) => !busy.has(p) || busy.get(p) === this.target());
    if (!port)
      throw new HostError(
        409,
        `Tailscale already serves something else on ports ${HTTPS_PORTS.join(', ')} of this computer. Free one with \`tailscale serve --https=443 off\`.`,
      );
    // Funnel off first when going back to Serve, and the other way round, so only one of them forwards.
    if (this.saved?.on && this.saved.httpsPort && (this.saved.via !== via || this.saved.httpsPort !== port))
      await this.tailscaleOff(ts, this.saved.via, this.saved.httpsPort);
    const r = await this.run(ts.cmd, [
      via === 'funnel' ? 'funnel' : 'serve',
      '--bg',
      `--https=${port}`,
      this.target(),
    ]);
    if (!r.ok) throw this.explain(r.out, via);
    const url = `https://${ts.dns}${port === 443 ? '' : `:${port}`}`;
    this.save({ on: true, via, httpsPort: port, url });
    this.problem = null;
    this.fix = null;
    this.emit();
    return this.state();
  }

  /** Turn Tailscale's own failure into a sentence, and what to do about it. */
  private explain(out: string, via: 'tailscale' | 'funnel'): HostError {
    const link = LOGIN_LINK.exec(out)?.[0] ?? null;
    if (/access denied|permission|operator|sudo/i.test(out))
      return new HostError(
        409,
        'Tailscale needs your permission to let Hildegard set up its link. Run the command, then try again.',
        process.platform === 'linux'
          ? 'sudo tailscale set --operator=$USER'
          : 'tailscale set --operator=$USER',
      );
    if (link)
      return new HostError(
        409,
        via === 'funnel'
          ? 'Funnel isn’t turned on for your tailnet yet. Open the page to turn it on, then try again.'
          : 'HTTPS isn’t turned on for your tailnet yet. Open the page to turn it on, then try again.',
        link,
      );
    const first = out.split('\n').find((l) => l.trim()) ?? 'it gave no reason';
    return new HostError(502, `Tailscale couldn’t set up the link: ${first.slice(0, 200)}`);
  }

  private async tailscaleOff(ts: Tailnet, via: HostFile['via'], port: number) {
    if (via === 'address') return;
    await this.run(ts.cmd, [via === 'funnel' ? 'funnel' : 'serve', `--https=${port}`, 'off']);
  }

  /** Turn the link off. Accounts and sessions stay, for the next time. */
  async off(): Promise<HostState> {
    const f = this.saved;
    if (f?.on && f.httpsPort) {
      const ts = await this.tailscale(true);
      if (ts) await this.tailscaleOff(ts, f.via, f.httpsPort);
    }
    this.save(f ? { ...f, on: false } : null);
    this.problem = null;
    this.fix = null;
    this.emit();
    return this.state();
  }

  /** At start: make sure Tailscale still forwards the link here, as it should after a reboot. */
  async resume(): Promise<void> {
    const f = this.saved;
    await this.tailscale(true);
    if (!f?.on || f.via === 'address') {
      this.emit();
      return;
    }
    try {
      await this.on({ via: f.via });
    } catch (e) {
      this.problem = (e as Error).message;
      this.fix = e instanceof HostError ? e.fix : null;
      this.emit();
    }
  }

  /** The bound listener couldn't open: say so on the state. */
  setProblem(problem: string | null, fix: string | null = null) {
    if (this.problem === problem && this.fix === fix) return;
    this.problem = problem;
    this.fix = fix;
    this.emit();
  }
}
