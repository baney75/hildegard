// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Go live, the keyholder. FFmpeg can't take its ingest address from a file, a descriptor or the environment, and
 * anything on its command line shows in `ps` and `/proc/<pid>/cmdline`. So FFmpeg never gets the stream key. It
 * publishes to a port on this computer, with a stand-in as the stream name, and this relay carries the connection to
 * the service (over TLS for rtmps://) and swaps the real key in on the wire.
 *
 * The stand-in is a random string exactly as long as the key. The swap is made in place on the RTMP messages that
 * carry the stream name (`releaseStream`, `FCPublish`, `publish`), so no length, chunk header or timestamp changes and
 * the rest of the stream is a plain byte pipe. The key lives in this process's memory and nowhere else: not in an
 * argument, an environment variable, a file, a log or an error message.
 */
import { randomInt } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const KEY_MIN = 8;
export const KEY_MAX = 512;
/** What a stream key may be made of: printable characters a service hands out, nothing that could break a message. */
export const KEY_RE = /^[\x21-\x7e]{8,512}$/;

/** A random stand-in for a stream key, as long as it. */
export function standIn(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

type Mode = 'handshake' | 'chunks' | 'raw';

interface Inflight {
  type: number;
  length: number;
  /** Where this message's payload bytes sit in the pending output: [offset, length]. */
  segs: [number, number][];
  got: number;
}

/** Messages longer than this before `publish` mean something is wrong; the stand-in is left unpatched. */
const MAX_MESSAGE = 64 * 1024;
/** Bytes held back while a message is incomplete. */
const MAX_HELD = 256 * 1024;

/**
 * Reads the client's side of an RTMP connection up to `publish` and replaces the stand-in with the key in the
 * messages that carry it. Everything else passes through byte for byte.
 */
export class KeyPatcher {
  mode: Mode = 'handshake';
  /** True once the `publish` command has gone through. */
  published = false;
  /** How many messages had the stand-in replaced. */
  patched = 0;
  private readonly stand: Buffer;
  private readonly key: Buffer;
  private buf: Buffer = Buffer.alloc(0);
  private handshakeLeft = 1 + 1536 + 1536;
  private chunkSize = 128;
  private streams = new Map<number, { length: number; type: number; ext: boolean }>();
  private inflight = new Map<number, Inflight>();
  /** Bytes ready to send (and the part still being patched). */
  private out: Buffer[] = [];
  private outLen = 0;

  constructor(standInText: string, key: string) {
    if (standInText.length !== key.length)
      throw new Error('The stand-in and the key must be the same length.');
    this.stand = Buffer.from(standInText, 'latin1');
    this.key = Buffer.from(key, 'latin1');
  }

  /** Feeds bytes from FFmpeg; returns the bytes to send on to the service (possibly none yet). */
  push(chunk: Buffer): Buffer[] {
    if (this.mode === 'raw') return [chunk];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const done: Buffer[] = [];
    for (;;) {
      if (this.mode === 'handshake') {
        const n = Math.min(this.handshakeLeft, this.buf.length);
        if (n > 0) {
          done.push(this.buf.subarray(0, n));
          this.buf = this.buf.subarray(n);
          this.handshakeLeft -= n;
        }
        if (this.handshakeLeft > 0) break;
        this.mode = 'chunks';
      }
      if ((this.mode as Mode) === 'raw') break;
      const used = this.chunk();
      if (used === 0) break;
      // Send what is complete; hold the bytes of a message that is still arriving.
      if (this.inflight.size === 0) {
        const all = this.take();
        if (all) done.push(all);
      }
      if (this.outLen > MAX_HELD) return this.giveUp(done);
    }
    if ((this.mode as Mode) === 'raw') {
      const rest = this.take();
      if (rest) done.push(rest);
      if (this.buf.length) done.push(this.buf);
      this.buf = Buffer.alloc(0);
    }
    return done;
  }

  /** Whatever is held, to send when the connection ends mid-message. */
  private take(): Buffer | null {
    if (!this.out.length) return null;
    const all = this.out.length === 1 ? this.out[0]! : Buffer.concat(this.out);
    this.out = [];
    this.outLen = 0;
    return all;
  }

  /** Stop reading the stream and pass it on as it is. The stand-in is never replaced after this. */
  private giveUp(done: Buffer[]): Buffer[] {
    this.mode = 'raw';
    const held = this.take();
    if (held) done.push(held);
    if (this.buf.length) done.push(this.buf);
    this.buf = Buffer.alloc(0);
    this.inflight.clear();
    return done;
  }

  /** Reads one chunk from `buf` into `out`. Returns the bytes used, or 0 when more are needed. */
  private chunk(): number {
    const b = this.buf;
    if (b.length < 1) return 0;
    const fmt = b[0]! >> 6;
    let csid = b[0]! & 0x3f;
    let p = 1;
    if (csid === 0) {
      if (b.length < 2) return 0;
      csid = 64 + b[1]!;
      p = 2;
    } else if (csid === 1) {
      if (b.length < 3) return 0;
      csid = 64 + b[1]! + b[2]! * 256;
      p = 3;
    }
    const hdr = [11, 7, 3, 0][fmt]!;
    if (b.length < p + hdr) return 0;
    let st = this.streams.get(csid);
    let tsField = 0;
    if (fmt <= 2) tsField = b.readUIntBE(p, 3);
    if (fmt <= 1) {
      st = { length: b.readUIntBE(p + 3, 3), type: b[p + 6]!, ext: false };
    } else if (!st) {
      // A continuation of something never seen: the stream isn't what was expected.
      this.mode = 'raw';
      return 0;
    }
    // A new message starts unless this csid is mid-message (a fmt 3 continuation).
    let cur = this.inflight.get(csid);
    const starts = !cur;
    if (starts) {
      if (st.length > MAX_MESSAGE && !this.published) {
        this.mode = 'raw';
        return 0;
      }
    }
    let q = p + hdr;
    const ext = fmt <= 2 ? tsField === 0xffffff : st.ext;
    if (fmt <= 2) st.ext = ext;
    if (ext) {
      if (b.length < q + 4) return 0;
      q += 4;
    }
    const length = st.length;
    const have = cur ? cur.got : 0;
    const want = Math.min(this.chunkSize, length - have);
    if (b.length < q + want) return 0;
    this.streams.set(csid, st);

    if (starts) cur = { type: st.type, length, segs: [], got: 0 };
    const c = cur!;
    // The raw bytes go to `out` unchanged; the payload's place in them is remembered for patching.
    const raw = Buffer.from(b.subarray(0, q + want));
    const base = this.outLen;
    this.out.push(raw);
    this.outLen += raw.length;
    c.segs.push([base + q, want]);
    c.got += want;
    this.buf = b.subarray(q + want);
    if (c.got < c.length) {
      this.inflight.set(csid, c);
      return q + want;
    }
    this.inflight.delete(csid);
    this.message(c);
    return q + want;
  }

  /** A whole message has arrived: replace the stand-in, follow chunk size changes, notice `publish`. */
  private message(m: Inflight) {
    const flat = this.out.length === 1 ? this.out[0]! : Buffer.concat(this.out);
    if (this.out.length > 1) this.out = [flat];
    const payload = Buffer.concat(m.segs.map(([o, n]) => flat.subarray(o, o + n)));
    if (m.type === 1 && payload.length >= 4) {
      const n = payload.readUInt32BE(0) & 0x7fffffff;
      if (n >= 1 && n <= 0x1000000) this.chunkSize = n;
      return;
    }
    if (m.type !== 20 && m.type !== 17) return;
    const at = payload.indexOf(this.stand);
    if (at >= 0) {
      // Map the payload offset back to the bytes it came from, which may straddle chunk headers.
      let left = this.key.length;
      let k = 0;
      let skip = at;
      for (const [o, n] of m.segs) {
        if (skip >= n) {
          skip -= n;
          continue;
        }
        const take = Math.min(n - skip, left);
        this.key.copy(flat, o + skip, k, k + take);
        k += take;
        left -= take;
        skip = 0;
        if (left === 0) break;
      }
      this.patched++;
    }
    // AMF0 string "publish" opens the command (AMF3 commands carry a leading zero byte).
    const off = m.type === 17 ? 1 : 0;
    if (
      payload.length > off + 9 &&
      payload[off] === 0x02 &&
      payload.readUInt16BE(off + 1) === 7 &&
      payload.toString('latin1', off + 3, off + 10) === 'publish'
    ) {
      this.published = true;
      this.mode = 'raw';
    }
  }

  /** Any bytes held when the connection ends. */
  flush(): Buffer[] {
    const held = this.take();
    const rest = this.buf.length ? [this.buf] : [];
    this.buf = Buffer.alloc(0);
    return held ? [held, ...rest] : rest;
  }
}

// ── The relay ──────────────────────────────────────────────────────────────────────────────────────────────────

export type RelayEvent =
  | { type: 'connecting' }
  | { type: 'live' }
  | { type: 'closed'; reason: string; rejected: boolean };

export interface RelayOptions {
  /** rtmp:// or rtmps:// and the application, with no key: where the service takes the stream. */
  server: string;
  key: string;
  onEvent: (e: RelayEvent) => void;
  /** Tests connect somewhere else, or without a certificate check. */
  connect?: (host: string, port: number, secure: boolean) => net.Socket;
  timeoutMs?: number;
}

/** What a service says when it turns a stream down. */
const REJECT =
  /(Publish\.BadName|Publish\.Denied|Publish\.Failed|Connect\.Rejected|Connect\.Failed|Unauthorized|Forbidden|not authori[sz]ed|Invalid stream key|stream key)/i;
const STARTED = /Publish\.Start/;

const explain = (e: NodeJS.ErrnoException): string => {
  switch (e.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Can’t find that server. Check the address and your connection.';
    case 'ECONNREFUSED':
      return 'The server refused the connection.';
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return 'The connection to the server dropped.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'The server’s certificate isn’t valid, so Hildegard won’t send to it.';
    default:
      return 'The connection to the server failed.';
  }
};

export class KeyRelay {
  readonly opts: RelayOptions;
  /** The stand-in FFmpeg publishes under. */
  readonly stand: string;
  /** Bytes sent to the service so far. */
  sent = 0;
  private server: net.Server | null = null;
  private local: net.Socket | null = null;
  private up: net.Socket | null = null;
  private closed = false;
  private live = false;
  private sawReject = false;
  private tail = '';

  constructor(opts: RelayOptions) {
    if (!KEY_RE.test(opts.key))
      throw new Error('That stream key isn’t one a service would give. Check it for spaces.');
    this.opts = opts;
    this.stand = standIn(opts.key.length);
  }

  /** Opens the local port; FFmpeg publishes to `rtmp://127.0.0.1:<port>/<app>/<stand-in>`. */
  async listen(): Promise<{ port: number; url: string }> {
    const u = new URL(this.opts.server);
    this.server = net.createServer((s) => this.accept(s, u));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (this.server.address() as net.AddressInfo).port;
    return { port, url: `rtmp://127.0.0.1:${port}${u.pathname}/${this.stand}` };
  }

  private accept(local: net.Socket, u: URL) {
    // One connection: FFmpeg's. Nothing else on this computer gets to use the key.
    this.server?.close();
    this.server = null;
    this.local = local;
    local.pause();
    local.setNoDelay(true);
    this.opts.onEvent({ type: 'connecting' });
    const secure = u.protocol === 'rtmps:';
    const port = Number(u.port || (secure ? 443 : 1935));
    let up: net.Socket;
    try {
      up = this.opts.connect
        ? this.opts.connect(u.hostname, port, secure)
        : secure
          ? // Certificates are checked against the name; an address has none to send.
            tls.connect({
              host: u.hostname,
              port,
              ...(net.isIP(u.hostname) ? {} : { servername: u.hostname }),
            })
          : net.connect({ host: u.hostname, port });
    } catch {
      return this.end('The connection to the server failed.');
    }
    this.up = up;
    up.setNoDelay(true);
    up.setTimeout(this.opts.timeoutMs ?? 15000, () => {
      if (!this.live && this.sent === 0)
        up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      else up.setTimeout(0);
    });
    const patcher = new KeyPatcher(this.stand, this.opts.key);
    const go = () => {
      up.setTimeout(0);
      local.resume();
    };
    if (secure && !this.opts.connect) up.once('secureConnect', go);
    else up.once('connect', go);
    local.on('data', (d: Buffer) => {
      for (const part of patcher.push(d)) {
        this.sent += part.length;
        up.write(part);
      }
    });
    up.on('data', (d: Buffer) => {
      const text = this.tail + d.toString('latin1');
      this.tail = text.slice(-64);
      if (REJECT.test(text)) this.sawReject = true;
      if (!this.live && STARTED.test(text)) {
        this.live = true;
        this.opts.onEvent({ type: 'live' });
      }
      local.write(d);
    });
    up.on('error', (e: NodeJS.ErrnoException) => this.end(explain(e)));
    local.on('error', () => this.end('FFmpeg closed the connection.'));
    up.on('close', () =>
      this.end(
        this.sawReject
          ? 'The service turned the stream down. Check the stream key.'
          : 'The service closed the connection.',
      ),
    );
    local.on('close', () => this.end('Stopped.'));
  }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.local?.destroy();
    this.up?.destroy();
    this.server?.close();
    this.opts.onEvent({ type: 'closed', reason, rejected: this.sawReject });
  }

  /** Whether the service has accepted the stream. */
  get isLive() {
    return this.live;
  }

  stop() {
    this.end('Stopped.');
  }
}
