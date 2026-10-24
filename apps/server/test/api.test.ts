// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportState, ModelState, Project, Snapshot, Take } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs, readHomeId } from '../src/config.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

let srv: Running;
let dataDir: string;
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
  dataDir = dir;
  // Sign in with Hugging Face is on by default; these tests cover the build where it's off, and the token path.
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hfClientId: null },
    { fakeTickMs: 25, secrets: memoryStore(), hubToken: join(dir, 'no-hf-token') },
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

  it('answers health with a random id for its data folder, never the path', async () => {
    const h = (await (await api('/api/health')).json()) as { ok: boolean; home: string };
    expect(h.ok).toBe(true);
    expect(h.home).toMatch(/^[\w-]{12}$/);
    expect(h.home).toBe(readHomeId(dataDir));
    expect(JSON.stringify(h)).not.toContain(dataDir);
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

  it('refuses a sexual prompt or title before it queues, for people and agents alike', async () => {
    const before = srv.store.takes.size;
    for (const body of [
      { request: request({ prompt: 'A naked woman on a bed' }) },
      { request: request({ prompt: 'A sexy 12-year-old' }), agent: 'Claude' },
      { request: request(), title: 'p0rn' },
    ]) {
      const res = await post('/api/shots', body);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'content_blocked' });
    }
    const child = await post('/api/shots', { request: request({ prompt: 'A sexy 12-year-old' }) });
    expect(((await child.json()) as { error: string }).error).toMatch(/children/);
    expect(srv.store.takes.size).toBe(before);
  });

  it('deletes a take the safety check refused, keeps no poster, and won’t retry it', async () => {
    const res = await post('/api/shots', { request: request({ prompt: 'A storm at sea [fail:guard]' }) });
    const [t] = ((await res.json()) as { takes: Take[] }).takes;
    await until(() => take(t!.id).status === 'failed');
    expect(take(t!.id).error).toMatchObject({ code: 'content_blocked' });
    expect(take(t!.id).error!.message).toMatch(/refused this take/);
    expect(take(t!.id).poster).toBeNull();
    expect((await api(`/media/${t!.id}.jpg`)).status).toBe(404);
    const retry = await post(`/api/takes/${t!.id}/retry`);
    expect(retry.status).toBe(409);
    expect(take(t!.id).status).toBe('failed');
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

  it('refuses a shot for a model that isn’t installed where it would render', async () => {
    // As with Hildegard's own ComfyUI and no models downloaded yet.
    const sched = srv.scheduler as unknown as { comfy: string };
    sched.comfy = 'managed';
    try {
      const res = await post('/api/shots', { request: request({ model: 'wan-2-2-ti2v-5b' }) });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        field: 'model',
        code: 'missing_model',
        error: expect.stringMatching(/isn’t installed on this computer\. Install it in Settings › Models/),
      });
    } finally {
      sched.comfy = 'fake';
    }
  });

  it('refuses a shot for a model this Mac’s GPU renders wrong, though its files are here', async () => {
    // As on a Mac that downloaded Wan 2.2 before Hildegard knew it comes out blurred there.
    const models = srv.models as unknown as { states: () => ModelState[] };
    const real = models.states;
    models.states = () =>
      real
        .call(srv.models)
        .map((m) => ({ ...m, installed: true, fit: 'no', fitWhy: 'apple-gpu' }) as ModelState);
    try {
      const res = await post('/api/shots', { request: request({ model: 'wan-2-2-ti2v-5b' }) });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        field: 'model',
        code: 'no_local_render',
        error:
          'Wan 2.2 5B doesn’t render on this Mac yet. Pair a device with an NVIDIA or AMD GPU and render there.',
      });
    } finally {
      models.states = real;
    }
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
    expect(s.hf).toEqual({ linked: false, user: null, storage: null, oauth: false, found: false });
  });
});

