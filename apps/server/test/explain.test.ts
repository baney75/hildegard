// SPDX-License-Identifier: AGPL-3.0-only
import { EngineError } from '@hildegard/comfy';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/scheduler.ts';

describe('explain: what to do about a failed take', () => {
  it('suggests Draft for running out of GPU memory only when the take isn’t Draft already', () => {
    const oom = () => new EngineError('out_of_memory', 'The GPU ran out of memory.');
    expect(explain(oom(), 'final').hint).toMatch(/Try Draft quality/);
    expect(explain(oom(), null).hint).toMatch(/Try Draft quality/);
    const draft = explain(oom(), 'draft').hint;
    expect(draft).not.toMatch(/Draft/);
    expect(draft).toMatch(/shorter take/);
  });
});
