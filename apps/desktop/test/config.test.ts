// SPDX-License-Identifier: AGPL-3.0-only
// The app's security shape, read from its own config and source: the main window gets three commands and no remote
// page gets any; a site's window gets no capability at all, no script of ours, and no user agent but the webview's.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tauri = fileURLToPath(new URL('../src-tauri/', import.meta.url));
const read = (rel: string) => readFileSync(join(tauri, rel), 'utf8');
interface Capability {
  windows?: string[];
  permissions?: string[];
  remote?: unknown;
  webviews?: unknown;
  description?: string;
  $schema?: string;
}
interface AppConfig {
  app: {
    withGlobalTauri: boolean;
    windows: unknown[];
    security: {
      capabilities: string[];
      csp: Record<string, string>;
      dangerousRemoteDomainIpcAccess?: unknown;
    };
  };
}
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;
/** Rust source without its comments, so a comment that says what the code must not do isn't taken for the code. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');

describe('capabilities', () => {
  const files = readdirSync(join(tauri, 'capabilities')).filter((f) => f.endsWith('.json'));

  it('has one capability, for the main window, with no remote URL', () => {
    expect(files).toEqual(['main.json']);
    const main = json<Capability>('capabilities/main.json');
    expect(main.windows).toEqual(['main']);
    expect(main).not.toHaveProperty('remote');
    expect(main).not.toHaveProperty('webviews');
    expect(main.permissions).toEqual(['allow-launch', 'allow-install', 'allow-open-logs']);
  });

  it('names no window a site could have, and no wildcard', () => {
    for (const f of files) {
      const c = json<Capability>(`capabilities/${f}`);
      for (const w of c.windows ?? []) {
        expect(w, f).not.toMatch(/[*]/);
        expect(w, f).not.toMatch(/^site-/);
      }
      // Its description may say where the Studio is served from; nothing else in it names an address.
      const { description: _d, $schema: _s, ...rest } = c;
      expect(JSON.stringify(rest), f).not.toMatch(/https?:\/\//);
    }
  });

  it('turns nothing on in the app config that would give a page a way in', () => {
    const conf = json<AppConfig>('tauri.conf.json');
    expect(conf.app.security.capabilities).toEqual(['main']);
    expect(conf.app.security).not.toHaveProperty('dangerousRemoteDomainIpcAccess');
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.windows).toEqual([]);
    expect(conf.app.security.csp['default-src']).toBe("'self'");
    expect(conf.app.security.csp['frame-src']).toBe("'none'");
    // The two plugins the sites use are called from Rust only, and no permission for them is granted to any window.
    const granted = JSON.stringify(json<Capability>('capabilities/main.json').permissions);
    expect(granted).not.toMatch(/dialog|clipboard|opener|updater/);
  });
});

describe('the windows the app builds', () => {
  const lib = code('src/lib.rs');
  const browse = code('src/browse.rs');
  const siteBuilder = lib.slice(lib.indexOf('fn build_site'), lib.indexOf('fn google_offer'));

  it('shows its own pages in the main window and nothing remote', () => {
    const urls = [...lib.matchAll(/WebviewUrl::(\w+)/g)].map((m) => m[1]);
    // The main window: the app's own page. The site windows: an external address, from build_site and sign_out only.
    expect(lib.match(/WebviewWindowBuilder::new\(app, "main", WebviewUrl::App/g)).toHaveLength(1);
    expect(urls.filter((u) => u === 'App')).toHaveLength(1);
    expect(urls.filter((u) => u === 'External')).toHaveLength(2);
  });

  it('builds each site window with its own profile, navigation and download rules, and no way in', () => {
    expect(siteBuilder).toContain('WebviewUrl::External');
    for (const needed of [
      '.data_directory(',
      '.on_navigation(',
      '.on_new_window(',
      '.on_download(downloads)',
      'data_store_identifier',
    ]) {
      expect(siteBuilder, needed).toContain(needed);
    }
    expect(siteBuilder).toContain('NewWindowResponse::Deny');
    // No script of ours in a site's page, no other user agent, no tools, no hook into the webview.
    for (const forbidden of [
      'initialization_script',
      'user_agent',
      'devtools',
      'with_webview',
      'invoke_system',
      'capabilities',
      'add_capability',
    ]) {
      expect(siteBuilder, forbidden).not.toContain(forbidden);
      expect(lib, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
      expect(browse, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it('on Windows touches the webview only to keep other sites’ frames out', () => {
    // wry reports main-frame navigations only on Windows; frames.rs checks every document, and does nothing else.
    const frames = code('src/frames.rs');
    expect(lib).toMatch(/#\[cfg\(windows\)\]\s*mod frames;/);
    expect(siteBuilder).toMatch(/#\[cfg\(windows\)\]\s*if let Err\(e\) = frames::guard\(/);
    expect(frames.match(/\.with_webview\(/g)).toHaveLength(1);
    expect(frames).toContain('AddWebResourceRequestedFilterWithRequestSourceKinds(');
    expect(frames).toContain('COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT');
    expect(frames).toContain('browse::document_allowed(&site,');
    const calls = new Set([...frames.matchAll(/\.([A-Z][A-Za-z0-9]+|add_[A-Za-z]+)\(/g)].map((m) => m[1]));
    expect([...calls].sort()).toEqual(
      [
        'AddWebResourceRequestedFilterWithRequestSourceKinds',
        'CoreWebView2',
        'CreateWebResourceResponse',
        'Navigate',
        'Request',
        'ResourceContext',
        'SetResponse',
        'Uri',
        'add_WebResourceRequested',
      ].sort(),
    );
    for (const forbidden of [
      'initialization_script',
      'user_agent',
      'UserAgent',
      'Script',
      'WebMessage',
      'DevTools',
      'HostObject',
    ])
      expect(frames, forbidden).not.toContain(forbidden);
  });

  it('gives every site its own folder under Hildegard’s data, never a shared one', () => {
    expect(siteBuilder).toMatch(/browse::ensure_profile\(&hg\.layout\.data, &site\.id\)/);
    expect(siteBuilder).toMatch(/browse::window_label\(&site\.id\)/);
  });

  it('closes a site’s window when asked, where the main window only hides', () => {
    expect(lib).toMatch(/if window\.label\(\) != "main" \{\s*return;\s*\}/);
  });

  it('opens every outside address through the throttled system-browser path', () => {
    const calls = [...lib.matchAll(/open_url\(([^,]+),/g)].map((m) => m[1]!.trim());
    // open_outside, and handoff to the site's own post page: nothing else opens an address for a page.
    expect(calls).toEqual(['url.as_str()', 'site.post.as_str()']);
  });
});

interface Site {
  id: string;
  home: string;
  post: string;
  domains: string[];
  auth: string[];
}

describe('the sites', () => {
  const sites = (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../presets/post-sites.json', import.meta.url)), 'utf8'),
    ) as { sites: Site[] }
  ).sites;

  it('never lists a Google sign-in domain as a site’s own or a sign-in domain', () => {
    for (const s of sites)
      for (const d of [...s.domains, ...s.auth]) {
        expect(d, s.id).not.toMatch(/(^|\.)accounts\.google\.|(^|\.)google\.com$/);
        // Google's captcha is a path on its host, never the host.
        if (/(^|\.)google\.com\//.test(d))
          expect(d, s.id).toMatch(/^(www|recaptcha)\.google\.com\/recaptcha\/$/);
      }
  });

  it('asks nothing of a site but https pages on its own domains', () => {
    for (const s of sites) {
      for (const url of [s.home, s.post]) {
        const u = new URL(url);
        expect(u.protocol).toBe('https:');
        expect(
          s.domains.some((d: string) => u.hostname === d || u.hostname.endsWith(`.${d}`)),
          `${s.id} ${url}`,
        ).toBe(true);
      }
    }
  });
});
