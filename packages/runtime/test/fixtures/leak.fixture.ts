// SPDX-License-Identifier: AGPL-3.0-only
// Not a test of its own (see cleanup.test.ts): the crash test's shape. A script starts the stand-in ComfyUI and then
// hangs, its parent gives up on it, and the test fails before it can assert anything about the processes.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { fakeInstall } from '../fake-install.ts';

it('starts ComfyUI, loses its parent script to a timeout, and fails', () => {
  const dir = fakeInstall();
  writeFileSync(process.env.LEAK_OUT!, dir);
  const script = join(dir, 'hang.mjs');
  const entry = resolve(import.meta.dirname, '../../src/index.ts');
  writeFileSync(
    script,
    `import { ComfyRuntime } from ${JSON.stringify(entry)};
const r = new ComfyRuntime({ dataDir: process.argv[2] });
await r.start();
console.log(JSON.stringify(r.pids()));
setInterval(() => {}, 1000);
`,
  );
  // As the crash test does, but the script never ends: the timeout kills it, and its children are not told.
  const out = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 4000 });
  // ComfyUI really was up (the script printed its processes' numbers) before the script was lost.
  expect(out.stdout).toMatch(/^\[\d+,\d+\]$/m);
  expect(out.status).toBe(0);
});
