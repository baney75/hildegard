// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/writing/{voice,samples,edits}: a writer's own voice. Everything here belongs to one person: the one signed in,
 * or, on this computer itself, the first owner. An owner may name another person with `?person=<id>`; a director may
 * only ever act on themselves, so asking for someone else's voice is refused, not quietly answered with their own.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Ctx, HgEnv } from './access.ts';
import { WRITING_LIMITS, WritingError, type WritingStore } from './writing.ts';

export interface WritingRouteDeps {
  store: WritingStore;
  /** Everyone with an account, oldest first. */
  people: () => { id: string; role: 'owner' | 'director' }[];
}

/** What the folder of someone who wrote here before there was an account is called. */
export const LOCAL_WRITER = 'local';

const Voice = z.object({ md: z.string().max(WRITING_LIMITS.voiceChars, 'Your voice notes are too long.') });
const NewSample = z.object({
  title: z.string().trim().min(1, 'Give the sample a title.').max(200),
  text: z.string().min(1, 'Paste some of your writing first.').max(WRITING_LIMITS.sampleChars),
  source: z.string().trim().max(200).optional(),
});
const NewEdit = z.object({
  draft: z.string().max(WRITING_LIMITS.textChars),
  final: z.string().max(WRITING_LIMITS.textChars),
  note: z.string().max(500).optional(),
});

/** The edit as the person sees it in a list: what was cut and added, and the lint counts. */
const RECENT = 10;

export function writingRoutes(d: WritingRouteDeps) {
  const { store } = d;
  const app = new Hono<HgEnv>();

  /** Whose voice this request is about, or the refusal. */
  const subject = (c: Ctx): string | Response => {
    const who = c.get('who');
    const people = d.people();
    const named = c.req.query('person');
    if (who?.kind === 'person') {
      if (named !== undefined && named !== who.person.id && who.person.role !== 'owner')
        return c.json(
          { error: 'Your voice is yours alone. Only the owner can open someone else’s.', code: 'owner' },
          403,
        );
      if (named !== undefined && named !== who.person.id) {
        if (!people.some((p) => p.id === named)) return c.json({ error: 'There’s no such person.' }, 404);
        return named;
      }
      return who.person.id;
    }
    if (who?.kind === 'local') {
      if (named !== undefined) {
        if (!people.some((p) => p.id === named)) return c.json({ error: 'There’s no such person.' }, 404);
        return named;
      }
      const owner = people.find((p) => p.role === 'owner');
      if (owner) {
        store.adopt(LOCAL_WRITER, owner.id);
        return owner.id;
      }
      return LOCAL_WRITER;
    }
    return c.json({ error: 'Sign in to Hildegard first.', code: 'signin' }, 401);
  };

  const go =
    (h: (c: Ctx, person: string) => unknown | Promise<unknown>, status: 200 | 201 = 200) =>
    async (c: Ctx) => {
      const person = subject(c);
      if (person instanceof Response) return person;
      try {
        const out = await h(c, person);
        return out instanceof Response ? out : c.json(out as object, status);
      } catch (e) {
        if (e instanceof WritingError) return c.json({ error: e.message, code: e.code }, e.status);
        if (e instanceof z.ZodError) {
          const i = e.issues[0];
          return c.json({ error: i?.message ?? 'That request isn’t right.', field: i?.path.join('.') }, 422);
        }
        throw e;
      }
    };
  const json = async (c: Ctx) => (await c.req.json().catch(() => ({}))) as unknown;
  const tooBig = (max: number) =>
    bodyLimit({
      maxSize: max,
      onError: (c) => c.json({ error: 'That is too much to send at once.' }, 413, { connection: 'close' }),
    });

  app.get(
    '/voice',
    go((_c, person) => ({
      person,
      voice: store.voice(person),
      samples: store.samples(person),
      edits: store.edits(person).slice(-RECENT).reverse(),
      topCut: store.topCut(person, 30),
    })),
  );
  app.put(
    '/voice',
    tooBig(WRITING_LIMITS.voiceChars * 4 + 4096),
    go(async (c, person) => ({
      person,
      voice: store.setVoice(person, Voice.parse(await json(c)).md.replace(/\r\n?/g, '\n')),
    })),
  );

  app.get(
    '/samples',
    go((_c, person) => ({ person, samples: store.samples(person) })),
  );
  app.post(
    '/samples',
    tooBig(WRITING_LIMITS.sampleChars * 4 + 4096),
    go(
      async (c, person) => ({ person, sample: store.addSample(person, NewSample.parse(await json(c))) }),
      201,
    ),
  );
  app.delete(
    '/samples/:id',
    go((c, person) => {
      store.removeSample(person, c.req.param('id') ?? '');
      return { ok: true };
    }),
  );

  app.get(
    '/edits',
    go((_c, person) => ({ person, edits: store.edits(person).slice(-50).reverse() })),
  );
  app.post(
    '/edits',
    tooBig(WRITING_LIMITS.textChars * 8 + 4096),
    go(async (c, person) => {
      const b = NewEdit.parse(await json(c));
      return { person, edit: store.recordEdit(person, b) };
    }, 201),
  );
  return app;
}
