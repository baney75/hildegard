// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Character, Snapshot, Still } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventFilter, seesStill, snapshotFor, type Who } from '../src/access.ts';
import { parseArgs } from '../src/config.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

let srv: Running;
let dir: string;
const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const api = (path: string, init: RequestInit = {}) => fetch(srv.url + path, init);
const post = (path: string, body?: unknown) =>
  api(path, { method: 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

const PNG = readFileSync(new URL('../../../packages/comfy/fixtures/still.png', import.meta.url));
const upload = async (bytes: Buffer) =>
  json<{ name: string }>(
    api('/api/uploads', { method: 'POST', headers: { 'x-hildegard': '1' }, body: bytes }),
  );

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
}
const still = (id: string) => srv.store.stills.get(id)!;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hg-images-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hfClientId: null },
    { fakeTickMs: 10, secrets: memoryStore(), hubToken: join(dir, 'no-hf-token') },
  );
  await until(() => srv.scheduler.engineState().online);
});
afterAll(() => srv.close());

describe('images', () => {
  it('draws images from words alone, at the aspect asked, each with its own seed', async () => {
    const res = await post('/api/images', {
      prompt: 'A lighthouse on a basalt headland under a green evening sky.',
      aspect: '16:9',
      count: 3,
      seed: 40,
    });
    expect(res.status).toBe(201);
    const { stills } = await json<{ stills: Still[] }>(res);
    expect(stills.map((s) => s.seed)).toEqual([40, 41, 42]);
    expect(stills[0]).toMatchObject({
      characterId: null,
      view: null,
      model: 'flux-2-klein-4b',
      aspect: '16:9',
      quality: 'final',
      references: [],
    });
    expect(stills[0]!.width).toBeGreaterThan(stills[0]!.height);
    // The person's words stand first, as written.
    expect(stills[0]!.prompt).toBe('A lighthouse on a basalt headland under a green evening sky.');
    await until(() => stills.every((s) => still(s.id).status === 'done'));
    const img = await api(still(stills[1]!.id).image!);
    expect(img.headers.get('content-type')).toBe('image/png');
    const snap = await json<Snapshot>(api('/api/snapshot'));
    expect(snap.stills.filter((s) => s.characterId === null).map((s) => s.id)).toEqual(
      expect.arrayContaining(stills.map((s) => s.id)),
    );
  });

  it('speaks Cinema’s camera language: rig and look join the prompt, and name the image', async () => {
    const { stills } = await json<{ stills: Still[] }>(
      post('/api/images', {
        prompt: 'A cellist in an empty chapel',
        aspect: '4:3',
        quality: 'draft',
        camera: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
      }),
    );
    expect(stills[0]!.quality).toBe('draft');
    expect(stills[0]!.prompt).toMatch(/^A cellist in an empty chapel\. .+f\/2\.8/);
    expect(stills[0]!.summary).toMatch(/35mm · f\/2\.8/);
  });

  it('edits references only when the person says they show no real person', async () => {
    const up = await upload(Buffer.concat([PNG, Buffer.from('edit-me')]));
    const body = { prompt: 'Make the sky in image 1 a winter dawn', references: [up.name] };
    const unsaid = await post('/api/images', body);
    expect(unsaid.status).toBe(422);
    expect(await json<{ field: string }>(unsaid)).toMatchObject({ field: 'noRealPerson' });
    const res = await post('/api/images', { ...body, noRealPerson: true });
    expect(res.status).toBe(201);
    const { stills } = await json<{ stills: Still[] }>(res);
    expect(stills[0]!.references).toEqual([up.name]);
    await until(() => still(stills[0]!.id).status === 'done');
  });

  it('draws with another stills model when asked, on the fake GPU', async () => {
    const res = await post('/api/images', { prompt: 'A pear on a slate', model: 'z-image-turbo', seed: 5 });
    expect(res.status).toBe(201);
    const { stills } = await json<{ stills: Still[] }>(res);
    expect(stills[0]).toMatchObject({ model: 'z-image-turbo', seed: 5, references: [] });
    await until(() => still(stills[0]!.id).status === 'done');
    const img = await api(still(stills[0]!.id).image!);
    expect(img.headers.get('content-type')).toBe('image/png');
    // The one that edits renders too, with up to three references.
    const up = await upload(Buffer.concat([PNG, Buffer.from('edit-with-qwen')]));
    const edit = await post('/api/images', {
      prompt: 'Make the sky in image 1 a winter dawn',
      model: 'qwen-image-edit-2511',
      references: [up.name],
      noRealPerson: true,
    });
    expect(edit.status).toBe(201);
    const made = await json<{ stills: Still[] }>(edit);
    expect(made.stills[0]).toMatchObject({ model: 'qwen-image-edit-2511', references: [up.name] });
    await until(() => still(made.stills[0]!.id).status === 'done');
  });

  it('samples a draft at the model’s draft steps, and a final at its final steps', async () => {
    const steps = async (quality: 'draft' | 'final') => {
      const { stills } = await json<{ stills: Still[] }>(
        post('/api/images', { prompt: 'A pear on a slate', model: 'qwen-image-2512', quality }),
      );
      await until(() => still(stills[0]!.id).status === 'done');
      return still(stills[0]!.id).progress?.steps;
    };
    expect(await steps('draft')).toBe(25);
    expect(await steps('final')).toBe(50);
  });

  it('draws a character’s still at final steps, whatever quality its record carries', async () => {
    const c = await json<{ id: string }>(
      post('/api/characters', { name: 'Mara', description: 'A carpenter' }),
    );
    const st = {
      id: 'aaaaaaaaaaaaaaa1',
      characterId: c.id,
      view: 'portrait',
      quality: 'draft',
      status: 'queued',
      priority: 'interactive',
      source: { kind: 'studio' },
      seed: 1,
      model: 'qwen-image-edit-2511',
      prompt: 'Character reference photograph of Mara.',
      references: [],
      width: 1024,
      height: 1024,
      queuePosition: null,
      progress: null,
      previewVersion: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      renderMs: null,
      error: null,
      image: null,
    } as Still;
    srv.scheduler.enqueueStill(st);
    await until(() => still(st.id).status === 'done');
    expect(still(st.id).progress?.steps).toBe(40);
  });

  it('refuses references for a model that draws from words only', async () => {
    const up = await upload(Buffer.concat([PNG, Buffer.from('words-only')]));
    const res = await post('/api/images', {
      prompt: 'Make the sky in image 1 a winter dawn',
      model: 'z-image-turbo',
      references: [up.name],
      noRealPerson: true,
    });
    expect(res.status).toBe(422);
    expect(await json<{ field: string; error: string }>(res)).toMatchObject({
      field: 'references',
      error: expect.stringMatching(
        /Z-Image Turbo draws from words only\. Pick FLUX\.2 \[klein\] 4B or Qwen-Image-Edit 2511/,
      ),
    });
    const four = await Promise.all(
      [1, 2, 3, 4].map((n) => upload(Buffer.concat([PNG, Buffer.from(`ref-${n}`)]))),
    );
    const tooMany = await post('/api/images', {
      prompt: 'Blend them',
      model: 'qwen-image-edit-2511',
      references: four.map((u) => u.name),
      noRealPerson: true,
    });
    expect(tooMany.status).toBe(422);
    expect(await json<{ field: string }>(tooMany)).toMatchObject({ field: 'references' });
  });

  it('refuses a missing reference, a real person’s consent photo, and sexual words', async () => {
    const missing = await post('/api/images', {
      prompt: 'Recolour it',
      references: [`${'a'.repeat(64)}.png`],
      noRealPerson: true,
    });
    expect(missing.status).toBe(422);

    const photo = await upload(Buffer.concat([PNG, Buffer.from('consent-photo')]));
    const real = {
      id: 'ffffffffffffffff',
      name: 'Someone Real',
      description: '',
      wardrobe: '',
      references: [
        { file: photo.name, view: 'portrait', source: 'consent', addedAt: new Date().toISOString() },
      ],
      cover: photo.name,
      voice: null,
      likeness: 'real',
      consent: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Character;
    srv.store.putCharacter(real);
    const theirs = await post('/api/images', {
      prompt: 'Them at the beach',
      references: [photo.name],
      noRealPerson: true,
    });
    expect(theirs.status).toBe(422);
    expect(await json<{ code: string }>(theirs)).toMatchObject({ code: 'character' });

    // A still drawn of them, never kept, uploaded again byte for byte, is theirs too.
    const drawn = Buffer.concat([PNG, Buffer.from('drawn-of-them')]);
    mkdirSync(join(dir, 'media', 'stills'), { recursive: true });
    writeFileSync(join(dir, 'media', 'stills', 'eeeeeeeeeeeeeeee.png'), drawn);
    srv.store.putStill({
      id: 'eeeeeeeeeeeeeeee',
      characterId: real.id,
      view: 'portrait',
      status: 'done',
      image: '/media/stills/eeeeeeeeeeeeeeee.png',
    } as Still);
    const again = await upload(drawn);
    const laundered = await post('/api/images', {
      prompt: 'Them in a garden',
      references: [again.name],
      noRealPerson: true,
    });
    expect(laundered.status).toBe(422);
    expect(await json<{ code: string }>(laundered)).toMatchObject({ code: 'character' });

    const bad = await post('/api/images', { prompt: 'nude, explicit' });
    expect(bad.status).toBe(422);
    expect(await json<{ code: string }>(bad)).toMatchObject({ code: 'content_blocked' });
    expect((await post('/api/images', { prompt: 'A field', aspect: '7:3' })).status).toBe(422);
    expect((await post('/api/images', { prompt: '' })).status).toBe(422);
  });

  it('has no character to keep an image for, and deletes like any still', async () => {
    const { stills } = await json<{ stills: Still[] }>(post('/api/images', { prompt: 'A pear on a slate' }));
    await until(() => still(stills[0]!.id).status === 'done');
    expect((await post(`/api/stills/${stills[0]!.id}/keep`)).status).toBe(409);
    const gone = await api(`/api/stills/${stills[0]!.id}`, { method: 'DELETE', headers: H });
    expect(gone.status).toBe(204);
    expect(srv.store.stills.has(stills[0]!.id)).toBe(false);
  });
});

describe('who sees an image', () => {
  const director: Who = { kind: 'person', person: { id: 'p1', name: 'Ada', role: 'director' }, session: 's' };
  const other: Who = { kind: 'person', person: { id: 'p2', name: 'Bo', role: 'director' }, session: 's' };
  const owner: Who = { kind: 'person', person: { id: 'p0', name: 'Don', role: 'owner' }, session: 's' };
  const mine = { id: 'i1', characterId: null, owner: 'p1' } as Still;
  const ownersOwn = { id: 'i2', characterId: null } as Still;
  const none = () => undefined;

  it('shows a director their own images only; the owner and this computer see all', () => {
    expect(seesStill(director, mine, none)).toBe(true);
    expect(seesStill(other, mine, none)).toBe(false);
    expect(seesStill(director, ownersOwn, none)).toBe(false);
    expect(seesStill(owner, mine, none)).toBe(true);
    expect(seesStill({ kind: 'local' }, ownersOwn, none)).toBe(true);
    expect(seesStill(null, mine, none)).toBe(false);
    const snap = {
      projects: [],
      shots: [],
      takes: [],
      exports: [],
      engine: { url: '' },
      hf: {},
      choir: { use: 'local', devices: [], sharing: {} },
      guests: [],
      characters: [],
      stills: [mine, ownersOwn],
    } as unknown as Snapshot;
    expect(snapshotFor(director, snap).stills.map((s) => s.id)).toEqual(['i1']);
    const filter = eventFilter(() => undefined, new Set());
    expect(filter(other, { type: 'still', still: mine })).toBeNull();
    expect(filter(director, { type: 'still', still: mine })).not.toBeNull();
  });

  it('keeps a character’s still to whoever sees the character', () => {
    const theirs = { id: 'c1', owner: 'p2' } as Character;
    const st = { id: 's1', characterId: 'c1' } as Still;
    expect(seesStill(director, st, () => theirs)).toBe(false);
    expect(seesStill(other, st, () => theirs)).toBe(true);
    expect(seesStill(director, st, none)).toBe(false);
  });
});
