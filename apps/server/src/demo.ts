// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Browser demos: a site or an unpacked extension, shown in a browser of its own and recorded, driven by a step script
 * (so an agent can make a demo with nobody clicking) or by a person in a window. The result goes to the person's
 * recordings on a clean backdrop, like the Studio's own screen recordings.
 *
 * Safety:
 *  - the browser is Playwright's Chromium (or HILDEGARD_DEMO_CHROMIUM), never the person's own: a fresh profile in a
 *    temp folder that is deleted after, so no cookies, sign-ins, bookmarks or extensions of theirs are in it, and
 *    nothing it does is kept. If there is none, nothing is downloaded: the person is told the command;
 *  - addresses are http(s), or file: inside the project folder the request names, and only from this computer;
 *  - nothing signs in to anything: a step can type into a field, but the step log shows what was typed into a password
 *    field, a step marked `mask`, or anything that looks like a key or token, as dots.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Browser, type Json, playwrightChromium } from './browser.ts';

/** The Playwright this repository pins, for the install command. */
export const PLAYWRIGHT_VERSION = '1.63.0';
export const INSTALL_CHROMIUM = `npx playwright@${PLAYWRIGHT_VERSION} install chromium`;
/** Longest a demo may run, and most steps in one. */
export const MAX_SECONDS = 600;
export const MAX_STEPS = 200;

export class DemoError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422 | 424 | 500;
  readonly code: string;
  constructor(status: DemoError['status'], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────────────────────

const Target = {
  text: z.string().min(1).max(200).optional(),
  selector: z.string().min(1).max(300).optional(),
};
export const Step = z.discriminatedUnion('do', [
  z.object({ do: z.literal('goto'), url: z.string().min(1).max(2000) }),
  z.object({ do: z.literal('click'), ...Target }),
  z.object({
    do: z.literal('type'),
    text: z.string().max(2000),
    selector: z.string().min(1).max(300).optional(),
    /** Milliseconds between keys; a person types about 8 a second. */
    delay: z.number().int().min(0).max(1000).optional(),
    /** Shown as dots in the step log. */
    mask: z.boolean().optional(),
  }),
  z.object({
    do: z.literal('key'),
    key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp']),
  }),
  z.object({ do: z.literal('wait'), ms: z.number().int().min(0).max(30_000).optional(), ...Target }),
  z.object({
    do: z.literal('scroll'),
    y: z.number().int().min(-20_000).max(20_000).optional(),
    selector: z.string().min(1).max(300).optional(),
  }),
  z.object({ do: z.literal('pause'), ms: z.number().int().min(0).max(30_000) }),
  z.object({
    do: z.literal('caption'),
    text: z.string().max(200),
    ms: z.number().int().min(0).max(30_000).optional(),
  }),
]);
export type DemoStep = z.infer<typeof Step>;

/** A step script from JSON text or an already parsed list, checked; the message names the step that is wrong. */
export function parseSteps(input: unknown): DemoStep[] {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      throw new DemoError(400, 'steps', `The steps aren’t JSON: ${(e as Error).message}`);
    }
  }
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Array.isArray((raw as { steps?: unknown }).steps)
  )
    raw = (raw as { steps: unknown[] }).steps;
  if (!Array.isArray(raw))
    throw new DemoError(400, 'steps', 'The steps are a list, like [{"do": "click", "text": "Sign up"}].');
  if (raw.length > MAX_STEPS) throw new DemoError(400, 'steps', `A demo has at most ${MAX_STEPS} steps.`);
  return raw.map((s, i) => {
    const r = Step.safeParse(s);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new DemoError(
        400,
        'steps',
        `Step ${i + 1} isn’t right${issue?.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue?.message ?? 'unknown'}.`,
      );
    }
    if ((r.data.do === 'click' || r.data.do === 'wait') && r.data.text && r.data.selector)
      throw new DemoError(400, 'steps', `Step ${i + 1}: give text or selector, not both.`);
    if (r.data.do === 'click' && !r.data.text && !r.data.selector)
      throw new DemoError(400, 'steps', `Step ${i + 1}: say what to click, by text or selector.`);
    return r.data;
  });
}

