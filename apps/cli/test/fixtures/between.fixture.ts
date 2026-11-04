// SPDX-License-Identifier: AGPL-3.0-only
// Not a test of its own (see cleanup.test.ts): the first test starts a server and fails; the second, which runs
// before the file ends, passes only if the first one's server was stopped as soon as that test was over.
import { expect, it } from 'vitest';
import { hildegard } from '../harness.ts';

const { LEAK_HOME: home, LEAK_DATA: data, LEAK_PORT: port } = process.env;

it('starts a server and fails', async () => {
  expect((await hildegard(home!, 'start', '--port', port!, '--data', data!, '--fake-gpu')).ok).toBe(true);
  expect('the first test fails here').toBe('before its stop');
});

it('finds that server gone', async () => {
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
});
