// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type Catalog,
  type CreateShotBody,
  composeShot,
  PresetError,
  type Priority,
  type Project,
  type ServerEvent,
  ShotRequest,
  type Snapshot,
  type Take,
  takeSeeds,
} from '@hildegard/presets';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { HfLink } from './hf.ts';
import type { ModelManager } from './models.ts';
import type { Scheduler } from './scheduler.ts';
import type { Store } from './store.ts';

export const VERSION = '0.1.0';

/**
 * Where users of this server can get its source (AGPL-3.0 §13). A modified build should set HILDEGARD_SOURCE_URL to
 * its own repository. The commit comes from the build (HILDEGARD_COMMIT) or, in a checkout, from git.
 */
const SOURCE = {
  url: process.env.HILDEGARD_SOURCE_URL ?? 'https://github.com/baney75/hildegard',
  commit: process.env.HILDEGARD_COMMIT ?? gitCommit(),
};

function gitCommit(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export interface AppDeps {
  config: Config;
  store: Store;
  scheduler: Scheduler;
  catalog: Catalog;
  models: ModelManager;
  hf: HfLink;
  mediaDir: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_UPLOAD = 20 * 1024 * 1024;

const id = () => randomUUID().replace(/-/g, '').slice(0, 16);
const now = () => new Date().toISOString();

/** A short title from the first words of a prompt. */
export function titleFrom(prompt: string): string {
  const clean = prompt
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,!?].*$/, '');
  const words = clean.split(' ').slice(0, 6).join(' ');
  return words.length < clean.length ? `${words}…` : words || 'Untitled shot';
}

/** Recognise an image upload by its first bytes, never by its name. */
export function sniffImage(b: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return 'webp';
  return null;
}

const CreateShot = z.object({
  projectId: z.string().max(64).optional(),
  shotId: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  request: z.unknown(),
  priority: z.enum(['forced', 'interactive', 'agent']).optional(),
  agent: z.string().trim().min(1).max(60).optional(),
});

