// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { clientKey, type HgEnv } from './access.ts';
import { type Choir, ChoirError } from './choir.ts';

/**
 * POST / (mounted at /api/choir/redeem): a device that isn't paired yet trades a short code for a key. No sign-in: the
 * code is the proof, and wrong ones are counted. It is mounted on the node-only app at the sharing device's own address,
 * and on the Studio app behind a guard that lets in this computer, Tailscale Serve (a loopback socket with the sharing
 * address as Host) and sockets opened to the sharing address itself. It is never on the hosted listener behind the public
 * link or the front door. A body over 1 KB is refused before it is read.
 */
export function redeemRoutes(choir: Choir): Hono<HgEnv> {
  const app = new Hono<HgEnv>();
  app.post(
    '/',
    bodyLimit({
      maxSize: 1024,
      onError: (c) => c.json({ error: 'That is too large to be a code.' }, 413, { connection: 'close' }),
    }),
    async (c) => {
      c.header('cache-control', 'no-store');
      const body = z
        .object({ code: z.string().max(40), name: z.string().max(63).optional() })
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'Give the code from the sharing device.' }, 400);
      try {
        return c.json(choir.redeem(body.data.code, c.get('source') ?? clientKey(c), body.data.name));
      } catch (e) {
        if (e instanceof ChoirError) return c.json({ error: e.message }, e.status);
        throw e;
      }
    },
  );
  return app;
}
