// SPDX-License-Identifier: AGPL-3.0-only
// Not a test of its own (see cleanup.test.ts): a timeout while `hildegard start` is still running. The server it
// would start doesn't exist yet when the test's cleanup runs.
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { hildegardEnv } from '../harness.ts';

it('times out while a start is still going', async () => {
  const { LEAK_HOME: home, LEAK_DATA: data, LEAK_PORT: port } = process.env;
  // Slowed by five seconds, so it is still in flight when the cleanup runs and starts its server only after.
  const NODE_OPTIONS = `--require=${fileURLToPath(new URL('./delay.cjs', import.meta.url))}`;
  await hildegardEnv(home!, { NODE_OPTIONS }, 'start', '--port', port!, '--data', data!, '--fake-gpu');
}, 300);