describe('take review', () => {
  it('checks a finished take against its shot, keeps the result, and serves a contact sheet', async () => {
    const { takes } = (await (await post('/api/shots', { request: request() })).json()) as { takes: Take[] };
    const id = takes[0]!.id;
    // Not finished yet: nothing to check.
    const early = await api(`/api/takes/${id}/review`);
    if (take(id).status !== 'done') expect(early.status).toBe(409);
    await until(() => take(id).status === 'done');
    const res = await api(`/api/takes/${id}/review`);
    expect(res.status).toBe(200);
    const r = (await res.json()) as {
      kind: string;
      passed: boolean;
      checks: Array<{ id: string; status: string }>;
      summary: string;
      sheet: string;
    };
    expect(r.kind).toBe('video');
    expect(r.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['size', 'length', 'colour', 'flicker']),
    );
    expect(r.summary).toMatch(/^Technical checks/);
    expect(r.sheet).toBe(`/api/takes/${id}/sheet`);
    const sheet = await api(r.sheet);
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get('content-type')).toBe('image/jpeg');
    // The second ask is the kept answer.
    const again = (await (await api(`/api/takes/${id}/review`)).json()) as { checks: unknown[] };
    expect(again.checks).toEqual(r.checks);
    expect((await api('/api/takes/nope/review')).status).toBe(404);
  }, 60_000);
});

describe('shot lookup', () => {
  it('returns a shot with its takes, its film and, once done, where each video is on disk', async () => {
    const { shot, takes } = (await (await post('/api/shots', { request: request() })).json()) as {
      shot: { id: string; projectId: string };
      takes: Take[];
    };
    await until(() => takes.every((t) => take(t.id).status === 'done'));
    const body = (await (await api(`/api/shots/${shot.id}`)).json()) as {
      takes: Take[];
      files: Record<string, string>;
      project: { id: string; title: string };
    };
    expect(body.project).toEqual({ id: shot.projectId, title: 'Untitled film' });
    expect(body.takes.map((t) => t.id)).toEqual(takes.map((t) => t.id));
    expect(existsSync(body.files[takes[0]!.id]!)).toBe(true);
    expect((await api('/api/shots/nope')).status).toBe(404);
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

  it('asks for a Hugging Face account before a gated download starts', async () => {
    const res = await post('/api/models/ltx-2-5-distilled/install', { acceptLicense: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'hf' });
    expect(srv.models.states().find((m) => m.id === 'ltx-2-5-distilled')?.downloading).toBeNull();
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

describe('export film', () => {
  it('joins each shot’s kept take, in order, into one MP4 labeled as AI-generated', async () => {
    const film = (await (await post('/api/projects', { title: 'Lighthouse / “Dusk”' })).json()) as Project;
    expect((await post(`/api/projects/${film.id}/export`)).status).toBe(409);
    const made: Take[][] = [];
    for (const prompt of ['The beam sweeps the fog', 'The keeper climbs the stairs']) {
      const r = await post('/api/shots', { projectId: film.id, request: request({ prompt, takes: 2 }) });
      made.push(((await r.json()) as { takes: Take[] }).takes);
    }
    await until(() => made.flat().every((t) => take(t.id).status === 'done'), 30_000);
    await post(`/api/takes/${made[0]![0]!.id}/keep`, { kept: true });

    const res = await post(`/api/projects/${film.id}/export`);
    expect(res.status).toBe(202);
    const started = (await res.json()) as ExportState;
    // Shot I's kept take 1, and shot II's newest, take 2.
    expect(started.takeIds).toEqual([made[0]![0]!.id, made[1]![1]!.id]);
    expect((await post(`/api/projects/${film.id}/export`)).status).toBe(409);

    let e = started;
    await until(async () => {
      e = (await (await api(`/api/exports/${started.id}`)).json()) as ExportState;
      return e.status !== 'running';
    }, 60_000);
    expect(e).toMatchObject({ status: 'done', done: 2, total: 2, error: null });
    expect(e.seconds).toBeCloseTo(6, 0);

    const file = await api(`${e.url}?download`);
    expect(file.headers.get('content-type')).toBe('video/mp4');
    expect(file.headers.get('content-disposition')).toContain("filename*=UTF-8''Lighthouse%20Dusk.mp4");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
    expect(bytes.includes('AI-generated video')).toBe(true);
    const snap = (await (await api('/api/snapshot')).json()) as Snapshot;
    expect(snap.exports.find((x) => x.id === e.id)?.status).toBe('done');
    expect(readFileSync(join(srv.config.dataDir, 'media', 'exports', `${e.id}.mp4`)).length).toBe(
      bytes.length,
    );
  }, 60_000);
});
