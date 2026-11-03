// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChoirInvite, ChoirState } from '@hildegard/presets';
import { afterAll, describe, expect, it } from 'vitest';
import { Choir, ChoirError, parseJoinCode } from '../src/choir.ts';
import {
  CODE_ALPHABET,
  CODE_LIMITS,
  CODE_RE,
  CODE_TTL_MS,
  CodeBook,
  hashCode,
  looksLikeCode,
  newCode,
  normalizeCode,
} from '../src/codes.ts';
import { parseArgs } from '../src/config.ts';
import type { SecretStore } from '../src/hf.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const secrets = () => {
  const stores = new Map<string, SecretStore>();
  return (account: string) => {
    if (!stores.has(account)) stores.set(account, memoryStore());
    return stores.get(account)!;
  };
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const post = (base: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { ...H, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('short codes', () => {
  it('are HG-XXXX-XXXX in Crockford base32, from 40 random bits', () => {
    const seen = new Set<string>();
    const letters = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = newCode();
      expect(c).toMatch(CODE_RE);
      seen.add(c);
      for (const ch of c.replace(/^HG-|-/g, '')) letters.add(ch);
    }
    expect(seen.size).toBe(2000);
    expect(CODE_ALPHABET).toHaveLength(32);
    for (const bad of 'ILOU') expect(CODE_ALPHABET).not.toContain(bad);
    for (const ch of letters) expect(CODE_ALPHABET).toContain(ch);
    // All 40 bits are used: the first symbol takes every value, the last too.
    expect(newCode(() => Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe('HG-ZZZZ-ZZZZ');
    expect(newCode(() => Buffer.from([0, 0, 0, 0, 0]))).toBe('HG-0000-0000');
    expect(newCode(() => Buffer.from([0x08, 0x86, 0x42, 0x98, 0xe8]))).toBe('HG-1234-5678');
  });

  it('are read the way people type them, and nothing else', () => {
    expect(normalizeCode('hg-7k2m-9qxd')).toBe('HG-7K2M-9QXD');
    expect(normalizeCode('  7k2m 9qxd ')).toBe('HG-7K2M-9QXD');
    expect(normalizeCode('HG7K2M9QXD')).toBe('HG-7K2M-9QXD');
    // Crockford: O is 0, I and L are 1.
    expect(normalizeCode('HG-OOIL-ilo0')).toBe('HG-0011-1100');
    for (const bad of [
      '',
      'HG-7K2M-9QX',
      'HG-7K2M-9QXDD',
      'HG-7K2U-9QXD',
      'hgc1_abcdefgh',
      'HG-7K2M-9QX!',
      42,
      null,
    ])
      expect(normalizeCode(bad), String(bad)).toBeNull();
    expect(looksLikeCode('HG-7K2M-9QXD')).toBe(true);
    expect(looksLikeCode(`hgc1_${'A'.repeat(60)}`)).toBe(false);
  });

  it('are kept only as SHA-256, with their expiry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-codes-'));
    const file = join(dir, 'codes.json');
    const book = new CodeBook<{ n: number }>({ file });
    const { code, expiresAt } = book.mint({ n: 1 });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.replace(/^HG-|-/g, ''));
    expect(text).toContain(hashCode(code));
    expect(JSON.parse(text).codes[0]).toMatchObject({ hash: hashCode(code), expiresAt });
    // A restart keeps a live code.
    expect(new CodeBook<{ n: number }>({ file }).take(code)).toEqual({ n: 1 });
  });

  it('last 10 minutes and work once', () => {
    let t = 1_000_000;
    const book = new CodeBook<string>({ now: () => t });
    const a = book.mint('a');
    expect(a.expiresAt - t).toBe(CODE_TTL_MS);
    t += CODE_TTL_MS - 1;
    expect(book.live(a.code)).toBe(true);
    expect(book.take(a.code)).toBe('a');
    expect(book.take(a.code)).toBeNull();
    expect(book.live(a.code)).toBe(false);
    const b = book.mint('b');
    t += CODE_TTL_MS;
    expect(book.live(b.code)).toBe(false);
    expect(book.take(b.code)).toBeNull();
    expect(book.take('HG-0000-0000')).toBeNull();
  });
});

