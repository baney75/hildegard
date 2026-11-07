// SPDX-License-Identifier: AGPL-3.0-only
// The design skills' checkers (skills/hildegard-brand, skills/hildegard-app, skills/hildegard-council) are Python an
// agent runs on its own work. Each check here is one that could fail: a hairline, live text, a gradient, a failing
// contrast pair, a review that breaks the council's rules. Checks that need pixels run only where a rasterizer or
// Chromium is installed, and say so.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const brand = join(root, 'skills/hildegard-brand');
const example = join(brand, 'templates/example');
const dir = mkdtempSync(join(tmpdir(), 'design-checkers-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, args: string[], cwd = dir) {
  const r = spawnSync(python, [script, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const hasPillow = spawnSync(python, ['-c', 'import PIL']).status === 0;

describe('logo_check.py', () => {
  const script = join(brand, 'scripts/logo_check.py');

  it('passes the example mark and fails a mark with hairlines, live text and a gradient', () => {
    const ok = run(script, [join(example, 'mark.svg'), '--out', join(dir, 'ok')]);
    expect(ok.out).toMatch(/PASS text/);
    expect(ok.out).toMatch(/PASS flat/);
    expect(ok.out).not.toMatch(/FAIL/);
    expect(ok.code).toBe(0);

    writeFileSync(
      join(dir, 'bad.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
        '<stop offset="1" stop-color="#00f"/></linearGradient></defs><circle cx="256" cy="256" r="200" fill="none" stroke="url(#g)" stroke-width="6"/>' +
        '<text x="100" y="280" font-size="80">Acme</text></svg>',
    );
    const bad = run(script, [join(dir, 'bad.svg'), '--out', join(dir, 'bad')]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL text: live <text>/);
    expect(bad.out).toMatch(/FAIL flat: uses linearGradient/);
    expect(bad.out).toMatch(/FAIL strokes: <circle> stroke-width 6/);
    const rep = JSON.parse(readFileSync(join(dir, 'bad', 'report.json'), 'utf8'));
    if (rep.rasterizer && hasPillow) expect(rep.files['bad.svg'].checks.hairlines[0]).toBe('fail');
  });

  it('fails a mark that needs two colors to read, where it can see pixels', () => {
    writeFileSync(
      join(dir, 'two.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="56" y="56" width="200" height="400" fill="#c1121f"/>' +
        '<rect x="256" y="56" width="200" height="400" fill="#003049"/></svg>',
    );
    const r = run(script, [join(dir, 'two.svg'), '--out', join(dir, 'two')]);
    const rep = JSON.parse(readFileSync(join(dir, 'two', 'report.json'), 'utf8'));
    if (!rep.rasterizer || !hasPillow) return; // no rsvg-convert, cairosvg or Chromium here
    expect(rep.files['two.svg'].checks['one-color'][0]).toBe('fail');
    expect(r.code).toBe(1);
  });
});

describe('brand_guide.py', () => {
  const script = join(brand, 'scripts/brand_guide.py');

  it('passes the example brand and names the nearest passing color for a pair that fails', () => {
    const ok = run(script, [join(example, 'brand.json'), '--check', '--offline', '--out', join(dir, 'g1')]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/PASS ink\s+on ground\s+13\.83:1/);

    const b = JSON.parse(readFileSync(join(example, 'brand.json'), 'utf8'));
    b.colors.find((c: { role: string }) => c.role === 'muted').hex = '#a39d96';
    b.voice.lines = b.voice.lines.slice(0, 2);
    for (const f of ['mark.svg', 'logo-horizontal.svg', 'logo-stacked.svg'])
      writeFileSync(join(dir, f), readFileSync(join(example, f)));
    writeFileSync(join(dir, 'brand.json'), JSON.stringify(b));
    const bad = run(script, [join(dir, 'brand.json'), '--check', '--offline', '--out', join(dir, 'g2')]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL voice\.lines needs exactly three lines/);
    const m = bad.out.match(
      /muted #a39d96 on ground #f5f0e6 is ([\d.]+):1, under 4\.5:1 for small text; (#[0-9a-f]{6}) reaches ([\d.]+):1/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('wordmark.py and lockup.py', () => {
  const font = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
  ].find((f) => existsSync(f));

  it.skipIf(!font)(
    'sets letters as paths with the font kerning and the hand kerning, and locks up with the mark',
    () => {
      const wm = join(brand, 'scripts/wordmark.py');
      const plain = run(wm, ['AVA', '--font', font!, '--out', join(dir, 'w1.svg')]);
      expect(plain.code).toBe(0);
      const tight = run(wm, ['AVA', '--font', font!, '--kern', 'AV:-100', '--out', join(dir, 'w2.svg')]);
      expect(tight.code).toBe(0);
      const svg = readFileSync(join(dir, 'w1.svg'), 'utf8');
      expect(svg).not.toMatch(/<text/);
      expect(svg.match(/<path /g)).toHaveLength(3);
      expect(svg).toMatch(/data-cap-height="[\d.]+"/);
      const width = (s: string) => Number(s.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/)![1]);
      expect(width(readFileSync(join(dir, 'w2.svg'), 'utf8'))).toBeLessThan(width(svg));

      const lk = run(join(brand, 'scripts/lockup.py'), [
        join(example, 'mark.svg'),
        join(dir, 'w1.svg'),
        '--layout',
        'horizontal',
        '--out',
        join(dir, 'lk.svg'),
      ]);
      expect(lk.code).toBe(0);
      const out = readFileSync(join(dir, 'lk.svg'), 'utf8');
      expect(out).not.toMatch(/<svg[^>]*>[\s\S]*<svg/); // no nested <svg>: sign and embroidery software read it
      expect(out.match(/<path /g)!.length).toBe(5);
    },
  );
});

describe('council.py', () => {
  const script = join(root, 'skills/hildegard-council/scripts/council.py');

  it('gives each critic only its own rubric, and the tally fixes hard fails and what two critics agree on', () => {
    writeFileSync(join(dir, 'brief.md'), 'A logo for Maumee Bee Supply.');
    writeFileSync(join(dir, 'sheet.png'), '');
    const p = execFileSync(
      python,
      [
        script,
        'brief',
        '--role',
        'typographer',
        '--medium',
        'logo',
        '--brief',
        'brief.md',
        '--render',
        'sheet.png',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
    expect(p).toMatch(/You are the Typographer/);
    expect(p).toMatch(/Spacing and kerning/);
    expect(p).not.toMatch(/Would I stop/); // the customer's rubric stays with the customer
    expect(p).toMatch(/Maumee Bee Supply/);

    const review = (role: string, scores: Record<string, number>, extra: object) =>
      writeFileSync(
        join(dir, 'council', 'r1', `${role}.json`),
        JSON.stringify({ role, scores, overall: 3, verdict: 'x', ...extra }),
      );
    review(
      'typographer',
      { 'Typeface fit': 4, 'Spacing and kerning': 2, 'Scale and contrast': 4, 'Weight at size': 4 },
      { hard_fails: [], fixes: [{ area: 'wordmark', fix: 'tighten M and a by 20 units', must: true }] },
    );
    review(
      'customer',
      { 'Would I stop': 3, 'Do I understand': 2, 'Do I know what to do': 4, 'Do I trust it': 4 },
      {
        hard_fails: [{ kind: 'confusing', where: 'the mark', fix: 'make the hive shape read as a hive' }],
        fixes: [{ area: 'wordmark', fix: 'the name is too small on the cap at 40 mm', must: true }],
      },
    );
    review(
      'production',
      { 'One color and reversed': 4, Scales: 4, 'Files and system': 4, 'Built to last': 4 },
      { hard_fails: [{ kind: 'illegible', where: 'x', fix: 'y' }], fixes: [] },
    );
    const t = execFileSync(python, [script, 'tally'], { cwd: dir, encoding: 'utf8' });
    expect(t).toMatch(/HARD FAIL confusing \(The customer\)/);
    expect(t).toMatch(/wordmark, flagged by 2 critics/);
    expect(t).toMatch(/production: hard fail 'illegible' is not one Production may call/);
    expect(t).toMatch(/Round 2 is due/);
  });
});
