// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileStore, parseArgs, type Running, startServer } from '../src/index.ts';
import { minutes, readGcode } from '../src/printer.ts';

let srv: Running;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
const QUESTIONS = [
  'intent',
  'silhouette',
  'proportion',
  'hierarchy',
  'surface',
  'life',
  'base',
  'near',
  'looked',
  'people',
];
const answers = () =>
  QUESTIONS.map((id) => ({ id, answer: 'yes', evidence: 'all eight views and the checks' }));
const loopId = (t: string) => /Loop (\w{16})/.exec(t)![1]!;

/** A ring of `n` points at radius r, height z. */
const ring = (r: number, z: number, n = 64) =>
  Array.from({ length: n }, (_, j) => [
    r * Math.cos((2 * Math.PI * j) / n),
    r * Math.sin((2 * Math.PI * j) / n),
    z,
  ]);

/** A pin (a cylinder) and the sleeve it slides into (a tube), as one OBJ with each part named. */
function pinAndSleeve(pinR: number, holeR = 5, outerR = 9) {
  const n = 64;
  const v: number[][] = [];
  const f: number[][] = [];
  const lines: string[] = [];
  // The sleeve: outer bottom, inner bottom, outer top, inner top.
  v.push(...ring(outerR, 0), ...ring(holeR, 0), ...ring(outerR, 20), ...ring(holeR, 20));
  const [ob, ib, ot, it] = [0, n, 2 * n, 3 * n];
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    f.push([ob + j, ob + k, ot + k], [ob + j, ot + k, ot + j]);
    f.push([ib + j, it + k, ib + k], [ib + j, it + j, it + k]);
    f.push([ot + j, ot + k, it + k], [ot + j, it + k, it + j]);
    f.push([ob + j, ib + k, ob + k], [ob + j, ib + j, ib + k]);
  }
  lines.push(
    'o sleeve',
    ...v.map((p) => `v ${p.join(' ')}`),
    ...f.map((t) => `f ${t.map((i) => i + 1).join(' ')}`),
  );
  // The pin: a cylinder from z = -2 to 22, standing through the sleeve.
  const base = v.length;
  const pv = [...ring(pinR, -2), ...ring(pinR, 22), [0, 0, -2], [0, 0, 22]];
  const pf: number[][] = [];
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    pf.push([j, k, n + k], [j, n + k, n + j], [2 * n, k, j], [2 * n + 1, n + j, n + k]);
  }
  lines.push(
    'o pin',
    ...pv.map((p) => `v ${p.join(' ')}`),
    ...pf.map((t) => `f ${t.map((i) => i + base + 1).join(' ')}`),
  );
  return `${lines.join('\n')}\n`;
}

/** An L bracket, 60 mm along x, 40 mm tall, 20 mm deep: a foot and an upright on the left. */
function bracket() {
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, at: number) => {
    const v = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    const q = [
      [1, 4, 3, 2],
      [5, 6, 7, 8],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 4, 8, 7],
      [4, 1, 5, 8],
    ];
    return [...v.map((p) => `v ${p.join(' ')}`), ...q.map((x) => `f ${x.map((i) => i + at).join(' ')}`)];
  };
  // Two boxes touching would share faces; overlap them inside instead, which the views read as one bracket.
  return [...box(0, 60, 0, 20, 0, 8, 0), ...box(0, 8, 0, 20, 0, 40, 8)].join('\n');
}
const L: [number, number][] = [
  [0, 0],
  [60, 0],
  [60, 8],
  [8, 8],
  [8, 40],
  [0, 40],
];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-print-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
    {
      fakeTickMs: 20,
      secrets: fileStore(join(dir, 'secret.json')),
      slicer: {
        path: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/fake-slicer.mjs', import.meta.url))],
        kind: 'prusa',
        name: 'PrusaSlicer',
      },
    },
  );
  const server = createMcpServer(new HildegardClient(srv.url));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'codex-test', version: '1.0.0' });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  await srv.close();
});

describe('reading a slicer', () => {
  it('reads time, grams, layers and cost from PrusaSlicer’s and OrcaSlicer’s G-code', () => {
    expect(
      readGcode(
        ';LAYER_CHANGE\n;LAYER_CHANGE\n; filament used [g] = 7.21\n; total filament cost = 0.18\n; estimated printing time (normal mode) = 1h 2m 30s\n',
      ),
    ).toEqual({ minutes: 62.5, time: '1h 2m 30s', grams: 7.21, layers: 2, cost: 0.18 });
    const orca = readGcode(
      '; model printing time: 45m 2s; total estimated time: 49m 2s\n; total layer number: 575\n; total filament weight [g] : 7.20\n',
    );
    expect(orca).toMatchObject({ time: '49m 2s', grams: 7.2, layers: 575, cost: null });
    expect(minutes('1d 2h')).toBe(1560);
  });
});

