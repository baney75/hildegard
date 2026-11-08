// SPDX-License-Identifier: AGPL-3.0-only
// The prose lint as it stood at a git ref, for before-and-after comparisons.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProseLint } from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');

export async function engineAt(ref: string): Promise<{ lintProse: (t: string) => ProseLint; py: string }> {
  const dir = join(mkdtempSync(join(tmpdir(), 'prose-engine-')), 'engine');
  mkdirSync(dir);
  const show = (path: string, to: string) =>
    writeFileSync(
      join(dir, to),
      execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'buffer', maxBuffer: 1 << 26 }),
    );
  show('packages/craft/src/prose.ts', 'prose.ts');
  show('packages/craft/src/prose-rules.json', 'prose-rules.json');
  show('skills/hildegard/scripts/prose_lint.py', 'prose_lint.py');
  show('skills/hildegard/scripts/prose_rules.json', 'prose_rules.json');
  return {
    lintProse: (await import(pathToFileURL(join(dir, 'prose.ts')).href)).lintProse,
    py: join(dir, 'prose_lint.py'),
  };
}
