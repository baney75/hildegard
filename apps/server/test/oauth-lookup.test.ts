// SPDX-License-Identifier: AGPL-3.0-only
import { connect, type LookupFunction } from 'node:net';
import { describe, expect, it } from 'vitest';
import { publicLookup } from '../src/oauth.ts';

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