/** What looks like a key, token or password: the shapes the usual services give out, or a long run of mixed letters and digits. */
export function looksSecret(text: string): boolean {
  const t = text.trim();
  if (/^(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|hf|glpat|AKIA|AIza|ya29)[-_.A-Za-z0-9]{8,}$/.test(t))
    return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(t)) return true;
  // 20 characters or more with no spaces, mixing letters and digits: a key, not a word.
  return t.length >= 20 && !/\s/.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t);
}

const dots = (s: string) => '•'.repeat(Math.min(12, Math.max(4, s.length)));

/** One line for the step log; what was typed into a masked or password field, or that looks like a key, is dots. */
export function describeStep(s: DemoStep, opts: { hidden?: boolean } = {}): string {
  switch (s.do) {
    case 'goto':
      return `Open ${maskUrl(s.url)}`;
    case 'click':
      return s.text ? `Click “${s.text}”` : `Click ${s.selector}`;
    case 'type': {
      const hide = s.mask || opts.hidden || looksSecret(s.text);
      return `Type “${hide ? dots(s.text) : s.text}”${s.selector ? ` into ${s.selector}` : ''}`;
    }
    case 'key':
      return `Press ${s.key}`;
    case 'wait':
      return s.text
        ? `Wait for “${s.text}”`
        : s.selector
          ? `Wait for ${s.selector}`
          : `Wait ${s.ms ?? 1000} ms`;
    case 'scroll':
      return s.selector ? `Scroll to ${s.selector}` : `Scroll ${s.y ?? 600} px`;
    case 'pause':
      return `Pause ${s.ms} ms`;
    case 'caption':
      return s.text ? `Caption “${s.text}”` : 'Caption off';
  }
}

/** An address for a log: a password in it, and anything in its query that looks like a key, are dots. */
export function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    const hid = '••••';
    if (url.password) url.password = hid;
    for (const [k, v] of url.searchParams)
      if (/token|key|secret|pass|auth|code|sig/i.test(k) || looksSecret(v)) url.searchParams.set(k, hid);
    return decodeURI(url.toString());
  } catch {
    return u.slice(0, 200);
  }
}

// ── Addresses and folders ────────────────────────────────────────────────────────────────────────────────────

const inside = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** A folder a demo may read from: real, a folder, and not the home folder or the top of a disk itself. */
export function projectFolder(dir: string): string {
  if (!isAbsolute(dir)) throw new DemoError(400, 'root', 'The project folder must be a full path.');
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new DemoError(404, 'root', `There is no folder at ${dir}.`);
  }
  if (!statSync(real).isDirectory()) throw new DemoError(400, 'root', `${dir} isn’t a folder.`);
  let home = '';
  try {
    home = realpathSync(homedir());
  } catch {}
  if (real === home || real.split(/[\\/]/).filter(Boolean).length < 2)
    throw new DemoError(
      400,
      'root',
      'Name the project’s own folder, not your home folder or the whole disk.',
    );
  return real;
}

/** An address the demo may open: http(s), or a file inside the project folder. */
export function checkUrl(u: string, root: string | null): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new DemoError(
      400,
      'url',
      'That isn’t an address. Give one like https://example.com, or a file in the project.',
    );
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.username || url.password)
      throw new DemoError(
        400,
        'url',
        'A demo doesn’t sign in: leave the name and password out of the address.',
      );
    return url.toString();
  }
  if (url.protocol === 'file:') {
    if (!root)
      throw new DemoError(400, 'url', 'A file opens only from the project folder: give the folder as root.');
    let p: string;
    try {
      p = realpathSync(fileURLToPath(url));
    } catch {
      throw new DemoError(404, 'url', `There is no file at ${u}.`);
    }
    if (!inside(root, p)) throw new DemoError(403, 'url', 'That file is outside the project folder.');
    return pathToFileURL(p).toString() + url.search + url.hash;
  }
  throw new DemoError(400, 'url', 'A demo opens http, https, or a file in the project.');
}

