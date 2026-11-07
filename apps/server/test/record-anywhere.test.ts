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
import type { LinkOnResult } from '../src/link-on.ts';
import { NEEDS_LINK_ASK } from '../src/record-routes.ts';
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
  const spawn: Spawn = () => {
    const c = new FakeChild();
    setImmediate(() => {
      c.stderr.write('INF |  https://pretend-quick-name.trycloudflare.com  |\n');
      c.stderr.write('INF Registered tunnel connection connIndex=0\n');
    });
    return c;
  };
  return { calls, run, spawn };
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
type NeedsLink = { needsLink: true; where: 'phone'; ask: string; turnOn: { tool: string } };

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
    expect(need.ask).toBe(NEEDS_LINK_ASK);
    expect(need.ask).toBe(
      'To record on your phone, Hildegard needs a private link to this computer. Turn one on?',
    );
    expect(need.turnOn.tool).toBe('link_on');
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
  const on = async (local: (p: string, m?: string, b?: unknown) => Promise<Response>) =>
    (await (await local('/api/link/on', 'POST', {})).json()) as LinkOnResult;
  const changes = (calls: string[][]) =>
    calls.filter((c) => c[0] === 'tailscale' && (c[1] === 'serve' || c[1] === 'funnel') && c[2] !== 'status');

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

  it('runs a quick tunnel when only cloudflared is here, and says it is temporary and its sign-in page is public', async () => {
    const { local, calls } = await boot({ tailscale: 'missing', cloudflared: true });
    const r = await on(local);
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
    expect(await on(local)).toMatchObject({ status: 'on', via: 'quick', temporary: true });
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
      expect(t).toContain(NEEDS_LINK_ASK);
      expect(t).toMatch(/call link_on/);
      expect(t).toMatch(/Do not call link_on without their yes/);
      expect(t).not.toMatch(/\/record\//);
      expect(need.content.some((x) => x.type === 'image')).toBe(false);

      // Without the person's yes (confirmed: true) link_on turns nothing on, and gives the question again.
      const unasked = await call(c, 'link_on', {});
      expect(textOf(unasked)).toContain(NEEDS_LINK_ASK);
      expect(textOf(unasked)).toMatch(/Nothing was changed/);
      expect(((await (await fetch(`${srv.url}/api/host`)).json()) as { on: boolean }).on).toBe(false);

      // On the yes: link_on, then the phone link, with a QR code of exactly that address.
      const turned = await call(c, 'link_on', { confirmed: true });
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
