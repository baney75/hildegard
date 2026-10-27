// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, HildegardClient, zip } from '@hildegard/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileStore, parseArgs, startServer } from '../src/index.ts';
import { Loops, sniff } from '../src/loop.ts';
import {
  bwrapArgs,
  declaredParts,
  findOpenScad,
  findSandbox,
  looksLikeScad,
  mainScad,
  type OpenScad,
  openScadCandidates,
  ownFiles,
  readLog,
  renderScad,
  type ScadRender,
  safeRelative,
  scadEnv,
  scadTimeoutMs,
  scrubPaths,
  seatbeltProfile,
  tokenize,
  usesManifold,
  vetScad,
  writePartsObj,
} from '../src/openscad.ts';

const files = (o: Record<string, string>) => new Map(Object.entries(o));
/** A round read as where OpenSCAD runs sandboxed, unless a test says otherwise. */
const vet = (f: Map<string, string>, o = { sandboxed: true }) => vetScad(f, o);

describe('reading OpenSCAD source before it runs', () => {
  it('lets a round include its own files and libraries', () => {
    expect(
      vet(
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
    const p = vet(
      files({
        'main.scad':
          'include </etc/passwd>\nuse <../../secret.scad>\ninclude <C:\\Users\\me\\x.scad>\ninclude<~/.ssh/id>\ncube(1);',
      }),
    );
    expect(p).toHaveLength(4);
    expect(p[0]).toContain('line 1: include </etc/passwd> reaches outside the round');
  });

  it('wants import and surface to name, as a plain string, a file the round carries', () => {
    const p = vet(
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
    expect([...new Set(p.map((x) => /line (\d+)/.exec(x)![1]))]).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('ignores the words in comments and strings', () => {
    expect(
      vet(
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
    expect(sniff(b('solid_wall = 2;\n// the facet count\ncube(solid_wall);'))).toBe('scad');
    expect(
      sniff(b(`/*\n${'Licensed under the MIT licence. '.repeat(200)}\n*/\nwidth = 20;\ncube(width);`)),
    ).toBe('scad');
    expect(sniff(b('solid x\n  facet normal 0 0 1\n'))).toBe('stl');
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

/** A binary STL of `n` triangles, each a small real triangle. */
function stl(n: number): Buffer {
  const b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const at = 84 + i * 50 + 12;
    const v = [0, 0, i, 1, 0, i, 0, 1, i];
    v.forEach((x, k) => {
      b.writeFloatLE(x, at + k * 4);
    });
  }
  return b;
}

const unix = process.platform !== 'win32';
const bwrapOk =
  process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
const noLib = { sandboxed: false };

describe('every include and use, as OpenSCAD reads them', () => {
  it('refuses includes of anything but .scad files, so no unread file runs as source', () => {
    const p = vet(
      files({
        'main.scad':
          'include <helpers.inc>\nuse <data.json>\ninclude <notes.txt>\ninclude <x.SCAD>\ncube(1);',
        'helpers.inc': 'import("/etc/hostname");',
        'notes.txt': 'include </etc/whatever.scad>',
        'data.json': '{}',
      }),
    );
    expect(p).toHaveLength(4);
    for (const x of p) expect(x).toContain('only OpenSCAD files, named .scad');
    expect(vet(files({ 'main.scad': 'cube(1);', 'x.SCAD': 'import("/etc/x");' }))[0]).toContain(
      'lowercase .scad',
    );
  });

  it('finds an include after line breaks, carriage returns or > before the <, as the lexer does', () => {
    for (const src of [
      'include\n</Users/donovan/other/project.scad>\ncube(1);',
      'use\r\n<../x.scad>\ncube(1);',
      'use\r<../x.scad>\ncube(1);',
      'include >> </tmp/canary.scad>\ncube(1);',
      'x = 1.5include</etc/x.scad>\ncube(1);',
    ])
      expect(vet(files({ 'main.scad': src })).join('\n'), JSON.stringify(src)).toMatch(
        /reaches outside the round/,
      );
    expect(tokenize('a = x_include<y;').some((t) => t.t === 'inc')).toBe(false);
    expect(vet(files({ 'main.scad': 'refuse = 2; b = refuse < 3 ? 1 : 0; cube(b);' }))).toEqual([]);
  });

  it('refuses include and use when they aren’t a path in < >, so a lexer it doesn’t match fails closed', () => {
    const p = vet(files({ 'main.scad': 'include /* hide */ </etc/x.scad>\nuse;\ncube(1);' }));
    expect(p.join('\n')).toMatch(/write include as include <file.scad>/);
    expect(p.join('\n')).toMatch(/write use as use <file.scad>/);
    expect(vet(files({ 'main.scad': 'include <a.scad\ncube(1);', 'a.scad': '' }))[0]).toContain(
      'no closing >',
    );
  });

  it('checks every include, even one inside an import’s arguments or after an unclosed one', () => {
    for (const src of [
      'import("logo.svg", convexity =\ninclude </tmp/n.scad>\n);',
      'import("logo.svg",\ninclude </dev/zero.scad>',
    ])
      expect(vet(files({ 'main.scad': src, 'logo.svg': '' })).join('\n')).toMatch(
        /reaches outside the round/,
      );
  });

  it('resolves an include or import from the folder of the file that names it, and nowhere else', () => {
    expect(
      vet(
        files({
          'main.scad': 'use <parts/lid.scad>\nlid();',
          'parts/lid.scad': 'import("logo.svg");',
          'logo.svg': '',
        }),
      ).join('\n'),
    ).toContain('parts/lid.scad, line 1: import("logo.svg") must name a file sent with this round');
    expect(
      vet(
        files({
          'main.scad': 'use <parts/lid.scad>\nlid();',
          'parts/lid.scad': 'import("logo.svg");',
          'parts/logo.svg': '',
        }),
      ),
    ).toEqual([]);
  });

  it('reads data files only where OpenSCAD runs sandboxed, since its parsers for them run on what the agent sent', () => {
    const round = files({ 'main.scad': 'import("x.stl");\nsurface("h.png");', 'x.stl': '', 'h.png': '' });
    expect(vet(round)).toEqual([]);
    const p = vet(round, noLib);
    expect(p).toHaveLength(2);
    for (const x of p) expect(x).toContain('only where OpenSCAD is sandboxed');
  });

  it('reads deep nesting in one pass, and refuses what’s too deep or too big', () => {
    const deep = `cube(1);\n${'f('.repeat(100_000)}${')'.repeat(100_000)};`;
    const started = Date.now();
    expect(vet(files({ 'main.scad': deep })).join('\n')).toContain('nested deeper than 256');
    expect(Date.now() - started).toBeLessThan(3000);
    const wide = `cube(1);\n${'f(1, g(2, h(3))); '.repeat(50_000)}`;
    const t2 = Date.now();
    expect(vet(files({ 'main.scad': wide }))).toEqual([]);
    expect(Date.now() - t2).toBeLessThan(3000);
    expect(vet(files({ 'main.scad': `x = "${'a'.repeat(5 * 1024 * 1024)}";` }))[0]).toContain('over 4 MB');
  });

  it('takes libraries only where OpenSCAD runs sandboxed', () => {
    const round = files({ 'main.scad': 'include <BOSL2/std.scad>\ncuboid(10);' });
    expect(vet(round, { sandboxed: true })).toEqual([]);
    expect(vet(round, noLib)[0]).toContain('libraries can’t be used here');
    // Its own files still may be included.
    expect(
      vet(files({ 'main.scad': 'use <lib/a.scad>\na();', 'lib/a.scad': 'module a() cube(1);' }), noLib),
    ).toEqual([]);
  });
});

describe('the other ways OpenSCAD reads files', () => {
  it('refuses every built-in that reads a file by name besides import and surface', () => {
    const p = vet(
      files({
        'main.scad': [
          'echo(dxf_dim(file = "/abs/drawing.dxf", name = "w"));',
          'dxf_cross(file = "/abs/x.dxf");',
          'linear_extrude(file = "/abs/x.dxf");',
          'rotate_extrude(file = "/abs/x.dxf");',
          'import_stl("/tmp/private.stl");',
          'import_off("/tmp/a.off");',
          'import_dxf(file = "/tmp/a.dxf");',
          'cube(1);',
        ].join('\n'),
      }),
    );
    expect(p.map((x) => /line (\d+)/.exec(x)![1])).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('wants import’s file once, and none of its other strings to look like a path', () => {
    const round = (src: string) => vet(files({ 'main.scad': src, 'logo.svg': '', 'b.dxf': '' }));
    expect(round('import(file = "logo.svg", file = "/etc/x.svg");')[0]).toContain(
      'give import its file once',
    );
    expect(round('import(file = "logo.svg", "/abs/y.stl");')[0]).toContain('give import its file once');
    expect(round('import("b.dxf", layer = "../etc/x");')[0]).toContain('looks like another');
    expect(round('import("b.dxf", layer = "0", convexity = 3);')).toEqual([]);
    expect(round('import(id = "badge", file = "logo.svg");')).toEqual([]);
  });
});

describe('running OpenSCAD', () => {
  it('reads the time limit only from a number of seconds above 0', () => {
    expect(scadTimeoutMs({})).toBe(180_000);
    for (const v of ['3m', '180s', '', '0', '-5', 'NaN'])
      expect(scadTimeoutMs({ HILDEGARD_OPENSCAD_TIMEOUT: v })).toBe(180_000);
    expect(scadTimeoutMs({ HILDEGARD_OPENSCAD_TIMEOUT: '20' })).toBe(20_000);
  });

  it('passes on only the variables OpenSCAD needs', () => {
    const env = scadEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/a',
        LC_ALL: 'C',
        XDG_DATA_HOME: '/x',
        DATABASE_URL: 'postgres://u:pw@h/db',
        GH_PAT: 'ghp_x',
        SENTRY_DSN: 'https://k@s.io/1',
        NODE_OPTIONS: '--require /tmp/x.js',
      },
      ['/libs/a', '/libs/b'],
      'linux',
    );
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LC_ALL', 'OPENSCADPATH', 'PATH', 'XDG_DATA_HOME']);
    expect(env.OPENSCADPATH).toBe(['/libs/a', '/libs/b'].join(process.platform === 'win32' ? ';' : ':'));
  });

  it('never takes a file named like an option as the main file', () => {
    expect(() => mainScad(['-mfoo.scad'])).toThrow(/no .scad file at its top/);
    expect(safeRelative('-mfoo.scad')).toBe(false);
  });

  it('no longer looks for the flatpak wrapper, which a timeout can’t stop', () => {
    expect(openScadCandidates({ PATH: '' }, 'linux').some((p) => p.includes('flatpak'))).toBe(false);
  });

  it('keeps this computer’s paths out of what OpenSCAD says', () => {
    const said = scrubPaths(
      'WARNING: x in file ../../../../../Documents/OpenSCAD/libraries/BOSL2/std.scad, line 3\nERROR: in file /Users/donovan/Library/Hildegard/loops/abc/round-1.src/parts/lid.scad, line 2\nCan\'t open "/Users/donovan/secret.stl"\nECHO: "M3/screw"',
      '/Users/donovan/Library/Hildegard/loops/abc/round-1.src',
      ['/Users/donovan/Documents/OpenSCAD/libraries'],
    );
    expect(said).not.toMatch(/donovan|Hildegard\/loops/);
    expect(said).toContain('parts/lid.scad');
    expect(said).toContain('<library>/BOSL2/std.scad');
    expect(said).toContain('<path>');
    expect(said).toContain('"M3/screw"');
    if (unix)
      expect(ownFiles('/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD')).toEqual([
        '/Applications/OpenSCAD.app',
      ]);
  });

  it('writes parts as one OBJ without holding every vertex in one array, and refuses too big a mesh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-obj-'));
    writeFileSync(join(dir, 'a.stl'), stl(300_000));
    writeFileSync(join(dir, 'b.stl'), stl(2));
    const size = writePartsObj(join(dir, 'p.obj'), [
      { name: 'a', stl: join(dir, 'a.stl') },
      { name: 'b', stl: join(dir, 'b.stl') },
    ]);
    expect(size).toBe(statSync(join(dir, 'p.obj')).size);
    const obj = readFileSync(join(dir, 'p.obj'), 'utf8');
    expect(obj).toContain('o b\n');
    expect(obj.trimEnd().split('\n').at(-1)).toBe('f 900004 900005 900006');
    expect(() => writePartsObj(join(dir, 'q.obj'), [{ name: 'a', stl: join(dir, 'a.stl') }], 1000)).toThrow(
      /over/,
    );
    // Under the cap as STL, over it as OBJ text: stopped, and nothing left behind.
    const stlBytes = statSync(join(dir, 'a.stl')).size;
    expect(() =>
      writePartsObj(join(dir, 'r.obj'), [{ name: 'a', stl: join(dir, 'a.stl') }], stlBytes + 10),
    ).toThrow(/over/);
    expect(existsSync(join(dir, 'r.obj'))).toBe(false);
    const bad = stl(1);
    bad.writeFloatLE(Number.NaN, 84 + 12);
    writeFileSync(join(dir, 'nan.stl'), bad);
    expect(() => writePartsObj(join(dir, 'n.obj'), [{ name: 'n', stl: join(dir, 'nan.stl') }])).toThrow(
      /infinity/,
    );
  });

  // A stand-in for OpenSCAD: a shell script that does what each test needs.
  const fake = (body: string): OpenScad => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-fakescad-'));
    const path = join(dir, 'openscad');
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return { path, version: '2021.01', manifoldArgs: [], manifold: false };
  };
  const round = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-round-'));
    writeFileSync(join(dir, 'main.scad'), 'cube(1);');
    return dir;
  };
  // Writes the STL OpenSCAD would, to the path after -o.
  const WRITE =
    'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; fi; last="$1"; shift; done\ncp "$(dirname "$0")/ok.stl" "$out"';
  const ok = (body = '') => {
    const s = fake(`${body}\n${WRITE}`);
    writeFileSync(join(s.path, '..', 'ok.stl'), stl(1));
    return s;
  };

  it.runIf(unix)('passes the main file as ./name, and an environment without secrets', async () => {
    process.env.HG_TEST_SECRET_TOKEN = 'x';
    try {
      const s = ok('echo "ARGS: $*" >&2; env >&2');
      const dir = round();
      const r = await renderScad(s, dir, 'main.scad', join(dir, 'out.stl'), [], { sandbox: null });
      expect(r.out).toBe(join(dir, 'out.stl'));
      const s2 = fake('echo "ERROR: args $*"; env | sed "s/^/ERROR: /"; exit 1');
      const e = await renderScad(s2, dir, 'main.scad', join(dir, 'x.stl'), [], { sandbox: null }).catch(
        (x) => x,
      );
      expect(e.message).toContain('./main.scad');
      expect(e.message).not.toContain('HG_TEST_SECRET_TOKEN');
    } finally {
      delete process.env.HG_TEST_SECRET_TOKEN;
    }
  });

  it.runIf(unix)(
    'stops everything OpenSCAD started at the deadline, even what holds its output open',
    async () => {
      const dir = round();
      const s = fake(`sleep 30 &\necho $! > "${dir}/child.pid"\nsleep 30`);
      const started = Date.now();
      const e = await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], {
        sandbox: null,
        budget: { ms: 700 },
      }).catch((x) => x);
      expect(e.message).toContain('took longer');
      expect(Date.now() - started).toBeLessThan(5000);
      const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it('says it couldn’t run OpenSCAD without saying where it is', async () => {
    const dir = round();
    const e = await renderScad(
      {
        path: join(tmpdir(), 'secret-place', 'openscad'),
        version: '2021.01',
        manifoldArgs: [],
        manifold: false,
      },
      dir,
      'main.scad',
      join(dir, 'x.stl'),
      [],
      { sandbox: null },
    ).catch((x) => x);
    expect(e.message).toMatch(/Couldn’t run OpenSCAD|OpenSCAD stopped/);
    expect(e.message).not.toContain('secret-place');
  });

  it.runIf(unix)('refuses a mesh bigger than Hildegard reads', async () => {
    const dir = round();
    const e = await renderScad(ok(), dir, 'main.scad', join(dir, 'x.stl'), [], {
      sandbox: null,
      maxBytes: 100,
    }).catch((x) => x);
    expect(e.message).toMatch(/over 0 MB|over/);
  });

  it.runIf(unix)('renders one at a time on this computer', async () => {
    const dir = round();
    const s = ok(
      `echo "$(date +%s%N) start" >> "${dir}/times"; sleep 0.4; echo "$(date +%s%N) end" >> "${dir}/times"`,
    );
    await Promise.all(
      [1, 2].map((i) => renderScad(s, dir, 'main.scad', join(dir, `o${i}.stl`), [], { sandbox: null })),
    );
    const lines = readFileSync(join(dir, 'times'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[1]);
    expect(lines).toEqual(['start', 'end', 'start', 'end']);
  });

  it.runIf(unix)('starts a round’s time when its render starts, not while it waits its turn', async () => {
    const dir = round();
    const slow = ok('sleep 0.6');
    const budget = { ms: 400 };
    const first = renderScad(slow, dir, 'main.scad', join(dir, 'a.stl'), [], { sandbox: null });
    const second = renderScad(ok(), dir, 'main.scad', join(dir, 'b.stl'), [], { sandbox: null, budget });
    await Promise.all([first, second]);
    expect(budget.ms).toBeGreaterThan(0);
    expect(budget.ms).toBeLessThan(400);
  });

  it.runIf(unix)('turns renders away as busy once too many wait', async () => {
    const dir = round();
    const slow = ok('sleep 0.3');
    const all = Array.from({ length: 9 }, (_, i) =>
      renderScad(slow, dir, 'main.scad', join(dir, `q${i}.stl`), [], { sandbox: null }).then(
        () => 'ok',
        (e: Error) => e.message,
      ),
    );
    const said = await Promise.all(all);
    expect(said.filter((x) => x.includes('busy')).length).toBeGreaterThan(0);
    expect(said.filter((x) => x === 'ok').length).toBeGreaterThan(0);
  });

  it.runIf(unix)('stops an export that grows past the cap while it runs', async () => {
    const dir = round();
    const s = fake(
      'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; fi; shift; done\nhead -c 4000000 /dev/zero > "$out"\nsleep 30',
    );
    const started = Date.now();
    const e = await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], {
      sandbox: null,
      maxBytes: 1_000_000,
    }).catch((x) => x);
    expect(e.message).toContain('over');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('opens only OpenSCAD’s own files to the sandbox, never a hidden folder they sit in', () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-home-'));
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin', 'openscad'), '');
    expect(ownFiles(join(home, 'bin', 'openscad'), [home])).toBeNull();
    expect(ownFiles(join(home, 'OpenSCAD-2025.AppImage'), [home])).toBeNull();
    expect(ownFiles('/usr/bin/openscad', [home])).toEqual([]);
    expect(
      ownFiles(join(home, 'Applications', 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'), [home]),
    ).toEqual([join(home, 'Applications', 'OpenSCAD.app')]);
  });

  it('keeps paths with spaces out of what OpenSCAD says, whole', () => {
    const r = '/Users/jane doe/Library/Application Support/Hildegard/loops/a/round-1.src';
    const said = scrubPaths(
      `ERROR: in file ${r}/main.scad, line 2\nWARNING: in file /Users/jane doe/Documents/OpenSCAD/libraries/BOSL2/std.scad, line 1\nCan't open /Users/jane doe/Desktop/x.stl`,
      r,
      ['/Users/jane doe/Documents/OpenSCAD/libraries'],
      ['/Users/jane doe'],
    );
    expect(said).not.toContain('jane');
    expect(said).not.toContain('Support');
    expect(said).toContain('main.scad, line 2');
    expect(said).toContain('<library>/BOSL2/std.scad');
  });

  it.runIf(process.platform === 'darwin')(
    'writes the mesh where it’s asked for, outside the round, from the sandbox',
    async () => {
      const dir = round();
      const elsewhere = mkdtempSync(join(tmpdir(), 'hg-loop-'));
      const s = ok();
      const sandbox = findSandbox({ round: dir, read: [join(s.path, '..')], hide: [elsewhere] });
      const r = await renderScad(s, dir, 'main.scad', join(elsewhere, 'round-1.stl'), [], { sandbox });
      expect(statSync(r.out).size).toBe(84 + 50);
    },
  );

  it.runIf(process.platform === 'darwin' || bwrapOk)(
    'stops a sandboxed render at the deadline too',
    async () => {
      const dir = round();
      const s = fake(`sleep 30 &\necho $! > "${dir}/child.pid"\nsleep 30`);
      const sandbox = findSandbox({ round: dir, read: [join(s.path, '..')], hide: [] });
      expect(sandbox).not.toBeNull();
      const started = Date.now();
      const e = await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], {
        sandbox,
        budget: { ms: 700 },
      }).catch((x) => x);
      expect(e.message).toContain('took longer');
      expect(Date.now() - started).toBeLessThan(5000);
      await new Promise((r) => setTimeout(r, 300));
      if (process.platform === 'darwin') {
        const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
      } else expect(spawnSync('pgrep', ['-f', 'sleep 31.7']).stdout.toString().trim()).toBe('');
    },
  );

  it.runIf(process.platform === 'darwin')(
    'runs OpenSCAD in a sandbox that hides the owner’s files on macOS',
    async () => {
      const hidden = mkdtempSync(join(tmpdir(), 'hg-hidden-'));
      writeFileSync(join(hidden, 'secret.txt'), 'x');
      const dir = round();
      const s = ok(
        `cat "${hidden}/secret.txt" > "${dir}/leak" 2>/dev/null; touch "${hidden}/new" 2>/dev/null`,
      );
      const sandbox = findSandbox({ round: dir, read: [join(s.path, '..')], hide: [hidden] });
      expect(sandbox?.kind).toBe('sandbox-exec');
      await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], { sandbox });
      expect(readFileSync(join(dir, 'leak'), 'utf8')).toBe('');
      expect(existsSync(join(hidden, 'new'))).toBe(false);
      expect(seatbeltProfile({ round: dir, read: [], hide: [hidden] })).toContain('(deny network*)');
    },
  );

  const bwrap =
    process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
  it.runIf(bwrapOk || !!process.env.HILDEGARD_EXPECT_SANDBOX)(
    'runs OpenSCAD in bubblewrap on Linux',
    async () => {
      const hidden = mkdtempSync(join(tmpdir(), 'hg-hidden-'));
      writeFileSync(join(hidden, 'secret.txt'), 'x');
      const dir = round();
      const s = ok(`cat "${hidden}/secret.txt" > "${dir}/leak" 2>/dev/null; true`);
      const sandbox = findSandbox({ round: dir, read: [join(s.path, '..')], hide: [hidden] });
      const why = sandbox
        ? ''
        : spawnSync('bwrap', [...bwrapArgs({ round: dir, read: [], hide: [] }), 'true'], { encoding: 'utf8' })
            .stderr;
      expect(sandbox?.kind, why).toBe('bwrap');
      await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], { sandbox });
      expect(readFileSync(join(dir, 'leak'), 'utf8')).toBe('');
    },
  );

  it('builds bubblewrap’s arguments: an empty root with only the system, the round writable, no network', () => {
    const a = bwrapArgs({ round: '/r', read: ['/lib/x'], hide: ['/home/a'] }, (p) =>
      p === '/lib' ? 'link' : null,
    );
    const j = a.join(' ');
    expect(j).not.toContain('--ro-bind / /');
    expect(j).not.toContain('/home');
    expect(j).toContain('--ro-bind /usr /usr');
    expect(j).toContain('--ro-bind-try /lib/x /lib/x');
    expect(j).toContain('--bind /r /r');
    expect(a.indexOf('/tmp')).toBeLessThan(a.indexOf('/r'));
    expect(j).toContain('--remount-ro /');
    expect(a).toContain('--unshare-all');
    expect(a).toContain('--die-with-parent');
  });
});

describe('a round of OpenSCAD source', () => {
  it('records the rendered file’s size, the source’s apart, and gives every part one time budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-loops-'));
    const budgets: object[] = [];
    const loops = new Loops({
      dir,
      scadSandboxed: () => false,
      renderScad: async (_dir, _main, out, o) => {
        budgets.push(o.budget);
        writeFileSync(out, stl(10));
        return {
          out,
          seconds: 0.1,
          version: '2021.01',
          engine: 'CGAL',
          warnings: [],
          echo: [],
        } as ScadRender;
      },
      reviewModel: async () => ({ kind: 'mesh', info: {}, checks: [], passed: true }),
    });
    const l = loops.start({
      kind: 'model',
      title: 'Box',
      brief: { for: 'a test', what: 'a box and lid', specifics: ['fits'] },
    });
    const src = 'parts = ["box", "lid"];\npart = "all";\ncube(1);';
    const r = await loops.submit(l.id, new TextEncoder().encode(src), 'first');
    expect(r.sourceBytes).toBe(src.length);
    expect(r.bytes).toBe(statSync(join(dir, l.id, r.file)).size);
    expect(r.bytes).not.toBe(src.length);
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBe(budgets[1]);
  });
});