describe('redeeming a short join code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-redeem-'));
  const state: ChoirState[] = [];
  let t = 10_000_000;
  const choir = new Choir({
    dataDir: dir,
    secrets: secrets(),
    onChange: (s) => state.push(s),
    now: () => t,
  });
  const URL_ = 'http://100.64.0.1:7341';

  it('makes no key until redeemed, then gives one that works, once', () => {
    const r = choir.shortInvite(URL_, 'gpu-a');
    expect(r.short.code).toMatch(CODE_RE);
    expect(r.code).toBeNull();
    expect(Date.parse(r.short.expiresAt) - t).toBe(CODE_TTL_MS);
    const file = () => JSON.parse(readFileSync(join(dir, 'choir', 'sharing.json'), 'utf8'));
    expect(file().keys).toEqual([]);
    const joined = choir.redeem(r.short.code.toLowerCase(), 'peer-1', 'laptop');
    expect(joined).toMatchObject({ name: 'gpu-a', url: URL_ });
    expect(choir.accepts(joined.token)).toBe(true);
    const keys = file().keys as { hash: string; for?: string }[];
    expect(keys.length).toBe(1);
    expect(keys[0]?.for).toBe('laptop');
    expect(readFileSync(join(dir, 'choir', 'sharing.json'), 'utf8')).not.toContain(joined.token);
    expect(() => choir.redeem(r.short.code, 'peer-1')).toThrow(/isn’t good/);
  });

  it('makes the long code only when asked, and that one leaves a key', () => {
    const before = JSON.parse(readFileSync(join(dir, 'choir', 'sharing.json'), 'utf8')).keys.length;
    const r = choir.shortInvite(URL_, 'gpu-a', { long: true });
    expect(r.code).toMatch(/^hgc1_/);
    expect(choir.accepts(parseJoinCode(r.code!).token)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'choir', 'sharing.json'), 'utf8')).keys.length).toBe(before + 1);
  });

  it('answers with the sharing address and name as they are now, not as they were when the code was made', () => {
    const a = choir.shortInvite(URL_, 'gpu-a');
    choir.shortInvite('http://100.64.0.7:7341', 'gpu-b');
    const joined = choir.redeem(a.short.code, 'peer-7');
    expect(joined).toMatchObject({ name: 'gpu-b', url: 'http://100.64.0.7:7341' });
    expect(choir.accepts(joined.token)).toBe(true);
    // Redeeming changed neither the address nor the name.
    expect(JSON.parse(readFileSync(join(dir, 'choir', 'sharing.json'), 'utf8'))).toMatchObject({
      name: 'gpu-b',
      url: 'http://100.64.0.7:7341',
    });
    choir.shortInvite(URL_, 'gpu-a');
  });

  it('refuses an expired code, and stops sharing taking its codes with it', () => {
    const a = choir.shortInvite(URL_, 'gpu-a');
    t += CODE_TTL_MS + 1;
    expect(() => choir.redeem(a.short.code, 'peer-2')).toThrow(ChoirError);
    const b = choir.shortInvite(URL_, 'gpu-a');
    choir.revoke();
    expect(() => choir.redeem(b.short.code, 'peer-2')).toThrow(/isn’t good/);
  });

  it('counts wrong codes per source, and across all sources only against a source that already missed', () => {
    const wrong = (src: string) => {
      try {
        choir.redeem('HG-0000-0000', src);
      } catch (e) {
        return (e as ChoirError).status;
      }
      return 200;
    };
    // One source: five wrong tries, then it waits, valid code or not.
    choir.shortInvite(URL_, 'gpu-a');
    const mine = choir.shortInvite(URL_, 'gpu-a').short.code;
    for (let i = 0; i < CODE_LIMITS.perSource; i++) expect(wrong('src-a')).toBe(403);
    expect(wrong('src-a')).toBe(429);
    expect(() => choir.redeem(mine, 'src-a')).toThrow(/Too many wrong codes/);
    // After 60 wrong tries from anywhere, a source that never missed still gets a valid code through...
    for (let i = 0; i < 15; i++) for (let j = 0; j < 4; j++) wrong(`spread-${i}-${j}`);
    const s = choir.shortInvite(URL_, 'gpu-a').short.code;
    expect(choir.redeem(s, 'src-good').name).toBe('gpu-a');
    // ...while one that has missed once is held back, valid code or not.
    expect(wrong('src-missed')).toBe(403);
    const last = choir.shortInvite(URL_, 'gpu-a').short.code;
    expect(() => choir.redeem(last, 'src-missed')).toThrow(/Too many wrong codes/);
    // The window passes and enrolling opens again.
    t += CODE_LIMITS.windowMs + 1;
    const later = choir.shortInvite(URL_, 'gpu-a').short.code;
    expect(choir.redeem(later, 'src-missed').name).toBe('gpu-a');
  });
});

