// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/node/*: what a device sharing its GPU offers the devices paired with it, and nothing else. Every request
 * carries a paired device's key as a bearer token; the key opens these routes only, never the Studio's. Graphs must
 * be ones Hildegard's own builder makes (vetGraph), and renders wait in this computer's own queue.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type BuiltGraph, catalogFiles, EngineError, graphSafety, vetGraph } from '@hildegard/comfy';
import {
  type Catalog,
  loadSafety,
  type ModelState,
  REFUSAL_MESSAGE,
  type SafetyCheck,
} from '@hildegard/presets';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { sniffImage } from './app.ts';
import { type Choir, TOKEN_RE } from './choir.ts';
import type { NodeEvent, NodeInfo } from './remote-engine.ts';
import type { Scheduler } from './scheduler.ts';
import { explain } from './scheduler.ts';
import type { Updates } from './update.ts';

/** A start frame is up to 20 MB and each of four reference images up to 10 MB: their base64 and the graph fit in this. */
export const MAX_RENDER_BODY = 88 * 1024 * 1024;
/** Base64 of one image: 20 MB for a start frame, 10 MB for a reference, with room for the encoding. */
const B64_START = 28 * 1024 * 1024;
const B64_REF = 14 * 1024 * 1024;
/** Finished videos wait this long for the paired device to fetch them. */
const MEDIA_TTL_MS = 10 * 60_000;
/** Preview frames to a paired device: about two a second is plenty over a tailnet. */
const PREVIEW_EVERY_MS = 500;

const RenderBody = z.object({
  built: z.object({
    graph: z.record(z.string(), z.unknown()),
    outputNode: z.string().max(8),
    output: z.enum(['video', 'image']).optional(),
    startFrameNode: z.string().max(8).optional(),
    referenceNodes: z.array(z.string().max(8)).max(4).optional(),
  }),
  startFrame: z.string().max(B64_START).optional(),
  references: z.array(z.string().max(B64_REF)).max(4).optional(),
  // What the queue here shows about it. Both are the other device's say-so, for display only; anything odd is
  // dropped rather than refusing the take.
  from: z.string().max(200).optional().catch(undefined),
  quality: z.enum(['draft', 'final']).optional().catch(undefined),
});

/** The name a paired device gave itself, cut down to something safe to show: a few plain characters, or null. */
export function guestName(raw: string | undefined): string | null {
  const n = (raw ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return n || null;
}

export interface NodeDeps {
  choir: Choir;
  scheduler: Scheduler;
  catalog: Catalog;
  /** What may render here; presets/safety.toml unless a test says otherwise. */
  safety?: SafetyCheck;
  dataDir: string;
  version: string;
  /** This computer's GPU, for the paired device to show. */
  gpu: () => { name: string; vramGb: number | null } | null;
  models: () => ModelState[];
  fake: boolean;
  /** This computer's updates, which the owner's other devices may see and start. */
  updates?: () => Pick<Updates, 'state' | 'request'>;
}

/** Bearer auth with a paired device's key. Wrong, missing or revoked keys all get the same 401. */
export function pairedOnly(choir: Choir): MiddlewareHandler {
  return async (c, next) => {
    const m = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '');
    if (!m || !TOKEN_RE.test(m[1]!) || !choir.accepts(m[1]!)) {
      c.header('www-authenticate', 'Bearer');
      return c.json({ error: 'This device isn’t paired with that one.' }, 401);
    }
    await next();
  };
}

