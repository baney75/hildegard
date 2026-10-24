// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpsServer, request } from 'node:https';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LinkAgent,
  LinkRelay,
  linkName,
  newToken,
  proxyLine,
  readHello,
  readProxyLine,
} from '../src/index.ts';
import { testCert } from './cert.ts';

// A self-signed certificate for *.link.test, made for this run only.
const { cert, key } = testCert();

/** The ClientHello a TLS client sends for `servername`, caught by a plain TCP server. */
async function clientHello(servername?: string): Promise<Buffer> {
  return new Promise((ok) => {
    const srv = createServer((s) => {
      s.once('data', (b) => {
        ok(b);
        s.destroy();
        srv.close();
      });
    }).listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      const c = tlsConnect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false });
      c.on('error', () => {});
    });
  });
}

describe('reading the name from a ClientHello', () => {
  it('finds it in a whole hello, and in one that arrives a byte at a time', async () => {
    const hello = await clientHello('alpha.link.test');
    expect(readHello(hello)).toEqual({ kind: 'hello', name: 'alpha.link.test' });
    for (let i = 1; i < hello.length; i += 7) expect(readHello(hello.subarray(0, i)).kind).toBe('more');
  });

  it('says when there’s no name, and when it isn’t TLS at all', async () => {
    expect(readHello(await clientHello())).toEqual({ kind: 'hello', name: null });
    expect(readHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')).kind).toBe('bad');
    const broken = Buffer.from(await clientHello('alpha.link.test'));
    broken[5] = 0x02; // not a ClientHello
    expect(readHello(broken).kind).toBe('bad');
  });

  it('takes one label under the domain, and nothing else', () => {
    expect(linkName('Alpha.link.test.', 'link.test')).toBe('alpha');
    expect(linkName('a.b.link.test', 'link.test')).toBeNull();
    expect(linkName('link.test', 'link.test')).toBeNull();
    expect(linkName('alpha.evil.test', 'link.test')).toBeNull();
    expect(linkName('-alpha.link.test', 'link.test')).toBeNull();
    expect(linkName(null, 'link.test')).toBeNull();
  });
});

describe('the PROXY line', () => {
  it('carries the caller’s address, plain IPv4 for mapped ones', () => {
    const line = proxyLine({ ip: '::ffff:203.0.113.7', port: 5555 }, { ip: '::ffff:10.0.0.1', port: 443 });
    expect(line).toBe('PROXY TCP4 203.0.113.7 10.0.0.1 5555 443\r\n');
    expect(readProxyLine(line.trimEnd())).toEqual({ ip: '203.0.113.7', port: 5555 });
    expect(readProxyLine('PROXY UNKNOWN')).toBeNull();
    expect(() => readProxyLine('PROXY TCP4 not-an-ip 1.2.3.4 1 2')).toThrow();
    expect(() => readProxyLine('GET / HTTP/1.1')).toThrow();
  });
});

describe('Hildegard Link', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  /** A relay, and a Hildegard behind it serving HTTPS with its own certificate. */
  async function setup(
    opts: { name?: string; relay?: Partial<ConstructorParameters<typeof LinkRelay>[0]> } = {},
  ) {
    const relay = new LinkRelay({ domain: 'link.test', ...opts.relay });
    const ports = await relay.listen({ publicPort: 0, agentPort: 0, host: '127.0.0.1' });
    cleanup.push(() => relay.close());
    const callers: ({ ip: string; port: number } | null)[] = [];
    const site = createHttpsServer({ key, cert }, (req, res) => {
      res.end(`hello from ${req.headers.host} ${req.url}`);
    });
    cleanup.push(() => site.close());
    const token = newToken();
    const agent = new LinkAgent({
      relay: { host: '127.0.0.1', port: ports.agentPort },
      name: opts.name ?? 'alpha',
      token,
      onConnection: (s, from) => {
        callers.push(from);
        site.emit('connection', s);
      },
    });
    cleanup.push(() => agent.close());
    return { relay, ports, agent, token, callers, site };
  }

  const get = (port: number, host: string, path = '/mcp') =>
    new Promise<string>((ok, fail) => {
      const req = request(
        { host: '127.0.0.1', port, path, servername: host, headers: { host }, ca: cert, agent: false },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => ok(body));
        },
      );
      req.on('error', fail);
      req.end();
    });

  it('carries HTTPS end to end: the certificate is the Hildegard’s, and it knows who called', async () => {
    const { agent, ports, callers } = await setup();
    expect(await agent.start()).toBe('alpha.link.test');
    expect(await get(ports.publicPort, 'alpha.link.test')).toBe('hello from alpha.link.test /mcp');
    expect(await get(ports.publicPort, 'alpha.link.test', '/again')).toBe(
      'hello from alpha.link.test /again',
    );
    expect(callers).toHaveLength(2);
    expect(callers[0]?.ip).toBe('127.0.0.1');
  });

  it('ends TLS at the Hildegard, not the relay', async () => {
    const { agent, ports } = await setup();
    await agent.start();
    // A caller who checks the certificate gets the Hildegard’s own: the relay has none to offer.
    await expect(
      new Promise((ok, fail) => {
        const c = tlsConnect({
          host: '127.0.0.1',
          port: ports.publicPort,
          servername: 'alpha.link.test',
          ca: cert,
        });
        c.on('secureConnect', () => {
          ok(c.getPeerCertificate().subject.CN);
          c.destroy();
        });
        c.on('error', fail);
      }),
    ).resolves.toBe('link.test');
  });

  it('drops callers for names nobody holds, names it can’t read, and plain HTTP', async () => {
    const { agent, ports } = await setup();
    await agent.start();
    await expect(get(ports.publicPort, 'beta.link.test')).rejects.toThrow();
    await expect(get(ports.publicPort, 'alpha.other.test')).rejects.toThrow();
    const closed = await new Promise<string>((ok) => {
      const s = netConnect(ports.publicPort, '127.0.0.1', () =>
        s.write('GET / HTTP/1.1\r\nHost: alpha\r\n\r\n'),
      );
      let got = '';
      s.on('data', (d) => (got += d));
      s.on('close', () => ok(got));
      s.on('error', () => {});
    });
    expect(closed).toBe('');
  });

  it('keeps a name for the token that claimed it, across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-link-'));
    const namesFile = join(dir, 'names.json');
    const { agent, ports, relay } = await setup({ relay: { namesFile } });
    await agent.start();
    if (process.platform !== 'win32') expect(statSync(namesFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(namesFile, 'utf8')).not.toContain('hgl_');

    const thief = new LinkAgent({
      relay: { host: '127.0.0.1', port: ports.agentPort },
      name: 'alpha',
      token: newToken(),
      onConnection: () => {},
    });
    cleanup.push(() => thief.close());
    await expect(thief.start()).rejects.toThrow('belongs to someone else');

    await relay.close();
    const again = new LinkRelay({ domain: 'link.test', namesFile });
    const p2 = await again.listen({ publicPort: 0, agentPort: 0, host: '127.0.0.1' });
    cleanup.push(() => again.close());
    const thief2 = new LinkAgent({
      relay: { host: '127.0.0.1', port: p2.agentPort },
      name: 'alpha',
      token: newToken(),
      onConnection: () => {},
    });
    cleanup.push(() => thief2.close());
    await expect(thief2.start()).rejects.toThrow('belongs to someone else');
  });

  it('refuses short tokens and names that aren’t one label', async () => {
    const { ports } = await setup();
    for (const [name, token, error] of [
      ['alpha', 'short', 'too short'],
      ['a.b', newToken(), 'letters, digits and dashes'],
    ] as const) {
      const a = new LinkAgent({
        relay: { host: '127.0.0.1', port: ports.agentPort },
        name,
        token,
        onConnection() {},
      });
      cleanup.push(() => a.close());
      await expect(a.start()).rejects.toThrow(error);
    }
  });

  it('takes a name down at once, callers included, and lets it back', async () => {
    const { agent, ports, relay, token, site } = await setup();
    await agent.start();
    const caller = await new Promise<Socket>((ok) => {
      const c = tlsConnect(
        { host: '127.0.0.1', port: ports.publicPort, servername: 'alpha.link.test', ca: cert },
        () => ok(c),
      );
      // The takedown resets it.
      c.on('error', () => {});
    });
    const gone = new Promise((ok) => caller.once('close', ok));
    relay.block('alpha');
    await gone;
    await expect(get(ports.publicPort, 'alpha.link.test')).rejects.toThrow();
    const back = new LinkAgent({
      relay: { host: '127.0.0.1', port: ports.agentPort },
      name: 'alpha',
      token,
      onConnection: (s) => site.emit('connection', s),
    });
    cleanup.push(() => back.close());
    await expect(back.start()).rejects.toThrow('taken down');
    relay.unblock('alpha');
    const back2 = new LinkAgent({
      relay: { host: '127.0.0.1', port: ports.agentPort },
      name: 'alpha',
      token,
      onConnection: (s) => site.emit('connection', s),
    });
    cleanup.push(() => back2.close());
    await back2.start();
    expect(await get(ports.publicPort, 'alpha.link.test')).toContain('hello');
  });

  it('caps how many callers one name can have at once', async () => {
    const { agent, ports, relay } = await setup({ relay: { maxPerName: 2 } });
    await agent.start();
    const open = () =>
      new Promise<Socket>((ok, fail) => {
        const c = tlsConnect(
          { host: '127.0.0.1', port: ports.publicPort, servername: 'alpha.link.test', ca: cert },
          () => ok(c),
        );
        c.on('error', fail);
      });
    const held = [await open(), await open()];
    expect(relay.stats()).toMatchObject({ online: 1, open: 2 });
    await expect(open()).rejects.toThrow();
    for (const s of held) s.destroy();
  });

  it('keeps a Hildegard that answers its pings, and drops one that doesn’t', async () => {
    const { agent, ports, relay } = await setup({ relay: { pingMs: 50 } });
    await agent.start();
    await new Promise((ok) => setTimeout(ok, 400));
    expect(relay.stats().online).toBe(1);
    expect(await get(ports.publicPort, 'alpha.link.test')).toContain('hello');
    // One that says hello and then goes quiet.
    const quiet = netConnect(ports.agentPort, '127.0.0.1', () =>
      quiet.write(`${JSON.stringify({ t: 'hello', name: 'quiet', token: newToken() })}\n`),
    );
    quiet.resume();
    quiet.on('error', () => {});
    await new Promise((ok) => quiet.once('close', ok));
    await expect.poll(() => relay.stats().online).toBe(1);
  });

  it('drops a caller who never says hello', async () => {
    const { agent, ports } = await setup({ relay: { helloTimeoutMs: 100 } });
    await agent.start();
    const t = Date.now();
    await new Promise((ok) => {
      const s = netConnect(ports.publicPort, '127.0.0.1');
      s.on('close', ok);
      s.on('error', () => {});
    });
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it('reconnects on its own when the control connection drops', async () => {
    const { agent, ports, relay } = await setup();
    await agent.start();
    const statuses: boolean[] = [];
    const back = new Promise<void>((ok) => {
      // A newer connection for the same name replaces the older one; the agent sees it close and dials again.
      (agent as unknown as { opts: { onStatus: (s: { online: boolean }) => void } }).opts.onStatus = (s) => {
        statuses.push(s.online);
        if (s.online) ok();
      };
    });
    (agent as unknown as { control: Socket }).control.destroy();
    await back;
    expect(statuses).toEqual([false, true]);
    expect(relay.stats().online).toBe(1);
    expect(await get(ports.publicPort, 'alpha.link.test')).toContain('hello');
  });
});
