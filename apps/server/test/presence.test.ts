// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChoirState, Take } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snapshotFor, type Who } from '../src/access.ts';
import { type Candidate, place } from '../src/choir.ts';
import { parseArgs } from '../src/config.ts';
import type { SecretStore } from '../src/hf.ts';
import {
  Presence,
  parseComputeApps,
  parseLogind,
  parseMacIdle,
  parseMillis,
  presenceReason,
  systemIdle,
  underUs,
} from '../src/presence.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('seeing whether someone else wants the computer', () => {
  it('reads each system’s idle clock', () => {
    expect(parseMacIdle('    | |   "HIDIdleTime" = 4123456789\n')).toBeCloseTo(4.12, 2);
    expect(parseMacIdle('nothing here')).toBeNull();
    expect(parseMillis('(uint64 90500,)\n')).toBe(90.5);
    expect(parseMillis('2500\n')).toBe(2.5);
    expect(parseMillis(null)).toBeNull();
    const now = 1_800_000_000_000;
    expect(parseLogind('IdleHint=no\nIdleSinceHint=0\n', now)).toBe(0);
    expect(parseLogind(`IdleHint=yes\nIdleSinceHint=${(now - 300_000) * 1000}\n`, now)).toBe(300);
    expect(parseLogind('', now)).toBeNull();
  });

  it('uses the first idle clock that answers on Linux, and none on a computer with no desktop', async () => {
    const asked: string[] = [];
    const idle = systemIdle(async (cmd) => {
      asked.push(cmd);
      return cmd === 'gdbus' ? '(uint64 12000,)' : null;
    }, 'linux');
    expect(await idle()).toBe(12);
    expect(await idle()).toBe(12);
    expect(asked).toEqual(['gdbus', 'gdbus']);
    const headless: string[] = [];
    const none = systemIdle(async (cmd) => {
      headless.push(cmd);
      return null;
    }, 'linux');
    expect(await none()).toBeNull();
    // Not asked again straight away: a server with no desktop doesn't pay for three programs every few seconds.
    const n = headless.length;
    expect(await none()).toBeNull();
    expect(headless).toHaveLength(n);
  });

  it('counts other programs holding GPU memory, never Hildegard’s own', () => {
    const smi = [
      '4242, /usr/bin/python3, 10240',
      '5151, /opt/llama.cpp/llama-server, 20480',
      '6000, /usr/lib/xorg/Xorg, 220',
      '7000, C:\\Games\\game.exe, [N/A]',
    ].join('\n');
    expect(parseComputeApps(smi, (pid) => pid === 4242)).toEqual(['llama-server', 'game.exe']);
    expect(parseComputeApps('', () => false)).toEqual([]);
    expect(parseComputeApps(null, () => false)).toBeNull();
  });

  it('tells Hildegard’s processes by their parents', () => {
    // ComfyUI (300) runs under the server (100); the language model (400) runs under a shell (50).
    const stat: Record<number, string> = {
      300: '300 (python3 (comfy)) S 100 300 300',
      400: '400 (llama-server) S 50 400 400',
      50: '50 (bash) S 1 50 50',
    };
    const read = (p: string) => stat[Number(/\/proc\/(\d+)\/stat/.exec(p)?.[1])] ?? null;
    expect(underUs(300, read, 100)).toBe(true);
    expect(underUs(400, read, 100)).toBe(false);
  });

  it('says why in a sentence: the owner at the keyboard, or another program on the GPU', () => {
    expect(presenceReason(5, [])).toBe('Someone is using this computer.');
    expect(presenceReason(181, [])).toBeNull();
    expect(presenceReason(null, ['qwen3-coder'])).toBe('qwen3-coder is using the GPU.');
    expect(presenceReason(999, ['a', 'b'])).toBe('2 other programs are using the GPU.');
    // A computer that can't see its owner (no desktop) still counts the GPU, and otherwise is free.
    expect(presenceReason(null, [])).toBeNull();
  });

  it('takes an idle hook’s word where the desktop has no idle clock (Hyprland), until it runs out', async () => {
    let t = 0;
    const p = new Presence({ idle: async () => null, now: () => t });
    expect(await p.reason()).toBeNull();
    expect(p.sees).toBe(false);
    p.tell(false);
    expect(await p.reason()).toBe('Someone is using this computer.');
    p.tell(true);
    expect(await p.reason()).toBeNull();
    p.tell(false, 1);
    t += 61_000;
    expect(await p.reason()).toBeNull();
  });
});

