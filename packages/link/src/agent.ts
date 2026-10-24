// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Hildegard side of Link. It keeps a control connection to a relay open under its name, and for each caller dials a
 * data connection back and hands it on, still encrypted, with the caller's address read from the PROXY line. The
 * Hildegard ends TLS itself, with its own certificate, so the relay can't read anything.
 */
import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { type ConnectionOptions, connect as tlsConnect } from 'node:tls';
import { MAX_LINE, parse, readLines, readProxyLine, send } from './wire.ts';

export interface LinkAgentOptions {
  relay: {
    host: string;
    port: number;
    /** TLS to the relay's agent port. Leave out only for tests and private networks. */
    tls?: ConnectionOptions;
  };
  /** The first label of the address: `alpha` for `alpha.hildegard.link`. */
  name: string;
  /** The secret that holds the name. Keep it in the keychain. */
  token: string;
  /** A caller, still encrypted. Hand it to a TLS server (`server.emit('connection', socket)`). */
  onConnection: (socket: Duplex, from: { ip: string; port: number } | null) => void;
  /** Told when the link goes up or down. */
  onStatus?: (s: { online: boolean; host?: string; error?: string }) => void;
  /** Longest wait between reconnects. */
  maxBackoffMs?: number;
}

/** `s` as a plain stream, so whatever is already buffered on it is read first. */
function buffered(s: Socket): Duplex {
  const d = new Duplex({
    read: () => void s.resume(),
    write: (chunk, enc, cb) => void s.write(chunk, enc, cb),
    final: (cb) => void s.end(cb),
    destroy: (err, cb) => {
      s.destroy();
      cb(err);
    },
  });
  s.on('data', (c: Buffer) => {
    if (!d.push(c)) s.pause();
  });
  s.on('end', () => d.push(null));
  s.on('close', () => d.destroy());
  return d;
}

/** A token to claim a new name with: 256 random bits. */
export const newToken = () => `hgl_${randomBytes(32).toString('base64url')}`;

export class LinkAgent {
  private control?: Socket;
  private closed = false;
  private backoff = 1_000;
  private retry?: NodeJS.Timeout;
  private readonly data = new Set<Socket>();
  private readonly opts: LinkAgentOptions;
  host?: string;

  constructor(opts: LinkAgentOptions) {
    this.opts = opts;
  }

  private dial(): Socket {
    const { host, port, tls } = this.opts.relay;
    const s = tls ? tlsConnect({ host, port, servername: host, ...tls }) : netConnect({ host, port });
    s.setNoDelay(true);
    return s;
  }

  /** Connects, and resolves with the public address once the relay accepts the name. Keeps reconnecting after. */
  start(): Promise<string> {
    return new Promise((ok, fail) => {
      let first = true;
      const connect = () => {
        if (this.closed) return;
        const s = this.dial();
        this.control = s;
        s.on('error', () => {});
        send(s, { t: 'hello', name: this.opts.name, token: this.opts.token });
        readLines(
          s,
          (line) => {
            const m = parse(line);
            if (m?.t === 'ok') {
              this.host = m.host;
              this.backoff = 1_000;
              this.opts.onStatus?.({ online: true, host: m.host });
              if (first) ok(m.host);
              first = false;
            } else if (m?.t === 'error') {
              // A refused name won't get better by retrying.
              this.closed = true;
              this.opts.onStatus?.({ online: false, error: m.message });
              if (first) fail(new Error(m.message));
              first = false;
              s.destroy();
              return false;
            } else if (m?.t === 'ping') send(s, { t: 'pong' });
            else if (m?.t === 'open' && typeof m.id === 'string') this.accept(m.id);
            return true;
          },
          MAX_LINE,
        );
        s.once('close', () => {
          if (this.control === s) this.control = undefined;
          if (this.closed) return;
          this.opts.onStatus?.({ online: false });
          this.retry = setTimeout(connect, this.backoff);
          this.retry.unref();
          this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
        });
      };
      connect();
    });
  }

  /** Dial back for one caller, read who they are, and pass the rest on. */
  private accept(id: string) {
    const s = this.dial();
    this.data.add(s);
    s.once('close', () => this.data.delete(s));
    s.on('error', () => {});
    send(s, { t: 'data', id });
    readLines(s, (line) => {
      let from: { ip: string; port: number } | null;
      try {
        from = readProxyLine(line);
      } catch {
        s.destroy();
        return false;
      }
      // The caller's first bytes may have come with the PROXY line, put back on the stream. A TLS server reads
      // straight from the socket's handle and would miss them, so in that case it gets a stream that starts with them.
      queueMicrotask(() => {
        const raw = !s.readableLength;
        this.opts.onConnection(raw ? s : buffered(s), from);
        // Reading was paused for the PROXY line; whoever took the socket now reads from it.
        s.resume();
      });
      return false;
    });
  }

  /** Ends the control connection and every caller. */
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.control?.destroy();
    for (const s of this.data) s.destroy();
  }
}
