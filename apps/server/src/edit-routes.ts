// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/edits/*: video edits. Each belongs to the person who made it: the owner of this Hildegard and this computer see
 * everyone's (as they do for films and recordings), a director sees only their own, and an edit that isn't yours is
 * answered as if it didn't exist.
 *
 *   POST   /api/edits                create from a source (recording:<id>, export:<id>, edit:<id>) or a whole edit list
 *   GET    /api/edits                yours
 *   GET    /api/edits/:id            the edit: its list, its last check, its job, its render, its verdict
 *   PUT    /api/edits/:id/edl        replace the edit list; answers with the check
 *   POST   /api/edits/:id/check      check it again, in full
 *   POST   /api/edits/:id/plan       propose a list: transcribe, drop fillers and false starts, shorten pauses, fit a length
 *   GET    /api/edits/:id/words      the transcript as text to cut words from
 *   POST   /api/edits/:id/render     render it and make the contact sheet (a job; poll the edit)
 *   POST   /api/edits/:id/verify     the gate: does the output prove the list (a job; poll the edit)
 *   DELETE /api/edits/:id
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Transcript } from '@hildegard/presets';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv, Who } from './access.ts';
import {
  EditError,
  type EditJobs,
  type EditStore,
  type Edl,
  ID_RE,
  type Resolvers,
  resolveRefs,
  type StoredEdit,
  toCheck,
  toRender,
  toVerify,
  view,
} from './edit.ts';
import { mayOpen, ownerKey } from './record-routes.ts';

export interface EditRouteDeps {
  store: EditStore;
  jobs: EditJobs;
  who: (c: Ctx) => Who | null;
  /** The file of a recording this person may see, or null. */
  recordFile: (id: string, who: Who | null) => string | null;
  /** The file of a finished export this person may see, or null. */
  exportFile: (id: string, who: Who | null) => string | null;
  /**
   * Words and times from a 16 kHz mono WAV, on the owner's voice studio. Absent where there is none. Only the owner and
   * this computer may use it, since the studio is the owner's.
   */
  transcribe?: (wav: string, who: Who) => Promise<Transcript>;
}

