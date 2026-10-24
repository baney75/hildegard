// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Take } from '@hildegard/presets';
import { expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

async function until(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

it('a take rendering when Hildegard stops renders again after the next start, never canceled', async () => {
  const data = mkdtempSync(join(tmpdir(), 'hg-restart-'));
  const config = { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 };
  const first = await startServer(config, { fakeTickMs: 200, secrets: memoryStore() });
  await until(() => first.scheduler.engineState().online);
  const res = await fetch(`${first.url}/api/shots`, {
    method: 'POST',
    headers: { 'x-hildegard': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      request: {
        prompt: 'A lighthouse keeper climbs the spiral stairs at dusk',
        rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
        format: { quality: 'draft', seconds: 3 },
      },
    }),
  });
  const id = ((await res.json()) as { takes: Take[] }).takes[0]!.id;
  await until(() => first.store.takes.get(id)!.status === 'running');
  await first.close();
  expect(first.store.takes.get(id)!.status).not.toBe('canceled');

  const second = await startServer(config, { fakeTickMs: 25, secrets: memoryStore() });
  try {
    expect(['queued', 'running', 'done']).toContain(second.store.takes.get(id)!.status);
    await until(() => second.store.takes.get(id)!.status === 'done');
  } finally {
    await second.close();
  }
}, 30_000);
