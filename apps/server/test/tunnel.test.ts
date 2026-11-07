// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { HostState, TunnelReport } from '@hildegard/presets';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import type { SecretStore } from '../src/hf.ts';
import { type Exec, Host, HostError } from '../src/host.ts';
import { type Running, startServer } from '../src/server.ts';
import {
  type Child,
  Cloudflared,
  parseTunnelHostname,
  type Spawn,
  tunnelName,
  tunnelReport,
} from '../src/tunnel.ts';
import { memoryStore } from './helpers.ts';

const TUNNEL_ID = '6ff42ae2-765d-4adf-8112-31c55c1551ef';
/** Stands in for the tunnel's credential, so the tests can look for it where it must never be. */
const FAKE_CRED = 'pretend-tunnel-credential-0b7f';

/** What this pretend computer has: each test sets it up, and the stand-ins below answer from it. */
interface World {
  tailscale: 'missing' | 'NeedsLogin' | 'Stopped' | 'Running';
  cloudflared: boolean;
  /** Tunnels in the pretend Cloudflare account. */
  account: { id: string; name: string }[];
  /** What `tunnel route dns` says. */
  route: 'added' | 'same' | 'taken';
  /** What `tailscale serve status --json` reports, by HTTPS port. */
  served: Record<string, string>;
  quickNames: string[];
  /** Tailscale refuses to turn a route off. */
  offFails?: boolean;
  /** How many cloudflared starts stop before they connect. */
  failStarts?: number;
  /** How many cloudflared starts run on without ever connecting (the network is down). */
  hangStarts?: number;
  /** Starts connect only after this many milliseconds. */
  slowMs?: number;
}

const fresh = (): World => ({
  tailscale: 'Running',
  cloudflared: true,
  account: [],
  route: 'added',
  served: {},
  quickNames: ['first-quick-name', 'second-quick-name', 'third-quick-name'],
});

class FakeChild extends EventEmitter implements Child {
  pid = 0;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  constructor(args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.args = args;
    this.env = env;
  }
  say(line: string) {
    this.stderr.write(`2026-11-07T18:00:00Z INF ${line}\n`);
  }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.emit('exit', null));
    return true;
  }
  /** cloudflared stopping on its own. */
  die() {
    this.killed = true;
    this.emit('exit', 1);
  }
}