const Source = z.string().min(1).max(4096);
const Create = z
  .object({
    title: z.string().max(120).optional(),
    source: Source.optional(),
    edl: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => !!b.source !== !!b.edl, 'Give a source, or a whole edit list, not both.');
const Plan = z.object({
  transcript: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  /** The words file with lines deleted, to cut exactly those words. */
  text: z.string().max(2_000_000).optional(),
  target_seconds: z.number().min(1).max(86_400).optional(),
  target: z.enum(['youtube', 'shorts', 'reels', 'tiktok', 'x', 'podcast']).optional(),
  fillers: z.boolean().default(true),
  filler_words: z.array(z.string().max(40)).max(40).optional(),
  strict_fillers: z.boolean().default(false),
  bad_takes: z.boolean().default(true),
  pauses: z.boolean().default(true),
  captions: z.boolean().default(true),
  /** Also cut where it is quiet and still. */
  auto: z.boolean().default(false),
  /** Don't transcribe: cut by loudness and motion alone. */
  transcribe: z.boolean().default(true),
  title: z.string().max(200).optional(),
});
const Render = z.object({
  encoder: z
    .enum(['auto', 'libx264', 'h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_vaapi'])
    .optional(),
  workers: z.number().int().min(1).max(32).optional(),
});

export function editRoutes(d: EditRouteDeps) {
  const { store, jobs } = d;
  const app = new Hono<HgEnv>();

  const fail = (c: Ctx, e: unknown) => {
    if (e instanceof EditError) return c.json({ error: e.message, code: e.code }, e.status);
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
  const body = async (c: Ctx) => ((await c.req.json().catch(() => ({}))) ?? {}) as unknown;
  const must = (c: Ctx): string => {
    const k = ownerKey(d.who(c));
    if (!k) throw new EditError(401, 'signin', 'Sign in to Hildegard first.');
    return k;
  };
  const mine = (c: Ctx): StoredEdit => {
    must(c);
    const id = c.req.param('id') ?? '';
    const e = ID_RE.test(id) ? store.get(id) : undefined;
    if (!e || !mayOpen(d.who(c), e)) throw new EditError(404, 'missing', 'No such edit.');
    return e;
  };
  const resolvers = (c: Ctx): Resolvers => {
    const who = d.who(c);
    return {
      recording: (id) => d.recordFile(id, who),
      exported: (id) => d.exportFile(id, who),
      edit: (id) => {
        const o = ID_RE.test(id) ? store.get(id) : undefined;
        return o?.render && mayOpen(who, o) ? store.fileOf(o, 'out.mp4') : null;
      },
      local: who?.kind === 'local',
    };
  };

  /** An edit as its asker sees it: where the video is on disk only for this computer itself. */
  const shown = (c: Ctx, e: StoredEdit) =>
    view(e, e.render && d.who(c)?.kind === 'local' ? store.fileOf(e, 'out.mp4') : null);

  /** The edit list with references as paths, written beside the edit for the script. */
  const runFile = (c: Ctx, e: StoredEdit): string => {
    const resolved = resolveRefs(e.edl, resolvers(c));
    mkdirSync(store.dirOf(e), { recursive: true });
    const file = store.fileOf(e, 'edl.run.json');
    writeFileSync(file, JSON.stringify(resolved), { mode: 0o600 });
    return file;
  };

  const check = async (c: Ctx, e: StoredEdit, quick = false) => {
    const file = runFile(c, e);
    const r = await jobs.run(() => {}, ['check', file, ...(quick ? ['--quick'] : [])]);
    e.check = toCheck(r);
    store.save(e);
  };

  app.post(
    '/',
    go(async (c) => {
      const owner = must(c);
      const b = Create.parse(await body(c));
      const edl: Edl = b.edl ?? { version: 1, sources: { a: { path: b.source } } };
      resolveRefs(edl, resolvers(c)); // refuse a source they may not use now, not at render time
      const e = store.create(owner, b.title ?? 'Untitled edit', edl);
      try {
        await check(c, e, true);
      } catch (err) {
        if (!(err instanceof EditError && err.code === 'tool')) throw err;
      }
      return c.json(shown(c, e), 201);
    }, 201),
  );

  app.get(
    '/',
    go((c) => {
      const k = must(c);
      const who = d.who(c);
      const all = who?.kind === 'local' || (who?.kind === 'person' && who.person.role === 'owner');
      return { edits: store.list(all ? undefined : k).map((e) => shown(c, e)) };
    }),
  );

  app.get(
    '/:id',
    go((c) => shown(c, mine(c))),
  );

  app.put(
    '/:id/edl',
    go(async (c) => {
      const e = mine(c);
      if (jobs.busy(e))
        throw new EditError(
          409,
          'busy',
          'This edit is working. Wait for it to finish, then change the list.',
        );
      const edl = z.record(z.string(), z.unknown()).parse(await body(c));
      resolveRefs(edl, resolvers(c));
      e.edl = edl;
      e.verify = null;
      store.save(e);
      await check(c, e);
      return shown(c, e);
    }),
  );

  app.post(
    '/:id/check',
    go(async (c) => {
      const e = mine(c);
      await check(c, e);
      return shown(c, e);
    }),
  );

  app.get(
    '/:id/words',
    go((c) => {
      const e = mine(c);
      const file = store.fileOf(e, 'words.txt');
      if (!existsSync(file))
        throw new EditError(404, 'words', 'This edit has no transcript yet. Plan it first.');
      return c.text(readFileSync(file, 'utf8'));
    }),
  );

  app.post(
    '/:id/plan',
    go(async (c) => {
      const e = mine(c);
      const who = d.who(c)!;
      const b = Plan.parse(await body(c));
      const sources = (e.edl.sources ?? {}) as Record<string, { path?: unknown }>;
      const ids = Object.keys(sources);
      if (ids.length !== 1)
        throw new EditError(
          422,
          'source',
          'Planning works on one source. Make an edit of that source, then plan it.',
        );
      const refPath = sources[ids[0]!]!.path;
      const resolved = resolveRefs(e.edl, resolvers(c));
      const source = (resolved.sources as Record<string, { path: string }>)[ids[0]!]!.path;
      const owns = who.kind === 'local' || who.person.role === 'owner';
      if (
        b.transcribe &&
        !b.transcript &&
        !existsSync(store.fileOf(e, 'transcript.json')) &&
        !(d.transcribe && owns)
      )
        throw new EditError(
          409,
          'transcribe',
          d.transcribe
            ? 'Transcribing uses the owner’s voice studio. Send the transcript (words with times) yourself, or ask the owner to plan this edit.'
            : 'This Hildegard has no voice studio to transcribe with. Send the transcript (words with times), or plan with transcribe: false to cut by loudness and motion.',
        );
      const job = jobs.start(e, 'plan', async (set) => {
        const tfile = store.fileOf(e, 'transcript.json');
        if (b.transcript) writeFileSync(tfile, JSON.stringify(b.transcript), { mode: 0o600 });
        else if (b.transcribe && !existsSync(tfile)) {
          set({ stage: 'Listening to the recording' });
          const wav = store.fileOf(e, 'audio.wav');
          const ex = await jobs.run(set, ['extract-audio', source, wav]);
          if (ex.ok !== true)
            throw new EditError(
              422,
              'audio',
              String(ex.error ?? 'That recording has no sound to transcribe.'),
            );
          try {
            set({ stage: 'Transcribing' });
            const t = await d.transcribe!(wav, who);
            writeFileSync(tfile, JSON.stringify(t), { mode: 0o600 });
          } finally {
            rmSync(wav, { force: true });
          }
        }
        const have = existsSync(tfile);
        const out = store.fileOf(e, 'edl.plan.json');
        const args = ['plan', source, '-o', out];
        if (have) args.push('--transcript', tfile);
        if (b.text !== undefined) {
          const tx = store.fileOf(e, 'edited.txt');
          writeFileSync(tx, b.text, { mode: 0o600 });
          args.push('--text', tx);
        }
        if (b.target_seconds) args.push('--target-seconds', String(b.target_seconds));
        if (b.target) args.push('--target', b.target);
        if (!b.fillers) args.push('--no-fillers');
        for (const w of b.filler_words ?? []) args.push('--filler', w);
        if (b.strict_fillers) args.push('--strict-fillers');
        if (!b.bad_takes) args.push('--no-bad-takes');
        if (!b.pauses) args.push('--no-pauses');
        if (!b.captions) args.push('--no-captions');
        if (b.auto) args.push('--auto');
        if (b.title) args.push('--title', b.title);
        set({ stage: 'Planning the cuts' });
        const r = await jobs.run(set, args);
        if (r.ok !== true) throw new EditError(422, 'plan', String(r.error ?? 'Planning failed.'));
        const planned = JSON.parse(readFileSync(out, 'utf8')) as Edl;
        rmSync(out, { force: true });
        // The plan replaces what it decides (the cuts, pauses and captions) and keeps what it doesn't (hiding, titles,
        // music, reframe, target): the source goes back to the reference it was given as.
        const next: Edl = { ...e.edl };
        for (const k of ['keep', 'cuts', 'pauses', 'captions']) delete next[k];
        Object.assign(next, { sources: { a: { path: refPath } } });
        for (const k of ['cuts', 'pauses', 'captions', 'target', 'title'])
          if (planned[k] !== undefined) next[k] = planned[k];
        e.edl = next;
        e.plan = (r.report as Record<string, unknown>) ?? null;
        e.verify = null;
        if (have) {
          const w = await jobs.run(set, ['transcript-text', tfile, '-o', store.fileOf(e, 'words.txt')]);
          if (w.ok !== true)
            throw new EditError(422, 'words', String(w.error ?? 'Couldn’t write the words file.'));
        }
        set({ stage: 'Checking the list' });
        const ck = await jobs.run(set, ['check', runFile(c, e)]);
        e.check = toCheck(ck);
      });
      return c.json({ ...shown(c, e), job }, 202);
    }, 202),
  );

  app.post(
    '/:id/render',
    go(async (c) => {
      const e = mine(c);
      const b = Render.parse(await body(c));
      const file = runFile(c, e);
      const out = store.fileOf(e, 'out.mp4');
      const job = jobs.start(e, 'render', async (set) => {
        const args = ['render', file, out];
        if (b.encoder) args.push('--encoder', b.encoder);
        if (b.workers) args.push('--workers', String(b.workers));
        const r = await jobs.run(set, args);
        if (r.ok !== true) throw new EditError(422, 'render', String(r.error ?? 'Rendering failed.'));
        e.verify = null;
        set({ stage: 'Making the contact sheet', done: null, total: null });
        const sh = await jobs.run(set, ['sheet', out, '--edl', file, '-o', store.fileOf(e, 'sheet.jpg')]);
        e.render = toRender(r, sh.ok === true);
        // The chapters.txt the renderer wrote sits beside the video; keep it where /media can serve it.
        const chap = `${out.replace(/\.mp4$/, '')}.chapters.txt`;
        if (existsSync(chap)) copyFileSync(chap, store.fileOf(e, 'chapters.txt'));
        e.check = e.check ?? null;
      });
      return c.json({ ...shown(c, e), job }, 202);
    }, 202),
  );

  app.post(
    '/:id/verify',
    go(async (c) => {
      const e = mine(c);
      if (!e.render)
        throw new EditError(409, 'render', 'Render this edit first; the gate checks the finished video.');
      const file = runFile(c, e);
      const out = store.fileOf(e, 'out.mp4');
      const job = jobs.start(e, 'verify', async (set) => {
        set({ stage: 'Checking the finished video' });
        const r = await jobs.run(set, ['verify', out, file]);
        e.verify = toVerify(r);
      });
      return c.json({ ...shown(c, e), job }, 202);
    }, 202),
  );

  app.delete(
    '/:id',
    go((c) => {
      const e = mine(c);
      if (jobs.busy(e)) throw new EditError(409, 'busy', 'This edit is working. Wait for it to finish.');
      store.remove(e.id);
      return { ok: true };
    }),
  );

  return app;
}
