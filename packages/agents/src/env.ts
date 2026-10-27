// SPDX-License-Identifier: AGPL-3.0-only
/** The environment Pi gets, shared by running it and by asking it its version. */

/**
 * What Pi may read from Hildegard's environment: enough to start, find programs and use a temp folder, and nothing
 * that could hold a sign-in or a key other than the one Hildegard sets. Windows needs its system variables to start
 * Node at all.
 */
export const PI_ENV = [
  'PATH',
  // Proxies, certificate authorities and a local model server's address: needed to reach a provider. A proxy URL can
  // carry the proxy's own user and password; those pass through, since Pi can't reach the provider without them.
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'OLLAMA_HOST',
  'HOME',
  'LANG',
  'LC_*',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ComSpec',
];

/**
 * The variables of `from` that `names` allows: exact names, or prefixes ending in `*`. Windows' names ignore case
 * (`Path` is `PATH` there).
 */
export function inherited(
  from: NodeJS.ProcessEnv,
  names: readonly string[],
  caseless = false,
): NodeJS.ProcessEnv {
  const norm = (x: string) => (caseless ? x.toUpperCase() : x);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    const key = norm(k);
    if (
      v !== undefined &&
      names.some((n) => (n.endsWith('*') ? key.startsWith(norm(n.slice(0, -1))) : key === norm(n)))
    )
      out[k] = v;
  }
  return out;
}
