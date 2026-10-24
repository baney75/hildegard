// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/voice/*: the owner's voice studio. Directors never reach it (access.ts lets them nowhere under it), and agents
 * reach it as the owner through the MCP tools, which can use voices but never start a clone.
 *
 * /api/consent/<token>: the one page a speaker reaches without signing in, to read their consent line on their own
 * phone. The token is the only key, it lasts as long as the line does, and it can only add that one recording.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv } from './access.ts';
import { ModelError } from './fetcher.ts';
import { VoiceError, type VoiceStudio, type Who } from './voice.ts';
import { VoiceEngineError } from './voice-engine.ts';
import type { VoiceModels } from './voice-models.ts';

const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_CONSENT = 25 * 1024 * 1024;

export interface VoiceRouteDeps {
  studio: VoiceStudio;
  models: VoiceModels;
  /** Refuses anyone but the owner (or this computer); null to go on. */
  ownerOnly: (c: Ctx) => Response | null;
  /** Where a speaker's phone can reach this Hildegard over https, if anywhere. */
  linkBase: (c: Ctx) => string | null;
  publicKey: string;
}

function fail(c: Ctx, e: unknown) {
  if (e instanceof VoiceError) return c.json({ error: e.message, code: e.code }, e.status);
  if (e instanceof z.ZodError) {
    const i = e.issues[0];
    return c.json(
      { error: i?.message ?? 'That request isn’t right.', field: i?.path.join('.') || undefined },
      400,
    );
  }
  if (e instanceof ModelError) return c.json({ error: e.message, code: e.code }, 409);
  if (e instanceof VoiceEngineError)
    return c.json({ error: e.message, code: e.code }, e.code === 'not_installed' ? 409 : 502);
  throw e;
}

/** Who asked: the Studio, or an agent naming itself; agents queue behind the Studio unless they say otherwise. */
function whoFrom(body: Record<string, unknown>): { who: Who; rest: Record<string, unknown> } {
  const { agent, priority, ...rest } = body;
  const name = typeof agent === 'string' && agent.trim() ? agent.trim().slice(0, 60) : null;
  const p =
    priority === 'forced' || priority === 'interactive' || priority === 'agent' ? priority : undefined;
  return { who: { source: name ? { kind: 'agent', name } : { kind: 'studio' }, priority: p }, rest };
}

async function bytes(c: Ctx, max: number): Promise<Uint8Array> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > max) throw new VoiceError(413, 'size', `Recordings up to ${max / 1024 / 1024} MB.`);
  const b = new Uint8Array(await c.req.arrayBuffer());
  if (b.length > max) throw new VoiceError(413, 'size', `Recordings up to ${max / 1024 / 1024} MB.`);
  if (!b.length) throw new VoiceError(400, 'empty', 'That recording is empty.');
  return b;
}

const param = (c: Ctx, k: string) => c.req.param(k) ?? '';
const json = async (c: Ctx) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

