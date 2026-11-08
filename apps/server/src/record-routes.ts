// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/record/*: recording from any chat.
 *
 * Two kinds of caller. The person on the record page has only the link's token (GET /api/record/<token> to see what
 * is asked, POST /api/record/<token> to send it, once), and can do nothing else. Everyone else signs in as usual:
 * the owner, this computer, or a director, and each sees the links and recordings they made. (The owner and this
 * computer see everyone's, as they do for films; a director sees only their own.) A recording that isn't yours
 * is answered as if it didn't exist.
 *
 * An interview adds three to each side. The page, by token: GET shows the questions so far (it looks every few
 * seconds, for a follow-up), POST /<token>/answers sends one answer's sound on Next, and POST /<token>/chapters sends
 * the chapters before the full recording. The person who made it, signed in: POST /<id>/ask adds a question and
 * GET /<id>/interview says where it stands. A token is never one of those ids, so it opens neither.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv, Who } from './access.ts';
import { type LinkPlan, PUBLIC_REFUSED } from './link-on.ts';
import {
  type Entry,
  ID_RE,
  MAX_QUESTION,
  MAX_QUESTIONS,
  MAX_SCRIPT,
  RecordError,
  type RecordKind,
  type RecordStore,
  SOURCES,
  TOKEN_RE,
} from './record.ts';
import { CLEAN_DEFAULTS, type CleanJob, type CleanJobs } from './record-clean.ts';

