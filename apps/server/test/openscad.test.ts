// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileStore, parseArgs, startServer } from '../src/index.ts';
import { sniff } from '../src/loop.ts';
import {
  declaredParts,
  findOpenScad,
  looksLikeScad,
  mainScad,
  openScadCandidates,
  readLog,
  safeRelative,
  usesManifold,
  vetScad,
} from '../src/openscad.ts';

const files = (o: Record<string, string>) => new Map(Object.entries(o));

describe('reading OpenSCAD source before it runs', () => {
  it('lets a round include its own files and libraries', () => {
    expect(
      vetScad(
        files({
          'main.scad': 'include <BOSL2/std.scad>\nuse <parts/lid.scad>\nlid();\nimport("logo.svg");',
          'parts/lid.scad': 'module lid() cube(10);\nsurface(file = "../height.png");',
          'logo.svg': '',
          'height.png': '',
        }),
      ),
    ).toEqual([expect.stringContaining('parts/lid.scad, line 2: surface("../height.png")')]);
  });

  it('refuses includes that leave the round', () => {
    const p = vetScad(
      files({
        'main.scad':
          'include </etc/passwd>\nuse <../../secret.scad>\ninclude <C:\\Users\\me\\x.scad>\ninclude<~/.ssh/id>\ncube(1);',
      }),
    );
    expect(p).toHaveLength(4);
    expect(p[0]).toContain('line 1: include </etc/passwd> reaches outside the round');
  });

  it('wants import and surface to name, as a plain string, a file the round carries', () => {
    const p = vetScad(
      files({
        'main.scad': [
          'f = "/etc/hostname";',
          'import(f);',
          'import(str("/et", "c/x"));',
          'surface(file = f, center = true);',
          'import("/etc/hostname");',
          'import("missing.stl");',
          'import("a\\x2e\\x2e/b.stl");',
          'module m(p) import(p);',
          'x = import;',
        ].join('\n'),
      }),
    );
    expect(p.map((x) => /line (\d+)/.exec(x)![1])).toEqual(['2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('ignores the words in comments and strings', () => {
    expect(
      vetScad(
        files({
          'main.scad':
            '// include </etc/passwd>\n/* import(x) */\necho("import(f); include </x>");\ncube(1); // surface(f)',
        }),
      ),
    ).toEqual([]);
  });

  it('keeps paths relative', () => {
    expect(safeRelative('BOSL2/std.scad')).toBe(true);
    for (const p of ['/a', '../a', 'a/../b', 'a\\b', 'C:x', '~/a', '']) expect(safeRelative(p)).toBe(false);
  });

  it('finds the main file', () => {
    expect(mainScad(['main.scad', 'lib.scad'])).toBe('main.scad');
    expect(mainScad(['vase.scad', 'parts/a.scad'])).toBe('vase.scad');
    expect(() => mainScad(['a.scad', 'b.scad'])).toThrow(/name it main.scad/);
    expect(() => mainScad(['a.stl'])).toThrow(/no .scad file/);
  });

  it('knows OpenSCAD source from other text', () => {
    expect(looksLikeScad('// a box\n$fn = 64;\ndifference() { cube(10); cylinder(h = 20, r = 2); }')).toBe(
      true,
    );
    expect(looksLikeScad('include <BOSL2/std.scad>\ncuboid(10);')).toBe(true);
    expect(looksLikeScad('Hello there, this is a note.')).toBe(false);
    const b = (s: string) => new TextEncoder().encode(s);
    expect(sniff(b('module peg(h) { cylinder(h = h, d = 5); }\npeg(10);'))).toBe('scad');
    expect(sniff(b('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))).toBe('obj');
  });

  it('reads the parts a print names at its top level', () => {
    expect(declaredParts('parts = ["lid", "box"];\npart = "all";\ncube(1);')).toEqual(['lid', 'box']);
    expect(declaredParts('module m() { parts = ["x"]; }\ncube(1);')).toBeNull();
    expect(declaredParts('cube(1);')).toBeNull();
    expect(() => declaredParts('parts = ["a b"];')).toThrow(/letters, digits/);
    expect(() => declaredParts('parts = ["a", "a"];')).toThrow(/own name/);
    expect(() => declaredParts('parts = [p, "b"];')).toThrow(/plain names/);
  });

  it('reads what OpenSCAD said', () => {
    const l = readLog(
      'ECHO: w = 10\nWARNING: Ignoring unknown variable "d" in file main.scad, line 3\nERROR: Parser error in file main.scad, line 4: syntax error\nCurrent top level object is empty.',
    );
    expect(l.echo).toEqual(['w = 10']);
    expect(l.warnings[0]).toContain('unknown variable');
    expect(l.errors[0]).toContain('line 4');
    expect(l.empty).toBe(true);
  });

  it('looks where OpenSCAD is installed, and knows which builds use Manifold', () => {
    expect(openScadCandidates({ HILDEGARD_OPENSCAD: '/opt/x/openscad' }, 'linux')).toEqual([
      '/opt/x/openscad',
    ]);
    expect(openScadCandidates({ PATH: '' }, 'darwin')[0]).toBe(
      join('/Applications', 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'),
    );
    expect(openScadCandidates({ PATH: '', PROGRAMFILES: 'C:\\Program Files' }, 'win32')[0]).toContain(
      'openscad.com',
    );
    expect(usesManifold({ manifold: false, version: '2021.01' })).toBe(false);
    expect(usesManifold({ manifold: false, version: '2025.09.02' })).toBe(true);
    expect(usesManifold({ manifold: true, version: '2024.12.01' })).toBe(true);
  });
});

const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
const loopId = (t: string) => /Loop (\w{16})/.exec(t)![1]!;

async function serve(openscad?: null) {
  const dir = mkdtempSync(join(tmpdir(), 'hg-scad-'));
  const srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
    { fakeTickMs: 20, secrets: fileStore(join(dir, 'secret.json')), openscad },
  );
  const server = createMcpServer(new HildegardClient(srv.url));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'scad-test', version: '1.0.0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return {
    srv,
    call,
    close: async () => {
      await client.close();
      await srv.close();
    },
  };
}

const START = {
  kind: 'model',
  title: 'Cable clip',
  for: 'a desk cable clip, FDM in PLA',
  what: 'a block with a slot for a 6 mm cable',
  specifics: ['the slot grips without pinching'],
  print: true,
};

describe('a model loop without OpenSCAD', { timeout: 60_000 }, () => {
  it('says how to install it, and takes no round', async () => {
    const s = await serve(null);
    try {
      expect(textOf(await s.call('openscad_status'))).toContain('isn’t installed');
      const id = loopId(textOf(await s.call('loop_start', START)));
      const r = await s.call('loop_submit', { loop_id: id, note: 'a block', text: 'cube([20, 20, 10]);' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('OpenSCAD isn’t on this computer');
      expect(textOf(await s.call('loop_status', { loop_id: id }))).not.toContain('round 1');
    } finally {
      await s.close();
    }
  });
});

describe.skipIf(!findOpenScad())('a model loop in OpenSCAD', { timeout: 240_000 }, () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    s = await serve();
  });
  afterAll(async () => {
    await s.close();
  });

  it('renders the source, checks the mesh, and keeps the source with the round', async () => {
    expect(textOf(await s.call('openscad_status'))).toMatch(/OpenSCAD \S+, rendering with/);
    const id = loopId(textOf(await s.call('loop_start', START)));

    // Refused before it runs: no round is used.
    const sneaky = await s.call('loop_submit', {
      loop_id: id,
      note: 'reads a file',
      text: 'include </etc/passwd>\ncube(10);',
    });
    expect(sneaky.isError).toBe(true);
    expect(textOf(sneaky)).toContain('reaches outside the round');

    // OpenSCAD's own error comes back, and no round is used.
    const broken = await s.call('loop_submit', { loop_id: id, note: 'typo', text: 'cube([20, 20, 10]\n' });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toMatch(/OpenSCAD stopped|Parser error|syntax error/i);

    const empty = await s.call('loop_submit', { loop_id: id, note: 'nothing', text: 'module m() cube(1);' });
    expect(textOf(empty)).toContain('The model is empty');

    const r = await s.call('loop_submit', {
      loop_id: id,
      note: 'blockout: a block with a cable slot',
      text: [
        'w = 30; d = 20; h = 14; cable = 6;',
        'echo(slot = cable + 0.4);',
        'difference() {',
        '  cube([w, d, h]);',
        '  translate([-1, d / 2, h - cable / 2]) rotate([0, 90, 0]) cylinder(h = w + 2, d = cable + 0.4, $fn = 48);',
        '}',
      ].join('\n'),
    });
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t).toContain('round 1 of at most 6 (stl)');
    expect(t).toMatch(/openscad \S+, (Manifold|CGAL)/);
    expect(t).toContain('echo slot = 6.4');
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    const l = (await (await fetch(`${s.srv.url}/api/loops/${id}`)).json()) as {
      rounds: { format: string; source: string; review: { checks: { id: string; status: string }[] } }[];
    };
    const round = l.rounds[0]!;
    expect(round.format).toBe('stl');
    expect(round.review.checks.find((c) => c.id === 'watertight')?.status).toBe('pass');
    const src = await fetch(`${s.srv.url}${round.source}`);
    expect(await src.text()).toContain('cable = 6');
  });

  it('takes a folder of files, with main.scad using the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-scad-src-'));
    mkdirSync(join(dir, 'parts'));
    writeFileSync(join(dir, 'parts', 'peg.scad'), 'module peg(h) cylinder(h = h, d = 8, $fn = 32);\n');
    writeFileSync(
      join(dir, 'main.scad'),
      'use <parts/peg.scad>\ncube([20, 20, 4]);\ntranslate([10, 10, 0]) peg(12);\n',
    );
    const id = loopId(textOf(await s.call('loop_start', { ...START, title: 'Peg board' })));
    const r = await s.call('loop_submit', { loop_id: id, note: 'a plate and a peg', file_path: dir });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('round 1 of at most 6 (stl)');
  });

  it('renders a print in named parts, so the fits between them are measured', async () => {
    const id = loopId(
      textOf(
        await s.call('loop_start', {
          ...START,
          title: 'Hinge pin',
          fits: [{ a: 'pin', b: 'sleeve', kind: 'slide' }],
        }),
      ),
    );
    const r = await s.call('loop_submit', {
      loop_id: id,
      note: 'a pin in its sleeve, sized from the slide clearance',
      text: [
        'parts = ["pin", "sleeve"];',
        'part = "all";',
        'slide = 0.2;',
        'module sleeve() difference() { cylinder(h = 20, r = 9, $fn = 64); translate([0, 0, -1]) cylinder(h = 22, r = 5, $fn = 64); }',
        'module pin() translate([0, 0, -2]) cylinder(h = 24, r = 5 - slide, $fn = 64);',
        'if (part == "all" || part == "pin") pin();',
        'if (part == "all" || part == "sleeve") sleeve();',
      ].join('\n'),
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('(obj)');
    const l = (await (await fetch(`${s.srv.url}/api/loops/${id}`)).json()) as {
      rounds: {
        review: { info: Record<string, unknown>; checks: { id: string; status: string; value: unknown }[] };
      }[];
    };
    const review = l.rounds[0]!.review;
    expect(review.info.parts).toEqual(['pin', 'sleeve']);
    expect(review.checks.filter((c) => c.id.startsWith('fit')).map((c) => c.status)).toContain('pass');
  });
});
