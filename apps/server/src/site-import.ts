// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A live website into a site Hildegard keeps: opened in a real browser at desktop width, scrolled so lazy pictures
 * load, then written down as it stands (the page's HTML without its scripts, and every stylesheet, picture and font it
 * loaded, rewritten to load from the site's own folder). A full-page screenshot comes with it, so every round of the
 * web loop can be held to how the site looked. It's for redesigning a site you own or have the rights to.
 *
 * The browser may reach only public addresses: a name is looked up before each request, and loopback, private,
 * link-local and carrier-grade (Tailscale) addresses are refused, so a page can't make Hildegard read the owner's
 * own network.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Browser, Tab } from './browser.ts';

export class ImportError extends Error {}

/** True for addresses on the owner's own computer or network, and anything else that isn't the public internet. */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return privateAddress(mapped[1]!);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true;
}

/** Whether the browser may load this address: http(s) or data on a public host. */
export function publicOnly(look: (host: string) => Promise<string[]> = defaultLookup) {
  const seen = new Map<string, Promise<boolean>>();
  return async (url: string): Promise<boolean> => {
    if (/^(data|blob):/.test(url)) return true;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|.*\.ts\.net)$/i.test(host))
      return false;
    if (isIP(host)) return !privateAddress(host);
    let p = seen.get(host);
    if (!p) {
      p = look(host).then(
        (ips) => ips.length > 0 && ips.every((ip) => !privateAddress(ip)),
        () => false,
      );
      seen.set(host, p);
    }
    return p;
  };
}
const defaultLookup = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

export interface UrlImport {
  title: string;
  url: string;
  files: Map<string, Buffer>;
  reference: { data: Buffer; width: number } | null;
  notes: string[];
}