export interface RecordRouteDeps {
  records: RecordStore;
  cleaner: CleanJobs;
  who: (c: Ctx) => Who | null;
  /**
   * Where people reach this Hildegard from the device they are on: its link when it has one (`viaLink`), else the
   * address this request came to.
   */
  linkBase: (c: Ctx) => { base: string; viaLink: boolean; public: boolean };
  /** What turning on a link would do now, decided once (link-on.ts); changes nothing. */
  plan: () => Promise<LinkPlan>;
  /** This computer's own address, `http://127.0.0.1:<port>`: a link there opens in any browser on this computer. */
  hereBase: () => string;
  /** Whether the person asking may see this film. */
  sees: (c: Ctx, filmId: string) => boolean;
  /**
   * Transcribes an interview's answers when a transcription model is installed: `start` returns the job's id, or null
   * when there is none to run it; `read` says where that job is.
   */
  transcriber?: {
    start: (path: string, title: string) => Promise<string | null>;
    read: (job: string) => { status: 'running' | 'done' | 'failed'; text: string | null } | null;
  };
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

/** Where the person will record: on this computer, on their phone, or whichever fits the caller. */
export type RecordWhere = 'here' | 'phone' | 'auto';
const NewLink = z.object({
  kind: z.enum(['voice', 'video']).optional(),
  /** What the page may record from; the first is where it starts. */
  sources: z
    .array(z.enum(SOURCES as [string, ...string[]]))
    .min(1)
    .max(4)
    .optional()
    .transform((v) => v as Entry['sources']),
  /** Teleprompter text. */
  script: z.string().max(MAX_SCRIPT).optional(),
  /** An interview: questions shown one at a time. */
  questions: z.array(z.string().min(1).max(MAX_QUESTION)).max(MAX_QUESTIONS).optional(),
  where: z.enum(['here', 'phone', 'auto']).default('auto'),
  /** The person wants a link only their own devices can open: a public one is not an answer. */
  private: z.boolean().optional(),
  purpose: z.string().max(200).optional(),
  filmId: z.string().max(64).optional(),
});
const Ask = z.object({ question: z.string().min(1).max(MAX_QUESTION) });
const Chapters = z.object({ chapters: z.array(z.unknown()).max(200) });
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
      if (!body.kind && !body.sources)
        throw new RecordError(400, 'kind', 'Say what to record: a kind (voice or video) or sources.');
      if (body.filmId && !d.sees(c, body.filmId)) throw new RecordError(404, 'film', 'No such film.');
      const onThisComputer = local(c);
      // Auto: a caller on this computer records here, unless they said phone; anyone else is on a device of their own.
      const where: 'here' | 'phone' =
        body.where === 'auto' ? (onThisComputer ? 'here' : 'phone') : body.where;
      if (where === 'here' && !onThisComputer)
        throw new RecordError(
          400,
          'here',
          'A link that opens on this computer can only be made from this computer. Ask for one for your phone.',
        );
      const { base: raw, viaLink, public: isPublic } = d.linkBase(c);
      // A phone needs Hildegard's link. From this computer with none on, nothing is made and nothing is turned on: the
      // caller asks the person about the plan below (the route this computer would use, private or public) and sends
      // that plan's id back to turn it on. A link that is on but public is no answer to a request for a private one.
      if (where === 'phone' && onThisComputer && (!viaLink || (isPublic && body.private))) {
        const plan = await d.plan();
        const privateRoute = plan.route === 'tailscale';
        return c.json(
          {
            needsLink: true,
            where,
            plan,
            // Private: the question, to ask word for word. Public or none: what the person has to do themselves.
            ask: privateRoute ? plan.ask : plan.public ? PUBLIC_REFUSED : plan.ask,
            existingPublic: viaLink && isPublic,
            turnOn: privateRoute
              ? {
                  tool: 'link_on',
                  rest: 'POST /api/link/on',
                  next: 'After a yes, call link_on with confirmed: true and this plan id, then ask for the record link again with where: phone.',
                }
              : null,
          },
          200,
        );
      }
      const { id, token, expiresAt } = records.makeLink(owner, body);
      const base = (where === 'here' ? d.hereBase() : raw).replace(/\/$/, '');
      return c.json(
        {
          id,
          token,
          path: `/record/${token}`,
          url: `${base}/record/${token}`,
          where,
          // False when the address is only where this request came to; an in-process caller (the MCP) knows better.
          viaLink: where === 'here' ? false : viaLink,
          // The phone link is on the internet: anyone who has Hildegard's link can reach its sign-in page.
          public: where === 'phone' && viaLink && isPublic,
          expiresAt: new Date(expiresAt).toISOString(),
          localOnly: LOOPBACK_URL.test(base),
          // A phone's microphone works only on a secure page; over plain http it can still send a file.
          secure: base.startsWith('https://'),
        },
        201,
      );
    }, 201),
  );

  // The recordings the asker may see that have arrived, newest first.
  app.get(
    '/',
    go((c) => {
      must(c);
      const who = d.who(c);
      return {
        recordings: records
          .list()
          .filter((e) => mayOpen(who, e))
          .slice(0, 100)
          .map((e) => shown(c, e)),
      };
    }),
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

  // ── An interview, for the person who made it ───────────────────────────────────────────────────────────────

  /** An id, never a token: a token in one of these paths opens nothing. */
  const byId = (c: Ctx, id = c.req.param('id') ?? ''): Entry => {
    must(c);
    if (!ID_RE.test(id)) throw new RecordError(404, 'missing', 'No such recording.');
    return mine(c, records.get(id));
  };

  app.post(
    '/:id/ask',
    go(async (c) => {
      const e = byId(c);
      const { question } = Ask.parse(await json(c));
      const r = records.ask(e.id, question);
      return { id: e.id, index: r.index, questions: r.questions };
    }),
  );

  app.get(
    '/:id/interview',
    go((c) => {
      const e = byId(c);
      if (!e.questions) throw new RecordError(409, 'interview', 'That recording isn’t an interview.');
      const v = records.view(e);
      const answers = records.answersOf(e).map(({ answer, segment }) => {
        const t = answer.job ? (d.transcriber?.read(answer.job) ?? null) : null;
        return {
          index: answer.index,
          question: answer.question,
          at: answer.at,
          receivedAt: answer.receivedAt,
          mediaId: answer.media,
          seconds: segment?.seconds ?? null,
          url: segment ? records.url(segment) : null,
          file: segment && local(c) && records.exists(segment) ? records.path(segment) : null,
          transcript: t?.status === 'done' ? t.text : null,
          transcribing: t?.status === 'running',
        };
      });
      const n = answers.length;
      return {
        id: e.id,
        status: v.status,
        expiresAt: v.expiresAt,
        questions: e.questions,
        current: n < e.questions.length ? { index: n, question: e.questions[n]! } : null,
        answers,
        chapters: v.chapters,
        transcribes: !!d.transcriber,
        recording: v.status === 'received' ? shown(c, e) : null,
      };
    }),
  );

  // Chapters: by token, for a link's recording before it is sent; by id, for one made in the Studio and kept.
  app.post(
    '/:key/chapters',
    go(async (c) => {
      const key = c.req.param('key') ?? '';
      const { chapters } = Chapters.parse(await json(c));
      if (TOKEN_RE.test(key)) return { chapters: records.chaptersByLink(key, chapters).length };
      const e = byId(c, key);
      return { chapters: records.setChapters(e, chapters).length };
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

  /** A token, or the same answer as for any unknown link. */
  const token = (c: Ctx) => {
    const key = c.req.param('key') ?? '';
    if (!TOKEN_RE.test(key))
      throw new RecordError(404, 'unknown', 'This link doesn’t work. Ask for a new one.');
    return key;
  };

  // One answer's sound, on Next. The query says which question and where in the full recording it was put.
  app.post(
    '/:key/answers',
    go(async (c) => {
      const key = token(c);
      const len = c.req.header('content-length');
      const body = c.req.raw.body;
      let got: Awaited<ReturnType<RecordStore['answer']>>;
      try {
        got = await records.answer(
          key,
          { index: Number(c.req.query('index')), at: Number(c.req.query('at') ?? 0) },
          body,
          len === undefined ? undefined : Number(len),
        );
      } catch (e) {
        if (e instanceof RecordError && e.status !== 413 && e.code !== 'quota') await discard(body);
        throw e;
      }
      // Transcribed when Hildegard can; the person's page waits for none of it.
      const path = records.path(got.segment);
      if (d.transcriber && path)
        void d.transcriber
          .start(path, `Interview answer ${got.answer.index + 1}`)
          .then((job) => job && records.setAnswerJob(got.entry.id, got.answer.index, job))
          .catch(() => {});
      return { received: true, index: got.answer.index };
    }),
  );

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
