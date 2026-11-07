// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonProse, describeProseLint, lintProse } from '../src/index.ts';
import { countWords, countWordsRegex, needleOf, phraseHits, phraseHitsNaive } from '../src/prose.ts';
import RULES from '../src/prose-rules.json' with { type: 'json' };
import FIXTURES from './prose-fixtures.json' with { type: 'json' };

interface Case {
  name: string;
  text: string;
  fails?: string[];
  warns?: string[];
  clean?: boolean;
  ok?: boolean;
  /** Lint with the strict profile. */
  strict?: boolean;
  /** The first place a finding reports, exactly as written in the text. */
  reports?: Record<string, string>;
}

interface Attack {
  name: string;
  head: string;
  unit: string;
  times: number;
  tail: string;
}

/** For each warn the strict profile fails: a text that trips that warn and nothing that fails by default. */
const STRICT_PROBES: Record<string, string> = {
  'em-dash': 'We planted the beans in May—the soil was still cold.',
  'corporate-words': 'We leverage the van, utilize the shed and streamline the route.',
  cliches: 'At the end of the day, it works. When it comes to bees, water matters.',
  metadiscourse: 'Simply put, the bees need water.',
  weasel: 'Experts agree that bees need water.',
  'loaded-words': 'Crucial care helps. Vibrant hives foster growth.',
  'summary-openers': 'In summary, the bees need water.',
  'filler-adverbs': 'Honestly, the bees really truly need water.',
  'warm-boilerplate': 'We are so grateful to the crew. Thank you for your support.',
  'not-but': 'It is not about honey, but about bees.',
  'colon-reveal': 'The secret: always add water.',
  'summary-ending': 'Bees need water.\n\nThey need shade.\n\nOverall, keep them cool.',
  triads: 'We sell honey, wax, and soap. '.repeat(40),
  'bold-leads':
    '**Water.** Bees need it.\n\n**Shade.** Bees need it.\n\n**Sugar.** Bees need it.\n\n**Quiet.** Bees need it.',
  'bold-list-leads': '- **When:** Saturday\n- **Where:** The barn',
  'uniform-paragraphs': 'Bees need water.\n\n'.repeat(6),
  bold: 'Bees need **water** and **shade** daily.',
};
const RULE_IDS = new Set([...Object.keys(RULES.phrases), ...Object.keys(STRICT_PROBES)]);

