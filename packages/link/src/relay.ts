// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Hildegard Link relay. It gives each Hildegard a public address, `<name>.<domain>`, and passes the encrypted bytes
 * through: it reads only the name from the TLS ClientHello, so it never sees a prompt, a token or a video.
 *
 * Two ports. The public one takes TLS connections from chatbots. The agent one takes Hildegards: each keeps a control
 * connection open, and when someone connects to its name, the relay asks it (`open`) to dial back a data connection,
 * then joins the two. A Hildegard dials out, so it works behind any router, with no port forwarding.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { createServer as createTlsServer, type TlsOptions } from 'node:tls';
import { linkName, readHello } from './sni.ts';
import { MAX_LINE, parse, proxyLine, readLines, send } from './wire.ts';

export interface RelayOptions {
  /** Addresses are `<name>.<domain>`. */
  domain: string;
  /** Where names and their tokens' hashes are kept (0600). Without it, names last until the relay stops. */
  namesFile?: string;
  /** TLS for the agent port. Without it, the agent port is plain TCP, for tests and private networks only. */
  agentTls?: TlsOptions;
  /** Connections one name may have open at once. */
  maxPerName?: number;
  /** New connections a name may take in a minute. */
  perMinute?: number;
  /** How many names the relay holds. */
  maxNames?: number;
  /** How long a caller has to send its ClientHello, and a Hildegard to dial back. */
  helloTimeoutMs?: number;
  dialTimeoutMs?: number;
  /** How often to check a Hildegard's control connection is alive. */
  pingMs?: number;
  /** Names taken down for abuse: they can't connect, and nobody can reach them. */
  blocked?: Iterable<string>;
}

interface Agent {
  socket: Socket;
  /** Start of the current minute, and connections in it. */
  minute: number;
  count: number;
  lastSeen: number;
}

interface Pending {
  name: string;
  client: Socket;
  hello: Buffer;
  timer: NodeJS.Timeout;
}

const hash = (token: string) => createHash('sha256').update(token).digest();

export class LinkRelay {
  private readonly opts: Required<Omit<RelayOptions, 'namesFile' | 'agentTls' | 'blocked'>> & RelayOptions;
  /** name → hash of the token that claimed it. */
  private readonly names = new Map<string, Buffer>();
  private readonly agents = new Map<string, Agent>();
  private readonly pending = new Map<string, Pending>();
  private readonly blocked: Set<string>;
  private readonly sockets = new Set<Socket>();
  /** name → the callers connected to it right now. */
  private readonly live = new Map<string, Set<Socket>>();
  private publicServer?: Server;
  private agentServer?: Server;
  private pinger?: NodeJS.Timeout;

  constructor(opts: RelayOptions) {
    this.opts = {
      maxPerName: 64,
      perMinute: 600,
      maxNames: 100_000,
      helloTimeoutMs: 5_000,
      dialTimeoutMs: 10_000,
      pingMs: 25_000,
      ...opts,
    };
    this.blocked = new Set(opts.blocked ?? []);
    if (opts.namesFile) {
      try {
        const saved = JSON.parse(readFileSync(opts.namesFile, 'utf8')) as Record<string, string>;
        for (const [n, h] of Object.entries(saved)) this.names.set(n, Buffer.from(h, 'base64url'));
      } catch {}
    }
  }

  /** Starts both ports; 0 picks a free one. Resolves to the ports in use. */
  async listen(ports: { publicPort: number; agentPort: number; host?: string }) {
    this.publicServer = createServer((s) => this.onPublic(s));
    this.agentServer = this.opts.agentTls
      ? createTlsServer(this.opts.agentTls, (s) => this.onAgent(s))
      : createServer((s) => this.onAgent(s));
    const start = (srv: Server, port: number) =>
      new Promise<number>((ok, fail) => {
        srv.once('error', fail);
        srv.listen(port, ports.host ?? '0.0.0.0', () => {
          const a = srv.address();
          ok(typeof a === 'object' && a ? a.port : port);
        });
      });
    const publicPort = await start(this.publicServer, ports.publicPort);
    const agentPort = await start(this.agentServer, ports.agentPort);
    this.pinger = setInterval(() => this.ping(), this.opts.pingMs);
    this.pinger.unref();
    return { publicPort, agentPort };
  }

  async close() {
    clearInterval(this.pinger);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    for (const s of this.sockets) s.destroy();
    await Promise.all(
      [this.publicServer, this.agentServer].map(
        (s) => new Promise<void>((ok) => (s?.listening ? s.close(() => ok()) : ok())),
      ),
    );
  }

  /** Takes a name down: drops its Hildegard and anyone connected to it, and refuses both until `unblock`. */
  block(name: string) {
    this.blocked.add(name);
    this.agents.get(name)?.socket.destroy();
    for (const c of this.live.get(name) ?? []) c.destroy();
  }

  unblock(name: string) {
    this.blocked.delete(name);
  }

  /** What's connected, for a status page. Counts only, never addresses. */
  stats() {
    let open = 0;
    for (const l of this.live.values()) open += l.size;
    return { names: this.names.size, online: this.agents.size, open, pending: this.pending.size };
  }

