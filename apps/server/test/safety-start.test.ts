// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Catalog, loadCatalog } from '@hildegard/presets';
import { expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { fakeFetch, memoryStore } from './helpers.ts';

const BYTES = Buffer.from('weights '.repeat(4096));
const SHA = createHash('sha256').update(BYTES).digest('hex');

async function until(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** An upgrade from 0.1.2: a model installed, its license accepted, and the safety classifier never fetched. */
function upgraded() {
  const loaded = loadCatalog();
  const base = loaded.catalog.models[0]!;
  const tiny = {
    repo: 'org/tiny',
    path: 'vae/tiny.safetensors',
    dir: 'vae' as const,
    size: BYTES.length,
    gated: false,
  };
  const guard = { ...tiny, path: 'safety/guard.safetensors', dir: 'safety' as const };
  const catalog: Catalog = {
    ...loaded.catalog,
    models: [{ ...base, id: 'tiny', gated: false, loras: {}, files: [tiny] }],
    safety: { ...loaded.catalog.safety, classifier: guard },
  };
  const data = mkdtempSync(join(tmpdir(), 'hg-safety-start-'));
  mkdirSync(join(data, 'comfyui', 'models', 'vae'), { recursive: true });
  writeFileSync(join(data, 'comfyui', 'models', 'vae', 'tiny.safetensors'), BYTES);
  writeFileSync(
    join(data, 'licenses.json'),
    JSON.stringify({
      tiny: { license: base.license, licenseUrl: base.licenseUrl, acceptedAt: new Date().toISOString() },
    }),
  );
  const config = { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 };
  return { loaded: { ...loaded, catalog, lock: { version: 1 as const, files: {} } }, config, data };
}

it('starts when the safety classifier is missing, then fetches it in the background', async () => {
  const { loaded, config, data } = upgraded();
  const modelFetch = fakeFetch([
    [
      'HEAD /org/tiny/resolve/',
      () =>
        new Response(null, {
          status: 302,
          headers: {
            'x-repo-commit': 'a'.repeat(40),
            'x-linked-etag': `"${SHA}"`,
            'x-linked-size': String(BYTES.length),
          },
        }),
    ],
    ['GET /org/tiny/resolve/', () => new Response(BYTES, { status: 200 })],
  ]);
  const s = await startServer(config, { loaded, secrets: memoryStore(), modelFetch });
  try {
    expect(await (await fetch(`${s.url}/api/health`)).json()).toMatchObject({ ok: true });
    const guard = join(data, 'comfyui', 'models', 'safety', 'guard.safetensors');
    await until(() => {
      try {
        return readFileSync(guard).equals(BYTES);
      } catch {
        return false;
      }
    });
  } finally {
    await s.close();
  }
});

it('keeps running when fetching the classifier fails', async () => {
  const { loaded, config } = upgraded();
  const modelFetch = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const s = await startServer(config, { loaded, secrets: memoryStore(), modelFetch });
  try {
    await new Promise((r) => setTimeout(r, 300));
    expect(await (await fetch(`${s.url}/api/health`)).json()).toMatchObject({ ok: true });
  } finally {
    await s.close();
  }
});
