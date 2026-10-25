// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks a web page the way its visitors will meet it: Hildegard opens it in a real browser (Chrome, Chromium, Edge
 * or Brave, whichever this computer has) at a phone, a tablet and a desktop width, in light and dark, photographs each
 * one top to bottom, and audits it with tools/review_web.js: text that can't be read, a page that scrolls sideways,
 * controls with no name, targets too small for a thumb, missing alt text, broken images, script errors, and the
 * marks of a template nobody designed. The contact sheet outlines each problem where it is on the page.
 *
 * The page is a stranger's code, so it runs shut in: a fresh browser profile, served from a one-off address on this
 * computer that answers only for the round's own folder, with every other request refused (and reported, since a page
 * that needs the web isn't private and breaks offline). The browser is driven over a pipe, never a network port.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, platform, tmpdir } from 'node:os';
import { delimiter, extname, join, normalize, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Check, Review } from '@hildegard/craft';
import { resource } from '@hildegard/runtime';

export interface WebSpec {
  /** The site's folder: the round's files, with the pages in it. */
  dir: string;
  /** The pages to check, as paths inside `dir`; the first is the one the sheet leads with. */
  pages: string[];
  /** Where to write the contact sheet (JPEG). */
  sheet?: string;
  /** Hold it to the bar for a page that ships, not a draft. */
  final?: boolean;
  /** The brief asked for a dark theme that follows the visitor's setting. */
  dark?: boolean;
}

interface Viewport {
  name: 'phone' | 'tablet' | 'desktop';
  width: number;
  height: number;
  mobile: boolean;
}
const VIEWPORTS: Viewport[] = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'tablet', width: 820, height: 1180, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];
/** Longest page photographed, in CSS pixels; past it the sheet says the page goes on. */
const MAX_PAGE = 9000;

// ── Finding a browser ────────────────────────────────────────────────────────────────────────────────────────────

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
];
const WIN_APPS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'Chromium\\Application\\chrome.exe',
];
const LINUX_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge-stable',
  'microsoft-edge',
  'brave-browser',
  'brave',
];

/** The newest Chromium that Playwright downloaded, if any (people who build for the web often have one). */
function playwrightChromium(env: NodeJS.ProcessEnv, os: NodeJS.Platform): string | null {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    os === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : os === 'win32'
        ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright'),
  ].filter((r): r is string => !!r && r !== '0');
  const inside =
    os === 'darwin'
      ? [
          'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        ]
      : os === 'win32'
        ? ['chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']
        : ['chrome-linux64/chrome', 'chrome-linux/chrome'];
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    } catch {
      continue;
    }
    for (const d of dirs)
      for (const rel of inside) {
        const p = join(root, d, rel);
        if (existsSync(p)) return p;
      }
  }
  return null;
}

/** A Chromium-family browser on this computer: HILDEGARD_CHROME, then the usual places, then Playwright's. */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
): string | null {
  if (env.HILDEGARD_CHROME) return existsSync(env.HILDEGARD_CHROME) ? env.HILDEGARD_CHROME : null;
  const candidates: string[] = [];
  if (os === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')])
      candidates.push(...MAC_APPS.map((a) => join(root, a)));
  } else if (os === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean))
      candidates.push(...WIN_APPS.map((a) => join(root!, a)));
  } else {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean))
      candidates.push(...LINUX_NAMES.map((n) => join(dir, n)));
  }
  return candidates.find((c) => existsSync(c)) ?? playwrightChromium(env, os);
}

// ── The browser, over a pipe ─────────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
}

