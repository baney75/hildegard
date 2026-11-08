// SPDX-License-Identifier: AGPL-3.0-only
// Browser demos: the step script and what its log shows, the addresses and folders a demo may use, and the harness
// itself, headless, against a local page with a tiny unpacked extension, recorded onto a backdrop.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveFolder } from '../src/browser.ts';
import { parseArgs } from '../src/config.ts';
import {
  BACKDROPS,
  backdropOf,
  checkExtension,
  checkUrl,
  DemoError,
  Demos,
  demoChromium,
  describeStep,
  INSTALL_CHROMIUM,
  looksSecret,
  maskUrl,
  parseSteps,
  projectFolder,
} from '../src/demo.ts';
import { type Running, startServer } from '../src/server.ts';
import { py } from './audio.ts';
import { memoryStore } from './helpers.ts';

const fixtures = fileURLToPath(new URL('./fixtures/demo/', import.meta.url));
const renderScript = fileURLToPath(new URL('../../../tools/demo_render.py', import.meta.url));
/** Fake keys in the shapes services use, put together here so no scanner takes them for real ones. */
const fake = (...parts: string[]) => parts.join('');

describe('the step script', () => {
  it('reads JSON text, a list, or { steps }, and names the step that is wrong', () => {
    const steps = [
      { do: 'goto', url: 'https://example.com' },
      { do: 'click', text: 'Sign up' },
      { do: 'type', selector: '#email', text: 'ada@example.com', delay: 60 },
      { do: 'key', key: 'Enter' },
      { do: 'wait', text: 'Welcome' },
      { do: 'scroll', y: 400 },
      { do: 'pause', ms: 500 },
      { do: 'caption', text: 'That’s it.' },
    ];
    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
    expect(parseSteps({ steps })).toEqual(steps);
    expect(parseSteps(steps)).toHaveLength(8);
    for (const [bad, msg] of [
      ['{nope', /aren’t JSON/],
      [{ do: 'click' }, /a list/],
      [[{ do: 'fly' }], /Step 1 isn’t right/],
      [[{ do: 'goto', url: 'x' }, { do: 'click' }], /Step 2: say what to click/],
      [[{ do: 'click', text: 'A', selector: '#a' }], /Step 1: give text or selector, not both/],
      [[{ do: 'pause', ms: 60_000 }], /Step 1 isn’t right \(ms\)/],
      [Array.from({ length: 201 }, () => ({ do: 'pause', ms: 1 })), /at most 200 steps/],
    ] as const)
      expect(() => parseSteps(bad), JSON.stringify(bad).slice(0, 40)).toThrow(msg);
  });

  it('shows what was typed into a masked or password field, or anything that looks like a key, as dots', () => {
    const type = (text: string, extra: Record<string, unknown> = {}) =>
      describeStep({ do: 'type', text, ...extra } as Parameters<typeof describeStep>[0]);
    expect(type('Ada Lovelace')).toBe('Type “Ada Lovelace”');
    expect(type('correct horse battery', { mask: true })).toMatch(/^Type “•+”$/);
    expect(describeStep({ do: 'type', text: 'hunter2hunter2' }, { password: true })).not.toContain('hunter2');
    for (const key of [
      fake('sk-', 'proj-abc123def456ghi789'),
      fake('gh', 'p_', '1234567890abcdefghij', 'ABCDEFGHIJ123456'),
      fake('xo', 'xb-', '12345-67890-abcdef'),
      fake('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxIn0.sig'),
      fake('A1b2C3d4E5', 'f6G7h8I9j0K1'),
    ]) {
      expect(looksSecret(key), key).toBe(true);
      expect(type(key)).not.toContain(key.slice(0, 8));
    }
    for (const plain of ['hello world', 'Say hello', 'supercalifragilistic', '2026-11-07'])
      expect(looksSecret(plain)).toBe(false);
    // Addresses: the password and token-like query values are dots.
    expect(maskUrl('https://ada:pw@example.com/x?token=abc&page=2')).toBe(
      'https://ada:••••@example.com/x?token=••••&page=2',
    );
    expect(
      describeStep({ do: 'goto', url: `https://example.com/?api_key=${fake('sk-', 'live-1234567890ab')}` }),
    ).not.toContain('sk-live');
  });
});

