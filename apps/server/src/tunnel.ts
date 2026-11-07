// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tunnels on accounts the owner holds, so they reach this Hildegard from their other devices. Two providers, each
 * with a free account the owner makes on the provider's own page (Hildegard never makes one) or already has:
 *
 * - Tailscale: `tailscale serve` (the tailnet only) or, when asked by name, `tailscale funnel`. host.ts runs those.
 * - Cloudflare: a named tunnel, `hildegard-<computer>`, on a domain in the owner's account, for a name that stays the
 *   same; or a quick tunnel (a trycloudflare.com name that changes on every start, no account), as the labeled
 *   fallback. Here, `Cloudflared` signs in with `cloudflared tunnel login`, makes the tunnel and its DNS record, and
 *   runs `cloudflared` as a child it restarts, forwarding to the hosted listener, where every request signs in.
 *
 * Nothing is installed unless the owner asks: `hildegard tunnel install cloudflare`, or the button in Settings, fetches
 * the pinned cloudflared into Hildegard's own tools folder. The tunnel's credentials go to the keychain and reach
 * cloudflared in its environment, never in a file, on its command line or in the log. Whether this computer is signed
 * in to Cloudflare is told by cert.pem being there; Hildegard never reads it.
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { HostState, TunnelProvider, TunnelReport } from '@hildegard/presets';
import { parsePublicUrl } from '@hildegard/presets';
import { CLOUDFLARED, cloudflaredPath, downloadCloudflared } from '@hildegard/runtime';
import type { SecretStore } from './hf.ts';
import { type Exec, exec, HostError, type TunnelControl, tailscaleCmds } from './host.ts';

export const TAILSCALE_PAGES = {
  signup: 'https://login.tailscale.com/start',
  download: 'https://tailscale.com/download',
};
export const CLOUDFLARE_PAGES = {
  signup: 'https://dash.cloudflare.com/sign-up',
  download: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
};

/** The command that installs Tailscale on this kind of computer, for the owner to run. */
export function tailscaleInstall(platform = process.platform): string | null {
  if (platform === 'linux') return 'curl -fsSL https://tailscale.com/install.sh | sh';
  if (platform === 'darwin') return 'brew install --cask tailscale';
  if (platform === 'win32') return 'winget install --id Tailscale.Tailscale';
  return null;
}

/** Hildegard can fetch the pinned cloudflared for this computer. */
export const canFetchCloudflared = (platform = process.platform, arch = process.arch) =>
  !!CLOUDFLARED.assets[`${platform}-${arch}`];

/** The command that installs cloudflared: Hildegard's own fetch where it has a build, else the platform's manager. */
export function cloudflaredInstall(platform = process.platform, arch = process.arch): string | null {
  if (canFetchCloudflared(platform, arch)) return 'hildegard tunnel install cloudflare';
  if (platform === 'darwin') return 'brew install cloudflared';
  if (platform === 'win32') return 'winget install --id Cloudflare.cloudflared';
  return null;
}

// ── Tailscale ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TailscaleInfo {
  installed: boolean;
  version: string | null;
  /** Tailscale's own word: Running, NeedsLogin, Stopped, NoState, Starting; null when its service didn't answer. */
  backend: string | null;
}

/** Whether Tailscale is installed here, and signed in. `tailscale version` answers even while its service is down. */
export async function tailscaleInfo(run: Exec = exec): Promise<TailscaleInfo> {
  for (const cmd of tailscaleCmds()) {
    const v = await run(cmd, ['version'], 5000);
    const version = v.ok ? (v.out.split('\n')[0]?.trim() ?? '') : '';
    if (!v.ok || !/^\d+\.\d+/.test(version)) continue;
    const s = await run(cmd, ['status', '--json'], 5000);
    let backend: string | null = null;
    try {
      backend =
        (JSON.parse(s.out.slice(s.out.indexOf('{'))) as { BackendState?: string }).BackendState ?? null;
    } catch {}
    return { installed: true, version, backend };
  }
  return { installed: false, version: null, backend: null };
}

