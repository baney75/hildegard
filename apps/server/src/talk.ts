// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Talk: one spoken turn. The owner speaks, a transcription model hears it, a language model answers, and a speech
 * model says the answer. Each step is a port (TalkStt, TalkLlm, TalkTts), so a step can run on another of the owner's
 * devices without the turn changing: here through the voice studio and the local language models, or on a paired
 * device through talk-remote.ts. docs/architecture/talk-caps.md has the plan.
 */
import { basename } from 'node:path';
import type { DeviceCapabilities, LlmEndpoint, LlmState, VoiceCatalog } from '@hildegard/presets';
import { z } from 'zod';
import { LlmError, onThisComputer } from './llm.ts';
import { VoiceError, type VoiceStudio, type Who } from './voice.ts';

export type TalkTurnRequest = {
  /** WAV (or webm) bytes from the primary mic upload, or a prior upload id if you reuse voice uploads. */
  audio: Uint8Array | { uploadId: string };
  /** Optional language hint for STT. */
  language?: string;
  /** A joined Choir device to hear, answer and speak on; left out, every step runs here. */
  device?: string;
};

export type TalkTurnResult = {
  transcript: string;
  replyText: string;
  /** Audio the primary should play (wav bytes or a job/media URL the Studio already knows how to fetch). */
  audio: { contentType: string; bytes?: Uint8Array; url?: string };
  /** Where each step ran: this computer, or the paired device the turn named. */
  route: { stt: TalkWhere; llm: TalkWhere; tts: TalkWhere };
  /** How long each step took, and the whole turn, in milliseconds as this computer measured them. */
  ms: TalkTiming;
};

export type TalkTiming = { stt: number; llm: number; tts: number; total: number };

export type TalkWhere = 'local' | 'remote';

export type TalkMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Provider ports a remote device can implement too. Keep these pure. `where` is left out for this computer. */
export interface TalkStt {
  readonly where?: TalkWhere;
  transcribe(audioPath: string, language?: string): Promise<{ text: string }>;
}
export interface TalkLlm {
  readonly where?: TalkWhere;
  complete(messages: TalkMessage[]): Promise<string>;
}
export interface TalkTts {
  readonly where?: TalkWhere;
  speak(text: string): Promise<{ path: string; contentType: string }>;
}

export interface TalkDeps {
  stt: TalkStt;
  llm: TalkLlm;
  tts: TalkTts;
}

/** Where a turn's recording lands, and how the Studio reaches what Talk says back. */
export interface TalkFiles {
  /** Keep a recording; its path on this computer. */
  save(bytes: Uint8Array): Promise<string>;
  /** A recording uploaded before, by its upload id; its path on this computer. */
  find(uploadId: string): string;
  /** The URL the Studio plays a file at, or null to send the bytes. */
  url(path: string): string | null;
  read(path: string): Promise<Uint8Array>;
}

export class TalkError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  readonly code: string;
  constructor(status: TalkError['status'], code: string, message: string) {
    super(message);
    this.name = 'TalkError';
    this.status = status;
    this.code = code;
  }
}

const MAX_REPLY = 2000;

export const TALK_SYSTEM =
  'You are Talk, the voice of Hildegard, a studio for making films, voices and art. Answer what was said in one to three short sentences meant to be heard, not read: plain words, no lists, no markdown, no emoji.';

