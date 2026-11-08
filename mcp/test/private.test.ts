// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isSiteProfile, readable } from '../src/private.ts';

describe('a signed-in site’s profile', () => {
  it('is never read, on any system', () => {
    for (const p of [
      '/home/someone/.local/share/hildegard/browse/x/Cookies',
      '/Users/someone/Library/Application Support/Hildegard/browse/instagram/WebKit/LocalStorage',
      'C:\\Users\\Someone\\AppData\\Local\\Hildegard\\browse\\tiktok\\EBWebView\\Default\\Cookies',
      '/data/hildegard/browse/c-1a2b3c4d/x',
    ])
      expect(isSiteProfile(p), p).toBe(true);
    // Another folder named for another reason is only a path.
    for (const p of ['/home/someone/Videos/browse/a.mp4', '/home/someone/.local/share/hildegard/media/a.mp4'])
      expect(isSiteProfile(p), p).toBe(false);
  });

  it('is found by the folder the app was told it lives in', () => {
    expect(isSiteProfile('/srv/studio/browse/x/Cookies', '/srv/studio')).toBe(true);
    expect(isSiteProfile('/srv/studio/media/a.mp4', '/srv/studio')).toBe(false);
    // Not by a path that only starts the same way.
    expect(isSiteProfile('/srv/studio/browser/x', '/srv/studio')).toBe(false);
  });

  it('is refused with a plain sentence before anything reads it', () => {
    expect(() => readable('/home/a/.local/share/hildegard/browse/x/Cookies')).toThrow(/never read it/);
    expect(readable('/home/a/Videos/a.mp4')).toBe('/home/a/Videos/a.mp4');
  });
});