/** Chrome DevTools Protocol over --remote-debugging-pipe: messages are JSON, each ended by a NUL byte. */
class Browser {
  private readonly child: ChildProcess;
  private readonly out: Writable;
  private readonly profile: string;
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: Json, session?: string) => void>();
  private buffer = '';
  private closed = false;

  constructor(chrome: string) {
    this.profile = mkdtempSync(join(tmpdir(), 'hg-web-'));
    const args = [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      // Nothing leaves this computer: every request but loopback goes to a closed port, and names don't resolve.
      '--proxy-server=http://127.0.0.1:9',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // Chrome's sandbox won't start as root (containers, CI); the page is still shut in by everything above.
      ...(process.getuid?.() === 0 || process.env.HILDEGARD_CHROME_NO_SANDBOX ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    this.child = spawn(chrome, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.out = this.child.stdio[3] as Writable;
    const input = this.child.stdio[4] as Readable;
    let err = '';
    this.child.stderr?.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    input.on('data', (d: Buffer) => this.read(d.toString('utf8')));
    const fail = (why: string) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    this.child.once('error', (e) => fail(`Could not start the browser (${chrome}): ${e.message}`));
    this.child.once('exit', () => fail(`The browser stopped. ${err.trim().split('\n').at(-1) ?? ''}`.trim()));
    this.out.on('error', () => {});
  }

  private read(chunk: string) {
    this.buffer += chunk;
    for (let at = this.buffer.indexOf('\0'); at >= 0; at = this.buffer.indexOf('\0')) {
      const msg = JSON.parse(this.buffer.slice(0, at)) as {
        id?: number;
        result?: Json;
        error?: { message: string };
        method?: string;
        params?: Json;
        sessionId?: string;
      };
      this.buffer = this.buffer.slice(at + 1);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
      }
    }
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('The browser has stopped.'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(l: (method: string, params: Json, session?: string) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close() {
    if (!this.closed) this.send('Browser.close').catch(() => {});
    setTimeout(() => this.child.kill(), 2000).unref();
    this.child.once('exit', () => rmSync(this.profile, { recursive: true, force: true }));
    if (this.child.exitCode !== null) rmSync(this.profile, { recursive: true, force: true });
  }
}

/** A tab, attached in flat mode so its commands carry its session. */
class Tab {
  readonly blocked = new Set<string>();
  readonly errors: string[] = [];
  bytes = 0;
  requests = 0;
  private readonly off: () => void;
  private loaded: (() => void) | null = null;

  readonly browser: Browser;
  readonly session: string;

  private constructor(browser: Browser, session: string, origin: string) {
    this.browser = browser;
    this.session = session;
    this.off = browser.on((method, p, s) => {
      if (s !== session) return;
      if (method === 'Fetch.requestPaused') {
        const url = String((p.request as Json).url);
        const ok = url.startsWith(`${origin}/`) || url === origin;
        if (ok) {
          this.requests++;
          void browser.send('Fetch.continueRequest', { requestId: p.requestId }, session).catch(() => {});
        } else {
          this.blocked.add(url.length > 120 ? `${url.slice(0, 117)}…` : url);
          void browser
            .send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, session)
            .catch(() => {});
        }
      } else if (method === 'Network.loadingFinished') {
        this.bytes += Number(p.encodedDataLength ?? 0);
      } else if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails as Json;
        const ex = d.exception as Json | undefined;
        this.errors.push(
          String(ex?.description ?? d.text ?? 'An error')
            .split('\n')[0]!
            .slice(0, 200),
        );
      } else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        const args = (p.args as Json[]) ?? [];
        this.errors.push(
          args
            .map((a) => String(a.value ?? a.description ?? ''))
            .join(' ')
            .slice(0, 200),
        );
      } else if (method === 'Page.loadEventFired') {
        this.loaded?.();
      }
    });
  }

  static async open(browser: Browser, origin: string): Promise<Tab> {
    const { targetId } = (await browser.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const { sessionId } = (await browser.send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId: string;
    };
    const tab = new Tab(browser, sessionId, origin);
    await Promise.all(
      ['Page.enable', 'Runtime.enable', 'Network.enable'].map((m) => browser.send(m, {}, sessionId)),
    );
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    return tab;
  }

  cmd(method: string, params: Json = {}) {
    return this.browser.send(method, params, this.session);
  }

  async go(url: string, timeoutMs = 20_000) {
    const loaded = new Promise<void>((r) => {
      this.loaded = r;
    });
    const nav = (await this.cmd('Page.navigate', { url })) as { errorText?: string };
    if (nav.errorText) throw new Error(`The page didn’t open: ${nav.errorText}.`);
    const timer = new Promise<'late'>((r) => setTimeout(() => r('late'), timeoutMs));
    const late = (await Promise.race([loaded, timer])) === 'late';
    // Fonts and a frame or two of layout, so the photograph is of the page as it settles.
    await this.cmd('Runtime.evaluate', {
      expression:
        'document.fonts ? document.fonts.ready.then(() => new Promise(r => setTimeout(r, 250))) : 0',
      awaitPromise: true,
    }).catch(() => {});
    return !late;
  }

  async eval<T>(expression: string): Promise<T> {
    const r = (await this.cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async shoot(width: number, height: number, format: 'png' | 'jpeg' = 'png') {
    const r = (await this.cmd('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: 86 } : {}),
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    })) as { data: string };
    return r.data;
  }

  close() {
    this.off();
  }
}

// ── Serving the round ────────────────────────────────────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves one folder, read only, on a one-off loopback port. Nothing outside the folder answers. */
function serveFolder(dir: string): Promise<{ origin: string; server: Server }> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let file = resolve(root, normalize(`.${path}`));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const body = readFileSync(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      ok({ origin: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, server });
    });
  });
}