describe('round 3: what OpenSCAD reads by position, and what it leaves behind', () => {
  it('refuses a file given to linear_extrude or rotate_extrude by position, and asks for height by name unsandboxed', () => {
    const one = (src: string, o = { sandboxed: true }) => vet(files({ 'main.scad': src }), o);
    expect(one('linear_extrude("C:/Users/owner/secret.dxf") square(1);')[0]).toContain('reads a file');
    expect(one('rotate_extrude("\\\\\\\\host\\\\share\\\\x.dxf") square(1);')[0]).toContain('reads a file');
    expect(one('f = "x.dxf"; linear_extrude(f) square(1);', { sandboxed: false })[0]).toContain(
      'height by name',
    );
    expect(one('h = 3; linear_extrude(h) square(1);')).toEqual([]);
    for (const ok of [
      'linear_extrude(5) square(1);',
      'linear_extrude(-2) square(1);',
      'h = 3; linear_extrude(height = h) square(1);',
      'rotate_extrude(angle = 90) square(1);',
    ])
      expect(one(ok, { sandboxed: false }), ok).toEqual([]);
  });

  it('runs no import or surface at all unsandboxed, .scad or not', () => {
    const p = vet(
      files({ 'main.scad': 'cube(1);\nsurface("heights.scad");', 'heights.scad': '1 2 3\n4 5 6' }),
      noLib,
    );
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('only where OpenSCAD is sandboxed');
  });

  it('reads nested imports with long arguments in time and memory linear in the source', () => {
    const inner = Array.from({ length: 20_000 }, (_, i) => `${i}`).join(' + ');
    const src = `${'import("heights.scad", a = '.repeat(250)}${inner}${')'.repeat(250)};`;
    const started = Date.now();
    vet(files({ 'main.scad': src, 'heights.scad': '' }));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('counts the source cap in bytes, not characters', () => {
    expect(vet(files({ 'main.scad': `x = "${'é'.repeat(2_200_000)}";` }))[0]).toContain('over 4 MB');
  });

  it('leaves a lone slash in what OpenSCAD echoes alone', () => {
    expect(scrubPaths('ECHO: "ratio 3 / 2"', '/r', [], [])).toBe('ECHO: "ratio 3 / 2"');
  });

  const fake3 = (body: string): OpenScad => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-fakescad-'));
    const path = join(dir, 'openscad');
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return { path, version: '2021.01', manifoldArgs: [], manifold: false };
  };
  const round3 = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-round-'));
    writeFileSync(join(dir, 'main.scad'), 'cube(1);');
    return dir;
  };
  const OUT = 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; fi; shift; done';

  it.runIf(unix)('takes only a plain file OpenSCAD wrote, never a link where the mesh goes', async () => {
    const dir = round3();
    const target = join(mkdtempSync(join(tmpdir(), 'hg-t-')), 'big');
    writeFileSync(target, stl(3));
    const s = fake3(`${OUT}\nln -s "${target}" "$out"`);
    const e = await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], { sandbox: null }).catch(
      (x) => x,
    );
    expect(e.message).toContain('something other than a mesh');
  });

  it.runIf(unix)('gives OpenSCAD an empty home each time, whatever the round left there', async () => {
    const dir = round3();
    mkdirSync(join(dir, '.openscad-home'));
    writeFileSync(join(dir, '.openscad-home', 'planted.conf'), 'x');
    const s = fake3(`${OUT}\nhead -c 134 /dev/zero > "$out"`);
    await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], { sandbox: null }).catch(() => {});
    expect(existsSync(join(dir, '.openscad-home', 'planted.conf'))).toBe(false);
  });

  it('never runs a round read as sandboxed without the sandbox', async () => {
    const dir = round3();
    const e = await renderScad(
      { path: '/bin/true', version: '2021.01', manifoldArgs: [], manifold: false },
      dir,
      'main.scad',
      join(dir, 'x.stl'),
      [],
      { sandbox: null, requireSandbox: true },
    ).catch((x) => x);
    expect(e.message).toContain('can’t be sandboxed');
  });

  it('refuses a round that brings Hildegard’s own dot-folders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-loops-'));
    const loops = new Loops({
      dir,
      scadSandboxed: () => true,
      renderScad: async () => {
        throw new Error('should not render');
      },
      reviewModel: async () => ({ kind: 'mesh', info: {}, checks: [], passed: true }),
    });
    const l = loops.start({
      kind: 'model',
      title: 'Box',
      brief: { for: 'a test', what: 'a box', specifics: ['fits'] },
    });
    const enc = new TextEncoder();
    const z = zip([
      { name: 'main.scad', data: enc.encode('cube(1);') },
      { name: '.openscad-home/.config/fontconfig/fonts.conf', data: enc.encode('<fontconfig/>') },
    ]);
    await expect(loops.submit(l.id, new Uint8Array(z), 'first')).rejects.toThrow(/start with a dot/);
  });

  it.runIf(process.platform === 'darwin')(
    'renders a round kept inside a hidden folder, as Hildegard’s data is in the home folder',
    async () => {
      const data = mkdtempSync(join(tmpdir(), 'hg-data-'));
      mkdirSync(join(data, 'loops', 'a', 'round-1.src'), { recursive: true });
      writeFileSync(join(data, 'secret.json'), 'x');
      const dir = join(data, 'loops', 'a', 'round-1.src');
      writeFileSync(join(dir, 'main.scad'), 'cube(1);');
      const s = fake3(
        `${OUT}\ncat "${data}/secret.json" > "${dir}/leak" 2>/dev/null; head -c 134 /dev/zero > "$out"`,
      );
      const r = await renderScad(s, dir, 'main.scad', join(data, 'loops', 'a', 'round-1.stl'), [], {
        hide: [data, homedir()],
        requireSandbox: true,
      });
      expect(statSync(r.out).size).toBe(134);
      expect(readFileSync(join(dir, 'leak'), 'utf8')).toBe('');
    },
  );

  it.runIf(process.platform === 'darwin')(
    'keeps a sandboxed render from running other programs or listing other homes',
    () => {
      const dir = round3();
      const elsewhere = mkdtempSync(join(tmpdir(), 'hg-bin-'));
      copyFileSync('/bin/echo', join(elsewhere, 'echo2'));
      const prof = seatbeltProfile({ round: dir, read: [], hide: [] });
      expect(prof).toContain('com.apple.pasteboard.1');
      const run = (...a: string[]) => spawnSync('/usr/bin/sandbox-exec', ['-p', prof, ...a]).status;
      expect(run(join(elsewhere, 'echo2'), 'x')).not.toBe(0);
      expect(run('/bin/ls', '/Users')).not.toBe(0);
      expect(run('/bin/echo', 'x')).toBe(0);
    },
  );
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
