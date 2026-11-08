// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/demos: browser demos (demo.ts). The owner, at this computer or signed in, starts one, follows it and stops it.
 * A folder (an extension, a project with file addresses, a backdrop picture) and a window someone drives are only
 * from this computer: those are this computer's files and screen.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv, Who } from './access.ts';
import {
  type Backdrop,
  backdropOf,
  DemoError,
  type DemoJob,
  type Demos,
  parseSteps,
  projectFolder,
} from './demo.ts';
import type { RecordStore } from './record.ts';
import { ownerKey } from './record-routes.ts';

export interface DemoRouteDeps {
  demos: Demos;
  records: RecordStore;
  who: (c: Ctx) => Who | null;
}

const Start = z.object({
  url: z.string().min(1).max(2000),
  extension: z.string().max(1000).optional(),
  steps: z.unknown().optional(),
  width: z.number().int().min(320).max(2560).default(1280),
  height: z.number().int().min(240).max(1600).default(800),
  backdrop: z.string().max(20).optional(),
  /** A picture on this computer for the backdrop. */
  backdropImage: z.string().max(1000).optional(),
  aspect: z.enum(['16:9', '1:1', '9:16']).default('16:9'),
  padding: z.number().min(0).max(0.25).default(0.06),
  zoom: z.boolean().default(false),
  root: z.string().max(1000).optional(),
});

export function demoRoutes(d: DemoRouteDeps) {
  const app = new Hono<HgEnv>();
  const owner = (c: Ctx): { key: string; local: boolean } => {
    const w = d.who(c);
    if (!w) throw new DemoError(403, 'signin', 'Sign in to Hildegard first.');
    if (w.kind !== 'local' && w.person.role !== 'owner')
      throw new DemoError(403, 'owner', 'Only the owner can record browser demos here.');
    return { key: ownerKey(w)!, local: w.kind === 'local' };
  };
  const view = (c: Ctx, j: DemoJob) => {
    const e = j.recording ? d.records.get(j.recording) : undefined;
    const local = d.who(c)?.kind === 'local';
    return {
      id: j.id,
      status: j.status,
      stage: j.stage,
      log: j.log,
      error: j.error,
      startedAt: j.startedAt,
      recording: e
        ? {
            id: e.id,
            url: d.records.url(e),
            file: local && d.records.exists(e) ? d.records.path(e) : null,
            seconds: e.seconds,
          }
        : null,
    };
  };
  const go =
    (h: (c: Ctx) => unknown | Promise<unknown>, status: 200 | 202 = 200) =>
    async (c: Ctx) => {
      c.header('cache-control', 'no-store');
      try {
        return c.json((await h(c)) as object, status);
      } catch (e) {
        if (e instanceof DemoError) return c.json({ error: e.message, code: e.code }, e.status);
        if (e instanceof z.ZodError) {
          const i = e.issues[0];
          return c.json({ error: i?.message ?? 'That request isn’t right.', field: i?.path.join('.') }, 400);
        }
        throw e;
      }
    };
  const mine = (c: Ctx) => {
    const who = owner(c);
    const j = d.demos.get(c.req.param('id') ?? '');
    if (!j || (j.owner !== who.key && !who.local)) throw new DemoError(404, 'missing', 'No such demo.');
    return j;
  };

  app.post(
    '/',
    go(async (c) => {
      const who = owner(c);
      const b = Start.parse(await c.req.json().catch(() => ({})));
      const steps = b.steps === undefined || b.steps === null ? null : parseSteps(b.steps);
      const needsHere =
        !!b.extension || !!b.root || !!b.backdropImage || /^file:/i.test(b.url) || steps === null;
      if (needsHere && !who.local)
        throw new DemoError(
          403,
          'here',
          steps === null
            ? 'A demo you drive opens a window on the computer Hildegard runs on: start it there, or give steps.'
            : 'Folders and files are this computer’s: an extension, a file address or a backdrop picture works only from it.',
        );
      const backdrop: Backdrop = b.backdropImage
        ? { kind: 'image', image: b.backdropImage }
        : backdropOf(b.backdrop);
      const job = d.demos.start(who.key, {
        url: b.url,
        extension: b.extension ?? null,
        steps,
        width: b.width,
        height: b.height,
        backdrop,
        aspect: b.aspect,
        padding: b.padding,
        zoom: b.zoom,
        root: b.root ? projectFolder(b.root) : null,
        live: steps === null,
      });
      return view(c, job);
    }, 202),
  );
  app.get(
    '/:id',
    go((c) => view(c, mine(c))),
  );
  app.post(
    '/:id/stop',
    go((c) => {
      const j = mine(c);
      d.demos.stop(j.id);
      return view(c, j);
    }),
  );
  return app;
}