// ── What a page is checked for ───────────────────────────────────────────────────────────────────────────────────

interface Found {
  what: string;
  box: [number, number, number, number];
  [k: string]: unknown;
}
export interface Audit {
  viewport: string;
  width: number;
  height: number;
  pageHeight: number;
  title: string;
  lang: string;
  viewportMeta: string;
  description: string;
  background: string;
  colorScheme: string;
  sideways: boolean;
  scrollWidth: number;
  overflow: Found[];
  contrast: Found[];
  contrastCount: number;
  textCount: number;
  unchecked: number;
  small: Found[];
  smallCount: number;
  longLines: Found[];
  families: string[];
  unnamed: Found[];
  unnamedCount: number;
  unlabelled: Found[];
  targets: Found[];
  targetCount: number;
  noAlt: Found[];
  noAltCount: number;
  broken: Found[];
  heavy: Found[];
  images: number;
  h1: number;
  skips: Found[];
  placeholder: boolean;
  standIn: string;
  stock: string[];
  emojiIcons: number;
  words: number;
  animated: boolean;
  reduced: boolean;
  outlineOff: boolean;
  focusStyled: boolean;
}

export interface PageShot {
  page: string;
  viewport: Viewport['name'];
  /** The viewport, in CSS pixels. */
  width: number;
  screen: number;
  dark: boolean;
  /** PNG, base64: the page from the top, up to MAX_PAGE tall. */
  png: string;
  height: number;
  cut: boolean;
  audit: Audit;
}

const check = (
  id: string,
  status: Check['status'],
  value: unknown,
  limit: unknown,
  detail: string,
): Check => ({
  id,
  status,
  value,
  limit,
  detail,
});
const list = (xs: Found[], n = 3, extra?: (f: Found) => string) =>
  xs
    .slice(0, n)
    .map((f) => `${f.what}${extra ? ` (${extra(f)})` : ''}`)
    .join('; ');

