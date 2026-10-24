// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reads the name a browser or chatbot asks for (SNI) from the start of a TLS connection, without decrypting anything:
 * the ClientHello is sent in the clear, and the name in it is all the relay needs to know where to send the bytes.
 */

/** A ClientHello bigger than this isn't one we'll wait for. Post-quantum key shares still fit easily. */
export const MAX_HELLO = 32 * 1024;

export type Hello =
  /** Not enough bytes yet. */
  | { kind: 'more' }
  /** A ClientHello; `name` is null when it carries no server name. */
  | { kind: 'hello'; name: string | null }
  /** Not TLS, or not a ClientHello. */
  | { kind: 'bad' };

/** Joins the handshake bytes of the TLS records at the start of `buf`, until `want` bytes or the buffer runs out. */
function handshakeBytes(buf: Buffer): { bytes: Buffer; complete: boolean } | null {
  const parts: Buffer[] = [];
  let have = 0;
  let want = -1;
  let at = 0;
  while (at + 5 <= buf.length) {
    if (buf[at] !== 0x16 || buf[at + 1] !== 0x03) return null;
    const len = buf.readUInt16BE(at + 3);
    if (len === 0 || len > 16384 + 2048) return null;
    const body = buf.subarray(at + 5, Math.min(buf.length, at + 5 + len));
    parts.push(body);
    have += body.length;
    if (want < 0 && have >= 4) {
      const head = Buffer.concat(parts);
      if (head[0] !== 0x01) return null;
      want = 4 + head.readUIntBE(1, 3);
      if (want > MAX_HELLO) return null;
    }
    if (want >= 0 && have >= want) return { bytes: Buffer.concat(parts).subarray(0, want), complete: true };
    if (body.length < len) break;
    at += 5 + len;
  }
  if (buf.length >= 1 && buf[0] !== 0x16) return null;
  return { bytes: Buffer.concat(parts), complete: false };
}

/** The server name in a complete ClientHello handshake message, or null. Throws on a malformed one. */
function serverName(hs: Buffer): string | null {
  let at = 4 + 2 + 32; // handshake header, client_version, random
  const skip = (lenBytes: 1 | 2) => {
    if (at + lenBytes > hs.length) throw new Error('short');
    const n = lenBytes === 1 ? hs[at]! : hs.readUInt16BE(at);
    at += lenBytes + n;
  };
  skip(1); // session id
  skip(2); // cipher suites
  skip(1); // compression methods
  if (at === hs.length) return null; // no extensions
  if (at + 2 > hs.length) throw new Error('short');
  const end = at + 2 + hs.readUInt16BE(at);
  at += 2;
  if (end > hs.length) throw new Error('short');
  while (at + 4 <= end) {
    const type = hs.readUInt16BE(at);
    const len = hs.readUInt16BE(at + 2);
    at += 4;
    if (at + len > end) throw new Error('short');
    if (type === 0) {
      // server_name: a list of (type, name); only host_name (0) exists.
      let p = at + 2;
      const listEnd = at + 2 + hs.readUInt16BE(at);
      while (p + 3 <= listEnd) {
        const kind = hs[p]!;
        const n = hs.readUInt16BE(p + 1);
        if (p + 3 + n > listEnd) throw new Error('short');
        if (kind === 0) return hs.subarray(p + 3, p + 3 + n).toString('latin1');
        p += 3 + n;
      }
      return null;
    }
    at += len;
  }
  return null;
}

/** What the bytes so far say about the connection. */
export function readHello(buf: Buffer): Hello {
  if (buf.length > MAX_HELLO + 5 * 4) return { kind: 'bad' };
  const hs = handshakeBytes(buf);
  if (!hs) return { kind: 'bad' };
  if (!hs.complete) return { kind: 'more' };
  try {
    return { kind: 'hello', name: serverName(hs.bytes) };
  } catch {
    return { kind: 'bad' };
  }
}

/** `alpha.hildegard.link` under `hildegard.link` → `alpha`. One label only, letters, digits and dashes; else null. */
export function linkName(host: string | null, domain: string): string | null {
  if (!host) return null;
  const h = host.toLowerCase().replace(/\.$/, '');
  const suffix = `.${domain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}