function tailscaleProvider(ts: TailscaleInfo, host: HostState, ports: number[]): TunnelReport['tailscale'] {
  const forwarding = ports.length > 0;
  const signedIn = ts.backend === 'Running';
  const mine = host.on && (host.via === 'tailscale' || host.via === 'funnel');
  const base = {
    installed: ts.installed,
    signedIn,
    version: ts.version,
    ...TAILSCALE_PAGES,
    install: tailscaleInstall(),
    signIn:
      process.platform === 'darwin' || process.platform === 'win32'
        ? 'Open the Tailscale app and sign in'
        : 'tailscale up',
    name: host.tailscale.name,
    funnel: mine && host.via === 'funnel',
    forwarding,
  };
  if (mine && host.problem) return { ...base, state: 'problem', problem: host.problem, fix: host.fix };
  if (mine && host.url) return { ...base, state: 'on', problem: null, fix: null };
  // Off by Hildegard's account, but Tailscale still forwards here (it refused to turn the route off): say so.
  if (forwarding && !mine)
    return {
      ...base,
      state: 'problem',
      problem: 'Tailscale still forwards a link to this Hildegard, though the link is off.',
      // Only Hildegard's own route, by its port: never a reset, which would end every other route here too.
      fix: `tailscale serve --https=${ports[0]} off`,
    };
  if (!ts.installed)
    return {
      ...base,
      state: 'missing',
      problem: 'Tailscale isn’t installed here.',
      fix: base.install ?? TAILSCALE_PAGES.download,
    };
  if (!signedIn)
    return {
      ...base,
      state: 'signed-out',
      problem:
        ts.backend === 'Stopped'
          ? 'Tailscale is signed in but turned off here.'
          : ts.backend
            ? 'This computer isn’t signed in to Tailscale.'
            : 'Tailscale is installed, but its service isn’t running.',
      fix: ts.backend
        ? base.signIn
        : process.platform === 'linux'
          ? 'sudo systemctl enable --now tailscaled'
          : base.signIn,
    };
  return { ...base, state: 'ready', problem: null, fix: null };
}

// ── Cloudflare ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of a child process the supervisor uses; tests give a stand-in. */
export interface Child {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type Spawn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Child;
const spawnChild: Spawn = (cmd, args, env) =>
  nodeSpawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) as ChildProcess;

const QUICK_URL = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;
const LOGIN_URL = /https:\/\/dash\.cloudflare\.com\/argotunnel\S+/;
const CONNECTED = /Registered tunnel connection/;

/** `My-PC.local` → `hildegard-my-pc-local`: the tunnel's name in the owner's account, one per computer. */
export function tunnelName(computer = osHostname()): string {
  const slug = computer
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `hildegard-${slug || 'computer'}`;
}

/** A host name people will open, such as hildegard.example.com: a public DNS name, lower case, no scheme or path. */
export function parseTunnelHostname(
  raw: unknown,
): { ok: true; hostname: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim())
    return {
      ok: false,
      error: 'Say the name people will open, on a domain in your Cloudflare account: hildegard.example.com.',
    };
  const name = raw
    .trim()
    .replace(/^https:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();
  const p = parsePublicUrl(`https://${name}`);
  if (!p.ok) return { ok: false, error: p.error };
  const u = new URL(p.url);
  if (u.port) return { ok: false, error: 'Leave the port out: a Cloudflare tunnel answers on 443.' };
  if (/\.(trycloudflare\.com|ts\.net)$/.test(u.hostname))
    return { ok: false, error: 'Use a name on a domain in your own Cloudflare account.' };
  return { ok: true, hostname: u.hostname };
}

/** Where cloudflared looks for cert.pem, the sign-in `cloudflared tunnel login` writes, in its own order. */
function certPaths(home: string, env: NodeJS.ProcessEnv): string[] {
  if (env.TUNNEL_ORIGIN_CERT) return [env.TUNNEL_ORIGIN_CERT];
  const dirs = [join(home, '.cloudflared'), join(home, '.cloudflare-warp'), join(home, 'cloudflare-warp')];
  if (process.platform !== 'win32') dirs.push('/etc/cloudflared', '/usr/local/etc/cloudflared');
  return dirs.map((d) => join(d, 'cert.pem'));
}

/**
 * The environment for `cloudflared tunnel login` where it would use xdg-open: no display and a browser that does
 * nothing, so xdg-open opens no window. cloudflared still prints the page, which goes to the owner.
 */
