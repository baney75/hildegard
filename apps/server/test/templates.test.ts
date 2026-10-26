// SPDX-License-Identifier: AGPL-3.0-only
// Every website template is whole and passes every web check, in light and dark, at every width: a template that
// fails its own checks would teach every site made from it the same mistake.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findChrome } from '../src/browser.ts';
import { listTemplates, templateFiles, templatesDir } from '../src/templates.ts';
import { webReviewer } from '../src/web-review.ts';

const dir = templatesDir()!;
const ids = readdirSync(dir).filter((d) => !d.startsWith('.'));

describe('website templates', () => {
  it('lists every template, each with its pages and pictures', () => {
    const list = listTemplates(dir);
    expect(list.map((t) => t.id)).toEqual([...ids].sort());
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const t of list) {
      const files = templateFiles(t.id, dir);
      expect(t.pages, t.id).toContain('index.html');
      expect(files.has('styles.css'), t.id).toBe(true);
      for (const img of t.images) expect(files.has(img.file), `${t.id} ${img.file}`).toBe(true);
      for (const [file, bytes] of files)
        if (/\.(html|css|svg)$/.test(file))
          expect(bytes.toString('utf8'), `${t.id}/${file} license`).toContain('Apache-2.0');
    }
  });

  it.runIf(findChrome() || process.env.CI).each(ids)(
    '%s passes every check, light and dark',
    { timeout: 180_000 },
    async (id) => {
      const review = webReviewer(findChrome())!;
      const r = await review({ dir: join(dir, id), pages: ['index.html'], final: true, dark: true });
      const bad = r.checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}: ${c.detail}`);
      expect(bad).toEqual([]);
      expect(r.passed).toBe(true);
    },
  );
});
