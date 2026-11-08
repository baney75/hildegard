// SPDX-License-Identifier: AGPL-3.0-only
// What the bench corpora may and may not contain. The numbers they back (a lint that "fails no real person's writing")
// only mean something if the human pieces predate models, and the AI drafts are no one's but a model's.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const corpus = resolve(import.meta.dirname, '../bench/corpus');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );

describe('bench corpus', () => {
  it('has no human piece dated 2021 or later, and only the 18F site pages undated', () => {
    const manifest = JSON.parse(readFileSync(join(corpus, 'human/manifest.json'), 'utf8')) as Array<{
      id: string;
      date: string;
    }>;
    expect(manifest.length).toBeGreaterThan(200);
    const dated = manifest.filter((m) => m.date !== 'undated');
    const late = dated.filter((m) => !/^(1[89]\d\d|20[01]\d|2020)(-|$)/.test(m.date));
    expect(late.map((m) => `${m.id} ${m.date}`)).toEqual([]);
    // They have no date in their files, and the docs say so: 30 pages, a stand-in for small-business pages.
    const undated = manifest.filter((m) => m.date === 'undated');
    expect(undated.length).toBe(30);
    expect(undated.every((m) => m.id.startsWith('18f-pages-'))).toBe(true);
  });

  it('names no one: the owner’s name and email are in no piece', () => {
    const all = files(corpus);
    expect(all.length).toBeGreaterThan(300);
    const leaks = all.filter((f) => /baney|donovan/i.test(readFileSync(f, 'utf8')));
    expect(leaks.map((f) => f.slice(corpus.length + 1))).toEqual([]);
  });
});