function setup(w: World, opts: { signedIn?: boolean; readyMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hg-tunnel-'));
  const home = mkdtempSync(join(tmpdir(), 'hg-tunnel-home-'));
  if (opts.signedIn) {
    mkdirSync(join(home, '.cloudflared'));
    writeFileSync(join(home, '.cloudflared', 'cert.pem'), 'pretend');
  }
  const calls: string[][] = [];
  const children: FakeChild[] = [];
  const secrets = new Map<string, SecretStore & { value: string | null }>();
  const secretFor = (account: string) => {
    if (!secrets.has(account)) secrets.set(account, memoryStore());
    return secrets.get(account)!;
  };
  const run: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tailscale') {
      if (w.tailscale === 'missing') return { ok: false, out: '' };
      if (args[0] === 'version') return { ok: true, out: '1.102.3\n  tailscale commit: abc' };
      if (args[0] === 'status')
        return {
          ok: w.tailscale === 'Running',
          out: JSON.stringify({
            BackendState: w.tailscale,
            Self:
              w.tailscale === 'Running'
                ? { DNSName: 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] }
                : {},
          }),
        };
      if (args[0] === 'serve' && args[1] === 'status') {
        const Web: Record<string, unknown> = {};
        for (const [port, to] of Object.entries(w.served))
          Web[`studio.example.ts.net:${port}`] = { Handlers: { '/': { Proxy: to } } };
        return { ok: true, out: JSON.stringify({ Web }) };
      }
      // `serve|funnel --bg --https=P <target>` adds a route; `serve|funnel --https=P off` removes it, unless refused.
      if (args[1] === '--bg') w.served[args[2]!.split('=')[1]!] = args[3]!;
      if (args.at(-1) === 'off') {
        if (w.offFails) return { ok: false, out: 'error: something went wrong' };
        delete w.served[args[1]!.split('=')[1]!];
      }
      return { ok: true, out: '' };
    }
    // Every other command is a cloudflared candidate: only the plain `cloudflared` on PATH is installed here.
    if (cmd !== 'cloudflared' || !w.cloudflared) return { ok: false, out: '' };
    if (args[0] === '--version') return { ok: true, out: 'cloudflared version 2026.10.3 (built 2026-10-21)' };
    if (args[0] === 'tunnel' && args[1] === 'list')
      return {
        ok: true,
        out: JSON.stringify(
          w.account.map((t) => ({ ...t, deleted_at: '0001-01-01T00:00:00Z', connections: [] })),
        ),
      };
    if (args[0] === 'tunnel' && args[1] === 'create') {
      const file = args[args.indexOf('--credentials-file') + 1]!;
      const name = args.at(-1)!;
      writeFileSync(
        file,
        JSON.stringify({ AccountTag: 'acct', TunnelSecret: FAKE_CRED, TunnelID: TUNNEL_ID }),
      );
      w.account.push({ id: TUNNEL_ID, name });
      return { ok: true, out: JSON.stringify({ id: TUNNEL_ID, name }) };
    }
    if (args[0] === 'tunnel' && args[1] === 'token') {
      const file = args[args.indexOf('--cred-file') + 1]!;
      writeFileSync(
        file,
        JSON.stringify({ AccountTag: 'acct', TunnelSecret: FAKE_CRED, TunnelID: args.at(-1) }),
      );
      return { ok: true, out: '' };
    }
    if (args[0] === 'tunnel' && args[1] === 'route') {
      if (w.route === 'taken')
        return {
          ok: false,
          out: 'Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.',
        };
      if (w.route === 'same')
        return {
          ok: true,
          out: `INF ${args[4]} is already configured to route to your tunnel tunnelID=${args[3]}`,
        };
      return {
        ok: true,
        out: `INF Added CNAME ${args[4]} which will route to this tunnel tunnelID=${args[3]}`,
      };
    }
    return { ok: false, out: 'unknown command' };
  };
  const spawn: Spawn = (cmd, args, env) => {
    const c = new FakeChild([cmd, ...args], env);
    children.push(c);
    const begin = (fn: () => void) => (w.slowMs ? setTimeout(fn, w.slowMs) : setImmediate(fn));
    begin(() => {
      if (args[1] === 'login') {
        c.say('Please open the following URL and log in with your Cloudflare account:');
        c.stderr.write(
          'https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc\n',
        );
        return;
      }
      if (w.hangStarts) {
        w.hangStarts--;
        return;
      }
      if (w.failStarts) {
        w.failStarts--;
        c.say('ERR failed to connect to the edge');
        c.die();
        return;
      }
      if (args.includes('--url')) {
        c.say('Requesting new quick Tunnel on trycloudflare.com...');
        c.say(`|  https://${w.quickNames.shift()}.trycloudflare.com  |`);
      }
      c.say('Registered tunnel connection connIndex=0 location=iad22 protocol=quic');
    });
    return c;
  };
  const cloudflared = new Cloudflared({
    dataDir,
    run,
    spawn,
    secrets: secretFor,
    home,
    env: { PATH: '/usr/bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1' },
    computer: 'Studio-PC',
    readyMs: opts.readyMs ?? 2000,
    restartMs: 10,
    onUrl: (url) => host.tunnelMoved(url),
  });
  const host: Host = new Host({
    dataDir,
    port: () => 7341,
    hostPort: () => 7342,
    run,
    owner: () => true,
    tunnel: cloudflared,
  });
  const report = async () => {
    await host.tailscale(true);
    return tunnelReport({
      host: host.state(),
      savedHostname: host.hostname,
      cloudflared,
      run,
      forwarding: await host.forwarding(),
    });
  };
  const live = () => children.filter((c) => !c.killed);
  /** Hildegard starting again over the same data folder. */
  const restart = () =>
    new Host({
      dataDir,
      port: () => 7341,
      hostPort: () => 7342,
      run,
      owner: () => true,
      tunnel: cloudflared,
      retryMs: 20,
    });
  return { dataDir, home, calls, children, live, secrets, cloudflared, host, report, restart, run, spawn };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HostError);
    return e as HostError;
  }
  throw new Error('expected a refusal');
};

