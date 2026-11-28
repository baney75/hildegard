// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const CHECK_DESIGN = join(repo, 'skills/hildegard-design/scripts/check_design.py');

const runPy = (args: string[]) => spawnSync(python, ['-B', CHECK_DESIGN, ...args], { encoding: 'utf8' });

describe('check_design.py', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hildegard-design-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('passes clean tokenized HTML/CSS and rejects slop patterns, raw hex/fonts, transition:all, 100vw, and missing paths', () => {
    const cleanHtml = join(dir, 'clean.html');
    writeFileSync(
      cleanHtml,
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Rye &amp; Salt</title>
<style>
:root {
  --bg: #f6f1e7;
  --ink: #1e1b18;
  --accent: #a63d28;
  --font-head: "Libre Caslon Display", serif;
  --font-body: "Libre Franklin", sans-serif;
}
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); font-family: var(--font-body); }
#bed { padding: 24px; }
a:focus-visible, #bed { outline: 2px solid var(--ink); }
main:has(#cafe) { padding: 16px; }
h1 { font-family: var(--font-head); }
button { background: var(--accent); color: var(--bg); transition: transform 160ms ease-out; }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
</head>
<body><main id="bed"><h1>Rye and Salt Bakery</h1><button type="button">Order</button></main></body>
</html>`,
    );
    const rOk = runPy(['--html', cleanHtml, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);
    expect(JSON.parse(rOk.stdout).ok).toBe(true);

    // Missing path and empty directory must fail cleanly
    expect(runPy(['--html', join(dir, 'missing-dir'), '--json']).status).toBe(1);
    const emptyDir = join(dir, 'empty-html');
    mkdirSync(emptyDir, { recursive: true });
    expect(runPy(['--html', emptyDir, '--json']).status).toBe(1);

    // Slop HTML/CSS: raw hex outside :root, transition: all, 100vw, overflow-x: hidden, missing focus-visible/reduced-motion, purple-blue gradient, italic word in h1, emoji, filler copy
    const badHtml = join(dir, 'bad.html');
    writeFileSync(
      badHtml,
      `<!doctype html>
<html><head><style>
html, body { width: 100vw; overflow-x: hidden; color: #222222; font-family: Arial, sans-serif; }
.hero { background: linear-gradient(135deg, #6366f1, #3b82f6); }
button { transition: all 0.3s ease; }
</style></head>
<body><section class="hero"><h1>Baking <em>reimagined</em></h1><p>Unlock the power of bread \u{1F525}</p><button>Go</button></section></body></html>`,
    );
    const rBad = runPy(['--html', badHtml, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('css_tokens');
    expect(badIds).toContain('no_transition_all');
    expect(badIds).toContain('safe_overflow');
    expect(badIds).toContain('focus_visible');
    expect(badIds).toContain('reduced_motion');
    expect(badIds).toContain('no_slop_patterns');

    // Inline style="" only and interactive HTML with no <style> must NOT silently pass
    const inlineOnly = join(dir, 'inline-only.html');
    writeFileSync(
      inlineOnly,
      '<!doctype html><html><body><div style="color:#ff0000; width:100vw; transition:all 0.2s"><button>Click</button></div></body></html>',
    );
    const rInline = runPy(['--html', inlineOnly, '--json']);
    expect(rInline.status).toBe(1);
    const inlineBad = JSON.parse(rInline.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(inlineBad).toContain('css_tokens');
    expect(inlineBad).toContain('no_transition_all');
    expect(inlineBad).toContain('safe_overflow');
    expect(inlineBad).toContain('focus_visible');
    expect(inlineBad).toContain('reduced_motion');

    const noCssInteractive = join(dir, 'no-css.html');
    writeFileSync(noCssInteractive, '<!doctype html><html><body><button>Bare</button></body></html>');
    const rNoCss = runPy(['--html', noCssInteractive, '--json']);
    expect(rNoCss.status).toBe(1);
    expect(
      JSON.parse(rNoCss.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('focus_visible');

    // Hardening: url(#fade), content:"#123", body .carousel {overflow-x:hidden}, border-top-color/var(--t-all), and typographic symbols ✕ ✓ ★ ✦ ❧ must PASS
    const edgeOk = join(dir, 'edge-ok.html');
    writeFileSync(
      edgeOk,
      `<!doctype html>
<html lang="en"><head><style>
:root { --bg: #f6f1e7; --ink: #1e1b18; --t-all: 160ms; }
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); }
body .carousel { overflow-x: hidden; }
.badge::before { content: "#123"; filter: url(#fade); }
button { transition: border-top-color var(--t-all) ease-out; }
button:focus-visible { outline: 2px solid var(--ink); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style></head>
<body><div class="carousel"><span class="badge">✓ ★ ✦ ❧ ✕</span><button>Go</button></div></body></html>`,
    );
    const rEdgeOk = runPy(['--html', edgeOk, '--json']);
    expect(rEdgeOk.status, rEdgeOk.stdout).toBe(0);

    // Hardening: CSS nesting outer raw color, [data-theme="dark"] .card raw color, minified @media body overflow-x:hidden, and bare transition shorthand must FAIL
    const nestedBad = join(dir, 'nested-bad.html');
    writeFileSync(
      nestedBad,
      `<!doctype html>
<html><head><style>
:root { --bg: #fff; --ink: #111; }
.card { color: #ff0000; &:hover { opacity: 0.8; } }
[data-theme="dark"] .card { background: #222222; }
@media(min-width:1px){body{overflow-x:hidden}}
button { transition: 200ms ease-out; }
button:focus-visible { outline: 2px solid var(--ink); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style></head><body><div class="card"><button>Act</button></div></body></html>`,
    );
    const rNested = runPy(['--html', nestedBad, '--json']);
    expect(rNested.status).toBe(1);
    const nestedBadIds = JSON.parse(rNested.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(nestedBadIds).toContain('css_tokens');
    expect(nestedBadIds).toContain('safe_overflow');
    expect(nestedBadIds).toContain('no_transition_all');

    // Round-1 #209 highs + mediums:
    // 1. html[data-theme="dark"], :root[data-theme], minified @media/@layer {:root{--*}} must PASS css_tokens
    const themeRootOk = join(dir, 'theme-root-ok.html');
    writeFileSync(
      themeRootOk,
      `<!doctype html><html><head><style>
@layer base{:root[data-theme]{--bg:#fff;--ink:#111}}
@media(prefers-color-scheme:dark){html[data-theme="dark"]{--bg:#111;--ink:#eee}}
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); }
.empty-ov { overflow-x: ; }
</style></head><body><p>Clean</p></body></html>`,
    );
    expect(runPy(['--html', themeRootOk, '--json']).status).toBe(0);

    // 2. .app [data-theme="dark"], nested :root { .card { color:#f00 } }, body{overflow-x:hidden!important}, transition: 200ms ease-out !important, and ⚠️/❤️ must FAIL
    const r1Bad = join(dir, 'r1-bad.html');
    writeFileSync(
      r1Bad,
      `<!doctype html><html><head><style>
:root { --bg: #fff; --ink: #111; .card { color: #ff0000; } }
.app [data-theme="dark"] { color: #00ff00; }
body{overflow-x:hidden!important}
button { transition: 200ms ease-out !important; }
button:focus-visible { outline: 2px solid var(--ink); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style></head><body><div class="app"><div data-theme="dark"><p>Warn \u26A0\uFE0F \u2764\uFE0F</p><button>Go</button></div></div></body></html>`,
    );
    const rR1Bad = runPy(['--html', r1Bad, '--json']);
    expect(rR1Bad.status).toBe(1);
    const r1BadIds = JSON.parse(rR1Bad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(r1BadIds).toContain('css_tokens');
    expect(r1BadIds).toContain('safe_overflow');
    expect(r1BadIds).toContain('no_transition_all');
    expect(r1BadIds).toContain('no_slop_patterns');

    // Round-2 #209 high (second-F1): grouping at-rules nested inside style rules
    const r2NestedAtOk = join(dir, 'r2-nested-at-ok.html');
    writeFileSync(
      r2NestedAtOk,
      `<!doctype html><html><head><style>
:root { --bg: #fff; --ink: #111; @media (prefers-color-scheme: dark) { --bg: #111; --ink: #eee; } }
.modal { body { overflow-x: hidden; } }
body { background: var(--bg); color: var(--ink); }
</style></head><body><p>Clean</p></body></html>`,
    );
    expect(runPy(['--html', r2NestedAtOk, '--json']).status).toBe(0);

    const r2NestedAtBad = join(dir, 'r2-nested-at-bad.html');
    writeFileSync(
      r2NestedAtBad,
      `<!doctype html><html><head><style>
:root { --bg: #fff; --ink: #111; }
body { @media (max-width: 768px) { overflow-x: hidden; } }
</style></head><body><p>Bad</p></body></html>`,
    );
    const rR2Bad = runPy(['--html', r2NestedAtBad, '--json']);
    expect(rR2Bad.status).toBe(1);
    const r2BadIds = JSON.parse(rR2Bad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(r2BadIds).toContain('safe_overflow');
  });

  it('validates DESIGN.md YAML token blocks, unique keys, token refs, and safe @path references', () => {
    const goodMd = join(dir, 'DESIGN.md');
    writeFileSync(
      goodMd,
      `---
version: alpha
name: Hearth Bakery
---

## Colors

\`\`\`yaml
colors:
  primary: "#1A1C1E"
  accent: "#B8422E"
\`\`\`

## Components

See \`@components/button.html\` for usage.

\`\`\`yaml
components:
  button:
    bg: "{colors.accent}"
\`\`\`
`,
    );
    const rOk = runPy(['--design-md', goodMd, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    // Duplicate top-level key, broken token ref, and path traversal @ref must fail
    const badMd = join(dir, 'BAD-DESIGN.md');
    writeFileSync(
      badMd,
      `---
name: Broken System
colors:
  primary: "#111111"
---

See \`@../../etc/passwd.txt\`.

\`\`\`yaml
colors:
  accent: "not a color 123"
components:
  card:
    bg: "{colors.missing_token}"
\`\`\`
`,
    );
    const rBad = runPy(['--design-md', badMd, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('unique_top_keys');
    expect(badIds).toContain('valid_color_tokens');
    expect(badIds).toContain('token_refs_valid');
    expect(badIds).toContain('external_refs_safe');

    // Duplicate top-level key INSIDE ONE block, cyclic/group/metadata refs, and extensionless/backslash/tilde/markdown-link @refs must fail
    const sameBlockDup = join(dir, 'SAME-BLOCK-DUP.md');
    writeFileSync(
      sameBlockDup,
      `---
name: Hearth
colors:
  primary: "{colors.primary}"
  accent: "{name}"
colors:
  secondary: "#123456"
components:
  card:
    bg: "{colors}"
    ref: "@../secret"
---

See \`@../../etc/passwd\`, \`@/etc/shadow\`, \`@~/.ssh/id_rsa.pub\`, \`@..\\..\\x.txt\`, and [spec](@../x.txt).
`,
    );
    const rDup = runPy(['--design-md', sameBlockDup, '--json']);
    expect(rDup.status).toBe(1);
    const dupOut = JSON.parse(rDup.stdout);
    const dupBad = dupOut.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
    expect(dupBad).toContain('unique_top_keys');
    expect(dupBad).toContain('token_refs_valid');
    expect(dupBad).toContain('external_refs_safe');
    const extCheck = dupOut.checks.find((c: { id: string }) => c.id === 'external_refs_safe');
    expect(extCheck.value.length).toBeGreaterThanOrEqual(6);

    // Hardening: bad color in FIRST of two duplicate colors: blocks, invalid "#12345"/"notacolor", zero-indented omitted list, nested color-mix, extensionless symlink @secret, trailing period @secret., and @C:..\secret
    const nestedMixMd = join(dir, 'NESTED-MIX.md');
    writeFileSync(
      nestedMixMd,
      `---
name: Mix System
omitted:
- spacing
colors:
  primary: "color-mix(in oklch, oklch(0.6 0.2 250) 70%, white)"
  accent: "#B8422E"
---
`,
    );
    const rMix = runPy(['--design-md', nestedMixMd, '--json']);
    expect(rMix.status, rMix.stdout).toBe(0);

    const extSub = join(dir, 'design-sub');
    mkdirSync(extSub, { recursive: true });
    const outsideTarget = join(dir, 'outside-secret.txt');
    writeFileSync(outsideTarget, 'top-secret');
    if (process.platform !== 'win32') {
      symlinkSync(outsideTarget, join(extSub, 'secret'));
    }
    const hardMd = join(extSub, 'HARD-DESIGN.md');
    writeFileSync(
      hardMd,
      `---
name: Hardened
colors:
  first_bad: "notacolor"
  short_hex: "#12345"
colors:
  second_ok: "#123456"
---

Check \`@C:..\\secret\`${process.platform !== 'win32' ? ' and see @secret.' : ''}.
`,
    );
    const rHard = runPy(['--design-md', hardMd, '--json']);
    expect(rHard.status).toBe(1);
    const hardOut = JSON.parse(rHard.stdout);
    const hardBad = hardOut.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
    expect(hardBad).toContain('unique_top_keys');
    expect(hardBad).toContain('valid_color_tokens');
    expect(hardBad).toContain('external_refs_safe');
    const badColorVals = hardOut.checks.find((c: { id: string }) => c.id === 'valid_color_tokens').value;
    expect(badColorVals.some((v: string) => v.includes('notacolor'))).toBe(true);
    expect(badColorVals.some((v: string) => v.includes('#12345'))).toBe(true);

    // Round-1 #209 highs: YAML block lists of mappings must not crash, and @.., @./.., @.\.. must fail external_refs_safe
    const listMapMd = join(dir, 'LIST-MAP-DESIGN.md');
    writeFileSync(
      listMapMd,
      `---
name: List Map System
omitted:
- section: spacing
  reason: static
fonts:
  - family: Inter
    weight: 400
colors:
  primary: "#1A1C1E"
---
`,
    );
    const rListMap = runPy(['--design-md', listMapMd, '--json']);
    expect(rListMap.status, rListMap.stdout).toBe(0);

    const dotTravMd = join(dir, 'DOT-TRAV-DESIGN.md');
    writeFileSync(
      dotTravMd,
      `---
name: Dot Trav
colors:
  primary: "#1A1C1E"
---

Bad refs: \`@..\`, \`@./..\`, and \`@.\\..\`.
`,
    );
    const rDotTrav = runPy(['--design-md', dotTravMd, '--json']);
    expect(rDotTrav.status).toBe(1);
    const dotOut = JSON.parse(rDotTrav.stdout);
    const dotExt = dotOut.checks.find((c: { id: string }) => c.id === 'external_refs_safe');
    expect(dotExt.ok).toBe(false);
    expect(dotExt.value.length).toBe(3);

    // Round-2 #209 high (second-F2): quoted list-item keys and mapping under omitted must not raise TypeError or drop values
    const r2YamlMapMd = join(dir, 'R2-YAML-MAP.md');
    writeFileSync(
      r2YamlMapMd,
      `---
name: Quoted And Omitted Map
fonts:
  - "family": Inter
    weight: 400
omitted:
  colors: monochrome
---
`,
    );
    const rR2YamlMap = runPy(['--design-md', r2YamlMapMd, '--json']);
    expect(rR2YamlMap.status, rR2YamlMap.stdout).toBe(0);

    const r2YamlOmittedListMd = join(dir, 'R2-YAML-OMITTED-LIST.md');
    writeFileSync(
      r2YamlOmittedListMd,
      `---
name: Quoted Omitted List
omitted:
  - "section": colors
    reason: monochrome
  - note: extra
---
`,
    );
    const rR2YamlOmittedList = runPy(['--design-md', r2YamlOmittedListMd, '--json']);
    expect(rR2YamlOmittedList.status, rR2YamlOmittedList.stdout).toBe(0);
  });

  it('validates isometric mechanical illustration contracts and rejects sparse/unmounted/floating-line specs', () => {
    const goodIso = join(dir, 'iso-ok.json');
    writeFileSync(
      goodIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 45,
        elevation_deg: 30,
        tones: { lo: '#2b2d30', mid: '#5a5f66', hi: '#c5cbd3', lit: '#ffffff' },
        lit_count: 1,
        parts: [
          { group: 'base_plate', host: 'ground', count: 12 },
          { group: 'rails', host: 'base_plate', count: 14 },
          { group: 'mechanism', host: 'rails', count: 16 },
        ],
        depth_sorted: true,
        floating_line_ends: 0,
        closeup_4x_checked: true,
        themes_checked: ['dark', 'light'],
      }),
    );
    const rOk = runPy(['--iso', goodIso, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    const badIso = join(dir, 'iso-bad.json');
    writeFileSync(
      badIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 10,
        elevation_deg: 80,
        tones: { lo: '#222', mid: '#222', hi: '#999', lit: '#fff' },
        lit_count: 3,
        parts: [{ group: 'floating', host: '', count: 5 }],
        depth_sorted: false,
        floating_line_ends: 4,
        closeup_4x_checked: false,
        themes_checked: ['dark'],
      }),
    );
    const rBad = runPy(['--iso', badIso, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('camera_iso');
    expect(badIds).toContain('four_tone_ramp');
    expect(badIds).toContain('part_density');
    expect(badIds).toContain('depth_sorted');
    expect(badIds).toContain('line_ends_resolved');
    expect(badIds).toContain('closeup_4x_checked');
    expect(badIds).toContain('dual_theme_checked');

    // Pre-render mode allows truthful closeup_4x_checked=false and themes_checked=[] while full mode rejects them
    const preRenderIso = join(dir, 'iso-prerender.json');
    writeFileSync(
      preRenderIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 45,
        elevation_deg: 30,
        tones: { lo: '#2b2d30', mid: '#5a5f66', hi: '#c5cbd3', lit: '#ffffff' },
        lit_count: 1,
        parts: [
          { group: 'base_plate', host: 'ground', count: 20 },
          { group: 'mechanism', host: 'base_plate', count: 22 },
        ],
        depth_sorted: true,
        closeup_4x_checked: false,
        themes_checked: [],
      }),
    );
    expect(runPy(['--iso', preRenderIso, '--pre-render', '--json']).status).toBe(0);
    expect(runPy(['--iso', preRenderIso, '--json']).status).toBe(1);

    // Missing tier, cyclic hosts, and dangling host "midair" must fail part_density
    for (const [label, payload] of [
      [
        'missing-tier',
        {
          azimuth_deg: 45,
          elevation_deg: 30,
          tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
          lit_count: 1,
          parts: [{ group: 'b', host: 'ground', count: 44 }],
          depth_sorted: true,
        },
      ],
      [
        'cyclic-host',
        {
          tier: 'figure',
          azimuth_deg: 45,
          elevation_deg: 30,
          tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
          lit_count: 1,
          parts: [
            { group: 'a', host: 'b', count: 22 },
            { group: 'b', host: 'a', count: 22 },
          ],
          depth_sorted: true,
        },
      ],
      [
        'dangling-host',
        {
          tier: 'figure',
          azimuth_deg: 45,
          elevation_deg: 30,
          tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
          lit_count: 1,
          parts: [{ group: 'a', host: 'midair', count: 44 }],
          depth_sorted: true,
        },
      ],
    ] as const) {
      const p = join(dir, `iso-${label}.json`);
      writeFileSync(p, JSON.stringify(payload));
      const r = runPy(['--iso', p, '--pre-render', '--json']);
      expect(r.status, `${label}: ${r.stdout}`).toBe(1);
      expect(
        JSON.parse(r.stdout)
          .checks.filter((c: { ok: boolean }) => !c.ok)
          .map((c: { id: string }) => c.id),
      ).toContain('part_density');
    }

    // Hardening: missing lit_count must FAIL four_tone_ramp; missing/malformed/directory --iso --json must emit JSON without traceback
    const noLitIso = join(dir, 'iso-no-lit.json');
    writeFileSync(
      noLitIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 45,
        elevation_deg: 30,
        tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
        parts: [{ group: 'b', host: 'ground', count: 44 }],
        depth_sorted: true,
      }),
    );
    const rNoLit = runPy(['--iso', noLitIso, '--pre-render', '--json']);
    expect(rNoLit.status).toBe(1);
    expect(
      JSON.parse(rNoLit.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('four_tone_ramp');

    const malformedIso = join(dir, 'iso-malformed.json');
    writeFileSync(malformedIso, '{bad json');
    const nonUtf8Iso = join(dir, 'iso-nonutf8.json');
    writeFileSync(nonUtf8Iso, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    for (const badPath of [join(dir, 'does-not-exist.json'), dir, malformedIso, nonUtf8Iso]) {
      const rErr = runPy(['--iso', badPath, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('validates animated line-art SVG ink contracts (--ink-anim) including planted-foot gait math and --pre-render', () => {
    const goodInk = join(dir, 'ink-ok.json');
    writeFileSync(
      goodInk,
      JSON.stringify({
        open_stroke_limbs: true,
        curved_lines: true,
        gait: {
          kind: 'walk',
          stride: 36,
          duty: 0.6,
          period_s: 1.0,
          scale: 0.5,
          travel_speed: 30.0,
          free_sine_walk: false,
        },
        skeleton_first_cloth: true,
        card_fixed_bg: true,
        palette_tokens: { ink: 'currentColor', paper_class: '.pp' },
        debug_stepping: { query_flag: '?debug', step_fn: 'window.__step', dt_s: 0.016667 },
        zoomed_strip_checked: true,
        day_cycle_checked: true,
      }),
    );
    const rOk = runPy(['--ink-anim', goodInk, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    // Pre-render mode passes without zoomed_strip_checked; full mode rejects it
    const preInk = join(dir, 'ink-prerender.json');
    writeFileSync(
      preInk,
      JSON.stringify({
        open_stroke_limbs: true,
        curved_lines: true,
        gait: {
          kind: 'run',
          stride: 32,
          duty: 0.4,
          period_s: 0.5,
          scale: 1.0,
          travel_speed: 160.0,
          free_sine_walk: false,
        },
        skeleton_first_cloth: true,
        card_fixed_bg: true,
        palette_tokens: { ink: 'currentColor', paper_class: '.pp' },
        debug_stepping: { query_flag: '?debug', step_fn: 'window.__step', dt_s: 0.016667 },
      }),
    );
    expect(runPy(['--ink-anim', preInk, '--pre-render', '--json']).status).toBe(0);
    expect(runPy(['--ink-anim', preInk, '--json']).status).toBe(1);

    // Skating travel_speed, free_sine_walk=true, wrong run duty >= 0.5, and bad debug dt_s must fail
    const badInk = join(dir, 'ink-bad.json');
    writeFileSync(
      badInk,
      JSON.stringify({
        open_stroke_limbs: false,
        curved_lines: false,
        gait: {
          kind: 'run',
          stride: 32,
          duty: 0.6,
          period_s: 0.5,
          scale: 1.0,
          travel_speed: 999.0,
          free_sine_walk: true,
        },
        skeleton_first_cloth: false,
        card_fixed_bg: false,
        palette_tokens: { ink: '#000', paper_class: 'pp' },
        debug_stepping: { query_flag: 'debug', step_fn: '', dt_s: 0.1 },
        zoomed_strip_checked: false,
        extra_key: 1,
      }),
    );
    const rBad = runPy(['--ink-anim', badInk, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('unknown_keys');
    expect(badIds).toContain('open_stroke_limbs');
    expect(badIds).toContain('curved_lines');
    expect(badIds).toContain('planted_foot_gait');
    expect(badIds).toContain('no_free_sine_walk');
    expect(badIds).toContain('skeleton_first_cloth');
    expect(badIds).toContain('card_fixed_bg');
    expect(badIds).toContain('ink_paper_tokens');
    expect(badIds).toContain('deterministic_debug_step');
    expect(badIds).toContain('zoomed_strip_checked');

    // Missing/malformed/non-UTF-8/dir --ink-anim returns JSON without traceback
    const nonUtf8 = join(dir, 'ink-nonutf8.json');
    writeFileSync(nonUtf8, Buffer.from([0xff, 0xfe]));
    for (const p of [join(dir, 'nope-ink.json'), dir, nonUtf8]) {
      const rErr = runPy(['--ink-anim', p, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('validates sakuga tactile UI VFX contracts (--sakuga) including 4 beats, volume squash, and --pre-render', () => {
    const goodSak = join(dir, 'sakuga-ok.json');
    writeFileSync(
      goodSak,
      JSON.stringify({
        control: 'button',
        plain_at_rest: true,
        immediate_state_change: true,
        beats: [
          { name: 'anticipation', effects: ['press_squash'] },
          { name: 'hit', effects: ['impact_burst', 'invert_frame'], sfx_word: 'DON!' },
          { name: 'follow_through', effects: ['smoke_puffs'] },
          { name: 'settle', effects: ['spring_settle'] },
        ],
        shared_clock_canvas: true,
        visual_rules: {
          flat_two_tone_outline: true,
          exit_by_shrink_not_fade: true,
          spring_driven: true,
          reduced_motion_keeps_state: true,
          volume_preserving_squash: { scale_x: 1.25, scale_y: 0.8 },
        },
        css_vars: { '--sk-ink': '#1a1a1f', '--sk-card': '#ffffff', '--sk-acc': '#e84a7f' },
        verification: {
          frame_strip_times_s: [0, 0.05, 0.12, 0.25, 0.45, 0.8],
          widths_px: [390, 1440],
          horizontal_overflow: false,
          keyboard_checked: true,
        },
      }),
    );
    const rOk = runPy(['--sakuga', goodSak, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    // Pre-render skips verification; full mode rejects missing verification
    const preSak = join(dir, 'sakuga-prerender.json');
    const prePayload = JSON.parse(readFileSync(goodSak, 'utf8'));
    delete prePayload.verification;
    writeFileSync(preSak, JSON.stringify(prePayload));
    expect(runPy(['--sakuga', preSak, '--pre-render', '--json']).status).toBe(0);
    expect(runPy(['--sakuga', preSak, '--json']).status).toBe(1);

    // Bad squash area (1.5*1.5), sfx on wrong beat, >2 effects per beat, token ref in css_vars, and missing phone width must fail
    const badSak = join(dir, 'sakuga-bad.json');
    writeFileSync(
      badSak,
      JSON.stringify({
        control: 'carousel',
        plain_at_rest: false,
        immediate_state_change: false,
        beats: [
          { name: 'anticipation', effects: ['a', 'b', 'c'], sfx_word: 'WHOOSH' },
          { name: 'hit', effects: ['burst'], sfx_word: 'DON!' },
          { name: 'follow_through', effects: [] },
          { name: 'settle', effects: [] },
        ],
        shared_clock_canvas: false,
        visual_rules: {
          flat_two_tone_outline: false,
          exit_by_shrink_not_fade: false,
          spring_driven: false,
          reduced_motion_keeps_state: false,
          volume_preserving_squash: { scale_x: 1.5, scale_y: 1.5 },
        },
        css_vars: { '--sk-ink': '{colors.ink}', '--sk-acc': 'notacolor' },
        verification: {
          frame_strip_times_s: [0, 0.2, 0.1],
          widths_px: [1440],
          horizontal_overflow: true,
          keyboard_checked: false,
        },
      }),
    );
    const rBad = runPy(['--sakuga', badSak, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('semantic_control');
    expect(badIds).toContain('plain_at_rest');
    expect(badIds).toContain('immediate_state_change');
    expect(badIds).toContain('sakuga_beats');
    expect(badIds).toContain('sakuga_sfx_on_hit');
    expect(badIds).toContain('shared_clock_canvas');
    expect(badIds).toContain('volume_preserving_squash');
    expect(badIds).toContain('css_var_theming');
    expect(badIds).toContain('stepped_frame_strip');
    expect(badIds).toContain('responsive_widths');
    expect(badIds).toContain('no_horizontal_overflow');
    expect(badIds).toContain('keyboard_checked');

    // Missing/malformed/non-UTF-8/dir --sakuga returns JSON without traceback
    const nonUtf8Sak = join(dir, 'sak-nonutf8.json');
    writeFileSync(nonUtf8Sak, Buffer.from([0xff, 0xfe]));
    for (const p of [join(dir, 'nope-sak.json'), dir, nonUtf8Sak]) {
      const rErr = runPy(['--sakuga', p, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('validates vector logo SVGs (--logo) for viewBox, security, outlined text, clearspace, 16px legibility, flat monochrome, and WCAG contrast', () => {
    // 1. Clean light-surface evenodd mark + benign <title>/<desc> must PASS
    const goodLight = join(dir, 'logo-light.svg');
    writeFileSync(
      goodLight,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <title>Hearth</title>
  <desc>Clean geometric brand mark</desc>
  <path fill="#1A1C1E" fill-rule="evenodd" d="M 16 16 H 84 V 84 H 16 Z M 34 34 H 66 V 66 H 34 Z"/>
  <rect x="42" y="42" width="16" height="16" fill="#B8422E"/>
</svg>`,
    );
    expect(runPy(['--logo', goodLight, '--surface', '#FFFFFF', '--json']).status).toBe(0);
    expect(runPy(['--logo', goodLight, '--json']).status).toBe(0);

    // 2. Clean dark-surface inverse mark + universal currentColor mark must PASS
    const goodDark = join(dir, 'logo-dark.svg');
    writeFileSync(
      goodDark,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect x="12" y="12" width="40" height="40" fill="#F6F1E7"/>
  <circle cx="32" cy="32" r="10" fill="#F2B84B"/>
</svg>`,
    );
    expect(runPy(['--logo', goodDark, '--surface', '#111111', '--json']).status).toBe(0);
    expect(runPy(['--logo', goodDark, '--surface', '#FFFFFF', '--json']).status).toBe(1);

    const goodMono = join(dir, 'logo-mono.svg');
    writeFileSync(
      goodMono,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <polygon points="32,10 54,52 10,52" fill="currentColor"/>
</svg>`,
    );
    expect(runPy(['--logo', goodMono, '--surface', '#FFFFFF', '--json']).status).toBe(0);
    expect(runPy(['--logo', goodMono, '--surface', '#111111', '--json']).status).toBe(0);

    // 3. Live <text> rejected by default, allowed with --allow-draft-text
    const draftSvg = join(dir, 'logo-draft.svg');
    writeFileSync(
      draftSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <rect x="16" y="16" width="48" height="48" fill="#1A1C1E"/>
  <text x="80" y="50" fill="#1A1C1E">HEARTH</text>
</svg>`,
    );
    const rDraftFail = runPy(['--logo', draftSvg, '--json']);
    expect(rDraftFail.status).toBe(1);
    expect(
      JSON.parse(rDraftFail.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('logo_outlined_text');
    expect(runPy(['--logo', draftSvg, '--allow-draft-text', '--json']).status).toBe(0);

    // 4. Fake white-fill cutout hack (#1A1C1E + #FFFFFF) must FAIL logo_contrast on both light and dark
    const fakeCutout = join(dir, 'logo-fake-cutout.svg');
    writeFileSync(
      fakeCutout,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="34" fill="#1A1C1E"/>
  <circle cx="50" cy="50" r="14" fill="#FFFFFF"/>
</svg>`,
    );
    const rCut = runPy(['--logo', fakeCutout, '--json']);
    expect(rCut.status).toBe(1);
    expect(
      JSON.parse(rCut.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('logo_contrast');

    // 5. Security, aspect mismatch, hairline stroke, edge clip, gradient/filter, >3 inks, and >64 shapes must FAIL
    const badSvg = join(dir, 'logo-bad.svg');
    const manyRects = Array.from(
      { length: 65 },
      (_, i) => `<rect x="20" y="${20 + (i % 5)}" width="10" height="10" fill="#1A1C1E"/>`,
    ).join('');
    writeFileSync(
      badSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="100" onload="alert(1)">
  <defs><linearGradient id="g"/><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>
  <script>alert(1)</script>
  <image href="https://example.com/x.png" width="20" height="20"/>
  <rect x="0" y="0" width="100" height="100" fill="url(#g)" filter="url(#f)" stroke="#111111" stroke-width="1"/>
  <circle cx="30" cy="30" r="10" fill="#B8422E"/>
  <circle cx="50" cy="50" r="10" fill="#14532D"/>
  <circle cx="70" cy="70" r="10" fill="#1E3A8A"/>
  ${manyRects}
</svg>`,
    );
    const rBad = runPy(['--logo', badSvg, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('logo_viewbox');
    expect(badIds).toContain('logo_self_contained');
    expect(badIds).toContain('logo_complexity');
    expect(badIds).toContain('logo_micro_legibility');
    expect(badIds).toContain('logo_clearspace');
    expect(badIds).toContain('logo_monochrome_safe');
    expect(badIds).toContain('logo_palette_restraint');

    // 6. XML entity bomb, malformed XML, non-UTF-8, missing file, and directory must emit clean JSON without traceback
    const xxeSvg = join(dir, 'logo-xxe.svg');
    writeFileSync(xxeSvg, '<!DOCTYPE svg [<!ENTITY x "boom">]><svg viewBox="0 0 10 10"/>');
    const badXml = join(dir, 'logo-malformed.svg');
    writeFileSync(badXml, '<svg><unclosed></svg>');
    const nonUtf8 = join(dir, 'logo-nonutf8.svg');
    writeFileSync(nonUtf8, Buffer.from([0xff, 0xfe, 0x00]));
    for (const p of [xxeSvg, badXml, nonUtf8, join(dir, 'missing-logo.svg'), dir]) {
      const rErr = runPy(['--logo', p, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('enforces strict flattened-logo contract, accurate SVG path/curve/transform geometry, paints, lengths, namespace, and pure wordmark drafts', () => {
    const failedIds = (svgText: string, extraArgs: string[] = [], name = 'case.svg') => {
      const p = join(dir, name);
      writeFileSync(p, svgText);
      const r = runPy(['--logo', p, ...extraArgs, '--json']);
      const parsed = JSON.parse(r.stdout);
      const bad = parsed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
      return { status: r.status, ok: parsed.ok, bad, checks: parsed.checks, stdout: r.stdout };
    };

    // 1. Compact svgo arc flags & compact numbers PASS; malformed/truncated/unknown/bad-flag paths FAIL; implicit repeated commands > 400 FAIL
    const compactArcOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path fill="#1A1C1E" d="M50 15a30 30 0 01-20 40A30 30 0 0180 80l-10-10 .5.5 1e-3 0Z"/>
</svg>`,
      [],
      'logo-compact-arc.svg',
    );
    expect(compactArcOk.status, compactArcOk.stdout).toBe(0);

    for (const [label, d] of [
      ['truncated-L', 'M 20 20 L 40'],
      ['unknown-cmd', 'M 20 20 X 40 40'],
      ['bad-arc-flag', 'M 20 20 A 30 30 0 2 1 80 80'],
      ['no-moveto', 'L 20 20 80 80'],
      ['trailing-after-z', 'M 20 20 L 80 80 Z 40 40'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" d="${d}"/></svg>`,
        [],
        `logo-bad-path-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_geometry');
    }

    const manyImplicit = Array.from(
      { length: 405 },
      (_, i) => `${20 + (i % 50)} ${20 + ((i * 3) % 50)}`,
    ).join(' ');
    const rImplicit = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" d="M 20 20 L ${manyImplicit} Z"/></svg>`,
      [],
      'logo-implicit-405.svg',
    );
    expect(rImplicit.status).toBe(1);
    expect(rImplicit.bad).toContain('logo_complexity');

    // 2. <line> must NEVER inherit default black fill; light stroke on dark surface PASSES
    const lineDark = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <line x1="20" y1="50" x2="80" y2="50" stroke="#F6F1E7" stroke-width="8"/>
</svg>`,
      ['--surface', '#111111'],
      'logo-line-dark.svg',
    );
    expect(lineDark.status, lineDark.stdout).toBe(0);

    // 3. Paints: rgba white cutout fails contrast; translucent rgba/#rrggbbaa/hsla fails monochrome; opaque hsl/#rrggbbaa/CSS named passes; unparsed paint fails
    const rgbaCutout = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="34" fill="#1A1C1E"/>
  <circle cx="50" cy="50" r="14" fill="rgba(255, 255, 255, 1)"/>
</svg>`,
      ['--surface', '#FFFFFF'],
      'logo-rgba-cutout.svg',
    );
    expect(rgbaCutout.status).toBe(1);
    expect(rgbaCutout.bad).toContain('logo_contrast');

    for (const [label, paint] of [
      ['rgba-half', 'rgba(26, 28, 30, 0.5)'],
      ['hex8-half', '#1A1C1E80'],
      ['hex4-half', '#1118'],
      ['hsla-half', 'hsla(210, 8%, 11%, 0.5)'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="${paint}"/></svg>`,
        [],
        `logo-trans-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_monochrome_safe');
    }

    const richColorsOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="16" y="16" width="30" height="30" fill="hsl(210, 10%, 12%)"/>
  <rect x="54" y="16" width="30" height="30" fill="#B8422EFF"/>
  <rect x="35" y="54" width="30" height="30" fill="midnightblue" stroke="rgba(255,255,255,0)"/>
</svg>`,
      ['--surface', '#FFFFFF'],
      'logo-rich-colors-ok.svg',
    );
    expect(richColorsOk.status, richColorsOk.stdout).toBe(0);

    for (const [label, paint] of [
      ['inherit', 'inherit'],
      ['context-fill', 'context-fill'],
      ['bogus', 'not-a-color'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="60" height="60" fill="#1A1C1E" stroke="${paint}" stroke-width="6"/>
</svg>`,
        [],
        `logo-unparsed-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_palette_restraint');
    }

    // 4. Strict flattened-logo contract & security: <style>, <use>, nested <svg>, SMIL, <?xml-stylesheet?>, data: URI, style url(), and opacity/fill-opacity/stroke-opacity < 1
    for (const [label, body, expectedCheck] of [
      [
        'style-tag',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.a{fill:#111}</style><rect class="a" x="20" y="20" width="60" height="60" fill="#111"/></svg>`,
        'logo_self_contained',
      ],
      [
        'use-tag',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><rect id="r" x="20" y="20" width="60" height="60"/></defs><use href="#r" fill="#111"/><rect x="20" y="20" width="60" height="60" fill="#111"/></svg>`,
        'logo_self_contained',
      ],
      [
        'nested-svg',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><svg x="10" y="10" width="80" height="80"><rect x="10" y="10" width="60" height="60" fill="#111"/></svg></svg>`,
        'logo_self_contained',
      ],
      [
        'smil-animate',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111"><animate attributeName="x" from="20" to="30" dur="1s"/></rect></svg>`,
        'logo_self_contained',
      ],
      [
        'smil-set',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111"><set attributeName="fill" to="#000"/></rect></svg>`,
        'logo_self_contained',
      ],
      [
        'xml-stylesheet',
        `<?xml-stylesheet type="text/css" href="evil.css"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111"/></svg>`,
        'logo_self_contained',
      ],
      [
        'data-uri-xlink',
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"><a xlink:href="data:image/svg+xml;base64,PHN2Zy8+"><rect x="20" y="20" width="60" height="60" fill="#111"/></a></svg>`,
        'logo_self_contained',
      ],
      [
        'style-url-data',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" style="background:url(data:image/png;base64,AA==)"/></svg>`,
        'logo_self_contained',
      ],
      [
        'style-url-local',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" style="clip-path:url(#c)"/></svg>`,
        'logo_self_contained',
      ],
      [
        'el-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" opacity="0.8"/></svg>`,
        'logo_monochrome_safe',
      ],
      [
        'group-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g opacity="0.5"><rect x="20" y="20" width="60" height="60" fill="#111"/></g></svg>`,
        'logo_monochrome_safe',
      ],
      [
        'fill-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" fill-opacity="0.6"/></svg>`,
        'logo_monochrome_safe',
      ],
      [
        'stroke-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><line x1="20" y1="50" x2="80" y2="50" stroke="#111" stroke-width="8" stroke-opacity="0.5"/></svg>`,
        'logo_monochrome_safe',
      ],
    ] as const) {
      const r = failedIds(body, [], `logo-flat-${label}.svg`);
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain(expectedCheck);
    }

    // 5. True Bezier & arc bounding boxes (control points outside 4% while curve stays inside PASS; reflected S/T and curve crossing margin FAIL)
    const cubicControlOutCurveIn = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#1A1C1E" d="M 20 50 C 20 0 80 0 80 50 L 80 80 L 20 80 Z"/>
</svg>`,
      [],
      'logo-cubic-in.svg',
    );
    expect(cubicControlOutCurveIn.status, cubicControlOutCurveIn.stdout).toBe(0);

    const quadControlOutCurveIn = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#1A1C1E" d="M 20 50 Q 50 -20 80 50 L 80 80 L 20 80 Z"/>
</svg>`,
      [],
      'logo-quad-in.svg',
    );
    expect(quadControlOutCurveIn.status, quadControlOutCurveIn.stdout).toBe(0);

    const smoothTReflectOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="none" stroke="#1A1C1E" stroke-width="6" d="M 15 50 Q 32.5 10 50 50 T 85 50"/>
</svg>`,
      [],
      'logo-smooth-t-ok.svg',
    );
    expect(smoothTReflectOk.status, smoothTReflectOk.stdout).toBe(0);

    const smoothTReflectOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="none" stroke="#1A1C1E" stroke-width="6" d="M 15 50 Q 32.5 -50 50 50 T 85 50"/>
</svg>`,
      [],
      'logo-smooth-t-out.svg',
    );
    expect(smoothTReflectOut.status).toBe(1);
    expect(smoothTReflectOut.bad).toContain('logo_clearspace');

    const smoothSReflectOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="none" stroke="#1A1C1E" stroke-width="6" d="M 15 50 C 25 20 40 -20 50 50 S 75 110 85 50"/>
</svg>`,
      [],
      'logo-smooth-s-out.svg',
    );
    expect(smoothSReflectOut.status).toBe(1);
    expect(smoothSReflectOut.bad).toContain('logo_clearspace');

    const arcBulgeOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#1A1C1E" d="M 30 30 A 45 45 0 1 1 70 30 Z"/>
</svg>`,
      [],
      'logo-arc-bulge-out.svg',
    );
    expect(arcBulgeOut.status).toBe(1);
    expect(arcBulgeOut.bad).toContain('logo_clearspace');

    // 6. Full 2D affine transforms (matrix, skewX, skewY, rotate) & exact rotated circle/ellipse/rect bboxes
    const rotatedCircleOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="#1A1C1E" transform="rotate(45 50 50)"/>
</svg>`,
      [],
      'logo-rot-circle-ok.svg',
    );
    expect(rotatedCircleOk.status, rotatedCircleOk.stdout).toBe(0);

    const rotatedEllipseOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="50" cy="50" rx="40" ry="15" fill="#1A1C1E" transform="rotate(90 50 50)"/>
</svg>`,
      [],
      'logo-rot-ellipse-ok.svg',
    );
    expect(rotatedEllipseOk.status, rotatedEllipseOk.stdout).toBe(0);

    const rotatedEllipseOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="50" cy="50" rx="48" ry="15" fill="#1A1C1E" transform="rotate(90 50 50)"/>
</svg>`,
      [],
      'logo-rot-ellipse-out.svg',
    );
    expect(rotatedEllipseOut.status).toBe(1);
    expect(rotatedEllipseOut.bad).toContain('logo_clearspace');

    const rotatedRectOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="#1A1C1E" transform="rotate(45 50 50)"/>
</svg>`,
      [],
      'logo-rot-rect-out.svg',
    );
    expect(rotatedRectOut.status).toBe(1);
    expect(rotatedRectOut.bad).toContain('logo_clearspace');

    const matrixSkewOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g transform="matrix(1 0 0 1 10 10) skewX(5) skewY(5)">
    <rect x="20" y="20" width="35" height="35" fill="#1A1C1E"/>
  </g>
</svg>`,
      [],
      'logo-matrix-skew-ok.svg',
    );
    expect(matrixSkewOk.status, matrixSkewOk.stdout).toBe(0);

    const matrixSkewOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="60" height="60" fill="#1A1C1E" transform="skewX(45)"/>
</svg>`,
      [],
      'logo-skew-out.svg',
    );
    expect(matrixSkewOut.status).toBe(1);
    expect(matrixSkewOut.bad).toContain('logo_clearspace');

    const badTransform = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="60" height="60" fill="#1A1C1E" transform="bogus(10)"/>
</svg>`,
      [],
      'logo-bad-transform.svg',
    );
    expect(badTransform.status).toBe(1);
    expect(badTransform.bad).toContain('logo_geometry');

    // 7. Strict SVG namespace: missing or wrong xmlns must fail logo_svg_valid
    for (const [label, rootTag] of [
      ['missing-xmlns', '<svg viewBox="0 0 100 100">'],
      ['wrong-xmlns', '<svg xmlns="http://example.com/svg" viewBox="0 0 100 100">'],
    ] as const) {
      const r = failedIds(
        `${rootTag}<rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
        [],
        `logo-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_svg_valid');
    }

    // 8. Percent and mm/pt lengths parsed cleanly (not coerced to 0); unparseable non-empty length fails logo_geometry
    const unitsOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
  <rect x="20%" y="20%" width="60%" height="60%" fill="#1A1C1E"/>
  <circle cx="50%" cy="50%" r="10pt" fill="#B8422E"/>
</svg>`,
      ['--surface', '#FFFFFF'],
      'logo-units-ok.svg',
    );
    expect(unitsOk.status, unitsOk.stdout).toBe(0);

    const mmRectOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="5mm" y="5mm" width="15mm" height="15mm" fill="#1A1C1E"/>
</svg>`,
      [],
      'logo-mm-ok.svg',
    );
    expect(mmRectOk.status, mmRectOk.stdout).toBe(0);

    const badLen = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="bogus" height="40" fill="#1A1C1E"/>
</svg>`,
      [],
      'logo-bad-len.svg',
    );
    expect(badLen.status).toBe(1);
    expect(badLen.bad).toContain('logo_geometry');

    // 9. --allow-draft-text pure <text> wordmark passes with flag and fails without flag
    const pureWordmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEARTH</text>
</svg>`;
    const rPureFail = failedIds(pureWordmarkSvg, [], 'logo-pure-wordmark.svg');
    expect(rPureFail.status).toBe(1);
    expect(rPureFail.bad).toContain('logo_outlined_text');
    expect(rPureFail.bad).toContain('logo_complexity');

    const rPureDraftOk = failedIds(pureWordmarkSvg, ['--allow-draft-text'], 'logo-pure-wordmark.svg');
    expect(rPureDraftOk.status, rPureDraftOk.stdout).toBe(0);

    // 10. viewBox with px units rejected; width="0" with no height rejected
    for (const [label, attrs] of [
      ['vb-units', 'viewBox="0 0 100px 100px"'],
      ['width-zero-only', 'viewBox="0 0 100 100" width="0"'],
      ['height-neg-only', 'viewBox="0 0 100 100" height="-10"'],
      ['width-unparseable', 'viewBox="0 0 100 100" width="auto"'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
        [],
        `logo-vb-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_viewbox');
    }
  }, 60_000);

  it('enforces strict SVG tag/namespace/attribute allowlist and round-2 logo hardening regressions', () => {
    const failedIds = (svgText: string, extraArgs: string[] = [], name = 'r2-case.svg') => {
      const p = join(dir, name);
      writeFileSync(p, svgText);
      const r = runPy(['--logo', p, ...extraArgs, '--json']);
      const parsed = JSON.parse(r.stdout);
      const bad = parsed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
      return { status: r.status, ok: parsed.ok, bad, checks: parsed.checks, stdout: r.stdout };
    };

    // HIGH #1: URL-bearing presentation/reference attrs & disallowed container tags (<defs>/<clipPath>)
    for (const [label, attr] of [
      ['clip-path-url', 'clip-path="url(https://evil.example/a#c)"'],
      ['mask-url', 'mask="url(https://evil.example/a#m)"'],
      ['filter-url', 'filter="url(https://evil.example/a#f)"'],
      ['marker-start-url', 'marker-start="url(https://evil.example/a#mk)"'],
      ['cursor-url', 'cursor="url(https://evil.example/a.cur), auto"'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E" ${attr}/></svg>`,
        [],
        `logo-r2-h1-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }
    const defsClipRejected = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="c"><rect x="10" y="10" width="80" height="80"/></clipPath></defs><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-defs-clip.svg',
    );
    expect(defsClipRejected.status).toBe(1);
    expect(defsClipRejected.bad).toContain('logo_self_contained');

    // HIGH #2 + MEDIUM #13: Entity-obfuscated URI schemes & <a> links (javascript, https, mailto, blob)
    for (const [label, body] of [
      [
        'href-tab-js',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="java&#x09;script:alert(1)"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
      [
        'href-lf-https',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="h&#x0a;ttps://evil.example/x"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
      [
        'a-mailto',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="mailto:x@y.com"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
      [
        'a-blob',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="blob:https://example.com/1234"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
    ] as const) {
      const r = failedIds(body, [], `logo-r2-h2-${label}.svg`);
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }

    // HIGH #3: ANY inline style attribute rejected (CSS escapes, inline transform, CSS comments)
    for (const [label, styleVal] of [
      ['css-escape-url', '\\75rl(https://evil.example/x)'],
      ['css-escape-fill', 'fi\\6cl: #FFF'],
      ['css-escape-opacity', 'op\\61city: 0.3'],
      ['inline-transform', 'transform: scale(0.1)'],
      ['css-comment-opacity', '/* c */ opacity: 0.3'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E" style="${styleVal}"/></svg>`,
        [],
        `logo-r2-h3-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }

    // HIGH #4: Hairline filled paths & scaled filled paths fail logo_micro_legibility
    const hairlineBar = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" d="M 10 10 H 90 V 11 H 10 Z"/></svg>`,
      [],
      'logo-r2-h4-bar.svg',
    );
    expect(hairlineBar.status).toBe(1);
    expect(hairlineBar.bad).toContain('logo_micro_legibility');

    const scaledTinyPath = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" transform="translate(50 50) scale(0.01)" d="M -30 -30 H 30 V 30 H -30 Z"/></svg>`,
      [],
      'logo-r2-h4-scaled.svg',
    );
    expect(scaledTinyPath.status).toBe(1);
    expect(scaledTinyPath.bad).toContain('logo_micro_legibility');

    const hairlinePoly = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon fill="#1A1C1E" points="10,10 90,10 90,11 10,11"/></svg>`,
      [],
      'logo-r2-h4-poly.svg',
    );
    expect(hairlinePoly.status).toBe(1);
    expect(hairlinePoly.bad).toContain('logo_micro_legibility');

    // MEDIUM #6: Inherited color property with currentColor
    for (const [label, body] of [
      [
        'svg-color-white',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" color="#FFFFFF"><rect x="20" y="20" width="60" height="60" fill="currentColor"/></svg>`,
      ],
      [
        'g-color-white',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g color="#FFFFFF"><rect x="20" y="20" width="60" height="60" fill="currentColor"/></g></svg>`,
      ],
    ] as const) {
      const r = failedIds(body, ['--surface', '#FFFFFF'], `logo-r2-m6-${label}.svg`);
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_contrast');
    }
    const plainCurrentColor = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="currentColor"/></svg>`,
      ['--surface', '#FFFFFF'],
      'logo-r2-m6-plain.svg',
    );
    expect(plainCurrentColor.status, plainCurrentColor.stdout).toBe(0);

    const badColorNone = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" color="none"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m6-color-none.svg',
    );
    expect(badColorNone.status).toBe(1);
    expect(badColorNone.bad).toContain('logo_palette_restraint');

    // MEDIUM #7: <tspan> inspected under --allow-draft-text, and <textPath> rejected outright
    const tspanWhite = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEA<tspan fill="#FFFFFF">RTH</tspan></text>
</svg>`,
      ['--allow-draft-text', '--surface', '#FFFFFF'],
      'logo-r2-m7-tspan-white.svg',
    );
    expect(tspanWhite.status).toBe(1);
    expect(tspanWhite.bad).toContain('logo_contrast');

    const tspanTranslucent = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEA<tspan opacity="0.5">RTH</tspan></text>
</svg>`,
      ['--allow-draft-text', '--surface', '#FFFFFF'],
      'logo-r2-m7-tspan-op.svg',
    );
    expect(tspanTranslucent.status).toBe(1);
    expect(tspanTranslucent.bad).toContain('logo_monochrome_safe');

    const tspanValid = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEA<tspan fill="#B8422E">RTH</tspan></text>
</svg>`,
      ['--allow-draft-text', '--surface', '#FFFFFF'],
      'logo-r2-m7-tspan-ok.svg',
    );
    expect(tspanValid.status, tspanValid.stdout).toBe(0);

    const textPathRejected = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" font-size="24" fill="#1A1C1E"><textPath>HEARTH</textPath></text>
</svg>`,
      ['--allow-draft-text'],
      'logo-r2-m7-textpath.svg',
    );
    expect(textPathRejected.status).toBe(1);
    expect(textPathRejected.bad).toContain('logo_self_contained');

    // MEDIUM #8: Unrounded WCAG contrast comparison (#959595 on #FFFFFF is ~2.995 < 3.0)
    const borderlineContrast = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#959595"/></svg>`,
      ['--surface', '#FFFFFF'],
      'logo-r2-m8-959595.svg',
    );
    expect(borderlineContrast.status).toBe(1);
    expect(borderlineContrast.bad).toContain('logo_contrast');

    // MEDIUM #10 & round-4 HIGH #1: Non-SVG namespace child and ANY <metadata> (plain or carrying XHTML <img>) rejected
    const foreignNsChild = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><xhtml:div xmlns:xhtml="http://www.w3.org/1999/xhtml"/><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m10-xhtml.svg',
    );
    expect(foreignNsChild.status).toBe(1);
    expect(foreignNsChild.bad).toContain('logo_self_contained');

    const evilMetadata = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><metadata><script>alert(1)</script></metadata><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m10-meta-script.svg',
    );
    expect(evilMetadata.status).toBe(1);
    expect(evilMetadata.bad).toContain('logo_self_contained');

    const evilMetadataUri = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><metadata><dc:link xmlns:dc="http://purl.org/dc/elements/1.1/" ref="h&#x0a;ttps://evil.example/x"/></metadata><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m10-meta-uri.svg',
    );
    expect(evilMetadataUri.status).toBe(1);
    expect(evilMetadataUri.bad).toContain('logo_self_contained');

    const evilMetadataXhtmlImg = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><metadata><img xmlns="http://www.w3.org/1999/xhtml" srcset="//evil.example/t.png 1x"/></metadata><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r4-meta-xhtml-img.svg',
    );
    expect(evilMetadataXhtmlImg.status).toBe(1);
    expect(evilMetadataXhtmlImg.bad).toContain('logo_self_contained');

    const plainMetadata = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><metadata>Hearth Brand</metadata><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r4-meta-plain.svg',
    );
    expect(plainMetadata.status).toBe(1);
    expect(plainMetadata.bad).toContain('logo_self_contained');

    // MEDIUM #11 & #12: display="none", visibility="hidden", mix-blend-mode="multiply" rejected
    for (const [label, attr] of [
      ['display-none', 'display="none"'],
      ['visibility-hidden', 'visibility="hidden"'],
      ['mix-blend-mode', 'mix-blend-mode="multiply"'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E" ${attr}/></svg>`,
        [],
        `logo-r2-m11-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }

    // LOW: <polygon> with > 400 vertices fails logo_complexity
    const polyPts = Array.from({ length: 405 }, (_, i) => {
      const ang = (i / 405) * Math.PI * 2;
      const x = (50 + 30 * Math.cos(ang)).toFixed(2);
      const y = (50 + 30 * Math.sin(ang)).toFixed(2);
      return `${x},${y}`;
    }).join(' ');
    const densePoly = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="${polyPts}" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-low-poly-405.svg',
    );
    expect(densePoly.status).toBe(1);
    expect(densePoly.bad).toContain('logo_complexity');

    // Round-4 MEDIUM #2: 2-line stacked wordmark passes --allow-draft-text clearspace
    const stackedWordmark = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <text x="50" y="42" text-anchor="middle" font-size="14" fill="#1A1C1E"><tspan x="50" dy="0">NORTH</tspan><tspan x="50" dy="18">FORGE</tspan></text>
</svg>`,
      ['--allow-draft-text'],
      'logo-r4-stacked-wordmark.svg',
    );
    expect(stackedWordmark.status, stackedWordmark.stdout).toBe(0);

    // Round-4 LOW #3: Non-finite length overflow fails logo_viewbox; non-finite transform composition fails logo_geometry
    const overflowWidth = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1e308in" height="100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r4-overflow-width.svg',
    );
    expect(overflowWidth.status).toBe(1);
    expect(overflowWidth.bad).toContain('logo_viewbox');

    const overflowTransform = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E" transform="scale(1e200) scale(1e200)"/></svg>`,
      [],
      'logo-r4-overflow-transform.svg',
    );
    expect(overflowTransform.status).toBe(1);
    expect(overflowTransform.bad).toContain('logo_geometry');

    // Round-4 LOW #4: Tiny draft <text> font-size or scaled-down draft <text> fails logo_micro_legibility under --allow-draft-text
    const tinyFontDraft = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" text-anchor="middle" font-size="1" fill="#1A1C1E">HI</text></svg>`,
      ['--allow-draft-text'],
      'logo-r4-tiny-font.svg',
    );
    expect(tinyFontDraft.status).toBe(1);
    expect(tinyFontDraft.bad).toContain('logo_micro_legibility');

    const scaledDownDraft = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" text-anchor="middle" transform="scale(0.01)" font-size="16" fill="#1A1C1E">HI</text></svg>`,
      ['--allow-draft-text'],
      'logo-r4-scaled-text.svg',
    );
    expect(scaledDownDraft.status).toBe(1);
    expect(scaledDownDraft.bad).toContain('logo_micro_legibility');
  }, 60_000);

  it('audits HTML and TSX with --web-lint [--fidelity], enforcing all 12 prescriptive rules, 4 fidelity gates, comment stripping, and symlink/node_modules skipping', () => {
    // 1. Clean HTML passes --web-lint --fidelity (including allowed style="--idx: 1", descendant/classed h1, and transition: none)
    const cleanWebHtml = join(dir, 'wl-clean.html');
    writeFileSync(
      cleanWebHtml,
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Brand</title>
<style>
:root {
  --bg: #f6f1e7;
  --surface: #ffffff;
  --ink: #1e1b18;
  --hairline: rgba(30, 27, 24, 0.12);
  --accent: #a63d28;
}
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); font-size: 16px; line-height: 1.5; margin: 0; }
header, main { max-width: 65ch; margin: 0 auto; padding: 24px; }
header h1.title { font-size: clamp(2rem, 5vw, 2.5rem); letter-spacing: -0.02em; }
.card { background: var(--surface); border: 1px solid var(--hairline); padding: 20px; }
.btn { background: var(--accent); color: var(--surface); border: 0; padding: 10px 18px; transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.btn:active { transform: scale(0.97); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (min-width: 768px) { header, main { padding: 48px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none; animation: none; } }
</style></head>
<body>
  <header><h1 class="title">Brand</h1></header>
  <main><section class="card" style="--idx: 1"><p>Concrete facts.</p><button class="btn" type="button">Action</button></section></main>
</body>
</html>`,
    );
    const rCleanHtml = runPy(['--web-lint', cleanWebHtml, '--fidelity', '--json']);
    expect(rCleanHtml.status, rCleanHtml.stdout).toBe(0);
    const cleanHtmlOut = JSON.parse(rCleanHtml.stdout);
    expect(cleanHtmlOut.ok).toBe(true);
    expect(cleanHtmlOut.findings).toEqual([]);

    // Non-motion transition: none without prefers-reduced-motion must NOT false-trigger reduced-motion
    const staticNoneHtml = join(dir, 'wl-transition-none.html');
    writeFileSync(
      staticNoneHtml,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; --surface: #fafafa; --accent: #a63d28; }
body { background: var(--bg); color: var(--ink); font-size: 16px; }
h1 { font-size: 40px; }
.box { transition: none; animation: none; }
</style></head><body><main><h1>Static</h1><div class="box">Plain</div></main></body></html>`,
    );
    const rStaticNone = runPy(['--web-lint', staticNoneHtml, '--json']);
    expect(rStaticNone.status, rStaticNone.stdout).toBe(0);

    // 2. Clean TSX passes --web-lint (min-h-dvh, <Button variant="brand">, static Record map, balanced-brace style={{ '--step': 1 }})
    const cleanTsx = join(dir, 'wl-clean.tsx');
    writeFileSync(
      cleanTsx,
      `const TONE_CLASS: Record<string, string> = { ok: 'text-foreground', warn: 'text-muted-foreground' };
export function Banner({ tone, step, fn }: { tone: string; step: number; fn: (a: number, b: number) => number }) {
  return (
    <section className="min-h-dvh flex items-center" style={{ '--step': step, '--y': \`\${fn(1, 2)}px\` }}>
      <Button onClick={() => step > 0} variant="brand">Action</Button>
      <span className={TONE_CLASS[tone] ?? 'text-foreground'}>Live</span>
    </section>
  );
}`,
    );
    const rCleanTsx = runPy(['--web-lint', cleanTsx, '--json']);
    expect(rCleanTsx.status, rCleanTsx.stdout).toBe(0);
    expect(JSON.parse(rCleanTsx.stdout).ok).toBe(true);

    // 3. All 12 rules failing across broken HTML and TSX
    const brokenHtml = join(dir, 'wl-broken.html');
    writeFileSync(
      brokenHtml,
      `<!doctype html>
<html><head><style>
:root { --bg: #f6f1e7; --ink: #1e1b18; --accent: #a63d28; --surface: #ffffff; }
html, body { width: 100vw; overflow-x: hidden; color: #222222; font-size: 16px; }
.card-header { background: linear-gradient(135deg, #6366f1, #3b82f6); }
.pop { transform: scale(0); transition: all 300ms ease-in; animation: enter 200ms ease-in; }
@media (prefers-reduced-motion: reduce) {}
</style></head>
<body>
  <div class="card-hedaer h-screen bg-pink-500 p-[13px]" style="color: var(--accent)">
    <p style="--: 1">Unlock the power of widgets \u{1F525}</p>
    <button class="pop" type="button">Go</button>
  </div>
</body></html>`,
    );
    const rBrokenHtml = runPy(['--web-lint', brokenHtml, '--json']);
    expect(rBrokenHtml.status).toBe(1);
    const brokenHtmlOut = JSON.parse(rBrokenHtml.stdout);
    const htmlRules = new Set(brokenHtmlOut.findings.map((f: { rule: string }) => f.rule));
    for (const rule of [
      'no-raw-colors',
      'no-arbitrary-values',
      'no-inline-styles',
      'no-unknown-classes',
      'micro-craft',
      'no-transition-all',
      'safe-overflow',
      'focus-visible',
      'reduced-motion',
      'no-slop-patterns',
    ]) {
      expect(htmlRules, `expected HTML rule ${rule}`).toContain(rule);
    }
    const unknownClassFinding = brokenHtmlOut.findings.find(
      (f: { rule: string; what: string }) =>
        f.rule === 'no-unknown-classes' && f.what.includes('card-hedaer'),
    );
    expect(unknownClassFinding?.fix).toContain('.card-header');
    const focusFinding = brokenHtmlOut.findings.find((f: { rule: string }) => f.rule === 'focus-visible');
    expect(focusFinding?.fix).toContain('a:focus-visible, button:focus-visible');
    // Inline style="--: 1" (bare --) and style="color: var(--accent)" must both trigger no-inline-styles
    const inlineHtmlFindings = brokenHtmlOut.findings.filter(
      (f: { rule: string }) => f.rule === 'no-inline-styles',
    );
    expect(inlineHtmlFindings.length).toBe(2);

    // Check human-readable CLI output format: [rule] file:line | what | why | Fix:
    const rBrokenText = runPy(['--web-lint', brokenHtml]);
    expect(rBrokenText.status).toBe(1);
    expect(rBrokenText.stdout).toMatch(/\[no-unknown-classes\] wl-broken\.html:\d+ \| .* \| .* \| Fix: /);
    expect(rBrokenText.stdout).toContain('RESULT: FIX the lines above');

    // no-unknown-classes must STILL fire when HTML has <style> with zero declared .class selectors
    const noClassCssHtml = join(dir, 'wl-noclass-css.html');
    writeFileSync(
      noClassCssHtml,
      `<!doctype html><html><head><style>
:root { --bg: #fff; --ink: #111; }
body { background: var(--bg); color: var(--ink); }
</style></head><body><div class="mystery-widget">Text</div></body></html>`,
    );
    const rNoClassCss = runPy(['--web-lint', noClassCssHtml, '--json']);
    expect(rNoClassCss.status).toBe(1);
    expect(JSON.parse(rNoClassCss.stdout).findings.map((f: { rule: string }) => f.rule)).toContain(
      'no-unknown-classes',
    );

    // Broken TSX: no-restyle (with onClick={() => x > 1}, className={"..."}, className={'...'}), require-static-classes (direct, cn(), ternary), balanced-brace style={{ ... }} & bare '--', raw colors, arbitrary values, min-h-screen
    const brokenTsx = join(dir, 'wl-broken.tsx');
    writeFileSync(
      brokenTsx,
      `export function Broken({ tone, ok, fn }: { tone: string; ok: boolean; fn: (o: { a: number }) => string }) {
  return (
    <div className="min-h-screen" style={{ color: fn({ a: 1 }) }}>
      <Button onClick={() => tone.length > 0} className="bg-red-500 p-[13px]">Save</Button>
      <Card className={"rounded-lg border-2"} style={{ '--': 1 }} />
      <Badge className={'text-slate-900'} />
      <span className={\`bg-\${tone}-500\`} />
      <span className={cn(\`text-\${tone}-600\`, 'flex')} />
      <span className={ok ? \`p-\${tone}\` : 'p-4'} />
    </div>
  );
}`,
    );
    const rBrokenTsx = runPy(['--web-lint', brokenTsx, '--json']);
    expect(rBrokenTsx.status).toBe(1);
    const brokenTsxOut = JSON.parse(rBrokenTsx.stdout);
    const tsxRules = new Set(brokenTsxOut.findings.map((f: { rule: string }) => f.rule));
    for (const rule of [
      'no-restyle',
      'no-raw-colors',
      'no-arbitrary-values',
      'no-inline-styles',
      'require-static-classes',
      'micro-craft',
    ]) {
      expect(tsxRules, `expected TSX rule ${rule}`).toContain(rule);
    }
    const restyleComps = brokenTsxOut.findings
      .filter((f: { rule: string }) => f.rule === 'no-restyle')
      .map((f: { what: string }) => f.what);
    expect(restyleComps.some((w: string) => w.includes('<Button'))).toBe(true);
    expect(restyleComps.some((w: string) => w.includes('<Card'))).toBe(true);
    expect(restyleComps.some((w: string) => w.includes('<Badge'))).toBe(true);
    expect(
      brokenTsxOut.findings.filter((f: { rule: string }) => f.rule === 'require-static-classes').length,
    ).toBe(3);
    expect(brokenTsxOut.findings.filter((f: { rule: string }) => f.rule === 'no-inline-styles').length).toBe(
      2,
    );

    // 4. All 4 --fidelity checks failing (only 2 tokens, bad type scale ratio + 0px guard, only prefers-reduced-motion media query, missing landmarks)
    const lowFidelityHtml = join(dir, 'wl-low-fidelity.html');
    writeFileSync(
      lowFidelityHtml,
      `<!doctype html>
<html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
body { background: var(--bg); color: var(--ink); font-size: 16px; }
h1 { font-size: 20px; }
.tiny { font-size: 0px; }
@media (prefers-reduced-motion: reduce) { * { transition: none; } }
</style></head>
<body><div><p>No landmarks here</p></div></body></html>`,
    );
    const rLowFid = runPy(['--web-lint', lowFidelityHtml, '--fidelity', '--json']);
    expect(rLowFid.status).toBe(1);
    const lowFidBad = JSON.parse(rLowFid.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(lowFidBad).toContain('fidelity_tokens');
    expect(lowFidBad).toContain('fidelity_type_scale');
    expect(lowFidBad).toContain('fidelity_responsive');
    expect(lowFidBad).toContain('fidelity_landmarks');

    // Non-finite font-size (1e309px) must NOT pass fidelity_type_scale
    const infFontHtml = join(dir, 'wl-inf-font.html');
    writeFileSync(
      infFontHtml,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; --surface: #eee; --accent: #a63d28; }
body { font-size: 16px; background: var(--bg); color: var(--ink); }
h1 { font-size: 1e309px; }
@media (min-width: 768px) { body { padding: 16px; } }
</style></head><body><header><h1>Hi</h1></header><main><p>Body</p></main></body></html>`,
    );
    const rInfFont = runPy(['--web-lint', infFontHtml, '--fidelity', '--json']);
    expect(rInfFont.status).toBe(1);
    expect(
      JSON.parse(rInfFont.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('fidelity_type_scale');

    // 5. Commented-out HTML/JSX must neither false-trigger findings nor falsely satisfy fidelity_landmarks
    const commentedHtml = join(dir, 'wl-comments.html');
    writeFileSync(
      commentedHtml,
      `<!doctype html>
<html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; --surface: #eee; --accent: #a63d28; }
body { background: var(--bg); color: var(--ink); font-size: 16px; }
h1 { font-size: 40px; }
@media (min-width: 768px) { body { padding: 24px; } }
</style></head>
<body>
<!--
  <header><h1>Commented</h1></header>
  <main><div style="color: #ff0000" class="bogus-cls">Unlock the power of \u{1F525}</div></main>
-->
<p>Plain visible text only.</p>
</body></html>`,
    );
    // Without --fidelity, commented-out violations must NOT fail
    const rCommNoFid = runPy(['--web-lint', commentedHtml, '--json']);
    expect(rCommNoFid.status, rCommNoFid.stdout).toBe(0);
    // With --fidelity, commented-out landmarks must NOT satisfy fidelity_landmarks
    const rCommFid = runPy(['--web-lint', commentedHtml, '--fidelity', '--json']);
    expect(rCommFid.status).toBe(1);
    expect(
      JSON.parse(rCommFid.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('fidelity_landmarks');

    const commentedTsx = join(dir, 'wl-comments.tsx');
    writeFileSync(
      commentedTsx,
      `export function CleanWithComment() {
  return (
    <section className="min-h-dvh">
      {/*
        <Button className="bg-red-500 p-[13px]" style={{ color: 'red' }}>Nope</Button>
        <div className={\`bg-\${tone}-500\`} />
      */}
      <Button variant="brand">Real</Button>
    </section>
  );
}`,
    );
    const rCommTsx = runPy(['--web-lint', commentedTsx, '--json']);
    expect(rCommTsx.status, rCommTsx.stdout).toBe(0);

    // 6. --fidelity rejected without --web-lint
    const rBadFidelity = runPy(['--html', cleanWebHtml, '--fidelity', '--json']);
    expect(rBadFidelity.status).not.toBe(0);
    expect(rBadFidelity.stderr).toContain('--fidelity');

    // 7. Directory scan skips node_modules and symlinks (both symlinked file and symlinked directory)
    const scanDir = join(dir, 'wl-dir-scan');
    const nmDir = join(scanDir, 'node_modules', 'pkg');
    const externalBadDir = join(dir, 'wl-external-bad');
    mkdirSync(nmDir, { recursive: true });
    mkdirSync(externalBadDir, { recursive: true });
    writeFileSync(join(scanDir, 'index.html'), readFileSync(cleanWebHtml, 'utf8'));
    writeFileSync(join(nmDir, 'bad.html'), readFileSync(brokenHtml, 'utf8'));
    const extBadFile = join(externalBadDir, 'bad-link.html');
    writeFileSync(extBadFile, readFileSync(brokenHtml, 'utf8'));
    if (process.platform !== 'win32') {
      symlinkSync(extBadFile, join(scanDir, 'linked-bad.html'));
      symlinkSync(externalBadDir, join(scanDir, 'linked-dir'));
    }
    const rDirScan = runPy(['--web-lint', scanDir, '--fidelity', '--json']);
    expect(rDirScan.status, rDirScan.stdout).toBe(0);
    const dirOut = JSON.parse(rDirScan.stdout);
    const scannedChk = dirOut.checks.find((c: { id: string }) => c.id === 'web_lint_files_scanned');
    expect(scannedChk.value).toBe(1);
  }, 60_000);

  it('covers all round-1 --web-lint regression cases (nested JSX, style assertions, comments, regexes, generics, Tailwind normalization, CSS lines, clamp)', () => {
    // HIGH #1: nested JSX inside prop expressions (trigger, renderItem, element) caught with exact line numbers
    const nestedJsx = join(dir, 'wl-r1-h1-nested.tsx');
    writeFileSync(
      nestedJsx,
      `export function PopoverDemo() {
  return (
    <Popover
      trigger={<Button className="bg-red-500">Open</Button>}
      renderItem={() => <Card style={{ color: 'red' }} />}
      element={<Badge className="p-[13px]" />}
    >
      <span>Body</span>
    </Popover>
  );
}`,
    );
    const rH1 = runPy(['--web-lint', nestedJsx, '--json']);
    expect(rH1.status).toBe(1);
    const h1Out = JSON.parse(rH1.stdout);
    const h1Rules = new Set(h1Out.findings.map((f: { rule: string }) => f.rule));
    expect(h1Rules).toContain('no-restyle');
    expect(h1Rules).toContain('no-raw-colors');
    expect(h1Rules).toContain('no-inline-styles');
    expect(h1Rules).toContain('no-arbitrary-values');
    const h1Btn = h1Out.findings.find(
      (f: { rule: string; what: string }) => f.rule === 'no-restyle' && f.what.includes('<Button'),
    );
    expect(h1Btn?.line).toBe(4);
    const h1Card = h1Out.findings.find((f: { rule: string }) => f.rule === 'no-inline-styles');
    expect(h1Card?.line).toBe(5);
    const h1Badge = h1Out.findings.find((f: { rule: string }) => f.rule === 'no-arbitrary-values');
    expect(h1Badge?.line).toBe(6);

    // HIGH #2: inline style with TS assertions, conditionals, identifiers, and spreads fail; custom-prop-only with TS assertion passes
    const stylePassTsx = join(dir, 'wl-r1-h2-style-ok.tsx');
    writeFileSync(
      stylePassTsx,
      `export function VarsOnly() {
  return (
    <div style={{ '--idx': 1 } as React.CSSProperties}>
      <span style={({ '--delay': '40ms' }) satisfies React.CSSProperties}>Hi</span>
    </div>
  );
}`,
    );
    const rH2Ok = runPy(['--web-lint', stylePassTsx, '--json']);
    expect(rH2Ok.status, rH2Ok.stdout).toBe(0);

    const styleBadTsx = join(dir, 'wl-r1-h2-style-bad.tsx');
    writeFileSync(
      styleBadTsx,
      `export function BadStyles({ cond, obj, base }: { cond: boolean; obj: React.CSSProperties; base: React.CSSProperties }) {
  return (
    <section>
      <div style={{ color: 'red' } as React.CSSProperties} />
      <div style={cond ? { padding: 4 } : undefined} />
      <div style={obj} />
      <div style={{ ...base, '--x': 1 }} />
    </section>
  );
}`,
    );
    const rH2Bad = runPy(['--web-lint', styleBadTsx, '--json']);
    expect(rH2Bad.status).toBe(1);
    const h2Findings = JSON.parse(rH2Bad.stdout).findings.filter(
      (f: { rule: string }) => f.rule === 'no-inline-styles',
    );
    expect(h2Findings.length).toBe(4);

    // HIGH #3: two separate {/* a */} ... <Button className='bg-red-500'/> ... {/* b */} comments must NOT delete Button
    const twoCommentsTsx = join(dir, 'wl-r1-h3-comments.tsx');
    writeFileSync(
      twoCommentsTsx,
      `export function BetweenComments() {
  return (
    <div>
      {/* a */}
      <Button className="bg-red-500">Act</Button>
      {/* b */}
    </div>
  );
}`,
    );
    const rH3 = runPy(['--web-lint', twoCommentsTsx, '--json']);
    expect(rH3.status).toBe(1);
    const h3Rules = new Set(JSON.parse(rH3.stdout).findings.map((f: { rule: string }) => f.rule));
    expect(h3Rules).toContain('no-restyle');
    expect(h3Rules).toContain('no-raw-colors');

    // HIGH #4: raw <button> in JSX-only file without focus-visible fails; <button className='focus-visible:ring-2'> and <Button variant='brand'> pass
    const rawBtnBad = join(dir, 'wl-r1-h4-raw-btn-bad.tsx');
    writeFileSync(
      rawBtnBad,
      `export function RawBtn() {
  return <button type="button">Click</button>;
}`,
    );
    const rH4Bad = runPy(['--web-lint', rawBtnBad, '--json']);
    expect(rH4Bad.status).toBe(1);
    expect(JSON.parse(rH4Bad.stdout).findings.map((f: { rule: string }) => f.rule)).toContain(
      'focus-visible',
    );

    const rawBtnOk = join(dir, 'wl-r1-h4-raw-btn-ok.tsx');
    writeFileSync(
      rawBtnOk,
      `export function RawBtnOk() {
  return <button type="button" className="focus-visible:ring-2">Click</button>;
}`,
    );
    expect(runPy(['--web-lint', rawBtnOk, '--json']).status).toBe(0);

    const compBtnOk = join(dir, 'wl-r1-h4-comp-btn-ok.tsx');
    writeFileSync(
      compBtnOk,
      `export function CompBtnOk() {
  return <Button variant="brand">Click</Button>;
}`,
    );
    expect(runPy(['--web-lint', compBtnOk, '--json']).status).toBe(0);

    // MEDIUM #5: // and /* */ comments between JSX props do NOT drop the tag
    const propCommentsTsx = join(dir, 'wl-r1-m5-prop-comments.tsx');
    writeFileSync(
      propCommentsTsx,
      `export function CommentedProps() {
  return (
    <Button
      // inline prop comment
      /* block prop comment */
      className="bg-red-500"
    >
      Save
    </Button>
  );
}`,
    );
    const rM5 = runPy(['--web-lint', propCommentsTsx, '--json']);
    expect(rM5.status).toBe(1);
    const m5Rules = new Set(JSON.parse(rM5.stdout).findings.map((f: { rule: string }) => f.rule));
    expect(m5Rules).toContain('no-restyle');
    expect(m5Rules).toContain('no-raw-colors');

    // MEDIUM #6: cn([...]) and clsx([...]) array arguments are audited (while subscript lookup keys are skipped)
    const cnArrayTsx = join(dir, 'wl-r1-m6-cn-array.tsx');
    writeFileSync(
      cnArrayTsx,
      `const TONE_MAP: Record<string, string> = { 'bg-red-500': 'text-foreground' };
export function CnArrays() {
  return (
    <div>
      <span className={TONE_MAP['bg-red-500']} />
      <div className={cn(['bg-red-500', 'p-[13px]'])} />
      <section className={clsx(['h-screen'])} />
    </div>
  );
}`,
    );
    const rM6 = runPy(['--web-lint', cnArrayTsx, '--json']);
    expect(rM6.status).toBe(1);
    const m6Out = JSON.parse(rM6.stdout);
    const m6Rules = new Set(m6Out.findings.map((f: { rule: string }) => f.rule));
    expect(m6Rules).toContain('no-raw-colors');
    expect(m6Rules).toContain('no-arbitrary-values');
    expect(m6Rules).toContain('micro-craft');
    // Subscript key TONE_MAP['bg-red-500'] on line 5 must NOT trigger no-raw-colors
    const m6RawLines = m6Out.findings
      .filter((f: { rule: string }) => f.rule === 'no-raw-colors')
      .map((f: { line: number }) => f.line);
    expect(m6RawLines).toEqual([6]);

    // MEDIUM #7: data-class and <script> strings do not trigger fake HTML unknown-class/inline-style errors
    const htmlSafety = join(dir, 'wl-r1-m7-safe.html');
    writeFileSync(
      htmlSafety,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
.card { background: var(--bg); color: var(--ink); }
</style></head><body>
  <div class="card" data-class="foo">Hello</div>
<script>
var s = 'class="bogus"';
var bad = 'style="color:#ff0000"';
</script>
</body></html>`,
    );
    const rM7Safe = runPy(['--web-lint', htmlSafety, '--json']);
    expect(rM7Safe.status, rM7Safe.stdout).toBe(0);

    // MEDIUM #8: footer p { font-size: 11px; } must NOT override body { font-size: 16px; }
    const m8Html = join(dir, 'wl-r1-m8-body-prec.html');
    writeFileSync(
      m8Html,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; --surface: #fafafa; --accent: #a63d28; }
body { background: var(--bg); color: var(--ink); font-size: 16px; }
h1 { font-size: 28px; }
footer p { font-size: 11px; }
@media (min-width: 768px) { body { padding: 16px; } }
</style></head><body><header><h1>Title</h1></header><main><p>Body</p></main><footer><p>Small</p></footer></body></html>`,
    );
    const rM8 = runPy(['--web-lint', m8Html, '--fidelity', '--json']);
    expect(rM8.status).toBe(1);
    const m8TypeCheck = JSON.parse(rM8.stdout).checks.find(
      (c: { id: string }) => c.id === 'fidelity_type_scale',
    );
    expect(m8TypeCheck.ok).toBe(false);
    expect(m8TypeCheck.value).toBe(1.75);

    // MEDIUM #9: generic JSX component <DataTable<User> className='bg-red-500'/> triggers no-restyle & no-raw-colors
    const genericTsx = join(dir, 'wl-r1-m9-generic.tsx');
    writeFileSync(
      genericTsx,
      `export function Users() {
  return <DataTable<User> className="bg-red-500" />;
}`,
    );
    const rM9 = runPy(['--web-lint', genericTsx, '--json']);
    expect(rM9.status).toBe(1);
    const m9Rules = new Set(JSON.parse(rM9.stdout).findings.map((f: { rule: string }) => f.rule));
    expect(m9Rules).toContain('no-restyle');
    expect(m9Rules).toContain('no-raw-colors');

    // MEDIUM #10: plain HTML without Tailwind flags class='text-heroo' as no-unknown-classes
    const plainHtmlTypo = join(dir, 'wl-r1-m10-plain-typo.html');
    writeFileSync(
      plainHtmlTypo,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
body { background: var(--bg); color: var(--ink); }
.text-hero { color: var(--ink); }
</style></head><body><p class="text-heroo">Typo</p></body></html>`,
    );
    const rM10 = runPy(['--web-lint', plainHtmlTypo, '--json']);
    expect(rM10.status).toBe(1);
    const m10Finding = JSON.parse(rM10.stdout).findings.find(
      (f: { rule: string; what: string }) => f.rule === 'no-unknown-classes' && f.what.includes('text-heroo'),
    );
    expect(m10Finding).toBeTruthy();
    expect(m10Finding.fix).toContain('.text-hero');

    // MEDIUM #11: !bg-red-500, bg-red-500!, hover:!bg-red-500, -m-[13px], and bare <Button className='border rounded'>
    const normTsx = join(dir, 'wl-r1-m11-norm.tsx');
    writeFileSync(
      normTsx,
      `export function Modifiers() {
  return (
    <div className="!bg-red-500 bg-red-500! hover:!bg-red-500 -m-[13px]">
      <Button className="border rounded">Save</Button>
    </div>
  );
}`,
    );
    const rM11 = runPy(['--web-lint', normTsx, '--json']);
    expect(rM11.status).toBe(1);
    const m11Out = JSON.parse(rM11.stdout);
    const m11Raw = m11Out.findings.filter((f: { rule: string }) => f.rule === 'no-raw-colors');
    expect(m11Raw.length).toBe(3);
    expect(m11Out.findings.some((f: { rule: string }) => f.rule === 'no-arbitrary-values')).toBe(true);
    const m11Restyle = m11Out.findings.filter((f: { rule: string }) => f.rule === 'no-restyle');
    expect(m11Restyle.length).toBe(2);

    // MEDIUM #12: regex literal /^https?:\/\// before JSX props (and inside JSX prop expr) not misread as comment
    const regexTsx = join(dir, 'wl-r1-m12-regex.tsx');
    writeFileSync(
      regexTsx,
      `export function RegexCheck({ url }: { url: string }) {
  const ok = /^https?:\\/\\//.test(url);
  const slashClass = /[/*]/.test(url);
  return (
    <Button onClick={() => /^https?:\\/\\//.test(url) && ok && slashClass} className="bg-red-500">
      Go
    </Button>
  );
}`,
    );
    const rM12 = runPy(['--web-lint', regexTsx, '--json']);
    expect(rM12.status).toBe(1);
    const m12Rules = new Set(JSON.parse(rM12.stdout).findings.map((f: { rule: string }) => f.rule));
    expect(m12Rules).toContain('no-restyle');
    expect(m12Rules).toContain('no-raw-colors');
    expect(m12Rules).not.toContain('web-lint-unparsed');

    // Fail-loud web-lint-unparsed: malformed JSX attribute and unsupported dynamic className emit web-lint-unparsed
    const unparsedTsx = join(dir, 'wl-r1-unparsed.tsx');
    writeFileSync(
      unparsedTsx,
      `export function Unparsed({ tone }: { tone: string }) {
  return (
    <div>
      <Button className=bg-red-500 />
      <span className={computeClasses(tone)} />
    </div>
  );
}`,
    );
    const rUnp = runPy(['--web-lint', unparsedTsx, '--json']);
    expect(rUnp.status).toBe(1);
    const unpOut = JSON.parse(rUnp.stdout);
    const unpFindings = unpOut.findings.filter((f: { rule: string }) => f.rule === 'web-lint-unparsed');
    expect(unpFindings.length).toBeGreaterThanOrEqual(2);
    const unpCheck = unpOut.checks.find((c: { id: string }) => c.id === 'web-lint-unparsed');
    expect(unpCheck?.ok).toBe(false);

    // LOW #1: transition-timing-function: ease-in fails micro-craft while my-ease-in and ease-in-out pass
    const easeBadCss = join(dir, 'wl-r1-l1-ease-bad.css');
    writeFileSync(
      easeBadCss,
      `:root { --bg: #fff; --ink: #111; }
.a { transition-timing-function: ease-in; }
.b { animation-timing-function: ease-in; }
@media (prefers-reduced-motion: reduce) { .a, .b { transition: none; animation: none; } }`,
    );
    const rL1Bad = runPy(['--web-lint', easeBadCss, '--json']);
    expect(rL1Bad.status).toBe(1);
    const l1Hits = JSON.parse(rL1Bad.stdout).findings.filter(
      (f: { rule: string }) => f.rule === 'micro-craft',
    );
    expect(l1Hits.length).toBe(2);

    const easeOkCss = join(dir, 'wl-r1-l1-ease-ok.css');
    writeFileSync(
      easeOkCss,
      `:root { --bg: #fff; --ink: #111; --my-ease-in: cubic-bezier(0.22, 1, 0.36, 1); }
.a { transition: transform 180ms ease-in-out; }
.b { animation: my-ease-in 180ms ease-out; }
@media (prefers-reduced-motion: reduce) { .a, .b { transition: none; animation: none; } }`,
    );
    const rL1Ok = runPy(['--web-lint', easeOkCss, '--json']);
    expect(rL1Ok.status, rL1Ok.stdout).toBe(0);

    // LOW #2: CSS finding reports actual declaration line (> 1) and multi-file slop finding points to offending file & line
    const multiDir = join(dir, 'wl-r1-l2-multi');
    mkdirSync(multiDir, { recursive: true });
    writeFileSync(
      join(multiDir, 'a-clean.html'),
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
body { background: var(--bg); color: var(--ink); }
</style></head><body><main><p>Clean file.</p></main></body></html>`,
    );
    writeFileSync(
      join(multiDir, 'b-slop.html'),
      `<!doctype html>
<html lang="en">
<head><style>
:root { --bg: #fff; --ink: #111; }
body {
  background: var(--bg);
  color: #222222;
}
</style></head>
<body>
  <main>
    <p>Unlock the power of widgets</p>
  </main>
</body>
</html>`,
    );
    const rL2 = runPy(['--web-lint', multiDir, '--json']);
    expect(rL2.status).toBe(1);
    const l2Out = JSON.parse(rL2.stdout);
    const l2Color = l2Out.findings.find((f: { rule: string }) => f.rule === 'no-raw-colors');
    expect(l2Color.file).toBe('b-slop.html');
    expect(l2Color.line).toBe(7);
    const l2Slop = l2Out.findings.find((f: { rule: string }) => f.rule === 'no-slop-patterns');
    expect(l2Slop.file).toBe('b-slop.html');
    expect(l2Slop.line).toBe(12);

    // LOW #3: CSS hsl(...) and oklch(...) outside :root fail no-raw-colors
    const modernColorCss = join(dir, 'wl-r1-l3-colors.css');
    writeFileSync(
      modernColorCss,
      `:root { --bg: #fff; --ink: #111; }
.a { color: hsl(210 50% 50%); }
.b { background: oklch(0.6 0.15 240); }`,
    );
    const rL3 = runPy(['--web-lint', modernColorCss, '--json']);
    expect(rL3.status).toBe(1);
    const l3Hits = JSON.parse(rL3.stdout).findings.filter(
      (f: { rule: string }) => f.rule === 'no-raw-colors',
    );
    expect(l3Hits.length).toBe(2);
    expect(l3Hits.map((f: { line: number }) => f.line)).toEqual([2, 3]);

    // LOW #4: clamp(24px, 4vw, max(36px, 2.5rem)) parses cleanly (40px / 16px = 2.5 >= 2.0)
    const clampNestedHtml = join(dir, 'wl-r1-l4-clamp.html');
    writeFileSync(
      clampNestedHtml,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; --surface: #fafafa; --accent: #a63d28; }
body { background: var(--bg); color: var(--ink); font-size: 16px; }
h1 { font-size: clamp(24px, 4vw, max(36px, 2.5rem)); }
@media (min-width: 768px) { body { padding: 16px; } }
</style></head><body><header><h1>Fluid</h1></header><main><p>Body</p></main></body></html>`,
    );
    const rL4 = runPy(['--web-lint', clampNestedHtml, '--fidelity', '--json']);
    expect(rL4.status, rL4.stdout).toBe(0);
    const l4TypeCheck = JSON.parse(rL4.stdout).checks.find(
      (c: { id: string }) => c.id === 'fidelity_type_scale',
    );
    expect(l4TypeCheck.ok).toBe(true);
    expect(l4TypeCheck.value).toBe(2.5);
  }, 60_000);

  it('covers all round-2 --web-lint regression cases (color-mix, TS generic call signatures, slash modifiers, className predicates/object maps, no-preference motion, JSX focus-visible fix, HTML script/comment/prose order, Vue/Svelte drop, Tailwind HTML unknown classes)', () => {
    // HIGH #1: token-only color-mix passes both --html and --web-lint; raw literal inside color-mix still fails
    const colorMixOk = join(dir, 'wl-r2-h1-colormix-ok.html');
    writeFileSync(
      colorMixOk,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; --accent: #a63d28; }
body { background: var(--bg); color: var(--ink); }
.pill { background: color-mix(in srgb, var(--accent) 12%, transparent); }
</style></head><body><main><span class="pill">OK</span></main></body></html>`,
    );
    expect(runPy(['--html', colorMixOk, '--json']).status).toBe(0);
    expect(runPy(['--web-lint', colorMixOk, '--json']).status).toBe(0);

    const colorMixBad = join(dir, 'wl-r2-h1-colormix-bad.html');
    writeFileSync(
      colorMixBad,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; --accent: #a63d28; }
body { background: var(--bg); color: var(--ink); }
.pill { background: color-mix(in srgb, #ff0000 50%, transparent); }
</style></head><body><main><span class="pill">Bad</span></main></body></html>`,
    );
    const rMixHtmlBad = runPy(['--html', colorMixBad, '--json']);
    expect(rMixHtmlBad.status).toBe(1);
    expect(
      JSON.parse(rMixHtmlBad.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('css_tokens');
    const rMixWlBad = runPy(['--web-lint', colorMixBad, '--json']);
    expect(rMixWlBad.status).toBe(1);
    expect(JSON.parse(rMixWlBad.stdout).findings.map((f: { rule: string }) => f.rule)).toContain(
      'no-raw-colors',
    );

    // HIGH #2: TS generic call-signature type parameters do not desync the lexer or swallow subsequent JSX
    const genericCallTsx = join(dir, 'wl-r2-h2-generic-call.tsx');
    writeFileSync(
      genericCallTsx,
      `type Id = <T>(x: T) => T;
type Pair = <T, U>(a: T, b: U) => [T, U];
type Bounded = <T extends { id: string }>(x: T) => string;
type Defaulted = <T = string>(x: T) => T;
type ConstGeneric = <const T>(x: T) => T;
export function GenericDemo(fn: <T>(x: T) => T) {
  const cfg = {
    renderItem: <T>(item: T) => <Button className="bg-red-500">{String(fn(item))}</Button>,
  };
  return cfg.renderItem('ok');
}`,
    );
    const rR2H2 = runPy(['--web-lint', genericCallTsx, '--json']);
    expect(rR2H2.status).toBe(1);
    const r2h2Out = JSON.parse(rR2H2.stdout);
    const r2h2Rules = new Set(r2h2Out.findings.map((f: { rule: string }) => f.rule));
    expect(r2h2Rules).toContain('no-restyle');
    expect(r2h2Rules).toContain('no-raw-colors');
    expect(r2h2Rules).not.toContain('web-lint-unparsed');
    const r2h2Btn = r2h2Out.findings.find(
      (f: { rule: string; what: string }) => f.rule === 'no-restyle' && f.what.includes('<Button'),
    );
    expect(r2h2Btn?.line).toBe(8);

    // MEDIUM #3: Tailwind slash opacity / line-height modifiers are caught
    const slashModTsx = join(dir, 'wl-r2-m3-slash-mod.tsx');
    writeFileSync(
      slashModTsx,
      `export function SlashMods() {
  return <div className="bg-[#ff0000]/50 text-[15px]/6 bg-red-500/[0.5]">Hi</div>;
}`,
    );
    const rR2M3 = runPy(['--web-lint', slashModTsx, '--json']);
    expect(rR2M3.status).toBe(1);
    const r2m3Out = JSON.parse(rR2M3.stdout);
    const m3Raw = r2m3Out.findings.filter((f: { rule: string }) => f.rule === 'no-raw-colors');
    const m3Arb = r2m3Out.findings.filter((f: { rule: string }) => f.rule === 'no-arbitrary-values');
    expect(m3Raw.length).toBe(2);
    expect(m3Arb.length).toBe(1);

    // MEDIUM #4: className predicates & clsx/cn object-map values
    const predOkTsx = join(dir, 'wl-r2-m4-pred-ok.tsx');
    writeFileSync(
      predOkTsx,
      `export function Predicates({ items, isDisabled, isOpen, isPinned }: { items: string[]; isDisabled: () => boolean; isOpen: () => boolean; isPinned: () => boolean }) {
  return (
    <div>
      <Button className={items.includes('border') ? 'flex' : 'grid'}>Act</Button>
      <span className={clsx('flex', { 'opacity-50': isDisabled() })}>Muted</span>
      <div className={(isOpen() || isPinned()) && 'mt-4'}>Box</div>
    </div>
  );
}`,
    );
    const rR2M4Ok = runPy(['--web-lint', predOkTsx, '--json']);
    expect(rR2M4Ok.status, rR2M4Ok.stdout).toBe(0);

    const predBadTsx = join(dir, 'wl-r2-m4-pred-bad.tsx');
    writeFileSync(
      predBadTsx,
      `export function PredicatesBad({ isDisabled }: { isDisabled: () => boolean }) {
  return <span className={clsx('flex', { 'bg-red-500': isDisabled() })}>Bad</span>;
}`,
    );
    const rR2M4Bad = runPy(['--web-lint', predBadTsx, '--json']);
    expect(rR2M4Bad.status).toBe(1);
    const r2m4BadRules = new Set(JSON.parse(rR2M4Bad.stdout).findings.map((f: { rule: string }) => f.rule));
    expect(r2m4BadRules).toContain('no-raw-colors');
    expect(r2m4BadRules).not.toContain('web-lint-unparsed');

    // MEDIUM #5: motion wrapped inside @media (prefers-reduced-motion: no-preference) passes reduced-motion
    const noPrefMotionCss = join(dir, 'wl-r2-m5-no-pref.css');
    writeFileSync(
      noPrefMotionCss,
      `:root { --bg: #fff; --ink: #111; }
@media (prefers-reduced-motion: no-preference) {
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .card { transition: transform 180ms ease-out; animation: fadeIn 200ms ease-out; }
}`,
    );
    const rR2M5 = runPy(['--web-lint', noPrefMotionCss, '--json']);
    expect(rR2M5.status, rR2M5.stdout).toBe(0);

    // HIGH #6: raw <button> in a .tsx file reports a JSX/Tailwind focus-visible utility Fix (not raw CSS)
    const jsxFocusBad = join(dir, 'wl-r2-h6-jsx-focus.tsx');
    writeFileSync(
      jsxFocusBad,
      `export function RawBtnFix() {
  return <button type="button">Save</button>;
}`,
    );
    const rR2H6 = runPy(['--web-lint', jsxFocusBad, '--json']);
    expect(rR2H6.status).toBe(1);
    const h6Focus = JSON.parse(rR2H6.stdout).findings.find(
      (f: { rule: string }) => f.rule === 'focus-visible',
    );
    expect(h6Focus).toBeTruthy();
    expect(h6Focus.fix).toContain('focus-visible:');
    expect(h6Focus.fix).not.toContain('a:focus-visible');

    // MEDIUM #7: <!-- inside <script> does not hide subsequent markup; prose and <pre><code> text do not trigger false findings
    const scriptCommentBad = join(dir, 'wl-r2-m7-script-comment.html');
    writeFileSync(
      scriptCommentBad,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
.ok { color: var(--ink); }
</style></head><body>
<script>var marker = '<!--';</script>
<div class="bogus-after-script" style="color: red">Real violation</div>
<!-- later real comment -->
</body></html>`,
    );
    const rR2M7Bad = runPy(['--web-lint', scriptCommentBad, '--json']);
    expect(rR2M7Bad.status).toBe(1);
    const m7BadRules = new Set(JSON.parse(rR2M7Bad.stdout).findings.map((f: { rule: string }) => f.rule));
    expect(m7BadRules).toContain('no-unknown-classes');
    expect(m7BadRules).toContain('no-inline-styles');

    const proseCodeClean = join(dir, 'wl-r2-m7-prose-code.html');
    writeFileSync(
      proseCodeClean,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
.doc { color: var(--ink); background: var(--bg); }
</style></head><body>
<article class="doc">
  <p>Do not write class="fake" or style="color:red" in prose.</p>
  <pre><code>class="fake" style="color:red"</code></pre>
  <p>Inline <code>&lt;div class="also-fake" style="padding:9px"&gt;</code> example.</p>
</article>
</body></html>`,
    );
    const rR2M7Clean = runPy(['--web-lint', proseCodeClean, '--json']);
    expect(rR2M7Clean.status, rR2M7Clean.stdout).toBe(0);

    // SCOPE #8: .vue and .svelte are not scanned by WEB_LINT_EXTS
    const vueSvelteDir = join(dir, 'wl-r2-s8-ignored');
    mkdirSync(vueSvelteDir, { recursive: true });
    writeFileSync(
      join(vueSvelteDir, 'App.vue'),
      `<template><div class="bg-red-500" style="color:red">Vue</div></template>`,
    );
    writeFileSync(
      join(vueSvelteDir, 'Widget.svelte'),
      `<div class="bg-red-500" style="color:red">Svelte</div>`,
    );
    const rR2S8 = runPy(['--web-lint', vueSvelteDir, '--json']);
    expect(rR2S8.status).toBe(1);
    const s8Out = JSON.parse(rR2S8.stdout);
    expect(s8Out.checks[0]?.id).toBe('web_lint_files_scanned');
    expect(s8Out.checks[0]?.ok).toBe(false);
    expect(s8Out.checks[0]?.value).toBe(0);

    // SCOPE #9: Tailwind-enabled HTML passes on-demand utilities without no-unknown-classes, while plain HTML still flags them
    const twHtmlOk = join(dir, 'wl-r2-s9-tailwind-ok.html');
    writeFileSync(
      twHtmlOk,
      `<!doctype html><html lang="en"><head>
<script src="https://cdn.tailwindcss.com"></script>
<style>
:root { --bg: #fff; --ink: #111; }
body { background: var(--bg); color: var(--ink); }
</style></head><body>
<main class="ps-4 drop-shadow-sm"><ul class="list-disc"><li class="underline underline-offset-2 decoration-2">Item</li></ul></main>
</body></html>`,
    );
    const rR2S9Ok = runPy(['--web-lint', twHtmlOk, '--json']);
    expect(rR2S9Ok.status, rR2S9Ok.stdout).toBe(0);

    const plainHtmlBad = join(dir, 'wl-r2-s9-plain-bad.html');
    writeFileSync(
      plainHtmlBad,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
body { background: var(--bg); color: var(--ink); }
</style></head><body>
<main class="ps-4 drop-shadow-sm underline-offset-2">Plain HTML</main>
</body></html>`,
    );
    const rR2S9Bad = runPy(['--web-lint', plainHtmlBad, '--json']);
    expect(rR2S9Bad.status).toBe(1);
    const s9Unknown = JSON.parse(rR2S9Bad.stdout).findings.filter(
      (f: { rule: string }) => f.rule === 'no-unknown-classes',
    );
    expect(s9Unknown.length).toBe(3);
  }, 60_000);

  it('covers all round-3 --web-lint regression cases (JSX child parens, fail-loud className, left-to-right HTML scan, top-level @keyframes, predicate templates, regex parens, TSX <style> strings, unclosed /*, typed var & slash modifiers)', () => {
    // HIGH #1: JSX child text starting with '(' must not trigger TS generic params; nested components still caught while TS generics still work
    const jsxParensTsx = join(dir, 'wl-r3-h1-jsx-parens.tsx');
    writeFileSync(
      jsxParensTsx,
      `type Id = <T>(x: T) => T;
export function Notes({ fn }: { fn: <T>(x: T) => T }) {
  const render = <T,>(x: T) => fn(x);
  return (
    <div>(Note): click <Button className="bg-red-500"/>{String(render('a'))}</div>
  );
}
export function OptionalNote() {
  return <p>(Optional): <Badge className="p-[13px]"/></p>;
}`,
    );
    const rH1 = runPy(['--web-lint', jsxParensTsx, '--json']);
    expect(rH1.status).toBe(1);
    const h1Out = JSON.parse(rH1.stdout);
    const h1Rules = new Set(h1Out.findings.map((f: { rule: string }) => f.rule));
    expect(h1Rules).toContain('no-restyle');
    expect(h1Rules).toContain('no-raw-colors');
    expect(h1Rules).toContain('no-arbitrary-values');
    expect(h1Rules).not.toContain('web-lint-unparsed');

    // HIGH #2: unhandled className forms emit web-lint-unparsed; cn(...)! and cn(...) as string unwrap and audit; TONE_MAP[tone] passes
    const clsUnparsedTsx = join(dir, 'wl-r3-h2-unparsed.tsx');
    writeFileSync(
      clsUnparsedTsx,
      `const TONE_MAP: Record<string, string> = { ok: 'text-foreground' };
export function ClassAudit({ x, tone, idx }: { x: string; tone: string; idx: number }) {
  return (
    <div>
      <span className={TONE_MAP[tone] ?? 'text-foreground'} />
      <span className={TONE_MAP[tone]} />
      <span className={x as string} />
      <span className={{ ok: 'a' }[tone]} />
      <span className={['a', 'b'][idx]} />
      <span className={computeClasses(tone)} />
      <span className={x} />
      <span className={cn('bg-red-500')!} />
      <span className={cn('bg-red-500') as string} />
    </div>
  );
}`,
    );
    const rH2 = runPy(['--web-lint', clsUnparsedTsx, '--json']);
    expect(rH2.status).toBe(1);
    const h2Out = JSON.parse(rH2.stdout);
    const h2Unparsed = h2Out.findings.filter((f: { rule: string }) => f.rule === 'web-lint-unparsed');
    const h2Raw = h2Out.findings.filter((f: { rule: string }) => f.rule === 'no-raw-colors');
    expect(h2Unparsed.map((f: { line: number }) => f.line)).toEqual([7, 8, 9, 10, 11]);
    expect(h2Raw.map((f: { line: number }) => f.line)).toEqual([12, 13]);

    // MEDIUM #3: HTML comment mentioning <script> without closing ends at --> and never masks following markup
    const commentScriptHtml = join(dir, 'wl-r3-m3-comment-script.html');
    writeFileSync(
      commentScriptHtml,
      `<!doctype html><html lang="en"><head><style>
:root { --bg: #fff; --ink: #111; }
body { background: var(--bg); color: var(--ink); }
</style></head><body>
<!-- mentions <script> without closing -->
<div style="color: red">Visible violation</div>
</body></html>`,
    );
    const rM3 = runPy(['--web-lint', commentScriptHtml, '--json']);
    expect(rM3.status).toBe(1);
    expect(JSON.parse(rM3.stdout).findings.map((f: { rule: string }) => f.rule)).toContain(
      'no-inline-styles',
    );

    // MEDIUM #4: top-level @keyframes used only inside @media (prefers-reduced-motion: no-preference) passes
    const topKfCss = join(dir, 'wl-r3-m4-top-keyframes.css');
    writeFileSync(
      topKfCss,
      `:root { --bg: #fff; --ink: #111; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: no-preference) {
  .card { animation: fade 200ms ease-out; }
}`,
    );
    const rM4 = runPy(['--web-lint', topKfCss, '--json']);
    expect(rM4.status, rM4.stdout).toBe(0);

    // MEDIUM #5: template literals in predicates and clsx object-map values do NOT trigger require-static-classes
    const predTplTsx = join(dir, 'wl-r3-m5-pred-tpl.tsx');
    writeFileSync(
      predTplTsx,
      `export function PredTemplates({ id, i }: { id: string; i: number }) {
  return (
    <div>
      <span className={id === \`row-\${i}\` ? 'flex' : 'grid'} />
      <span className={clsx('flex', { 'opacity-50': id === \`row-\${i}\` })} />
    </div>
  );
}`,
    );
    const rM5 = runPy(['--web-lint', predTplTsx, '--json']);
    expect(rM5.status, rM5.stdout).toBe(0);

    // MEDIUM #6: regex literal containing ')' inside cn(...) parses cleanly and flags no-raw-colors
    const regexParenTsx = join(dir, 'wl-r3-m6-regex-paren.tsx');
    writeFileSync(
      regexParenTsx,
      `export function RegexParen({ s }: { s: string }) {
  return <div className={cn(/[)]/.test(s) ? 'bg-red-500' : 'flex')} />;
}`,
    );
    const rM6 = runPy(['--web-lint', regexParenTsx, '--json']);
    expect(rM6.status).toBe(1);
    const m6Rules = new Set(JSON.parse(rM6.stdout).findings.map((f: { rule: string }) => f.rule));
    expect(m6Rules).toContain('no-raw-colors');
    expect(m6Rules).not.toContain('web-lint-unparsed');

    // SMALL #1..#4: JS string '<style>' does not mask code; unclosed '/*' emits web-lint-unparsed;
    // text-[length:var(--x)] passes; text-[15px]/tight and text-[15px]/2.5 fail no-arbitrary-values
    const styleStrTsx = join(dir, 'wl-r3-s1-style-str.tsx');
    writeFileSync(
      styleStrTsx,
      `export function StyleInStr() {
  const a = 'do not use <style> tags';
  return (
    <div className="text-[length:var(--x)] text-[15px]/tight text-[15px]/2.5">
      <Button className="bg-red-500">{a}</Button>
    </div>
  );
}
export const styleCloseHint = 'or </style> here';`,
    );
    const rS1 = runPy(['--web-lint', styleStrTsx, '--json']);
    expect(rS1.status).toBe(1);
    const s1Out = JSON.parse(rS1.stdout);
    const s1Arb = s1Out.findings.filter((f: { rule: string }) => f.rule === 'no-arbitrary-values');
    expect(s1Arb.length).toBe(2);
    expect(s1Arb.some((f: { what: string }) => f.what.includes('length:var(--x)'))).toBe(false);
    expect(s1Out.findings.some((f: { rule: string }) => f.rule === 'no-raw-colors')).toBe(true);

    const unclosedBlockTsx = join(dir, 'wl-r3-s2-unclosed-comment.tsx');
    writeFileSync(
      unclosedBlockTsx,
      `export function BrokenComment() {
  /* forgot to close
  return <Button className="bg-red-500">Hi</Button>;
}`,
    );
    const rS2 = runPy(['--web-lint', unclosedBlockTsx, '--json']);
    expect(rS2.status).toBe(1);
    const s2Unp = JSON.parse(rS2.stdout).findings.find(
      (f: { rule: string }) => f.rule === 'web-lint-unparsed',
    );
    expect(s2Unp).toBeTruthy();
    expect(s2Unp.line).toBe(2);
  }, 60_000);
});
