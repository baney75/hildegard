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
