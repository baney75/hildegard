// SPDX-License-Identifier: AGPL-3.0-only
// Recording with no setup: a link that opens on this computer, a phone link only when Hildegard's own link is on, and
// `link_on`, which turns on the best link there is (Tailscale, else a quick tunnel, else it says what is missing) and
// only for a caller on this computer. The pretend computer is the same stand-in for `tailscale` and `cloudflared` that
// tunnel.test.ts uses.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { crc32, inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { qrPng } from '../../../mcp/src/qr.ts';
import { parseArgs } from '../src/config.ts';
import type { Exec } from '../src/host.ts';
import { ASK_PRIVATE, ASK_PUBLIC, type LinkOnResult, PUBLIC_REFUSED } from '../src/link-on.ts';
import { type Running, startServer } from '../src/server.ts';
import type { Child, Spawn } from '../src/tunnel.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const PASS = 'a long and private passphrase';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** What the pretend computer has. */
interface World {
  tailscale: 'missing' | 'NeedsLogin' | 'Running';
  /** Running, but the tailnet has no MagicDNS name, so Serve can't get HTTPS. */
  noDns?: boolean;
  cloudflared: boolean;
}

class FakeChild extends EventEmitter implements Child {
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

function pretend(w: World) {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const served: Record<string, string> = {};
  const run: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tailscale') {
      if (w.tailscale === 'missing') return { ok: false, out: '' };
      if (args[0] === 'version') return { ok: true, out: '1.102.3' };
      if (args[0] === 'status')
        return {
          ok: w.tailscale === 'Running',
          out: JSON.stringify({
            BackendState: w.tailscale,
            Self:
              w.tailscale === 'Running'
                ? { DNSName: w.noDns ? '' : 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] }
                : {},
          }),
        };
      if (args[0] === 'serve' && args[1] === 'status') {
        const Web: Record<string, unknown> = {};
        for (const [port, to] of Object.entries(served))
          Web[`studio.example.ts.net:${port}`] = { Handlers: { '/': { Proxy: to } } };
        return { ok: true, out: JSON.stringify({ Web }) };
      }
      if (args[1] === '--bg') served[args[2]!.split('=')[1]!] = args[3]!;
      if (args.at(-1) === 'off') delete served[args[1]!.split('=')[1]!];
      return { ok: true, out: '' };
    }
    if (cmd === 'cloudflared' && w.cloudflared && args[0] === '--version')
      return { ok: true, out: 'cloudflared version 2026.10.3 (built 2026-10-21)' };
    return { ok: false, out: '' };
  };
  const spawn: Spawn = (_cmd, args) => {
    spawned.push(args);
    const c = new FakeChild();
    setImmediate(() => {
      c.stderr.write('INF |  https://pretend-quick-name.trycloudflare.com  |\n');
      c.stderr.write('INF Registered tunnel connection connIndex=0\n');
    });
    return c;
  };
  return { calls, spawned, run, spawn };
}

let open: Running[] = [];
afterEach(async () => {
  for (const s of open) await s.close();
  open = [];
});

