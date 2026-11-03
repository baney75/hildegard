// SPDX-License-Identifier: AGPL-3.0-only
import { connect, type LookupFunction } from 'node:net';
import { createServer } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { testCert } from '../../../packages/link/test/cert.ts';
import { cappedResolve, fetchMetadataWith, publicLookup } from '../src/oauth.ts';

type Answer = { err: Error | null; address: unknown; family?: number };
const ask = (resolved: { address: string; family: number }[], opts: unknown) =>
  new Promise<Answer>((done) =>
    publicLookup(async () => resolved)('client.example', opts, (err, address, family) =>
      done({ err, address, family }),
    ),
  );

// 203.0.113.0/24 is a documentation range the guard treats as public; the v6 one is a real public resolver. Nothing here connects except the last test, to 203.0.113.7, which is never routed.
const PUBLIC = [
  { address: '203.0.113.7', family: 4 },
  { address: '2606:4700:4700::1111', family: 6 },
];

describe('publicLookup (the client metadata fetch connects through it)', () => {
  it('answers Node’s all:true question with the whole list (claude.ai’s CIMD fetch failed with "Invalid IP address: undefined")', async () => {
    const a = await ask(PUBLIC, { all: true });
    expect(a.err).toBeNull();
    expect(a.address).toEqual(PUBLIC);
  });

  it('answers a single-address question with the first address', async () => {
    const a = await ask(PUBLIC, { family: 0 });
    expect(a.err).toBeNull();
    expect(a.address).toBe('203.0.113.7');
    expect(a.family).toBe(4);
  });

  it('refuses a name if any of its addresses is private, either way of asking', async () => {
    for (const opts of [{ all: true }, {}]) {
      const a = await ask([PUBLIC[0]!, { address: '10.0.0.5', family: 4 }], opts);
      expect(a.err?.message).toMatch(/isn’t a public address/);
    }
    expect((await ask([{ address: '127.0.0.1', family: 4 }], { all: true })).err).not.toBeNull();
    expect((await ask([], { all: true })).err).not.toBeNull();
  });

  it('works as the lookup of a real Node connection that races addresses', async () => {
    const lookup = publicLookup(async () => [PUBLIC[0]!]) as unknown as LookupFunction;
    const outcome = await new Promise<string>((done) => {
      const socket = connect({ host: 'client.example', port: 443, lookup, autoSelectFamily: true });
      socket.on('connectionAttempt', (ip: string) => {
        socket.destroy();
        done(`attempt ${ip}`);
      });
      socket.on('error', (e: NodeJS.ErrnoException) => done(`error ${e.code ?? ''} ${e.message}`));
    });
    expect(outcome).toBe('attempt 203.0.113.7');
  });
});

describe('fetchMetadata', () => {
  it('goes through the public-address guard', async () => {
    const guard = publicLookup(async () => [{ address: '10.0.0.5', family: 4 }]);
    await expect(fetchMetadataWith('https://client.example/x', guard, 2000)).rejects.toThrow(
      /isn’t a public address/,
    );
  });

  it('gives up after its total deadline even when the server keeps dripping bytes', async () => {
    const { cert, key } = testCert();
    const drips: NodeJS.Timeout[] = [];
    const server = createServer({ cert, key }, (sock) => {
      const line = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n';
      let i = 0;
      const t = setInterval(() => (i < line.length ? sock.write(line[i++]!) : clearInterval(t)), 100);
      drips.push(t);
      sock.on('error', () => {});
      sock.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const local = (_h: string, opts: unknown, cb: (e: Error | null, a: unknown, f?: number) => void) =>
      (opts as { all?: boolean })?.all
        ? cb(null, [{ address: '127.0.0.1', family: 4 }])
        : cb(null, '127.0.0.1', 4);
    const started = Date.now();
    try {
      await expect(
        fetchMetadataWith(`https://link.test:${port}/x`, local as never, 600, { port, ca: cert }),
      ).rejects.toThrow(/didn’t answer in time/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      drips.forEach(clearInterval);
      server.close();
    }
  });
});

describe('publicLookup when Node’s callback throws', () => {
  it('answers once and lets nothing escape', async () => {
    let calls = 0;
    publicLookup(async () => PUBLIC)('client.example', { all: true }, () => {
      calls++;
      throw new TypeError("Cannot read properties of null (reading 'connect')");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });
});

describe('fetchMetadata against a server that stops partway', () => {
  it('rejects promptly when the body is cut short', async () => {
    const { cert, key } = testCert();
    const server = createServer({ cert, key }, (sock) => {
      sock.on('error', () => {});
      sock.on('data', () => {
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{');
        setTimeout(() => sock.end(), 50);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const local = (_h: string, opts: unknown, cb: (e: Error | null, a: unknown, f?: number) => void) =>
      (opts as { all?: boolean })?.all
        ? cb(null, [{ address: '127.0.0.1', family: 4 }])
        : cb(null, '127.0.0.1', 4);
    const started = Date.now();
    try {
      await expect(
        fetchMetadataWith(`https://link.test:${port}/x`, local as never, 3000, { port, ca: cert }),
      ).rejects.toThrow(/stopped partway|closed early|aborted/);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      server.close();
    }
  });
});

describe('cappedResolve', () => {
  it('runs at most max lookups at once and frees a slot only when a lookup ends', async () => {
    const pending: (() => void)[] = [];
    const slow = () =>
      new Promise<{ address: string; family: number }[]>((r) => pending.push(() => r(PUBLIC)));
    const capped = cappedResolve(slow, 2);
    const a = capped('a.example');
    const b = capped('b.example');
    await expect(capped('c.example')).rejects.toThrow(/Too many apps/);
    pending.shift()!();
    await a;
    const d = capped('d.example');
    for (const f of pending) f();
    await expect(d).resolves.toEqual(PUBLIC);
    await b;
  });
});
