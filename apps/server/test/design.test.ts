// SPDX-License-Identifier: AGPL-3.0-only
// Design files into code: Figma and pen.dev files read into one tree, and that tree written out as HTML and CSS.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanSvg, type Design, designSite, slug } from '../src/design.ts';
import {
  FigmaError,
  figmaDesign,
  figmaFrames,
  figmaNeeds,
  importFigma,
  parseFigmaUrl,
} from '../src/figma.ts';
import { PenError, parseJsonc, penDesign, penImages } from '../src/pen.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'design', name), 'utf8');
const bakery = JSON.parse(fixture('figma-bakery.json'));

describe('the design writer', () => {
  it('keeps only plain drawing from SVG', () => {
    const ok = '<svg viewBox="0 0 4 4"><path d="M0 0h4v4z" fill="url(#g)"/></svg>';
    expect(cleanSvg(`<?xml version="1.0"?>${ok}`)).toBe(ok);
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="https://x.test"><path d="M0 0"/></a></svg>',
      '<svg><image href="https://x.test/p.png"/></svg>',
      '<svg><path style="fill:url(https://x.test/a)"/></svg>',
      '<svg><foreignObject><div>hi</div></foreignObject></svg>',
      '<div>not svg</div>',
    ])
      expect(cleanSvg(bad)).toBeNull();
  });

  it('makes CSS-safe names', () => {
    expect(slug('Hero / Title 2')).toBe('hero-title-2');
    expect(slug('42')).toBe('part-42');
    expect(slug('Ünïcödé')).toBe('unicode');
    expect(slug('"><script>')).toBe('script');
  });

  it('escapes every word it writes', () => {
    const d: Design = {
      title: 'A <b>title</b>',
      colors: [],
      fonts: [],
      notes: [],
      pages: [
        {
          name: 'Home',
          root: {
            kind: 'box',
            name: 'Root',
            x: 0,
            y: 0,
            w: 800,
            h: 600,
            wSize: 'fixed',
            hSize: 'fixed',
            fills: [],
            layout: { dir: 'column', gap: 0, padding: [0, 0, 0, 0], justify: 'start', align: 'start' },
            children: [
              {
                kind: 'text',
                name: 'x" onclick="alert(1)',
                x: 0,
                y: 0,
                w: 100,
                h: 20,
                wSize: 'hug',
                hSize: 'hug',
                fills: [],
                text: {
                  content: '<script>alert(1)</script>',
                  style: { size: 16 },
                  href: 'javascript:alert(1)',
                },
                children: [],
              },
            ],
          },
        },
      ],
    };
    const html = designSite(d).files.get('index.html')!;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onclick=');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<title>Home · A &lt;b&gt;title&lt;/b&gt;</title>');
  });
});