describe('prose lint', () => {
  for (const c of FIXTURES.cases as Case[]) {
    it(c.name, () => {
      const l = lintProse(c.text, { strict: c.strict });
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
      for (const [id, at] of Object.entries(c.reports ?? {}))
        expect(l.findings.find((f) => f.id === id)?.matches[0]?.text).toBe(at);
    });
  }

  describe('the em dash', () => {
    const dashed = 'We planted the beans in May\u2014the soil was still cold.';
    const em = (t: string, strict = false) =>
      lintProse(t, { strict }).findings.find((f) => f.id === 'em-dash');

    it('warns in the default profile and says what to do instead', () => {
      const f = em(dashed)!;
      expect(f.severity).toBe('warn');
      expect(f.why).toMatch(/machine tell/);
      expect(f.fix).toMatch(/comma, a colon, parentheses or two sentences/);
      expect(lintProse(dashed).ok).toBe(true);
    });

    it('points at each dash, in the text as given', () => {
      const text = 'One\u2014two.\nThree -- four \u2014 five.';
      expect(em(text)!.matches).toEqual([
        { text: '\u2014', index: 3, line: 1, column: 4 },
        { text: '--', index: 15, line: 2, column: 7 },
        { text: '\u2014', index: 23, line: 2, column: 15 },
      ]);
    });

    it('is never found in a hyphen, an en dash, a range or a flag', () => {
      for (const t of [
        'A well-known mother-in-law.',
        'Pages 10\u201312 and 2020-2024.',
        'Run it with --max 3 or --json.',
        '---\n\nA line.\n\n---',
        'Use two--no, three.',
      ])
        expect(em(t), t).toBeUndefined();
    });

    it('fails nothing a person wrote, however many dashes, and is not a weak tell that stacks', () => {
      const many = Array.from({ length: 12 }, (_, i) => `Item ${i}\u2014a plain note.`).join(' ');
      expect(lintProse(many).ok).toBe(true);
      const withTell = lintProse(`${many} Simply put, it works.`);
      const ids = withTell.findings.map((f) => f.id);
      expect(ids).toContain('em-dash');
      expect(ids).toContain('metadiscourse');
      expect(ids).not.toContain('stacked-tells');
      expect(withTell.ok).toBe(true);
    });

    it('fails in the strict profile, and only there', () => {
      expect(em(dashed, true)!.severity).toBe('fail');
      expect(lintProse(dashed, { strict: true }).ok).toBe(false);
      expect(lintProse(dashed, { strict: false }).ok).toBe(true);
      expect(lintProse(dashed).ok).toBe(true);
    });
  });

  describe('the strict profile', () => {
    it('fails every warn it lists, leaves headings a warn, and changes nothing else', () => {
      // Every rule in strict.fail has a probe here, so a rule added to the list must be added to the test.
      expect(Object.keys(STRICT_PROBES).sort()).toEqual([...RULES.strict.fail].sort());
      const warnsOnly = Object.keys(STRICT_PROBES);
      for (const id of warnsOnly) {
        const text = STRICT_PROBES[id]!;
        const base = lintProse(text);
        const strict = lintProse(text, { strict: true });
        expect(base.findings.find((f) => f.id === id)?.severity, `${id} default`).toBe('warn');
        expect(strict.findings.find((f) => f.id === id)?.severity, `${id} strict`).toBe('fail');
        expect(strict.ok, id).toBe(false);
        // Same findings, same places: only the severity moves.
        expect(strict.findings.map((f) => [f.id, f.matches])).toEqual(
          base.findings.map((f) => [f.id, f.matches]),
        );
      }
    });

    it('lists only rules that exist, and never a fail or the headings rule', () => {
      const strictIds = new Set(RULES.strict.fail);
      expect(strictIds.has('headings')).toBe(false);
      expect(strictIds.has('stacked-tells')).toBe(false);
      for (const id of strictIds) expect(RULE_IDS.has(id), id).toBe(true);
      for (const id of strictIds)
        if (id in RULES.phrases) expect(RULES.phrases[id as 'cliches']!.severity, id).toBe('warn');
    });

    it('fails nothing that is clean', () => {
      expect(
        lintProse('The bees need water in July. A pan of stones will do.', { strict: true }),
      ).toMatchObject({
        ok: true,
        findings: [],
      });
    });
  });

  it('points at each tell where it is in the text as given', () => {
    const text = 'Line one is fine.\nWe will delve into it.';
    const f = lintProse(text).findings.find((x) => x.id === 'stock-words')!;
    expect(f.matches[0]).toMatchObject({ text: 'delve', line: 2, column: 9 });
    expect(text.slice(f.matches[0]!.index, f.matches[0]!.index + 5)).toBe('delve');
  });

  it('lints the largest text the server takes in well under a second, even made of nothing but tells', () => {
    for (const unit of ['delve ', 'TODO a\n']) {
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
    const d = describeProseLint(lintProse('We delve into it. TODO fast.'));
    expect(d).toMatch(/^Fails: 2 tells to fix/);
    expect(d).toMatch(/- fail unfinished: .+ At 1:\d+ “TODO”/);
  });

  it('tells an agent which lint fails bind: everyday prose yes, craft and academic work no', () => {
    const skill = readFileSync(resolve(import.meta.dirname, '../../../skills/hildegard/SKILL.md'), 'utf8');
    const step = skill.split('\n').find((l) => l.startsWith('**Writing:** lint every draft'))!;
    expect(step).toMatch(/everyday prose \([^)]*references\/blog\.md`\), every fail must be fixed/);
    expect(step).toMatch(
      /fiction, poetry, scripts, prayer and speech \([^)]*writing-craft\.md`\) and academic work \([^)]*nonfiction-academic\.md`\), treat every finding, fails included, as a warning/,
    );
    expect(step).toMatch(/say which you kept/);
    // The five-things rule gives way to the blog interview's fast path.
    const five = skill.split('\n').find((l) => l.includes('at least five concrete things'))!;
    expect(five).toMatch(/asks for speed.*fast path in `references\/blog\.md`/);
  });

  it('keeps the skill’s copy of the rules identical to the package’s', () => {
    const pkg = readFileSync(resolve(import.meta.dirname, '../src/prose-rules.json'), 'utf8');
    const skill = readFileSync(
      resolve(import.meta.dirname, '../../../skills/hildegard/scripts/prose_rules.json'),
      'utf8',
    );
    expect(skill).toBe(pkg);
  });

  it('counts words as the regex does, for every kind of character', () => {
    const samples = [
      '',
      ' ',
      "it's a well-known x--y ’tis 'quoted' -- -a a- 2nd ² ½ ① é日本語 😀 𝒜 \ud800 a\udc00b",
      "a-b c’d e'f",
      '---',
      "'a",
      'x2y',
      'ǅ ǆ',
      'ⅷ',
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = [..."abcXYZ09 \n\t'’-—,.é日😀𝒜²½ǅ\ud800\udc00_"];
    for (let k = 0; k < 2000; k++) {
      let t = '';
      for (let i = Math.floor(rnd() * 60); i > 0; i--) t += alphabet[Math.floor(rnd() * alphabet.length)];
      samples.push(t);
    }
    for (const t of samples) expect(countWords(t), JSON.stringify(t)).toBe(countWordsRegex(t));
  });

  it('opens each phrase pattern on the letters every match must start with', () => {
    expect(needleOf('delve')).toBe('delve');
    expect(needleOf('delves?')).toBe('delve');
    expect(needleOf("it['’]?s worth noting( that)?")).toBe('it');
    expect(needleOf('meticulous(ly)?')).toBe('meticulous');
    expect(needleOf('game[- ]changer')).toBe('game');
    expect(needleOf('(sets|set) the stage for')).toBe('');
    expect(needleOf('delve|tapestry')).toBe('');
    expect(needleOf('a (b|c)|d')).toBe('');
    expect(needleOf('Stands as a TESTAMENT')).toBe('stands as a testament');
  });

  it('finds phrases the way scanning each pattern over the whole text does, even where lowercasing changes the text', () => {
    const shape = (hits: RegExpExecArray[][]) => hits.map((h) => h.map((m) => [m.index, m[0]]));
    for (const t of [
      'Kelvin \u212Adelve it. DELVE. Delve—delve, x-delve, delved, delves.',
      'İstanbul will delve into the realm, and we’re grateful to İ. It’s worth noting that it is IMPORTANT TO NOTE.',
      'Unlock the full potential, unlock the door. Whether you’re a baker or a brewer, we look forward to seeing you.',
      'ǅ delve ǅ tapestry ǅ',
      'delvedelve delve-delve delve_delve',
    ])
      expect(shape(phraseHits(t)), t).toEqual(shape(phraseHitsNaive(t)));
  });
});