/** Run one turn: hear, answer, speak, in that order. */
export async function talkTurn(
  deps: TalkDeps,
  files: TalkFiles,
  req: TalkTurnRequest,
  now: () => number = performance.now.bind(performance),
): Promise<TalkTurnResult> {
  const start = now();
  let mark = start;
  /** Milliseconds since the last lap. */
  const lap = () => {
    const t = now();
    const ms = Math.max(0, Math.round(t - mark));
    mark = t;
    return ms;
  };
  const path = req.audio instanceof Uint8Array ? await files.save(req.audio) : files.find(req.audio.uploadId);
  lap();
  const transcript = (await deps.stt.transcribe(path, req.language)).text.trim();
  const sttMs = lap();
  if (!transcript)
    throw new TalkError(
      400,
      'silent',
      'Talk didn’t hear any words. Try again a little closer to the microphone.',
    );
  const replyText = (
    await deps.llm.complete([
      { role: 'system', content: TALK_SYSTEM },
      { role: 'user', content: transcript },
    ])
  ).trim();
  const llmMs = lap();
  if (!replyText) throw new TalkError(502, 'no_reply', 'The language model gave no answer. Try again.');
  // A speech job takes up to 5000 characters; a spoken answer is far shorter than that.
  const said = await deps.tts.speak(replyText.slice(0, MAX_REPLY));
  const ttsMs = lap();
  const url = files.url(said.path);
  return {
    transcript,
    replyText,
    audio: url
      ? { contentType: said.contentType, url }
      : { contentType: said.contentType, bytes: await files.read(said.path) },
    route: { stt: deps.stt.where ?? 'local', llm: deps.llm.where ?? 'local', tts: deps.tts.where ?? 'local' },
    ms: { stt: sttMs, llm: llmMs, tts: ttsMs, total: Math.max(0, Math.round(now() - start)) },
  };
}

// ── This computer's adapters ────────────────────────────────────────────────────────────────────────────────────

const TALK_WHO: Who = { source: { kind: 'studio' }, priority: 'interactive' };
/** A turn is meant to be waited on: past this, a step counts as failed. */
const STEP_MS = 5 * 60_000;
/** What the stand-in voice engine "hears" in a recording with nothing marked on it (tests and --fake-gpu). */
export const FAKE_HEARD = 'Hello Hildegard, can you hear me?';
/** The voice Talk answers in, a built-in one every speech install has. */
export const TALK_VOICE = 'kokoro-heart';

type Studio = Pick<VoiceStudio, 'transcribe' | 'speak' | 'whenDone' | 'files'>;

async function finished(studio: Studio, jobId: string) {
  const j = await studio.whenDone(jobId, STEP_MS);
  if (j.status !== 'done')
    throw new TalkError(
      502,
      j.error?.code ?? 'voice',
      j.error?.message ??
        (j.status === 'canceled' ? 'The voice job was canceled.' : 'The voice job didn’t finish in time.'),
    );
  return j;
}

/** Transcribes with the voice studio's Whisper. The path must be a recording the studio keeps (TalkFiles.save). */
export function localStt(studio: Studio, opts: { fake: boolean }): TalkStt {
  return {
    async transcribe(audioPath, language) {
      const job = studio.transcribe({ source: basename(audioPath), language, title: 'Talk' }, TALK_WHO);
      const j = await finished(studio, job.id);
      const text = (j.transcript?.segments ?? [])
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(' ');
      // The stand-in engine hears only what a test marks on a file; a browser recording has no mark.
      return { text: text || (opts.fake ? FAKE_HEARD : '') };
    },
  };
}

/** Speaks with the voice studio, in Talk's voice. */
export function localTts(studio: Studio, voice = TALK_VOICE): TalkTts {
  return {
    async speak(text) {
      const job = studio.speak({ paragraphs: [{ text }], voice, title: 'Talk' }, TALK_WHO);
      const j = await finished(studio, job.id);
      const path = studio.files(j.id)[0];
      if (!path) throw new TalkError(502, 'voice', 'The voice engine made no audio.');
      return { path, contentType: 'audio/wav' };
    },
  };
}

/** Answers with no model at all: the same reply every time for the same words, so tests and the stand-in GPU agree. */
export function stubLlm(note = ''): TalkLlm {
  return {
    async complete(messages) {
      const said =
        [...messages]
          .reverse()
          .find((m) => m.role === 'user')
          ?.content.trim() ?? '';
      return `${note}You said: “${said}”`;
    },
  };
}

const NO_MODEL = 'No local language model is running here, so this is a stand-in answer. ';