describe('Figma import', () => {
  it('reads links to files and frames', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Bakery?node-id=12-34&t=x')).toEqual({
      key: 'AbCdEf1234567890',
      nodeId: '12:34',
    });
    expect(parseFigmaUrl('https://figma.com/file/AbCdEf1234567890/Bakery')).toEqual({
      key: 'AbCdEf1234567890',
    });
    expect(parseFigmaUrl('AbCdEf1234567890')).toEqual({ key: 'AbCdEf1234567890' });
    expect(parseFigmaUrl('https://figma.com.evil.test/design/AbCdEf1234567890/x')).toBeNull();
    expect(parseFigmaUrl('http://www.figma.com/design/AbCdEf1234567890/x')).toBeNull();
    expect(parseFigmaUrl('not a link')).toBeNull();
  });

  it('turns frames into pages of semantic, responsive HTML', () => {
    const frames = figmaFrames(bakery.document);
    expect(frames.map((f) => f.name)).toEqual(['Home']);
    const needs = figmaNeeds(frames);
    expect(needs.svgIds).toEqual(['1:2']);
    expect(needs.imageRefs).toHaveLength(3);
    const images = new Map(needs.imageRefs.map((r, i) => [r, `assets/loaf${i}.png`]));
    const svgs = new Map([['1:2', '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14"/></svg>']]);
    const d = figmaDesign(bakery.name, frames, bakery.styles, { images, svgs });
    expect(d.colors).toEqual([
      { name: 'ground', light: '#f6f1e7', dark: '#201c18' },
      { name: 'ink', light: '#1d1a16', dark: undefined },
      { name: 'brand-accent', light: '#8a3b12', dark: undefined },
    ]);
    expect(d.fonts.sort()).toEqual(['Fraunces', 'Inter']);
    expect(d.notes.join('\n')).toMatch(/Only 1 of 3 colours have a dark value/);
    const site = designSite(d);
    expect(site.pages).toEqual(['index.html']);
    const html = site.files.get('index.html')!;
    const css = site.files.get('index.css')!;
    expect(html).toContain('<nav class="nav">');
    expect(html).toContain('<footer class="footer">');
    expect(html).toMatch(/<h1 class="title">Bread baked at four, sold by seven.<\/h1>/);
    expect(html).toMatch(/<h2 class="heading">Today’s bread<\/h2>/);
    expect(html).toContain('<a class="order-link" href="#order">Order for pickup</a>');
    expect(html).toContain('alt="Country sourdough loaf"');
    expect(html).toContain('<circle');
    expect(css).toMatch(/\.hero\{[^}]*background-color:var\(--ground\)/);
    expect(css).toMatch(/\.row\{[^}]*flex-wrap:wrap/);
    expect(css).toMatch(/\.card\{[^}]*flex:1 1 249\.6px/);
    expect(css).toMatch(/\.title\{[^}]*font-size:clamp\(/);
    expect(site.files.get('tokens.css')).toContain('@media (prefers-color-scheme: dark)');
  });

  it('downloads only from Figma, and sends the token only to its API', async () => {
    const calls: { url: string; token?: string }[] = [];
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const res = (body: string | Buffer, type = 'application/json') =>
      new Response(body, { headers: { 'content-type': type } });
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, token: init?.headers?.['X-Figma-Token'] });
      const u = new URL(url);
      if (u.pathname === '/v1/files/AbCdEf1234567890') return res(JSON.stringify(bakery));
      if (u.pathname.endsWith('/images') && u.pathname.startsWith('/v1/files/'))
        return res(
          JSON.stringify({
            meta: {
              images: {
                ref0abcdef: 'https://s3-alpha.figma.com/img/a',
                ref1abcdef: 'https://evil.test/steal',
                ref2abcdef: 'http://s3-alpha.figma.com/img/c',
              },
            },
          }),
        );
      if (u.pathname.startsWith('/v1/images/') && u.searchParams.get('format') === 'svg')
        return res(
          JSON.stringify({ images: { '1:2': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/svg' } }),
        );
      if (u.pathname.startsWith('/v1/images/'))
        return res(
          JSON.stringify({ images: { '1:1': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/png' } }),
        );
      if (u.hostname.endsWith('amazonaws.com') && u.pathname === '/svg')
        return res('<svg viewBox="0 0 2 2"><path d="M0 0h2v2z"/></svg>', 'image/svg+xml');
      return res(png, 'image/png');
    };
    const out = await importFigma('https://www.figma.com/design/AbCdEf1234567890/Bakery', 'figd_secret', {
      fetch: fake,
    });
    for (const c of calls)
      expect(c.token === 'figd_secret').toBe(new URL(c.url).hostname === 'api.figma.com');
    expect(calls.some((c) => c.url.includes('evil.test'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('http:'))).toBe(false);
    expect([...out.files.keys()]).toEqual(['assets/ref0abcdef.png']);
    expect(out.reference).toEqual({ data: png, width: 1440 });
    expect(out.design.notes.join('\n')).toMatch(/2 picture fills couldn’t be downloaded/);
    expect(designSite(out.design).files.get('index.html')).toContain('<path d="M0 0h2v2z"/>');
  });

  it('says plainly when Figma refuses', async () => {
    const no = async () => new Response('{}', { status: 403 });
    await expect(importFigma('AbCdEf1234567890', 't', { fetch: no })).rejects.toThrow(/refused the token/);
    await expect(importFigma('https://example.com/x', 't', { fetch: no })).rejects.toBeInstanceOf(FigmaError);
  });
});

describe('.pen import', () => {
  const pen = fixture('studio.pen');

  it('reads JSON with comments and trailing commas, and leaves strings alone', () => {
    expect(parseJsonc('// note\n{ "a": "http://x.test/*y*/", /* c */ "b": [1, 2,], }')).toEqual({
      a: 'http://x.test/*y*/',
      b: [1, 2],
    });
  });

  it('expands components, keeps themes, and draws paths', () => {
    expect(penImages(parseJsonc(pen))).toEqual(['images/galley.png', 'images/missing.png']);
    const d = penDesign(pen, 'Studio Ostra', new Map([['images/galley.png', 'assets/galley.png']]));
    expect(d.pages.map((p) => p.name)).toEqual(['Studio Ostra']);
    expect(d.colors).toContainEqual({ name: 'color-accent', light: '#1f5f4a', dark: '#7fd1b0' });
    expect(d.notes.join('\n')).toMatch(/lucide:arrow-right/);
    expect(d.notes.join('\n')).toMatch(/images\/missing\.png/);
    const site = designSite(d);
    const html = site.files.get('index.html')!;
    expect(html).toContain('<h1 class="title">Kitchens drawn around how you cook.</h1>');
    expect(html).toMatch(/<p class="lede">Studio Ostra designs/);
    expect(html).toMatch(
      /<a class="button" href="#">[\s\S]*<span class="label">Book a kitchen visit<\/span>/,
    );
    expect(html).toContain('data-icon="lucide:arrow-right"');
    expect(html).toContain('<path d="M12 2 L22 12 L12 22 L2 12 Z" style="fill:var(--color-accent)"/>');
    expect(html).toContain('alt="Galley kitchen in oak"');
    expect(html).not.toContain('Swap for the Alder Street photo');
    const css = site.files.get('index.css')!;
    expect(css).toMatch(/\.hero\{[^}]*padding:72px 64px 72px 64px/);
    expect(css).toMatch(/\.button\{[^}]*border-radius:999px/);
    expect(site.files.get('tokens.css')).toMatch(/--color-ink: #f1ede4/);
  });

  it('refuses what isn’t a .pen file, and paths that aren’t path data', () => {
    expect(() => penDesign('{"a":1}')).toThrow(PenError);
    expect(() => penDesign('nope')).toThrow(/isn’t valid JSON/);
    const evil = {
      children: [
        {
          type: 'frame',
          id: 'f',
          children: [
            { type: 'path', id: 'p', geometry: 'M0 0"/><script>alert(1)</script>', fill: '#000000' },
          ],
        },
      ],
    };
    const html = designSite(penDesign(evil)).files.get('index.html')!;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<svg');
  });
});
