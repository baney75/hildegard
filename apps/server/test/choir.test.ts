// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChoirState, GuestTake, Snapshot, Take } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventFilter, snapshotFor, type Who } from '../src/access.ts';
import {
  checkUrl,
  encodeJoinCode,
  hashToken,
  newToken,
  parseJoinCode,
  privateLink,
  tailscaleSelf,
  tokenMatches,
} from '../src/choir.ts';
import { parseArgs } from '../src/config.ts';
import type { SecretStore } from '../src/hf.ts';
import { guestName } from '../src/node-api.ts';
import { RemoteEngine } from '../src/remote-engine.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

describe('keys', () => {
  it('are 256 random bits, stored as a hash, and match only themselves', () => {
    const a = newToken();
    const b = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
    const hashes = [hashToken(b), hashToken(a)];
    expect(tokenMatches(a, hashes)).toBe(true);
    expect(tokenMatches(b, hashes)).toBe(true);
    expect(tokenMatches(newToken(), hashes)).toBe(false);
    expect(tokenMatches(`${a}x`, hashes)).toBe(false);
    expect(tokenMatches('', hashes)).toBe(false);
    expect(tokenMatches(a, [])).toBe(false);
  });
});

describe('join codes', () => {
  const token = newToken();
  it('round-trip, and tolerate the line breaks a paste brings', () => {
    const code = encodeJoinCode({ name: 'parish1', url: 'http://100.101.102.103:7341', token });
    expect(code).toMatch(/^hgc1_[A-Za-z0-9_-]+$/);
    expect(parseJoinCode(`  ${code.slice(0, 20)}\n${code.slice(20)}\n`)).toEqual({
      name: 'parish1',
      url: 'http://100.101.102.103:7341',
      token,
    });
  });

  it('refuse anything that is not one', () => {
    const enc = (o: unknown) => `hgc1_${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
    for (const bad of [
      '',
      'hello',
      'hgc1_!!!',
      `hgc1_${'A'.repeat(2000)}`,
      enc({ n: 'parish1', u: 'http://100.101.102.103:7341', t: 'short' }),
      enc({ n: 'local', u: 'http://100.101.102.103:7341', t: token }),
      enc({ n: 'bad name!', u: 'http://100.101.102.103:7341', t: token }),
      enc({ n: 'p', u: 'file:///etc/passwd', t: token }),
      enc({ n: 'p', u: 'http://100.101.102.103:7341/api/snapshot', t: token }),
      enc({ n: 'p', u: 'http://user:pw@100.101.102.103:7341', t: token }),
    ])
      expect(() => parseJoinCode(bad), bad.slice(0, 40)).toThrow();
  });

  it('accept only private links: Tailscale, loopback or https', () => {
    for (const ok of [
      'http://100.64.0.1:7341',
      'http://100.127.255.1:7341',
      'http://parish1.tail1234.ts.net:7341',
      'http://127.0.0.1:7341',
      'http://[::1]:7341',
      'http://[fd7a:115c:a1e0::1]:7341',
      'https://studio.example.com',
    ])
      expect(privateLink(new URL(ok)), ok).toBe(true);
    for (const no of ['http://192.168.1.20:7341', 'http://100.128.0.1:7341', 'http://example.com:7341'])
      expect(privateLink(new URL(no)), no).toBe(false);
    expect(() => checkUrl('http://192.168.1.20:7341')).toThrow(/Tailscale/);
  });

  it('find this device on its tailnet, or say it isn’t on one', () => {
    const status = JSON.stringify({
      BackendState: 'Running',
      Self: {
        HostName: 'Parish1',
        DNSName: 'parish1.tail1234.ts.net.',
        TailscaleIPs: ['100.70.1.2', 'fd7a::1'],
      },
    });
    expect(tailscaleSelf(() => status)).toEqual({ ip: '100.70.1.2', name: 'parish1' });
    expect(tailscaleSelf(() => JSON.stringify({ BackendState: 'Stopped', Self: {} }))).toBeNull();
    expect(tailscaleSelf(() => null)).toBeNull();
  });
});

describe('renders from paired devices', () => {
  it('keep only a short, plain name from what the other device calls itself', () => {
    expect(guestName('rectory1')).toBe('rectory1');
    expect(guestName('  Donovan’s  MacBook\n')).toBe('Donovans MacBook');
    expect(guestName('<img src=x onerror=alert(1)>')).toBe('img srcx onerroralert1');
    expect(guestName('\u202Eevil\u0000')).toBe('evil');
    expect(guestName('x'.repeat(500))).toBe('x'.repeat(40));
    expect(guestName('   ')).toBeNull();
    expect(guestName(undefined)).toBeNull();
  });

  it('show directors that the GPU is busy, not which device sent the render', () => {
    const g: GuestTake = {
      id: 'g1',
      from: 'rectory1',
      status: 'running',
      queuePosition: 0,
      progress: 0.42,
      quality: null,
      createdAt: '2026-10-23T12:00:00.000Z',
    };
    const snap = {
      projects: [],
      shots: [],
      takes: [],
      exports: [],
      engine: { url: 'http://127.0.0.1:8188' },
      hf: {},
      choir: { use: 'local', devices: [], sharing: { on: true, url: null, paired: 1, problem: null } },
      guests: [g],
    } as unknown as Snapshot;
    const director: Who = {
      kind: 'person',
      person: { id: 'p1', name: 'Ada', role: 'director' },
      session: 's',
    };
    const owner: Who = { kind: 'person', person: { id: 'p0', name: 'Don', role: 'owner' }, session: 's' };
    expect(snapshotFor({ kind: 'local' }, snap).guests).toEqual([g]);
    expect(snapshotFor(owner, snap).guests).toEqual([g]);
    expect(snapshotFor(director, snap).guests).toEqual([{ ...g, from: null }]);
    const filter = eventFilter(() => undefined, new Set());
    expect(filter(director, { type: 'guests', guests: [g] })).toEqual({
      type: 'guests',
      guests: [{ ...g, from: null }],
    });
  });
});

// ── Two servers in one process: a GPU device sharing, and a computer without one joined to it ─────────────────────

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const memorySecrets = () => {
  const stores = new Map<string, SecretStore>();
  return (account: string) => {
    if (!stores.has(account)) stores.set(account, memoryStore());
    return stores.get(account)!;
  };
};
async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

let gpu: Running;
let mac: Running;
let shareUrl: string;
let token: string;
const post = (srv: Running, path: string, body?: unknown) =>
  fetch(srv.url + path, {
    method: 'POST',
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const request = (prompt: string) => ({
  prompt,
  rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
  format: { quality: 'draft', seconds: 3 },
});

beforeAll(async () => {
  gpu = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-node-'))]), port: 0 },
    { fakeTickMs: 30, secrets: memoryStore(), choirSecrets: memorySecrets() },
  );
  // The Mac: no GPU, no ComfyUI installed.
  mac = await startServer(
    { ...parseArgs(['--data', mkdtempSync(join(tmpdir(), 'hg-mac-'))]), port: 0 },
    { secrets: memoryStore(), choirSecrets: memorySecrets() },
  );
  await until(() => gpu.scheduler.engineState().online);
  // Paired devices reach the GPU on its own listener, as they would on its Tailscale address.
  const res = await post(gpu, '/api/choir/invite', { url: `http://127.0.0.1:${await freePort()}` });
  expect(res.status).toBe(200);
  const invite = (await res.json()) as { code: string; url: string };
  shareUrl = invite.url;
  token = parseJoinCode(invite.code).token;
  const joined = await post(mac, '/api/choir/join', { code: invite.code });
  expect(joined.status).toBe(201);
}, 30_000);
afterAll(async () => {
  await mac?.close();
  await gpu?.close();
});

describe('rendering on another device', () => {
  it('shares without a problem: an invite’s own sync and the one its change sets off never race for the port', async () => {
    const choir = async () =>
      ((await (await fetch(`${gpu.url}/api/choir`, { headers: H })).json()) as ChoirState).sharing;
    expect(await choir()).toMatchObject({ on: true, problem: null });
    expect((await post(gpu, '/api/choir/invite', { url: shareUrl })).status).toBe(200);
    expect(await choir()).toMatchObject({ on: true, problem: null });
  });

  it('keeps only the key’s hash on the sharing device and the key in the joined one’s secret store', () => {
    const file = readFileSync(join(gpu.config.dataDir, 'choir', 'sharing.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toContain(hashToken(token));
    // Windows has no POSIX modes; the file sits in the owner's own profile there.
    if (process.platform !== 'win32')
      expect(statSync(join(gpu.config.dataDir, 'choir', 'sharing.json')).mode & 0o077).toBe(0);
    expect(readFileSync(join(mac.config.dataDir, 'choir', 'devices.json'), 'utf8')).not.toContain(token);
  });

  it('switches the computer without ComfyUI to the device it joined, naming it, with its models', async () => {
    await until(() => mac.scheduler.engineState().online);
    const snap = (await (await fetch(`${mac.url}/api/snapshot`)).json()) as Snapshot;
    expect(snap.choir.use).toBe(snap.choir.devices[0]!.name);
    expect(snap.engine).toMatchObject({ comfy: 'remote', online: true, fake: true, problem: null });
    expect(snap.engine.device).toBe(`${snap.choir.use} · Stand-in`);
    // The stand-in renders any model, so every one counts as there: nothing asks to download it here.
    expect(snap.models.every((m) => m.installed)).toBe(true);
    // Fit is the GPU's that renders: the stand-in has none to judge by.
    expect(snap.models.map((m) => m.fit)).toEqual(snap.models.map(() => null));
    expect(snap.choir.devices[0]!.fit).toEqual(Object.fromEntries(snap.models.map((m) => [m.id, null])));
    const install = await post(mac, '/api/models/wan-2-2-ti2v-5b/install', { acceptLicense: true });
    expect(install.status).toBe(409);
    expect(((await install.json()) as { error: string }).error).toContain(snap.choir.use);
  });

  it('renders a take end to end there, with progress, and the video lands here', async () => {
    const events: string[] = [];
    const off = mac.store.on((e) => {
      if (e.type === 'take' && e.take.status === 'running' && e.take.progress?.value)
        events.push(`progress ${e.take.progress.value}`);
    });
    const res = await post(mac, '/api/shots', { request: request('A ferry crosses a grey harbour at dawn') });
    expect(res.status).toBe(201);
    const { takes } = (await res.json()) as { takes: Take[] };
    const id = takes[0]!.id;
    await until(() => mac.store.takes.get(id)?.status === 'done');
    off();
    const t = mac.store.takes.get(id)!;
    expect(t.video).toBe(`/media/${id}.mp4`);
    expect(t.bytes).toBeGreaterThan(1000);
    expect(existsSync(join(mac.config.dataDir, 'media', `${id}.mp4`))).toBe(true);
    expect(events.length).toBeGreaterThan(1);
    expect(t.poster).toBe(`/media/${id}.jpg`);
    // Nothing is left behind on the GPU device once the video has been fetched.
    expect(gpu.store.takes.size).toBe(0);
  });

  it('sends the start frame along with the take', async () => {
    const jpg = readFileSync(new URL('../../../packages/comfy/fixtures/preview.jpg', import.meta.url));
    const up = await fetch(`${mac.url}/api/uploads`, {
      method: 'POST',
      headers: { 'x-hildegard': '1' },
      body: jpg,
    });
    const { name } = (await up.json()) as { name: string };
    const res = await post(mac, '/api/shots', {
      request: { ...request('A lantern swings in the wind'), startFrame: name },
    });
    const { takes } = (await res.json()) as { takes: Take[] };
    await until(() => mac.store.takes.get(takes[0]!.id)?.status === 'done');
  });

  it('cancels a render there when the take is canceled here', async () => {
    gpu.scheduler.setPaused(false);
    const res = await post(mac, '/api/shots', {
      request: request('A long slow pan across a field of barley'),
    });
    const { takes } = (await res.json()) as { takes: Take[] };
    const id = takes[0]!.id;
    await until(() => (mac.store.takes.get(id)?.progress?.value ?? 0) > 0.1);
    expect(gpu.scheduler.load()).toBe(1);
    expect((await post(mac, `/api/takes/${id}/cancel`)).status).toBe(200);
    await until(() => mac.store.takes.get(id)?.status === 'canceled');
    await until(() => gpu.scheduler.load() === 0);
  });

  it('queues a paired render behind the device’s own takes, never alongside', async () => {
    gpu.scheduler.setPaused(true);
    const own = await post(gpu, '/api/shots', { request: request('A candle gutters in a stone window') });
    const ownTake = ((await own.json()) as { takes: Take[] }).takes[0]!;
    const res = await post(mac, '/api/shots', { request: request('Rain on a tin roof, close up') });
    const remote = ((await res.json()) as { takes: Take[] }).takes[0]!;
    await until(() => gpu.scheduler.load() === 2);
    gpu.scheduler.setPaused(false);
    await until(() => gpu.store.takes.get(ownTake.id)?.status === 'running');
    expect(mac.store.takes.get(remote.id)?.status).not.toBe('done');
    await until(() => mac.store.takes.get(remote.id)?.status === 'done');
    expect(gpu.store.takes.get(ownTake.id)?.status).toBe('done');
  });

  it('shows a paired device’s render in the GPU computer’s own snapshot and events, by name, without its prompt', async () => {
    const lists: GuestTake[][] = [];
    const off = gpu.store.on((e) => {
      if (e.type === 'guests') lists.push(e.guests);
    });
    const snap = async () => (await (await fetch(`${gpu.url}/api/snapshot`)).json()) as Snapshot;
    expect((await snap()).guests).toEqual([]);
    gpu.scheduler.setPaused(true);
    const res = await post(mac, '/api/shots', { request: request('A secret about the orchard at night') });
    const remote = ((await res.json()) as { takes: Take[] }).takes[0]!;
    await until(async () => (await snap()).guests.length === 1);
    // A take of the GPU computer's own, asked for after it, waits behind it, and the reason is on screen.
    const own = await post(gpu, '/api/shots', { request: request('Moths around a porch light') });
    const ownTake = ((await own.json()) as { takes: Take[] }).takes[0]!;
    const waiting = await snap();
    expect(waiting.guests).toEqual([
      {
        id: expect.any(String),
        from: guestName(mac.choir.sharingName()),
        status: 'queued',
        queuePosition: 0,
        progress: null,
        quality: 'draft',
        createdAt: expect.any(String),
      },
    ]);
    expect(waiting.takes.find((t) => t.id === ownTake.id)?.queuePosition).toBe(1);
    expect(JSON.stringify(waiting)).not.toContain('orchard');

    gpu.scheduler.setPaused(false);
    await until(() => mac.store.takes.get(remote.id)?.status === 'done');
    off();
    const running = lists.flat().filter((g) => g.status === 'running');
    expect(running.length).toBeGreaterThan(1);
    expect(running.every((g) => g.from === guestName(mac.choir.sharingName()) && g.queuePosition === 0)).toBe(
      true,
    );
    const progress = running.map((g) => g.progress ?? 0);
    expect(Math.max(...progress)).toBeGreaterThan(0);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));
    // Gone once it is done.
    expect(lists.at(-1)).toEqual([]);
    expect((await snap()).guests).toEqual([]);
    await until(() => gpu.store.takes.get(ownTake.id)?.status === 'done');
  });
});

describe('the sharing device’s door', () => {
  const node = (path: string, init: RequestInit = {}, key = token) =>
    fetch(shareUrl + path, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });

  it('answers a paired device, and a wrong or missing key gets 401', async () => {
    expect((await node('/api/node/info')).status).toBe(200);
    expect((await node('/api/node/info', {}, newToken())).status).toBe(401);
    expect((await fetch(`${shareUrl}/api/node/info`)).status).toBe(401);
    expect(
      (await fetch(`${gpu.url}/api/node/info`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
  });

  it('never serves the Studio or its API, key or not', async () => {
    for (const p of ['/api/snapshot', '/api/events', '/api/choir', '/', '/media/x.mp4'])
      expect((await node(p)).status, p).toBe(404);
    expect((await node('/api/shots', { method: 'POST', headers: H, body: '{}' })).status).toBe(404);
    expect((await node('/api/choir/invite', { method: 'POST', headers: H, body: '{}' })).status).toBe(404);
    // On the main listener the key opens nothing either: the Studio still wants its own header.
    expect(
      (
        await fetch(`${gpu.url}/api/projects`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });

  it('refuses graphs Hildegard never builds', async () => {
    const send = (built: unknown) =>
      node('/api/node/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ built }),
      });
    const evil = await send({
      graph: {
        1: { class_type: 'PythonExec', inputs: { code: 'import os' } },
        2: { class_type: 'SaveVideo', inputs: { video: ['1', 0], filename_prefix: 'x', format: 'mp4' } },
      },
      outputNode: '2',
    });
    expect(evil.status).toBe(422);
    expect(JSON.stringify(await evil.json())).toContain('PythonExec, which Hildegard never uses');
    expect((await send({ graph: 'nope' })).status).toBe(400);
    // Refused on its declared length, before a byte of it is read. Sending the whole body would race the refusal
    // (the server hangs up mid-upload), so this declares one and sends nothing.
    const big = await new Promise<{ status?: number; connection?: string }>((resolve, reject) => {
      const req = httpRequest(`${shareUrl}/api/node/render`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(31 * 1024 * 1024),
        },
      });
      req.on('response', (res) => {
        res.resume();
        resolve({ status: res.statusCode, connection: res.headers.connection });
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(big).toEqual({ status: 413, connection: 'close' });
  });

  it('serves a finished video only once, to a paired device', async () => {
    expect((await node('/api/node/media/0123456789abcdef0123456789abcdef')).status).toBe(404);
    expect((await node('/api/node/media/../../state.json')).status).toBe(404);
  });

  it('turns away paired devices once sharing is revoked, and the joined computer says so', async () => {
    expect((await post(gpu, '/api/choir/revoke')).status).toBe(200);
    // The door itself closes, and the key opens nothing on the main listener either.
    await expect(node('/api/node/info')).rejects.toThrow();
    expect(
      (await fetch(`${gpu.url}/api/node/info`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    const engine = new RemoteEngine({ name: 'parish1', url: gpu.url, token: () => token });
    await expect(engine.info()).rejects.toThrow('parish1 no longer accepts this computer.');
    await until(async () => {
      const s = (await (await fetch(`${mac.url}/api/choir`)).json()) as ChoirState;
      return !!s.devices[0]?.problem && !s.devices[0].online;
    });
    // Back to this computer, and leaving forgets the device.
    expect((await post(mac, '/api/choir/use', { name: 'local' })).status).toBe(200);
    expect(mac.scheduler.engineState().comfy).toBe('not-installed');
    const name = mac.choir.state().devices[0]!.name;
    expect((await post(mac, '/api/choir/leave', { name })).status).toBe(200);
    expect(mac.choir.state().devices).toEqual([]);
  });
});

describe('pairing', () => {
  it('says a code with the wrong key was never good, and pairs nothing', async () => {
    const real = (await (await post(gpu, '/api/choir/invite', { url: shareUrl })).json()) as { code: string };
    const forged = encodeJoinCode({ ...parseJoinCode(real.code), token: newToken() });
    const r = await post(mac, '/api/choir/join', { code: forged });
    expect(r.status).toBe(403);
    const { error } = (await r.json()) as { error: string };
    expect(error).toMatch(/doesn’t accept that code\. On \S+, open Settings › Devices/);
    expect(mac.choir.state().devices).toEqual([]);
  });

  it('takes a key the other device made, so it can build the same code itself, and refuses one that isn’t a key', async () => {
    const key = newToken();
    const r = await post(gpu, '/api/choir/invite', { url: shareUrl, key });
    expect(r.status).toBe(200);
    const { code } = (await r.json()) as { code: string };
    expect(parseJoinCode(code).token).toBe(key);
    // The device that made the key builds the very same code without being sent it.
    expect(encodeJoinCode({ ...parseJoinCode(code), token: key })).toBe(code);
    const file = readFileSync(join(gpu.config.dataDir, 'choir', 'sharing.json'), 'utf8');
    expect(file).not.toContain(key);
    expect(file).toContain(hashToken(key));
    expect((await post(gpu, '/api/choir/invite', { url: shareUrl, key: 'short' })).status).toBe(400);
  });

  it('refuses a computer’s own code, and addresses outside the tailnet', async () => {
    const own = (await (await post(gpu, '/api/choir/invite', { url: shareUrl })).json()) as { code: string };
    const r = await post(gpu, '/api/choir/join', { code: own.code });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain('own code');
    await post(gpu, '/api/choir/revoke');
    expect((await post(gpu, '/api/choir/invite', { url: 'http://192.168.1.4:7341' })).status).toBe(400);
    // The Studio asks first whether Tailscale is up, so it can ask for an address instead.
    const t = (await (await fetch(`${gpu.url}/api/choir/tailnet`)).json()) as { url: string | null };
    expect(t.url === null || /^http:\/\/100\./.test(t.url)).toBe(true);
  });
});
