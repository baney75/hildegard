// SPDX-License-Identifier: AGPL-3.0-only
// Sites: started from Figma, pen.dev, a folder or nothing; edited over MCP; previewed sandboxed; held to the design.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChrome, serveFolder } from '../src/browser.ts';
import { fileStore, parseArgs, type Running, startServer } from '../src/index.ts';
import { importUrl, privateAddress, publicOnly } from '../src/site-import.ts';

let srv: Running;
let client: Client;
let dir: string;

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
const idOf = (t: string) => /Site ([a-f0-9]{12})/.exec(t)?.[1] ?? '';
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${srv.url}${path}`, {
    ...init,
    headers: { 'x-hildegard': '1', 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const fixtures = join(import.meta.dirname, 'fixtures', 'design');
const bakery = JSON.parse(readFileSync(join(fixtures, 'figma-bakery.json'), 'utf8'));
const png = (w: number, h: number) => {
  // A real PNG of one colour, so the reference compare can read it.
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xee)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
const tokensSeen: string[] = [];
const figmaFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
  const u = new URL(url);
  if (u.hostname === 'api.figma.com') tokensSeen.push(init?.headers?.['X-Figma-Token'] ?? '');
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v1/me') return json({ handle: 'donovan' });
  if (u.pathname === '/v1/files/AbCdEf1234567890') return json(bakery);
  if (u.pathname === '/v1/files/AbCdEf1234567890/images')
    return json({ meta: { images: { ref0abcdef: 'https://s3-alpha.figma.com/img/a' } } });
  if (u.pathname.startsWith('/v1/images/'))
    return json({
      images: {
        '1:2': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/svg',
        '1:1': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/png',
      },
    });
  if (u.pathname === '/svg')
    return new Response('<svg viewBox="0 0 2 2"><path d="M0 0h2v2z"/></svg>', {
      headers: { 'content-type': 'image/svg+xml' },
    });
  return new Response(new Uint8Array(png(1440, 1400)), { headers: { 'content-type': 'image/png' } });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hg-sites-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
    {
      fakeTickMs: 20,
      secrets: fileStore(join(dir, 'secret.json')),
      choirSecrets: (account) => fileStore(join(dir, 'secrets', `${account}.secret`)),
      figmaFetch,
    },
  );
  const server = createMcpServer(new HildegardClient(srv.url));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'claude-code-test', version: '1.0.0' });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  await srv.close();
});

describe('sites', { timeout: 60_000 }, () => {
  let site = '';

  it('starts empty, and takes files, tokens and words', async () => {
    expect(textOf(await call('site_files'))).toMatch(/No sites yet/);
    site = idOf(textOf(await call('site_new', { from: 'empty', title: 'Elm Street Bakery' })));
    expect(site).toMatch(/^[a-f0-9]{12}$/);
    const css =
      ':root {\n  --accent: #8a3b12;\n  color-scheme: light dark;\n}\n@media (prefers-color-scheme: dark) {\n  :root { --accent: #f0a46c; }\n}\n';
    expect(textOf(await call('site_write', { site_id: site, path: 'styles.css', text: css }))).toMatch(
      /Wrote styles\.css/,
    );
    expect(textOf(await call('site_tokens', { site_id: site }))).toBe(
      '--accent: #8a3b12  [styles.css]\n--accent: #f0a46c (dark)  [styles.css]',
    );
    await call('site_tokens', { site_id: site, name: '--accent', value: '#1f5f4a' });
    expect(textOf(await call('site_read', { site_id: site, path: 'styles.css' }))).toContain(
      '--accent: #1f5f4a;',
    );
    // A value that would break out of its declaration is refused.
    const bad = await call('site_tokens', {
      site_id: site,
      name: '--accent',
      value: 'red; } body { display:none',
    });
    expect(bad.isError).toBe(true);

    const r = await api(`/api/sites/${site}/text`, {
      method: 'POST',
      body: JSON.stringify({ page: 'index.html', from: 'Elm Street Bakery', to: 'Bread & salt' }),
    });
    expect(r.status).toBe(409); // in the title and the heading
    const one = await api(`/api/sites/${site}/text`, {
      method: 'POST',
      body: JSON.stringify({ page: 'index.html', from: '<h1>Elm Street Bakery</h1>', to: 'x' }),
    });
    expect(one.status).toBe(422); // markup isn't words
    await call('site_write', {
      site_id: site,
      path: 'index.html',
      text: '<!doctype html><html lang="en"><head><title>Elm Street Bakery</title><link rel="stylesheet" href="styles.css"></head><body><h1>Bread every morning</h1></body></html>',
    });
    const ok = await api(`/api/sites/${site}/text`, {
      method: 'POST',
      body: JSON.stringify({
        page: 'index.html',
        from: 'Bread every morning',
        to: 'Bread & salt, every morning',
      }),
    });
    expect(ok.status).toBe(200);
    expect(textOf(await call('site_read', { site_id: site, path: 'index.html' }))).toContain(
      '<h1>Bread &amp; salt, every morning</h1>',
    );
  });

  it('keeps every path inside the site', async () => {
    for (const path of ['../escape.html', '/etc/passwd', '.hildegard/canvas.js', 'a/../../b.css'])
      expect((await call('site_write', { site_id: site, path, text: 'x' })).isError, path).toBe(true);
    expect((await call('site_read', { site_id: 'nope', path: 'index.html' })).isError).toBe(true);
  });

  it('previews sandboxed, behind the site’s key, with the canvas helper only when asked', async () => {
    const s = (await (await api(`/api/sites/${site}`)).json()) as { preview: string };
    const page = await fetch(`${srv.url}${s.preview}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(await page.text()).not.toContain('canvas.js');
    const canvas = await (await fetch(`${srv.url}${s.preview}index.html?canvas=1`)).text();
    expect(canvas).toContain('.hildegard/canvas.js"></script></body>');
    expect((await fetch(`${srv.url}${s.preview}.hildegard/canvas.js`)).headers.get('content-type')).toMatch(
      /javascript/,
    );
    const wrong = s.preview.replace(/\/[^/]+\/$/, '/AAAAAAAAAAAAAAAAAAAAAAAA/');
    expect((await fetch(`${srv.url}${wrong}`)).status).toBe(404);
    // A new key retires the old links.
    await api(`/api/sites/${site}`, { method: 'PATCH', body: JSON.stringify({ newPreviewKey: true }) });
    expect((await fetch(`${srv.url}${s.preview}`)).status).toBe(404);
    // The API never serves a site's page as a page.
    const raw = await fetch(`${srv.url}/api/sites/${site}/files/index.html`);
    expect(raw.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    // The templates are served the same way, for the gallery; nothing outside them.
    const tpl = await fetch(`${srv.url}/preview/template/hearth/index.html`);
    expect(tpl.status).toBe(200);
    expect(tpl.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(
      (await fetch(`${srv.url}/preview/template/hearth/styles.css`)).headers.get('content-type'),
    ).toMatch(/css/);
    for (const bad of [
      'template/hearth/template.json',
      'template/nope/index.html',
      'template/..%2f..%2fpackage.json/x',
    ])
      expect((await fetch(`${srv.url}/preview/${bad}`)).status, bad).toBe(404);
  });

  it('changes words without reading the new ones as a pattern', async () => {
    await api(`/api/sites/${site}/files/words.html`, {
      method: 'PUT',
      body: '<!doctype html><title>Words</title><h1>Fresh bread</h1>',
    });
    const r = await api(`/api/sites/${site}/text`, {
      method: 'POST',
      body: JSON.stringify({ page: 'words.html', from: 'Fresh bread', to: 'Costs $& and $1 & <more>' }),
    });
    expect(r.status).toBe(200);
    const html = await (await api(`/api/sites/${site}/files/words.html`)).text();
    expect(html).toContain('<h1>Costs $&amp; and $1 &amp; &lt;more&gt;</h1>');
    await api(`/api/sites/${site}/files/words.html`, { method: 'DELETE' });
  });

  it('imports a Figma file with its design image, sending the token only to Figma', async () => {
    const before = textOf(
      await call('site_new', { from: 'figma', url: 'https://www.figma.com/design/AbCdEf1234567890/Bakery' }),
    );
    expect(before).toMatch(/no Figma token yet/);
    const bad = await api('/api/sites/figma-token', {
      method: 'PUT',
      body: JSON.stringify({ token: 'not a token' }),
    });
    expect(bad.status).toBe(422);
    const link = await api('/api/sites/figma-token', {
      method: 'PUT',
      body: JSON.stringify({ token: 'figd_0123456789abcdefghijklmnop' }),
    });
    expect(await link.json()).toEqual({ linked: true, as: 'donovan' });
    expect(readFileSync(join(dir, 'secrets', 'figma.secret'), 'utf8')).toBe(
      'figd_0123456789abcdefghijklmnop',
    );
    const made = textOf(
      await call('site_new', { from: 'figma', url: 'https://www.figma.com/design/AbCdEf1234567890/Bakery' }),
    );
    expect(made).toMatch(/“Hearth Bakery”/);
    expect(made).toMatch(/image of its design, 1440 px wide/);
    expect(made).toMatch(/index\.html, index\.css, tokens\.css|assets\/ref0abcdef\.png/);
    expect(tokensSeen.every((t) => t === '' || t === 'figd_0123456789abcdefghijklmnop')).toBe(true);
    const id = idOf(made);
    const html = textOf(await call('site_read', { site_id: id, path: 'index.html' }));
    expect(html).toContain('<h1 class="title">Bread baked at four, sold by seven.</h1>');
    const ref = await fetch(`${srv.url}/api/sites/${id}/reference`);
    expect(ref.headers.get('content-type')).toBe('image/png');
  });

  it('imports a .pen file with the pictures beside it, and a folder', async () => {
    const work = mkdtempSync(join(tmpdir(), 'hg-pen-'));
    copyFileSync(join(fixtures, 'studio.pen'), join(work, 'studio.pen'));
    mkdirSync(join(work, 'images'));
    writeFileSync(join(work, 'images', 'galley.png'), png(8, 6));
    const made = textOf(await call('site_new', { from: 'pen', pen_path: join(work, 'studio.pen') }));
    expect(made).toMatch(/assets\/galley\.png/);
    expect(made).toMatch(/lucide:arrow-right/);
    const folder = join(work, 'site');
    mkdirSync(join(folder, 'css'), { recursive: true });
    writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Folder</title>');
    writeFileSync(join(folder, 'css', 'a.css'), 'body{}');
    const f = textOf(await call('site_new', { from: 'folder', folder, title: 'From a folder' }));
    expect(f).toMatch(/2 files/);
    expect(f).toMatch(/css\/a\.css, index\.html/);
  });

  it('refuses to import addresses on this computer or its network', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.20',
      '172.20.0.1',
      '169.254.169.254',
      '100.101.102.103',
      '::1',
      'fd7a:115c:a1e0::1',
      '::ffff:10.0.0.1',
    ])
      expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '2606:4700::6810:84e5', '1.1.1.1'])
      expect(privateAddress(ip), ip).toBe(false);
    const allow = publicOnly(async (h) => (h === 'rebind.test' ? ['10.0.0.8'] : ['93.184.216.34']));
    expect(await allow('https://example.com/a.css')).toBe(true);
    expect(await allow('https://rebind.test/')).toBe(false);
    expect(await allow('http://localhost:7341/api/settings')).toBe(false);
    expect(await allow('http://[::1]/')).toBe(false);
    expect(await allow('file:///etc/passwd')).toBe(false);
    expect(await allow('https://parish1.tail1234.ts.net/')).toBe(false);
    const r = await api('/api/sites', {
      method: 'POST',
      body: JSON.stringify({ from: 'url', url: `${srv.url}/` }),
    });
    expect(r.status === 422 || r.status === 501).toBe(true);
  });

  it.runIf(findChrome() || process.env.CI)(
    'holds a web loop to the site’s design, round by round',
    { timeout: 180_000 },
    async () => {
      const { sites } = (await (await api('/api/sites')).json()) as {
        sites: { id: string; source: { kind: string } }[];
      };
      const figma = sites.find((s) => s.source.kind === 'figma')!.id;
      const start = textOf(
        await call('loop_start', {
          kind: 'web',
          title: 'Bakery from Figma',
          for: 'people deciding whether to reserve bread',
          what: 'the bakery’s home page, built from its Figma design',
          specifics: ['bread at four', 'three loaves', 'pickup order'],
          site_id: figma,
        }),
      );
      expect(start).toMatch(/compared with the site’s design image at 1440 px/);
      expect(start).toMatch(/loop_submit site_id/);
      const loop = /Loop ([a-f0-9]{16})/.exec(start)![1]!;
      const round = textOf(
        await call('loop_submit', { loop_id: loop, site_id: figma, note: 'the Figma import as it came' }),
      );
      expect(round).toMatch(/reference/);
    },
  );

  it.runIf(findChrome() || process.env.CI)(
    'imports a live page as it stands: its files kept, its scripts left out',
    { timeout: 120_000 },
    async () => {
      const site = mkdtempSync(join(tmpdir(), 'hg-live-'));
      mkdirSync(join(site, 'css'));
      mkdirSync(join(site, 'img'));
      writeFileSync(join(site, 'img', 'loaf.png'), png(40, 30));
      writeFileSync(join(site, 'img', 'grain.png'), png(4, 4));
      writeFileSync(join(site, 'css', 'site.css'), 'body{background:url("../img/grain.png?v=2&x=1")}');
      writeFileSync(
        join(site, 'index.html'),
        '<!doctype html><html lang="en"><head><title>Rye &amp; Salt</title><link rel="stylesheet" href="css/site.css"><script>document.title="changed"</script></head><body><h1 onclick="alert(1)">Rye</h1><img src="img/loaf.png" alt="A loaf"><a href="javascript:alert(1)">x</a></body></html>',
      );
      const { origin, server } = await serveFolder(site);
      try {
        const out = await importUrl(`${origin}/index.html`, findChrome()!, {
          allow: async (u) => u.startsWith(`${origin}/`) || u.startsWith('data:'),
        });
        const html = out.files.get('index.html')!.toString();
        expect(out.title).toBe('changed');
        expect(html).not.toMatch(/<script|onclick|javascript:/);
        expect(html).toMatch(/<img src="assets\/loaf-[a-f0-9]{8}\.png" alt="A loaf">/);
        expect(html).toMatch(/href="assets\/site-[a-f0-9]{8}\.css"/);
        const css = [...out.files].find(([p]) => p.endsWith('.css'))![1].toString();
        expect(css).toMatch(/url\("grain-[a-f0-9]{8}\.png"\)/);
        expect(out.reference?.width).toBe(1440);
        expect(out.notes.join(' ')).toMatch(/Scripts were left out/);
      } finally {
        server.close();
      }
    },
  );

  it('deletes a site', async () => {
    expect((await api(`/api/sites/${site}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/sites/${site}`)).status).toBe(404);
  });
});