export function quietBrowser(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPLAY: _d, WAYLAND_DISPLAY: _w, XDG_CURRENT_DESKTOP: _x, ...rest } = env;
  return { ...rest, BROWSER: 'true' };
}

const firstLine = (out: string) =>
  (
    out
      .split('\n')
      .map((l) => l.replace(/^\S+Z\s+(ERR|INF|WRN)\s+/, '').trim())
      .find((l) => l && !/^(Thank you|Please open|If the browser)/.test(l)) ?? 'it gave no reason'
  ).slice(0, 200);

export interface CloudflaredOptions {
  dataDir: string;
  run?: Exec;
  spawn?: Spawn;
  /** Where the tunnels' credentials go: the keychain by default. */
  secrets: (account: string) => SecretStore;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** This computer's name, for the tunnel's. */
  computer?: string;
  /** How long cloudflared has to connect. */
  readyMs?: number;
  /** The first wait before starting cloudflared again after it stops on its own; it doubles each time, up to a minute. */
  restartMs?: number;
  /** A quick tunnel came back under a new name after cloudflared restarted. */
  onUrl?: (url: string) => void;
  /** Something the report shows changed: a sign-in finished, the tunnel stopped or came back. */
  onChange?: () => void;
  /** The command line of a process, to tell an old cloudflared of Hildegard's from someone else's. */
  commandOf?: (pid: number) => Promise<string | null>;
}

interface Want {
  kind: 'cloudflare' | 'quick';
  args: string[];
  env: NodeJS.ProcessEnv;
  hostname: string | null;
}

async function commandOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux')
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      return null;
    }
  if (process.platform === 'win32') return null;
  const r = await exec('ps', ['-p', String(pid), '-o', 'command='], 5000);
  return r.ok ? r.out : null;
}

export class Cloudflared implements TunnelControl {
  private readonly o: CloudflaredOptions;
  private readonly run: Exec;
  private readonly spawn: Spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  readonly dir: string;
  readonly log: string;
  private readonly pidFile: string;
  private bin: { path: string; version: string } | null = null;
  private binAt = 0;
  private want: Want | null = null;
  private child: Child | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private startedAt = 0;
  url: string | null = null;
  problem: string | null = null;
  fix: string | null = null;
  tunnel: { name: string; id: string } | null = null;
  private loginChild: Child | null = null;
  signingIn: string | null = null;

  constructor(o: CloudflaredOptions) {
    this.o = o;
    this.run = o.run ?? exec;
    this.spawn = o.spawn ?? spawnChild;
    this.env = o.env ?? process.env;
    this.home = o.home ?? homedir();
    this.dir = join(o.dataDir, 'tunnel');
    this.log = join(this.dir, 'cloudflared.log');
    this.pidFile = join(this.dir, 'cloudflared.pid');
  }

  get name(): string {
    return tunnelName(this.o.computer);
  }

  get running(): boolean {
    return !!this.want && !!this.url && !this.problem;
  }

  get kind(): 'cloudflare' | 'quick' | null {
    return this.want?.kind ?? null;
  }