/** The checks, from every page at every viewport. Exported for tests. */
export function judge(
  shots: PageShot[],
  net: { blocked: string[]; errors: string[]; bytes: number; late: string[] },
  spec: Pick<WebSpec, 'final' | 'dark'>,
): Check[] {
  const light = shots.filter((s) => !s.dark);
  const at = (v: Viewport['name']) => light.filter((s) => s.viewport === v);
  const where = (s: PageShot) => `${s.page} at ${s.viewport}${s.dark ? ', dark' : ''}`;
  const worst = <K extends keyof Audit>(xs: PageShot[], k: K) =>
    xs.filter((s) => (Array.isArray(s.audit[k]) ? (s.audit[k] as unknown[]).length : s.audit[k]));
  const out: Check[] = [];

  out.push(
    check(
      'loads',
      net.late.length ? 'fail' : 'pass',
      net.late,
      [],
      'Pages that didn’t finish loading within 20 seconds. Something on them waits forever: a script, a font, an image from the web.',
    ),
  );
  out.push(
    check(
      'errors',
      net.errors.length ? 'fail' : 'pass',
      net.errors.slice(0, 5),
      [],
      'Script errors and console errors while the page loaded. Each one is something broken for every visitor.',
    ),
  );

  const sideways = light.filter((s) => s.audit.sideways);
  out.push(
    check(
      'overflow',
      sideways.length ? 'fail' : 'pass',
      sideways.map((s) => `${where(s)}: ${s.audit.scrollWidth}px wide`),
      'no sideways scroll',
      `The page scrolls sideways${sideways.length ? `; what sticks out: ${list(sideways[0]!.audit.overflow)}` : ''}. Let it wrap, give images max-width: 100%, and check fixed widths.`,
    ),
  );

  const low = shots.filter((s) => s.audit.contrastCount);
  const lowCount = low.reduce((n, s) => n + s.audit.contrastCount, 0);
  out.push(
    check(
      'contrast',
      lowCount ? 'fail' : 'pass',
      lowCount,
      'WCAG AA: 4.5:1, or 3:1 for large text',
      `Text that’s too faint for its background${low.length ? `, such as ${list(low[0]!.audit.contrast, 3, (f) => `${f.ratio}:1, needs ${f.need}:1`)} (${where(low[0]!)})` : ''}. Darken the text or lighten the ground until it passes.${shots.some((s) => s.audit.unchecked) ? ' Text over images or gradients can’t be measured: look at it on the sheet.' : ''}`,
    ),
  );

  const noAlt = worst(light, 'noAlt');
  out.push(
    check(
      'alt',
      noAlt.length ? 'fail' : 'pass',
      Math.max(0, ...light.map((s) => s.audit.noAltCount)),
      0,
      `Images with no alt attribute${noAlt.length ? `: ${list(noAlt[0]!.audit.noAlt, 3, (f) => String(f.src))}` : ''}. Describe what each shows for people who can’t see it, or alt="" if it’s decoration.`,
    ),
  );
  const broken = worst(light, 'broken');
  out.push(
    check(
      'images',
      broken.length ? 'fail' : 'pass',
      [...new Set(broken.flatMap((s) => s.audit.broken.map((f) => String(f.src))))].slice(0, 5),
      [],
      'Images that didn’t load. Send them in the zip beside the page, with paths relative to it.',
    ),
  );
  const unnamed = worst(light, 'unnamed');
  out.push(
    check(
      'names',
      unnamed.length ? 'fail' : 'pass',
      Math.max(0, ...light.map((s) => s.audit.unnamedCount)),
      0,
      `Links and buttons with nothing to call them by${unnamed.length ? `: ${list(unnamed[0]!.audit.unnamed)}` : ''}. A screen reader says “button”; give each words, or an aria-label for an icon.`,
    ),
  );
  const unlabelled = worst(light, 'unlabelled');
  out.push(
    check(
      'labels',
      unlabelled.length ? 'fail' : 'pass',
      unlabelled.length ? unlabelled[0]!.audit.unlabelled.length : 0,
      0,
      `Form fields without a label${unlabelled.length ? `: ${list(unlabelled[0]!.audit.unlabelled)}` : ''}. A placeholder isn’t a label; it vanishes as you type.`,
    ),
  );
  const tiny = at('phone').filter((s) => s.audit.targetCount);
  out.push(
    check(
      'targets',
      tiny.length ? 'warn' : 'pass',
      Math.max(0, ...at('phone').map((s) => s.audit.targetCount)),
      '24 × 24 CSS pixels on a phone',
      `Things to tap that are smaller than a fingertip can hit${tiny.length ? `: ${list(tiny[0]!.audit.targets, 3, (f) => (f.size as number[]).join(' × '))}` : ''}. Pad them to 44 pixels where you can.`,
    ),
  );
  const small = at('phone').filter((s) => s.audit.smallCount);
  out.push(
    check(
      'text-size',
      small.length ? 'warn' : 'pass',
      Math.max(0, ...at('phone').map((s) => s.audit.smallCount)),
      '12 px on a phone',
      `Text under 12 pixels on a phone${small.length ? `: ${list(small[0]!.audit.small)}` : ''}. Body text reads best at 16.`,
    ),
  );
  const long = at('desktop').filter((s) => s.audit.longLines.length);
  out.push(
    check(
      'measure',
      long.length ? 'warn' : 'pass',
      long.length ? Math.max(...long[0]!.audit.longLines.map((f) => Number(f.chars))) : 0,
      '90 characters a line',
      'Lines of body text too long to read comfortably on a desktop. Hold paragraphs to about 65 characters (max-width: 65ch).',
    ),
  );
  const families = [...new Set(light.flatMap((s) => s.audit.families))];
  out.push(
    check(
      'fonts',
      families.length > 3 ? 'warn' : 'pass',
      families,
      3,
      'Typefaces in use. More than three reads as nobody chose; one for text and one for display is usually right.',
    ),
  );
  const first = light[0]?.audit;
  const structure: string[] = [];
  if (first && first.h1 !== 1) structure.push(`${first.h1} h1 headings (want one)`);
  const skips = [...new Map(light.flatMap((s) => s.audit.skips).map((f) => [f.what, f])).values()];
  if (skips.length)
    structure.push(`a heading skips a level: ${list(skips, 2, (f) => `h${f.from} to h${f.to}`)}`);
  out.push(
    check(
      'headings',
      structure.length ? 'warn' : 'pass',
      structure,
      'one h1, no skipped levels',
      'The outline a screen reader and a search engine see. One h1 that says what the page is, then h2, h3 in order.',
    ),
  );
  const head: string[] = [];
  for (const s of light.filter((x) => x.viewport === 'phone')) {
    if (!s.audit.title) head.push(`${s.page}: no <title>`);
    if (!s.audit.lang) head.push(`${s.page}: no lang on <html>`);
    if (!/width=device-width/.test(s.audit.viewportMeta)) head.push(`${s.page}: no viewport meta`);
  }
  out.push(
    check(
      'head',
      head.some((h) => /viewport|title/.test(h)) ? 'fail' : head.length ? 'warn' : 'pass',
      head,
      [],
      'The basics every page needs: a <title>, <html lang>, and <meta name="viewport" content="width=device-width, initial-scale=1"> (without it a phone shows the desktop page shrunk).',
    ),
  );

  const placeholder = light.find((s) => s.audit.placeholder);
  const standIn = light.find((s) => s.audit.standIn);
  out.push(
    check(
      'placeholder',
      placeholder ? 'fail' : standIn ? 'warn' : 'pass',
      placeholder ? 'lorem ipsum' : (standIn?.audit.standIn ?? ''),
      'real words',
      'Placeholder text or stand-in names. A page is designed around its real words; write them, or ask your user for them.',
    ),
  );
  const stock = [...new Set(light.flatMap((s) => s.audit.stock))];
  out.push(
    check(
      'stock-copy',
      stock.length >= 2 ? 'warn' : 'pass',
      stock,
      'none',
      'Phrases from every template (“unlock the power”, “seamless”, “elevate your”). Say the plain, specific thing this product does.',
    ),
  );
  const emoji = Math.max(0, ...light.map((s) => s.audit.emojiIcons));
  out.push(
    check(
      'emoji-icons',
      emoji >= 3 ? 'warn' : 'pass',
      emoji,
      'under 3',
      'Headings, buttons and list items that start with an emoji in place of an icon. It reads as a template; draw or choose real icons, or let the words stand.',
    ),
  );

  if (net.blocked.length || spec.final)
    out.push(
      check(
        'offline',
        net.blocked.length ? (spec.final ? 'fail' : 'warn') : 'pass',
        net.blocked.slice(0, 6),
        'nothing from the web',
        'Things the page asked the web for, which Hildegard refused (fonts, scripts and images from other sites). A page that needs them breaks offline and tells those sites who visits. Put them in the zip beside the page.',
      ),
    );
  const mb = net.bytes / 1024 / 1024;
  out.push(
    check(
      'weight',
      mb > 15 ? 'fail' : mb > 3 ? 'warn' : 'pass',
      `${mb.toFixed(2)} MB`,
      '3 MB',
      'What the first page weighs. Over 3 MB is slow on a phone signal: size images to how big they’re shown, as WebP or AVIF.',
    ),
  );
  const heavy = light.flatMap((s) => s.audit.heavy);
  if (heavy.length)
    out.push(
      check(
        'image-size',
        'warn',
        list(heavy, 3, (f) => `${f.natural}px shown at ${f.shown}px`),
        '2.5 × the size shown',
        'Images much bigger than they’re shown. Export them at twice the shown width at most.',
      ),
    );

  const dark = shots.filter((s) => s.dark);
  if (dark.length) {
    const same = dark.filter(
      (d) =>
        light.find((l) => l.page === d.page && l.viewport === d.viewport)?.audit.background ===
        d.audit.background,
    );
    out.push(
      check(
        'dark',
        same.length ? (spec.dark ? 'fail' : 'pass') : 'pass',
        same.length ? 'the same in dark' : 'follows the visitor’s setting',
        spec.dark ? 'a dark theme' : null,
        spec.dark
          ? 'Whether the page has a dark theme when the visitor’s system asks for one (prefers-color-scheme: dark).'
          : 'Whether the page changes when the visitor’s system is dark. Not asked for, so either is fine; if it does change, check the dark views as hard as the light.',
      ),
    );
  }
  const motion = light.find((s) => s.audit.animated && !s.audit.reduced);
  out.push(
    check(
      'motion',
      motion ? 'warn' : 'pass',
      motion ? 'animates, with no reduced-motion style' : 'fine',
      '@media (prefers-reduced-motion: reduce)',
      'Animation without a way out. Some visitors get sick from motion; calm it under prefers-reduced-motion.',
    ),
  );
  const focus = light.find((s) => s.audit.outlineOff && !s.audit.focusStyled);
  out.push(
    check(
      'focus',
      focus ? 'fail' : 'pass',
      focus ? 'outline removed, no :focus style' : 'fine',
      'a visible focus',
      'Whether someone using a keyboard can see where they are. Never remove the outline without a :focus-visible style in its place.',
    ),
  );
  return out;
}