describe('placing a take on any free device', () => {
  const c = (name: string, over: Partial<Candidate> = {}): Candidate => ({
    name,
    ready: true,
    opportunistic: false,
    busy: null,
    has: () => true,
    fit: () => 'fits',
    queue: 0,
    ...over,
  });
  const job = (over = {}) => ({ model: 'wan', priority: 'interactive' as const, guest: false, ...over });

  it('prefers a device that’s always shared, then a comfortable fit, then the shorter queue, then this computer', () => {
    expect(place(job(), c('local', { opportunistic: true }), [c('spark')])).toBe('spark');
    expect(place(job(), c('local'), [c('spark')])).toBe('local');
    expect(place(job(), c('local', { fit: () => 'tight' }), [c('spark')])).toBe('spark');
    expect(place(job(), c('local', { queue: 2 }), [c('spark', { queue: 1 })])).toBe('spark');
  });

  it('skips busy devices, ones without the model, and ones it won’t fit', () => {
    const inUse = c('local', { opportunistic: true, busy: 'Someone is using this computer.' });
    expect(place(job(), inUse, [c('spark', { opportunistic: true })])).toBe('spark');
    expect(place(job(), c('local', { has: () => false }), [c('spark')])).toBe('spark');
    expect(place(job(), c('local', { fit: () => 'no' }), [c('spark')])).toBe('spark');
    expect(place(job(), c('local'), [c('spark', { ready: false })])).toBe('local');
  });

  it('renders here when nothing is free, since this computer’s own work never waits, and keeps paired renders here', () => {
    const inUse = c('local', { opportunistic: true, busy: 'x' });
    expect(place(job(), inUse, [c('spark', { busy: 'y' })])).toBe('local');
    expect(place(job(), c('local', { has: () => false }), [c('spark', { busy: 'y' })])).toBe('spark');
    expect(place(job(), null, [])).toBe('local');
    expect(place(job({ guest: true }), inUse, [c('spark')])).toBe('local');
  });
});

describe('who sees why a GPU is busy', () => {
  it('shows directors where takes render, never what runs on another computer', () => {
    const choir: ChoirState = {
      use: 'auto',
      rendering: 'spark',
      devices: [
        {
          name: 'spark',
          url: 'http://100.64.0.2:7341',
          online: true,
          gpu: 'GB10, 113.7 GB',
          version: '0.1.11',
          models: [],
          fit: {},
          fitWhy: {},
          problem: null,
          update: null,
          opportunistic: true,
          busy: 'ollama is using the GPU.',
          queue: 0,
        },
      ],
      sharing: {
        on: true,
        url: 'http://100.64.0.1:7341',
        paired: 1,
        problem: null,
        opportunistic: true,
        busyCheck: 'gpu+load',
        busy: 'llama-server is using the GPU.',
        seesOwner: true,
      },
    };
    const director: Who = {
      kind: 'person',
      person: { id: 'p1', name: 'Ada', role: 'director' },
      session: 's',
    };
    const snap = {
      projects: [],
      shots: [],
      takes: [],
      exports: [],
      engine: { url: '' },
      hf: {},
      choir,
      guests: [],
      characters: [],
      stills: [],
    } as unknown as Parameters<typeof snapshotFor>[1];
    const seen = snapshotFor(director, snap).choir;
    expect(seen.rendering).toBe('spark');
    expect(seen.devices[0]).toMatchObject({ name: 'spark', url: '', busy: null });
    expect(seen.sharing.busy).toBeNull();
    expect(snapshotFor({ kind: 'local' }, snap).choir.sharing.busy).toBe('llama-server is using the GPU.');
  });
});