const cfCalls = (calls: string[][], sub: string) =>
  calls.filter((c) => c[0] === 'cloudflared' && c[2] === sub);
const tailscaleChanges = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'tailscale' && (c[1] === 'serve' || c[1] === 'funnel') && c[2] !== 'status');

let made: ReturnType<typeof setup>[] = [];
const make = (w: World, o?: { signedIn?: boolean; readyMs?: number }) => {
  const s = setup(w, o);
  made.push(s);
  return s;
};
afterEach(async () => {
  for (const s of made) await s.cloudflared.stop();
  made = [];
});

describe('tunnels: no tool installed', () => {
  it('says what to install and where to make an account, for each provider, and starts nothing', async () => {
    const s = make({ ...fresh(), tailscale: 'missing', cloudflared: false });
    const r = await s.report();
    expect(r.tailscale).toMatchObject({
      state: 'missing',
      installed: false,
      signup: 'https://login.tailscale.com/start',
    });
    expect(r.tailscale.fix).toBeTruthy();
    expect(r.cloudflare).toMatchObject({
      state: 'missing',
      installed: false,
      signup: 'https://dash.cloudflare.com/sign-up',
    });
    if (process.platform === 'linux' && process.arch === 'x64') {
      expect(r.cloudflare.canFetch).toBe(true);
      expect(r.cloudflare.fix).toBe('hildegard tunnel install cloudflare');
    }

    for (const via of ['cloudflare', 'quick'] as const) {
      const e = await refusal(s.host.on({ via, hostname: 'hildegard.example.com' }));
      expect(e.status).toBe(409);
      expect(e.message).toMatch(/cloudflared isn’t installed/);
      expect(e.message).toMatch(/never installs it unless you ask/);
    }
    expect((await refusal(s.host.on({ via: 'tailscale' }))).fix).toBe('tailscale up');
    expect(s.children).toEqual([]);
    expect(s.host.state().on).toBe(false);
    // Nothing was fetched on its own: the tools folder doesn't exist.
    expect(existsSync(join(s.dataDir, 'tools'))).toBe(false);
  });
});