describe('sending a short code', () => {
  const make = (answer: (url: string) => Response) => {
    const urls: string[] = [];
    const choir = new Choir({
      dataDir: mkdtempSync(join(tmpdir(), 'hg-send-')),
      secrets: secrets(),
      onChange: () => {},
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return answer(String(input));
      }) as typeof fetch,
    });
    return { choir, urls };
  };

  it('sends nothing without an address, and says the command to run', async () => {
    const { choir, urls } = make(() => Response.json({}, { status: 200 }));
    await expect(choir.join('HG-0000-0000')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('--url http://<address>:7341'),
    });
    expect(urls).toEqual([]);
  });

  it('sends it to the one address given, and nowhere else', async () => {
    const { choir, urls } = make(() => Response.json({}, { status: 403 }));
    await expect(choir.join('HG-0000-0000', { url: 'http://100.64.0.2:7341' })).rejects.toMatchObject({
      status: 403,
    });
    expect(urls).toEqual(['http://100.64.0.2:7341/api/choir/redeem']);
  });

  it('refuses an answer that names a different address', async () => {
    const { choir, urls } = make(() =>
      Response.json({ name: 'evil', url: 'http://100.64.0.66:7341', token: 'A'.repeat(43) }),
    );
    await expect(choir.join('HG-0000-0000', { url: 'http://100.64.0.2:7341' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('different address'),
    });
    expect(urls).toEqual(['http://100.64.0.2:7341/api/choir/redeem']);
    expect(choir.state().devices).toEqual([]);
  });
});