/** What Talk needs from llm.ts. */
export interface TalkModels {
  state(): Promise<LlmState>;
  pick(endpoint?: string): Promise<{ endpoint: LlmEndpoint; model: string }>;
  chat(e: LlmEndpoint, body: Record<string, unknown>, ms?: number): Promise<{ content?: string | null }>;
}

/**
 * The model Talk answers with: the owner's choice when it runs on this computer, else the first one here that does,
 * picked as `llm.pick` picks. Null when none does, so the turn gives the stand-in answer. Talk's route says `local`,
 * so an owner's endpoint on another computer or a paid API is never asked.
 */
export async function pickTalkModel(
  llm: TalkModels,
): Promise<{ endpoint: LlmEndpoint; model: string } | null> {
  const state = await llm.state();
  const here = state.endpoints.filter(onThisComputer);
  const chosen = here.find((e) => e.id === state.use?.endpoint);
  // The owner's choice is asked even when it is down, so the turn says why rather than quietly answering elsewhere.
  const e = chosen ?? here.find((x) => x.online && x.models.length);
  if (!e) return null;
  let picked: { endpoint: LlmEndpoint; model: string };
  try {
    picked = await llm.pick(e.id);
  } catch (err) {
    if (err instanceof LlmError && err.status === 404) return null;
    throw err;
  }
  return onThisComputer(picked.endpoint) ? picked : null;
}

/**
 * Answers with a language model running here (llm.ts). With none running, it gives the stand-in answer and says so,
 * so a turn still finishes.
 */
export function localLlm(llm: TalkModels): TalkLlm {
  const stub = stubLlm(NO_MODEL);
  return {
    async complete(messages) {
      const picked = await pickTalkModel(llm);
      if (!picked) return stub.complete(messages);
      const msg = await llm.chat(
        picked.endpoint,
        { model: picked.model, temperature: 0.6, messages },
        STEP_MS,
      );
      return msg.content ?? '';
    },
  };
}

/**
 * Whether a turn can run, and why not: the speech engine, a transcription model, and the model Talk's own voice
 * speaks with. Another speaking model doesn't count, since Talk always answers in TALK_VOICE.
 */
export function talkReadiness(d: {
  engine: boolean;
  caps: Pick<DeviceCapabilities, 'stt'>;
  catalog: Pick<VoiceCatalog, 'models' | 'voices'>;
  usable: (model: string) => boolean;
  voice?: string;
}): { ready: boolean; problem: string | null } {
  if (!d.engine)
    return {
      ready: false,
      problem: 'The voice engine isn’t installed on this computer yet. Run `hildegard voice install`.',
    };
  const modelId = d.catalog.voices.find((v) => v.id === (d.voice ?? TALK_VOICE))?.model;
  const model = d.catalog.models.find((m) => m.id === modelId);
  const speaks = model ? d.usable(model.id) : false;
  const missing = [d.caps.stt.length ? null : 'Whisper', speaks ? null : (model?.name ?? 'Kokoro')].filter(
    (x): x is string => !!x,
  );
  if (!missing.length) return { ready: true, problem: null };
  return {
    ready: false,
    problem: `Talk needs ${missing.join(' and ')}. Install ${missing.length > 1 ? 'them' : 'it'} in Voice › Models.`,
  };
}

/** Errors a turn can end with, as an HTTP status, a code and a sentence. */
export function explainTalk(
  e: unknown,
): { status: 400 | 403 | 404 | 409 | 410 | 413 | 415 | 502; code: string; message: string } | null {
  if (e instanceof TalkError || e instanceof VoiceError)
    return { status: e.status, code: e.code, message: e.message };
  if (e instanceof LlmError) return { status: e.status, code: 'llm', message: e.message };
  if (e instanceof z.ZodError)
    return { status: 400, code: 'bad_request', message: e.issues[0]?.message ?? 'That request isn’t right.' };
  return null;
}
