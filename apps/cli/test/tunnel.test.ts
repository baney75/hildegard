// SPDX-License-Identifier: AGPL-3.0-only
// `hildegard tunnel`, run as a person or an agent would, against a server whose `tailscale` and `cloudflared` are
// stand-ins: no tool, a tool but no sign-in, signed in, running, and off.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { type Exec, fileStore, parseArgs, type Spawn, startServer } from '@hildegard/server';
import { describe, expect, it } from 'vitest';
import { freePort, hildegard } from './harness.ts';

class FakeChild extends EventEmitter {
  pid = 0;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.emit('exit', null));
    return true;
  }
}

describe('hildegard tunnel', () => {
  it('walks each path: nothing installed, not signed in, a quick tunnel on, doctor, and off read back', async () => {
    const world = { tailscale: false, cloudflared: false };
    const children: FakeChild[] = [];
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'tailscale') {
        if (!world.tailscale) return { ok: false, out: '' };
        if (args[0] === 'version') return { ok: true, out: '1.102.3' };
        if (args[0] === 'status') return { ok: false, out: JSON.stringify({ BackendState: 'NeedsLogin' }) };
        return { ok: true, out: '' };
      }
      if (cmd === 'cloudflared' && world.cloudflared && args[0] === '--version')
        return { ok: true, out: 'cloudflared version 2026.10.3 (built 2026-10-21)' };
      return { ok: false, out: '' };
    };
    const spawn: Spawn = (_cmd, args) => {
      const c = new FakeChild();
      children.push(c);
      setImmediate(() => {
        if (args.includes('--url'))
          c.stderr.write('INF |  https://calm-river-test-name.trycloudflare.com  |\n');
        c.stderr.write('INF Registered tunnel connection connIndex=0\n');
      });
      return c;
    };
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-tunnel-'));
    const tunnelHome = mkdtempSync(join(tmpdir(), 'hg-cli-tunnel-home-'));
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0, hostPort: await freePort() },
      {
        fakeTickMs: 20,
        secrets: fileStore(join(data, 'secret.json')),
        exec,
        spawn,
        tunnelSecrets: (a) => fileStore(join(data, 'secrets', `${a}.secret`)),
        tunnelHome,
      },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data, '--json'];
    try {
      // Nothing installed: a status read owes nothing; each provider says what to install and where to sign up.
      const st = await hildegard(home, 'tunnel', ...at);
      expect(st.ok).toBe(true);
      expect(st.needsOwner).toBe(false);
      expect(st.steps.map((s) => [s.id, s.status])).toEqual([
        ['tailscale', 'skipped'],
        ['cloudflare', 'skipped'],
      ]);
      expect(st.steps[0]!.detail).toMatch(/login\.tailscale\.com\/start/);
      expect(st.steps[1]!.detail).toMatch(/dash\.cloudflare\.com\/sign-up/);

      // Choosing one: what it needs is now the owner's to do, with the exact command. Nothing is installed for them.
      const cf = await hildegard(home, 'tunnel', 'cloudflare', ...at);
      expect(cf.needsOwner).toBe(true);
      expect(cf.message).toMatch(/installs nothing unless you ask/);
      expect(cf.steps[0]!.command).toBeTruthy();
      const ts = await hildegard(home, 'tunnel', 'tailscale', ...at);
      expect(ts.needsOwner).toBe(true);
      expect(ts.message).toBe('Install Tailscale first.');

      // "Create a free account" is the provider's own page, never an account Hildegard makes.
      const signup = await hildegard(home, 'tunnel', 'cloudflare', '--signup', ...at);
      expect(signup.url).toBe('https://dash.cloudflare.com/sign-up');
      expect(signup.needsOwner).toBe(true);

      // Installed, not signed in: a named tunnel asks for the sign-in; Tailscale says how to sign in.
      world.cloudflared = true;
      world.tailscale = true;
      const named = await hildegard(
        home,
        'tunnel',
        'cloudflare',
        '--hostname',
        'hildegard.example.com',
        ...at,
      );
      expect(named.needsOwner).toBe(true);
      expect(named.steps[0]).toMatchObject({
        id: 'cloudflare',
        command: 'hildegard tunnel cloudflare --login',
      });
      const tsOut = await hildegard(home, 'tunnel', 'tailscale', ...at);
      expect(tsOut.message).toBe('Sign this computer in to Tailscale first.');
      expect(tsOut.steps[0]!.command).toBe('tailscale up');

      // A quick tunnel needs no account, only the owner account here. It says it is temporary.
      const noOwner = await hildegard(home, 'tunnel', 'cloudflare', '--quick', ...at);
      expect(noOwner.steps.at(-1)).toMatchObject({ id: 'owner', status: 'needs-owner' });
      const owner = await fetch(`${srv.url}/api/people/owner`, {
        method: 'POST',
        headers: { 'x-hildegard': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', passphrase: 'a long and private passphrase' }),
      });
      expect(owner.status).toBe(201);
      const quick = await hildegard(home, 'tunnel', 'cloudflare', '--quick', ...at);
      expect(quick.ok).toBe(true);
      expect(quick.url).toBe('https://calm-river-test-name.trycloudflare.com');
      expect(quick.warning).toMatch(/temporary/);
      expect(quick.steps.at(-1)!.detail).toMatch(/temporary Cloudflare quick tunnel/);

      // Already running: status and doctor read it back.
      const on = await hildegard(home, 'tunnel', ...at);
      expect(on.steps.find((s) => s.id === 'cloudflare')).toMatchObject({ status: 'done' });
      expect(on.message).toMatch(/calm-river-test-name/);
      const doc = await hildegard(home, 'doctor', ...at);
      expect(doc.steps.find((s) => s.id === 'tunnel')).toMatchObject({ status: 'done' });

      // Off, read back from the server: nothing forwards here, and cloudflared is stopped.
      const off = await hildegard(home, 'tunnel', 'off', ...at);
      expect(off.ok).toBe(true);
      expect(off.steps[0]!.detail).toMatch(/Nothing forwards/);
      expect(children.every((c) => c.killed)).toBe(true);
      const after = await hildegard(home, 'tunnel', ...at);
      expect(after.steps.find((s) => s.id === 'cloudflare')!.status).toBe('skipped');
    } finally {
      await srv.close();
    }
  }, 120_000);

  it('signs in to Cloudflare without a terminal: the page comes back for the owner, and nothing waits', async () => {
    const exec: Exec = async (cmd, args) =>
      cmd === 'cloudflared' && args[0] === '--version'
        ? { ok: true, out: 'cloudflared version 2026.10.3' }
        : { ok: false, out: '' };
    const spawn: Spawn = () => {
      const c = new FakeChild();
      setImmediate(() =>
        c.stderr.write('https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Fexample\n'),
      );
      return c;
    };
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-tunnel-'));
    const tunnelHome = mkdtempSync(join(tmpdir(), 'hg-cli-tunnel-home-'));
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0, hostPort: await freePort() },
      { fakeTickMs: 20, secrets: fileStore(join(data, 's.json')), exec, spawn, tunnelHome },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data, '--json'];
    try {
      const r = await hildegard(home, 'tunnel', 'cloudflare', '--login', ...at);
      expect(r.needsOwner).toBe(true);
      expect(r.url).toMatch(/^https:\/\/dash\.cloudflare\.com\/argotunnel/);
      // Signed in (cert.pem appears where cloudflared puts it): the next run says so instead of signing in again.
      mkdirSync(join(tunnelHome, '.cloudflared'));
      writeFileSync(join(tunnelHome, '.cloudflared', 'cert.pem'), 'pretend');
      const again = await hildegard(home, 'tunnel', 'cloudflare', '--login', ...at);
      expect(again.steps[0]).toMatchObject({ id: 'cloudflare-login', status: 'done' });
    } finally {
      await srv.close();
    }
  }, 60_000);

  it('says off failed when Tailscale won’t turn its route off, with the command for only that route', async () => {
    const served: Record<string, string> = {};
    const exec: Exec = async (cmd, args) => {
      if (cmd !== 'tailscale') return { ok: false, out: '' };
      if (args[0] === 'version') return { ok: true, out: '1.102.3' };
      if (args[0] === 'status')
        return {
          ok: true,
          out: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] },
          }),
        };
      if (args[0] === 'serve' && args[1] === 'status') {
        const Web: Record<string, unknown> = {};
        for (const [p, to] of Object.entries(served))
          Web[`studio.example.ts.net:${p}`] = { Handlers: { '/': { Proxy: to } } };
        return { ok: true, out: JSON.stringify({ Web }) };
      }
      if (args[1] === '--bg') served[args[2]!.split('=')[1]!] = args[3]!;
      if (args.at(-1) === 'off') return { ok: false, out: 'error: something went wrong' };
      return { ok: true, out: '' };
    };
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-tunnel-'));
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0, hostPort: await freePort() },
      {
        fakeTickMs: 20,
        secrets: fileStore(join(data, 's.json')),
        exec,
        tunnelHome: mkdtempSync(join(tmpdir(), 'hg-h-')),
      },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data, '--json'];
    try {
      await fetch(`${srv.url}/api/people/owner`, {
        method: 'POST',
        headers: { 'x-hildegard': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', passphrase: 'a long and private passphrase' }),
      });
      expect((await hildegard(home, 'tunnel', 'tailscale', ...at)).ok).toBe(true);
      const off = await hildegard(home, 'tunnel', 'off', ...at);
      expect(off.ok).toBe(false);
      expect(off.steps[0]).toMatchObject({ status: 'failed', command: 'tailscale serve --https=443 off' });
      expect(off.steps[0]!.detail).toMatch(/Still on through Tailscale/);
    } finally {
      await srv.close();
    }
  }, 60_000);
});
