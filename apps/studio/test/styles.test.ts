// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classesIn, classKnown, splitSelectors, styleRules } from './css-rules.ts';

const root = join(import.meta.dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(join(root, 'src'));
const sources = [
  ...files.filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(f, 'utf8')),
  readFileSync(join(root, 'index.html'), 'utf8'),
].join('\n');
const sheets = files.filter((f) => f.endsWith('.css'));

describe('stylesheets', () => {
  it('reads rules inside @media, past comments and data URLs', () => {
    const css =
      '/* a { } */ .a, .b:not(.c) { x: url("data:,{}") } @media (x) { .d .e { y: 1 } } @font-face { f: 1 }';
    expect(styleRules(css).map((r) => r.selectors)).toEqual([['.a', '.b:not(.c)'], ['.d .e']]);
    expect(splitSelectors(':is(.a, .b) .c, .d')).toEqual([':is(.a, .b) .c', '.d']);
    expect(classesIn('.a.b:not(.c) > .d[data-x=".e"]')).toEqual(['a', 'b', 'd']);
  });

  it('knows classes written whole or as a template prefix', () => {
    const known = classKnown(['className={`hg-btn--$', "{kind}`} kind: 'primary' 'cs-card'"].join(''));
    expect(['cs-card', 'hg-btn--primary'].map(known)).toEqual([true, true]);
    expect(['cs-gone', 'hg-btn--gone'].map(known)).toEqual([false, false]);
  });

  // Every rule ships in the one stylesheet each page loads, so a rule for a class nothing renders is pure weight.
  it('has no rules for classes the Studio never renders', () => {
    const known = classKnown(sources);
    const dead = sheets.flatMap((f) =>
      styleRules(readFileSync(f, 'utf8')).flatMap((r) =>
        r.selectors.filter((s) => !classesIn(s).every(known)).map((s) => `${f.slice(root.length + 1)}: ${s}`),
      ),
    );
    expect(dead).toEqual([]);
  });
});