// ── Two servers with the stand-in GPU: a laptop, and a DGX Spark it pairs with ───────────────────────────────────

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
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
const memorySecrets = () => {
  const stores = new Map<string, SecretStore>();
  return (account: string) => {
    if (!stores.has(account)) stores.set(account, memoryStore());
    return stores.get(account)!;
  };
};
const post = (srv: Running, path: string, body?: unknown) =>
  fetch(srv.url + path, {
    method: 'POST',
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const shot = async (srv: Running, prompt: string, quality = 'draft'): Promise<string> => {
  const res = await post(srv, '/api/shots', {
    request: {
      prompt,
      rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
      format: { quality, seconds: quality === 'final' ? 5 : 3 },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { takes: Take[] }).takes[0]!.id;
};

/** Seconds since each owner last touched their computer, and the other programs holding each GPU's memory. */
const idle = { laptop: 9999, spark: 9999 };
const others = { laptop: [] as string[], spark: [] as string[] };
let laptop: Running;
let spark: Running;
const guest = () => spark.scheduler.guestTakes()[0]?.status ?? null;
const opportunistic = async (srv: Running, on: boolean) =>
  expect((await post(srv, '/api/choir/opportunistic', { on })).status).toBe(200);

beforeAll(async () => {
  const quick = { busyRecheckMs: 60, busySettleMs: 30 };
  spark = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', tmp('hg-spark-')]), port: 0 },
    {
      fakeTickMs: 30,
      secrets: memoryStore(),
      choirSecrets: memorySecrets(),
      presence: { idle: async () => idle.spark, gpu: async () => others.spark, watchMs: 40 },
      ...quick,
    },
  );
  laptop = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', tmp('hg-laptop-')]), port: 0 },
    {
      fakeTickMs: 30,
      secrets: memoryStore(),
      choirSecrets: memorySecrets(),
      presence: { idle: async () => idle.laptop, gpu: async () => others.laptop, watchMs: 40 },
      ...quick,
    },
  );
  await until(() => laptop.scheduler.engineState().online && spark.scheduler.engineState().online);
  const invite = await post(spark, '/api/choir/invite', { url: `http://127.0.0.1:${await freePort()}` });
  expect(invite.status).toBe(200);
  const { code } = (await invite.json()) as { code: string };
  expect((await post(laptop, '/api/choir/join', { code, name: 'spark' })).status).toBe(201);
}, 30_000);
afterAll(async () => {
  await laptop?.close();
  await spark?.close();
});

describe('an opportunistic computer', () => {
  it('stops a paired render within a moment of its owner coming back, and finishes it once they leave', async () => {
    expect((await post(laptop, '/api/choir/use', { name: 'spark' })).status).toBe(200);
    await opportunistic(spark, true);
    try {
      const id = await shot(laptop, 'A heron lifts off a still pond', 'final');
      await until(() => guest() === 'running');
      const backAt = Date.now();
      idle.spark = 1;
      await until(() => guest() === 'queued');
      // Well inside the couple of seconds the release notes promise (the stand-in looks every 40 ms).
      expect(Date.now() - backAt).toBeLessThan(2000);
      expect(spark.choir.state().sharing.busy).toBe('Someone is using this computer.');
      await new Promise((r) => setTimeout(r, 300));
      expect(guest()).toBe('queued');
      idle.spark = 9999;
      await until(() => laptop.store.takes.get(id)?.status === 'done', 30_000);
      await until(() => spark.choir.state().sharing.busy === null);
    } finally {
      idle.spark = 9999;
      await opportunistic(spark, false);
    }
  }, 45_000);

  it('waits for a language model holding the GPU, as on parish1, and stays online meanwhile', async () => {
    await opportunistic(spark, true);
    others.spark = ['qwen3-coder'];
    try {
      const id = await shot(laptop, 'Snow settles on a red tin roof');
      await until(() => guest() === 'queued');
      await new Promise((r) => setTimeout(r, 300));
      expect(guest()).toBe('queued');
      expect(spark.choir.state().sharing.busy).toBe('qwen3-coder is using the GPU.');
      expect(spark.scheduler.engineState().online).toBe(true);
      // The paired laptop hears why, too.
      await laptop.choir.refresh();
      expect(laptop.choir.state().devices[0]).toMatchObject({
        opportunistic: true,
        busy: 'qwen3-coder is using the GPU.',
      });
      others.spark = [];
      await until(() => laptop.store.takes.get(id)?.status === 'done');
    } finally {
      others.spark = [];
      await opportunistic(spark, false);
    }
  });

  it('runs paired renders straight away when it isn’t opportunistic, owner or not', async () => {
    idle.spark = 1;
    try {
      const id = await shot(laptop, 'Wind combs a field of wheat');
      await until(() => laptop.store.takes.get(id)?.status === 'done');
      expect(spark.choir.state().sharing.busy).toBeNull();
    } finally {
      idle.spark = 9999;
    }
  });
});

describe('any free device', () => {
  it('sends each take to the free one: the Spark while the laptop is in use, the laptop while the Spark is', async () => {
    expect((await post(laptop, '/api/choir/use', { name: 'auto' })).status).toBe(200);
    try {
      // The laptop's owner is at it: its take goes to the Spark.
      await opportunistic(laptop, true);
      idle.laptop = 1;
      await until(() => laptop.choir.state().sharing.busy !== null);
      await laptop.choir.refresh();
      const first = await shot(laptop, 'Fog rolls over a harbour wall');
      await until(() => laptop.store.takes.get(first)?.status === 'done');
      expect(laptop.choir.state().rendering).toBe('spark');

      // Now the Spark is someone's, and the laptop is free: the take stays here.
      await opportunistic(spark, true);
      idle.spark = 1;
      idle.laptop = 9999;
      await until(
        () => spark.choir.state().sharing.busy !== null && laptop.choir.state().sharing.busy === null,
      );
      await laptop.choir.refresh();
      const second = await shot(laptop, 'A lighthouse beam sweeps the rain');
      await until(() => laptop.store.takes.get(second)?.status === 'done');
      expect(laptop.choir.state().rendering).toBe('local');
      expect(spark.scheduler.load()).toBe(0);
    } finally {
      idle.laptop = 9999;
      idle.spark = 9999;
      await opportunistic(spark, false);
      await opportunistic(laptop, false);
      await post(laptop, '/api/choir/use', { name: 'local' });
    }
  }, 45_000);

  it('refuses “auto” as a device’s name', async () => {
    const invite = await post(spark, '/api/choir/invite', { url: `http://127.0.0.1:${await freePort()}` });
    const { code } = (await invite.json()) as { code: string };
    expect((await post(laptop, '/api/choir/join', { code, name: 'auto' })).status).toBe(400);
  });
});

// Last: an idle hook's word holds for a day, over the stand-in idle clock.
describe('an idle hook', () => {
  it('takes an idle hook’s word from this computer only', async () => {
    await opportunistic(spark, true);
    try {
      const back = (await (await post(spark, '/api/choir/presence', { away: false })).json()) as ChoirState;
      expect(back.sharing.busy).toBe('Someone is using this computer.');
      const away = (await (await post(spark, '/api/choir/presence', { away: true })).json()) as ChoirState;
      expect(away.sharing.busy).toBeNull();
      expect((await post(spark, '/api/choir/presence', { away: 'maybe' })).status).toBe(400);
    } finally {
      await opportunistic(spark, false);
    }
  });
});