export function voiceRoutes(d: VoiceRouteDeps) {
  const { studio, models } = d;
  const app = new Hono<HgEnv>();
  app.use('*', async (c, next) => d.ownerOnly(c) ?? next());
  const go =
    (h: (c: Ctx) => unknown | Promise<unknown>, status: 200 | 201 | 202 = 200) =>
    async (c: Ctx) => {
      try {
        const out = await h(c);
        return out instanceof Response ? out : c.json(out as object, status);
      } catch (e) {
        return fail(c, e);
      }
    };

  app.get(
    '/',
    go(() => studio.state()),
  );
  app.get('/consent-key', (c) => c.text(d.publicKey, 200, { 'content-type': 'application/x-pem-file' }));

  // Voices
  app.get(
    '/voices',
    go(() => studio.list()),
  );
  app.patch(
    '/voices/:id',
    go(async (c) =>
      studio.rename(
        param(c, 'id'),
        z.object({ name: z.string().trim().min(1).max(60) }).parse(await json(c)).name,
      ),
    ),
  );
  app.delete(
    '/voices/:id',
    go((c) => {
      studio.remove(param(c, 'id'));
      return { ok: true };
    }),
  );
  app.post(
    '/voices/:id/revoke',
    go((c) => studio.revoke(param(c, 'id'))),
  );
  app.get(
    '/voices/:id/uses',
    go((c) => studio.uses(param(c, 'id'))),
  );
  app.get(
    '/voices/:id/certificate',
    go((c) => {
      const v = studio.voice(param(c, 'id'));
      if (!v.consent) throw new VoiceError(404, 'missing', 'Only cloned voices have a consent certificate.');
      return c.body(v.consent.certificate, 200, {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="${v.id}-consent.json"`,
      });
    }),
  );
  app.post(
    '/voices/:id/preview',
    go(async (c) => studio.preview(param(c, 'id'), whoFrom(await json(c)).who), 202),
  );

  // Jobs
  for (const kind of ['speak', 'design', 'convert', 'transcribe', 'dub'] as const)
    app.post(
      `/${kind}`,
      go(async (c) => {
        const { who, rest } = whoFrom(await json(c));
        return studio[kind](rest, who);
      }, 202),
    );
  app.post(
    '/design/:job/keep',
    go(async (c) => {
      const b = z
        .object({ candidate: z.number().int().min(1).max(3), name: z.string().trim().min(1).max(60) })
        .parse(await json(c));
      return studio.keepDesign(param(c, 'job'), b.candidate, b.name);
    }, 201),
  );
  app.get(
    '/jobs/:id',
    go((c) => ({ ...studio.job(param(c, 'id')), files: studio.files(param(c, 'id')) })),
  );
  app.post(
    '/jobs/:id/cancel',
    go((c) => studio.cancel(param(c, 'id'))),
  );
  app.post(
    '/jobs/:id/keep',
    go(async (c) => studio.keep(param(c, 'id'), z.object({ kept: z.boolean() }).parse(await json(c)).kept)),
  );
  app.delete(
    '/jobs/:id',
    go((c) => {
      studio.delete(param(c, 'id'));
      return { ok: true };
    }),
  );

  // Files
  app.post(
    '/uploads',
    go(async (c) => studio.upload(await bytes(c, MAX_UPLOAD)), 201),
  );
  app.post(
    '/check',
    go(async (c) => studio.isOurs(z.object({ source: z.string() }).parse(await json(c)).source)),
  );

  // Models
  app.post(
    '/models/:id/install',
    go(async (c) => {
      const mid = param(c, 'id');
      const m = models.model(mid);
      if ((await json(c)).acceptLicense === true) models.acceptLicense(mid);
      if (!models.licenseAccepted(mid)) {
        const also = models.needs(m);
        return c.json(
          {
            error: `Accept the ${m.license} first.`,
            code: 'license',
            license: m.license,
            licenseUrl: m.licenseUrl,
            terms: m.terms,
            also: also.map((x) => ({ id: x.id, name: x.name, license: x.license, licenseUrl: x.licenseUrl })),
          },
          409,
        );
      }
      void models.install(mid).catch(() => {});
      return c.json(models.states(), 202);
    }),
  );
  app.post(
    '/models/:id/cancel',
    go((c) => {
      if (!models.cancel(param(c, 'id'))) throw new VoiceError(409, 'idle', 'Nothing is downloading.');
      return models.states();
    }),
  );

  // Consent
  app.post(
    '/consent',
    go(async (c) => {
      c.header('cache-control', 'no-store');
      return studio.startConsent(await json(c), d.linkBase(c));
    }, 201),
  );
  app.get(
    '/consent/:id',
    go((c) => studio.session(param(c, 'id'))),
  );
  app.post(
    '/consent/:id/recording',
    go(async (c) => studio.record({ session: param(c, 'id') }, await bytes(c, MAX_CONSENT))),
  );
  app.post(
    '/consent/:id/samples',
    go(async (c) =>
      studio.addSamples(
        param(c, 'id'),
        z.object({ names: z.array(z.string()).min(1).max(40) }).parse(await json(c)).names,
      ),
    ),
  );
  app.delete(
    '/consent/:id/samples/:name',
    go((c) => studio.removeSample(param(c, 'id'), param(c, 'name'))),
  );
  app.post(
    '/consent/:id/check',
    go((c) => studio.check(param(c, 'id')), 202),
  );
  app.post(
    '/consent/:id/finish',
    go(
      async (c) =>
        studio.finish(
          param(c, 'id'),
          z.object({ name: z.string().trim().min(1).max(60) }).parse(await json(c)).name,
        ),
      201,
    ),
  );
  return app;
}

/** /api/consent/<token>: the speaker's own phone, signed in or not. */
export function consentLinkRoutes(studio: VoiceStudio) {
  const app = new Hono<HgEnv>();
  const go = (h: (c: Ctx) => unknown | Promise<unknown>) => async (c: Ctx) => {
    c.header('cache-control', 'no-store');
    try {
      return c.json((await h(c)) as object);
    } catch (e) {
      return fail(c, e);
    }
  };
  app.get(
    '/:token',
    go((c) => studio.byToken(param(c, 'token'))),
  );
  app.post(
    '/:token/recording',
    go(async (c) => {
      await studio.record({ token: param(c, 'token') }, await bytes(c, MAX_CONSENT));
      // The phone learns only that it arrived.
      return { recorded: true };
    }),
  );
  return app;
}