describe('tunnels: tool installed, not signed in', () => {
  it('asks for a Cloudflare sign-in before a named tunnel, and gives Cloudflare’s sign-in page', async () => {
    const s = make(fresh());
    const r = await s.report();
    expect(r.cloudflare).toMatchObject({ state: 'signed-out', installed: true, signedIn: false });
    expect(r.cloudflare.fix).toBe('hildegard tunnel cloudflare --login');

    const e = await refusal(s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' }));
    expect(e.status).toBe(409);
    expect(e.fix).toBe('hildegard tunnel cloudflare --login');
    expect(cfCalls(s.calls, 'create')).toEqual([]);

    const login = await s.cloudflared.login();
    expect(login.done).toBe(false);
    expect(login.url).toMatch(/^https:\/\/dash\.cloudflare\.com\/argotunnel\?/);
    expect(s.children[0]!.args.slice(1)).toEqual(['tunnel', 'login']);
    // Asked from afar (an agent, the Studio), cloudflared never opens a browser on this screen by itself.
    if (process.platform === 'linux') {
      expect(login.opened).toBe(false);
      expect(s.children[0]!.env.DISPLAY).toBeUndefined();
      expect(s.children[0]!.env.WAYLAND_DISPLAY).toBeUndefined();
      expect(s.children[0]!.env.BROWSER).toBe('true');
    }
    expect((await s.report()).cloudflare.signingIn).toBe(login.url);
    // Asking again while that page waits gives the same page, not a second sign-in.
    expect(await s.cloudflared.login()).toEqual(login);
    expect(s.children).toHaveLength(1);
  });

  it('runs a quick tunnel with no account, labeled temporary', async () => {
    const s = make(fresh());
    const h = await s.host.on({ via: 'quick' });
    expect(h).toMatchObject({
      on: true,
      via: 'custom',
      tunnel: 'quick',
      url: 'https://first-quick-name.trycloudflare.com',
    });
    const child = s.live()[0]!;
    expect(child.args).toContain('--url');
    expect(child.args).toContain('http://127.0.0.1:7342');
    expect(child.args).toContain(join(s.dataDir, 'tunnel', 'quick.yml'));
    expect(child.env.TUNNEL_CRED_CONTENTS).toBeUndefined();
    expect((await s.report()).cloudflare).toMatchObject({ state: 'on', temporary: true });
  });

  it('says how to sign in to Tailscale when it is installed but signed out or turned off', async () => {
    for (const backend of ['NeedsLogin', 'Stopped'] as const) {
      const s = make({ ...fresh(), tailscale: backend });
      const r = await s.report();
      expect(r.tailscale).toMatchObject({ state: 'signed-out', installed: true, signedIn: false });
      expect(r.tailscale.fix).toBe(r.tailscale.signIn);
      expect(tailscaleChanges(s.calls)).toEqual([]);
    }
  });
});

describe('tunnels: signed in', () => {
  it('makes the named tunnel, points the name at it and runs it, with its credentials only in the keychain', async () => {
    const s = make(fresh(), { signedIn: true });
    expect((await s.report()).cloudflare.state).toBe('ready');

    const h = await s.host.on({ via: 'cloudflare', hostname: 'https://Hildegard.Example.com/' });
    expect(h).toMatchObject({
      on: true,
      via: 'custom',
      tunnel: 'cloudflare',
      url: 'https://hildegard.example.com',
      problem: null,
    });
    const name = tunnelName('Studio-PC');
    expect(name).toBe('hildegard-studio-pc');
    expect(cfCalls(s.calls, 'create')).toHaveLength(1);
    expect(cfCalls(s.calls, 'create')[0]).toContain(name);
    expect(cfCalls(s.calls, 'route')[0]!.slice(1)).toEqual([
      'tunnel',
      'route',
      'dns',
      TUNNEL_ID,
      'hildegard.example.com',
    ]);
    const child = s.live()[0]!;
    expect(child.args.slice(1)).toEqual([
      'tunnel',
      '--config',
      join(s.dataDir, 'tunnel', 'cloudflared.yml'),
      '--no-autoupdate',
      'run',
      TUNNEL_ID,
    ]);
    // The credential reaches cloudflared in its environment: never its arguments, a file or the log.
    expect(child.env.TUNNEL_CRED_CONTENTS).toContain(FAKE_CRED);
    expect(child.args.join(' ')).not.toContain(FAKE_CRED);
    expect(s.secrets.get(`cloudflare-tunnel-${TUNNEL_ID}`)!.value).toContain(FAKE_CRED);
    for (const f of readdirSync(join(s.dataDir, 'tunnel')))
      expect(readFileSync(join(s.dataDir, 'tunnel', f), 'utf8'), f).not.toContain(FAKE_CRED);
    expect(readFileSync(join(s.dataDir, 'host.json'), 'utf8')).not.toContain(FAKE_CRED);
    const config = readFileSync(join(s.dataDir, 'tunnel', 'cloudflared.yml'), 'utf8');
    expect(config).toContain('hostname: hildegard.example.com');
    expect(config).toContain('service: http://127.0.0.1:7342');
    expect(config).toMatch(/- service: http_status:404\n$/);

    const r = await s.report();
    expect(r.cloudflare).toMatchObject({
      state: 'on',
      temporary: false,
      hostname: 'hildegard.example.com',
      tunnel: { name, id: TUNNEL_ID },
    });
    expect(r.tailscale.state).toBe('ready');
    expect(tailscaleChanges(s.calls)).toEqual([]);
  });

  it('serves on the tailnet by default and uses Funnel only when asked by name', async () => {
    const s = make(fresh());
    expect((await s.report()).tailscale.state).toBe('ready');
    await s.host.on({ via: 'tailscale' });
    expect(s.calls.filter((c) => c[1] === 'serve' && c[2] === '--bg')).toHaveLength(1);
    expect(s.calls.filter((c) => c[1] === 'funnel')).toEqual([]);
    expect((await s.report()).tailscale).toMatchObject({ state: 'on', funnel: false });
    await s.host.on({ via: 'funnel' });
    expect((await s.report()).tailscale).toMatchObject({ state: 'on', funnel: true });
  });

  it('refuses names off the owner’s own domain, and never overwrites a DNS record that points elsewhere', async () => {
    for (const bad of [
      '',
      'http://hildegard.example.com',
      'abc-def.trycloudflare.com',
      'pc.example.ts.net',
      'hildegard.example.com:8443',
      '100.64.0.1',
      'hildegard',
    ])
      expect(parseTunnelHostname(bad).ok, bad).toBe(false);

    const s = make({ ...fresh(), route: 'taken' }, { signedIn: true });
    await s.host.on({ via: 'tailscale' });
    const e = await refusal(s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' }));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/already has a DNS record/);
    expect(s.calls.some((c) => c.includes('--overwrite-dns'))).toBe(false);
    // The old link stays as it was, and no cloudflared is left running.
    expect(s.live()).toEqual([]);
    expect(s.host.state()).toMatchObject({ on: true, via: 'tailscale' });
  });
});

describe('tunnels: already there', () => {
  it('takes the tunnel already in the account and a name already routed, making neither again', async () => {
    const s = make(
      { ...fresh(), route: 'same', account: [{ id: TUNNEL_ID, name: 'hildegard-studio-pc' }] },
      { signedIn: true },
    );
    expect((await s.report()).cloudflare.tunnel).toEqual({ name: 'hildegard-studio-pc', id: TUNNEL_ID });
    await s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' });
    expect(cfCalls(s.calls, 'create')).toEqual([]);
    // Made before, on another computer or by hand: its credentials are fetched once, into the keychain.
    expect(cfCalls(s.calls, 'token')).toHaveLength(1);
    expect(s.live()).toHaveLength(1);

    // On again replaces it: one cloudflared, never two.
    await s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' });
    expect(s.live()).toHaveLength(1);
    expect(s.children).toHaveLength(2);
    expect(cfCalls(s.calls, 'token')).toHaveLength(1);
  });

  it('reuses a Tailscale Serve route that already forwards here, and leaves other routes alone', async () => {
    const s = make({
      ...fresh(),
      served: { '443': 'http://127.0.0.1:7342', '8443': 'http://127.0.0.1:9999' },
    });
    expect((await s.host.on({ via: 'tailscale' })).url).toBe('https://studio.example.ts.net');
    expect(s.calls.find((c) => c[1] === 'serve' && c[2] === '--bg')).toContain('--https=443');
    expect(s.calls.filter((c) => c.includes('--https=8443'))).toEqual([]);
  });

  it('brings the tunnel back when Hildegard starts again', async () => {
    const s = make(fresh(), { signedIn: true });
    await s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' });
    await s.cloudflared.stop();
    expect(s.live()).toEqual([]);

    const again = s.restart();
    await again.resume();
    expect(again.state()).toMatchObject({
      on: true,
      tunnel: 'cloudflare',
      url: 'https://hildegard.example.com',
      problem: null,
    });
    expect(s.live()).toHaveLength(1);
  });

  it('starts cloudflared again when it stops on its own; a quick tunnel’s new name becomes the link', async () => {
    const s = make(fresh());
    await s.host.on({ via: 'quick' });
    s.live()[0]!.die();
    const end = Date.now() + 3000;
    while (s.host.state().url !== 'https://second-quick-name.trycloudflare.com' && Date.now() < end)
      await new Promise((r) => setTimeout(r, 10));
    expect(s.host.state()).toMatchObject({
      on: true,
      tunnel: 'quick',
      url: 'https://second-quick-name.trycloudflare.com',
    });
    expect(s.live()).toHaveLength(1);
  });
});

describe('tunnels: off', () => {
  it('stops cloudflared for good, keeps the tunnel and the name for next time, and reads back off', async () => {
    const s = make(fresh(), { signedIn: true });
    await s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' });
    expect(await s.host.off()).toMatchObject({ on: false, tunnel: null, url: null });
    expect(s.live()).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.live()).toEqual([]);
    const r = await s.report();
    expect(r.cloudflare).toMatchObject({ state: 'ready', hostname: 'hildegard.example.com' });
    expect(r.host.on).toBe(false);
    const disk = JSON.parse(readFileSync(join(s.dataDir, 'host.json'), 'utf8'));
    expect(disk.door).toMatchObject({ on: false, hostname: 'hildegard.example.com' });
    expect(disk.door.tunnel).toBeUndefined();
    expect(existsSync(join(s.dataDir, 'tunnel', 'cloudflared.pid'))).toBe(false);
    // Starting again brings nothing back.
    await s.restart().resume();
    expect(s.live()).toEqual([]);
  });

  it('stops a tunnel when Tailscale takes over, and turns Serve off with the link', async () => {
    const s = make(fresh());
    await s.host.on({ via: 'quick' });
    await s.host.on({ via: 'tailscale' });
    expect(s.live()).toEqual([]);
    expect(s.host.state()).toMatchObject({ via: 'tailscale', tunnel: null });
    await s.host.off();
    expect(s.calls.some((c) => c[1] === 'serve' && c[2] === '--https=443' && c[3] === 'off')).toBe(true);
    expect((await s.report()).tailscale.state).toBe('ready');
  });
});

// ── Through the server: the report, sign-in, and the tunnel's name on the hosted listener only ─────────────────

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const statusAs = (base: string, host: string, path: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(base + path);
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname, headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end();
  });

