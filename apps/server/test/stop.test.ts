// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));

it('exits promptly on stop while a Studio tab holds the event stream open', async () => {
  const data = mkdtempSync(join(tmpdir(), 'hg-stop-'));
  const child = spawn(process.execPath, [main, '--fake-gpu', '--port', '0', '--data', data], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (b: Buffer) => {
        out += b;
        const m = /running at (http:\/\/\S+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      child.once('exit', () => reject(new Error(`The server exited early: ${out}`)));
    });
    // A tab's live connection: the event stream, read up to its first message and left open.
    const events = await fetch(`${url}/api/events`);
    await events.body!.getReader().read();

    const res = await fetch(`${url}/api/system/stop`, { method: 'POST', headers: { 'x-hildegard': '1' } });
    expect(res.status).toBe(200);
    const code = await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5000))]);
    expect(code).toBe(0);
  } finally {
    child.kill();
  }
}, 20_000);
