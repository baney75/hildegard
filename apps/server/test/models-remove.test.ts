// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Catalog, loadCatalog, type ModelFile } from '@hildegard/presets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const { catalog: real } = loadCatalog();
const file = (path: string, dir: ModelFile['dir']): ModelFile => ({
  repo: 'org/pack',
  path,
  dir,
  size: 10,
  gated: false,
});
const own = (name: string) => file(`${name}.safetensors`, 'diffusion_models');
const textEncoder = file('te.safetensors', 'text_encoders');
const vae = file('vae.safetensors', 'vae');
const guard = file('guard.safetensors', 'safety');

/**
 * Three models: a and b share a text encoder, a and c share a VAE, and every model passes the safety classifier.
 * c is never installed, so the VAE is one only a needs.
 */
const catalog: Catalog = {
  ...real,
  models: [
    { ...real.models[0]!, id: 'a', loras: {}, files: [own('a'), textEncoder, vae] },
    { ...real.models[0]!, id: 'b', loras: {}, files: [own('b'), textEncoder] },
    { ...real.models[0]!, id: 'c', loras: {}, files: [own('c'), vae] },
  ],
  safety: { ...real.safety, classifier: guard },
};

let srv: Running;
let comfy: string;
const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const remove = (id: string, body: unknown = {}) =>
  fetch(`${srv.url}/api/models/${id}/remove`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const at = (f: ModelFile) => join(comfy, 'models', f.dir, f.path);
const put = (...files: ModelFile[]) =>
  files.forEach((f) => {
    mkdirSync(dirname(at(f)), { recursive: true });
    writeFileSync(at(f), 'weights');
  });
/** What is still on disk, by name. */
const left = () =>
  [own('a'), own('b'), own('c'), textEncoder, vae, guard].filter((f) => existsSync(at(f))).map((f) => f.path);

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-models-remove-'));
  comfy = join(dir, 'comfyui');
  // a and b are installed, c is not.
  put(own('a'), own('b'), textEncoder, vae, guard);
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir, '--comfy-dir', comfy]), port: 0, hfClientId: null },
    { fakeTickMs: 25, secrets: memoryStore(), loaded: { catalog, lock: { version: 1, files: {} } } },
  );
});
afterEach(() => srv.close());

describe('removing a model', () => {
  it('deletes its own files, keeps the shared ones, and says which shared files nothing uses now', async () => {
    const res = await remove('a');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      removed: string[];
      shared: Array<{ file: string; neededBy: string[] }>;
    };
    expect(body.removed).toEqual(['diffusion_models/a.safetensors']);
    // The text encoder and the classifier are b's too; the VAE only a (installed) used.
    expect(Object.fromEntries(body.shared.map((f) => [f.file, f.neededBy]))).toEqual({
      'text_encoders/te.safetensors': ['b'],
      'vae/vae.safetensors': [],
      'safety/guard.safetensors': ['b'],
    });
    expect(left()).toEqual(['b.safetensors', 'te.safetensors', 'vae.safetensors', 'guard.safetensors']);
  });

  it('with unused, also frees the shared files no kept model needs, and only those', async () => {
    const body = (await (await remove('a', { withUnused: true })).json()) as {
      removed: string[];
      freedBytes: number;
    };
    expect(body.removed.sort()).toEqual(['diffusion_models/a.safetensors', 'vae/vae.safetensors']);
    expect(body.freedBytes).toBe(14);
    expect(left()).toEqual(['b.safetensors', 'te.safetensors', 'guard.safetensors']);
    // The last installed model takes the rest: nothing else needs the text encoder or the classifier.
    const last = (await (await remove('b', { withUnused: true })).json()) as { removed: string[] };
    expect(last.removed.sort()).toEqual([
      'diffusion_models/b.safetensors',
      'safety/guard.safetensors',
      'text_encoders/te.safetensors',
    ]);
    expect(left()).toEqual([]);
  });

  it('keeps a shared file while a model that is still downloading needs it', async () => {
    // c's download is in progress: its VAE is needed even though c is not installed yet.
    const hold = new AbortController();
    (srv.models as unknown as { jobs: Map<string, unknown> }).jobs.set('c', {
      abort: hold,
      done: 0,
      total: 1,
      file: 'x',
      bytesPerSec: 0,
    });
    const body = (await (await remove('a', { withUnused: true })).json()) as { removed: string[] };
    expect(body.removed).toEqual(['diffusion_models/a.safetensors']);
    expect(existsSync(at(vae))).toBe(true);
  });

  it('can be previewed with dryRun, which deletes nothing', async () => {
    const before = left();
    const body = (await (await remove('a', { withUnused: true, dryRun: true })).json()) as {
      removed: string[];
      dryRun: boolean;
    };
    expect(body.dryRun).toBe(true);
    expect(body.removed.sort()).toEqual(['diffusion_models/a.safetensors', 'vae/vae.safetensors']);
    expect(left()).toEqual(before);
  });

  it('is repeatable: a removed model’s leftover shared files can still be freed afterwards', async () => {
    await remove('a');
    expect(existsSync(at(vae))).toBe(true);
    const again = (await (await remove('a', { withUnused: true })).json()) as { removed: string[] };
    expect(again.removed).toEqual(['vae/vae.safetensors']);
    expect(existsSync(at(textEncoder))).toBe(true);
  });

  it('refuses an unknown model, and a removal while Hildegard renders', async () => {
    expect((await remove('nope')).status).toBe(404);
    const release = await srv.scheduler.lease();
    try {
      const busy = await remove('a');
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ code: 'busy' });
      expect(left()).toContain('a.safetensors');
      // Looking is always fine.
      expect((await remove('a', { dryRun: true })).status).toBe(200);
    } finally {
      release();
    }
  });
});
