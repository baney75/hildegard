// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/loops/*: generate → render → critique → refine, for the owner and the agents acting as them. A round arrives as
 * the file's bytes in the body (never a path), with what changed in `?note=`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv } from './access.ts';
import { Critique, type Loop, LoopError, Loops, type Round, StartLoop } from './loop.ts';

export interface LoopRouteDeps {
  loops: Loops;
  ownerOnly: (c: Ctx) => Response | null;
  sendFile: (c: Ctx, file: string, type: string) => Response;
}

const TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  stl: 'model/stl',
  obj: 'model/obj',
  ply: 'application/octet-stream',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  // A page an agent made is shown as its source, never run on Hildegard's own address.
  html: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  gcode: 'text/plain; charset=utf-8',
};

/** A round as an API answer: links to its file and sheet instead of names in a folder. */
export const roundView = (l: Loop, r: Round) => ({
  ...r,
  file: `/api/loops/${l.id}/files/${r.file}`,
  sheet: r.sheet ? `/api/loops/${l.id}/files/${r.sheet}` : null,
  handoff: r.handoff ? `/api/loops/${l.id}/files/${r.handoff}` : null,
  slice: r.slice
    ? { ...r.slice, gcode: r.slice.gcode ? `/api/loops/${l.id}/files/${r.slice.gcode}` : null }
    : (r.slice ?? null),
});
export const loopView = (l: Loop) => ({
  ...l,
  rounds: l.rounds.map((r) => roundView(l, r)),
  questions: Loops.questions(l.kind),
});

export function loopRoutes(d: LoopRouteDeps) {
  const { loops } = d;
  const app = new Hono<HgEnv>();
  app.use('*', async (c, next) => {
    // A signed link from an MCP result opens that one file, as media links do.
    if (c.get('signedMedia') && c.req.method === 'GET' && c.req.path.includes('/files/')) return next();
    return d.ownerOnly(c) ?? next();
  });
  const go =
    (h: (c: Ctx) => unknown | Promise<unknown>, status: 200 | 201 = 200) =>
    async (c: Ctx) => {
      try {
        const out = await h(c);
        return out instanceof Response ? out : c.json(out as object, status);
      } catch (e) {
        if (e instanceof LoopError) return c.json({ error: e.message, code: e.code }, e.status);
        if (e instanceof z.ZodError) {
          const i = e.issues[0];
          return c.json({ error: i?.message ?? 'That request isn’t right.', field: i?.path.join('.') }, 422);
        }
        throw e;
      }
    };
  const body = async (c: Ctx) => (await c.req.json().catch(() => ({}))) as unknown;

  app.get(
    '/',
    go(() => ({
      loops: loops.list().map((l) => ({
        id: l.id,
        kind: l.kind,
        title: l.title,
        status: l.status,
        rounds: l.rounds.length,
        maxRounds: l.maxRounds,
        chosen: l.chosen,
        agent: l.agent,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    })),
  );
  app.post(
    '/',
    go(async (c) => loopView(loops.start(StartLoop.parse(await body(c)))), 201),
  );
  app.get(
    '/:id',
    go((c) => loopView(loops.get(c.req.param('id') ?? ''))),
  );
  app.post(
    '/:id/rounds',
    go(async (c) => {
      const l = loops.get(c.req.param('id') ?? '');
      if (Number(c.req.header('content-length') ?? 0) > 512 * 1024 * 1024)
        throw new LoopError(413, 'size', 'Files up to 512 MB.');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const r = await loops.submit(l.id, bytes, c.req.query('note') ?? '');
      return {
        loop: l.id,
        round: roundView(l, r),
        roundsLeft: l.maxRounds - l.rounds.length,
        questions: Loops.questions(l.kind),
      };
    }, 201),
  );
  app.put(
    '/:id/reference',
    go(async (c) => {
      const l = loops.get(c.req.param('id') ?? '');
      if (Number(c.req.header('content-length') ?? 0) > 40 * 1024 * 1024)
        throw new LoopError(413, 'size', 'The design’s image up to 40 MB.');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return loopView(
        loops.setReference(l.id, bytes, Number(c.req.query('width')), c.req.query('page') || undefined),
      );
    }),
  );
  app.post(
    '/:id/rounds/:n/critique',
    go(async (c) => {
      const l = loops.get(c.req.param('id') ?? '');
      const out = loops.critique(l.id, Number(c.req.param('n')), Critique.parse(await body(c)));
      return { loop: l.id, round: roundView(l, out.round), verdict: out.verdict, next: out.next };
    }),
  );
  app.post(
    '/:id/finish',
    go(async (c) => {
      const b = z
        .object({ round: z.number().int().positive(), note: z.string().trim().min(3).max(2000) })
        .parse(await body(c));
      return loopView(loops.finish(c.req.param('id') ?? '', b.round, b.note));
    }),
  );
  app.post(
    '/:id/stop',
    go((c) => loopView(loops.stop(c.req.param('id') ?? ''))),
  );
  app.delete(
    '/:id',
    go((c) => {
      loops.remove(c.req.param('id') ?? '');
      return { ok: true };
    }),
  );
  app.get('/:id/files/:name', (c) => {
    const name = c.req.param('name');
    if (!/^(round-\d{1,2}(\.sheet|\.handoff)?\.[a-z0-9]{2,5}|reference\.(png|jpg))$/.test(name))
      return c.body(null, 404);
    const file = loops.file(c.req.param('id'), name);
    if (!file) return c.body(null, 404);
    if (name.endsWith('.handoff.html')) {
      // Hildegard's own print sheet: escaped text and one embedded image, shown as a page that may run nothing.
      const res = d.sendFile(c, file, 'text/html; charset=utf-8');
      res.headers.set(
        'content-security-policy',
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin",
      );
      return res;
    }
    const ext = name.split('.').at(-1)!;
    return d.sendFile(c, file, TYPES[ext] ?? 'application/octet-stream');
  });
  return app;
}