export function nodeRoutes(deps: NodeDeps): Hono {
  const { choir, scheduler, catalog } = deps;
  const dir = join(deps.dataDir, 'choir', 'renders');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = catalogFiles(catalog.models);
  const safety = graphSafety(catalog, deps.safety ?? loadSafety());
  const jobs = new Map<string, AbortController>();
  /** Finished videos not yet fetched. */
  const ready = new Set<string>();
  const id = () => randomBytes(16).toString('hex');

  // Videos nobody came back for, and anything left from before a restart.
  const sweep = () => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > MEDIA_TTL_MS) void rm(p, { force: true });
      } catch {}
    }
  };
  sweep();
  setInterval(sweep, 60_000).unref();

  const app = new Hono();
  app.use('*', pairedOnly(choir));

  app.get('/info', (c) => {
    const states = deps.models();
    const info: NodeInfo = {
      id: choir.id,
      name: choir.sharingName(),
      version: deps.version,
      gpu: deps.gpu(),
      online: scheduler.engineState().online,
      fake: deps.fake,
      // The stand-in engine renders any model.
      models: catalog.models
        .filter((m) => deps.fake || states.find((s) => s.id === m.id)?.installed)
        .map((m) => m.id),
      fit: Object.fromEntries(states.map((s) => [s.id, s.fit])),
      fitWhy: Object.fromEntries(states.map((s) => [s.id, s.fitWhy])),
      queue: scheduler.load(),
      accepting: choir.state().use === 'local',
      update: deps.updates?.().state(),
    };
    c.header('cache-control', 'no-store');
    return c.json(info);
  });

  // Paired devices are the owner's own (Choir pairs your devices, not other people's), so any of them may update this
  // one: only to the newest release, signed with the update key, and only once nothing renders here.
  app.post('/update', async (c) => {
    const updates = deps.updates?.();
    if (!updates) return c.json({ error: 'This Hildegard can’t update itself.' }, 501);
    const why = await updates.request();
    if (why) return c.json({ error: why, update: updates.state() }, 409);
    return c.json(updates.state());
  });

  app.post(
    '/render',
    bodyLimit({
      maxSize: MAX_RENDER_BODY,
      // The rest of the body is never read, so the connection can't carry another request: say so, or the
      // client reuses it and its next request is reset (Windows does).
      onError: (c) =>
        c.json({ error: 'That take is too big to send.', code: 'invalid_graph' }, 413, {
          connection: 'close',
        }),
    }),
    async (c) => {
      if (choir.state().use !== 'local')
        return c.json(
          {
            error: `${choir.sharingName()} renders on another device itself right now.`,
            code: 'engine_offline',
          },
          409,
        );
      const parsed = RenderBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: 'That isn’t a take Hildegard sends.', code: 'invalid_graph' }, 400);
      const built = parsed.data.built as BuiltGraph;
      const problems = vetGraph(built, files, safety);
      if (problems.some((p) => /sexual content/.test(p)))
        return c.json({ error: REFUSAL_MESSAGE.sexual, code: 'content_blocked' }, 422);
      if (problems.some((p) => /safety check|classifier|less strictly/.test(p)))
        return c.json(
          {
            error: `${choir.sharingName()} renders only takes that pass its safety check. Update Hildegard on the device that sent this one.`,
            code: 'invalid_graph',
            problems: problems.slice(0, 10),
          },
          422,
        );
      if (problems.length)
        return c.json(
          {
            error: 'That graph isn’t one Hildegard makes, so it won’t run here.',
            code: 'invalid_graph',
            problems: problems.slice(0, 10),
          },
          422,
        );
      if (!!built.startFrameNode !== !!parsed.data.startFrame)
        return c.json({ error: 'The start frame is missing.', code: 'invalid_graph' }, 422);
      if ((built.referenceNodes?.length ?? 0) !== (parsed.data.references?.length ?? 0))
        return c.json({ error: 'The reference images are missing.', code: 'invalid_graph' }, 422);

      const job = id();
      // Saved under this computer's own name for it, whatever the other device asked for.
      const save = built.graph[built.outputNode]!;
      save.inputs.filename_prefix = `hildegard/paired-${job}`;
      // Every image it brings, sniffed by its bytes and written where only this route reads it.
      const images: string[] = [];
      const keep = async (b64: string, name: string): Promise<string | null> => {
        const bytes = Buffer.from(b64, 'base64');
        const kind = sniffImage(bytes);
        if (!kind) return null;
        const path = join(dir, `${name}.${kind}`);
        await writeFile(path, bytes, { mode: 0o600 });
        images.push(path);
        return path;
      };
      const cleanup = () => Promise.all(images.map((p) => rm(p, { force: true })));
      let startFrame: string | undefined;
      if (parsed.data.startFrame) {
        startFrame = (await keep(parsed.data.startFrame, job)) ?? undefined;
        if (!startFrame)
          return c.json({ error: 'The start frame isn’t a PNG, JPEG or WebP.', code: 'invalid_graph' }, 415);
      }
      const references: string[] = [];
      for (const [i, b64] of (parsed.data.references ?? []).entries()) {
        const path = await keep(b64, `${job}-ref${i + 1}`);
        if (!path) {
          await cleanup();
          return c.json(
            { error: 'A reference image isn’t a PNG, JPEG or WebP.', code: 'invalid_graph' },
            415,
          );
        }
        references.push(path);
      }
      const still = built.output === 'image';
      const dest = join(dir, `${job}.${still ? 'png' : 'mp4'}`);
      const ac = new AbortController();
      jobs.set(job, ac);
      c.req.raw.signal?.addEventListener('abort', () => ac.abort(), { once: true });
      c.header('content-type', 'application/x-ndjson');
      c.header('cache-control', 'no-store');

      return stream(c, async (s) => {
        s.onAbort(() => ac.abort());
        // Handlers fire synchronously; lines go out in order, one write at a time.
        let chain = Promise.resolve();
        let previewBusy = false;
        let lastPreview = 0;
        const send = (ev: NodeEvent) => {
          chain = chain
            .then(() => (s.aborted ? undefined : s.write(`${JSON.stringify(ev)}\n`)))
            .then(
              () => {},
              () => ac.abort(),
            );
          return chain;
        };
        const ping = setInterval(() => void send({ type: 'ping' }), 15_000);
        void send({ type: 'accepted', job });
        try {
          await scheduler.guest({
            from: guestName(parsed.data.from),
            quality: parsed.data.quality ?? null,
            built,
            startFrame,
            references,
            dest,
            signal: ac.signal,
            handlers: {
              onQueued: (position) => void send({ type: 'queued', position }),
              onRunning: () => void send({ type: 'running' }),
              onProgress: (p) => void send({ type: 'progress', ...p }),
              onPreview: (bytes, contentType) => {
                const now = Date.now();
                if (previewBusy || now - lastPreview < PREVIEW_EVERY_MS) return;
                lastPreview = now;
                previewBusy = true;
                void send({
                  type: 'preview',
                  contentType,
                  data: Buffer.from(bytes).toString('base64'),
                }).finally(() => {
                  previewBusy = false;
                });
              },
            },
          });
          const { size } = await stat(dest);
          ready.add(job);
          setTimeout(() => ready.delete(job), MEDIA_TTL_MS).unref();
          await send({ type: 'done', media: job, bytes: size });
        } catch (e) {
          await rm(dest, { force: true });
          const err =
            e instanceof EngineError ? e : new EngineError('unknown', 'Something went wrong.', String(e));
          const ex = explain(err);
          await send({ type: 'error', code: err.code, message: ex.message, detail: ex.detail ?? '' });
        } finally {
          clearInterval(ping);
          jobs.delete(job);
          await cleanup();
        }
      });
    },
  );

  app.post('/render/:job/cancel', (c) => {
    const ac = jobs.get(c.req.param('job'));
    if (!ac) return c.json({ error: 'Nothing like that is rendering here.' }, 404);
    ac.abort();
    return c.json({ ok: true });
  });

  /** The finished video or still, once: it is deleted as soon as it has been sent. */
  app.get('/media/:id', (c: Context) => {
    const mid = c.req.param('id') ?? '';
    const ok = /^[a-f0-9]{32}$/.test(mid) && ready.has(mid);
    const ext = ok ? (['mp4', 'png'] as const).find((e) => existsSync(join(dir, `${mid}.${e}`))) : undefined;
    if (!ext) return c.json({ error: 'No such render.' }, 404);
    const file = join(dir, `${mid}.${ext}`);
    ready.delete(mid);
    const size = statSync(file).size;
    const rs = createReadStream(file);
    rs.once('end', () => void rm(file, { force: true }));
    return new Response(Readable.toWeb(rs) as ReadableStream, {
      headers: {
        'content-type': ext === 'png' ? 'image/png' : 'video/mp4',
        'content-length': String(size),
        'cache-control': 'no-store',
      },
    });
  });

  return app;
}

/**
 * The app on the address paired devices reach (a Tailscale IP): /api/node/* and nothing else. The Studio and its API
 * are never served there, so the key can't reach them and nobody else on the tailnet can either.
 */
export function nodeOnlyApp(routes: Hono, hosts: () => string[]): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!hosts().includes(host)) return c.text('Unknown host', 421);
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
  });
  app.route('/api/node', routes);
  app.all('*', (c) => c.json({ error: 'Not here.' }, 404));
  app.onError((err, c) => {
    console.error(err.message);
    return c.json({ error: 'Something went wrong on this device.' }, 500);
  });
  return app;
}
