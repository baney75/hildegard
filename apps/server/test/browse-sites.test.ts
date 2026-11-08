// SPDX-License-Identifier: AGPL-3.0-only
// The sites a person adds to the app's Browse menu: the same checks the app makes again before it opens one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowseSiteError, BrowseSites, removalNotice, sharedCookies, siteUrl } from '../src/browse-sites.ts';

describe('which addresses are a site', () => {
  it('takes https on a real host and nothing else', () => {
    expect(siteUrl('https://bsky.app/')?.hostname).toBe('bsky.app');
    expect(siteUrl('  https://www.example.com/start  ')?.hostname).toBe('www.example.com');
    for (const bad of [
      'http://example.com/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://192.168.1.10/',
      'https://2130706433/',
      'https://0x7f.1/',
      'https://intranet/',
      'https://printer.local/',
      'https://user:pw@example.com/',
      'https://example.com:8443/',
      'https://example.com./',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
    ])
      expect(siteUrl(bad), bad).toBeNull();
  });
});

describe('the list', () => {
  const fresh = () => new BrowseSites(mkdtempSync(join(tmpdir(), 'hg-browse-')));

  it('adds, lists and removes, in the file the app reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-browse-'));
    const sites = new BrowseSites(dir);
    const added = sites.add('Bluesky', 'https://bsky.app/');
    expect(added.id).toMatch(/^c-[0-9a-f]{8}$/);
    expect(sites.list()).toEqual([added]);
    // The app's reader: {"sites":[{"id","name","url"}]} under <data>/browse/sites.json.
    expect(JSON.parse(readFileSync(join(dir, 'browse', 'sites.json'), 'utf8'))).toEqual({ sites: [added] });
    mkdirSync(join(dir, 'browse', added.id), { recursive: true });
    writeFileSync(join(dir, 'browse', added.id, 'Cookies'), 'x');
    expect(sites.remove(added.id)).toEqual(added);
    expect(sites.list()).toEqual([]);
    // Its sign-in goes with it.
    expect(existsSync(join(dir, 'browse', added.id))).toBe(false);
  });

  it('refuses a bad address, a bad name, a repeat and a long list', () => {
    const sites = fresh();
    expect(() => sites.add('Local', 'https://localhost/')).toThrow(BrowseSiteError);
    expect(() => sites.add('  ', 'https://bsky.app/')).toThrow(/name/);
    sites.add('Bluesky', 'https://bsky.app/');
    expect(() => sites.add('Again', 'https://www.bsky.app/')).toThrow(/already/);
    for (let i = 0; i < 23; i++) sites.add(`Site ${i}`, `https://site${i}.example/`);
    expect(() => sites.add('One more', 'https://one-more.example/')).toThrow(/holds 24/);
    expect(() => sites.remove('c-nope')).toThrow(/No such site/);
  });

  it('ignores an entry in the file that would not pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-browse-'));
    mkdirSync(join(dir, 'browse'));
    writeFileSync(
      join(dir, 'browse', 'sites.json'),
      JSON.stringify({
        sites: [
          { id: 'c-aaaa', name: 'Ok', url: 'https://ok.example/' },
          { id: 'x', name: 'Impostor', url: 'https://x.example/' },
          { id: 'c-bbbb', name: 'Local', url: 'https://localhost/' },
        ],
      }),
    );
    expect(new BrowseSites(dir).list().map((s) => s.id)).toEqual(['c-aaaa']);
  });
});

describe('what removing a site says', () => {
  it('says its sign-in is gone where each site has its own store', () => {
    expect(removalNotice('Bluesky', false)).toBe(
      'Removed Bluesky. Its window closes, and its cookies and saved data are gone from Hildegard.',
    );
  });

  it('says on macOS 11 to 13 that the sign-in may stay, and how to sign out on the site', () => {
    const text = removalNotice('Bluesky', true);
    expect(text).toMatch(/can’t clear Bluesky’s alone/);
    expect(text).toMatch(/use its own Sign out/);
    expect(text).not.toMatch(/gone/);
  });
});

describe('cookies on older macOS', () => {
  it('says shared for macOS 11 to 13 (Darwin 20 to 22) and no other system', () => {
    expect(sharedCookies('darwin', '20.6.0')).toBe(true);
    expect(sharedCookies('darwin', '22.1.0')).toBe(true);
    expect(sharedCookies('darwin', '23.0.0')).toBe(false);
    expect(sharedCookies('linux', '6.1.0')).toBe(false);
    expect(sharedCookies('win32', '10.0.0')).toBe(false);
  });
});
