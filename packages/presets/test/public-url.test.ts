// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parsePublicUrl } from '../src/index.ts';

describe('parsePublicUrl', () => {
  it('takes an https origin and gives it back normalized', () => {
    expect(parsePublicUrl('https://hildegard.example.com')).toEqual({
      ok: true,
      url: 'https://hildegard.example.com',
      host: 'hildegard.example.com',
    });
    expect(parsePublicUrl('  https://Hildegard.Example.com/ ')).toMatchObject({
      url: 'https://hildegard.example.com',
    });
    expect(parsePublicUrl('https://hg.example.org:8443')).toEqual({
      ok: true,
      url: 'https://hg.example.org:8443',
      host: 'hg.example.org:8443',
    });
    expect(parsePublicUrl('https://hg.example.org:443')).toMatchObject({ host: 'hg.example.org' });
  });

  it('refuses http, paths, queries, fragments, logins, addresses, Tailscale names and private names', () => {
    for (const bad of [
      undefined,
      42,
      '',
      'hildegard.example.com',
      'http://hildegard.example.com',
      'HTTP://hildegard.example.com',
      'ftp://hildegard.example.com',
      'https://hildegard.example.com/mcp',
      'https://hildegard.example.com//',
      'https://hildegard.example.com?',
      'https://hildegard.example.com/?a=1',
      'https://hildegard.example.com#x',
      'https://me@hildegard.example.com',
      'https://hildegard.example.com:0',
      'https://hildegard.example.com:70000',
      'https://hildegard.example.com:abc',
      'https://1.2.3.4',
      'https://127.1',
      'https://0x7f000001',
      'https://[fd7a:115c:a1e0::1]',
      'https://localhost',
      'https://hildegard',
      'https://studio.tail1234.ts.net',
      'https://STUDIO.tail1234.TS.NET:8443',
      'https://ts.net',
      'https://nas.local',
      'https://hildegard.example.com.',
      `https://${'a'.repeat(300)}.example.com`,
    ]) {
      expect(parsePublicUrl(bad).ok, String(bad)).toBe(false);
    }
  });
});
