// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A self-signed certificate for `link.test` and `*.link.test`, made fresh for each test run so no private key is ever
 * committed. Node can sign but not build certificates, so this writes the few DER structures by hand.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const len = (n: number) =>
  n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const time = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END ${label}-----\n`;

export function testCert(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('link.test')))));
  const now = Date.now();
  const extensions = seq(
    // Basic constraints: CA, so it can be its own trust anchor.
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),
    // Subject alternative names.
    seq(
      oid('2.5.29.17'),
      tlv(0x04, seq(tlv(0x82, Buffer.from('link.test')), tlv(0x82, Buffer.from('*.link.test')))),
    ),
  );
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
    ecdsaSha256,
    name,
    seq(time(new Date(now - 86_400_000)), time(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, extensions),
  );
  const sig = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.from([0]), sig));
  return {
    cert: pem('CERTIFICATE', cert),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}
