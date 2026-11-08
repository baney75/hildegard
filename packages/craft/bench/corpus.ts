// SPDX-License-Identifier: AGPL-3.0-only
// The prose lint bench's corpora: human writing, AI drafts with no skill, and (apart) drafts made with the skill.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Piece {
  id: string;
  group: 'human' | 'ai' | 'skill';
  /** For AI drafts, the model; for human pieces, the source. */
  from: string;
  genre: string;
  /**
   * `test` pieces are never read one by one while rules are tuned. `holdout` pieces are not measured at all until the rules
   * are final.
   */
  split: 'dev' | 'test' | 'holdout';
  text: string;
  /** AI drafts: from a brief with the writer's facts, or from the topic alone. */
  kind?: 'facts' | 'generic';
  /** Not in git: read from the owner's cache when it exists. */
  cached: boolean;
}

const here = import.meta.dirname;
export const corpusDir = join(here, 'corpus');

export function loadCommitted(): Piece[] {
  const out: Piece[] = [];
  const human = JSON.parse(readFileSync(join(corpusDir, 'human/manifest.json'), 'utf8')) as Array<{
    id: string;
    genre: string;
    split: 'dev' | 'test' | 'holdout';
  }>;
  for (const m of human)
    out.push({
      id: m.id,
      group: 'human',
      from: m.id.replace(/-\d+$/, ''),
      genre: m.genre,
      split: m.split,
      text: readFileSync(join(corpusDir, 'human', `${m.id}.md`), 'utf8'),
      cached: false,
    });
  const briefs = JSON.parse(readFileSync(join(corpusDir, 'ai/briefs.json'), 'utf8')) as Array<{
    id: string;
    genre: string;
    split: 'dev' | 'test' | 'holdout';
  }>;
  for (const model of readdirSync(join(corpusDir, 'ai')).sort()) {
    if (!existsSync(join(corpusDir, 'ai', model, `${briefs[0]!.id}.md`))) continue;
    for (const b of briefs)
      for (const kind of ['facts', 'generic'] as const) {
        const f = join(corpusDir, 'ai', model, `${b.id}${kind === 'generic' ? '-generic' : ''}.md`);
        if (!existsSync(f)) continue;
        out.push({
          id: `${model}/${b.id}${kind === 'generic' ? '-generic' : ''}`,
          group: 'ai',
          from: model,
          genre: b.genre,
          split: b.split,
          kind,
          text: readFileSync(f, 'utf8'),
          cached: false,
        });
      }
  }
  return out;
}

/** Drafts the owner already has on disk: more no-skill AI writing, and drafts made with the skill. */
export function loadCached(): Piece[] {
  const out: Piece[] = [];
  const runs = join(homedir(), '.cache/hildegard-creative-eval/runs');
  for (const variant of existsSync(runs) ? readdirSync(runs) : [])
    for (const model of readdirSync(join(runs, variant))) {
      const dir = join(runs, variant, model);
      for (const task of readdirSync(dir).filter((t) => /^w\d/.test(t))) {
        const f = join(dir, task, 'draft-nofront.md');
        if (!existsSync(f)) continue;
        out.push({
          id: `creative-eval/${variant}/${model}/${task}`,
          group: variant === 'none' ? 'ai' : 'skill',
          from: `${model}-${variant}`,
          genre: 'blog',
          split: 'dev',
          text: readFileSync(f, 'utf8'),
          cached: true,
        });
      }
    }
  const wr = join(homedir(), '.cache/hildegard-writing-eval');
  for (const v of ['old', 'new'])
    if (existsSync(join(wr, v)))
      for (const f of readdirSync(join(wr, v)).filter((n) => n.endsWith('.md')))
        out.push({
          id: `writing-eval/${v}/${f}`,
          group: 'skill',
          from: `sonnet-${v}`,
          genre: 'blog',
          split: 'dev',
          text: readFileSync(join(wr, v, f), 'utf8'),
          cached: true,
        });
  return out;
}