describe('what a demo may open', () => {
  const root = mkdtempSync(join(tmpdir(), 'hg-demoroot-'));
  writeFileSync(join(root, 'index.html'), '<p>hi</p>');

  it('opens http and https, and files inside the project folder only', () => {
    expect(checkUrl('https://example.com/a', null)).toBe('https://example.com/a');
    expect(checkUrl('http://127.0.0.1:5173/', null)).toBe('http://127.0.0.1:5173/');
    const inside = pathToFileURL(join(root, 'index.html')).toString();
    expect(checkUrl(inside, projectFolder(root))).toMatch(/index\.html$/);
    expect(() => checkUrl(inside, null)).toThrow(/project folder/);
    expect(() => checkUrl(pathToFileURL('/etc/hostname').toString(), projectFolder(root))).toThrow(DemoError);
    expect(() =>
      checkUrl(pathToFileURL(join(root, '..', 'x.html')).toString(), projectFolder(root)),
    ).toThrow();
    for (const bad of [
      'javascript:alert(1)',
      'chrome://settings',
      'data:text/html,hi',
      'ftp://x',
      'not a url',
    ])
      expect(() => checkUrl(bad, root), bad).toThrow(DemoError);
    // Nothing signs in: a name and password in the address are refused.
    expect(() => checkUrl('https://ada:pw@example.com/', null)).toThrow(/doesn’t sign in/);
  });

  it('takes a project folder only when it is one, and not the home folder or a disk', () => {
    expect(() => projectFolder(homedir())).toThrow(/not your home folder/);
    expect(() => projectFolder('/')).toThrow();
    expect(() => projectFolder('relative/path')).toThrow(/full path/);
    expect(() => projectFolder(join(root, 'nope'))).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('takes an unpacked extension’s folder only with its manifest', () => {
    expect(checkExtension(join(fixtures, 'extension'))).toMatch(/extension$/);
    expect(() => checkExtension(root)).toThrow(/no manifest\.json/);
    expect(() => checkExtension('ext')).toThrow(/full path/);
  });

  it('names its backdrops and takes a color, and refuses anything else', () => {
    expect(backdropOf(undefined)).toEqual(BACKDROPS.viridian);
    expect(backdropOf('#1F5A3D')).toEqual({ kind: 'solid', colors: ['#1f5a3d'] });
    expect(() => backdropOf('plaid')).toThrow(/Backdrops:/);
  });

  it('never downloads a browser: with none, it says the command and stops', () => {
    // Playwright's own folder is looked for under the home folder too: both point at empty folders here.
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      const env = { PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(join(tmpdir(), 'hg-nopw-')), HOME: root };
      expect(() => demoChromium(env)).toThrow(expect.objectContaining({ status: 424 }));
      expect(() => demoChromium(env)).toThrow(INSTALL_CHROMIUM);
    } finally {
      process.env.HOME = home;
    }
    expect(INSTALL_CHROMIUM).toBe('npx playwright@1.63.0 install chromium');
  });
});

describe('the harness, headless', () => {
  let chrome: string | null = null;
  let site: Awaited<ReturnType<typeof serveFolder>> | null = null;
  beforeAll(async () => {
    try {
      chrome = demoChromium();
    } catch {
      chrome = null;
    }
    site = await serveFolder(fixtures);
  });
  afterAll(() => site?.server.close());

  it('records a site with an unpacked extension onto the backdrop, typing and clicking by itself', async (ctx) => {
    if (!chrome) ctx.skip();
    const kept: string[] = [];
    const out = mkdtempSync(join(tmpdir(), 'hg-demoout-'));
    const mine = () => readdirSync(tmpdir()).filter((n) => /^hg-(demo|web)-/.test(n)).length;
    const before = mine();
    const demos = new Demos({
      keep: async (_owner, file) => {
        const dest = join(out, 'kept.mp4');
        copyFileSync(file, dest);
        kept.push(dest);
        return 'rec_0000000000000001';
      },
      python: () => py,
      script: () => renderScript,
      chromium: () => chrome!,
      headless: true,
    });
    const typedKey = fake('sk-', 'proj-abc123def456ghi789');
    const job = demos.start('local', {
      url: `${site!.origin}/page.html`,
      extension: join(fixtures, 'extension'),
      steps: parseSteps([
        { do: 'click', selector: '#name' },
        { do: 'type', text: 'Ada', delay: 30 },
        { do: 'type', text: typedKey, mask: true, delay: 5 },
        { do: 'click', text: 'Say hello' },
        { do: 'wait', text: 'Hello, Ada' },
        { do: 'caption', text: 'It says hello.', ms: 600 },
      ]),
      width: 960,
      height: 600,
      backdrop: { kind: 'solid', colors: ['#2c7350'] },
      aspect: '16:9',
      padding: 0.1,
      zoom: false,
    });
    const end = Date.now() + 90_000;
    while (!['done', 'failed', 'stopped'].includes(demos.get(job.id)!.status) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 200));
    const j = demos.get(job.id)!;
    expect(j.error).toBeNull();
    expect(j.status).toBe('done');
    expect(j.recording).toBe('rec_0000000000000001');
    // The step log never shows what was typed as a key.
    expect(j.log.join('\n')).toContain('Type “Ada”');
    expect(j.log.join('\n')).not.toContain('sk-proj');
    // The throwaway profile and the frames are gone.
    await new Promise((r) => setTimeout(r, 2500));
    expect(mine()).toBeLessThanOrEqual(before);

    const file = kept[0]!;
    expect(existsSync(file)).toBe(true);
    // A frame from the middle: the backdrop's color in the padding, and the extension's badge inside the window.
    const probe = execFileSync(
      py,
      [
        '-I',
        '-c',
        `
import av, json, sys
c = av.open(sys.argv[1]); s = c.streams.video[0]
frames = [f.to_ndarray(format='rgb24') for f in c.decode(s)]
f = frames[len(frames) // 2]
h, w, _ = f.shape
pad = f[h // 2, 20].tolist()
inset = round(min(w, h) * 0.1)
k = min((w - 2 * inset) / 960, (h - 2 * inset) / 600)
x0 = (w - round(960 * k)) // 2; y0 = (h - round(600 * k)) // 2
badge = f[y0 + round(24 * k), x0 + round(24 * k)].tolist()
print(json.dumps({"w": w, "h": h, "n": len(frames), "pad": pad, "badge": badge}))
`,
        file,
      ],
      { encoding: 'utf8' },
    );
    const m = JSON.parse(probe.trim().split('\n').at(-1)!) as {
      w: number;
      h: number;
      n: number;
      pad: number[];
      badge: number[];
    };
    expect([m.w, m.h]).toEqual([1920, 1080]);
    // A steady 30 a second for as long as it ran.
    expect(m.n).toBeGreaterThan(30 * 2);
    const near = (a: number[], b: number[], d = 24) => a.every((v, i) => Math.abs(v - b[i]!) <= d);
    expect(near(m.pad, [0x2c, 0x73, 0x50]), `padding ${m.pad}`).toBe(true);
    expect(near(m.badge, [0xff, 0x00, 0xaa], 40), `badge ${m.badge}`).toBe(true);
  }, 120_000);
});

