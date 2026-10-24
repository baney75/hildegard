// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The few bytes the relay and a Hildegard say to each other in the clear: one JSON line per message on the control
 * connection, and a PROXY protocol v1 line at the start of each data connection, so the Hildegard knows who is
 * calling (for its rate limits) even though the bytes come through the relay.
 */
import { isIPv4, isIPv6 } from 'node:net';
import type { Duplex } from 'node:stream';

/** What the relay and a Hildegard send each other on the control connection. */
export type Message =
  | { t: 'hello'; name: string; token: string }
  | { t: 'data'; id: string }
  | { t: 'ok'; host: string }
  | { t: 'error'; message: string }
  | { t: 'open'; id: string }
  | { t: 'ping' }
  | { t: 'pong' };

export const MAX_LINE = 1024;

export const send = (s: Duplex, m: Message) => {
  if (!s.destroyed) s.write(`${JSON.stringify(m)}\n`);
};

export function parse(line: string): Message | null {
  try {
    const m = JSON.parse(line) as Partial<Message> | null;
    return m && typeof m === 'object' && typeof m.t === 'string' ? (m as Message) : null;
  } catch {
    return null;
  }
}

/**
 * Calls `onLine` for each line, `\n`-ended, until it returns false. Before each call the stream is paused, with any
 * bytes after that line put back, so a handler that takes the stream over (or ends it) sees them first. A line
 * longer than `max` ends the stream.
 */
export function readLines(s: Duplex, onLine: (line: string) => boolean, max = MAX_LINE) {
  let buf: Buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > max) s.destroy();
      return;
    }
    const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
    const rest = buf.subarray(nl + 1);
    buf = Buffer.alloc(0);
    s.off('data', onData);
    s.pause();
    if (rest.length) s.unshift(rest);
    if (onLine(line) && !s.destroyed) {
      s.on('data', onData);
      s.resume();
    }
  };
  s.on('data', onData);
}

const plain = (ip: string | undefined) =>
  ip?.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;

/** `PROXY TCP4 <src> <dst> <sport> <dport>\r\n`, or `PROXY UNKNOWN\r\n` when an address is missing. */
export function proxyLine(src: { ip?: string; port?: number }, dst: { ip?: string; port?: number }): string {
  const a = plain(src.ip);
  const b = plain(dst.ip);
  if (!a || !b || !src.port || !dst.port) return 'PROXY UNKNOWN\r\n';
  const fam = isIPv4(a) && isIPv4(b) ? 'TCP4' : isIPv6(a) && isIPv6(b) ? 'TCP6' : null;
  return fam ? `PROXY ${fam} ${a} ${b} ${src.port} ${dst.port}\r\n` : 'PROXY UNKNOWN\r\n';
}

/** The caller's address from a PROXY v1 line, or null when it says UNKNOWN. Throws when it isn't one. */
export function readProxyLine(line: string): { ip: string; port: number } | null {
  const m = /^PROXY (TCP4|TCP6|UNKNOWN)(?: (\S+) (\S+) (\d{1,5}) (\d{1,5}))?$/.exec(line);
  if (!m) throw new Error('Not a PROXY line.');
  if (m[1] === 'UNKNOWN') return null;
  const ip = m[2]!;
  if (m[1] === 'TCP4' ? !isIPv4(ip) : !isIPv6(ip)) throw new Error('Bad address in the PROXY line.');
  return { ip, port: Number(m[4]) };
}
