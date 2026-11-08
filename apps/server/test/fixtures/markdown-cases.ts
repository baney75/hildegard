// SPDX-License-Identifier: AGPL-3.0-only
// Hostile 500,000-character posts for the Markdown renderer: each is a way a pattern can backtrack or recurse.

const N = 500_000;
const rep = (unit: string, chars = N) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

export const CASES: Record<string, () => string> = {
  'backticks only': () => rep('`'),
  'backticks after a word': () => `a${rep('`', N - 1)}`,
  'backtick runs of growing length': () => {
    let s = 'a';
    for (let i = 1; s.length < N; i++) s += `${'`'.repeat(i)} `;
    return s.slice(0, N);
  },
  'a lone backtick, many times': () => rep('`a '),
  'asterisks only': () => rep('*'),
  'asterisks after a word': () => `a ${rep('*', N - 2)}`,
  'open emphasis, many times': () => rep('*a '),
  'open strong, many times': () => rep('** a '),
  'open underscores': () => rep('_a '),
  'open double underscores': () => rep('__a '),
  'open brackets': () => rep('['),
  'brackets after a word': () => `a${rep('[', N - 1)}`,
  'closing brackets and parens': () => rep(']('),
  'links that never close': () => rep('[a]('),
  'pictures that never close': () => rep('![a]('),
  'many brackets, one link': () => `${rep('[', N - 12)}a](http://x/)`,
  'open parens in an address': () => `[a](${rep('(', N - 4)}`,
  'a long run of spaces': () => `a${rep(' ', N - 2)}x`,
  'a long run of spaces before a line break': () => `a${rep(' ', N - 2)}\nb`,
  'a heading with a long run of spaces': () => `# a${rep(' ', N - 4)}x`,
  'headings with a line separator': () => rep('# a\u2028b\n'),
  'headings ending in a paragraph separator': () => rep('# a\u2029\n'),
  'a fence line with a long run of spaces': () => `\`\`\`${rep(' ', N - 4)}!`,
  'quotes nested deeper than any post': () => rep('>'),
  'quotes, one per line': () => rep('> ', N),
  'lists nested deeper than any post': () =>
    Array.from({ length: 900 }, (_, i) => `${' '.repeat(i)}- a`).join('\n'),
};