describe('/api/demos', () => {
  const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
  const PASS = 'a long and private passphrase';
  let srv: Running;
  let remote: string;
  const work = mkdtempSync(join(tmpdir(), 'hg-demoapi-'));
  const local = (path: string, body?: unknown) =>
    fetch(srv.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: H,
      body: JSON.stringify(body),
    });
  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });
    srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', join(work, 'data'), '--ui', work]), port: 0, hostPort: port },
      {
        fakeTickMs: 20,
        secrets: memoryStore(),
        exec: async () => ({ ok: false, out: '' }),
        limits: { perName: 50, perClient: 1000 },
      },
    );
    remote = srv.hostedUrl()!;
    await local('/api/people/owner', { name: 'Ada', passphrase: PASS });
  }, 30_000);
  afterAll(() => srv.close());

  it('is the owner’s: nobody signed in and a director are refused', async () => {
    const body = { url: 'https://example.com', steps: [] };
    expect(
      (await fetch(`${remote}/api/demos`, { method: 'POST', headers: H, body: JSON.stringify(body) })).status,
    ).toBe(401);
    const inv = (await (await local('/api/people/invites', { role: 'director' })).json()) as { url: string };
    await fetch(`${remote}/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Dee', passphrase: PASS }),
    });
    const signin = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Dee', passphrase: PASS }),
    });
    const cookie = signin.headers.getSetCookie()[0]!.split(';')[0]!;
    const res = await fetch(`${remote}/api/demos`, {
      method: 'POST',
      headers: { ...H, cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    // The owner, signed in elsewhere: a folder, a file address or a window to drive is only from this computer.
    const own = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    const owner = own.headers.getSetCookie()[0]!.split(';')[0]!;
    for (const b of [
      { url: 'https://example.com', steps: [], extension: join(fixtures, 'extension') },
      { url: 'file:///etc/hostname', steps: [] },
      { url: 'https://example.com' },
    ]) {
      const r = await fetch(`${remote}/api/demos`, {
        method: 'POST',
        headers: { ...H, cookie: owner },
        body: JSON.stringify(b),
      });
      expect(r.status, JSON.stringify(b)).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe('here');
    }
  });

  it('checks the steps and the address before it opens anything, and says the install command when there’s no browser', async () => {
    const bad = await local('/api/demos', { url: 'https://example.com', steps: [{ do: 'fly' }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Step 1 isn’t right/);
    const was = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const home = process.env.HOME;
    process.env.PLAYWRIGHT_BROWSERS_PATH = mkdtempSync(join(tmpdir(), 'hg-nopw-'));
    process.env.HOME = work;
    try {
      const none = await local('/api/demos', { url: 'https://example.com', steps: [] });
      expect(none.status).toBe(424);
      expect(((await none.json()) as { error: string }).error).toContain(INSTALL_CHROMIUM);
    } finally {
      process.env.PLAYWRIGHT_BROWSERS_PATH = was;
      process.env.HOME = home;
      if (was === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
    expect((await local('/api/demos/dmo_0000000000000000')).status).toBe(404);
  });

  it('demo_browser over the MCP: the install command when there’s no browser, and no folders for an app elsewhere', async () => {
    const client = new Client({ name: 'test-chatbot', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    const call = async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: 'demo_browser', arguments: args })) as CallToolResult;
      return {
        error: !!r.isError,
        text: r.content.map((c) => (c as { text?: string }).text ?? '').join('\n'),
      };
    };
    const was = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const home = process.env.HOME;
    process.env.PLAYWRIGHT_BROWSERS_PATH = mkdtempSync(join(tmpdir(), 'hg-nopw-'));
    process.env.HOME = work;
    try {
      const r = await call({ url: 'https://example.com', steps: [{ do: 'pause', ms: 100 }] });
      expect(r.error).toBe(true);
      expect(r.text).toContain(INSTALL_CHROMIUM);
      const bad = await call({ url: 'https://example.com', steps: [{ do: 'click' }] });
      expect(bad.error).toBe(true);
    } finally {
      process.env.PLAYWRIGHT_BROWSERS_PATH = was;
      process.env.HOME = home;
      if (was === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      await client.close();
    }
  });
});