describe('tunnels: the API', () => {
  let srv: Running | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it('reports both providers, signs in, and a quick tunnel’s name answers only on the hosted listener while on', async () => {
    const s = setup(fresh());
    const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
    const post = (path: string, body: unknown) =>
      fetch(`${srv!.url}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    srv = await startServer(
      {
        ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-tunnel-api-'))]),
        port: 0,
        hostPort: await freePort(),
      },
      {
        fakeTickMs: 25,
        secrets: memoryStore(),
        exec: s.run,
        spawn: s.spawn,
        tunnelSecrets: () => memoryStore(),
        tunnelHome: s.home,
      },
    );
    const r = (await (await fetch(`${srv.url}/api/tunnel`)).json()) as TunnelReport;
    expect(r.cloudflare.state).toBe('signed-out');
    expect(r.tailscale.state).toBe('ready');

    const login = (await (await post('/api/tunnel/login', { provider: 'cloudflare' })).json()) as {
      url: string;
    };
    expect(login.url).toMatch(/^https:\/\/dash\.cloudflare\.com\//);
    expect((await post('/api/tunnel/login', { provider: 'tailscale' })).status).toBe(400);

    expect(
      (await post('/api/people/owner', { name: 'Ada', passphrase: 'a long and private passphrase' })).status,
    ).toBe(201);
    const on = (await (await post('/api/host', { via: 'quick' })).json()) as HostState;
    expect(on).toMatchObject({ on: true, tunnel: 'quick' });
    const name = new URL(on.url!).host;
    const hosted = srv.hostedUrl()!;
    expect(await statusAs(hosted, name, '/api/health')).toBe(200);
    // Never on the Studio's own listener.
    expect(await statusAs(srv.url, name, '/api/health')).toBe(421);

    await post('/api/host/off', {});
    expect(await statusAs(hosted, name, '/api/health')).toBe(421);
    const after = (await (await fetch(`${srv.url}/api/tunnel`)).json()) as TunnelReport;
    expect(after.host.on).toBe(false);
    expect(after.cloudflare.temporary).toBe(false);
  }, 30_000);
});

describe('tunnels: after review (round 1)', () => {
  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return fn();
  };

  it('reads Tailscale’s own word after off: a route it refused to turn off is reported, with only its port', async () => {
    const w = fresh();
    const s = make(w);
    await s.host.on({ via: 'tailscale' });
    expect((await s.report()).tailscale.forwarding).toBe(true);
    w.offFails = true;
    await s.host.off();
    const r = await s.report();
    expect(r.host.on).toBe(false);
    expect(r.tailscale).toMatchObject({
      state: 'problem',
      forwarding: true,
      fix: 'tailscale serve --https=443 off',
    });
    w.offFails = false;
    delete w.served['443'];
    expect((await s.report()).tailscale).toMatchObject({ state: 'ready', forwarding: false });
  });

  it('keeps the working tunnel when a change is refused', async () => {
    const s = make({ ...fresh(), route: 'taken' }, { signedIn: true });
    await s.host.on({ via: 'quick' });
    const quick = s.host.state().url;
    await refusal(s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' }));
    await refusal(s.host.on({ via: 'cloudflare', hostname: 'not a name' }));
    expect(s.live()).toHaveLength(1);
    expect(s.host.state()).toMatchObject({ on: true, tunnel: 'quick', url: quick, problem: null });
    expect((await s.report()).cloudflare.state).toBe('on');
  });

  it('brings the old tunnel back when the new one fails to connect', async () => {
    const w = fresh();
    const s = make(w, { signedIn: true });
    await s.host.on({ via: 'quick' });
    w.failStarts = 1;
    await refusal(s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' }));
    expect(s.live()).toHaveLength(1);
    expect(s.live()[0]!.args).toContain('--url');
    expect(s.host.state()).toMatchObject({ on: true, tunnel: 'quick', problem: null });
  });

  it('keeps starting cloudflared again when a restart fails before it connects', async () => {
    const w = fresh();
    const s = make(w);
    await s.host.on({ via: 'quick' });
    w.failStarts = 2;
    s.live()[0]!.die();
    expect(await until(() => s.cloudflared.running && w.failStarts === 0)).toBe(true);
    expect(s.live()).toHaveLength(1);
    expect(s.host.state()).toMatchObject({ on: true, tunnel: 'quick' });
  });

  it('tries a saved tunnel again when it can’t start with Hildegard, until it works', async () => {
    const w = fresh();
    const s = make(w, { signedIn: true });
    await s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' });
    await s.cloudflared.stop();
    w.failStarts = 2;
    const again = s.restart();
    await again.resume();
    expect(again.state().problem).toMatch(/tries again/);
    expect(await until(() => again.state().problem === null && s.live().length === 1)).toBe(true);
    expect(again.state()).toMatchObject({
      on: true,
      tunnel: 'cloudflare',
      url: 'https://hildegard.example.com',
    });
  });
});

describe('tunnels: after review (round 2)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('never runs two cloudflared when restarts can’t connect, and off stops every one', async () => {
    const w = fresh();
    const s = make(w, { readyMs: 80 });
    await s.host.on({ via: 'quick' });
    w.hangStarts = 4;
    s.live()[0]!.die();
    for (let i = 0; i < 12; i++) {
      await wait(50);
      expect(s.live().length, `after ${(i + 1) * 50} ms`).toBeLessThanOrEqual(1);
    }
    await s.host.off();
    await wait(50);
    expect(s.live()).toEqual([]);
  });

  it('lets off win over a tunnel still starting: nothing forwards and the link stays off', async () => {
    // The start connects 150 ms in, after the off: it must not turn the link back on.
    const w = { ...fresh(), slowMs: 150 };
    const s = make(w, { readyMs: 2000 });
    const starting = s.host.on({ via: 'quick' }).then(
      () => 'on',
      () => 'refused',
    );
    await wait(30);
    expect(s.live()).toHaveLength(1);
    await s.host.off();
    expect(await starting).toBe('refused');
    expect(s.live()).toEqual([]);
    expect(s.host.state()).toMatchObject({ on: false, tunnel: null });
  });

  it('tries nothing again once Hildegard is closing', async () => {
    const w = fresh();
    const s = make(w, { signedIn: true });
    await s.host.on({ via: 'cloudflare', hostname: 'hildegard.example.com' });
    await s.cloudflared.stop();
    w.failStarts = 1;
    const again = s.restart();
    await again.resume();
    const started = s.children.length;
    again.stop();
    await wait(120);
    expect(s.children.length).toBe(started);
  });

  it('says so when the Serve route was removed outside Hildegard', async () => {
    const w = fresh();
    const s = make(w);
    await s.host.on({ via: 'tailscale' });
    expect((await s.report()).tailscale.state).toBe('on');
    delete w.served['443'];
    expect((await s.report()).tailscale).toMatchObject({
      state: 'problem',
      forwarding: false,
      fix: 'hildegard tunnel tailscale',
    });
  });
});