const EXT: Record<string, string> = {
  'text/css': 'css',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff2': 'woff2',
  'application/font-woff': 'woff',
  'application/x-font-woff': 'woff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
const KEEP = new Set(['Stylesheet', 'Image', 'Font', 'Media']);
const WIDTH = 1440;
const MAX_HEIGHT = 12_000;

/** In the page: its HTML without scripts or handlers, every address made absolute. */
const SNAPSHOT = `(() => {
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return ''; } };
  const doc = document.documentElement.cloneNode(true);
  const live = [...document.querySelectorAll('img')];
  [...doc.querySelectorAll('img')].forEach((img, i) => {
    const src = live[i] && (live[i].currentSrc || live[i].src);
    if (src) img.setAttribute('src', abs(src));
    img.removeAttribute('srcset'); img.removeAttribute('sizes'); img.removeAttribute('loading');
    for (const a of [...img.attributes]) if (/^data-(src|srcset|lazy)/.test(a.name)) img.removeAttribute(a.name);
  });
  doc.querySelectorAll('picture source').forEach((s) => s.remove());
  doc.querySelectorAll('script, noscript, iframe, object, embed, base, portal, template, link[rel~=preload], link[rel~=modulepreload], link[rel~=prefetch], link[rel~=dns-prefetch], link[rel~=preconnect], link[rel~=manifest], meta[http-equiv]').forEach((e) => e.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /^\\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      else if (a.name === 'nonce' || a.name === 'integrity' || a.name === 'crossorigin') el.removeAttribute(a.name);
    }
    for (const n of ['src', 'href', 'poster']) {
      const v = el.getAttribute(n);
      if (v && !v.startsWith('#') && !/^(mailto|tel|data):/i.test(v)) el.setAttribute(n, abs(v));
    }
    const st = el.getAttribute('style');
    if (st && st.includes('url(')) el.setAttribute('style', st.replace(/url\\((['"]?)([^'")]+)\\1\\)/g, (m, q, u) => /^data:/.test(u) ? m : 'url("' + abs(u) + '")'));
  }
  for (const s of doc.querySelectorAll('style')) s.textContent = s.textContent.replace(/url\\((['"]?)([^'")]+)\\1\\)/g, (m, q, u) => /^data:/.test(u) ? m : 'url("' + abs(u) + '")');
  return { html: '<!doctype html>\\n' + doc.outerHTML, title: document.title, url: location.href, height: Math.min(${MAX_HEIGHT}, Math.ceil(document.documentElement.scrollHeight)) };
})()`;

/** Scrolls to the bottom a screen at a time, so pictures that load as they're scrolled to have loaded. */
const SCROLL = `new Promise((done) => {
  let y = 0; const step = () => {
    y += innerHeight * 0.8; scrollTo(0, y);
    if (y < Math.min(document.documentElement.scrollHeight, ${MAX_HEIGHT})) setTimeout(step, 120);
    else setTimeout(() => { scrollTo(0, 0); setTimeout(done, 400); }, 400);
  }; step();
})`;

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Imports the page at `url`. `allow` decides which addresses the browser may load (public ones by default); the tests
 * pass their own to import from a local server.
 */
export async function importUrl(
  url: string,
  chrome: string,
  opts: { allow?: (url: string) => Promise<boolean>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<UrlImport> {
  let start: URL;
  try {
    start = new URL(url.trim());
  } catch {
    throw new ImportError('That isn’t a web address. Give the whole address, starting https://.');
  }
  if (start.protocol !== 'https:' && start.protocol !== 'http:')
    throw new ImportError('Only http and https addresses can be imported.');
  const allow = opts.allow ?? publicOnly();
  if (!(await allow(start.href)))
    throw new ImportError('That address is on this computer or its network. Import a public website.');
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const browser = new Browser(chrome, { offline: false });
  let timer: NodeJS.Timeout | undefined;
  const work = (async (): Promise<UrlImport> => {
    await browser.send('Browser.getVersion');
    const tab = await Tab.open(browser, allow);
    await tab.cmd('Network.enable', { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 50_000_000 });
    await tab.cmd('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await tab.cmd('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    const ok = await tab.go(start.href, 30_000).catch((e: Error) => {
      throw new ImportError(e.message);
    });
    await tab.eval(SCROLL).catch(() => {});
    const snap = await tab.eval<{ html: string; title: string; url: string; height: number }>(SNAPSHOT);
    await tab.cmd('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: Math.max(900, snap.height),
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 300));
    const shot = await tab.shoot(WIDTH, Math.max(900, snap.height), 'png').catch(() => null);

    // Every stylesheet, picture and font the page loaded, kept under assets/.
    const files = new Map<string, Buffer>();
    const local = new Map<string, string>();
    const skipped: string[] = [];
    let total = 0;
    for (const [requestId, r] of tab.responses) {
      if (!KEEP.has(r.type) || r.status < 200 || r.status >= 300 || local.has(r.url)) continue;
      if (!/^https?:/.test(r.url)) continue;
      const ext =
        EXT[r.mime.toLowerCase()] ?? /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(new URL(r.url).pathname)?.[1];
      if (!ext || !Object.values(EXT).includes(ext.toLowerCase())) continue;
      const body = (await tab.cmd('Network.getResponseBody', { requestId }).catch(() => null)) as {
        body: string;
        base64Encoded: boolean;
      } | null;
      if (!body) {
        skipped.push(r.url);
        continue;
      }
      const data = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
      if (total + data.length > maxBytes || files.size >= 1500) {
        skipped.push(r.url);
        continue;
      }
      total += data.length;
      const base =
        new URL(r.url).pathname
          .split('/')
          .pop()!
          .replace(/\.[^.]*$/, '')
          .replace(/[^\w-]+/g, '-')
          .slice(0, 40) || 'file';
      const path = `assets/${base}-${createHash('sha256').update(r.url).digest('hex').slice(0, 8)}.${ext.toLowerCase()}`;
      files.set(path, data);
      local.set(r.url, path);
    }

    // Stylesheets: their url()s and @imports point at the copies beside them.
    const fromCss = (cssUrl: string, ref: string) => {
      let abs: string;
      try {
        abs = new URL(ref, cssUrl).href;
      } catch {
        return null;
      }
      const to = local.get(abs);
      return to ? to.slice('assets/'.length) : null;
    };
    for (const [u, path] of local) {
      if (!path.endsWith('.css')) continue;
      const css = files
        .get(path)!
        .toString('utf8')
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, ref: string) => {
          if (ref.startsWith('data:') || ref.startsWith('#')) return m;
          const to = fromCss(u, ref);
          return to ? `url("${to}")` : m;
        })
        .replace(/@import\s+(['"])([^'"]+)\1/g, (m, _q, ref: string) => {
          const to = fromCss(u, ref);
          return to ? `@import "${to}"` : m;
        });
      files.set(path, Buffer.from(css));
    }

    // The page: every address it loaded, made local. Longest first, so no address is cut by a shorter one.
    let html = snap.html;
    for (const [u, path] of [...local].sort((a, b) => b[0].length - a[0].length)) {
      const amp = u.replace(/&/g, '&amp;');
      html = html.replace(new RegExp(escRe(amp), 'g'), path);
      if (amp !== u) html = html.replace(new RegExp(escRe(u), 'g'), path);
    }
    if (!/<meta[^>]+name=["']?viewport/i.test(html))
      html = html.replace(
        /<head([^>]*)>/i,
        '<head$1>\n<meta name="viewport" content="width=device-width, initial-scale=1">',
      );
    files.set('index.html', Buffer.from(html));
    tab.close();

    const host = new URL(snap.url).hostname;
    const notes = [
      `Imported from ${snap.url} at ${new Date().toISOString().slice(0, 10)}, as it looked at ${WIDTH} pixels wide. Import only a site you own or have the rights to.`,
      'Scripts were left out: menus, sliders and anything else the page did with JavaScript has to be built again, in HTML and CSS or a small script of the site’s own.',
      ...(ok ? [] : ['The page was still loading after 30 seconds; something on it may be missing.']),
      ...(skipped.length
        ? [
            `${skipped.length} files couldn’t be kept (too big, or the browser had let them go); they still load from ${host}.`,
          ]
        : []),
      ...(tab.blocked.size
        ? [
            `Refused ${tab.blocked.size} requests to addresses that aren’t public, such as ${[...tab.blocked][0]}.`,
          ]
        : []),
    ];
    return {
      title: snap.title.trim().slice(0, 120) || host,
      url: snap.url,
      files,
      reference: shot ? { data: Buffer.from(shot, 'base64'), width: WIDTH } : null,
      notes,
    };
  })();
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ImportError('The page took too long to import.')),
          opts.timeoutMs ?? 120_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    browser.close();
  }
}
