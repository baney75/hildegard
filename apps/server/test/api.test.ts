// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot, Take } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

let srv: Running;
const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const api = (path: string, init: RequestInit = {}) => fetch(srv.url + path, init);
const post = (path: string, body?: unknown) =>
  api(path, { method: 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

const request = (over: Record<string, unknown> = {}) => ({
  prompt: 'A lighthouse keeper climbs the spiral stairs at dusk',
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
const take = (id: string) => srv.store.takes.get(id)!;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-api-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
    { fakeTickMs: 25, secrets: memoryStore() },
  );
  await until(() => srv.scheduler.engineState().online);
});
afterAll(() => srv.close());

describe('security', () => {
  it('refuses unknown Host headers (DNS rebinding)', async () => {
    const { request: req } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const u = new URL(`${srv.url}/api/health`);
      req({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example' } }, (res) =>
        resolve(res.statusCode!),
      ).end();
    });
    expect(status).toBe(421);
  });

  it('refuses writes without the Hildegard header, and from other sites', async () => {
    expect((await api('/api/projects', { method: 'POST' })).status).toBe(403);
    expect(
      (await api('/api/projects', { method: 'POST', headers: { ...H, origin: 'https://evil.example' } }))
        .status,
    ).toBe(403);
    expect(
      (await api('/api/projects', { method: 'POST', headers: { ...H, origin: srv.url }, body: '{}' })).status,
    ).toBe(201);
  });

  it('sends protective headers', async () => {
    const res = await api('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('does not serve files outside the media folder', async () => {
    for (const p of ['/media/../state.json', '/media/%2e%2e/state.json', '/media/uploads/../../state.json'])
      expect((await api(p)).status).toBe(404);
  });
});

describe('shots and takes', () => {
  it('renders takes end to end, with progress, a poster and a seekable video', async () => {
    const res = await post('/api/shots', { request: request({ takes: 2, seed: 41 }) });
    expect(res.status).toBe(201);
    const { shot, takes } = (await res.json()) as { shot: { title: string }; takes: Take[] };
    expect(shot.title).toBe('A lighthouse keeper climbs the spiral…');
    expect(takes.map((t) => t.seed)).toEqual([41, 42]);
    expect(takes.map((t) => t.number)).toEqual([1, 2]);
    await until(() => takes.every((t) => take(t.id).status === 'done'));
    const t = take(takes[0]!.id);
    expect(t.video).toBe(`/media/${t.id}.mp4`);
    expect(t.poster).toBe(`/media/${t.id}.jpg`);
    expect(t.renderMs).toBeGreaterThan(0);
    const range = await api(t.video!, { headers: { range: 'bytes=0-99' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect((await range.arrayBuffer()).byteLength).toBe(100);
  });

  it('streams take updates over server-sent events', async () => {
    const ac = new AbortController();
    const res = await api('/api/events', { signal: ac.signal });
    const reader = res.body!.getReader();
    const { takes } = (await (await post('/api/shots', { request: request() })).json()) as { takes: Take[] };
    let text = '';
    await until(async () => {
      text += new TextDecoder().decode((await reader.read()).value);
      const batches = text.split('event: batch').slice(1).join('');
      return batches.includes(`"id":"${takes.at(-1)!.id}"`) && /"status":"done"/.test(batches);
    });
    ac.abort();
    // The first event carries a full snapshot, so a client never has to fetch one and race the stream.
    const hello = JSON.parse(
      text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6),
    ) as { snapshot: Snapshot };
    expect(hello.snapshot.engine.fake).toBe(true);
  });

  it('serves the poster for a preview asked for just after the take finished', async () => {
    const { takes } = (await (await post('/api/shots', { request: request() })).json()) as { takes: Take[] };
    await until(() => take(takes[0]!.id).status === 'done');
    const res = await api(`/api/takes/${takes[0]!.id}/preview?v=3`, { redirect: 'manual' });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`/media/${takes[0]!.id}.jpg`);
    expect((await api('/api/takes/nope/preview')).status).toBe(404);
  });

  it('explains a bad preset and points at the field', async () => {
    const res = await post('/api/shots', {
      request: request({ rig: { body: 'imax-70', lens: 'clean', focal: 35, aperture: 2.8 } }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: 'rig.body' });
    const empty = await post('/api/shots', { request: request({ prompt: '  ' }) });
    expect(await empty.json()).toMatchObject({ error: 'Describe the shot', field: 'prompt' });
  });

  it('turns a GPU failure into a plain sentence with a fix, and retries', async () => {
    const res = await post('/api/shots', { request: request({ prompt: 'A storm at sea [fail:oom]' }) });
    const [t] = ((await res.json()) as { takes: Take[] }).takes;
    await until(() => take(t!.id).status === 'failed');
    expect(take(t!.id).error).toMatchObject({
      code: 'out_of_memory',
      message: 'Your GPU ran out of memory.',
    });
    expect((await post(`/api/takes/${t!.id}/retry`)).status).toBe(200);
    expect(take(t!.id).status).not.toBe('failed');
  });

  it('cancels a waiting take, and Force now jumps the queue', async () => {
    srv.scheduler.setPaused(true);
    const a = (
      (await (await post('/api/shots', { request: request(), agent: 'Claude' })).json()) as { takes: Take[] }
    ).takes[0]!;
    const b = ((await (await post('/api/shots', { request: request() })).json()) as { takes: Take[] })
      .takes[0]!;
    const c = (
      (await (await post('/api/shots', { request: request(), agent: 'Claude' })).json()) as { takes: Take[] }
    ).takes[0]!;
    expect(take(a.id).priority).toBe('agent');
    // Studio work goes ahead of agent work.
    expect(
      srv.scheduler
        .queued()
        .map((t) => t.id)
        .slice(-3),
    ).toEqual([b.id, a.id, c.id]);
    expect((await post(`/api/takes/${c.id}/force`, { interrupt: false })).status).toBe(200);
    expect(srv.scheduler.queued()[0]!.id).toBe(c.id);
    expect((await post(`/api/takes/${a.id}/cancel`)).status).toBe(200);
    expect(take(a.id).status).toBe('canceled');
    expect((await post(`/api/takes/${a.id}/cancel`)).status).toBe(409);
    srv.scheduler.setPaused(false);
    await until(() => take(c.id).status === 'done' && take(b.id).status === 'done');
    expect(take(c.id).finishedAt! <= take(b.id).finishedAt!).toBe(true);
  });

  it('accepts only real images as start frames, named by their hash', async () => {
    const bad = await api('/api/uploads', {
      method: 'POST',
      headers: { 'x-hildegard': '1' },
      body: '<svg onload=alert(1)>',
    });
    expect(bad.status).toBe(415);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const ok = await api('/api/uploads', { method: 'POST', headers: { 'x-hildegard': '1' }, body: png });
    expect(ok.status).toBe(201);
    const { name } = (await ok.json()) as { name: string };
    expect(name).toMatch(/^[0-9a-f]{64}\.png$/);
  });

  it('deletes a shot with its takes and files', async () => {
    const { shot, takes } = (await (await post('/api/shots', { request: request() })).json()) as {
      shot: { id: string };
      takes: Take[];
    };
    await until(() => take(takes[0]!.id).status === 'done');
    expect((await api(`/api/shots/${shot.id}`, { method: 'DELETE', headers: H })).status).toBe(204);
    expect(srv.store.takes.has(takes[0]!.id)).toBe(false);
    expect((await api(`/media/${takes[0]!.id}.mp4`)).status).toBe(404);
  });

  it('returns everything in one snapshot', async () => {
    const s = (await (await api('/api/snapshot')).json()) as Snapshot;
    expect(s.engine).toMatchObject({ online: true, fake: true });
    expect(s.models.map((m) => m.id)).toEqual(['ltx-2-5-distilled', 'ltx-2-distilled', 'wan-2-2-ti2v-5b']);
    expect(s.hf).toEqual({ linked: false, user: null, storage: null, oauth: false });
  });
});

describe('model installs', () => {
  it('shows the license terms and installs nothing until they are accepted', async () => {
    const res = await post('/api/models/wan-2-2-ti2v-5b/install');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; license: string; terms: string[] };
    expect(body).toMatchObject({ code: 'license', license: 'Apache-2.0' });
    expect(body.terms.length).toBeGreaterThan(0);
    expect(srv.models.licenseAccepted('wan-2-2-ti2v-5b')).toBe(false);
    expect((await post('/api/models/nope/install', { acceptLicense: true })).status).toBe(404);
  });
});

describe('Hugging Face routes', () => {
  it('says browser sign-in needs an OAuth app, and offers the token path', async () => {
    const res = await post('/api/hf/oauth/start');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/paste a token/);
  });
  it('shows a safe page when sign-in is canceled', async () => {
    const res = await api('/api/hf/callback?error=access_denied&state=<script>');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Sign-in was canceled');
    expect(html).not.toContain('<script>');
  });
});
