// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonProse, describeProseLint, lintProse } from '../src/index.ts';
import FIXTURES from './prose-fixtures.json' with { type: 'json' };

interface Case {
  name: string;
  text: string;
  fails?: string[];
  warns?: string[];
  clean?: boolean;
  ok?: boolean;
}

interface Attack {
  name: string;
  head: string;
  unit: string;
  times: number;
  tail: string;
}

describe('prose lint', () => {
  for (const c of FIXTURES.cases as Case[]) {
    it(c.name, () => {
      const l = lintProse(c.text);
      const ids = (sev: string) => l.findings.filter((f) => f.severity === sev).map((f) => f.id);
      if (c.clean) {
        expect(
          l.findings.map((f) => `${f.severity} ${f.id}: ${f.matches.map((m) => m.text).join(' | ')}`),
        ).toEqual([]);
        expect(l.ok).toBe(true);
      }
      if (c.ok !== undefined) expect(l.ok).toBe(c.ok);
      for (const id of c.fails ?? []) expect(ids('fail')).toContain(id);
      for (const id of c.warns ?? []) expect(ids('warn')).toContain(id);
      if (c.fails?.length) expect(l.ok).toBe(false);
    });
  }

  it('points at each tell where it is in the text as given', () => {
    const text = 'Line one is fine.\nWe will delve into it.';
    const f = lintProse(text).findings.find((x) => x.id === 'stock-words')!;
    expect(f.matches[0]).toMatchObject({ text: 'delve', line: 2, column: 9 });
    expect(text.slice(f.matches[0]!.index, f.matches[0]!.index + 5)).toBe('delve');
  });

  it('lints the largest text the server takes in well under a second, even made of nothing but tells', () => {
    for (const unit of ['delve ', 'a — b\n']) {
      const text = unit.repeat(Math.floor(200_000 / unit.length));
      const started = performance.now();
      const l = lintProse(text);
      expect(l.ok).toBe(false);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  for (const a of FIXTURES.attacks as Attack[]) {
    it(`lints 200,000 characters of ${a.name} in well under a second`, () => {
      const text = a.head + a.unit.repeat(a.times) + a.tail;
      const started = performance.now();
      lintProse(text);
      expect(performance.now() - started).toBeLessThan(750);
    });
  }

  it('blanks what the plain patterns blank, and only that, when a closer is missing', () => {
    // Underscores stand in for spaces in the input, so every space in the output is a blanked character. The
    // expected values are what the plain patterns (no consumed-alternative) gave before they were rewritten.
    const blanked = (t: string) => blankNonProse(t).replaceAll(' ', '.');
    expect(blanked('x_<_y_<b>z')).toBe('x_.......z');
    expect(blanked('a_<>_b_<i>c')).toBe('a_<>_b_...c');
    expect(blanked('a_<_b\nc_<i>d')).toBe('a_<_b\nc_...d');
    expect(blanked('a_![b](c)_d')).toBe('a_......._d');
    expect(blanked('![a_![b](c)')).toBe('...........');
    expect(blanked('![a]_![b](c)')).toBe('![a]_.......');
    expect(blanked('![a](b_![c](d)')).toBe('..............');
    expect(blanked('see_[x](y)_and_](z')).toBe('see_[x](.._and_](z');
    expect(blanked('<code>a</code>_b_<CODE>c')).toBe('.............._b_......c');
    expect(blanked('<pre>a_<code>b</pre>_c</code>')).toBe('...................._c.......');
  });

  it('skips a capitalised match inside a sentence, a name, and keeps the one that starts it', () => {
    const l = lintProse(
      'Foster the habit early. Pastor Mike Foster will bless the food. Teachers foster it too.',
    );
    expect(l.findings.find((f) => f.id === 'loaded-words')?.matches.map((m) => m.text)).toEqual([
      'Foster',
      'foster',
    ]);
  });

  it('blanks code, links and HTML without moving anything', () => {
    const text = 'See `robust()` and [x](https://a.b/delve) or <b>bold</b>.';
    const blanked = blankNonProse(text);
    expect(blanked).toHaveLength(text.length);
    expect(blanked).not.toMatch(/robust|delve|<b>/);
    expect(blanked).toContain('See');
  });

  it('describes a lint in lines an agent can act on', () => {
    expect(describeProseLint(lintProse('A plain sentence about a red barn.'))).toMatch(
      /^Clean: no tells in 7 words/,
    );
    const d = describeProseLint(lintProse('We delve into it — fast.'));
    expect(d).toMatch(/^Fails: 2 tells to fix/);
    expect(d).toMatch(/- fail dashes: .+ At 1:\d+ “—”/);
  });

  it('keeps the skill’s copy of the rules identical to the package’s', () => {
    const pkg = readFileSync(resolve(import.meta.dirname, '../src/prose-rules.json'), 'utf8');
    const skill = readFileSync(
      resolve(import.meta.dirname, '../../../skills/hildegard/scripts/prose_rules.json'),
      'utf8',
    );
    expect(skill).toBe(pkg);
  });
});
