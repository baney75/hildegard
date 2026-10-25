// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, HildegardClient, zip } from '@hildegard/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileStore, parseArgs, type Running, startServer } from '../src/index.ts';
import { sniff } from '../src/loop.ts';
import { findChrome } from '../src/web-review.ts';
import { readZip, safeName, unzipTo, ZipError } from '../src/zip.ts';

let srv: Running;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
const enc = (s: string) => new TextEncoder().encode(s);

const QUESTIONS = [
  'intent',
  'hierarchy',
  'content',
  'type',
  'space',
  'colour',
  'specific',
  'responsive',
  'images',
  'states',
  'themes',
  'plain',
  'true',
  'looked',
  'people',
];
const answers = (answer: 'yes' | 'no' = 'yes') =>
  QUESTIONS.map((id) => ({ id, answer, evidence: 'phone and desktop first screens, light and dark' }));

/** A page that gets everything wrong that can be measured. */
const BAD = `<!doctype html><html><head><title>Acme</title>
<link rel="stylesheet" href="https://fonts.example.net/inter.css">
<style>body{margin:0;font-family:sans-serif}.wide{width:1100px}.faint{color:#c8c8c8}button{outline:none}</style></head>
<body><h1>Unlock the power of seamless baking</h1><p class="faint">Lorem ipsum dolor sit amet.</p>
<div class="wide">A strip that runs off the side of a phone.</div><img src="loaf.png"><button></button>
<input placeholder="Email"><script>missing()</script></body></html>`;

/** A small page made with care: it should pass every check. */
const GOOD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hearth Bakery · Bread on Elm Street</title>
<style>
:root{--ground:#f6f1e7;--ink:#1d1a16;--accent:#8a3b12;color-scheme:light dark}
@media (prefers-color-scheme: dark){:root{--ground:#16130f;--ink:#efe7da;--accent:#f0a46c}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:1rem/1.55 Georgia,serif}
main{max-width:40rem;margin:0 auto;padding:2rem 1.25rem}
h1{font-size:2.25rem;line-height:1.15;margin:0 0 1rem}
h2{font-size:1.4rem;margin:2rem 0 .5rem}
p{max-width:65ch}
a.button{display:inline-block;padding:.75rem 1.25rem;background:var(--accent);color:var(--ground);text-decoration:none;border-radius:6px}
a.button:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
label{display:block;margin-top:1rem}
input{font:inherit;padding:.6rem;min-height:44px;width:100%;max-width:20rem}
</style></head>
<body><main>
<h1>Sourdough from a wood oven on Elm Street</h1>
<p>We bake four loaves each morning from flour milled forty miles away. The oven is lit at three.</p>
<p><a class="button" href="#order">Reserve a loaf for tomorrow</a></p>
<h2 id="order">Reserve a loaf</h2>
<form><label for="email">Your email</label><input id="email" type="email" autocomplete="email"></form>
<h2>Hours</h2><p>Tuesday to Saturday, seven until the bread runs out, usually before eleven.</p>
</main></body></html>`;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-web-loop-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
    { fakeTickMs: 20, secrets: fileStore(join(dir, 'secret.json')) },
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

describe('web rounds as files', () => {
  it('tells a page and a ZIP from their bytes', () => {
    expect(sniff(enc('<!doctype html><html></html>'))).toBe('html');
    expect(sniff(enc('\n  <!-- made by hand --><HTML lang="en">'))).toBe('html');
    expect(sniff(zip([{ name: 'index.html', data: enc('<p>hi</p>') }]))).toBe('zip');
    expect(sniff(enc('<p>just a fragment</p>'))).toBeNull();
  });

  it('unpacks a site and refuses paths that leave its folder', () => {
    expect(safeName('css/site.css')).toBe('css/site.css');
    for (const bad of ['../x.html', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b', ''])
      expect(safeName(bad), bad).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'hg-zip-'));
    const files = unzipTo(
      zip([
        { name: 'site/index.html', data: enc('<!doctype html>') },
        { name: 'site/img/a.svg', data: enc('<svg/>') },
      ]),
      dir,
    );
    expect(files.sort()).toEqual(['img/a.svg', 'index.html']);
    expect(readFileSync(join(dir, 'img', 'a.svg'), 'utf8')).toBe('<svg/>');
    expect(() => readZip(zip([{ name: '../escape.html', data: enc('x') }]))).toThrow(ZipError);
    // A file that says it is small and inflates into more is refused, not written.
    const bomb = zip([{ name: 'big.html', data: Buffer.alloc(200_000, 32) }]);
    const lie = Buffer.from(bomb);
    const cd = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lie.writeUInt32LE(10, cd + 24);
    expect(() => readZip(lie)).toThrow(ZipError);
  });
});

// CI has a browser on every system, so there this always runs; elsewhere it needs one.
describe.runIf(findChrome() || process.env.CI)('a web page loop over MCP', { timeout: 180_000 }, () => {
  it('renders every width in light and dark, outlines the faults, and passes a page made with care', async () => {
    const start = textOf(
      await call('loop_start', {
        kind: 'web',
        title: 'Bakery page',
        for: 'people on Elm Street deciding whether to reserve bread',
        what: 'a one-page site for a small bakery',
        specifics: ['the wood oven', 'four loaves a morning', 'reserve by email'],
        dark: true,
      }),
    );
    const id = /Loop (\w{16})/.exec(start)![1]!;
    expect(start).toContain('hierarchy');
    expect(start).toContain('file_path to the HTML page or to the site’s folder');

    const r1 = await call('loop_submit', { loop_id: id, note: 'First draft from a template', text: BAD });
    const t1 = textOf(r1);
    expect(r1.isError, t1).toBeFalsy();
    for (const fault of [
      'overflow',
      'contrast',
      'alt',
      'names',
      'labels',
      'head',
      'placeholder',
      'errors',
      'focus',
      'dark',
    ])
      expect(t1, fault).toMatch(new RegExp(`FAIL ${fault}\\b`));
    expect(t1).toMatch(/warn offline/);
    expect(t1).toContain('fonts.example.net');
    const img = r1.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined;
    expect(img?.mimeType).toBe('image/jpeg');

    await call('loop_critique', {
      loop_id: id,
      round: 1,
      answers: answers('no'),
      change: 'Start again from the bakery’s own words',
    });

    // Round two arrives as the site's folder, which the MCP server packs.
    const site = mkdtempSync(join(tmpdir(), 'hg-site-'));
    writeFileSync(join(site, 'index.html'), GOOD);
    mkdirSync(join(site, '.git'));
    writeFileSync(join(site, '.git', 'config'), 'secret');
    const r2 = await call('loop_submit', {
      loop_id: id,
      note: 'Rewrote it around the oven',
      file_path: site,
    });
    const t2 = textOf(r2);
    expect(t2, t2).not.toMatch(/FAIL/);
    const c2 = textOf(await call('loop_critique', { loop_id: id, round: 2, answers: answers() }));
    expect(c2).toContain('Finish the loop with round 2');
  });

  it('checks the pages it is told to, and says which pages a site has', async () => {
    const id = /Loop (\w{16})/.exec(
      textOf(
        await call('loop_start', {
          kind: 'web',
          title: 'Two pages',
          for: 'a test',
          what: 'a site with a missing page',
          specifics: ['two pages'],
          pages: ['index.html', 'about.html'],
        }),
      ),
    )![1]!;
    const data = zip([{ name: 'index.html', data: enc(GOOD) }]).toString('base64');
    const r = await call('loop_submit', { loop_id: id, note: 'one page only', data });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('no about.html');
  });
});
