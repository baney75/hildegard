// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Talk across the owner's devices. A device sharing its GPU also hears, answers and speaks for the devices paired with
 * it, on /api/node/{transcribe,complete,speak} behind the same bearer key as rendering; the remote adapters here are
 * the paired side, each a TalkStt, TalkLlm or TalkTts that calls one of those routes. Only the turn's recording and
 * the words of the turn cross over: never a voice sample or a consent recording. docs/architecture/talk-caps.md.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  explainTalk,
  TALK_VOICE,
  TalkError,
  type TalkFiles,
  type TalkLlm,
  type TalkMessage,
  type TalkStt,
  type TalkTts,
} from './talk.ts';

/** Recordings up to 25 MB, as on /api/talk/turn. */
export const MAX_TALK_AUDIO = 25 * 1024 * 1024;
const MAX_TALK_JSON = 256 * 1024;
/** A turn is meant to be waited on: past this, a step on the other device counts as failed. */
const REMOTE_STEP_MS = 5 * 60_000;

const CompleteBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(8000) }))
    .min(1)
    .max(40),
});
const SpeakBody = z.object({
  text: z.string().trim().min(1).max(2000),
  voice: z.string().max(80).optional(),
});

/** What this device lends paired devices for Talk: its own ports, and where it keeps a recording it was sent. */
export interface NodeTalkDeps {
  stt: TalkStt;
  llm: TalkLlm;
  /** Talk's voice, or another built-in one `voices` lists. */
  tts: (voice: string) => TalkTts;
  /** Built-in voices a paired device may ask for. A cloned voice is never one of them. */
  voices: () => string[];
  files: Pick<TalkFiles, 'save' | 'read'>;
}

const fail = (e: unknown) => {
  const x = explainTalk(e);
  if (!x) throw e;
  return { body: { error: x.message, code: x.code }, status: x.status };
};

/**
 * /api/node/transcribe, /complete and /speak. Mounted inside nodeRoutes, so pairedOnly runs first. `talk` is asked per
 * request, since the server makes the node routes before its voice studio.
 */
export function nodeTalkRoutes(talk: () => NodeTalkDeps): Hono {
  const app = new Hono();
  const tooBig = (max: string) =>
    bodyLimit({
      maxSize: max === 'audio' ? MAX_TALK_AUDIO : MAX_TALK_JSON,
      onError: (c) =>
        c.json(
          {
            error: max === 'audio' ? 'Talk takes recordings up to 25 MB.' : 'That’s too much to send.',
            code: 'size',
          },
          413,
          { connection: 'close' },
        ),
    });

  // The recording as the raw body (or multipart `audio`), with `language` in the query or the form.
  app.post('/transcribe', tooBig('audio'), async (c) => {
    let bytes: Uint8Array;
    let language = c.req.query('language');
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await c.req.parseBody().catch(() => null);
      const f = form?.audio;
      if (!(f instanceof File))
        return c.json({ error: 'Send the recording as “audio”.', code: 'empty' }, 400);
      bytes = new Uint8Array(await f.arrayBuffer());
      if (typeof form?.language === 'string') language = form.language;
    } else bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) return c.json({ error: 'That recording is empty.', code: 'empty' }, 400);
    const lang = language?.trim().slice(0, 12) || undefined;
    const d = talk();
    try {
      const path = await d.files.save(bytes);
      const { text } = await d.stt.transcribe(path, lang);
      c.header('cache-control', 'no-store');
      return c.json({ text: text.trim() });
    } catch (e) {
      const x = fail(e);
      return c.json(x.body, x.status);
    }
  });

  app.post('/complete', tooBig('json'), async (c) => {
    const parsed = CompleteBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the turn as { messages }.', code: 'bad_request' }, 400);
    try {
      const text = (await talk().llm.complete(parsed.data.messages)).trim();
      c.header('cache-control', 'no-store');
      return c.json({ text });
    } catch (e) {
      const x = fail(e);
      return c.json(x.body, x.status);
    }
  });

  // The answer's audio comes back as the response body, so nothing waits here for a second fetch.
  app.post('/speak', tooBig('json'), async (c) => {
    const parsed = SpeakBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the words as { text }.', code: 'bad_request' }, 400);
    const voice = parsed.data.voice ?? TALK_VOICE;
    const d = talk();
    if (!d.voices().includes(voice))
      return c.json({ error: 'That voice isn’t one this device speaks for others.', code: 'voice' }, 400);
    try {
      const said = await d.tts(voice).speak(parsed.data.text);
      const bytes = await d.files.read(said.path);
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        'content-type': said.contentType,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
      });
    } catch (e) {
      const x = fail(e);
      return c.json(x.body, x.status);
    }
  });
  return app;
}

