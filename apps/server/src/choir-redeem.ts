// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import { clientKey, type HgEnv } from './access.ts';
import { type Choir, ChoirError } from './choir.ts';

/**
 * POST / (mounted at /api/choir/redeem, on the sharing device's own address only, never on the Studio app or its public link): a device that
 * isn't paired yet trades a short code for a key. No sign-in: the code is the proof, and wrong ones are counted.
 */
export function redeemRoutes(choir: Choir): Hono<HgEnv> {
  const app = new Hono<HgEnv>();
  app.post('/', async (c) => {
    c.header('cache-control', 'no-store');
    const body = z
      .object({ code: z.string().max(40), name: z.string().max(63).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give the code from the sharing device.' }, 400);
    try {
      return c.json(choir.redeem(body.data.code, clientKey(c), body.data.name));
    } catch (e) {
      if (e instanceof ChoirError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  return app;
}
