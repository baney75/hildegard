// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChoirDevice, ChoirState, GuestTake, Snapshot, Take } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventFilter, snapshotFor, type Who } from '../src/access.ts';
import { busyCheck, busyFrom, nvidiaPercent } from '../src/busy.ts';
import {
  Choir,
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
import { guestName, MAX_RENDER_BODY } from '../src/node-api.ts';
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
      characters: [],
      stills: [],
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
/** Updates the GPU device started: a newer release is always out for it. */
let gpuUpdates = 0;
/** What the GPU device's stand-in says when asked whether something else is using it. */
let gpuBusy = false;
let gpuData: string;
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
  gpuData = mkdtempSync(join(tmpdir(), 'hg-node-'));
  gpu = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', gpuData]), port: 0 },
    {
      fakeTickMs: 30,
      hostBusy: async () => gpuBusy,
      busyRecheckMs: 100,
      busySettleMs: 50,
      secrets: memoryStore(),
      choirSecrets: memorySecrets(),
      updates: {
        fetch: (async () => Response.json({ version: '9.9.9' })) as typeof fetch,
        run: () => gpuUpdates++,
        firstMs: 3_600_000,
        idleMs: 3_600_000,
      },
    },
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
    const queuedAt = Date.now();
    await new Promise((r) => setTimeout(r, 1200));
    gpu.scheduler.setPaused(false);
    await until(() => gpu.store.takes.get(ownTake.id)?.status === 'running');
    expect(mac.store.takes.get(remote.id)?.status).not.toBe('done');
    await until(() => mac.store.takes.get(remote.id)?.status === 'done');
    expect(gpu.store.takes.get(ownTake.id)?.status).toBe('done');
    // Its render time is the GPU's work on it, not its wait in the line.
    const waitedAndRendered = Date.now() - queuedAt;
    expect(mac.store.takes.get(remote.id)?.renderMs).toBeLessThan(waitedAndRendered - 1200);
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

describe('sharing only when the GPU device is free', () => {
  const opp = async (on: boolean) => {
    const res = await post(gpu, '/api/choir/opportunistic', { on });
    expect(res.status).toBe(200);
    return (await res.json()) as ChoirState;
  };
  const guestStatus = () => gpu.scheduler.guestTakes()[0]?.status ?? null;

  it('is off until the owner turns it on, and stays as set across restarts and revokes', async () => {
    expect(
      ((await (await fetch(`${gpu.url}/api/choir`, { headers: H })).json()) as ChoirState).sharing
        .opportunistic,
    ).toBe(false);
    expect((await opp(true)).sharing.opportunistic).toBe(true);
    const again = new Choir({ dataDir: gpuData, secrets: memorySecrets(), onChange: () => {} });
    expect(again.opportunistic).toBe(true);
    // Revoking and inviting again drop or add keys, never this setting.
    const lone = mkdtempSync(join(tmpdir(), 'hg-opp-'));
    const one = new Choir({ dataDir: lone, secrets: memorySecrets(), onChange: () => {} });
    one.setOpportunistic(true);
    one.invite('http://127.0.0.1:7999', 'lone');
    one.revoke();
    one.invite('http://127.0.0.1:7999', 'lone');
    expect(new Choir({ dataDir: lone, secrets: memorySecrets(), onChange: () => {} }).opportunistic).toBe(
      true,
    );
    expect((await post(gpu, '/api/choir/opportunistic', { on: 'yes' })).status).toBe(400);
    expect((await opp(false)).sharing.opportunistic).toBe(false);
  });

  it('puts a paired device’s render behind this computer’s own work, even one that came later', async () => {
    await opp(true);
    try {
      gpu.scheduler.setPaused(true);
      const res = await post(mac, '/api/shots', { request: request('Wind in a wheat field at dusk') });
      const remote = ((await res.json()) as { takes: Take[] }).takes[0]!;
      await until(() => guestStatus() === 'queued');
      const own = await post(gpu, '/api/shots', { request: request('A bell rope sways in an empty tower') });
      const ownTake = ((await own.json()) as { takes: Take[] }).takes[0]!;
      gpu.scheduler.setPaused(false);
      await until(() => gpu.store.takes.get(ownTake.id)?.status === 'running');
      expect(guestStatus()).toBe('queued');
      await until(() => mac.store.takes.get(remote.id)?.status === 'done');
      expect(gpu.store.takes.get(ownTake.id)?.status).toBe('done');
    } finally {
      await opp(false);
    }
  });

  it('stops a paired device’s render when this computer’s own work arrives, and finishes it afterwards', async () => {
    await opp(true);
    try {
      const res = await post(mac, '/api/shots', {
        request: {
          ...request('Candles lit one by one down a nave'),
          format: { quality: 'final', seconds: 5 },
        },
      });
      const remote = ((await res.json()) as { takes: Take[] }).takes[0]!;
      await until(() => guestStatus() === 'running');
      const own = await post(gpu, '/api/shots', { request: request('Dust in a shaft of light') });
      const ownTake = ((await own.json()) as { takes: Take[] }).takes[0]!;
      await until(() => gpu.store.takes.get(ownTake.id)?.status === 'running');
      expect(guestStatus()).toBe('queued');
      await until(() => gpu.store.takes.get(ownTake.id)?.status === 'done');
      await until(() => mac.store.takes.get(remote.id)?.status === 'done', 30_000);
    } finally {
      await opp(false);
    }
  }, 45_000);

  it('waits while something else uses the computer, and starts once it’s free', async () => {
    await opp(true);
    gpuBusy = true;
    try {
      const res = await post(mac, '/api/shots', { request: request('Snow settling on a lychgate') });
      const remote = ((await res.json()) as { takes: Take[] }).takes[0]!;
      await until(() => guestStatus() === 'queued');
      await new Promise((r) => setTimeout(r, 600));
      expect(guestStatus()).toBe('queued');
      gpuBusy = false;
      await until(() => mac.store.takes.get(remote.id)?.status === 'done');
    } finally {
      gpuBusy = false;
      await opp(false);
    }
  });

  it('stops a paired device’s render for speech, a retried take, or the mode turned on, and never to sit idle', async () => {
    const final = (prompt: string) => ({ ...request(prompt), format: { quality: 'final', seconds: 5 } });
    const sendAndRun = async (prompt: string) => {
      const res = await post(mac, '/api/shots', { request: final(prompt) });
      const t = ((await res.json()) as { takes: Take[] }).takes[0]!;
      await until(() => guestStatus() === 'running');
      return t;
    };
    await opp(true);
    try {
      // Speech (a lease) on this computer.
      let remote = await sendAndRun('Bells across a valley at noon');
      const release = await gpu.scheduler.lease();
      expect(guestStatus()).toBe('queued');
      release();
      await until(() => mac.store.takes.get(remote.id)?.status === 'done', 30_000);

      // A take of this computer's own that failed, retried.
      const failed = await post(gpu, '/api/shots', { request: request('A lamp flickers [fail:node]') });
      const bad = ((await failed.json()) as { takes: Take[] }).takes[0]!;
      await until(() => gpu.store.takes.get(bad.id)?.status === 'failed');
      remote = await sendAndRun('Leaves turning on a pond');
      expect((await post(gpu, `/api/takes/${bad.id}/retry`)).status).toBeLessThan(300);
      await until(() => guestStatus() === 'queued');
      await until(() => mac.store.takes.get(remote.id)?.status === 'done', 30_000);

      // Paused here: a new take of its own can't start, so the paired render keeps going.
      remote = await sendAndRun('Fog lifting off a harbour');
      gpu.scheduler.setPaused(true);
      const own = await post(gpu, '/api/shots', { request: request('A clock face at dawn') });
      const ownTake = ((await own.json()) as { takes: Take[] }).takes[0]!;
      await new Promise((r) => setTimeout(r, 300));
      expect(guestStatus()).toBe('running');
      // Unpaused, it yields to that take.
      gpu.scheduler.setPaused(false);
      await until(() => gpu.store.takes.get(ownTake.id)?.status === 'running');
      await until(() => mac.store.takes.get(remote.id)?.status === 'done', 30_000);
    } finally {
      await opp(false);
    }

    // Paused, speech still gets the GPU: a lease stops the paired render even then.
    await opp(true);
    try {
      const remote = await sendAndRun('Wind chimes on a porch');
      gpu.scheduler.setPaused(true);
      const release = await gpu.scheduler.lease();
      expect(guestStatus()).toBe('queued');
      release();
      gpu.scheduler.setPaused(false);
      await until(() => mac.store.takes.get(remote.id)?.status === 'done', 30_000);
    } finally {
      gpu.scheduler.setPaused(false);
      await opp(false);
    }

    // Off, with its own take waiting: turning it on stops the paired render for that take.
    const remote = await sendAndRun('Sparks from a forge');
    gpu.scheduler.setPaused(true);
    const own = await post(gpu, '/api/shots', { request: request('Rain on slate'), priority: 'agent' });
    const ownTake = ((await own.json()) as { takes: Take[] }).takes[0]!;
    gpu.scheduler.setPaused(false);
    expect(guestStatus()).toBe('running');
    await opp(true);
    try {
      await until(() => gpu.store.takes.get(ownTake.id)?.status === 'running');
      await until(() => mac.store.takes.get(remote.id)?.status === 'done', 30_000);
    } finally {
      await opp(false);
    }
  }, 120_000);

  it('runs renders straight away when it’s off, busy or not', async () => {
    gpuBusy = true;
    try {
      const res = await post(mac, '/api/shots', { request: request('A kettle steams on a range') });
      const remote = ((await res.json()) as { takes: Take[] }).takes[0]!;
      await until(() => mac.store.takes.get(remote.id)?.status === 'done');
    } finally {
      gpuBusy = false;
    }
  });

  it('counts the computer busy from GPU use or load per core', async () => {
    expect(busyFrom({ gpuPercent: 45, load1: 0, cores: 8 })).toBe(true);
    expect(busyFrom({ gpuPercent: 5, load1: 1, cores: 8 })).toBe(false);
    expect(busyFrom({ gpuPercent: null, load1: 7, cores: 8 })).toBe(true);
    expect(busyFrom({ gpuPercent: null, load1: 0, cores: 0 })).toBe(false);
    const said = (out: string | null) =>
      ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) =>
        out === null ? cb(new Error('no nvidia-smi'), '') : cb(null, out)) as unknown as Parameters<
        typeof nvidiaPercent
      >[0];
    expect(await nvidiaPercent(said('3\n71\n'))).toBe(71);
    // No nvidia-smi: no NVIDIA GPU. One that fails or says nothing usable: unknown, which counts as busy.
    const missing = ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) =>
      cb(
        Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }),
        '',
      )) as unknown as Parameters<typeof nvidiaPercent>[0];
    expect(await nvidiaPercent(missing)).toBe(null);
    // Stuck for good: it gives up on its own deadline.
    const stuck = (() => {}) as unknown as Parameters<typeof nvidiaPercent>[0];
    await expect(nvidiaPercent(stuck)).rejects.toThrow(/in time/);
    await expect(nvidiaPercent(said('[N/A]\n'))).rejects.toThrow();
    await expect(nvidiaPercent(said(null))).rejects.toThrow();
    expect(await busyCheck('linux', said('12\n'))).toBe('gpu+load');
    expect(await busyCheck('linux', said(null))).toBe('gpu-unknown');
    expect(await busyCheck('linux', missing)).toBe('load');
    expect(await busyCheck('darwin', missing)).toBe('load');
    expect(await busyCheck('win32', missing)).toBe('none');
  });
});

describe('updating another of your devices', () => {
  it('shows its version, and updates it from here to the newest release, once', async () => {
    const choir = (await (await fetch(`${mac.url}/api/choir`, { headers: H })).json()) as ChoirState;
    const name = choir.devices[0]!.name;
    expect(choir.devices[0]!.update).toMatchObject({ applying: false, updatable: true, waiting: false });
    const res = await post(mac, '/api/choir/update', { name });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { device: ChoirDevice }).device.update).toMatchObject({
      available: '9.9.9',
      applying: true,
    });
    expect(gpuUpdates).toBe(1);
    // Asking again while it updates starts nothing more.
    expect((await post(mac, '/api/choir/update', { name })).status).toBe(200);
    expect(gpuUpdates).toBe(1);
    expect((await post(mac, '/api/choir/update', { name: 'nope' })).status).toBe(404);
  });

  it('takes the request only with a paired device’s key', async () => {
    const res = await fetch(`${shareUrl}/api/node/update`, {
      method: 'POST',
      headers: { authorization: `Bearer ${newToken()}` },
    });
    expect(res.status).toBe(401);
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
          'content-length': String(MAX_RENDER_BODY + 1024 * 1024),
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
