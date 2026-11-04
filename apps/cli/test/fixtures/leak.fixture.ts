// SPDX-License-Identifier: AGPL-3.0-only
// Not a test of its own (see cleanup.test.ts): starts a server as the CLI tests do, then fails before its own stop.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hildegard } from '../harness.ts';

it('starts a server and fails before it stops it', async () => {
  const { LEAK_DATA: data, LEAK_PORT: port } = process.env;
  const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
  expect((await hildegard(home, 'start', '--port', port!, '--data', data!, '--fake-gpu')).ok).toBe(true);
  expect('the test fails here').toBe('before its stop');
  await hildegard(home, 'stop', '--data', data!);
});
