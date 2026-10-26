// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A Chromium-family browser, driven over a pipe (never a network port): finding one on this computer, starting it with
 * a fresh profile, tabs attached in flat mode, and a one-off loopback server for one folder. Hildegard checks pages
 * with it (web-review.ts) shut off from the network, and imports a live site with it (site-import.ts) with the
 * network on.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, platform, tmpdir } from 'node:os';
import { delimiter, extname, join, normalize, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';

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

export type Json = Record<string, unknown>;
interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
}

/** Chrome DevTools Protocol over --remote-debugging-pipe: messages are JSON, each ended by a NUL byte. */
export class Browser {
  private readonly child: ChildProcess;
  private readonly out: Writable;
  private readonly profile: string;
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: Json, session?: string) => void>();
  private buffer = '';
  private closed = false;

  /** `offline` (the default) shuts the browser off from everything but loopback. */
  constructor(chrome: string, opts: { offline?: boolean } = {}) {
    const offline = opts.offline ?? true;
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
      // Offline, nothing leaves this computer: every request but loopback goes to a closed port, and names don't resolve.
      ...(offline
        ? [
            '--proxy-server=http://127.0.0.1:9',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          ]
        : []),
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
export class Tab {
  readonly blocked = new Set<string>();
  readonly errors: string[] = [];
  /** Every response the page received, by request: what an import keeps. */
  readonly responses = new Map<string, { url: string; mime: string; type: string; status: number }>();
  bytes = 0;
  requests = 0;
  private readonly off: () => void;
  private loaded: (() => void) | null = null;

  readonly browser: Browser;
  readonly session: string;

  /**
   * `origin`: the only site the tab may load from; null lets it load any http(s) address; a function decides each
   * address itself (it may look the name up first).
   */
  private constructor(
    browser: Browser,
    session: string,
    origin: string | null | ((url: string) => Promise<boolean>),
  ) {
    this.browser = browser;
    this.session = session;
    this.off = browser.on((method, p, s) => {
      if (s !== session) return;
      if (method === 'Fetch.requestPaused') {
        const url = String((p.request as Json).url);
        const decide = (ok: boolean) => {
          if (ok) {
            this.requests++;
            void browser.send('Fetch.continueRequest', { requestId: p.requestId }, session).catch(() => {});
          } else {
            this.blocked.add(url.length > 120 ? `${url.slice(0, 117)}…` : url);
            void browser
              .send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, session)
              .catch(() => {});
          }
        };
        if (typeof origin === 'function') origin(url).then(decide, () => decide(false));
        else
          decide(
            origin === null
              ? /^(https?|data|blob):/.test(url)
              : url.startsWith(`${origin}/`) || url === origin,
          );
      } else if (method === 'Network.responseReceived') {
        const r = p.response as Json;
        this.responses.set(String(p.requestId), {
          url: String(r.url),
          mime: String(r.mimeType ?? ''),
          type: String(p.type ?? ''),
          status: Number(r.status ?? 0),
        });
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

  static async open(
    browser: Browser,
    origin: string | null | ((url: string) => Promise<boolean>),
  ): Promise<Tab> {
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

export const TYPES: Record<string, string> = {
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
export function serveFolder(dir: string): Promise<{ origin: string; server: Server }> {
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