describe('a print loop over MCP', { timeout: 240_000 }, () => {
  it('keeps the printer, measures how the parts fit, slices, and hands over a print sheet', async () => {
    expect(textOf(await call('printer_profile'))).toContain('slide 0.2');
    const bad = await call('printer_profile', { clearance_mm: { press: 0.5 } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('loosen in the order');
    const set = textOf(
      await call('printer_profile', {
        name: 'Workshop MK4',
        bed_mm: [250, 210, 220],
        price_per_kg: 20,
        currency: 'eur',
        clearance_mm: { slide: 0.15 },
      }),
    );
    expect(set).toContain('Workshop MK4: 250 × 210 × 220 mm');
    expect(set).toMatch(/slide calibrated \d{4}-\d\d-\d\d/);
    expect(set).toContain('Slices with PrusaSlicer');

    const id = loopId(
      textOf(
        await call('loop_start', {
          kind: 'model',
          title: 'Hinge pin',
          for: 'a replacement pin for a cupboard hinge, printed in PLA',
          what: 'a pin that slides into a sleeve',
          specifics: ['slides without play'],
          print: true,
          fits: [{ a: 'pin', b: 'sleeve', kind: 'slide' }],
          evidence: {
            dims: [
              { name: 'bore', mm: 10, source: 'measured', tolerance_mm: 0.2, how: 'calipers' },
              { name: 'length', mm: 24, source: 'listing', how: '“24 mm pin”' },
            ],
            unknowns: ['how much load the pin carries'],
            listing: { title: 'Hinge pin, pack of 1', price: 4.99, currency: 'EUR' },
          },
        }),
      ),
    );

    // Round one: the pin is bigger than the hole. That fails, and nothing is sliced.
    const r1 = textOf(
      await call('loop_submit', { loop_id: id, note: 'A pin and its sleeve', text: pinAndSleeve(5.3) }),
    );
    expect(r1).toMatch(/FAIL interference/);
    expect(r1).toContain('sleeve and pin overlap by 0.30 mm');
    expect(r1).toContain('parts sleeve, pin');
    expect(r1).toContain('not sliced');
    await call('loop_critique', {
      loop_id: id,
      round: 1,
      answers: answers(),
      change: 'Size the pin from the slide clearance',
    });

    // Round two: sized from this printer's slide clearance (0.15 per side). It passes, and comes back sliced.
    const r2 = textOf(
      await call('loop_submit', { loop_id: id, note: 'Pin is 5 − 0.15', text: pinAndSleeve(4.85) }),
    );
    expect(r2, r2).not.toMatch(/FAIL/);
    expect(r2).not.toMatch(/warn fits/);
    expect(r2).toContain('46m 26s, 5.73 g, 119 layers, 0.11 EUR of filament, against 4.99 EUR to buy');
    await call('loop_critique', { loop_id: id, round: 2, answers: answers() });
    const done = textOf(
      await call('loop_finish', { loop_id: id, round: 2, note: 'A pin and sleeve, slide fit.' }),
    );
    expect(done).toContain('print sheet');
    const sheetUrl = /print sheet[^:]*: (\S+)/.exec(done)![1]!;
    const res = await fetch(sheetUrl);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('Hinge pin');
    expect(html).toContain('saves 4.88 EUR');
    expect(html).toContain('how much load the pin carries');
    expect(html).toContain('“24 mm pin”');
    expect(html).toContain('slide');
    expect(html).not.toContain('<script');
    expect(done).toMatch(/G-code \(PrusaSlicer\): \S+round-2\.gcode/);
  });

  it('holds a model to the photographed outline, and catches it turned the wrong way', async () => {
    const id = loopId(
      textOf(
        await call('loop_start', {
          kind: 'model',
          title: 'Shelf bracket',
          for: 'a copy of a bracket from its photo',
          what: 'an L bracket',
          specifics: ['the upright on the left'],
          print: true,
          views: [{ name: 'front', look: '+y', up: '+z', outline: L.map(([u, v]) => [60 - u, v]) }],
        }),
      ),
    );
    const r = textOf(await call('loop_submit', { loop_id: id, note: 'From the photo', text: bracket() }));
    expect(r).toMatch(/FAIL likeness/);
    expect(r).toContain('look=-y');
  });

  it('measures a photo with print_kit.py, and holds the model to it', async () => {
    const work = mkdtempSync(join(tmpdir(), 'hg-print-kit-'));
    const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const kit = fileURLToPath(
      new URL('../../../skills/hildegard-print/scripts/print_kit.py', import.meta.url),
    );
    const run = (...args: string[]) =>
      JSON.parse(
        execFileSync(python, ['-I', kit, '--job', join(work, 'job'), ...args], { encoding: 'utf8' }),
      );
    // A photo at 10 px a millimetre: a bank card, and the L bracket beside it, upright on the left; and its cut-out.
    execFileSync(python, [
      '-I',
      '-c',
      `import sys
from PIL import Image, ImageDraw
L = [(1000, 1300), (1600, 1300), (1600, 1220), (1080, 1220), (1080, 900), (1000, 900)]
photo = Image.new('RGB', (2000, 1500), 'white')
d = ImageDraw.Draw(photo)
d.rectangle([100, 1000, 956, 1300], outline='black', width=3)
d.polygon(L, fill='gray')
photo.save(sys.argv[1])
mask = Image.new('L', photo.size, 0)
ImageDraw.Draw(mask).polygon(L, fill=255)
mask.save(sys.argv[2])`,
      join(work, 'photo.png'),
      join(work, 'mask.png'),
    ]);
    expect(run('grid', join(work, 'photo.png'), '--crop', '900,850,1700,1350').step_px).toBe(50);
    run('scale', 'front', join(work, 'photo.png'), 'card', '100,1000,956,1000');
    expect(run('dim', 'width', 'front', '1000,1300,1600,1300')).toMatchObject({ mm: 60, source: 'measured' });
    expect(run('outline', 'front', '--mask', join(work, 'mask.png')).size_mm).toEqual([60, 40]);
    run('give', 'depth', '20', '--source', 'assumed', '--why', 'the back isn’t photographed');
    run(
      'listing',
      'https://shop.example/bracket',
      '--title',
      'Bracket',
      '--price',
      '3.5',
      '--currency',
      'eur',
    );
    run('unknown', 'how thick the upright is');
    const { views, evidence } = run('loop');
    expect(evidence.listing).toEqual({
      title: 'Bracket',
      url: 'https://shop.example/bracket',
      price: 3.5,
      currency: 'EUR',
    });
    expect(evidence.dims.map((d: { name: string }) => d.name)).toEqual(['width', 'depth']);
    expect(views[0]).toMatchObject({ name: 'front', look: '+y', up: '+z' });

    const id = loopId(
      textOf(
        await call('loop_start', {
          kind: 'model',
          title: 'Bracket from its photo',
          for: 'a copy of a bracket from its photo',
          what: 'an L bracket',
          specifics: ['the upright on the left'],
          print: true,
          views,
          evidence,
        }),
      ),
    );
    const r = textOf(await call('loop_submit', { loop_id: id, note: 'From the photo', text: bracket() }));
    // The test's bracket is two overlapping boxes, which the mesh checks fail; the likeness is what's held here.
    expect(r, r).not.toMatch(/(FAIL|warn) likeness/);
  });

  it('makes a fit coupon that passes as a print', async () => {
    const work = mkdtempSync(join(tmpdir(), 'hg-coupon-'));
    const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const kit = fileURLToPath(
      new URL('../../../skills/hildegard-print/scripts/print_kit.py', import.meta.url),
    );
    const out = JSON.parse(
      execFileSync(python, ['-I', kit, 'coupon', join(work, 'coupon.obj')], { encoding: 'utf8' }),
    );
    expect(out.holes_mm_per_side).toEqual([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]);
    const id = loopId(
      textOf(
        await call('loop_start', {
          kind: 'model',
          title: 'Fit coupon',
          for: 'calibrating this printer’s fits',
          what: 'a strip of holes and a pin',
          specifics: ['eight clearances'],
          print: true,
        }),
      ),
    );
    const r = textOf(
      await call('loop_submit', { loop_id: id, note: 'print_kit coupon', file_path: out.file }),
    );
    expect(r, r).not.toMatch(/FAIL|warn (watertight|manifold|winding)/);
    expect(r).toContain('parts holes, pin');
  });

  it('fails a round the slicer refuses, and says why', async () => {
    await call('printer_profile', { bed_mm: [250, 210, 25] });
    const id = loopId(
      textOf(
        await call('loop_start', {
          kind: 'model',
          title: 'Too tall',
          for: 'a test',
          what: 'a pin and sleeve on a short printer',
          specifics: ['short'],
          print: true,
          fits: [{ a: 'pin', b: 'sleeve', kind: 'slide' }],
        }),
      ),
    );
    const r = textOf(await call('loop_submit', { loop_id: id, note: 'try', text: pinAndSleeve(4.85) }));
    expect(r).toMatch(/FAIL slice/);
    expect(r).toContain('could not fit on the bed');
  });
});
