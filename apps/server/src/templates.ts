// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Website templates: whole, finished sites to start from, shipped in the hildegard-web skill so any AI app with the
 * skill has them too. Each is plain HTML and CSS with its system as CSS variables (light and dark), drawings instead of
 * stock photos, and real words for a made-up business; each passes every web check at every width, in CI. A template
 * says what its pictures should be, so an agent can render real ones on the owner's GPUs at the exact aspect.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resource } from '@hildegard/runtime';
import { z } from 'zod';

export const TemplateMeta = z.object({
  name: z.string().min(1).max(60),
  /** Who it suits, in a phrase. */
  for: z.string().min(3).max(200),
  description: z.string().min(10).max(600),
  /** The page's sections, top to bottom. */
  sections: z.array(z.string().min(1).max(60)).min(1).max(20),
  /** The pictures, and what to render in their place. */
  images: z
    .array(
      z.object({
        file: z.string().min(1).max(200),
        aspect: z.string().regex(/^\d+:\d+$/),
        prompt: z.string().min(10).max(600),
      }),
    )
    .max(20),
  /** The type the template is set in, as CSS font stacks. */
  type: z.object({ display: z.string().max(200), text: z.string().max(200) }),
});
export type TemplateMeta = z.infer<typeof TemplateMeta>;
export interface TemplateInfo extends TemplateMeta {
  id: string;
  pages: string[];
}

/** Where the templates are: beside the hildegard-web skill. */
export function templatesDir(): string | null {
  try {
    return resource(join('skills', 'hildegard-web', 'templates'));
  } catch {
    return null;
  }
}

const ID = /^[a-z][a-z0-9-]{1,40}$/;

export function listTemplates(dir = templatesDir()): TemplateInfo[] {
  if (!dir || !existsSync(dir)) return [];
  const out: TemplateInfo[] = [];
  for (const id of readdirSync(dir).sort()) {
    const meta = join(dir, id, 'template.json');
    if (!ID.test(id) || !existsSync(meta)) continue;
    const m = TemplateMeta.safeParse(JSON.parse(readFileSync(meta, 'utf8')));
    if (!m.success) continue;
    const files = templateFiles(id, dir);
    out.push({ id, ...m.data, pages: [...files.keys()].filter((f) => f.endsWith('.html')) });
  }
  return out;
}

/** A template's files, by path (its template.json left out). */
export function templateFiles(id: string, dir = templatesDir()): Map<string, Buffer> {
  if (!dir || !ID.test(id) || !existsSync(join(dir, id, 'template.json')))
    throw new Error(`There’s no template called ${id.slice(0, 40)}.`);
  const root = join(dir, id);
  const files = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size < 20 * 1024 * 1024) {
        const rel = relative(root, p).split(sep).join('/');
        if (rel !== 'template.json') files.set(rel, readFileSync(p));
      }
    }
  };
  walk(root);
  return files;
}
