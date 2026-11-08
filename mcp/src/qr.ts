// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A QR code as a PNG, for AI apps that show images: a phone's camera reads the screen. Dark on white with a four-module
 * quiet zone, whatever the app's theme, since phone cameras read that reliably.
 */
import { crc32, deflateSync } from 'node:zlib';
import { encode } from 'uqr';

const SCALE = 8;

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** The QR code for `text` as PNG bytes (8-bit greyscale). */
export function qrPng(text: string): Buffer {
  const { data, size } = encode(text, { ecc: 'M', border: 4 });
  const px = size * SCALE;
  // One filter byte (none) per row, then one byte per pixel.
  const raw = Buffer.alloc((px + 1) * px, 0xff);
  for (let y = 0; y < px; y++) {
    const row = y * (px + 1);
    raw[row] = 0;
    const mods = data[Math.floor(y / SCALE)]!;
    for (let x = 0; x < px; x++) if (mods[Math.floor(x / SCALE)]) raw[row + 1 + x] = 0x0b;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
