// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { holdsLinks, layout, uvEnv } from '../src/install.ts';

describe('uvEnv', () => {
  it('keeps uv’s cache and Python in Hildegard’s folder on a drive that holds links', () => {
    const L = layout(mkdtempSync(join(tmpdir(), 'hildegard-uv-')));
    expect(holdsLinks(L.tools)).toBe(true);
    // The probe leaves nothing behind.
    expect(readdirSync(L.tools)).toEqual([]);
    expect(uvEnv(L)).toEqual({
      UV_CACHE_DIR: join(L.dataDir, 'cache', 'uv'),
      UV_PYTHON_INSTALL_DIR: join(L.tools, 'python'),
    });
  });
});
