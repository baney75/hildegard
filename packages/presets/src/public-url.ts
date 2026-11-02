// SPDX-License-Identifier: Apache-2.0
/**
 * `hildegard host --public-url`: the owner's own HTTPS front door (a Cloudflare named tunnel, Caddy, and the like)
 * that forwards to Hildegard's hosted listener. Checked the same way by the CLI before it asks and by the server
 * before it believes it.
 */

export type PublicUrl =
  | {
      ok: true /** The origin to save, such as https://hildegard.example.com or https://example.com:8443. */;
      url: string;
      host: string;
    }
  | { ok: false; error: string };

const BAD = (error: string): PublicUrl => ({ ok: false, error });

/** The name must be DNS, with at least one dot: not an address, not `localhost`, not a bare word. */
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Check a front door's address: an https origin, nothing after it, on a name of your own. */
export function parsePublicUrl(input: unknown): PublicUrl {
  if (typeof input !== 'string' || !input.trim())
    return BAD('Give the https address people will use, such as https://hildegard.example.com.');
  const raw = input.trim();
  if (raw.length > 300) return BAD('That address is too long.');
  if (/^http:\/\//i.test(raw))
    return BAD(
      'Use an https address. Your front door (the tunnel or proxy) must give it HTTPS, so passphrases never cross the internet in the clear.',
    );
  const m = /^https:\/\/([^/?#]*)\/?$/i.exec(raw);
  if (!m)
    return BAD(
      /^https:\/\//i.test(raw)
        ? 'Give only the address, with no path, query or fragment: https://hildegard.example.com.'
        : 'Give an https address, such as https://hildegard.example.com.',
    );
  if (m[1]!.includes('@')) return BAD('Leave out any user name or password.');
  let u: URL;
  try {
    u = new URL(`https://${m[1]}`);
  } catch {
    return BAD('That isn’t a web address. Try https://hildegard.example.com.');
  }
  if (/:0+$/.test(m[1]!)) return BAD('Port 0 isn’t a port. Leave the port out for the usual 443.');
  const name = u.hostname.toLowerCase();
  if (name.startsWith('[') || /^[\d.]+$/.test(name) || /^0x[0-9a-f]+$/i.test(name))
    return BAD('Use a name, not an IP address: https certificates are issued for names.');
  if (name === 'ts.net' || name.endsWith('.ts.net'))
    return BAD(
      'A .ts.net name belongs to Tailscale. For it, run `hildegard host` (the tailnet) or `hildegard host --funnel` (the public internet).',
    );
  if (!DNS_NAME.test(name)) return BAD('That isn’t a public web name, like hildegard.example.com.');
  if (/\.(local|localhost|internal|lan|home|arpa)$/.test(name))
    return BAD('That name only works on your own network. Use the public name your front door answers to.');
  return { ok: true, url: u.origin, host: u.host };
}
