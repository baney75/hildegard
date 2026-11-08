// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/stream/*: Go live.
 *
 * Who may do what. Anyone signed in as the owner may read the state, change the scene, the microphone, the lower third
 * and the caption, and Stop. Everything else (starting, the preview picture, devices, destinations, keys, OBS) is the
 * person at this computer's alone: it uses this computer's screen, camera and microphone and sends the stream key
 * somewhere. An AI app calling through the MCP is never that person, whatever computer it runs on, so those routes
 * answer it with `code: 'needs-owner'`. No route returns a stream key or OBS password, and none logs a body.
 */

import { StreamDestinationId } from '@hildegard/presets';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv } from './access.ts';
import { StreamError, type Streamer } from './stream.ts';
import { type Obs, ObsError } from './stream-obs.ts';

export interface StreamRouteDeps {
  streamer: Streamer;
  obs: Obs;
  /** The request is from the person at this computer (a loopback connection, not through a proxy). */
  local: (c: Ctx) => boolean;
  /** The request is from the owner: at this computer, or signed in as the owner elsewhere. */
  owner: (c: Ctx) => boolean;
}

/** Settings an owner signed in on another device may change while live: nothing that moves the stream. */
const REMOTE_KEYS = new Set(['scene', 'mute', 'lowerThird', 'caption']);

