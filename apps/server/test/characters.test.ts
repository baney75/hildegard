// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Character, Snapshot, Still, Take } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventFilter, open, snapshotFor, type Who } from '../src/access.ts';
import { parseArgs } from '../src/config.ts';
import { checkConsent, Likeness, type SignedConsent } from '../src/likeness.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

let srv: Running;
let dir: string;
const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const api = (path: string, init: RequestInit = {}) => fetch(srv.url + path, init);
const send = (method: string, path: string, body?: unknown) =>
  api(path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (path: string, body?: unknown) => send('POST', path, body);
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

const PNG = readFileSync(new URL('../../../packages/comfy/fixtures/still.png', import.meta.url));
/** Different photos, as a camera takes them: the same PNG with a different tail after IEND. */
const shot = (i: number) => Buffer.concat([PNG, Buffer.from(`photo-${i}`)]);
const request = (over: Record<string, unknown> = {}) => ({
  prompt: 'She walks the terrace wall at dusk',
  rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
  format: { quality: 'draft', seconds: 3 },
  ...over,
});

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
}
const still = (id: string) => srv.store.stills.get(id)!;
const character = (id: string) => srv.store.characters.get(id)!;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hg-chars-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hfClientId: null },
    { fakeTickMs: 10, secrets: memoryStore(), hubToken: join(dir, 'no-hf-token') },
  );
  await until(() => srv.scheduler.engineState().online);
});
afterAll(() => srv.close());

async function newCharacter(body: Record<string, unknown> = {}): Promise<Character> {
  const res = await post('/api/characters', {
    name: 'Mara',
    description: 'Early thirties, auburn side braid, light freckles, grey-green eyes',
    wardrobe: 'an undyed linen shirt and canvas apron',
    ...body,
  });
  expect(res.status).toBe(201);
  return json<Character>(res);
}

/** Portraits for a character, rendered, and the first one kept as a reference. */
async function withFace(c: Character): Promise<Character> {
  const { stills } = await json<{ stills: Still[] }>(
    post(`/api/characters/${c.id}/stills`, { view: 'portrait' }),
  );
  await until(() => still(stills[0]!.id).status === 'done');
  return json<Character>(post(`/api/stills/${stills[0]!.id}/keep`));
}

