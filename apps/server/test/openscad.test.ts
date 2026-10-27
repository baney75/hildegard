// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
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
  installDir,
  looksLikeScad,
  mainScad,
  type OpenScad,
  openScadCandidates,
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
const noLib = { libraries: false };

describe('every include and use, as OpenSCAD reads them', () => {
  it('refuses includes of anything but .scad files, so no unread file runs as source', () => {
    const p = vetScad(
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
    expect(vetScad(files({ 'main.scad': 'cube(1);', 'x.SCAD': 'import("/etc/x");' }))[0]).toContain(
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
      expect(vetScad(files({ 'main.scad': src })).join('\n'), JSON.stringify(src)).toMatch(
        /reaches outside the round/,
      );
    expect(tokenize('a = x_include<y;').some((t) => t.t === 'inc')).toBe(false);
    expect(vetScad(files({ 'main.scad': 'refuse = 2; b = refuse < 3 ? 1 : 0; cube(b);' }))).toEqual([]);
  });

  it('refuses include and use when they aren’t a path in < >, so a lexer it doesn’t match fails closed', () => {
    const p = vetScad(files({ 'main.scad': 'include /* hide */ </etc/x.scad>\nuse;\ncube(1);' }));
    expect(p.join('\n')).toMatch(/write include as include <file.scad>/);
    expect(p.join('\n')).toMatch(/write use as use <file.scad>/);
    expect(vetScad(files({ 'main.scad': 'include <a.scad\ncube(1);', 'a.scad': '' }))[0]).toContain(
      'no closing >',
    );
  });

  it('checks every include, even one inside an import’s arguments or after an unclosed one', () => {
    for (const src of [
      'import("logo.svg", convexity =\ninclude </tmp/n.scad>\n);',
      'import("logo.svg",\ninclude </dev/zero.scad>',
    ])
      expect(vetScad(files({ 'main.scad': src, 'logo.svg': '' })).join('\n')).toMatch(
        /reaches outside the round/,
      );
  });

  it('resolves an include or import from the folder of the file that names it, and nowhere else', () => {
    expect(
      vetScad(
        files({
          'main.scad': 'use <parts/lid.scad>\nlid();',
          'parts/lid.scad': 'import("logo.svg");',
          'logo.svg': '',
        }),
      ).join('\n'),
    ).toContain('parts/lid.scad, line 1: import("logo.svg") must name a file sent with this round');
    expect(
      vetScad(
        files({
          'main.scad': 'use <parts/lid.scad>\nlid();',
          'parts/lid.scad': 'import("logo.svg");',
          'parts/logo.svg': '',
        }),
        noLib,
      ),
    ).toEqual([]);
  });

  it('takes libraries only where OpenSCAD runs sandboxed', () => {
    const round = files({ 'main.scad': 'include <BOSL2/std.scad>\ncuboid(10);' });
    expect(vetScad(round, { libraries: true })).toEqual([]);
    expect(vetScad(round, noLib)[0]).toContain('libraries can’t be used here');
    // Its own files still may be included.
    expect(
      vetScad(files({ 'main.scad': 'use <lib/a.scad>\na();', 'lib/a.scad': 'module a() cube(1);' }), noLib),
    ).toEqual([]);
  });
});

describe('the other ways OpenSCAD reads files', () => {
  it('refuses every built-in that reads a file by name besides import and surface', () => {
    const p = vetScad(
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
    const round = (src: string) => vetScad(files({ 'main.scad': src, 'logo.svg': '', 'b.dxf': '' }));
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
    expect(installDir('/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD')).toBe(
      '/Applications/OpenSCAD.app',
    );
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
        deadline: Date.now() + 700,
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
  it.runIf(bwrap || !!process.env.HILDEGARD_EXPECT_SANDBOX)(
    'runs OpenSCAD in bubblewrap on Linux',
    async () => {
      const hidden = mkdtempSync(join(tmpdir(), 'hg-hidden-'));
      writeFileSync(join(hidden, 'secret.txt'), 'x');
      const dir = round();
      const s = ok(`cat "${hidden}/secret.txt" > "${dir}/leak" 2>/dev/null; true`);
      const sandbox = findSandbox({ round: dir, read: [join(s.path, '..')], hide: [hidden] });
      expect(sandbox?.kind).toBe('bwrap');
      await renderScad(s, dir, 'main.scad', join(dir, 'x.stl'), [], { sandbox });
      expect(readFileSync(join(dir, 'leak'), 'utf8')).toBe('');
    },
  );

  it('builds bubblewrap’s arguments: the system read only, home hidden, the round writable, no network', () => {
    const a = bwrapArgs({ round: '/r', read: ['/lib'], hide: ['/home/a'] });
    expect(a.join(' ')).toContain('--ro-bind / /');
    expect(a.join(' ')).toContain('--tmpfs /home/a');
    expect(a.join(' ')).toContain('--bind /r /r');
    expect(a).toContain('--unshare-net');
    expect(a.indexOf('--tmpfs')).toBeLessThan(a.indexOf('--bind'));
  });
});

describe('a round of OpenSCAD source', () => {
  it('records the rendered file’s size, the source’s apart, and gives every part one deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-loops-'));
    const deadlines: number[] = [];
    const loops = new Loops({
      dir,
      scadSandboxed: () => false,
      renderScad: async (_dir, _main, out, o) => {
        deadlines.push(o.deadline);
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
    expect(deadlines).toHaveLength(2);
    expect(deadlines[0]).toBe(deadlines[1]);
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