// ── The paired side ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RemoteTalkOpts {
  /** The sharing device's URL, as in its join code. */
  url: string;
  /** The key this device keeps for it; null once it has left. */
  token: () => string | null;
  /** The device's name, for messages. */
  name?: string;
  fetch?: typeof fetch;
}

const AUDIO_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
};

/** One call to a /api/node Talk route, with every way it can fail said as a TalkError. */
async function call(o: RemoteTalkOpts, path: string, init: RequestInit): Promise<Response> {
  const who = o.name ?? 'The other device';
  const token = o.token();
  if (!token)
    throw new TalkError(409, 'remote_key', `This computer has no key for ${who} any more. Join it again.`);
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(new URL(`/api/node/${path}`, o.url), {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REMOTE_STEP_MS),
    });
  } catch (e) {
    const late = (e as Error).name === 'TimeoutError';
    throw new TalkError(
      502,
      'remote_offline',
      late
        ? `${who} took too long to answer.`
        : `${who} isn’t answering. Check that it is on and on your tailnet.`,
    );
  }
  if (res.ok) return res;
  if (res.status === 401)
    throw new TalkError(
      502,
      'remote_refused',
      `${who} doesn’t accept this computer’s key any more. Join it again.`,
    );
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  throw new TalkError(
    res.status === 400 || res.status === 409 ? res.status : 502,
    body?.code ?? 'remote',
    body?.error ?? `${who} couldn’t do that (HTTP ${res.status}).`,
  );
}

/** Hears on a paired device: the recording's bytes go there, the words come back. */
export function remoteStt(o: RemoteTalkOpts): TalkStt {
  return {
    where: 'remote',
    async transcribe(audioPath, language) {
      const bytes = await readFile(audioPath);
      const q = language ? `?language=${encodeURIComponent(language)}` : '';
      const res = await call(o, `transcribe${q}`, {
        method: 'POST',
        headers: {
          'content-type': AUDIO_TYPES[extname(audioPath).toLowerCase()] ?? 'application/octet-stream',
        },
        body: bytes,
      });
      const r = (await res.json()) as { text?: unknown };
      return { text: typeof r.text === 'string' ? r.text : '' };
    },
  };
}

/** Answers with a language model on a paired device. */
export function remoteLlm(o: RemoteTalkOpts): TalkLlm {
  return {
    where: 'remote',
    async complete(messages: TalkMessage[]) {
      const res = await call(o, 'complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      const r = (await res.json()) as { text?: unknown };
      return typeof r.text === 'string' ? r.text : '';
    },
  };
}

/**
 * Speaks on a paired device, and keeps the audio here with `save` (the primary's voice uploads, so the Studio plays
 * it like any other), or in a temporary folder when none is given.
 */
export function remoteTts(
  o: RemoteTalkOpts & { voice?: string; save?: (bytes: Uint8Array) => Promise<string> },
): TalkTts {
  let tmp: string | null = null;
  const save =
    o.save ??
    (async (bytes: Uint8Array) => {
      tmp ??= mkdtempSync(join(tmpdir(), 'hg-talk-'));
      const p = join(tmp, `${randomBytes(8).toString('hex')}.wav`);
      await writeFile(p, bytes, { mode: 0o600 });
      return p;
    });
  return {
    where: 'remote',
    async speak(text) {
      const res = await call(o, 'speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...(o.voice ? { voice: o.voice } : {}) }),
      });
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/wav';
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new TalkError(502, 'voice', `${o.name ?? 'The other device'} made no audio.`);
      return { path: await save(bytes), contentType };
    },
  };
}