async function boot(w: World, opts: { owner?: boolean } = {}) {
  const fake = pretend(w);
  const ui = mkdtempSync(join(tmpdir(), 'hg-anywhere-ui-'));
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Studio</title><div id="root"></div>');
  const srv = await startServer(
    {
      ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-anywhere-')), '--ui', ui]),
      port: 0,
      hostPort: await freePort(),
    },
    {
      fakeTickMs: 25,
      secrets: memoryStore(),
      exec: fake.run,
      spawn: fake.spawn,
      tunnelSecrets: () => memoryStore(),
      tunnelHome: mkdtempSync(join(tmpdir(), 'hg-anywhere-home-')),
      limits: { perName: 50, perClient: 1000 },
    },
  );
  open.push(srv);
  const local = (path: string, method = 'GET', body?: unknown) =>
    fetch(srv.url + path, {
      method,
      headers: method === 'GET' ? {} : H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  if (opts.owner !== false)
    expect((await local('/api/people/owner', 'POST', { name: 'Ada', passphrase: PASS })).status).toBe(201);
  return { srv, local, ...fake };
}

type Link = {
  id: string;
  token: string;
  url: string;
  where: 'here' | 'phone';
  viaLink: boolean;
  secure: boolean;
};
type Plan = { route: 'tailscale' | 'quick' | 'none'; public: boolean; id: string; ask: string };
type NeedsLink = {
  needsLink: true;
  where: 'phone';
  ask: string;
  plan: Plan;
  existingPublic: boolean;
  turnOn: { tool: string } | null;
};

const changes = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'tailscale' && (c[1] === 'serve' || c[1] === 'funnel') && c[2] !== 'status');

describe('record_link: where', () => {
  it('auto picks a link on this computer for a caller on this computer, and says so', async () => {
    const { srv, local } = await boot({ tailscale: 'missing', cloudflared: false });
    const res = await local('/api/record/links', 'POST', { kind: 'voice' });
    expect(res.status).toBe(201);
    const l = (await res.json()) as Link;
    expect(l.where).toBe('here');
    expect(l.url).toBe(`${srv.url}/record/${l.token}`);
    expect(l.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/record\/[A-Za-z0-9_-]{43}$/);
    expect(l.viaLink).toBe(false);
    // The page it names opens in a browser on this computer.
    expect((await fetch(l.url)).status).toBe(200);
    // Said outright, it is the same.
    const here = (await (
      await local('/api/record/links', 'POST', { kind: 'video', where: 'here' })
    ).json()) as Link;
    expect(here.where).toBe('here');
  });

  it('asks before making a phone link when no link is on, and changes nothing', async () => {
    const { local, calls } = await boot({ tailscale: 'Running', cloudflared: true });
    const before = (await (await local('/api/record')).json()) as { recordings: unknown[] };
    const res = await local('/api/record/links', 'POST', { kind: 'voice', where: 'phone' });
    expect(res.status).toBe(200);
    const need = (await res.json()) as NeedsLink & { token?: string };
    expect(need.needsLink).toBe(true);
    // The question is worded for the route this computer would use: Tailscale here, so private.
    expect(need.plan).toMatchObject({ route: 'tailscale', public: false, ask: ASK_PRIVATE });
    expect(need.plan.id).toMatch(/^[0-9a-f]{8}$/);
    expect(need.ask).toBe(ASK_PRIVATE);
    expect(need.ask).toMatch(/private/);
    expect(need.turnOn?.tool).toBe('link_on');
    expect(need.token).toBeUndefined();
    // Tailscale was only read, never told to serve; the link is still off.
    expect(
      calls.filter(
        (c) => c[0] === 'tailscale' && (c[1] === 'serve' || c[1] === 'funnel') && c[2] !== 'status',
      ),
    ).toEqual([]);
    expect(((await (await local('/api/host')).json()) as { on: boolean }).on).toBe(false);
    expect(((await (await local('/api/record')).json()) as { recordings: unknown[] }).recordings).toEqual(
      before.recordings,
    );
  });

  it('makes a phone link on Hildegard’s own link once one is on, and auto still picks this computer', async () => {
    const { local } = await boot({ tailscale: 'Running', cloudflared: false });
    expect((await local('/api/host', 'POST', { via: 'tailscale' })).status).toBe(200);
    const phone = (await (
      await local('/api/record/links', 'POST', { kind: 'voice', where: 'phone' })
    ).json()) as Link;
    expect(phone.where).toBe('phone');
    expect(phone.viaLink).toBe(true);
    expect(phone.secure).toBe(true);
    expect(phone.url).toBe(`https://studio.example.ts.net/record/${phone.token}`);
    const auto = (await (await local('/api/record/links', 'POST', { kind: 'voice' })).json()) as Link;
    expect(auto.where).toBe('here');
    expect(auto.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('lets only the Studio’s own origin ask for the camera and microphone, so another origin’s frame can’t (first-F3)', async () => {
    const { srv } = await boot({ tailscale: 'missing', cloudflared: false });
    for (const path of ['/', '/record/anything', '/api/health']) {
      const res = await fetch(srv.url + path);
      expect(res.headers.get('permissions-policy'), path).toBe('camera=(self), microphone=(self)');
    }
    // A site preview and a published site are pages someone wrote, on this same origin: they never may.
    for (const path of ['/preview/anything/index.html', '/s/anything/']) {
      const res = await fetch(srv.url + path);
      expect(res.headers.get('permissions-policy'), path).toBe('camera=(), microphone=()');
    }
  });

  it('refuses a link that opens on this computer to anyone who is not on it', async () => {
    const { srv, local } = await boot({ tailscale: 'missing', cloudflared: false });
    const inv = (await (await local('/api/people/invites', 'POST', { role: 'director' })).json()) as {
      url: string;
    };
    const remote = srv.hostedUrl()!;
    await fetch(`${remote}/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Greta', passphrase: PASS }),
    });
    const signin = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Greta', passphrase: PASS }),
    });
    const cookie = signin.headers.getSetCookie()[0]!.split(';')[0]!;
    const post = (body: unknown) =>
      fetch(`${remote}/api/record/links`, {
        method: 'POST',
        headers: { ...H, cookie },
        body: JSON.stringify(body),
      });
    const here = await post({ kind: 'voice', where: 'here' });
    expect(here.status).toBe(400);
    expect(((await here.json()) as { code: string }).code).toBe('here');
    // Auto for someone on another device is a link for that device, never a loopback address.
    const auto = await post({ kind: 'voice' });
    expect(auto.status).toBe(201);
    const l = (await auto.json()) as Link;
    expect(l.where).toBe('phone');
    expect(l.url.startsWith(srv.url)).toBe(false);
    expect(l.url.startsWith(remote)).toBe(true);
    // Directors list only their own recordings.
    const list = await fetch(`${remote}/api/record`, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { recordings: unknown[] }).recordings).toEqual([]);
  });
});

describe('link_on', () => {
  type Local = (p: string, m?: string, b?: unknown) => Promise<Response>;
  const post = async (local: Local, body: unknown) =>
    (await (await local('/api/link/on', 'POST', body)).json()) as LinkOnResult;
  /** What the Studio or the CLI does: ask for the plan, then confirm exactly that plan (a public one is the person's own yes). */
  const on = async (local: Local, opts: { person?: boolean } = {}) => {
    const first = await post(local, {});
    const plan = 'plan' in first ? first.plan : undefined;
    if (first.status === 'on' || !plan || plan.route === 'none' || first.status === 'failed') return first;
    return post(local, { plan: plan.id, ...(opts.person && plan.public ? { acceptPublic: true } : {}) });
  };

  it('chooses Tailscale Serve when Tailscale is signed in, even with cloudflared here, and never Funnel', async () => {
    const { local, calls } = await boot({ tailscale: 'Running', cloudflared: true });
    const r = await on(local);
    expect(r).toMatchObject({
      status: 'on',
      via: 'tailscale',
      private: true,
      temporary: false,
      already: false,
      url: 'https://studio.example.ts.net',
    });
    expect(changes(calls).map((c) => c[1])).toEqual(['serve']);
    expect(calls.some((c) => c[0] === 'tailscale' && c[1] === 'funnel')).toBe(false);
    expect((r as { message: string }).message).toMatch(/private/);
    // Asked again, it says it was already on and changes nothing more.
    const again = await on(local);
    expect(again).toMatchObject({ status: 'on', already: true, via: 'tailscale' });
    expect(changes(calls)).toHaveLength(1);
  });

  it('runs a quick tunnel only on the person’s own yes to the public plan, and says it is temporary and public', async () => {
    const { local, calls } = await boot({ tailscale: 'missing', cloudflared: true });
    const r = await on(local, { person: true });
    expect(r).toMatchObject({
      status: 'on',
      via: 'quick',
      private: false,
      temporary: true,
      url: 'https://pretend-quick-name.trycloudflare.com',
    });
    const msg = (r as { message: string }).message;
    expect(msg).toMatch(/temporary/);
    expect(msg).toMatch(/public|anyone who finds the name/);
    expect(changes(calls)).toEqual([]);
    // Signed in to Tailscale too late is not a reason to leave: Tailscale signed out, cloudflared here, is a quick tunnel.
  });

  it('uses a quick tunnel when Tailscale is installed but signed out', async () => {
    const { local } = await boot({ tailscale: 'NeedsLogin', cloudflared: true });
    expect(await on(local, { person: true })).toMatchObject({ status: 'on', via: 'quick', temporary: true });
  });

  it('changes nothing and says what is missing when there is neither: one click or one command each', async () => {
    const { local, calls } = await boot({ tailscale: 'missing', cloudflared: false });
    const r = await on(local);
    expect(r.status).toBe('needs-owner');
    if (r.status !== 'needs-owner') throw new Error('unreachable');
    expect(r.steps.map((s) => s.id)).toEqual(['cloudflared', 'tailscale']);
    expect(r.steps[0]!.command).toBe('hildegard tunnel install cloudflare');
    expect(r.steps[1]!.title).toBe('Install Tailscale');
    expect(changes(calls)).toEqual([]);
    expect(((await (await local('/api/host')).json()) as { on: boolean }).on).toBe(false);
  });

  it('says to sign in when Tailscale is installed but signed out and there is no cloudflared', async () => {
    const { local } = await boot({ tailscale: 'NeedsLogin', cloudflared: false });
    const r = await on(local);
    expect(r.status).toBe('needs-owner');
    expect(r.steps.find((s) => s.id === 'tailscale')!.title).toBe('Sign in to Tailscale');
  });

  it('does not fall back to a public tunnel when Tailscale is signed in but can’t serve', async () => {
    const { local, calls } = await boot({ tailscale: 'Running', noDns: true, cloudflared: true });
    const r = await on(local);
    expect(r.status).toBe('needs-owner');
    expect(r.steps[0]!.command).toMatch(/login\.tailscale\.com/);
    expect(((await (await local('/api/host')).json()) as { on: boolean }).on).toBe(false);
    expect(changes(calls)).toEqual([]);
  });

  it('names the route in the plan and turns on nothing without the plan id (first-F1, first-F2)', async () => {
    const { local, calls, spawned } = await boot({ tailscale: 'Running', cloudflared: true });
    const first = await post(local, {});
    expect(first).toMatchObject({ status: 'confirm', plan: { route: 'tailscale', public: false } });
    expect(first.status === 'confirm' && first.message).toBe(ASK_PRIVATE);
    // A wrong id is the same as none: the answer is the plan, and nothing was changed.
    const wrong = await post(local, { plan: 'deadbeef' });
    expect(wrong).toMatchObject({ status: 'confirm', plan: { route: 'tailscale' } });
    expect(changes(calls)).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('never turns on a public route without the person’s own yes, whatever else is sent (second-F7, sol-F1)', async () => {
    const { local, spawned } = await boot({ tailscale: 'missing', cloudflared: true });
    const first = await post(local, {});
    expect(first.status).toBe('needs-owner');
    const plan = (first as { plan: Plan }).plan;
    expect(plan).toMatchObject({ route: 'quick', public: true, ask: ASK_PUBLIC });
    expect((first as { message: string }).message).toBe(PUBLIC_REFUSED);
    // The plan id alone (all an AI app can send) turns on nothing.
    const withId = await post(local, { plan: plan.id });
    expect(withId.status).toBe('needs-owner');
    expect(spawned).toEqual([]);
    expect(((await (await local('/api/host')).json()) as { on: boolean }).on).toBe(false);
  });

  it('refuses a plan that changed since it was shown, and shows the new one (first-F2)', async () => {
    const world: World = { tailscale: 'missing', cloudflared: true };
    const { local, calls, spawned } = await boot(world);
    const shown = (await post(local, {})) as { plan: Plan };
    expect(shown.plan.route).toBe('quick');
    // Tailscale comes up before the person answers. Their yes was to a public tunnel; they get a new question.
    world.tailscale = 'Running';
    const stale = await post(local, { plan: shown.plan.id, acceptPublic: true });
    expect(stale).toMatchObject({ status: 'confirm', plan: { route: 'tailscale', public: false } });
    expect(spawned).toEqual([]);
    expect(changes(calls)).toEqual([]);
    // And the other way: yes to Tailscale, then Tailscale goes down: a public route is never swapped in.
    const ts = (stale as { plan: Plan }).plan;
    world.tailscale = 'NeedsLogin';
    const down = await post(local, { plan: ts.id });
    expect(down.status).toBe('needs-owner');
    expect(spawned).toEqual([]);
  });

  it('turns on exactly the confirmed route once the plan still holds', async () => {
    const world: World = { tailscale: 'Running', cloudflared: true };
    const { local, calls, spawned } = await boot(world);
    const plan = ((await post(local, {})) as { plan: Plan }).plan;
    const done = await post(local, { plan: plan.id });
    expect(done).toMatchObject({ status: 'on', via: 'tailscale', private: true });
    expect(changes(calls).map((c) => c[1])).toEqual(['serve']);
    expect(spawned).toEqual([]);
  });

  it('answers a bad body with 400', async () => {
    const { local } = await boot({ tailscale: 'Running', cloudflared: true });
    expect((await local('/api/link/on', 'POST', { plan: 5 })).status).toBe(400);
  });

  it('makes the owner account first, and never picks a passphrase', async () => {
    const { local, calls } = await boot({ tailscale: 'Running', cloudflared: true }, { owner: false });
    const r = await on(local);
    expect(r.status).toBe('needs-owner');
    expect(r.steps.map((s) => s.id)).toEqual(['owner']);
    expect(r.steps[0]!.command).toBe('hildegard host owner');
    expect(changes(calls)).toEqual([]);
    // Nothing was made for them: there is still no owner.
    expect(((await (await local('/api/host')).json()) as { owner: boolean }).owner).toBe(false);
  });

  it('refuses a caller that is not on this computer, including a signed-in owner and a director', async () => {
    const { srv, local, calls } = await boot({ tailscale: 'Running', cloudflared: true });
    const remote = srv.hostedUrl()!;
    // Nobody signed in.
    expect((await fetch(`${remote}/api/link/on`, { method: 'POST', headers: H, body: '{}' })).status).toBe(
      401,
    );
    // The owner, signed in on another device.
    const signin = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    expect(signin.status).toBe(200);
    const cookie = signin.headers.getSetCookie()[0]!.split(';')[0]!;
    const owner = await fetch(`${remote}/api/link/on`, {
      method: 'POST',
      headers: { ...H, cookie },
      body: '{}',
    });
    expect(owner.status).toBe(403);
    expect(((await owner.json()) as { error: string }).error).toMatch(/computer Hildegard runs on/);
    // A director.
    const inv = (await (await local('/api/people/invites', 'POST', { role: 'director' })).json()) as {
      url: string;
    };
    await fetch(`${remote}/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Greta', passphrase: PASS }),
    });
    const g = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Greta', passphrase: PASS }),
    });
    const gcookie = g.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(
      (
        await fetch(`${remote}/api/link/on`, {
          method: 'POST',
          headers: { ...H, cookie: gcookie },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    // And through a proxy's headers, as a request from elsewhere that reached the Studio's own socket.
    expect(
      (
        await fetch(`${srv.url}/api/link/on`, {
          method: 'POST',
          headers: { ...H, 'x-forwarded-for': '203.0.113.9' },
          body: '{}',
        })
      ).status,
    ).not.toBe(200);
    expect(changes(calls)).toEqual([]);
    expect(((await (await local('/api/host')).json()) as { on: boolean }).on).toBe(false);
  });
});

describe('over the MCP', () => {
  const textOf = (r: CallToolResult) =>
    r.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  async function mcpAt(base: string) {
    const client = new Client({ name: 'test-chatbot', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    return client;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown>) =>
    (await c.callTool({ name, arguments: args })) as CallToolResult;

  it('gives a loopback link on this computer, asks before a phone link, and gives a QR code once there is one', async () => {
    const { srv } = await boot({ tailscale: 'Running', cloudflared: false });
    const c = await mcpAt(srv.url);
    try {
      // Here: no setup at all, and no image.
      const here = await call(c, 'record_link', { kind: 'voice', purpose: 'Narration' });
      expect(here.isError).toBeFalsy();
      const url = /Link for a voice recording: (\S+)/.exec(textOf(here))![1]!;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/record\//);
      expect(here.content.some((x) => x.type === 'image')).toBe(false);

      // Phone with no link: nothing is made, and the AI is told what to ask and which tool to call on a yes.
      const need = await call(c, 'record_link', { kind: 'voice', where: 'phone' });
      const t = textOf(need);
      expect(t).toContain(ASK_PRIVATE);
      expect(t).toMatch(/call link_on/);
      const planId = /plan: "([0-9a-f]{8})"/.exec(t)![1]!;
      expect(t).toMatch(/Do not call link_on without their yes/);
      expect(t).not.toMatch(/\/record\//);
      expect(need.content.some((x) => x.type === 'image')).toBe(false);

      // Without the person's yes (confirmed: true) link_on turns nothing on, and gives the question again.
      const unasked = await call(c, 'link_on', {});
      expect(textOf(unasked)).toContain(ASK_PRIVATE);
      expect(textOf(unasked)).toMatch(/Nothing was changed/);
      expect(((await (await fetch(`${srv.url}/api/host`)).json()) as { on: boolean }).on).toBe(false);
      // A yes with no plan id turns nothing on either: the yes has to be to a route that was described.
      const noPlan = await call(c, 'link_on', { confirmed: true });
      expect(textOf(noPlan)).toMatch(/Nothing was changed/);
      expect(((await (await fetch(`${srv.url}/api/host`)).json()) as { on: boolean }).on).toBe(false);

      // On the yes: link_on with the plan id, then the phone link, with a QR code of exactly that address.
      const turned = await call(c, 'link_on', { confirmed: true, plan: planId });
      expect(turned.isError).toBeFalsy();
      expect(textOf(turned)).toMatch(/https:\/\/studio\.example\.ts\.net/);
      expect(textOf(turned)).toMatch(/record_link again with where: "phone"/);
      const phone = await call(c, 'record_link', { kind: 'voice', where: 'phone' });
      const purl = /Link for a voice recording: (\S+)/.exec(textOf(phone))![1]!;
      expect(purl).toMatch(/^https:\/\/studio\.example\.ts\.net\/record\//);
      const img = phone.content.find((x) => x.type === 'image') as
        | { type: 'image'; data: string; mimeType: string }
        | undefined;
      expect(img?.mimeType).toBe('image/png');
      expect(Buffer.from(img!.data, 'base64').equals(qrPng(purl))).toBe(true);
    } finally {
      await c.close();
    }
  }, 60_000);

  it('with only cloudflared, link_on confirmed: true is needs-owner and starts nothing (second-F7, first-F1, sol-F1)', async () => {
    const { srv, local, calls, spawned } = await boot({ tailscale: 'missing', cloudflared: true });
    const c = await mcpAt(srv.url);
    try {
      const need = await call(c, 'record_link', { kind: 'voice', where: 'phone' });
      const t = textOf(need);
      // The sentence says a phone link would be public, and the two ways the person can do it themselves.
      expect(t).toContain(PUBLIC_REFUSED);
      expect(t).toMatch(/public/);
      expect(t).toMatch(/trycloudflare\.com/);
      expect(t).toMatch(/Record on your phone/);
      expect(t).toMatch(/type `hildegard tunnel auto` yourself at a terminal/);
      expect(t).not.toMatch(/yes-public/);
      expect(t).not.toMatch(/Turn it on\?/);
      expect(t).toMatch(/do not try link_on/);
      expect(t).not.toMatch(/confirmed: true/);
      // Even with the yes, and the right plan id, from the injected text's point of view: nothing starts.
      const plan = ((await (await local('/api/link/on', 'POST', {})).json()) as { plan: Plan }).plan;
      for (const args of [{ confirmed: true }, { confirmed: true, plan: plan.id }, { plan: plan.id }]) {
        const r = await call(c, 'link_on', args);
        expect(textOf(r)).toContain(PUBLIC_REFUSED);
        expect(textOf(r)).toMatch(/Nothing was changed/);
        expect(textOf(r)).toMatch(/cannot turn a public link on from a chat/);
      }
      expect(spawned).toEqual([]);
      expect(changes(calls)).toEqual([]);
      expect(((await (await fetch(`${srv.url}/api/host`)).json()) as { on: boolean }).on).toBe(false);
    } finally {
      await c.close();
    }
  }, 60_000);

  it('turns on Serve, never Funnel, with Tailscale ready and the matching plan id; a stale id is refused', async () => {
    const world: World = { tailscale: 'missing', cloudflared: true };
    const { srv, calls, spawned } = await boot(world);
    const c = await mcpAt(srv.url);
    try {
      // The plan the person was shown was public (no Tailscale yet) ...
      const shown = await call(c, 'link_on', {});
      expect(textOf(shown)).toContain(PUBLIC_REFUSED);
      // ... then Tailscale came up. A private question is asked, with its own id.
      world.tailscale = 'Running';
      const q = await call(c, 'link_on', {});
      expect(textOf(q)).toContain(ASK_PRIVATE);
      const id = /plan: "([0-9a-f]{8})"/.exec(textOf(q))![1]!;
      // A stale id (from before) changes nothing and asks the new question.
      const stale = await call(c, 'link_on', { confirmed: true, plan: 'deadbeef' });
      expect(textOf(stale)).toMatch(/Nothing was changed: the route changed/);
      expect(textOf(stale)).toContain(ASK_PRIVATE);
      expect(changes(calls)).toEqual([]);
      const ok = await call(c, 'link_on', { confirmed: true, plan: id });
      expect(ok.isError).toBeFalsy();
      expect(textOf(ok)).toMatch(/private/);
      expect(changes(calls).map((x) => x[1])).toEqual(['serve']);
      expect(calls.some((x) => x[0] === 'tailscale' && x[1] === 'funnel')).toBe(false);
      expect(spawned).toEqual([]);
    } finally {
      await c.close();
    }
  }, 60_000);

  it('says plainly when the phone link is public, and offers the private route if the person asked for private (sol-F2)', async () => {
    const { srv, local, spawned } = await boot({ tailscale: 'Running', cloudflared: true });
    // A Funnel link is already on (the person's own doing).
    expect((await local('/api/host', 'POST', { via: 'funnel' })).status).toBe(200);
    const c = await mcpAt(srv.url);
    try {
      const phone = await call(c, 'record_link', { kind: 'voice', where: 'phone' });
      const t = textOf(phone);
      expect(t).toMatch(/Link for a voice recording: https:\/\/studio\.example\.ts\.net/);
      expect(t).toMatch(/This link is PUBLIC/);
      expect(t).not.toMatch(/private/);
      const rest = (await (
        await local('/api/record/links', 'POST', { kind: 'voice', where: 'phone' })
      ).json()) as Link & { public: boolean };
      expect(rest.public).toBe(true);
      // Asked for private: the public link is not handed over; the private route is offered, with its plan.
      const priv = await call(c, 'record_link', { kind: 'voice', where: 'phone', private: true });
      const p = textOf(priv);
      expect(p).not.toMatch(/Link for a voice recording/);
      expect(p).toMatch(/that is on now is public/);
      expect(p).toContain(ASK_PRIVATE);
      const id = /plan: "([0-9a-f]{8})"/.exec(p)![1]!;
      const moved = await call(c, 'link_on', { confirmed: true, plan: id });
      expect(textOf(moved)).toMatch(/private/);
      const host = (await (await fetch(`${srv.url}/api/host`)).json()) as { via: string };
      expect(host.via).toBe('tailscale');
      expect(spawned).toEqual([]);
    } finally {
      await c.close();
    }
  }, 60_000);

  it('with a public link on and no private route, a request for private is told so and offered nothing to turn on', async () => {
    const { srv, local } = await boot({ tailscale: 'missing', cloudflared: true });
    const q = await local('/api/host', 'POST', { via: 'quick' });
    expect(q.status).toBe(200);
    const c = await mcpAt(srv.url);
    try {
      const priv = await call(c, 'record_link', { kind: 'voice', where: 'phone', private: true });
      const p = textOf(priv);
      expect(p).toMatch(/is public, and no private one is possible/);
      expect(p).not.toMatch(/Link for a voice recording/);
      expect(p).toMatch(/do not try link_on/);
      // Without that ask, the quick link is handed over and called public.
      const plain = await call(c, 'record_link', { kind: 'voice', where: 'phone' });
      expect(textOf(plain)).toMatch(/This link is PUBLIC/);
    } finally {
      await c.close();
    }
  }, 60_000);

  it('turns nothing on for a chat on another device', async () => {
    const { srv, local, calls } = await boot({ tailscale: 'Running', cloudflared: true });
    const key = (
      (await (await local('/api/auth/keys', 'POST', { name: 'Ada’s agent', person: 'Ada' })).json()) as {
        key: string;
      }
    ).key;
    const client = new Client({ name: 'far-chatbot', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${srv.hostedUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    try {
      const r = await call(client, 'link_on', { confirmed: true });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/computer Hildegard runs on/);
      expect(calls.filter((c) => c[0] === 'tailscale' && c[1] === 'serve' && c[2] !== 'status')).toEqual([]);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe('the QR code', () => {
  it('is a valid greyscale PNG of the address, dark on white with a quiet zone', () => {
    const png = qrPng('https://studio.example.ts.net/record/abc');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const chunks: Record<string, Buffer> = {};
    for (let at = 8; at < png.length; ) {
      const len = png.readUInt32BE(at);
      const type = png.toString('latin1', at + 4, at + 8);
      const body = png.subarray(at + 8, at + 8 + len);
      expect(png.readUInt32BE(at + 8 + len)).toBe(crc32(png.subarray(at + 4, at + 8 + len)));
      chunks[type] = body;
      at += 12 + len;
    }
    const px = chunks.IHDR!.readUInt32BE(0);
    expect(chunks.IHDR!.readUInt32BE(4)).toBe(px);
    expect(px % 8).toBe(0);
    const raw = inflateSync(chunks.IDAT!);
    expect(raw.length).toBe((px + 1) * px);
    // The quiet zone is white all round; the code has dark modules.
    expect(raw[1]).toBe(0xff);
    expect([...raw].filter((b) => b === 0x0b).length).toBeGreaterThan(px);
    expect(qrPng('a').equals(qrPng('b'))).toBe(false);
  });
});