/** An unpacked extension's folder, with its manifest. */
export function checkExtension(dir: string): string {
  if (!isAbsolute(dir)) throw new DemoError(400, 'extension', 'The extension’s folder must be a full path.');
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new DemoError(404, 'extension', `There is no folder at ${dir}.`);
  }
  if (!existsSync(join(real, 'manifest.json')))
    throw new DemoError(
      400,
      'extension',
      'That folder has no manifest.json: give the unpacked extension’s own folder.',
    );
  return real;
}

/** Playwright's Chromium, which loads unpacked extensions (branded Chrome no longer does). */
export function demoChromium(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HILDEGARD_DEMO_CHROMIUM) {
    if (existsSync(env.HILDEGARD_DEMO_CHROMIUM)) return env.HILDEGARD_DEMO_CHROMIUM;
    throw new DemoError(
      424,
      'browser',
      `There is no browser at HILDEGARD_DEMO_CHROMIUM (${env.HILDEGARD_DEMO_CHROMIUM}).`,
    );
  }
  const found = playwrightChromium(env, platform());
  if (!found)
    throw new DemoError(
      424,
      'browser',
      `Browser demos use Playwright’s Chromium, and this computer doesn’t have it. Install it with: ${INSTALL_CHROMIUM}`,
    );
  return found;
}

// ── In the page: the cursor, click ripples and captions ───────────────────────────────────────────────────────

/** Drawn into every page, above everything and ignored by it: follows the real mouse events the harness sends. */
export const OVERLAY = `(() => {
  if (window.__hgDemo) return; window.__hgDemo = true;
  const mk = () => {
    if (document.getElementById('__hg-demo')) return;
    const root = document.createElement('div');
    root.id = '__hg-demo';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    root.innerHTML = '<svg id="__hg-cur" width="26" height="30" viewBox="0 0 26 30" style="position:absolute;left:-40px;top:-40px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><path d="M2 2 L2 24 L8 18 L12.5 28 L16.5 26.2 L12 16.5 L21 16.5 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg><div id="__hg-cap" style="position:absolute;left:50%;bottom:6%;transform:translateX(-50%);max-width:80%;padding:10px 18px;border-radius:12px;background:rgba(10,14,19,.86);color:#f2ecdd;font:500 22px/1.35 system-ui,sans-serif;text-align:center;display:none"></div>';
    (document.body || document.documentElement).appendChild(root);
  };
  const at = (x, y) => { mk(); const c = document.getElementById('__hg-cur'); if (c) { c.style.left = x - 2 + 'px'; c.style.top = y - 2 + 'px'; } };
  addEventListener('mousemove', (e) => at(e.clientX, e.clientY), true);
  addEventListener('mousedown', (e) => {
    mk(); at(e.clientX, e.clientY);
    const r = document.createElement('div');
    r.style.cssText = 'position:absolute;left:' + (e.clientX - 22) + 'px;top:' + (e.clientY - 22) + 'px;width:44px;height:44px;border-radius:50%;border:3px solid rgba(217,180,92,.95);background:rgba(217,180,92,.25);transform:scale(.3);opacity:1;transition:transform .45s ease-out,opacity .45s ease-out';
    document.getElementById('__hg-demo').appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.4)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 600);
  }, true);
  window.__hgCaption = (t) => { mk(); const c = document.getElementById('__hg-cap'); if (!c) return; c.textContent = t || ''; c.style.display = t ? 'block' : 'none'; };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mk); else mk();
})();`;

/** Finds an element by selector, or by its visible text among things people click, scrolled into view; its middle. */
const FIND = (sel: string | undefined, text: string | undefined) => `(() => {
  const sel = ${JSON.stringify(sel ?? null)}, text = ${JSON.stringify(text ?? null)};
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let el = null;
  if (sel) el = document.querySelector(sel);
  else {
    const want = text.trim().toLowerCase();
    const all = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],summary,label,[onclick]')];
    const words = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase();
    el = all.find((e) => seen(e) && words(e) === want) || all.find((e) => seen(e) && words(e).includes(want));
    if (!el) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim().toLowerCase().includes(want) && n.parentElement && seen(n.parentElement)) { el = n.parentElement; break; }
    }
  }
  if (!el || !seen(el)) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, hidden: el.type === 'password' };
})()`;