export function streamRoutes(d: StreamRouteDeps) {
  const { streamer, obs } = d;
  const app = new Hono<HgEnv>();

  // An AI app calls through the MCP with the person it signed in as; that is not a click in the Studio.
  const agent = (c: Ctx) => !!c.env?.as;
  const needsOwner = (c: Ctx, why: string) =>
    c.json(
      { error: `${why} Press it in Hildegard’s Studio, on the computer it runs on.`, code: 'needs-owner' },
      403,
    );
  /** The person at this computer, in the Studio. */
  const here = (c: Ctx, why: string) =>
    agent(c)
      ? needsOwner(c, why)
      : d.local(c)
        ? null
        : c.json({ error: `${why} Do it from the computer Hildegard runs on.`, code: 'local' }, 403);
  /** The owner, anywhere, but not an AI app. */
  const owns = (c: Ctx, why: string) =>
    agent(c)
      ? needsOwner(c, why)
      : d.owner(c)
        ? null
        : c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);

  const fail = (c: Ctx, e: unknown) => {
    if (e instanceof StreamError || e instanceof ObsError)
      return c.json(
        { error: e.message, code: e.code },
        e.status as 400 | 401 | 403 | 404 | 409 | 501 | 502 | 504,
      );
    if (e instanceof z.ZodError) return c.json({ error: e.issues[0]?.message ?? 'That isn’t right.' }, 400);
    throw e;
  };
  const go = (h: (c: Ctx) => unknown | Promise<unknown>) => async (c: Ctx) => {
    c.header('cache-control', 'no-store');
    try {
      const out = await h(c);
      return out instanceof Response ? out : c.json(out as object);
    } catch (e) {
      return fail(c, e);
    }
  };
  const body = async (c: Ctx) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const view = (c: Ctx) => streamer.state(!agent(c) && d.local(c));
  /** What an AI app may see: no devices, no file paths, no addresses. */
  const redacted = (c: Ctx) => {
    const s = view(c);
    if (!agent(c)) return s;
    return {
      ...s,
      settings: undefined,
      destinations: s.destinations.map((x) => ({
        id: x.id,
        name: x.name,
        enabled: x.enabled,
        keySet: x.keySet,
        state: x.state,
        detail: x.detail,
      })),
    };
  };

  app.get(
    '/',
    go((c) => redacted(c)),
  );

  app.put(
    '/settings',
    go(async (c) => {
      const b = await body(c);
      const live = Object.keys(b).every((k) => REMOTE_KEYS.has(k));
      const no = live
        ? owns(c, 'Changing the stream is the owner’s.')
        : here(c, 'Changing where the stream goes is the owner’s.');
      if (no) return no;
      await streamer.update(b);
      return view(c);
    }),
  );

  // Keys: written and removed here, and never read back by anything.
  const Id = z.object({ id: StreamDestinationId });
  app.put(
    '/keys/:id',
    go(async (c) => {
      const no = here(c, 'Saving a stream key is the owner’s.');
      if (no) return no;
      const { id } = Id.parse({ id: c.req.param('id') });
      const key = z.object({ key: z.string().max(600) }).parse(await body(c)).key;
      streamer.setKey(id, key);
      return view(c);
    }),
  );
  app.delete(
    '/keys/:id',
    go((c) => {
      const no = here(c, 'Removing a stream key is the owner’s.');
      if (no) return no;
      streamer.clearKey(Id.parse({ id: c.req.param('id') }).id);
      return view(c);
    }),
  );

  app.get(
    '/devices',
    go(async (c) => here(c, 'The devices on this computer are the owner’s.') ?? (await streamer.devices())),
  );
  app.get(
    '/log',
    go((c) => here(c, 'FFmpeg’s log is the owner’s.') ?? { lines: streamer.log() }),
  );
  app.post(
    '/preflight',
    go(
      async (c) =>
        here(c, 'Checking the stream uses this computer’s devices, which is the owner’s.') ??
        (await streamer.preflight()),
    ),
  );

  app.post(
    '/preview/start',
    go(async (c) => {
      const no = here(c, 'The preview shows this computer’s screen and camera.');
      if (no) return no;
      await streamer.startPreview();
      return view(c);
    }),
  );
  app.post(
    '/preview/stop',
    go(async (c) => {
      const no = here(c, 'The preview is the owner’s.');
      if (no) return no;
      await streamer.stopPreview();
      return view(c);
    }),
  );
  /** One picture of the preview. */
  app.get('/preview.jpg', (c) => {
    const no = here(c, 'The preview shows this computer’s screen and camera.');
    if (no) return no;
    const f = streamer.latestFrame();
    if (!f) return c.json({ error: 'No picture yet.' }, 404);
    return new Response(new Uint8Array(f), {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
    });
  });
  /** The preview as it moves: a multipart stream of pictures the page shows in an img tag. */
  app.get('/preview.mjpg', (c) => {
    const no = here(c, 'The preview shows this computer’s screen and camera.');
    if (no) return no;
    const b = 'hgframe';
    let off: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const enc = new TextEncoder();
        const send = (f: Buffer) => {
          try {
            ctrl.enqueue(
              enc.encode(`--${b}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`),
            );
            ctrl.enqueue(new Uint8Array(f));
            ctrl.enqueue(enc.encode('\r\n'));
          } catch {
            off?.();
          }
        };
        const first = streamer.latestFrame();
        if (first) send(first);
        off = streamer.onFrame(send);
      },
      cancel() {
        off?.();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': `multipart/x-mixed-replace; boundary=${b}`, 'cache-control': 'no-store' },
    });
  });

  app.post(
    '/go-live',
    go(async (c) => {
      const no = here(c, 'Going live is the owner’s to start.');
      if (no) return no;
      await streamer.goLive();
      return view(c);
    }),
  );
  app.post(
    '/cancel',
    go(async (c) => {
      const no = here(c, 'The countdown is the owner’s.');
      if (no) return no;
      await streamer.cancelCountdown();
      return view(c);
    }),
  );
  // Stop is the owner's from any device: ending a stream is always safe to allow.
  app.post(
    '/stop',
    go(async (c) => {
      const no = owns(c, 'Stopping a stream is the owner’s.');
      if (no) return no;
      await streamer.stop();
      return view(c);
    }),
  );

  // ── OBS ──────────────────────────────────────────────────────────────────────────────────────────────────────
  app.get(
    '/obs',
    go(
      async (c) =>
        here(c, 'OBS is on this computer, and the owner’s.') ?? {
          ...(await obs.status()),
          passwordSaved: obs.hasPassword(),
        },
    ),
  );
  app.put(
    '/obs/password',
    go(async (c) => {
      const no = here(c, 'The OBS password is the owner’s.');
      if (no) return no;
      obs.setPassword(z.object({ password: z.string().max(300) }).parse(await body(c)).password);
      return { ...(await obs.status()), passwordSaved: true };
    }),
  );
  app.delete(
    '/obs/password',
    go((c) => {
      const no = here(c, 'The OBS password is the owner’s.');
      if (no) return no;
      obs.clearPassword();
      return { ok: true };
    }),
  );
  app.post(
    '/obs/scene',
    go(async (c) => {
      const no = here(c, 'Switching OBS scenes is the owner’s.');
      if (no) return no;
      await obs.setScene(z.object({ scene: z.string().min(1).max(200) }).parse(await body(c)).scene);
      return { ...(await obs.status()), passwordSaved: obs.hasPassword() };
    }),
  );
  app.post(
    '/obs/start',
    go(async (c) => {
      const no = here(c, 'Starting OBS’s stream is the owner’s.');
      if (no) return no;
      await obs.start();
      return { ...(await obs.status()), passwordSaved: obs.hasPassword() };
    }),
  );
  app.post(
    '/obs/stop',
    go(async (c) => {
      const no = owns(c, 'Stopping OBS’s stream is the owner’s.');
      if (no) return no;
      await obs.stop();
      return { ...(await obs.status()), passwordSaved: obs.hasPassword() };
    }),
  );
  // Point OBS at a saved destination: the key goes from the keychain to OBS, and is not in the answer.
  app.post(
    '/obs/service',
    go(async (c) => {
      const no = here(c, 'Setting OBS’s stream service is the owner’s.');
      if (no) return no;
      const { destination } = z.object({ destination: StreamDestinationId }).parse(await body(c));
      await streamer.useInObs(obs, destination);
      return { ...(await obs.status()), passwordSaved: obs.hasPassword() };
    }),
  );

  return app;
}
