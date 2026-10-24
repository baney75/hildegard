// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Catalog, loadCatalog, loadSafety, type ModelLock, SafetyCheck } from '@hildegard/presets';
import type { Gpu } from '@hildegard/runtime';
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
    /** The repo was renamed: Hugging Face answers 307 to org/tiny-new. */
    renamed?: boolean;
    /** What Hugging Face's model page says about org/tiny. */
    tags?: string[];
    safety?: SafetyCheck;
    /** The hash Hugging Face publishes, when it isn't the file's. */
    etag?: string;
    /** The classifier is its own file, as in the real catalog, rather than the model's. */
    ownGuard?: boolean;
  } = {},
) {
  const base = real.models[0]!;
  const tiny = {
    repo: 'org/tiny',
    path: 'vae/tiny.safetensors',
    dir: 'vae' as const,
    size: opts.size ?? BYTES.length,
    gated: !!opts.gated,
  };
  const catalog: Catalog = {
    ...real,
    models: [{ ...base, id: 'tiny', gated: !!opts.gated, loras: {}, files: [tiny] }],
    // The classifier downloads with every model; here it is the model's own file, so each test fetches one file.
    safety: {
      ...real.safety,
      classifier: opts.ownGuard
        ? { ...tiny, path: 'safety/guard.safetensors', dir: 'safety' as const }
        : tiny,
    },
  };
  const body = opts.body ?? BYTES;
  const at = opts.renamed ? '/org/tiny-new/resolve/' : '/org/tiny/resolve/';
  type Route = Parameters<typeof fakeFetch>[0][number];
  const rename: Parameters<typeof fakeFetch>[0] = opts.renamed
    ? [
        [
          'HEAD /org/tiny/resolve/',
          (u) =>
            new Response(null, {
              status: 307,
              headers: { location: new URL(u).pathname.replace('/org/tiny/', '/org/tiny-new/') },
            }),
        ],
      ]
    : [];
  const fetch = fakeFetch([
    ...rename,
    ...(opts.tags
      ? [
          [
            'GET /api/models/org/tiny/',
            () => Response.json({ id: 'org/tiny', tags: opts.tags }),
          ] satisfies Route,
        ]
      : []),
    [
      `HEAD ${at}`,
      () =>
        opts.status
          ? new Response(null, { status: opts.status })
          : new Response(null, {
              status: 302,
              headers: {
                'x-repo-commit': COMMIT,
                'x-linked-etag': `"${opts.etag ?? SHA}"`,
                'x-linked-size': String(BYTES.length),
              },
            }),
    ],
    [
      `GET ${at}`,
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
    safety: opts.safety,
  });
  const dest = join(root, 'comfy', 'models', 'vae', 'tiny.safetensors');
  mm.acceptLicense('tiny');
  return { mm, fetch, root, dest, events, catalog, file: catalog.models[0]!.files[0]! };
}

describe('ModelManager', () => {
  it('will not download until the license is accepted, and asks again if the license changes', async () => {
    const { root, fetch, catalog } = setup();
    rmSync(join(root, 'licenses.json'));
    const make = (c: Catalog) =>
      new ModelManager({
        comfyDir: join(root, 'comfy'),
        dataDir: root,
        catalog: c,
        lock: { version: 1, files: {} },
        tokens: { accessToken: async () => null },
        onChange: () => {},
        fetch,
      });
    const mm = make(catalog);
    expect(mm.states()[0]!.licenseAccepted).toBe(false);
    await expect(mm.install('tiny')).rejects.toThrow(/Accept the/);
    expect(fetch.calls).toHaveLength(0);
    mm.acceptLicense('tiny');
    expect(mm.states()[0]!.licenseAccepted).toBe(true);
    expect(make(catalog).licenseAccepted('tiny')).toBe(true);
    const changed = { ...catalog, models: [{ ...catalog.models[0]!, license: 'Some New License' }] };
    expect(make(changed).licenseAccepted('tiny')).toBe(false);
  });

  it('says which models fit this computer, so the Studio can show it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hg-models-fit-'));
    const make = (gpu: Gpu | null) =>
      new ModelManager({
        comfyDir: join(root, 'comfy'),
        dataDir: root,
        catalog: real,
        lock: { version: 1, files: {} },
        tokens: { accessToken: async () => null },
        onChange: () => {},
        gpu,
      });
    const fits = (gpu: Gpu | null) =>
      Object.fromEntries(
        make(gpu)
          .states()
          .map((s) => [s.id, s.fit]),
      );
    // A 32 GB Apple silicon Mac: macOS lets the GPU use 24 GB of it.
    // None renders well on Apple's GPU yet, so none says it fits.
    expect(fits({ backend: 'mps', name: 'Apple M5', vramGb: 24, torchBackend: null })).toMatchObject({
      'ltx-2-5-distilled': 'no',
      'wan-2-2-ti2v-5b': 'no',
    });
    expect(fits(null)['wan-2-2-ti2v-5b']).toBeNull();
  });

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

  it('follows a renamed repo to its new name and still verifies the hash', async () => {
    const { mm, dest, fetch } = setup({ renamed: true });
    await mm.install('tiny');
    expect(readFileSync(dest)).toEqual(BYTES);
    expect(mm.states()[0]).toMatchObject({ installed: true, error: null });
    expect(fetch.calls.some((c) => c.method === 'GET' && c.url.includes('/org/tiny-new/resolve/'))).toBe(
      true,
    );
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
    const get = fetch.calls.find((c) => c.method === 'GET' && c.url.includes('/resolve/'))!;
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

  it('refuses a repo Hugging Face tags as not for all audiences, before downloading it', async () => {
    const { mm, fetch, dest } = setup({ tags: ['lora', 'not-for-all-audiences'] });
    await mm.install('tiny');
    expect(mm.states()[0]!.error).toMatch(/won’t install tiny\.safetensors.*not-for-all-audiences/);
    expect(fetch.calls.some((c) => c.method === 'GET' && c.url.includes('/resolve/'))).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a file whose hash is on the blocklist, before and after it downloads', async () => {
    const policy = loadSafety().policy;
    const blocked = new SafetyCheck({ ...policy, models: { ...policy.models, blockedSha256: [SHA] } });
    const a = setup({ safety: blocked });
    await a.mm.install('tiny');
    expect(a.mm.states()[0]!.error).toMatch(/known sexual model file/);
    expect(a.fetch.calls.some((c) => c.method === 'GET' && c.url.includes('/resolve/'))).toBe(false);
    // Hugging Face published another hash, but the bytes that came are a blocked file: deleted, never installed.
    const b = setup({ safety: blocked, etag: 'c'.repeat(64) });
    await b.mm.install('tiny');
    expect(b.mm.states()[0]!.error).toMatch(/known sexual model file/);
    expect(existsSync(b.dest)).toBe(false);
    expect(existsSync(`${b.dest}.part`)).toBe(false);
  });

  it('downloads the safety classifier with the first model', () => {
    const mm = new ModelManager({
      comfyDir: mkdtempSync(join(tmpdir(), 'hg-models-guard-')),
      dataDir: mkdtempSync(join(tmpdir(), 'hg-models-guard-')),
      catalog: real,
      lock: { version: 1, files: {} },
      tokens: { accessToken: async () => null },
      onChange: () => {},
    });
    for (const m of real.models)
      expect(mm.filesOf(m).map((f) => f.repo)).toContain('Falconsai/nsfw_image_detection');
    expect(mm.pathOf(real.safety.classifier)).toMatch(/models[/\\]safety[/\\]model\.safetensors$/);
  });

  it('after an upgrade, fetches only the safety classifier for a model that was already installed', async () => {
    const { mm, dest, root } = setup({ ownGuard: true });
    mkdirSync(join(root, 'comfy', 'models', 'vae'), { recursive: true });
    writeFileSync(dest, BYTES);
    expect(mm.states()[0]).toMatchObject({ installed: false, missingBytes: BYTES.length });
    await mm.completeSafety();
    expect(readFileSync(join(root, 'comfy', 'models', 'safety', 'guard.safetensors'))).toEqual(BYTES);
    expect(mm.states()[0]).toMatchObject({ installed: true, missingBytes: 0 });
  });

  it('fetches nothing for the safety check while no model is installed', async () => {
    const { mm, fetch, root } = setup({ ownGuard: true });
    await mm.completeSafety();
    expect(existsSync(join(root, 'comfy', 'models', 'safety'))).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });

  it('checks free space before downloading anything', async () => {
    const { mm, fetch } = setup({ size: 10 ** 15 });
    await mm.install('tiny');
    expect(mm.states()[0]!.error).toMatch(/is free\. Free up/);
    expect(fetch.calls).toHaveLength(0);
  });
});
