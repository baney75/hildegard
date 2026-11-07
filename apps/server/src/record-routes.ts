// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/record/*: recording from any chat.
 *
 * Two kinds of caller. The person on the record page has only the link's token (GET /api/record/<token> to see what
 * is asked, POST /api/record/<token> to send it, once), and can do nothing else. Everyone else signs in as usual:
 * the owner, this computer, or a director, and each sees the links and recordings they made. (The owner and this
 * computer see everyone's, as they do for films; a director sees only their own.) A recording that isn't yours
 * is answered as if it didn't exist.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv, Who } from './access.ts';
import { type Entry, ID_RE, RecordError, type RecordKind, type RecordStore, TOKEN_RE } from './record.ts';
import { CLEAN_DEFAULTS, type CleanJob, type CleanJobs } from './record-clean.ts';

export interface RecordRouteDeps {
  records: RecordStore;
  cleaner: CleanJobs;
  who: (c: Ctx) => Who | null;
  /**
   * Where people reach this Hildegard from the device they are on: its link when it has one (`viaLink`), else the
   * address this request came to.
   */
  linkBase: (c: Ctx) => { base: string; viaLink: boolean };
  /** Whether the person asking may see this film. */
  sees: (c: Ctx, filmId: string) => boolean;
}

/** The key a person's recordings are kept under. */
export const ownerKey = (who: Who | null): string | null =>
  !who ? null : who.kind === 'local' ? 'local' : who.person.id;

/** Whether `who` may see a recording: its owner, the owner of this Hildegard, and this computer. */
export function mayOpen(who: Who | null, e: Pick<Entry, 'owner'> | undefined): boolean {
  if (!who || !e) return false;
  if (who.kind === 'local' || who.person.role === 'owner') return true;
  return e.owner === who.person.id;
}

/** Reads and drops up to 8 MB of a body that was refused. */
async function discard(body: ReadableStream<Uint8Array> | null) {
  if (!body || body.locked) return;
  const r = body.getReader();
  try {
    for (let n = 0; n < 8 * 1024 * 1024; ) {
      const { done, value } = await r.read();
      if (done) return;
      n += value.length;
    }
    await r.cancel();
  } catch {}
}

const LOOPBACK_URL = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i;

const NewLink = z.object({
  kind: z.enum(['voice', 'video']),
  purpose: z.string().max(200).optional(),
  filmId: z.string().max(64).optional(),
});
const CleanBody = z.object({
  target_lufs: z.number().min(-40).max(-5).default(CLEAN_DEFAULTS.targetLufs),
  peak: z.number().min(-9).max(0).default(CLEAN_DEFAULTS.peak),
});

export function recordRoutes(d: RecordRouteDeps) {
  const { records, cleaner } = d;
  const app = new Hono<HgEnv>();
  const local = (c: Ctx) => d.who(c)?.kind === 'local';

  const fail = (c: Ctx, e: unknown) => {
    if (e instanceof RecordError) return c.json({ error: e.message, code: e.code }, e.status);
    if (e instanceof z.ZodError) {
      const i = e.issues[0];
      return c.json(
        { error: i?.message ?? 'That request isn’t right.', field: i?.path.join('.') || undefined },
        400,
      );
    }
    throw e;
  };
  const go =
    (h: (c: Ctx) => unknown | Promise<unknown>, status: 200 | 201 | 202 = 200) =>
    async (c: Ctx) => {
      c.header('cache-control', 'no-store');
      try {
        const out = await h(c);
        return out instanceof Response ? out : c.json(out as object, status);
      } catch (e) {
        return fail(c, e);
      }
    };
  const json = async (c: Ctx) => ((await c.req.json().catch(() => ({}))) ?? {}) as unknown;
  const must = (c: Ctx) => {
    const k = ownerKey(d.who(c));
    if (!k) throw new RecordError(401, 'signin', 'Sign in to Hildegard first.');
    return k;
  };
  /** A recording the asker may see; anything else is "no such recording", so its existence stays private. */
  const mine = (c: Ctx, e: Entry | undefined): Entry => {
    if (!e || !mayOpen(d.who(c), e)) throw new RecordError(404, 'missing', 'No such recording.');
    return e;
  };
  /** A recording as the person who owns it sees it: where it is on this computer, never the link. */
  const shown = (c: Ctx, e: Entry) => {
    const path = records.path(e);
    return { ...records.view(e), file: local(c) && path && records.exists(e) ? path : null };
  };
  const jobView = (c: Ctx, j: CleanJob) => {
    const made = j.recording ? records.get(j.recording.id) : undefined;
    return {
      id: j.id,
      from: j.from,
      status: j.status,
      stage: j.stage,
      error: j.error,
      recording: made ? shown(c, made) : null,
    };
  };

  // ── Signed in ──────────────────────────────────────────────────────────────────────────────────────────────

  app.post(
    '/links',
    go(async (c) => {
      const owner = must(c);
      const body = NewLink.parse(await json(c));
      if (body.filmId && !d.sees(c, body.filmId)) throw new RecordError(404, 'film', 'No such film.');
      const { id, token, expiresAt } = records.makeLink(owner, body);
      const { base: raw, viaLink } = d.linkBase(c);
      const base = raw.replace(/\/$/, '');
      return c.json(
        {
          id,
          token,
          path: `/record/${token}`,
          url: `${base}/record/${token}`,
          // False when the address is only where this request came to; an in-process caller (the MCP) knows better.
          viaLink,
          expiresAt: new Date(expiresAt).toISOString(),
          localOnly: LOOPBACK_URL.test(base),
        },
        201,
      );
    }, 201),
  );

  app.post(
    '/imports',
    go(async (c) => {
      const owner = must(c);
      const k = c.req.query('kind');
      const kind: RecordKind | 'auto' = k === 'voice' || k === 'video' ? k : 'auto';
      const len = c.req.header('content-length');
      const v = await records.import(
        owner,
        kind,
        c.req.raw.body,
        len === undefined ? undefined : Number(len),
      );
      const e = records.get(v.id)!;
      return c.json(shown(c, e), 201);
    }, 201),
  );

  // The token goes in the body, never the URL, so it stays out of every log that records addresses.
  app.post(
    '/status',
    go(async (c) => {
      must(c);
      const { token } = z.object({ token: z.string().max(100) }).parse(await json(c));
      const f = records.find(token);
      return shown(c, mine(c, f?.entry));
    }),
  );

  app.get(
    '/clean/:job',
    go((c) => {
      must(c);
      const j = cleaner.get(c.req.param('job') ?? '');
      if (!j || !mayOpen(d.who(c), { owner: j.owner })) throw new RecordError(404, 'missing', 'No such job.');
      return jobView(c, j);
    }),
  );

  app.post(
    '/:id/clean',
    go(async (c) => {
      must(c);
      const e = mine(c, records.get(c.req.param('id') ?? ''));
      const body = CleanBody.parse(await json(c));
      return c.json(jobView(c, cleaner.start(e, { targetLufs: body.target_lufs, peak: body.peak })), 202);
    }, 202),
  );

  // ── By token, with no sign-in: the page the person opens ───────────────────────────────────────────────────

  app.get(
    '/:key',
    go((c) => {
      const key = c.req.param('key') ?? '';
      if (TOKEN_RE.test(key)) return records.link(key);
      if (ID_RE.test(key)) {
        must(c);
        return shown(c, mine(c, records.get(key)));
      }
      throw new RecordError(404, 'unknown', 'This link doesn’t work. Ask for a new one.');
    }),
  );

  app.post(
    '/:key',
    go(async (c) => {
      const key = c.req.param('key') ?? '';
      if (!TOKEN_RE.test(key))
        throw new RecordError(404, 'unknown', 'This link doesn’t work. Ask for a new one.');
      const len = c.req.header('content-length');
      const body = c.req.raw.body;
      try {
        await records.receive(key, body, len === undefined ? undefined : Number(len));
      } catch (e) {
        // Read the rest of a modest body before answering, so the answer reaches the phone instead of a closed socket.
        if (e instanceof RecordError && e.status !== 413) await discard(body);
        throw e;
      }
      // The phone learns only that it arrived.
      return { received: true };
    }),
  );

  return app;
}