describe('characters', () => {
  it('makes an invented character, and refuses one described sexually', async () => {
    const c = await newCharacter();
    expect(c).toMatchObject({
      name: 'Mara',
      likeness: 'invented',
      consent: null,
      references: [],
      voice: null,
    });
    const snap = await json<Snapshot>(api('/api/snapshot'));
    expect(snap.characters.map((x) => x.id)).toContain(c.id);
    const bad = await post('/api/characters', { name: 'X', description: 'nude, explicit' });
    expect(bad.status).toBe(422);
    expect(await json<{ code: string }>(bad)).toMatchObject({ code: 'content_blocked' });
    expect((await post('/api/characters', { name: '' })).status).toBe(422);
  });

  it('renders four portraits to pick a face from, then keeps one as their face', async () => {
    const c = await newCharacter();
    const res = await post(`/api/characters/${c.id}/stills`, { view: 'portrait', count: 4, seed: 10 });
    expect(res.status).toBe(201);
    const { stills } = await json<{ stills: Still[] }>(res);
    expect(stills.map((s) => s.seed)).toEqual([10, 11, 12, 13]);
    expect(stills[0]).toMatchObject({ model: 'flux-2-klein-4b', width: 1024, height: 1024, references: [] });
    expect(stills[0]!.prompt).toMatch(/^Character reference photograph of Mara, Early thirties/);
    await until(() => stills.every((s) => still(s.id).status === 'done'));
    const done = still(stills[2]!.id);
    expect(done.image).toBe(`/media/stills/${done.id}.png`);
    const img = await api(done.image!);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(
      Buffer.from(await img.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');

    const kept = await json<Character>(post(`/api/stills/${done.id}/keep`));
    expect(kept.references).toEqual([expect.objectContaining({ view: 'portrait', source: 'still' })]);
    expect(kept.cover).toBe(kept.references[0]!.file);
    expect(existsSync(join(dir, 'media', 'uploads', kept.cover!))).toBe(true);
    // The still remembers the reference it became, so the Studio can show it kept.
    expect(still(done.id).kept).toBe(kept.cover);
    // Keeping the same still twice keeps one reference.
    expect((await json<Character>(post(`/api/stills/${done.id}/keep`))).references).toHaveLength(1);
  });

  it('draws the rest of a sheet from the face it has, and queues stills with takes', async () => {
    const c = await withFace(await newCharacter());
    const { stills } = await json<{ stills: Still[] }>(
      post(`/api/characters/${c.id}/stills`, { view: 'full-body' }),
    );
    expect(stills[0]!.references).toEqual([c.cover]);
    expect(stills[0]!.height).toBeGreaterThan(stills[0]!.width);
    expect(stills[0]!.prompt).toMatch(/same person as in reference image 1/);
    await until(() => still(stills[0]!.id).status === 'done');
    const sheet = await json<Character>(post(`/api/stills/${stills[0]!.id}/keep`));
    expect(sheet.references.map((r) => r.view)).toEqual(['portrait', 'full-body']);
    // Their face stays the cover.
    expect(sheet.cover).toBe(c.cover);
  });

  it('casts characters in a shot: the start frame is drawn from their references, the prompt names them', async () => {
    const mara = await withFace(await newCharacter());
    const konrad = await withFace(await newCharacter({ name: 'Brother Konrad', description: 'A tall monk' }));
    const res = await post('/api/shots', { request: request({ characters: [mara.id, konrad.id] }) });
    expect(res.status).toBe(201);
    const { takes } = await json<{ takes: Take[] }>(res);
    expect(takes[0]!.prompt).toMatch(/Featuring Mara, .*; Brother Konrad, A tall monk/);
    await until(() => srv.store.takes.get(takes[0]!.id)!.status === 'done');
    expect(srv.store.takes.get(takes[0]!.id)!.video).toMatch(/\.mp4$/);
  });

  it('refuses a cast it can’t draw: unknown, faceless, or with a start frame too', async () => {
    const faceless = await newCharacter();
    const unknown = await post('/api/shots', { request: request({ characters: ['0123456789abcdef'] }) });
    expect(unknown.status).toBe(422);
    expect(await json<{ field: string }>(unknown)).toMatchObject({ field: 'characters' });
    const none = await post('/api/shots', { request: request({ characters: [faceless.id] }) });
    expect(none.status).toBe(422);
    expect((await json<{ error: string }>(none)).error).toMatch(/no reference images yet/);
    const up = await json<{ name: string }>(
      api('/api/uploads', { method: 'POST', headers: { 'x-hildegard': '1' }, body: PNG }),
    );
    const both = await post('/api/shots', {
      request: request({ characters: [faceless.id], startFrame: up.name }),
    });
    expect(both.status).toBe(422);
    expect((await json<{ error: string }>(both)).error).toMatch(/start frame or characters/);
  });

  it('fails a queued take whose character was deleted, and deletes the character’s stills with it', async () => {
    const c = await withFace(await newCharacter());
    await srv.scheduler.setPaused(true);
    const { takes } = await json<{ takes: Take[] }>(
      post('/api/shots', { request: request({ characters: [c.id] }) }),
    );
    const stillIds = [...srv.store.stills.values()].filter((s) => s.characterId === c.id).map((s) => s.id);
    expect((await send('DELETE', `/api/characters/${c.id}`)).status).toBe(204);
    expect(stillIds.every((s) => !srv.store.stills.has(s))).toBe(true);
    srv.scheduler.setPaused(false);
    await until(() => srv.store.takes.get(takes[0]!.id)!.status === 'failed');
    expect(srv.store.takes.get(takes[0]!.id)!.error).toMatchObject({ code: 'character' });
  });

  it('adds an uploaded reference only when the person says it shows no real person', async () => {
    const c = await newCharacter();
    const up = await json<{ name: string }>(
      api('/api/uploads', { method: 'POST', headers: { 'x-hildegard': '1' }, body: PNG }),
    );
    const unsaid = await post(`/api/characters/${c.id}/references`, { file: up.name });
    expect(unsaid.status).toBe(422);
    const ok = await post(`/api/characters/${c.id}/references`, {
      file: up.name,
      view: 'portrait',
      noRealPerson: true,
    });
    expect(ok.status).toBe(201);
    expect((await json<Character>(ok)).references).toEqual([expect.objectContaining({ source: 'upload' })]);
    const gone = await send('DELETE', `/api/characters/${c.id}/references/${up.name}`);
    expect((await json<Character>(gone)).references).toEqual([]);
  });

  it('edits a character, keeps the cover to its references, and refuses a voice where there’s no Voice studio', async () => {
    const c = await withFace(await newCharacter());
    const edited = await json<Character>(
      send('PATCH', `/api/characters/${c.id}`, { wardrobe: 'a grey wool cloak' }),
    );
    expect(edited.wardrobe).toBe('a grey wool cloak');
    expect((await send('PATCH', `/api/characters/${c.id}`, { cover: `${'f'.repeat(64)}.png` })).status).toBe(
      422,
    );
    expect((await send('PATCH', `/api/characters/${c.id}`, { description: 'topless' })).status).toBe(422);
    expect((await send('PATCH', `/api/characters/${c.id}`, { voice: 'kokoro-fable' })).status).toBe(422);
  });
});

describe('a character based on a real person', () => {
  const photos = () => [0, 1, 2].map((i) => shot(i).toString('base64'));

  it('stays unusable until the person consents, on their own device, with photos they take', async () => {
    const c = await newCharacter({ name: 'Anna', likeness: 'real' });
    expect(c.consent).toMatchObject({ status: 'waiting' });
    // Nothing of them may be uploaded, drawn or cast before they consent.
    const up = await json<{ name: string }>(
      api('/api/uploads', { method: 'POST', headers: { 'x-hildegard': '1' }, body: PNG }),
    );
    expect(
      (await post(`/api/characters/${c.id}/references`, { file: up.name, noRealPerson: true })).status,
    ).toBe(409);
    expect((await post(`/api/characters/${c.id}/stills`, { view: 'portrait' })).status).toBe(409);
    const cast = await post('/api/shots', { request: request({ characters: [c.id] }) });
    expect((await json<{ error: string }>(cast)).error).toMatch(/hasn’t given consent/);

    expect((await post(`/api/characters/${c.id}/consent`, {})).status).toBe(422);
    const link = await json<{ url: string; local: boolean }>(
      post(`/api/characters/${c.id}/consent`, { maker: 'Sam' }),
    );
    expect(link.local).toBe(true);
    const token = /#\/likeness\/([\w-]{43})$/.exec(link.url)![1]!;
    // What the person sees: who asks, for which character, and the words they agree to.
    const ask = await json<{ maker: string; character: string; photos: string[]; statement: string }>(
      api(`/api/likeness/${token}`),
    );
    expect(ask).toMatchObject({
      maker: 'Sam',
      character: 'Anna',
      photos: ['portrait', 'three-quarter', 'profile'],
    });
    expect(ask.statement).toMatch(/I agree that Sam may use my likeness for the character “Anna”/);

    // Two photos, no agreement, or a file that isn't an image: refused.
    expect(
      (await post(`/api/likeness/${token}`, { person: 'Anna Weiss', agree: true, photos: photos().slice(1) }))
        .status,
    ).toBe(422);
    expect((await post(`/api/likeness/${token}`, { person: 'Anna Weiss', photos: photos() })).status).toBe(
      422,
    );
    expect(
      (
        await post(`/api/likeness/${token}`, {
          person: 'Anna Weiss',
          agree: true,
          photos: ['aGVsbG8=', ...photos().slice(1)],
        })
      ).status,
    ).toBe(422);

    const given = await post(`/api/likeness/${token}`, {
      person: 'Anna Weiss',
      agree: true,
      photos: photos(),
    });
    expect(given.status).toBe(201);
    const { revokeUrl } = await json<{ revokeUrl: string }>(given);
    expect(revokeUrl).toMatch(/#\/likeness\/revoke\/[\w-]{43}$/);
    // The link works once.
    expect((await api(`/api/likeness/${token}`)).status).toBe(410);
    expect(
      (await post(`/api/likeness/${token}`, { person: 'X', agree: true, photos: photos() })).status,
    ).toBe(410);

    const now = character(c.id);
    expect(now.consent).toMatchObject({ status: 'active', person: 'Anna Weiss' });
    expect(now.references.map((r) => [r.view, r.source])).toEqual([
      ['portrait', 'consent'],
      ['three-quarter', 'consent'],
      ['profile', 'consent'],
    ]);
    // Their own photos stay while their consent does.
    expect(
      (await send('DELETE', `/api/characters/${c.id}/references/${now.references[0]!.file}`)).status,
    ).toBe(409);

    // The signed record checks out, and fails once anything in it changes.
    const record = await json<SignedConsent>(api(`/api/characters/${c.id}/consent`));
    expect(record.record).toMatchObject({
      person: 'Anna Weiss',
      maker: 'Sam',
      character: { id: c.id, name: 'Anna' },
    });
    expect(record.record.photos).toHaveLength(3);
    expect(checkConsent(record)).toBe(true);
    expect(checkConsent({ ...record, record: { ...record.record, maker: 'Mallory' } })).toBe(false);

    // Now it draws and casts.
    const ok = await post('/api/shots', { request: request({ characters: [c.id] }) });
    expect(ok.status).toBe(201);

    // The person takes it back with their own link: the character stops and their photos go.
    const files = now.references.map((r) => join(dir, 'media', 'uploads', r.file));
    const revokeToken = revokeUrl.split('/').pop()!;
    expect((await post(`/api/likeness/revoke/${revokeToken}`)).status).toBe(200);
    const after = character(c.id);
    expect(after.consent).toMatchObject({ status: 'revoked', person: 'Anna Weiss' });
    expect(after.references).toEqual([]);
    expect(files.every((f) => !existsSync(f))).toBe(true);
    const refused = await post('/api/shots', { request: request({ characters: [c.id] }) });
    expect((await json<{ error: string }>(refused)).error).toMatch(/consent was taken back/);
    expect(checkConsent(await json<SignedConsent>(api(`/api/characters/${c.id}/consent`)))).toBe(true);
    expect((await json<SignedConsent>(api(`/api/characters/${c.id}/consent`))).revokedAt).not.toBeNull();
  });

  it('lets the maker revoke too, and the person decline', async () => {
    const c = await newCharacter({ name: 'Ben', likeness: 'real' });
    const { url } = await json<{ url: string }>(post(`/api/characters/${c.id}/consent`, { maker: 'Sam' }));
    const token = url.split('/').pop()!;
    expect((await post(`/api/likeness/${token}/decline`)).status).toBe(200);
    expect(character(c.id).consent).toMatchObject({ status: 'declined' });
    expect((await api(`/api/likeness/${token}`)).status).toBe(410);

    const again = await json<{ url: string }>(post(`/api/characters/${c.id}/consent`, { maker: 'Sam' }));
    await post(`/api/likeness/${again.url.split('/').pop()}`, {
      person: 'Ben',
      agree: true,
      photos: photos(),
    });
    expect(character(c.id).consent?.status).toBe('active');
    expect((await post(`/api/characters/${c.id}/consent`, { maker: 'Sam' })).status).toBe(409);
    expect((await post(`/api/characters/${c.id}/consent/revoke`)).status).toBe(200);
    expect(character(c.id).consent?.status).toBe('revoked');
  });

  it('refuses consent links for invented characters, and nonsense tokens', async () => {
    const c = await newCharacter();
    expect((await post(`/api/characters/${c.id}/consent`, { maker: 'Sam' })).status).toBe(409);
    expect((await api('/api/likeness/not-a-token')).status).toBe(410);
    expect((await post('/api/likeness/revoke/not-a-token')).status).toBe(404);
  });
});

describe('who sees characters', () => {
  const mine = { id: 'c1', owner: 'p1' } as Character;
  const theirs = { id: 'c2', owner: 'p2' } as Character;
  const owners = { id: 'c3' } as Character;
  const director: Who = { kind: 'person', person: { id: 'p1', name: 'Ada', role: 'director' }, session: 's' };
  const owner: Who = { kind: 'person', person: { id: 'p0', name: 'Don', role: 'owner' }, session: 's' };

  it('shows a director their own characters and stills only; the owner sees all', () => {
    const snap = {
      projects: [],
      shots: [],
      takes: [],
      exports: [],
      engine: { url: '' },
      hf: {},
      choir: { use: 'local', devices: [], sharing: {} },
      guests: [],
      characters: [mine, theirs, owners],
      stills: [
        { id: 's1', characterId: 'c1' },
        { id: 's2', characterId: 'c2' },
      ] as Still[],
    } as unknown as Snapshot;
    expect(snapshotFor(director, snap).characters.map((c) => c.id)).toEqual(['c1']);
    expect(snapshotFor(director, snap).stills.map((c) => c.id)).toEqual(['s1']);
    expect(snapshotFor(owner, snap).characters).toHaveLength(3);
    const byId = (id: string) => snap.characters.find((c) => c.id === id);
    const filter = eventFilter(() => undefined, new Set(), byId);
    expect(filter(director, { type: 'character', character: theirs })).toBeNull();
    expect(filter(director, { type: 'character', character: mine })).not.toBeNull();
    expect(filter(director, { type: 'still', still: { id: 's2', characterId: 'c2' } as Still })).toBeNull();
  });

  it('lets anyone holding a consent link reach it before signing in, and nothing else of characters', () => {
    expect(open('GET', '/api/likeness/abc')).toBe(true);
    expect(open('POST', '/api/likeness/abc')).toBe(true);
    expect(open('GET', '/api/characters')).toBe(false);
    expect(open('POST', '/api/characters/x/consent')).toBe(false);
  });
});

describe('Likeness', () => {
  it('expires links after a day, and keeps no token, only its hash', () => {
    let t = Date.parse('2026-10-24T00:00:00Z');
    const d = mkdtempSync(join(tmpdir(), 'hg-likeness-'));
    const l = new Likeness(d, { now: () => t });
    const { token } = l.start({ characterId: 'c1', character: 'Anna', maker: 'Sam' });
    expect(readFileSync(join(d, 'likeness', 'consent.json'), 'utf8')).not.toContain(token);
    expect(l.lookup(token)).toMatchObject({ character: 'Anna' });
    t += 25 * 3600_000;
    expect(l.lookup(token)).toBeNull();
    // A new link replaces the last for the same character.
    const a = l.start({ characterId: 'c1', character: 'Anna', maker: 'Sam' });
    const b = l.start({ characterId: 'c1', character: 'Anna', maker: 'Sam' });
    expect(l.lookup(a.token)).toBeNull();
    expect(l.lookup(b.token)).not.toBeNull();
    // The same install key signs after a restart.
    const again = new Likeness(d, { now: () => t });
    // The same picture three times isn't three photos.
    expect(() => again.give(b.token, 'Anna', [shot(0), shot(0), shot(1)])).toThrow(/Take each photo fresh/);
    const { consent } = again.give(b.token, 'Anna', [0, 1, 2].map(shot));
    expect(checkConsent(consent)).toBe(true);
  });
});
