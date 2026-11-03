// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/talk: one spoken turn on this computer, for the owner only (directors reach nothing under it; access.ts). The
 * Studio's Talk page calls only these, never /api/voice, so where each step runs can change behind them.
 */
import type { DeviceCapabilities } from '@hildegard/presets';
import { Hono } from 'hono';
import type { Ctx, HgEnv } from './access.ts';
import { explainTalk, type TalkDeps, type TalkFiles, type TalkTurnRequest, talkTurn } from './talk.ts';

const MAX_TURN = 25 * 1024 * 1024;

/** GET /api/talk */
export interface TalkStatus {
  /** A turn can run: something hears, and something speaks. */
  ready: boolean;
  /** The stand-in GPU: the words heard and the answer are stand-ins. */
  fake: boolean;
  /** Why it isn't ready, in a sentence; null when it is. */
  problem: string | null;
  /** The language model that answers, or null for the stand-in answer. */
  llm: { runtime: string; model: string } | null;
  capabilities: DeviceCapabilities;
}

export interface TalkRouteDeps {
  talk: TalkDeps;
  files: TalkFiles;
  status: () => Promise<TalkStatus>;
  /** Refuses anyone but the owner (or this computer); null to go on. */
  ownerOnly: (c: Ctx) => Response | null;
}

/** The turn's recording: a multipart upload (`audio`, and `language`), or JSON naming a voice upload. */
async function readTurn(c: Ctx): Promise<TalkTurnRequest | Response> {
  const type = c.req.header('content-type') ?? '';
  const lang = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 12) : undefined);
  if (Number(c.req.header('content-length') ?? 0) > MAX_TURN)
    return c.json({ error: 'Talk takes recordings up to 25 MB.', code: 'size' }, 413);
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.parseBody().catch(() => null);
    const f = form?.audio;
    if (!(f instanceof File)) return c.json({ error: 'Send the recording as “audio”.', code: 'empty' }, 400);
    if (f.size > MAX_TURN) return c.json({ error: 'Talk takes recordings up to 25 MB.', code: 'size' }, 413);
    const audio = new Uint8Array(await f.arrayBuffer());
    if (!audio.length) return c.json({ error: 'That recording is empty.', code: 'empty' }, 400);
    return { audio, language: lang(form?.language) };
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const uploadId = body?.uploadId;
  if (typeof uploadId !== 'string' || !uploadId)
    return c.json({ error: 'Send a recording, or the id of one you uploaded.', code: 'empty' }, 400);
  return { audio: { uploadId }, language: lang(body?.language) };
}

export function talkRoutes(d: TalkRouteDeps) {
  const app = new Hono<HgEnv>();
  app.use('*', async (c, next) => d.ownerOnly(c) ?? next());

  app.get('/', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await d.status());
  });

  app.post('/turn', async (c) => {
    const req = await readTurn(c);
    if (req instanceof Response) return req;
    try {
      const r = await talkTurn(d.talk, d.files, req);
      c.header('cache-control', 'no-store');
      return c.json({
        ...r,
        // Bytes travel as base64 in JSON; a file this computer serves goes as its URL.
        audio: {
          contentType: r.audio.contentType,
          ...(r.audio.url ? { url: r.audio.url } : {}),
          ...(r.audio.bytes ? { data: Buffer.from(r.audio.bytes).toString('base64') } : {}),
        },
      });
    } catch (e) {
      const x = explainTalk(e);
      if (!x) throw e;
      return c.json({ error: x.message, code: x.code }, x.status);
    }
  });
  return app;
}