  /** cloudflared here: the pinned one Hildegard fetched, then the owner's own. Asked at most every 15 seconds. */
  async find(fresh = false): Promise<{ path: string; version: string } | null> {
    if (!fresh && Date.now() - this.binAt < 15_000) return this.bin;
    const win = process.platform === 'win32';
    const candidates = [
      this.env.HILDEGARD_CLOUDFLARED,
      cloudflaredPath(this.o.dataDir),
      'cloudflared',
      ...(process.platform === 'darwin'
        ? ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']
        : []),
      ...(win
        ? [
            join(
              this.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
              'cloudflared',
              'cloudflared.exe',
            ),
            join(this.env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
          ]
        : []),
    ].filter((c): c is string => !!c);
    this.bin = null;
    for (const path of candidates) {
      const r = await this.run(path, ['--version'], 5000);
      const m = r.ok ? /cloudflared version (\S+)/.exec(r.out) : null;
      if (m) {
        this.bin = { path, version: m[1]! };
        break;
      }
    }
    this.binAt = Date.now();
    return this.bin;
  }

  /** This computer is signed in to a Cloudflare account: cert.pem is where cloudflared looks. Never read. */
  signedIn(): boolean {
    return certPaths(this.home, this.env).some((p) => existsSync(p));
  }

  /** Fetch the pinned cloudflared into Hildegard's tools folder. Only ever on the owner's word. */
  async install(): Promise<{ path: string; version: string }> {
    if (!canFetchCloudflared())
      throw new HostError(
        409,
        'Hildegard has no cloudflared to fetch for this kind of computer. Install it from Cloudflare’s page.',
        cloudflaredInstall() ?? CLOUDFLARE_PAGES.download,
      );
    try {
      await downloadCloudflared(this.o.dataDir, this.o.fetch ?? fetch);
    } catch (e) {
      throw new HostError(502, (e as Error).message, CLOUDFLARE_PAGES.download);
    }
    const bin = await this.find(true);
    if (!bin)
      throw new HostError(502, 'cloudflared downloaded but doesn’t run here.', CLOUDFLARE_PAGES.download);
    this.o.onChange?.();
    return bin;
  }

  private async need(): Promise<{ path: string; version: string }> {
    const bin = await this.find(true);
    if (!bin)
      throw new HostError(
        409,
        'cloudflared isn’t installed here. Install it, then try again. Hildegard never installs it unless you ask.',
        cloudflaredInstall() ?? CLOUDFLARE_PAGES.download,
      );
    return bin;
  }

  /**
   * Sign this computer in to the owner's Cloudflare account: `cloudflared tunnel login`, whose page the owner opens
   * (cloudflared also tries to open it here). Resolves with that page, or `done` when already signed in.
   */
  async login(): Promise<{ done: boolean; url: string | null; opened: boolean }> {
    // On macOS and Windows cloudflared opens the page itself; elsewhere the caller does (the Studio's tab, or the
    // terminal a person typed into), so an agent asking from afar never pops a browser on this computer's screen.
    const opened = process.platform === 'darwin' || process.platform === 'win32';
    if (this.signedIn()) return { done: true, url: null, opened: false };
    if (this.loginChild && this.signingIn) return { done: false, url: this.signingIn, opened };
    const bin = await this.need();
    const child = this.spawn(bin.path, ['tunnel', 'login'], opened ? this.env : quietBrowser(this.env));
    this.loginChild = child;
    const give = setTimeout(() => child.kill(), 10 * 60_000);
    give.unref?.();
    return new Promise((resolve, reject) => {
      let out = '';
      let settled = false;
      const wait = setTimeout(() => settle(), 20_000);
      wait.unref?.();
      const settle = (e?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(wait);
        if (e) return reject(e);
        if (this.signingIn) return resolve({ done: false, url: this.signingIn, opened });
        if (this.signedIn()) return resolve({ done: true, url: null, opened: false });
        reject(
          new HostError(
            502,
            `cloudflared couldn’t start the sign-in: ${firstLine(out)}`,
            'cloudflared tunnel login',
          ),
        );
      };
      const take = (d: Buffer | string) => {
        out += d.toString();
        const m = LOGIN_URL.exec(out);
        if (m && !this.signingIn) {
          this.signingIn = m[0];
          this.o.onChange?.();
          settle();
        }
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('error', (e) => settle(new HostError(502, e.message)));
      child.on('exit', () => {
        clearTimeout(give);
        if (this.loginChild === child) {
          this.loginChild = null;
          this.signingIn = null;
          this.o.onChange?.();
        }
        settle();
      });
    });
  }

  /** The named tunnel for this computer in the owner's account, if it exists. */
  async named(bin?: string): Promise<{ name: string; id: string } | null> {
    const path = bin ?? (await this.find())?.path;
    if (!path || !this.signedIn()) return null;
    const r = await this.run(path, ['tunnel', 'list', '--output', 'json', '--name', this.name], 20_000);
    if (!r.ok) return null;
    try {
      const list = JSON.parse(r.out.slice(r.out.indexOf('['))) as {
        id?: string;
        name?: string;
        deleted_at?: string;
      }[];
      const t = list.find(
        (x) => x.name === this.name && x.id && (!x.deleted_at || x.deleted_at.startsWith('0001-')),
      );
      this.tunnel = t ? { name: t.name!, id: t.id! } : null;
    } catch {
      this.tunnel = null;
    }
    return this.tunnel;
  }

  private secret(id: string): SecretStore {
    return this.o.secrets(`cloudflare-tunnel-${id.toLowerCase()}`);
  }

  /**
   * cloudflared writes credentials only to a file: let it, under Hildegard's own 0700 folder, move them to the
   * keychain at once and remove the file, whatever happened.
   */
  private async credentials(
    args: (file: string) => string[],
    bin: string,
  ): Promise<{ ok: boolean; out: string; creds: string | null }> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `new-${randomBytes(6).toString('hex')}.json`);
    try {
      const r = await this.run(bin, args(file), 30_000);
      const creds = existsSync(file) ? readFileSync(file, 'utf8') : null;
      return { ...r, creds };
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Make this computer's named tunnel, or take the one already in the account; its credentials go to the keychain. */
  private async ensureNamed(bin: string): Promise<{ name: string; id: string }> {
    let t = await this.named(bin);
    if (!t) {
      const r = await this.credentials(
        (f) => ['tunnel', 'create', '--output', 'json', '--credentials-file', f, this.name],
        bin,
      );
      if (!r.ok || !r.creds)
        throw new HostError(502, `Cloudflare couldn’t make the tunnel ${this.name}: ${firstLine(r.out)}`);
      let id = '';
      try {
        id = (JSON.parse(r.out.slice(r.out.indexOf('{'))) as { id?: string }).id ?? '';
      } catch {}
      if (!id)
        try {
          id = (JSON.parse(r.creds) as { TunnelID?: string }).TunnelID ?? '';
        } catch {}
      if (!id)
        throw new HostError(502, `Cloudflare made ${this.name} but didn’t say its id. Run this again.`);
      this.secret(id).set(r.creds);
      t = { name: this.name, id };
      this.tunnel = t;
    } else if (!this.secret(t.id).get()) {
      // Made on this computer before, or by hand: fetch its credentials again.
      const r = await this.credentials((f) => ['tunnel', 'token', '--cred-file', f, t!.id], bin);
      if (!r.ok || !r.creds)
        throw new HostError(
          502,
          `Cloudflare didn’t give the credentials for ${this.name}: ${firstLine(r.out)}`,
        );
      this.secret(t.id).set(r.creds);
    }
    return t;
  }

  /** Point the name at the tunnel. A record that points somewhere else is the owner's: never overwritten. */
  private async route(bin: string, id: string, hostname: string): Promise<void> {
    const r = await this.run(bin, ['tunnel', 'route', 'dns', id, hostname], 30_000);
    if (/already configured to route to your tunnel/i.test(r.out)) return;
    if (r.ok) return;
    if (/already exists/i.test(r.out))
      throw new HostError(
        409,
        `${hostname} already has a DNS record that points somewhere else. Remove it on Cloudflare’s DNS page, or pick another name.`,
        'https://dash.cloudflare.com/',
      );
    throw new HostError(
      502,
      `Cloudflare couldn’t point ${hostname} at the tunnel: ${firstLine(r.out)}. Is the domain in the account you signed in to?`,
    );
  }

  private write(name: string, body: string): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = join(this.dir, name);
    writeFileSync(f, body, { mode: 0o600 });
    chmodSync(f, 0o600);
    return f;
  }

  /**
   * Bring the tunnel up to `target` (the hosted listener) and resolve with its https link once Cloudflare has a
   * connection. Replaces any tunnel already running.
   */
  async up(kind: 'cloudflare' | 'quick', target: string, hostname?: string | null): Promise<string> {
    // Everything that can be refused (no cloudflared, no sign-in, a bad name, a DNS record in the way) is settled
    // before a running tunnel stops, so a refused change leaves the working one as it was.
    const bin = await this.need();
    let want: Want;
    if (kind === 'cloudflare') {
      const h = parseTunnelHostname(hostname);
      if (!h.ok) throw new HostError(400, h.error);
      if (!this.signedIn())
        throw new HostError(
          409,
          'Sign this computer in to your Cloudflare account first. No account yet? Make a free one, add your domain, then sign in.',
          'hildegard tunnel cloudflare --login',
        );
      const t = await this.ensureNamed(bin.path);
      await this.route(bin.path, t.id, h.hostname);
      const config = this.write(
        'cloudflared.yml',
        [
          `tunnel: ${t.id}`,
          'ingress:',
          `  - hostname: ${h.hostname}`,
          `    service: ${target}`,
          '  - service: http_status:404',
          '',
        ].join('\n'),
      );
      const creds = this.secret(t.id).get();
      if (!creds)
        throw new HostError(
          502,
          `The credentials for ${t.name} aren’t in the keychain any more. Run this again.`,
        );
      want = {
        kind,
        hostname: h.hostname,
        args: ['tunnel', '--config', config, '--no-autoupdate', 'run', t.id],
        env: { ...this.env, TUNNEL_CRED_CONTENTS: creds },
      };
    } else {
      // A config of Hildegard's own, so one the owner keeps in ~/.cloudflared never routes this tunnel elsewhere.
      const config = this.write('quick.yml', 'no-autoupdate: true\n');
      want = {
        kind,
        hostname: null,
        args: ['tunnel', '--config', config, '--no-autoupdate', '--url', target],
        env: this.env,
      };
    }
    await this.down();
    this.want = want;
    this.failures = 0;
    try {
      return await this.launch(bin.path, want);
    } catch (e) {
      this.want = null;
      throw e;
    }
  }

  /** An earlier Hildegard's cloudflared that outlived it (a crash): only one with this data folder in its command. */
  private async reap(): Promise<void> {
    let pid = 0;
    try {
      pid = Number(readFileSync(this.pidFile, 'utf8').trim());
    } catch {
      return;
    }
    rmSync(this.pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 1) return;
    const cmd = await (this.o.commandOf ?? commandOf)(pid);
    if (cmd && /cloudflared/.test(cmd) && cmd.includes(this.dir))
      try {
        process.kill(pid);
      } catch {}
  }

  private launch(bin: string, want: Want): Promise<string> {
    return new Promise((resolve, reject) => {
      void this.reap().then(() => {
        if (this.want !== want)
          return reject(new HostError(409, 'The tunnel was turned off while it started.'));
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(this.log, '', { mode: 0o600 });
        const child = this.spawn(bin, want.args, want.env);
        this.child = child;
        this.startedAt = Date.now();
        if (child.pid) writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 });
        let out = '';
        let url: string | null = want.kind === 'cloudflare' ? `https://${want.hostname}` : null;
        let ready = false;
        const timer = setTimeout(() => {
          if (ready) return;
          ready = true;
          const why = firstLine(
            out
              .split('\n')
              .filter((l) => / ERR /.test(l))
              .join('\n') || out,
          );
          child.kill();
          reject(
            new HostError(502, `cloudflared didn’t connect to Cloudflare in time: ${why}`, `See ${this.log}`),
          );
        }, this.o.readyMs ?? 45_000);
        timer.unref?.();
        const take = (d: Buffer | string) => {
          const s = d.toString();
          out = (out + s).slice(-20_000);
          try {
            appendFileSync(this.log, s);
          } catch {}
          if (!url) url = QUICK_URL.exec(out)?.[0] ?? null;
          if (!ready && url && CONNECTED.test(out)) {
            ready = true;
            clearTimeout(timer);
            const moved = this.url !== null && this.url !== url;
            this.url = url;
            this.problem = null;
            this.fix = null;
            if (moved) this.o.onUrl?.(url);
            this.o.onChange?.();
            resolve(url);
          }
        };
        child.stdout?.on('data', take);
        child.stderr?.on('data', take);
        child.on('error', (e) => {
          if (ready) return;
          ready = true;
          clearTimeout(timer);
          reject(new HostError(502, `cloudflared couldn’t start: ${e.message}`));
        });
        child.on('exit', (code) => {
          if (this.child !== child) return;
          this.child = null;
          rmSync(this.pidFile, { force: true });
          if (!ready) {
            ready = true;
            clearTimeout(timer);
            return reject(
              new HostError(
                502,
                `cloudflared stopped before it connected: ${firstLine(out)}`,
                `See ${this.log}`,
              ),
            );
          }
          if (this.want !== want) return;
          // It stopped on its own: say so, and start it again, waiting longer each time it keeps stopping.
          this.problem = `cloudflared stopped (exit ${code ?? 'signal'}); Hildegard is starting it again.`;
          this.fix = `See ${this.log}`;
          this.o.onChange?.();
          if (Date.now() - this.startedAt > 60_000) this.failures = 0;
          this.retry(bin, want);
        });
      });
    });
  }

  /**
   * Start cloudflared again after it stopped on its own, waiting longer each time, and keep trying for as long as the
   * tunnel is wanted: a start that fails before it connects schedules the next one.
   */
  private retry(bin: string, want: Want) {
    const wait = Math.min(60_000, (this.o.restartMs ?? 2000) * 2 ** this.failures++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.want !== want) return;
      this.launch(bin, want).catch((e: Error) => {
        if (this.want !== want) return;
        this.problem = `${e.message} Hildegard keeps trying.`;
        this.fix = e instanceof HostError ? e.fix : null;
        this.o.onChange?.();
        this.retry(bin, want);
      });
    }, wait);
    this.restartTimer.unref?.();
  }

  /** A tunnel is wanted: running, starting, or waiting to start again. */
  get active(): boolean {
    return this.want !== null;
  }

  /** Stop the tunnel. The named tunnel and its DNS record stay in the owner's account, for the next time. */
  async down(): Promise<void> {
    this.want = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    this.url = null;
    this.problem = null;
    this.fix = null;
    if (child) {
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        kill.unref?.();
        child.on('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        if (!child.kill('SIGTERM')) {
          clearTimeout(kill);
          resolve();
        }
      });
      rmSync(this.pidFile, { force: true });
    }
  }

  /** Server shutdown: the tunnel and any sign-in still waiting stop with it; the saved link stays, for the start. */
  async stop(): Promise<void> {
    this.loginChild?.kill();
    await this.down();
  }

  /** Where Cloudflare stands here, for the report. */
  async provider(host: HostState, savedHostname: string | null): Promise<TunnelReport['cloudflare']> {
    // Looked for fresh each time: a person who just installed it, or signed in, sees that at once.
    const bin = await this.find(true);
    const signedIn = this.signedIn();
    const tunnel = bin && signedIn ? (this.tunnel ?? (await this.named(bin.path))) : null;
    const mine = host.on && host.via === 'custom' && !!host.tunnel;
    const install = cloudflaredInstall();
    const base: Omit<TunnelReport['cloudflare'], 'state' | 'problem' | 'fix'> = {
      installed: !!bin,
      signedIn,
      version: bin?.version ?? null,
      ...CLOUDFLARE_PAGES,
      install,
      signIn: 'hildegard tunnel cloudflare --login',
      tunnel,
      hostname: (host.tunnel === 'cloudflare' ? this.want?.hostname : null) ?? savedHostname,
      temporary: mine && host.tunnel === 'quick',
      canFetch: canFetchCloudflared(),
      signingIn: this.signingIn,
    };
    const state = (s: TunnelProvider['state'], problem: string | null = null, fix: string | null = null) => ({
      ...base,
      state: s,
      problem,
      fix,
    });
    if (mine && (host.problem || this.problem))
      return state('problem', host.problem ?? this.problem, host.fix ?? this.fix);
    if (mine && host.url) return state('on');
    if (!bin)
      return state('missing', 'cloudflared isn’t installed here.', install ?? CLOUDFLARE_PAGES.download);
    if (!signedIn)
      return state(
        'signed-out',
        'This computer isn’t signed in to Cloudflare. A quick tunnel works without an account, but its name changes every time.',
        base.signIn,
      );
    return state('ready');
  }
}

/** Where both providers stand, with the link. */
export async function tunnelReport(o: {
  host: HostState;
  savedHostname: string | null;
  cloudflared: Cloudflared;
  run?: Exec;
  /** The HTTPS ports Tailscale forwards to the hosted listener now, as `tailscale serve status` says (Host.forwarding). */
  forwarding?: number[];
}): Promise<TunnelReport> {
  const [ts, cf] = await Promise.all([tailscaleInfo(o.run), o.cloudflared.provider(o.host, o.savedHostname)]);
  return { tailscale: tailscaleProvider(ts, o.host, o.forwarding ?? []), cloudflare: cf, host: o.host };
}