export function createApp(deps: AppDeps) {
  const { config, store, scheduler, catalog, mediaDir } = deps;
  mkdirSync(join(mediaDir, 'uploads'), { recursive: true });
  const app = new Hono();
  const allowedHosts = new Set([...LOOPBACK, ...config.allowedHosts.map((h) => h.toLowerCase())]);

  // ── Security: DNS-rebinding and cross-site request protection ─────────────────────────────────────────────
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!allowedHosts.has(host)) return c.text('Unknown host', 421);
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      // Browsers cannot add this header cross-site without a CORS preflight, which this server never grants.
      if (c.req.header('x-hildegard') !== '1') return c.json({ error: 'Missing x-hildegard header' }, 403);
      const origin = c.req.header('origin');
      if (origin) {
        try {
          const o = new URL(origin);
          if (!allowedHosts.has(o.hostname.toLowerCase()) && !allowedHosts.has(`[${o.hostname}]`))
            return c.json({ error: 'Cross-site request refused' }, 403);
        } catch {
          return c.json({ error: 'Bad origin' }, 403);
        }
      }
    }
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('cross-origin-resource-policy', 'same-origin');
  });

  const snapshot = (): Snapshot => ({
    version: VERSION,
    source: SOURCE,
    projects: [...store.projects.values()],
    shots: [...store.shots.values()],
    takes: [...store.takes.values()],
    engine: scheduler.engineState(),
    models: deps.models.states(),
    hf: deps.hf.state(),
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
  app.get('/api/snapshot', (c) => c.json(snapshot()));
  app.get('/api/catalog', (c) => {
    c.header('cache-control', 'no-cache');
    return c.json(catalog);
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const off = store.on((e) => {
        // Coalesce: only the newest state of each take matters.
        if (e.type === 'take') {
          const i = queue.findIndex((q) => q.type === 'take' && q.take.id === e.take.id);
          if (i >= 0) queue.splice(i, 1);
        }
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      // The snapshot is taken in the same tick as the subscription, so no change can fall between the two.
      const hello = JSON.stringify({ version: VERSION, snapshot: snapshot() });
      await stream.writeSSE({ event: 'hello', data: hello });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15_000)]);
          wake = null;
          if (!queue.length) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
        }
        const batch = queue.splice(0);
        await stream.writeSSE({ event: 'batch', data: JSON.stringify(batch) });
      }
      off();
    }),
  );

  // ── Projects ────────────────────────────────────────────────────────────────────────────────────────────────
  const newProject = (title = 'Untitled film'): Project => {
    const p: Project = { id: id(), title, createdAt: now(), updatedAt: now(), shotIds: [] };
    store.putProject(p);
    return p;
  };

  app.post('/api/projects', async (c) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(120).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Give the film a title of up to 120 characters' }, 400);
    return c.json(newProject(body.data.title), 201);
  });

  app.patch('/api/projects/:id', async (c) => {
    const p = store.projects.get(c.req.param('id'));
    if (!p) return c.json({ error: 'No such film' }, 404);
    const body = z
      .object({ title: z.string().trim().min(1).max(120) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give the film a title of up to 120 characters' }, 400);
    p.title = body.data.title;
    store.putProject(p);
    return c.json(p);
  });

  // ── Shots and takes ─────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/shots', async (c) => {
    const parsed = CreateShot.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Malformed request' }, 400);
    const body = parsed.data as CreateShotBody & { agent?: string };
    const req = ShotRequest.safeParse(body.request);
    if (!req.success) {
      const issue = req.error.issues[0]!;
      return c.json({ error: issue.message, field: issue.path.join('.') }, 422);
    }
    const request = req.data;
    if (request.startFrame && !existsSync(join(mediaDir, 'uploads', request.startFrame)))
      return c.json({ error: 'That start frame is gone; add it again', field: 'startFrame' }, 422);
    let composed: ReturnType<typeof composeShot>;
    try {
      composed = composeShot(catalog, request);
    } catch (e) {
      if (e instanceof PresetError) return c.json({ error: e.message, field: e.field }, 422);
      throw e;
    }

    let shot = body.shotId ? store.shots.get(body.shotId) : undefined;
    if (body.shotId && !shot) return c.json({ error: 'No such shot' }, 404);
    let project = store.projects.get(shot?.projectId ?? body.projectId ?? '');
    if (body.projectId && !project) return c.json({ error: 'No such film' }, 404);
    project ??= newProject();
    if (!shot) {
      shot = {
        id: id(),
        projectId: project.id,
        title: body.title ?? titleFrom(request.prompt),
        prompt: request.prompt,
        createdAt: now(),
        takeIds: [],
      };
      project.shotIds.push(shot.id);
      store.putProject(project);
    }

    const priority: Priority = body.priority ?? (body.agent ? 'agent' : 'interactive');
    const takes: Take[] = takeSeeds(request.takes, request.seed)
      .map(
        (seed) =>
          ({
            id: id(),
            shotId: shot.id,
            projectId: project.id,
            number: shot.takeIds.length + 1,
            status: 'queued',
            priority,
            source: body.agent ? { kind: 'agent', name: body.agent } : { kind: 'studio' },
            request,
            seed,
            model: composed.model.id,
            summary: composed.summary,
            prompt: composed.prompt,
            width: composed.width,
            height: composed.height,
            seconds: composed.seconds,
            fps: composed.fps,
            quality: composed.quality,
            queuePosition: null,
            progress: null,
            previewVersion: 0,
            createdAt: now(),
            startedAt: null,
            finishedAt: null,
            renderMs: null,
            error: null,
            kept: false,
            video: null,
            poster: null,
            bytes: null,
          }) satisfies Take,
      )
      .map((t) => {
        shot.takeIds.push(t.id);
        t.number = shot.takeIds.length;
        return t;
      });
    shot.prompt = request.prompt;
    store.putShot(shot);
    for (const t of takes) scheduler.enqueue(t);
    return c.json({ project, shot, takes }, 201);
  });

  /** One shot with its takes. Finished takes include the video's path on this computer, for local agents. */
  app.get('/api/shots/:id', (c) => {
    const shot = store.shots.get(c.req.param('id'));
    if (!shot) return c.json({ error: 'No such shot' }, 404);
    const takes = shot.takeIds.map((t) => store.takes.get(t)).filter((t): t is Take => !!t);
    const files = Object.fromEntries(
      takes.filter((t) => t.video).map((t) => [t.id, join(mediaDir, `${t.id}.mp4`)]),
    );
    return c.json({ shot, takes, files });
  });

  app.patch('/api/shots/:id', async (c) => {
    const s = store.shots.get(c.req.param('id'));
    if (!s) return c.json({ error: 'No such shot' }, 404);
    const body = z
      .object({ title: z.string().trim().min(1).max(120) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give the shot a title of up to 120 characters' }, 400);
    s.title = body.data.title;
    store.putShot(s);
    return c.json(s);
  });

  const deleteTakeFiles = async (t: Take) => {
    await rm(join(mediaDir, `${t.id}.mp4`), { force: true });
    await rm(join(mediaDir, `${t.id}.jpg`), { force: true });
  };

  app.delete('/api/shots/:id', async (c) => {
    const s = store.shots.get(c.req.param('id'));
    if (!s) return c.json({ error: 'No such shot' }, 404);
    for (const tid of s.takeIds) {
      scheduler.cancel(tid);
      const t = store.takes.get(tid);
      if (t) await deleteTakeFiles(t);
      store.remove('take', tid);
    }
    const p = store.projects.get(s.projectId);
    if (p) {
      p.shotIds = p.shotIds.filter((x) => x !== s.id);
      store.putProject(p);
    }
    store.remove('shot', s.id);
    return c.body(null, 204);
  });

  const takeAction = (fn: (t: Take, c: Context) => Promise<Response> | Response) => async (c: Context) => {
    const t = store.takes.get(c.req.param('id') ?? '');
    if (!t) return c.json({ error: 'No such take' }, 404);
    return fn(t, c);
  };

  app.post(
    '/api/takes/:id/cancel',
    takeAction((t, c) =>
      scheduler.cancel(t.id) ? c.json(t) : c.json({ error: 'This take has already finished' }, 409),
    ),
  );
  app.post(
    '/api/takes/:id/force',
    takeAction(async (t, c) => {
      const interrupt = (await c.req.json().catch(() => ({})))?.interrupt !== false;
      return scheduler.force(t.id, interrupt)
        ? c.json(t)
        : c.json({ error: 'Only a waiting take can be forced' }, 409);
    }),
  );
  app.post(
    '/api/takes/:id/retry',
    takeAction((t, c) => {
      const r = scheduler.retry(t.id);
      return r ? c.json(r) : c.json({ error: 'Only a failed or canceled take can be retried' }, 409);
    }),
  );
  app.post(
    '/api/takes/:id/keep',
    takeAction(async (t, c) => {
      const kept = (await c.req.json().catch(() => ({})))?.kept !== false;
      t.kept = kept;
      store.putTake(t);
      return c.json(t);
    }),
  );
  app.delete(
    '/api/takes/:id',
    takeAction(async (t, c) => {
      scheduler.cancel(t.id);
      await deleteTakeFiles(t);
      const s = store.shots.get(t.shotId);
      if (s) {
        s.takeIds = s.takeIds.filter((x) => x !== t.id);
        store.putShot(s);
      }
      store.remove('take', t.id);
      return c.body(null, 204);
    }),
  );

  app.get('/api/takes/:id/preview', (c) => {
    const id = c.req.param('id');
    const p = scheduler.previews.get(id);
    if (!p) {
      // The take finished between the event and this request: its last preview is now the poster.
      if (/^\w+$/.test(id) && existsSync(join(mediaDir, `${id}.jpg`)))
        return c.redirect(`/media/${id}.jpg`, 307);
      return c.body(null, 404);
    }
    c.header('cache-control', 'no-store');
    return c.body(Buffer.from(p.bytes), 200, { 'content-type': p.type });
  });

  // ── Engine ──────────────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/engine/pause', (c) => {
    scheduler.setPaused(true);
    return c.json(scheduler.engineState());
  });
  app.post('/api/engine/resume', (c) => {
    scheduler.setPaused(false);
    return c.json(scheduler.engineState());
  });

  // ── Models ──────────────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/models/:id/install', async (c) => {
    const id = c.req.param('id');
    const model = catalog.models.find((m) => m.id === id);
    if (!model) return c.json({ error: 'No such model' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { acceptLicense?: unknown };
    if (body.acceptLicense === true) deps.models.acceptLicense(id);
    if (!deps.models.licenseAccepted(id))
      return c.json(
        {
          error: `Accept the ${model.license} first.`,
          code: 'license',
          license: model.license,
          licenseUrl: model.licenseUrl,
          terms: model.terms,
        },
        409,
      );
    void deps.models.install(id).catch(() => {});
    return c.json(deps.models.states(), 202);
  });
  app.post('/api/models/:id/cancel', (c) =>
    deps.models.cancel(c.req.param('id'))
      ? c.json(deps.models.states())
      : c.json({ error: 'Nothing is downloading' }, 409),
  );

  // ── Hugging Face account ───────────────────────────────────────────────────────────────────────────────────
  const hfFail = (c: Context, e: unknown) => c.json({ error: (e as Error).message }, 400);
  app.get('/api/hf', (c) => c.json(deps.hf.state()));
  app.post('/api/hf/token', async (c) => {
    const body = z.object({ token: z.string().max(400) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Paste a token' }, 400);
    try {
      return c.json(await deps.hf.setToken(body.data.token));
    } catch (e) {
      return hfFail(c, e);
    }
  });
  app.post('/api/hf/unlink', (c) => c.json(deps.hf.unlink()));
  app.post('/api/hf/oauth/start', (c) => {
    // Hugging Face accepts any port on a loopback redirect, so browser sign-in works only from this computer.
    const u = new URL(c.req.url);
    if (!LOOPBACK.has(u.hostname))
      return c.json({ error: 'Sign in from this computer, or use a code from another device' }, 409);
    try {
      return c.json({ url: deps.hf.beginOAuth(`${u.protocol}//${u.host}/api/hf/callback`) });
    } catch (e) {
      return hfFail(c, e);
    }
  });
  app.get('/api/hf/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    let message = 'Hugging Face is linked. You can close this tab.';
    let ok = true;
    if (c.req.query('error') || !code || !state) {
      ok = false;
      message = 'Sign-in was canceled. Nothing changed.';
    } else {
      try {
        const s = await deps.hf.finishOAuth(state, code);
        message = `Linked as ${s.user}. You can close this tab.`;
      } catch (e) {
        ok = false;
        message = (e as Error).message;
      }
    }
    c.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    c.header('cache-control', 'no-store');
    const esc = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hildegard</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#14110f;color:#f3ede4}main{max-width:28rem;padding:2rem;text-align:center}a{color:#e8b86a}</style><main><p>${esc}</p><p><a href="/#/settings/huggingface">Back to Hildegard</a></p></main>`,
      ok ? 200 : 400,
    );
  });
  app.post('/api/hf/device', async (c) => {
    try {
      return c.json(await deps.hf.beginDevice());
    } catch (e) {
      return hfFail(c, e);
    }
  });

  // ── Uploads (start frames) ─────────────────────────────────────────────────────────────────────────────────
  app.post('/api/uploads', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_UPLOAD) return c.json({ error: 'Images up to 20 MB' }, 413);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length > MAX_UPLOAD) return c.json({ error: 'Images up to 20 MB' }, 413);
    const kind = sniffImage(buf);
    if (!kind) return c.json({ error: 'Use a PNG, JPEG or WebP image' }, 415);
    const name = `${createHash('sha256').update(buf).digest('hex')}.${kind}`;
    const path = join(mediaDir, 'uploads', name);
    if (!existsSync(path)) await writeFile(path, buf);
    return c.json({ name, url: `/media/uploads/${name}` }, 201);
  });

  // ── Media with byte ranges, so videos seek ─────────────────────────────────────────────────────────────────
  const TYPES: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  app.get('/media/*', (c) => {
    const rel = c.req.path.slice('/media/'.length);
    if (!/^(uploads\/)?[A-Za-z0-9._-]+$/.test(rel) || rel.includes('..')) return c.body(null, 404);
    const file = resolve(mediaDir, rel);
    if (!file.startsWith(resolve(mediaDir) + sep)) return c.body(null, 404);
    return sendFile(
      c,
      file,
      TYPES[extname(file)] ?? 'application/octet-stream',
      'private, max-age=31536000, immutable',
    );
  });

  // ── The Studio UI ───────────────────────────────────────────────────────────────────────────────────────────
  if (config.uiDir) {
    const ui = resolve(config.uiDir);
    const UI_TYPES: Record<string, string> = {
      ...TYPES,
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.json': 'application/json',
      '.webmanifest': 'application/manifest+json',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8',
    };
    app.get('*', (c) => {
      const p = decodeURIComponent(c.req.path);
      let file = resolve(ui, `.${p}`);
      if (!file.startsWith(ui + sep) || !existsSync(file) || statSync(file).isDirectory())
        file = join(ui, 'index.html');
      const hashed = file.includes(`${sep}assets${sep}`);
      c.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      return sendFile(
        c,
        file,
        UI_TYPES[extname(file)] ?? 'application/octet-stream',
        hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    });
  }

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong on this computer. The log has the details.' }, 500);
  });

  return app;
}

/** Serve a file with Range support and precompressed .br/.gz siblings when the client accepts them. */
function sendFile(c: Context, file: string, type: string, cache: string): Response {
  if (!existsSync(file)) return c.body(null, 404);
  const accept = c.req.header('accept-encoding') ?? '';
  if (!type.startsWith('video/') && !type.startsWith('image/')) {
    for (const [enc, ext] of [
      ['br', '.br'],
      ['gzip', '.gz'],
    ] as const) {
      if (accept.includes(enc) && existsSync(file + ext)) {
        const size = statSync(file + ext).size;
        return new Response(Readable.toWeb(createReadStream(file + ext)) as ReadableStream, {
          headers: {
            'content-type': type,
            'content-encoding': enc,
            'content-length': String(size),
            'cache-control': cache,
            vary: 'accept-encoding',
          },
        });
      }
    }
  }
  const size = statSync(file).size;
  const range = c.req.header('range');
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache,
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!m[1]) end = size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end)
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      },
    });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { ...headers, 'content-length': String(size) },
  });
}
