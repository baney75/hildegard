// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Whether a link to `url` keeps the key and prompts private: https anywhere; plain http only on loopback or inside
 * a tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48 or a *.ts.net name), where WireGuard encrypts it.
 */
export function privateLink(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const h = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (h.endsWith('.ts.net')) return true;
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127) return true;
  return /^fd7a:115c:a1e0:/.test(h);
}
