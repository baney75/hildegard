// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import { encode } from 'uqr';

/** The dark modules of a QR code as one SVG path, one unit per module, inside a quiet zone of `border` modules (four, as the QR standard asks). */
export function qrPath(text: string, border = 4): { d: string; size: number } {
  const { data, size } = encode(text, { ecc: 'M', border });
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y]![x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && data[y]![x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  }
  return { d, size };
}

/** Whether a link only works on this computer (a phone that opened it would reach itself). */
export function loopbackOnly(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return true;
  }
  // 127.0.0.0/8, ::1, the unspecified addresses, and localhost with its subdomains (RFC 6761).
  return (
    /^127\./.test(host) ||
    ['[::1]', '[::]', '0.0.0.0', 'localhost'].includes(host) ||
    host.endsWith('.localhost') ||
    /^\[::ffff:7f/.test(host)
  );
}

/**
 * A link as a QR code, to open it on a phone by pointing its camera at the screen. Always dark on light, whatever the
 * theme: phone cameras read that reliably.
 */
export function Qr({ value, label, hint }: { value: string; label: string; hint: string }) {
  const { d, size } = useMemo(() => qrPath(value), [value]);
  return (
    <figure className="hg-qr">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <rect width={size} height={size} fill="#fff" />
        <path d={d} fill="#0b0d10" />
      </svg>
      <figcaption className="body-sm sec-text">{hint}</figcaption>
    </figure>
  );
}