describe('joining with a short code between two servers', () => {
  const running: Running[] = [];
  afterAll(async () => {
    for (const s of running) await s.close();
  });
  const start = async (extra: Parameters<typeof startServer>[1] = {}) => {
    const s = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-sc-'))]), port: 0 },
      { fakeTickMs: 30, secrets: memoryStore(), choirSecrets: secrets(), ...extra },
    );
    running.push(s);
    return s;
  };
  const shareFrom = async (gpu: Running, shareUrl: string) => {
    const res = await post(gpu.url, '/api/choir/invite', { url: shareUrl });
    expect(res.status).toBe(200);
    return (await res.json()) as ChoirInvite;
  };

  it('shows the short code, the address and the command, and the long code only when asked', async () => {
    const gpu = await start();
    const shareUrl = `http://127.0.0.1:${await freePort()}`;
    const inv = await shareFrom(gpu, shareUrl);
    expect(inv.short?.code).toMatch(CODE_RE);
    expect(inv.url).toBe(shareUrl);
    expect(inv.command).toBe(`hildegard choir join ${inv.short?.code} --url ${shareUrl}`);
    // The long code is made only on request.
    expect(inv.code).toBeNull();
    const longInv = (await (
      await post(gpu.url, '/api/choir/invite', { url: shareUrl, long: true })
    ).json()) as ChoirInvite;
    expect(longInv.code).toMatch(/^hgc1_/);
    // A key the other device made itself gets no short code.
    const k = (await (
      await post(gpu.url, '/api/choir/invite', { url: shareUrl, key: 'A'.repeat(43) })
    ).json()) as ChoirInvite;
    expect(k.short).toBeNull();
  });

  it('joins a second server through the sharing address, once, and a long code still works', async () => {
    const gpu = await start();
    const shareUrl = `http://127.0.0.1:${await freePort()}`;
    const inv = await shareFrom(gpu, shareUrl);
    const mac = await start();
    const joined = await post(mac.url, '/api/choir/join', { code: inv.short!.code, url: shareUrl });
    expect(joined.status).toBe(201);
    const j = (await joined.json()) as { device: { name: string; online: boolean }; choir: ChoirState };
    expect(j.device.online).toBe(true);
    expect(j.choir.devices).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(gpu.config.dataDir, 'choir', 'codes.json'), 'utf8')).codes).toEqual(
      [],
    );
    // Used: a second device with the same code is turned away.
    const other = await start();
    const again = await post(other.url, '/api/choir/join', { code: inv.short!.code, url: shareUrl });
    expect(again.status).toBe(403);
    expect(other.choir.state().devices).toEqual([]);
    // The long code made with it works on yet another.
    const old = await start();
    const longInv = (await (
      await post(gpu.url, '/api/choir/invite', { url: shareUrl, long: true })
    ).json()) as ChoirInvite;
    expect((await post(old.url, '/api/choir/join', { code: longInv.code })).status).toBe(201);
  });

  it('lets only one of many redemptions at once have the code', async () => {
    const gpu = await start();
    const shareUrl = `http://127.0.0.1:${await freePort()}`;
    const inv = await shareFrom(gpu, shareUrl);
    const before = JSON.parse(readFileSync(join(gpu.config.dataDir, 'choir', 'sharing.json'), 'utf8')).keys
      .length;
    const rs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        post(shareUrl, '/api/choir/redeem', { code: inv.short!.code, name: `dev-${i}` }),
      ),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 403)).toHaveLength(3);
    const after = JSON.parse(readFileSync(join(gpu.config.dataDir, 'choir', 'sharing.json'), 'utf8')).keys
      .length;
    expect(after).toBe(before + 1);
  });

  it('stops a source after five wrong codes over HTTP, and answers wrong and malformed codes alike', async () => {
    const gpu = await start();
    const shareUrl = `http://127.0.0.1:${await freePort()}`;
    const inv = await shareFrom(gpu, shareUrl);
    const seen: number[] = [];
    for (const code of ['HG-0000-0000', 'nonsense', 'HG-1111-1111', '', 'HG-2222-2222', 'HG-3333-3333'])
      seen.push((await post(shareUrl, '/api/choir/redeem', { code })).status);
    expect(seen).toEqual([403, 403, 403, 403, 403, 429]);
    expect((await post(shareUrl, '/api/choir/redeem', { code: inv.short!.code })).status).toBe(429);
    // No body at all is a mistake, not a guess.
    expect((await post(shareUrl, '/api/choir/redeem')).status).toBe(400);
  });

  it('sends no request for a short code without an address', async () => {
    const mac = await start();
    const r = await post(mac.url, '/api/choir/join', { code: 'HG-0000-0000' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain('--url');
    expect(mac.choir.state().devices).toEqual([]);
  });

  it('refuses a code address outside a private link, and only this computer may share', async () => {
    const mac = await start();
    const r = await post(mac.url, '/api/choir/join', {
      code: 'HG-0000-0000',
      url: 'http://192.168.1.4:7341',
    });
    expect(r.status).toBe(400);
    // Minting is for this computer; a request that came through the link is refused.
    const hostPort = await freePort();
    const gpu = await startServer(
      {
        ...parseArgs([
          '--fake-gpu',
          '--data',
          mkdtempSync(join(tmpdir(), 'hg-sc-')),
          '--host-port',
          String(hostPort),
        ]),
        port: 0,
      },
      { fakeTickMs: 30, secrets: memoryStore(), choirSecrets: secrets() },
    );
    running.push(gpu);
    const hosted = gpu.hostedUrl()!;
    expect((await post(hosted, '/api/choir/invite', {})).status).toBe(401);
    // Redeeming is not offered on the public link at all.
    expect((await post(hosted, '/api/choir/redeem', { code: 'HG-0000-0000' })).status).toBe(401);
  });
});
