// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newer, UPDATE_KEY, Updates, verifySigned } from '../src/update.ts';

// Signed by `tauri signer sign` with a throwaway key, as releases sign theirs with the real one.
const dir = fileURLToPath(new URL('./fixtures/update/', import.meta.url));
const read = (f: string) => readFileSync(join(dir, f));
const KEY = read('test.key.pub').toString('utf8');
const desktopKey = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
  ) as { plugins: { updater: { pubkey: string } } }
).plugins.updater.pubkey;

describe('versions', () => {
  it('compares by number', () => {
    expect(newer('0.1.10', '0.1.9')).toBe(true);
    expect(newer('0.2.0', '0.1.99')).toBe(true);
    expect(newer('0.1.4', '0.1.4')).toBe(false);
    expect(newer('0.1.3', '0.1.4')).toBe(false);
  });
});

describe('signatures', () => {
  it('accepts a file signed with the key, and returns what the signature says about it', () => {
    expect(verifySigned(read('install.sh'), read('install.sh.sig').toString(), KEY)).toMatch(
      /\tfile:install\.sh$/,
    );
  });

  it('refuses a changed file, another file’s signature, and another key', () => {
    const sh = read('install.sh');
    const sig = read('install.sh.sig').toString();
    expect(() => verifySigned(Buffer.concat([sh, Buffer.from('rm -rf ~\n')]), sig, KEY)).toThrow(
      /doesn’t match/,
    );
    expect(() => verifySigned(sh, read('install.ps1.sig').toString(), KEY)).toThrow(/doesn’t match/);
    expect(() => verifySigned(sh, sig, UPDATE_KEY)).toThrow(/another key/);
    expect(() => verifySigned(sh, 'not a signature', KEY)).toThrow(/malformed/);
  });

  it('refuses a signature whose trusted comment was changed', () => {
    const lines = Buffer.from(read('install.sh.sig').toString(), 'base64').toString().split('\n');
    lines[2] = lines[2]!.replace('file:install.sh', 'file:other.sh');
    const forged = Buffer.from(lines.join('\n')).toString('base64');
    expect(() => verifySigned(read('install.sh'), forged, KEY)).toThrow(/comment was changed/);
  });

  it('uses the key the desktop app’s updater checks', () => {
    expect(UPDATE_KEY).toBe(desktopKey);
  });
});

function watcher(opts: { latest?: string; busy?: boolean; updatable?: boolean; dataDir?: string } = {}) {
  const runs: number[] = [];
  const changes: unknown[] = [];
  let busy = opts.busy ?? false;
  const u = new Updates({
    dataDir: opts.dataDir ?? mkdtempSync(join(tmpdir(), 'hg-update-')),
    version: '0.1.5',
    updatable: opts.updatable ?? true,
    busy: () => busy,
    run: () => runs.push(Date.now()),
    onChange: (s) => changes.push(s),
    fetch: (async () =>
      opts.latest
        ? Response.json({ version: opts.latest })
        : new Response('', { status: 404 })) as typeof fetch,
  });
  return { u, runs, changes, setBusy: (b: boolean) => (busy = b) };
}

describe('Updates', () => {
  it('finds a newer release and updates once, while nothing renders', async () => {
    const { u, runs } = watcher({ latest: '0.1.6' });
    expect(await u.check()).toMatchObject({
      current: '0.1.5',
      available: '0.1.6',
      applying: true,
      auto: true,
    });
    await u.check();
    expect(runs).toHaveLength(1);
  });

  it('waits while something renders', async () => {
    const w = watcher({ latest: '0.1.6', busy: true });
    expect(await w.u.check()).toMatchObject({ available: '0.1.6', applying: false });
    expect(w.runs).toHaveLength(0);
    w.setBusy(false);
    await w.u.check();
    expect(w.runs).toHaveLength(1);
  });

  it('with automatic updates off, only says so, and the choice is kept', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hg-update-'));
    const w = watcher({ latest: '0.1.6', dataDir });
    w.u.setAuto(false);
    expect(await w.u.check()).toMatchObject({ available: '0.1.6', auto: false, applying: false });
    expect(w.runs).toHaveLength(0);
    expect(watcher({ dataDir }).u.state().auto).toBe(false);
    expect(w.u.apply()).toBeNull();
    expect(w.runs).toHaveLength(1);
  });

  it('offers nothing for the same or an older release, and says why a check failed', async () => {
    expect(await watcher({ latest: '0.1.5' }).u.check()).toMatchObject({ available: null, error: null });
    expect(await watcher({ latest: '0.1.4' }).u.check()).toMatchObject({ available: null });
    expect(await watcher().u.check()).toMatchObject({ available: null, error: /doesn’t offer updates yet/ });
  });

  it('updates when another device asks, waiting for a render to finish even with automatic updates off', async () => {
    const w = watcher({ latest: '0.1.6', busy: true });
    w.u.setAuto(false);
    expect(await w.u.request()).toBeNull();
    expect(w.u.state()).toMatchObject({ available: '0.1.6', waiting: true, applying: false });
    expect(w.runs).toHaveLength(0);
    w.setBusy(false);
    await w.u.check();
    expect(w.u.state()).toMatchObject({ waiting: false, applying: true });
    expect(w.runs).toHaveLength(1);
  });

  it('says why another device can’t update it', async () => {
    expect(await watcher({ latest: '0.1.5' }).u.request()).toMatch(/up to date/);
    expect(await watcher().u.request()).toMatch(/doesn’t offer updates|404/);
    expect(await watcher({ latest: '0.1.6', updatable: false }).u.request()).toMatch(/source code/);
  });

  it('never runs an update from a source checkout', async () => {
    const w = watcher({ latest: '0.1.6', updatable: false });
    expect(await w.u.check()).toMatchObject({ available: '0.1.6', applying: false, updatable: false });
    expect(w.u.apply()).toMatch(/source code/);
    expect(w.runs).toHaveLength(0);
  });
});

describe('the update routes', () => {
  it('show the state, check, update now, and turn automatic updates off', async () => {
    const { startServer } = await import('../src/server.ts');
    const { parseArgs } = await import('../src/config.ts');
    const { memoryStore } = await import('./helpers.ts');
    const data = mkdtempSync(join(tmpdir(), 'hg-update-api-'));
    let runs = 0;
    const s = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 },
      {
        secrets: memoryStore(),
        updates: {
          fetch: (async () => Response.json({ version: '99.0.0' })) as unknown as typeof fetch,
          run: () => runs++,
          firstMs: 3_600_000,
        },
      },
    );
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${s.url}${path}`, {
        method,
        headers: { 'x-hildegard': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const snap = (await (await fetch(`${s.url}/api/snapshot`)).json()) as { update: unknown };
      expect(snap.update).toMatchObject({ available: null, auto: true, updatable: true });
      expect((await call('POST', '/api/update')).status).toBe(409);
      expect(await (await call('PUT', '/api/update', { auto: false })).json()).toMatchObject({ auto: false });
      expect((await call('PUT', '/api/update', { auto: 'yes' })).status).toBe(400);
      expect(await (await call('POST', '/api/update/check')).json()).toMatchObject({ available: '99.0.0' });
      expect(runs).toBe(0);
      expect(await (await call('POST', '/api/update')).json()).toMatchObject({ applying: true });
      expect(runs).toBe(1);
    } finally {
      await s.close();
    }
  });
});