  private track(s: Socket) {
    this.sockets.add(s);
    s.once('close', () => this.sockets.delete(s));
    s.on('error', () => {});
  }

  private saveNames() {
    const file = this.opts.namesFile;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const out = Object.fromEntries([...this.names].map(([n, h]) => [n, h.toString('base64url')]));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  /** A name's token checks out, or the name is free and now theirs. */
  private claim(name: string, token: string): string | null {
    if (this.blocked.has(name)) return 'This name was taken down.';
    if (token.length < 32 || token.length > 256) return 'That token is too short.';
    const want = this.names.get(name);
    const got = hash(token);
    if (want) return timingSafeEqual(want, got) ? null : 'That name belongs to someone else.';
    if (this.names.size >= this.opts.maxNames) return 'This relay is full. Try another one.';
    this.names.set(name, got);
    this.saveNames();
    return null;
  }

  private onAgent(s: Socket) {
    this.track(s);
    s.setNoDelay(true);
    const timer = setTimeout(() => s.destroy(), this.opts.dialTimeoutMs);
    readLines(s, (line) => {
      clearTimeout(timer);
      const m = parse(line);
      if (m?.t === 'data' && typeof m.id === 'string') {
        this.join(s, m.id);
        return false;
      }
      if (m?.t === 'hello' && typeof m.name === 'string' && typeof m.token === 'string') {
        const name = linkName(`${m.name}.${this.opts.domain}`, this.opts.domain);
        const refused = name ? this.claim(name, m.token) : 'Names are letters, digits and dashes.';
        if (refused || !name) {
          send(s, { t: 'error', message: refused ?? '' });
          s.end();
          return false;
        }
        this.control(s, name);
        return false;
      }
      s.destroy();
      return false;
    });
  }

  /** A Hildegard's control connection: it's now where `name` goes. A newer one replaces an older one. */
  private control(s: Socket, name: string) {
    const old = this.agents.get(name);
    const agent: Agent = { socket: s, minute: 0, count: 0, lastSeen: Date.now() };
    this.agents.set(name, agent);
    old?.socket.destroy();
    s.setKeepAlive(true, 30_000);
    send(s, { t: 'ok', host: `${name}.${this.opts.domain}` });
    readLines(
      s,
      (line) => {
        if (parse(line)?.t === 'pong') agent.lastSeen = Date.now();
        return true;
      },
      MAX_LINE,
    );
    s.resume();
    s.once('close', () => {
      if (this.agents.get(name) === agent) this.agents.delete(name);
    });
  }

  private ping() {
    const now = Date.now();
    for (const a of this.agents.values()) {
      if (now - a.lastSeen > this.opts.pingMs * 2.5) a.socket.destroy();
      else send(a.socket, { t: 'ping' });
    }
  }

  /** Someone on the internet: wait for their ClientHello, find the name, and ask its Hildegard to dial back. */
  private onPublic(client: Socket) {
    this.track(client);
    client.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), this.opts.helloTimeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const hello = readHello(buf);
      if (hello.kind === 'more') return;
      clearTimeout(timer);
      client.off('data', onData);
      client.pause();
      const name = hello.kind === 'hello' ? linkName(hello.name, this.opts.domain) : null;
      const agent = name && !this.blocked.has(name) ? this.agents.get(name) : undefined;
      if (!name || !agent || !this.admit(agent, this.live.get(name)?.size ?? 0)) return void client.destroy();
      const id = randomBytes(16).toString('hex');
      const pending: Pending = {
        name,
        client,
        hello: buf,
        timer: setTimeout(() => {
          this.pending.delete(id);
          client.destroy();
        }, this.opts.dialTimeoutMs),
      };
      this.pending.set(id, pending);
      const live = this.live.get(name) ?? new Set<Socket>();
      this.live.set(name, live.add(client));
      client.once('close', () => {
        live.delete(client);
        if (!live.size && this.live.get(name) === live) this.live.delete(name);
        if (this.pending.delete(id)) clearTimeout(pending.timer);
      });
      send(agent.socket, { t: 'open', id });
    };
    client.on('data', onData);
  }

  /** Under this name's limits, counting this connection. */
  private admit(a: Agent, open: number) {
    const now = Date.now();
    if (now - a.minute >= 60_000) {
      a.minute = now;
      a.count = 0;
    }
    if (open >= this.opts.maxPerName || a.count >= this.opts.perMinute) return false;
    a.count++;
    return true;
  }

  /** A Hildegard dialed back for connection `id`: tell it who's calling, replay the hello, and join the two. */
  private join(data: Socket, id: string) {
    const p = /^[0-9a-f]{32}$/.test(id) ? this.pending.get(id) : undefined;
    if (!p || this.blocked.has(p.name)) return void data.destroy();
    this.pending.delete(id);
    clearTimeout(p.timer);
    const c = p.client;
    data.write(
      proxyLine({ ip: c.remoteAddress, port: c.remotePort }, { ip: c.localAddress, port: c.localPort }),
    );
    data.write(p.hello);
    c.pipe(data);
    data.pipe(c);
    data.resume();
    c.resume();
    c.once('close', () => data.destroy());
    data.once('close', () => c.destroy());
  }
}
