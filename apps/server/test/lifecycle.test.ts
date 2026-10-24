// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const lifecycle = fileURLToPath(new URL('../src/lifecycle.ts', import.meta.url));

/** A process that guards itself the way the server does, then idles until it's stopped. */
function guarded() {
  const code = `import { guardProcess } from ${JSON.stringify(lifecycle)};
guardProcess(() => process.exit(0));
setInterval(() => {}, 1000);
console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (b) => (err += b));
  const ready = new Promise<void>((r) => child.stdout.once('data', () => r()));
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  return { child, ready, exited, err: () => err };
}

describe.skipIf(process.platform === 'win32')('guardProcess', () => {
  it('survives a hang-up and says why it stops', async () => {
    const p = guarded();
    await p.ready;
    p.child.kill('SIGHUP');
    await new Promise((r) => setTimeout(r, 300));
    expect(p.child.exitCode).toBeNull();
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    expect(p.err()).toMatch(/Ignored SIGHUP/);
    expect(p.err()).toMatch(/Stopping: got SIGTERM/);
    expect(p.err()).toMatch(/Exited with code 0/);
  });
});
