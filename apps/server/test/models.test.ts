import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Catalog, loadCatalog, type ModelLock } from '@hildegard/presets';
import { describe, expect, it } from 'vitest';
import { ModelManager } from '../src/models.ts';
import { fakeFetch } from './helpers.ts';

const { catalog: real } = loadCatalog();
const BYTES = Buffer.from('weights '.repeat(4096));
const SHA = createHash('sha256').update(BYTES).digest('hex');
const COMMIT = 'a'.repeat(40);

function setup(
  opts: {
    gated?: boolean;
    size?: number;
    lock?: ModelLock;
    status?: number;
    body?: Buffer;
    ignoreRange?: boolean;
    token?: string | null;
  } = {},
) {
  const base = real.models[0]!;
  const catalog: Catalog = {
    ...real,
    models: [
      {
        ...base,
        id: 'tiny',
        gated: !!opts.gated,
        loras: {},
        files: [
          {
            repo: 'org/tiny',
            path: 'vae/tiny.safetensors',
            dir: 'vae',
            size: opts.size ?? BYTES.length,
            gated: !!opts.gated,
          },
        ],
      },
    ],
  };
  const body = opts.body ?? BYTES;
  const fetch = fakeFetch([
    [
      'HEAD /org/tiny/resolve/',
      () =>
        opts.status
          ? new Response(null, { status: opts.status })
          : new Response(null, {
              status: 302,
              headers: {
                'x-repo-commit': COMMIT,
                'x-linked-etag': `"${SHA}"`,
                'x-linked-size': String(BYTES.length),
              },
            }),
    ],
    [
      'GET /org/tiny/resolve/',
      (_u, init) => {
        const range = (init.headers as Record<string, string>).range;
        const m = range && !opts.ignoreRange ? /bytes=(\d+)-/.exec(range) : null;
        if (m) return new Response(body.subarray(Number(m[1])), { status: 206 });
        return new Response(body, { status: 200 });
      },
    ],
  ]);
  const root = mkdtempSync(join(tmpdir(), 'hg-models-'));
  const events: unknown[] = [];
  const mm = new ModelManager({
    comfyDir: join(root, 'comfy'),
    dataDir: root,
    catalog,
    lock: opts.lock ?? { version: 1, files: {} },
    tokens: { accessToken: async () => (opts.token === undefined ? 'hf_token' : opts.token) },
    onChange: (s) => events.push(s),
    fetch,
  });
  const dest = join(root, 'comfy', 'models', 'vae', 'tiny.safetensors');
  return { mm, fetch, root, dest, events, file: catalog.models[0]!.files[0]! };
}

describe('ModelManager', () => {
  it('downloads, verifies against the published hash, and pins what it checked', async () => {
    const { mm, dest, root, events } = setup();
    expect(mm.states()[0]).toMatchObject({ installed: false, missingBytes: BYTES.length });
    await mm.install('tiny');
    expect(readFileSync(dest)).toEqual(BYTES);
    expect(mm.states()[0]).toMatchObject({
      installed: true,
      missingBytes: 0,
      error: null,
      downloading: null,
    });
    const rec = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'));
    expect(rec['org/tiny/vae/tiny.safetensors']).toEqual({
      revision: COMMIT,
      sha256: SHA,
      size: BYTES.length,
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('downloads the locked revision when models.lock.json pins one', async () => {
    const lock: ModelLock = {
      version: 1,
      files: {
        'org/tiny/vae/tiny.safetensors': { revision: 'b'.repeat(40), sha256: SHA, size: BYTES.length },
      },
    };
    const { mm, fetch } = setup({ lock });
    await mm.install('tiny');
    expect(fetch.calls.every((c) => c.url.includes(`/resolve/${'b'.repeat(40)}/`))).toBe(true);
    expect(mm.states()[0]!.installed).toBe(true);
  });

  it('resumes a partial download where it stopped', async () => {
    const { mm, dest, fetch } = setup();
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(`${dest}.part`, BYTES.subarray(0, 10_000));
    await mm.install('tiny');
    const get = fetch.calls.find((c) => c.method === 'GET')!;
    expect((get.init.headers as Record<string, string>).range).toBe('bytes=10000-');
    expect(readFileSync(dest)).toEqual(BYTES);
  });

  it('starts over when the server ignores the range', async () => {
    const { mm, dest } = setup({ ignoreRange: true });
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(`${dest}.part`, BYTES.subarray(0, 10_000));
    await mm.install('tiny');
    expect(readFileSync(dest)).toEqual(BYTES);
  });

  it('deletes a file that fails its checksum and says so', async () => {
    const bad = Buffer.from(BYTES);
    bad[5] = 0;
    const { mm, dest } = setup({ body: bad });
    await mm.install('tiny');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(mm.states()[0]).toMatchObject({ installed: false, error: expect.stringMatching(/checksum/) });
  });

  it('asks for a Hugging Face account for a gated model', async () => {
    const { mm } = setup({ gated: true, token: null });
    await mm.install('tiny');
    expect(mm.states()[0]!.error).toMatch(/Link one in Settings/);
  });

  it('asks to accept the license when Hugging Face refuses', async () => {
    const { mm } = setup({ gated: true, status: 403 });
    await mm.install('tiny');
    expect(mm.states()[0]!.error).toMatch(/Accept the license on huggingface.co\/org\/tiny/);
  });

  it('checks free space before downloading anything', async () => {
    const { mm, fetch } = setup({ size: 10 ** 15 });
    await mm.install('tiny');
    expect(mm.states()[0]!.error).toMatch(/is free\. Free up/);
    expect(fetch.calls).toHaveLength(0);
  });
});