// ── The contact sheet ────────────────────────────────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The sheet, as a page for the same browser to photograph: the first screen of every view, then whole pages. */
export function sheetHtml(
  shots: PageShot[],
  checks: Check[],
  title: string,
): { html: string; width: number } {
  const width = 1720;
  const bad = checks.filter((c) => c.status !== 'pass');
  const marks = (s: PageShot, scale: number) =>
    [
      ...s.audit.contrast.map((f) => ['contrast', f] as const),
      ...s.audit.overflow.map((f) => ['overflow', f] as const),
      ...s.audit.targets.map((f) => ['target', f] as const),
      ...s.audit.unnamed.map((f) => ['name', f] as const),
      ...s.audit.noAlt.map((f) => ['alt', f] as const),
      ...s.audit.broken.map((f) => ['image', f] as const),
      ...s.audit.small.map((f) => ['size', f] as const),
    ]
      .filter(([, f]) => f.box[1] < s.height)
      .map(
        ([k, f]) =>
          `<i class="m" style="left:${f.box[0] * scale}px;top:${f.box[1] * scale}px;width:${Math.max(4, f.box[2] * scale)}px;height:${Math.max(4, f.box[3] * scale)}px" title="${k}"></i>`,
      )
      .join('');
  const label = (s: PageShot) =>
    `${esc(s.page)} · ${s.viewport} ${s.width}px${s.dark ? ' · dark' : ''}${s.cut ? ` · first ${s.height}px` : ''}`;

  // Row one: what a visitor sees first, at each width, light and dark, all the same height.
  const foldH = 330;
  const lead = shots.filter((s) => s.page === shots[0]?.page);
  const fold = lead
    .map((s) => {
      const scale = foldH / s.screen;
      const w = Math.round(s.width * scale);
      return `<figure style="width:${w}px"><div class="shot" style="width:${w}px;height:${foldH}px"><img src="data:image/png;base64,${s.png}" style="width:${w}px">${marks(s, scale)}</div><figcaption>${label(s)} · first screen</figcaption></figure>`;
    })
    .join('');
  // Row two: whole pages, light, cut into columns so a long page still fits.
  const colH = 1500;
  const whole = shots
    .filter((s) => !s.dark)
    .map((s) => {
      const target = s.viewport === 'desktop' ? 420 : s.viewport === 'tablet' ? 300 : 210;
      const scale = target / s.width;
      const fullH = s.height * scale;
      const cols = Math.max(1, Math.ceil(fullH / colH));
      const parts = Array.from({ length: cols }, (_, i) => {
        const h = Math.min(colH, fullH - i * colH);
        return `<div class="shot" style="width:${target}px;height:${h}px"><div style="position:absolute;top:${-i * colH}px;left:0"><img src="data:image/png;base64,${s.png}" style="width:${target}px">${marks(s, scale)}</div></div>`;
      }).join('');
      return `<figure><div class="cols">${parts}</div><figcaption>${label(s)} · whole page${cols > 1 ? `, in ${cols} columns` : ''}</figcaption></figure>`;
    })
    .join('');
  const notes = bad
    .map((c) => `<li class="${c.status}"><b>${c.status === 'fail' ? 'FAIL' : 'warn'} ${esc(c.id)}</b></li>`)
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{background:#181816;color:#e6e4dc;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;padding:14px;width:${width}px}
h1{font-size:15px;font-weight:600;margin-bottom:10px}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;margin-bottom:18px}
figure{display:flex;flex-direction:column;gap:5px}
.cols{display:flex;gap:6px;align-items:flex-start}
.shot{position:relative;overflow:hidden;background:#fff;outline:1px solid #3a3a36}
.shot img{display:block}
.m{position:absolute;border:2px solid #e0249a;background:rgba(224,36,154,.12);border-radius:2px}
figcaption{color:#b8b5aa;font-size:12px}
ul{list-style:none;display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:12px;padding:0}
li.fail b{color:#ff6b9a}li.warn b{color:#e8c46a}
</style></head><body><h1>${esc(title)}</h1><ul>${notes || '<li>Every check passes. Now look hard.</li>'}</ul><div class="row">${fold}</div><div class="row">${whole}</div></body></html>`;
  return { html, width };
}

// ── The review ───────────────────────────────────────────────────────────────────────────────────────────────────

export class WebReviewError extends Error {}

/** Renders and checks the pages; writes the sheet. `chrome` is the browser, `audit` the source of review_web.js. */
export async function reviewWeb(
  chrome: string,
  audit: string,
  spec: WebSpec,
  timeoutMs = 180_000,
): Promise<Review> {
  if (!spec.pages.length) throw new WebReviewError('There’s no page to check.');
  const { origin, server } = await serveFolder(spec.dir);
  const browser = new Browser(chrome);
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    await browser.send('Browser.getVersion');
    const tab = await Tab.open(browser, origin);
    const shots: PageShot[] = [];
    const late: string[] = [];
    let firstBytes = -1;
    for (const page of spec.pages.slice(0, 5)) {
      const url = `${origin}/${page.split('/').map(encodeURIComponent).join('/')}`;
      const runs: [Viewport, boolean][] = [
        ...VIEWPORTS.map((v) => [v, false] as [Viewport, boolean]),
        [VIEWPORTS[0]!, true],
        [VIEWPORTS[2]!, true],
      ];
      for (const [v, dark] of runs) {
        await tab.cmd('Emulation.setDeviceMetricsOverride', {
          width: v.width,
          height: v.height,
          deviceScaleFactor: 1,
          mobile: v.mobile,
        });
        await tab.cmd('Emulation.setEmulatedMedia', {
          features: [
            { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
            { name: 'prefers-reduced-motion', value: 'no-preference' },
          ],
        });
        await tab.cmd('Emulation.setTouchEmulationEnabled', { enabled: v.mobile });
        const before = tab.bytes;
        const ok = await tab.go(url);
        if (firstBytes < 0) firstBytes = tab.bytes - before;
        if (!ok && !late.includes(page)) late.push(page);
        const a = await tab.eval<Audit>(`(${audit})(${JSON.stringify(v.name)})`);
        // Without a viewport meta, a phone lays the page out wider than its screen and shrinks it: that is sideways too.
        if (a.width > v.width + 1) {
          a.sideways = true;
          a.scrollWidth = Math.max(a.scrollWidth, a.width);
        }
        const height = Math.min(MAX_PAGE, Math.max(v.height, a.pageHeight));
        const png = await tab.shoot(v.width, height);
        shots.push({
          page,
          viewport: v.name,
          width: v.width,
          screen: v.height,
          dark,
          png,
          height,
          cut: a.pageHeight > MAX_PAGE,
          audit: a,
        });
      }
    }
    const checks = judge(
      shots,
      { blocked: [...tab.blocked], errors: [...new Set(tab.errors)], bytes: firstBytes, late },
      spec,
    );
    const lead = shots[0]!.audit;
    if (spec.sheet) {
      const { html, width } = sheetHtml(shots, checks, `${spec.pages[0]} — ${lead.title || 'untitled'}`);
      await tab.cmd('Fetch.disable');
      await tab.cmd('Emulation.setDeviceMetricsOverride', {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await tab.cmd('Emulation.setEmulatedMedia', { features: [] });
      const frame = (await tab.cmd('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      await tab.cmd('Page.setDocumentContent', { frameId: frame.frameTree.frame.id, html });
      await tab.eval('Promise.all([...document.images].map(i => i.decode().catch(() => 0)))');
      const h = await tab.eval<number>('document.documentElement.scrollHeight');
      const jpeg = await tab.shoot(width, Math.min(h, 16_000), 'jpeg');
      writeFileSync(spec.sheet, Buffer.from(jpeg, 'base64'));
    }
    tab.close();
    const info: Record<string, unknown> = {
      pages: spec.pages.slice(0, 5),
      title: lead.title,
      viewports: VIEWPORTS.map((v) => `${v.name} ${v.width}×${v.height}`),
      themes: 'light and dark',
      words: lead.words,
      images: lead.images,
      fonts: [...new Set(shots.flatMap((s) => s.audit.families))],
      'page height': shots
        .filter((s) => !s.dark && s.page === spec.pages[0])
        .map((s) => `${s.viewport} ${s.audit.pageHeight}px`),
      blocked: tab.blocked.size,
      weight: `${(Math.max(0, firstBytes) / 1024).toFixed(0)} KB`,
    };
    if (spec.sheet) info.sheet = spec.sheet;
    return { kind: 'web' as const, info, checks, passed: !checks.some((c) => c.status === 'fail') };
  })();
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WebReviewError('Checking the page took too long.')), timeoutMs);
      }),
    ]);
  } catch (e) {
    throw e instanceof WebReviewError ? e : new WebReviewError((e as Error).message);
  } finally {
    clearTimeout(timer);
    browser.close();
    server.close();
    server.closeAllConnections();
  }
}

/** The web checker for this computer, or undefined when it has no browser to render with. */
export function webReviewer(
  chrome: string | null = findChrome(),
): ((spec: WebSpec) => Promise<Review>) | undefined {
  if (!chrome) return undefined;
  let audit: string;
  try {
    audit = readFileSync(resource(join('tools', 'review_web.js')), 'utf8')
      .replace(/^\/\/.*$/gm, '')
      .replace(/\/\*\*[\s\S]*?\*\//, '')
      .trim()
      .replace(/;$/, '');
  } catch {
    return undefined;
  }
  return (spec) => reviewWeb(chrome, audit, spec);
}