// ── A demo ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Backdrop {
  kind: 'none' | 'solid' | 'gradient' | 'image';
  colors?: string[];
  image?: string | null;
}
/** The backdrops the Studio and the CLI name; any other is a color like #1f5a3d, or a picked image. */
export const BACKDROPS: Record<string, Backdrop> = {
  viridian: { kind: 'gradient', colors: ['#2c7350', '#12301f'] },
  dusk: { kind: 'gradient', colors: ['#3451b2', '#8a2943'] },
  vellum: { kind: 'gradient', colors: ['#faf5e8', '#e2d6b8'] },
  ember: { kind: 'gradient', colors: ['#c4602a', '#5a1e0c'] },
  ink: { kind: 'solid', colors: ['#0a0e13'] },
  paper: { kind: 'solid', colors: ['#f4eedd'] },
  none: { kind: 'none' },
};
export function backdropOf(name: string | undefined | null): Backdrop {
  if (!name) return BACKDROPS.viridian!;
  if (BACKDROPS[name]) return BACKDROPS[name]!;
  if (/^#[0-9a-f]{6}$/i.test(name)) return { kind: 'solid', colors: [name.toLowerCase()] };
  throw new DemoError(
    400,
    'backdrop',
    `Backdrops: ${Object.keys(BACKDROPS).join(', ')}, or a color like #1f5a3d.`,
  );
}

export interface DemoRequest {
  url: string;
  extension?: string | null;
  steps?: DemoStep[] | null;
  width: number;
  height: number;
  backdrop: Backdrop;
  aspect: '16:9' | '1:1' | '9:16';
  /** Share of the frame's shorter side around the window. */
  padding: number;
  zoom: boolean;
  /** The project folder: file addresses must be inside it. */
  root?: string | null;
  /** No steps: a window a person drives, recorded until they press Stop. */
  live?: boolean;
}

export type DemoStatus = 'starting' | 'recording' | 'rendering' | 'done' | 'failed' | 'stopped';
export interface DemoJob {
  id: string;
  owner: string;
  status: DemoStatus;
  stage: string | null;
  log: string[];
  error: string | null;
  /** The recording it made, once done. */
  recording: string | null;
  startedAt: string;
}

export interface DemoDeps {
  /** Puts the rendered file with the person's recordings; resolves with the recording's id. */
  keep: (owner: string, file: string) => Promise<string>;
  python: () => string;
  script: () => string;
  chromium?: () => string;
  /** False shows the window (a person driving); tests and scripted demos run headless. */
  headless?: boolean;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const newId = () => `dmo_${(Date.now() * 1000 + (seq++ % 1000)).toString(16).slice(-16).padStart(16, '0')}`;
const KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  ArrowDown: 40,
  ArrowUp: 38,
};

export class Demos {
  private readonly jobs = new Map<string, DemoJob>();
  private readonly stops = new Map<string, () => void>();
  private readonly d: DemoDeps;
  constructor(d: DemoDeps) {
    this.d = d;
  }

  get(id: string): DemoJob | undefined {
    return this.jobs.get(id);
  }
  /** Ends a live demo, or a scripted one early; what was caught is still rendered. */
  stop(id: string): boolean {
    const s = this.stops.get(id);
    s?.();
    return !!s;
  }

  start(owner: string, req: DemoRequest): DemoJob {
    const chrome = (this.d.chromium ?? demoChromium)();
    const url = checkUrl(req.url, req.root ?? null);
    for (const s of req.steps ?? []) if (s.do === 'goto') checkUrl(s.url, req.root ?? null);
    const extension = req.extension ? checkExtension(req.extension) : null;
    if (req.backdrop.kind === 'image' && (!req.backdrop.image || !existsSync(req.backdrop.image)))
      throw new DemoError(404, 'backdrop', 'That backdrop picture isn’t here any more.');
    const job: DemoJob = {
      id: newId(),
      owner,
      status: 'starting',
      stage: 'Opening the browser',
      log: [],
      error: null,
      recording: null,
      startedAt: new Date((this.d.now ?? Date.now)()).toISOString(),
    };
    this.jobs.set(job.id, job);
    void this.run(job, chrome, url, extension, req).catch((e) => {
      job.status = 'failed';
      job.error = (e as Error).message;
      job.stage = null;
    });
    return job;
  }

  private async run(job: DemoJob, chrome: string, url: string, extension: string | null, req: DemoRequest) {
    const work = mkdtempSync(join(tmpdir(), 'hg-demo-'));
    const frames = join(work, 'frames');
    mkdirSync(frames);
    const browser = new Browser(chrome, {
      offline: false,
      headless: req.live ? false : (this.d.headless ?? true),
      extension,
      window: { width: req.width, height: req.height },
    });
    let stopped = false;
    this.stops.set(job.id, () => {
      stopped = true;
    });
    const caught: { file: string; t: number }[] = [];
    const clicks: { t: number; x: number; y: number }[] = [];
    let t0 = 0;
    const clock = () => (performance.now() - t0) / 1000;
    try {
      const { targetId } = (await browser.send('Target.createTarget', { url: 'about:blank' })) as {
        targetId: string;
      };
      const { sessionId } = (await browser.send('Target.attachToTarget', { targetId, flatten: true })) as {
        sessionId: string;
      };
      const cmd = (m: string, p: Json = {}) => browser.send(m, p, sessionId);
      await cmd('Page.enable');
      await cmd('Runtime.enable');
      await cmd('Emulation.setDeviceMetricsOverride', {
        width: req.width,
        height: req.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cmd('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY });
      // Frames as the page changes; each is held until the next, so the video keeps a steady rate.
      let n = 0;
      let loaded: (() => void) | null = null;
      browser.on((method, p, s) => {
        if (s !== sessionId) return;
        if (method === 'Page.loadEventFired') loaded?.();
        if (method !== 'Page.screencastFrame') return;
        void cmd('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
        if (!t0 || stopped) return;
        const file = join(frames, `${String(n++).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(String(p.data), 'base64'));
        caught.push({ file, t: clock() });
      });
      const go = async (u: string) => {
        const ready = new Promise<void>((r) => {
          loaded = r;
        });
        const nav = (await cmd('Page.navigate', { url: u })) as { errorText?: string };
        if (nav.errorText) throw new DemoError(422, 'url', `The page didn’t open: ${nav.errorText}.`);
        await Promise.race([ready, sleep(20_000)]);
        await sleep(300);
      };
      const value = async <T>(expression: string): Promise<T> => {
        const r = (await cmd('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })) as {
          result: { value: T };
          exceptionDetails?: { text: string };
        };
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      };
      let mouse = { x: req.width / 2, y: req.height / 2 };
      const moveTo = async (x: number, y: number) => {
        const from = mouse;
        for (let i = 1; i <= 18; i++) {
          const u = i / 18;
          const e = u * u * (3 - 2 * u);
          await cmd('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: from.x + (x - from.x) * e,
            y: from.y + (y - from.y) * e,
          });
          await sleep(22);
        }
        mouse = { x, y };
      };
      const press = async (x: number, y: number) => {
        clicks.push({ t: clock(), x, y });
        await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sleep(60);
        await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      };
      const find = async (sel?: string, text?: string, waitMs = 5000) => {
        const until = Date.now() + waitMs;
        for (;;) {
          const r = await value<{ x: number; y: number; hidden: boolean } | null>(FIND(sel, text));
          if (r) return r;
          if (Date.now() > until)
            throw new DemoError(422, 'step', `Couldn’t find ${text ? `“${text}”` : sel} on the page.`);
          await sleep(200);
        }
      };

      await go(url);
      t0 = performance.now();
      await cmd('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });
      // Nothing changes on a still page, so ask for one frame now: the video starts on the page as it is.
      await value('new Promise((r) => requestAnimationFrame(() => r(0)))').catch(() => {});
      job.status = 'recording';
      job.stage = req.live ? 'Recording: use the window, then press Stop' : 'Recording';
      await sleep(600);
      if (req.live) {
        const most = Date.now() + MAX_SECONDS * 1000;
        while (!stopped && Date.now() < most) await sleep(250);
      } else {
        let hidden = false;
        for (const s of req.steps ?? []) {
          if (stopped || clock() > MAX_SECONDS) break;
          job.log.push(describeStep(s, { hidden }));
          job.stage = job.log.at(-1)!;
          switch (s.do) {
            case 'goto':
              await go(checkUrl(s.url, req.root ?? null));
              break;
            case 'click': {
              const at = await find(s.selector, s.text);
              await moveTo(at.x, at.y);
              await press(at.x, at.y);
              hidden = at.hidden;
              await sleep(400);
              break;
            }
            case 'type': {
              if (s.selector) {
                const at = await find(s.selector);
                await moveTo(at.x, at.y);
                await press(at.x, at.y);
                hidden = at.hidden;
              }
              if (hidden) job.log[job.log.length - 1] = describeStep(s, { hidden: true });
              for (const ch of s.text) {
                await cmd('Input.insertText', { text: ch });
                await sleep((s.delay ?? 90) * (0.7 + Math.random() * 0.6));
              }
              await sleep(250);
              break;
            }
            case 'key': {
              const k = { key: s.key, code: s.key, windowsVirtualKeyCode: KEYS[s.key] };
              await cmd('Input.dispatchKeyEvent', {
                type: 'keyDown',
                ...k,
                ...(s.key === 'Enter' ? { text: '\r' } : {}),
              });
              await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
              await sleep(300);
              break;
            }
            case 'wait':
              if (s.text || s.selector) await find(s.selector, s.text, s.ms ?? 10_000);
              else await sleep(s.ms ?? 1000);
              break;
            case 'scroll':
              if (s.selector) await find(s.selector);
              else
                await cmd('Input.dispatchMouseEvent', {
                  type: 'mouseWheel',
                  x: mouse.x,
                  y: mouse.y,
                  deltaX: 0,
                  deltaY: s.y ?? 600,
                });
              await sleep(700);
              break;
            case 'pause':
              await sleep(s.ms);
              break;
            case 'caption':
              await value(`window.__hgCaption && window.__hgCaption(${JSON.stringify(s.text)})`);
              await sleep(s.ms ?? 1800);
              break;
          }
        }
        await sleep(800);
      }
      await cmd('Page.stopScreencast').catch(() => {});
      const seconds = clock();
      if (!caught.length) throw new DemoError(500, 'frames', 'The browser showed nothing to record.');
      job.status = 'rendering';
      job.stage = 'Putting it on the backdrop';
      browser.close();
      const out = join(work, 'demo.mp4');
      await this.render({
        frames: caught,
        clicks,
        out,
        aspect: req.aspect,
        backdrop: req.backdrop,
        padding: req.padding,
        radius: 18,
        shadow: true,
        zoom: req.zoom,
        seconds,
      });
      job.recording = await this.d.keep(job.owner, out);
      job.status = stopped && !req.live ? 'stopped' : 'done';
      job.stage = null;
    } finally {
      this.stops.delete(job.id);
      browser.close();
      rmSync(work, { recursive: true, force: true });
    }
  }

  private render(job: Json): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.d.python(), ['-I', this.d.script()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let err = '';
      child.stderr.on('data', (d: Buffer) => {
        err = (err + d.toString()).slice(-2000);
      });
      child.stdout.resume();
      child.once('error', (e) => reject(new DemoError(500, 'render', `Couldn’t start Python: ${e.message}`)));
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new DemoError(
                500,
                'render',
                `Rendering the demo failed: ${err.trim().split('\n').at(-1) ?? code}`,
              ),
            ),
      );
      child.stdin.end(JSON.stringify(job));
    });
  }
}
