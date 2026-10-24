// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The voice studio: the library of voices (built in, designed and consented clones), the queue of voice jobs, and
 * consent. Jobs run one at a time on this computer's GPU, holding it through the render scheduler so a voice job and
 * a video render never share its memory. Everything it speaks carries Hildegard's watermark, and every use of a
 * cloned voice is written down, for its speaker to see.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type BuiltinVoice,
  type ConsentCheck,
  type ConsentSessionView,
  ConvertRequest,
  compileParagraph,
  DesignRequest,
  DubRequest,
  engineSettings,
  type MarkCheck,
  type SafetyCheck,
  type Segment,
  type ServerEvent,
  SpeakRequest,
  spokenText,
  TranscribeRequest,
  type Transcript,
  type Voice,
  type VoiceCatalog,
  type VoiceJob,
  type VoiceJobKind,
  type VoiceModel,
  type VoiceState,
  type VoiceUse,
  voiceHue,
} from '@hildegard/presets';
import { z } from 'zod';
import {
  type Certificate,
  type ConsentLine,
  type ConsentSigner,
  consentLine,
  cosine,
  heardLine,
  newToken,
  sha256File,
} from './consent.ts';
import type { LocalModels } from './llm.ts';
import { type VoiceEngine, VoiceEngineError, type VoiceEnv } from './voice-engine.ts';
import { TRANSCRIBER, type VoiceModels } from './voice-models.ts';

export class VoiceError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 410 | 413 | 415;
  readonly code: string;
  constructor(status: VoiceError['status'], code: string, message: string) {
    super(message);
    this.name = 'VoiceError';
    this.status = status;
    this.code = code;
  }
}

/** A voice as kept on disk: what everyone sees, and the reference audio and consent only this computer keeps. */
interface StoredVoice extends Voice {
  /** Reference clip, in `<data>/voice/refs/`. Gone once consent is revoked. */
  ref?: string;
  /** What the reference clip says, for models that want it. */
  refText?: string;
  cert?: Certificate;
}

interface Session {
  id: string;
  token: string;
  speaker: string;
  relation: 'self' | 'agreed' | 'licensed';
  language: string;
  until: string | null;
  line: ConsentLine;
  expiresAt: number;
  recording: { name: string; wav: string; seconds: number; via: 'here' | 'link'; at: string } | null;
  samples: Array<{ name: string; wav: string; seconds: number }>;
  checking: boolean;
  check: ConsentCheck | null;
  /** The reference clip chosen during the check, and what it says. */
  ref: { wav: string; text: string } | null;
  voice: string | null;
}

interface JobExtra {
  abort: AbortController;
  /** SHA-256 of each finished file, so “Is this ours?” recognises it byte for byte. */
  sha256: string[];
}

export interface Who {
  /** The Studio, or an agent by name. */
  source: VoiceJob['source'];
  priority?: VoiceJob['priority'];
}

const RANK = { forced: 0, interactive: 1, agent: 2 } as const;
const MAX_JOBS = 300;
const SR = 24000;
/** A finished check can be turned into a voice for this long. */
const FINISH_MS = 60 * 60 * 1000;
const PREVIEW_LINE = 'Hello. This is how I sound when I read a line from your script.';

const id = () => randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

/** The audio a browser, phone or editor makes, recognised by its first bytes. */
export function sniffAudio(b: Uint8Array): 'wav' | 'mp3' | 'ogg' | 'flac' | 'webm' | 'm4a' | null {
  const at = (o: number, s: string) => [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(0, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  if (at(0, 'OggS')) return 'ogg';
  if (at(0, 'fLaC')) return 'flac';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (at(4, 'ftyp')) return 'm4a';
  return null;
}

export class VoiceStudio {
  private readonly dir: string;
  private readonly mediaDir: string;
  private readonly refs: string;
  private readonly catalog: VoiceCatalog;
  private readonly models: VoiceModels;
  private readonly engine: VoiceEngine;
  private readonly lease: () => Promise<() => void>;
  private readonly safety: SafetyCheck;
  private readonly signer: ConsentSigner;
  private readonly emit: (e: ServerEvent) => void;
  private readonly translate?: (lines: string[], from: string, to: string) => Promise<string[]>;
  private readonly device: () => string;
  private voices: StoredVoice[] = [];
  private readonly jobs = new Map<string, VoiceJob>();
  private readonly extra = new Map<string, JobExtra>();
  private readonly sessions = new Map<string, Session>();
  private running: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(opts: {
    dataDir: string;
    mediaDir: string;
    catalog: VoiceCatalog;
    models: VoiceModels;
    engine: VoiceEngine;
    /** Hold the GPU (the render scheduler's lease). */
    lease: () => Promise<() => void>;
    safety: SafetyCheck;
    signer: ConsentSigner;
    emit: (e: ServerEvent) => void;
    /** A local language model, for dubbing without a given translation. */
    translate?: (lines: string[], from: string, to: string) => Promise<string[]>;
    /** This computer's name, for the jobs it makes. */
    device?: () => string;
  }) {
    this.dir = join(opts.dataDir, 'voice');
    this.mediaDir = join(opts.mediaDir, 'voice');
    this.refs = join(this.dir, 'refs');
    for (const d of [this.dir, this.mediaDir, this.refs]) mkdirSync(d, { recursive: true });
    this.catalog = opts.catalog;
    this.models = opts.models;
    this.engine = opts.engine;
    this.lease = opts.lease;
    this.safety = opts.safety;
    this.signer = opts.signer;
    this.emit = opts.emit;
    this.translate = opts.translate;
    this.device = opts.device ?? (() => 'This computer');
    this.voices = this.read<StoredVoice[]>('library.json', []);
    for (const j of this.read<VoiceJob[]>('jobs.json', [])) {
      // Stopped with Hildegard: back in line, from the start.
      if (j.status === 'running' || j.status === 'queued')
        Object.assign(j, { status: 'queued', progress: null, startedAt: null } satisfies Partial<VoiceJob>);
      this.jobs.set(j.id, j);
    }
    this.renumber();
    queueMicrotask(() => this.pump());
  }

  // ── Storage ─────────────────────────────────────────────────────────────────────────────────────────────────

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private write(file: string, data: unknown) {
    const path = join(this.dir, file);
    writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  private saveLibrary() {
    this.write('library.json', this.voices);
    this.emit({ type: 'voices', voices: this.list() });
  }

  private saveJobs(now = false) {
    const go = () => {
      this.saveTimer = null;
      const all = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // The oldest finished jobs fall off; their files stay until the owner deletes them.
      while (all.length > MAX_JOBS) {
        const i = all.findIndex((j) => j.status !== 'queued' && j.status !== 'running' && !j.kept);
        if (i < 0) break;
        this.jobs.delete(all[i]!.id);
        all.splice(i, 1);
      }
      this.write('jobs.json', all);
    };
    if (now) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      go();
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(go, 500);
      this.saveTimer.unref();
    }
  }

  close() {
    this.closed = true;
    for (const x of this.extra.values()) x.abort.abort();
    this.saveJobs(true);
  }

  // ── The library ─────────────────────────────────────────────────────────────────────────────────────────────

  private builtin(b: BuiltinVoice): Voice {
    return {
      id: b.id,
      kind: 'builtin',
      name: b.name,
      language: b.language,
      accent: b.accent,
      gender: b.gender,
      blurb: b.blurb,
      uses: b.uses,
      model: b.model,
      models: [b.model],
      preview: existsSync(join(this.mediaDir, `p-${b.id}.wav`)) ? `/media/voice/p-${b.id}.wav` : null,
      createdAt: null,
      hue: voiceHue(b.id),
    };
  }

  /** Models that can speak in a voice, best first; those usable here come first. */
  private modelsFor(v: Voice): string[] {
    if (v.kind === 'builtin') return [v.model];
    const order =
      v.kind === 'designed'
        ? ['qwen3-tts-clone', 'chatterbox-multilingual', 'qwen3-tts-design']
        : ['chatterbox-multilingual', 'qwen3-tts-clone'];
    const known = order.filter((m) => this.catalog.models.some((x) => x.id === m));
    return [...known.filter((m) => this.models.usable(m)), ...known.filter((m) => !this.models.usable(m))];
  }

  private view(v: StoredVoice): Voice {
    const { ref: _r, refText: _t, cert: _c, ...shown } = v;
    const models = this.modelsFor(v);
    const out: Voice = { ...shown, models, model: models[0] ?? v.model };
    if (out.consent) out.consent = { ...out.consent, status: this.consentStatus(v) };
    return out;
  }

  private consentStatus(v: StoredVoice): 'active' | 'revoked' | 'expired' {
    if (!v.consent) return 'active';
    if (v.consent.status === 'revoked') return 'revoked';
    if (v.consent.until && Date.parse(v.consent.until) < Date.now()) return 'expired';
    return 'active';
  }

  list(): Voice[] {
    return [...this.catalog.voices.map((b) => this.builtin(b)), ...this.voices.map((v) => this.view(v))];
  }

  voice(voiceId: string): Voice {
    const v = this.list().find((x) => x.id === voiceId);
    if (!v)
      throw new VoiceError(
        404,
        'missing',
        `There’s no voice ${voiceId}. list_voices shows the ones there are.`,
      );
    return v;
  }

  private stored(voiceId: string): StoredVoice | undefined {
    return this.voices.find((x) => x.id === voiceId);
  }

  rename(voiceId: string, name: string): Voice {
    const v = this.stored(voiceId);
    if (!v) throw new VoiceError(404, 'missing', 'Built-in voices keep their names.');
    v.name = name;
    this.saveLibrary();
    return this.view(v);
  }

  /** Remove a designed voice, or a clone whose consent is already revoked; its certificate is kept on file. */
  remove(voiceId: string) {
    const v = this.stored(voiceId);
    if (!v) throw new VoiceError(404, 'missing', 'Built-in voices can’t be removed.');
    if (v.kind === 'clone' && this.consentStatus(v) === 'active')
      throw new VoiceError(
        409,
        'consent',
        'Revoke this voice’s consent first. Its certificate stays on file.',
      );
    if (v.cert) {
      mkdirSync(join(this.dir, 'revoked'), { recursive: true });
      writeFileSync(join(this.dir, 'revoked', `${v.id}.json`), JSON.stringify(v.cert, null, 2));
    }
    if (v.ref) rmSync(join(this.refs, v.ref), { force: true });
    this.voices = this.voices.filter((x) => x !== v);
    this.saveLibrary();
  }

  /** End a clone: its reference audio is deleted, so nothing more can be made in it. The record stays. */
  revoke(voiceId: string): Voice {
    const v = this.stored(voiceId);
    if (!v?.consent) throw new VoiceError(404, 'missing', 'Only cloned voices have consent to revoke.');
    if (v.ref) rmSync(join(this.refs, v.ref), { force: true });
    delete v.ref;
    delete v.refText;
    v.consent = { ...v.consent, status: 'revoked' };
    appendFileSync(
      join(this.dir, 'ledger.jsonl'),
      `${JSON.stringify({ at: now(), voice: v.id, event: 'revoked' })}\n`,
    );
    this.saveLibrary();
    return this.view(v);
  }

  /** Every use of a cloned voice, newest first. */
  uses(voiceId: string): VoiceUse[] {
    let lines: string[] = [];
    try {
      lines = readFileSync(join(this.dir, 'ledger.jsonl'), 'utf8').split('\n');
    } catch {}
    return lines
      .filter(Boolean)
      .map((l) => JSON.parse(l) as VoiceUse & { voice: string; event?: string })
      .filter((u) => u.voice === voiceId && !u.event)
      .map(({ voice: _v, ...u }) => u)
      .reverse();
  }

  private ledger(j: VoiceJob, voiceIds: string[]) {
    const ex = this.extra.get(j.id);
    for (const v of new Set(voiceIds)) {
      if (this.stored(v)?.kind !== 'clone') continue;
      const use = {
        at: now(),
        voice: v,
        job: j.id,
        kind: j.kind,
        title: j.title,
        by: j.source.kind === 'agent' ? j.source.name : 'Studio',
        seconds: j.seconds,
        sha256: ex?.sha256[0] ?? null,
      };
      appendFileSync(join(this.dir, 'ledger.jsonl'), `${JSON.stringify(use)}\n`);
    }
  }

  state(): VoiceState {
    const speech = this.engine.ready('speech');
    return {
      voices: this.list(),
      models: this.models.states(),
      jobs: [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100),
      device: this.device(),
      engine: {
        ready: speech,
        fake: this.engine.fake,
        problem: speech
          ? null
          : 'The voice engine isn’t installed on this computer yet. Run `hildegard voice install`.',
      },
    };
  }

  // ── Files ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Keep an uploaded recording, named by its SHA-256. */
  async upload(bytes: Uint8Array): Promise<{ name: string; url: string; seconds: number }> {
    const kind = sniffAudio(bytes);
    if (!kind) throw new VoiceError(415, 'type', 'Use a WAV, MP3, M4A, OGG, FLAC or WebM recording.');
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${kind}`;
    const path = join(this.mediaDir, name);
    if (!existsSync(path)) writeFileSync(path, bytes);
    const wav = await this.decoded(name);
    return { name, url: `/media/voice/${name}`, seconds: wav.seconds };
  }

  private uploadPath(name: string): string {
    if (!/^[a-f0-9]{64}\.(wav|mp3|m4a|ogg|flac|webm|mp4|mov)$/.test(name))
      throw new VoiceError(400, 'upload', 'That isn’t an uploaded recording.');
    const p = join(this.mediaDir, name);
    if (!existsSync(p))
      throw new VoiceError(404, 'upload', 'That recording isn’t here any more. Upload it again.');
    return p;
  }

  /** An upload as a mono 24 kHz WAV, which every environment reads. Made once, then kept. */
  private async decoded(name: string): Promise<{ wav: string; seconds: number; speech: number }> {
    const src = this.uploadPath(name);
    const wav = join(this.mediaDir, `d-${name.replace(/\.[a-z0-9]+$/, '')}.wav`);
    const meta = `${wav}.json`;
    if (existsSync(wav) && existsSync(meta)) return { wav, ...JSON.parse(readFileSync(meta, 'utf8')) };
    try {
      const r = await this.engine.call<{ seconds: number; speech: number }>('speech', 'decode', {
        path: src,
        out: wav,
        sampleRate: SR,
      });
      writeFileSync(meta, JSON.stringify({ seconds: r.seconds, speech: r.speech }));
      return { wav, seconds: r.seconds, speech: r.speech };
    } catch (e) {
      throw e instanceof VoiceEngineError && e.code === 'audio_unreadable'
        ? new VoiceError(415, 'audio', 'That recording couldn’t be read. Try a WAV or MP3.')
        : e;
    }
  }

  // ── Jobs ────────────────────────────────────────────────────────────────────────────────────────────────────

  private newJob(
    kind: VoiceJobKind,
    who: Who,
    fields: Partial<VoiceJob> & { title: string; model: string },
  ): VoiceJob {
    const j: VoiceJob = {
      id: id(),
      kind,
      status: 'queued',
      voice: null,
      source: who.source,
      priority: who.priority ?? (who.source.kind === 'agent' ? 'agent' : 'interactive'),
      queuePosition: null,
      progress: null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      ms: null,
      device: null,
      error: null,
      audio: [],
      seconds: null,
      segments: null,
      request: null,
      seed: null,
      kept: false,
      ...fields,
    };
    this.jobs.set(j.id, j);
    this.renumber();
    this.put(j);
    queueMicrotask(() => this.pump());
    return j;
  }

  private progressAt = 0;
  private put(j: VoiceJob, progress = false) {
    if (progress) {
      const t = Date.now();
      if (t - this.progressAt < 160) return;
      this.progressAt = t;
    }
    this.emit({ type: 'voice-job', job: j });
    this.saveJobs();
  }

  job(jobId: string): VoiceJob {
    const j = this.jobs.get(jobId);
    if (!j) throw new VoiceError(404, 'missing', 'No such voice job.');
    return j;
  }

  private queued(): VoiceJob[] {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
  }

  private renumber() {
    for (const [i, j] of this.queued().entries())
      if (j.queuePosition !== i + 1) {
        j.queuePosition = i + 1;
        this.emit({ type: 'voice-job', job: j });
      }
  }

  cancel(jobId: string): VoiceJob {
    const j = this.job(jobId);
    if (j.status === 'queued') {
      Object.assign(j, {
        status: 'canceled',
        queuePosition: null,
        finishedAt: now(),
      } satisfies Partial<VoiceJob>);
      this.renumber();
      this.put(j);
    } else if (j.status === 'running') this.extra.get(j.id)?.abort.abort();
    else throw new VoiceError(409, 'done', 'That job already finished.');
    return j;
  }

  keep(jobId: string, kept: boolean): VoiceJob {
    const j = this.job(jobId);
    j.kept = kept;
    this.put(j);
    return j;
  }

  /** Delete a finished job and its files. */
  delete(jobId: string) {
    const j = this.job(jobId);
    if (j.status === 'queued' || j.status === 'running')
      throw new VoiceError(409, 'running', 'Cancel it first.');
    for (const a of j.audio) rmSync(join(this.mediaDir, a.replace('/media/voice/', '')), { force: true });
    this.jobs.delete(jobId);
    this.saveJobs();
    this.emit({ type: 'voice-job', job: { ...j, status: 'canceled', audio: [] } });
  }

  private pump() {
    if (this.running || this.closed) return;
    const next = this.queued()[0];
    if (!next) return;
    this.running = next.id;
    void this.run(next).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async run(j: VoiceJob) {
    const abort = new AbortController();
    const ex: JobExtra = { abort, sha256: [] };
    this.extra.set(j.id, ex);
    // Waits for a video render on the GPU to finish; none starts until this job ends. The job shows as waiting.
    const release = await this.lease();
    if (j.status !== 'queued') {
      // Canceled while it waited.
      release();
      return;
    }
    Object.assign(j, {
      status: 'running',
      queuePosition: 0,
      startedAt: now(),
      device: this.device(),
      error: null,
    } satisfies Partial<VoiceJob>);
    this.renumber();
    this.put(j);
    const started = Date.now();
    try {
      const used = await this.perform(j, abort.signal);
      for (const a of j.audio) {
        const p = join(this.mediaDir, a.replace('/media/voice/', ''));
        if (existsSync(p)) ex.sha256.push(sha256File(p));
      }
      j.status = 'done';
      this.ledger(j, used);
    } catch (e) {
      j.status = abort.signal.aborted ? 'canceled' : 'failed';
      j.error = explainVoice(e);
    } finally {
      release();
      j.queuePosition = null;
      j.finishedAt = now();
      j.ms = Date.now() - started;
      this.put(j);
      this.saveJobs(true);
    }
  }

  private perform(j: VoiceJob, signal: AbortSignal): Promise<string[]> {
    const r = j.request as Record<string, unknown>;
    switch (j.kind) {
      case 'speak':
        return this.runSpeak(j, SpeakRequest.parse(r), signal);
      case 'design':
        return this.runDesign(j, DesignRequest.parse(r), signal).then(() => []);
      case 'convert':
        return this.runConvert(j, ConvertRequest.parse(r), signal);
      case 'transcribe':
        return this.runTranscribe(j, TranscribeRequest.parse(r), signal).then(() => []);
      case 'dub':
        return this.runDub(j, DubRequest.parse(r), signal);
      case 'clone-check':
        return this.runCheck(j, String(r.session), signal).then(() => []);
    }
  }

  private progress(j: VoiceJob, done: number, total: number) {
    j.progress = { done, total };
    this.put(j, true);
  }

  // ── Speaking ────────────────────────────────────────────────────────────────────────────────────────────────

  private catalogModel(modelId: string): VoiceModel {
    const m = this.catalog.models.find((x) => x.id === modelId);
    if (!m) throw new VoiceError(404, 'model', `There’s no voice model ${modelId}.`);
    return m;
  }

  /** The model a voice speaks with, and how the worker should hear the voice. */
  private speaker(
    voiceId: string,
    want: string | undefined,
    language: string,
  ): { model: VoiceModel; spec: Record<string, string>; voice: Voice } {
    const v = this.voice(voiceId);
    const s = this.stored(voiceId);
    if (s?.kind === 'clone') {
      const st = this.consentStatus(s);
      if (st !== 'active')
        throw new VoiceError(
          410,
          'consent',
          st === 'revoked'
            ? `${s.name}’s consent was revoked, so Hildegard won’t speak in this voice.`
            : `${s.name}’s consent ended on ${s.consent!.until?.slice(0, 10)}. Ask them to record consent again.`,
        );
    }
    if (want && !v.models.includes(want))
      throw new VoiceError(
        400,
        'model',
        `${v.name} can’t speak with that model. It can with ${v.models.join(' or ')}.`,
      );
    const modelId = want ?? v.models.find((m) => this.models.usable(m)) ?? v.models[0]!;
    const model = this.catalogModel(modelId);
    if (!this.models.usable(model.id))
      throw new VoiceError(
        409,
        'model_missing',
        `${model.name} isn’t installed on this computer. Install it in Voice › Models, then try again.`,
      );
    if (!model.languages.includes(language)) {
      const alt = this.catalog.models.find((m) => m.can.includes('speak') && m.languages.includes(language));
      throw new VoiceError(
        400,
        'language',
        `${model.name} doesn’t speak ${language}.${alt ? ` ${alt.name} does.` : ''}`,
      );
    }
    let spec: Record<string, string>;
    if (v.kind === 'builtin') {
      const b = this.catalog.voices.find((x) => x.id === v.id)!;
      spec = b.preset === 'default' ? { kind: 'default' } : { kind: 'preset', name: b.preset };
    } else if (model.can.includes('design') && !model.can.includes('clone')) {
      spec = { kind: 'design', description: s?.description ?? '' };
    } else {
      if (!s?.ref || !existsSync(join(this.refs, s.ref)))
        throw new VoiceError(410, 'consent', `${v.name} has no reference audio any more.`);
      spec = { kind: 'clone', ref: join(this.refs, s.ref), ...(s.refText ? { refText: s.refText } : {}) };
    }
    return { model, spec, voice: v };
  }

  private checkWords(text: string) {
    const v = this.safety.text(text);
    if (!v.ok)
      throw new VoiceError(
        400,
        'content_blocked',
        'Hildegard doesn’t make sexual content, so it won’t say this.',
      );
  }

  /** Queue speech. Checks everything it can now, so a mistake comes back at once rather than as a failed job. */
  speak(body: unknown, who: Who): VoiceJob {
    const req = SpeakRequest.parse(body);
    this.checkWords(req.paragraphs.map((p) => spokenText(p.text, this.catalog.tags)).join('\n'));
    const voices = new Set(req.paragraphs.map((p) => p.voice ?? req.voice));
    let model = '';
    for (const v of voices) {
      const sp = this.speaker(
        v,
        v === req.voice ? req.model : undefined,
        req.language ?? this.voice(v).language,
      );
      if (!model) model = sp.model.id;
    }
    const seed = req.seed ?? randomInt(2 ** 31);
    const first = req.paragraphs[0]!.text;
    return this.newJob('speak', who, {
      title: req.title ?? titleOf(spokenText(first, this.catalog.tags)),
      voice: req.voice,
      model,
      request: { ...req, seed },
      seed,
    });
  }

  private async runSpeak(j: VoiceJob, req: SpeakRequest, signal: AbortSignal): Promise<string[]> {
    // Paragraphs in a row with the same voice are spoken in one go.
    const runs: Array<{ voice: string; paragraphs: SpeakRequest['paragraphs'] }> = [];
    for (const p of req.paragraphs) {
      const v = p.voice ?? req.voice;
      const last = runs[runs.length - 1];
      if (last?.voice === v) last.paragraphs.push(p);
      else runs.push({ voice: v, paragraphs: [p] });
    }
    const plan = runs.map((r) => {
      const language = req.language ?? this.voice(r.voice).language;
      const sp = this.speaker(r.voice, r.voice === req.voice ? req.model : undefined, language);
      const counts: number[] = [];
      const segments = r.paragraphs.flatMap((p) => {
        const segs = compileParagraph({ text: p.text, direction: p.direction, language }, this.catalog.tags);
        counts.push(segs.length);
        return segs.map((s) => this.workerSegment(sp.model, req, s));
      });
      return { ...sp, segments, counts };
    });
    const total = plan.reduce((n, p) => n + p.segments.length, 0);
    if (!total)
      throw new VoiceError(400, 'empty', 'There’s nothing to say: the script is only tags and pauses.');
    const out = join(this.mediaDir, `${j.id}.wav`);
    const parts: Array<{ path: string; seconds: number }> = [];
    const marks: Array<{ start: number; end: number }> = [];
    let done = 0;
    let at = 0;
    for (const [i, p] of plan.entries()) {
      const path = plan.length === 1 ? out : join(this.mediaDir, `${j.id}.part${i}.wav`);
      const r = await this.engine.call<{ seconds: number; segments: Array<{ start: number; end: number }> }>(
        p.model.env,
        'speak',
        {
          model: { engine: p.model.engine, dir: this.models.dirOf(p.model.id) },
          voice: p.spec,
          segments: p.segments,
          settings: engineSettings(p.model, req.settings),
          seed: (req.seed ?? 0) + done,
          out: path,
          title: j.title,
          comment: `Made with Hildegard. AI-generated speech. Voice ${p.voice.id}, job ${j.id}.`,
        },
        { signal, onProgress: (x) => this.progress(j, done + x.done, total) },
      );
      // Paragraph marks from segment marks.
      let k = 0;
      for (const n of p.counts) {
        const seg = r.segments.slice(k, k + n);
        k += n;
        if (seg.length) marks.push({ start: at + seg[0]!.start, end: at + seg[seg.length - 1]!.end });
        else marks.push({ start: at, end: at });
      }
      parts.push({ path, seconds: r.seconds });
      at += r.seconds;
      done += p.segments.length;
    }
    if (parts.length > 1) {
      let t = 0;
      const lines = parts.map((p) => {
        const line = { start: t, seconds: p.seconds, path: p.path };
        t += p.seconds;
        return line;
      });
      await this.engine.call('speech', 'dub', { lines, out, sampleRate: SR, title: j.title }, { signal });
      for (const p of parts) rmSync(p.path, { force: true });
    }
    Object.assign(j, {
      audio: [`/media/voice/${j.id}.wav`],
      seconds: Math.round(at * 1000) / 1000,
      segments: marks,
      progress: { done: total, total },
    } satisfies Partial<VoiceJob>);
    return plan.map((p) => p.voice.id);
  }

  private workerSegment(model: VoiceModel, req: SpeakRequest, s: Segment) {
    const seg: Record<string, unknown> = { text: s.text, language: s.language };
    if (s.instruct && model.controls.includes('direction')) seg.instruct = s.instruct;
    if (s.pause) seg.pause = s.pause;
    if (s.lift && model.engine === 'chatterbox') seg.settings = engineSettings(model, req.settings, s.lift);
    return seg;
  }

  /** A short clip of a voice, made once and kept. */
  preview(voiceId: string, who: Who): VoiceJob | { audio: string } {
    const v = this.voice(voiceId);
    const file = join(this.mediaDir, `p-${v.id}.wav`);
    if (existsSync(file)) return { audio: `/media/voice/p-${v.id}.wav` };
    const job = this.speak(
      { paragraphs: [{ text: PREVIEW_LINE }], voice: v.id, seed: 7, title: `${v.name} preview` },
      who,
    );
    // Copied into place once done; see whenDone.
    void this.whenDone(job.id).then((d) => {
      const src = d.audio[0] ? join(this.mediaDir, d.audio[0].replace('/media/voice/', '')) : null;
      if (d.status === 'done' && src && existsSync(src)) {
        copyFileSync(src, file);
        this.saveLibrary();
      }
    });
    return job;
  }

  /** Resolves when a job finishes, however it does. */
  whenDone(jobId: string, timeoutMs = 30 * 60_000): Promise<VoiceJob> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const look = () => {
        const j = this.jobs.get(jobId);
        if (!j || (j.status !== 'queued' && j.status !== 'running') || Date.now() - t0 > timeoutMs)
          return resolve(j ?? ({ status: 'canceled', audio: [] } as unknown as VoiceJob));
        setTimeout(look, 100).unref();
      };
      look();
    });
  }

  // ── Designing ───────────────────────────────────────────────────────────────────────────────────────────────

  design(body: unknown, who: Who): VoiceJob {
    const req = DesignRequest.parse(body);
    this.checkWords(`${req.description}\n${req.text}`);
    const m = this.catalog.models.find((x) => x.can.includes('design'));
    if (!m || !this.models.usable(m.id))
      throw new VoiceError(
        409,
        'model_missing',
        `Designing voices needs ${m?.name ?? 'Qwen3-TTS VoiceDesign'}. Install it in Voice › Models, then try again.`,
      );
    if (!m.languages.includes(req.language))
      throw new VoiceError(400, 'language', `${m.name} doesn’t speak ${req.language}.`);
    const seed = req.seed ?? randomInt(2 ** 31);
    return this.newJob('design', who, {
      title: titleOf(req.description),
      model: m.id,
      request: { ...req, seed },
      seed,
    });
  }

  private async runDesign(j: VoiceJob, req: DesignRequest, signal: AbortSignal) {
    const m = this.catalogModel(j.model);
    const audio: string[] = [];
    for (let i = 0; i < req.candidates; i++) {
      const name = `${j.id}-${i + 1}.wav`;
      await this.engine.call(
        m.env,
        'speak',
        {
          model: { engine: m.engine, dir: this.models.dirOf(m.id) },
          voice: { kind: 'design', description: req.description },
          segments: [{ text: req.text, language: req.language }],
          settings: {},
          seed: (req.seed ?? 0) + i,
          out: join(this.mediaDir, name),
          title: `${j.title}, candidate ${i + 1}`,
          comment: `Made with Hildegard. AI-generated speech. Designed voice, job ${j.id}.`,
        },
        { signal },
      );
      audio.push(`/media/voice/${name}`);
      j.audio = [...audio];
      this.progress(j, i + 1, req.candidates);
    }
  }

  /** Keep one of a design job's candidates as a voice in the library. */
  keepDesign(jobId: string, candidate: number, name: string): Voice {
    const j = this.job(jobId);
    if (j.kind !== 'design' || j.status !== 'done')
      throw new VoiceError(409, 'job', 'That isn’t a finished design.');
    const src = j.audio[candidate - 1];
    if (!src) throw new VoiceError(400, 'candidate', 'There’s no such candidate.');
    const req = DesignRequest.parse(j.request);
    const vid = `designed-${id()}`;
    copyFileSync(join(this.mediaDir, src.replace('/media/voice/', '')), join(this.refs, `${vid}.wav`));
    copyFileSync(join(this.refs, `${vid}.wav`), join(this.mediaDir, `p-${vid}.wav`));
    const v: StoredVoice = {
      id: vid,
      kind: 'designed',
      name,
      language: req.language,
      accent: null,
      gender: null,
      blurb: req.description,
      uses: [],
      model: 'qwen3-tts-clone',
      models: [],
      preview: `/media/voice/p-${vid}.wav`,
      createdAt: now(),
      description: req.description,
      hue: voiceHue(vid),
      ref: `${vid}.wav`,
      refText: req.text,
    };
    this.voices.push(v);
    this.saveLibrary();
    return this.view(v);
  }

  // ── Speech to speech, transcripts and dubbing ───────────────────────────────────────────────────────────────

  convert(body: unknown, who: Who): VoiceJob {
    const req = ConvertRequest.parse(body);
    this.uploadPath(req.source);
    const m = this.catalog.models.find((x) => x.can.includes('convert'));
    if (!m || !this.models.usable(m.id))
      throw new VoiceError(
        409,
        'model_missing',
        `Changing one voice into another needs ${m?.name ?? 'Chatterbox'}. Install it in Voice › Models, then try again.`,
      );
    const v = this.voice(req.voice);
    if (v.kind === 'clone') this.speaker(v.id, undefined, v.language);
    return this.newJob('convert', who, {
      title: req.title ?? `In ${v.name}’s voice`,
      voice: v.id,
      model: m.id,
      request: req,
    });
  }

  /** A reference clip for any voice: a clone's or design's own, or a built-in voice reading a line, made once. */
  private async refFor(voiceId: string, signal: AbortSignal): Promise<string> {
    const s = this.stored(voiceId);
    if (s) {
      if (!s.ref || !existsSync(join(this.refs, s.ref)))
        throw new VoiceError(410, 'consent', `${s.name} has no reference audio any more.`);
      return join(this.refs, s.ref);
    }
    const file = join(this.refs, `builtin-${voiceId}.wav`);
    if (existsSync(file)) return file;
    const v = this.voice(voiceId);
    const { model, spec } = this.speaker(v.id, undefined, v.language);
    await this.engine.call(
      model.env,
      'speak',
      {
        model: { engine: model.engine, dir: this.models.dirOf(model.id) },
        voice: spec,
        segments: [
          { text: PREVIEW_LINE, language: v.language },
          { text: 'I speak clearly, at an even pace.', language: v.language },
        ],
        settings: engineSettings(model, { speed: 1, expressiveness: 0.5, stability: 0.5, variety: 0.5 }),
        seed: 7,
        out: file,
      },
      { signal },
    );
    return file;
  }

  private async runConvert(j: VoiceJob, req: ConvertRequest, signal: AbortSignal): Promise<string[]> {
    const m = this.catalogModel(j.model);
    const src = await this.decoded(req.source);
    const ref = await this.refFor(req.voice, signal);
    const r = await this.engine.call<{ seconds: number }>(
      m.env,
      'convert',
      {
        model: { engine: m.engine, dir: this.models.dirOf(m.id) },
        source: src.wav,
        ref,
        out: join(this.mediaDir, `${j.id}.wav`),
        title: j.title,
        comment: `Made with Hildegard. AI-generated speech. Voice ${req.voice}, job ${j.id}.`,
      },
      { signal },
    );
    Object.assign(j, { audio: [`/media/voice/${j.id}.wav`], seconds: r.seconds } satisfies Partial<VoiceJob>);
    return [req.voice];
  }

  private transcriber(): VoiceModel {
    const t =
      this.catalog.models.find((m) => m.id === TRANSCRIBER) ??
      this.catalog.models.find((m) => m.can.includes('transcribe'));
    if (!t || !this.models.usable(t.id))
      throw new VoiceError(
        409,
        'model_missing',
        `Transcribing needs ${t?.name ?? 'Whisper'}. Install it in Voice › Models, then try again.`,
      );
    return t;
  }

  transcribe(body: unknown, who: Who): VoiceJob {
    const req = TranscribeRequest.parse(body);
    this.uploadPath(req.source);
    const t = this.transcriber();
    return this.newJob('transcribe', who, { title: req.title ?? 'Transcript', model: t.id, request: req });
  }

  private async hear(
    path: string,
    language: string | undefined,
    signal: AbortSignal,
    expect?: string,
  ): Promise<Transcript> {
    const t = this.transcriber();
    return this.engine.call<Transcript>(
      t.env,
      'transcribe',
      {
        model: { engine: t.engine, dir: this.models.dirOf(t.id) },
        path,
        language: language ?? null,
        words: true,
        // Only the stand-in engine reads this, to "hear" what was asked for in tests and --fake-gpu.
        ...(this.engine.fake && expect ? { expect } : {}),
      },
      { signal },
    );
  }

  private async runTranscribe(j: VoiceJob, req: TranscribeRequest, signal: AbortSignal) {
    const src = await this.decoded(req.source);
    j.transcript = await this.hear(src.wav, req.language, signal);
    j.seconds = j.transcript.seconds;
  }

  dub(body: unknown, who: Who): VoiceJob {
    const req = DubRequest.parse(body);
    this.uploadPath(req.source);
    const v = this.voice(req.voice);
    const sp = this.speaker(v.id, undefined, req.language);
    if (!req.lines) this.transcriber();
    if (req.lines) this.checkWords(req.lines.map((l) => l.text).join('\n'));
    return this.newJob('dub', who, {
      title: req.title ?? `Dub into ${req.language}`,
      voice: v.id,
      model: sp.model.id,
      request: req,
    });
  }

  private async runDub(j: VoiceJob, req: DubRequest, signal: AbortSignal): Promise<string[]> {
    const src = await this.decoded(req.source);
    let lines = req.lines;
    if (!lines) {
      const heard = await this.hear(src.wav, undefined, signal);
      j.transcript = heard;
      let texts = heard.segments.map((s) => s.text.trim());
      if (heard.language !== req.language) {
        if (!this.translate)
          throw new VoiceError(
            409,
            'translate',
            'Give the translated lines, or start a local language model (Settings › Local models) to translate them.',
          );
        texts = await this.translate(texts, heard.language, req.language);
      }
      lines = heard.segments.map((s, i) => ({ start: s.start, end: s.end, text: texts[i] ?? s.text }));
      this.checkWords(lines.map((l) => l.text).join('\n'));
    }
    const { model, spec } = this.speaker(req.voice, undefined, req.language);
    const parts: Array<{ start: number; seconds: number; path: string }> = [];
    for (const [i, l] of lines.entries()) {
      const path = join(this.mediaDir, `${j.id}.line${i}.wav`);
      await this.engine.call(
        model.env,
        'speak',
        {
          model: { engine: model.engine, dir: this.models.dirOf(model.id) },
          voice: spec,
          segments: [{ text: l.text, language: req.language }],
          settings: engineSettings(model, { speed: 1, expressiveness: 0.5, stability: 0.5, variety: 0.3 }),
          seed: i,
          out: path,
        },
        { signal },
      );
      parts.push({ start: l.start, seconds: Math.max(0.3, l.end - l.start), path });
      this.progress(j, i + 1, lines.length + 1);
    }
    const r = await this.engine.call<{ seconds: number }>(
      'speech',
      'dub',
      {
        bed: src.wav,
        lines: parts,
        out: join(this.mediaDir, `${j.id}.wav`),
        sampleRate: SR,
        title: j.title,
        comment: `Made with Hildegard. AI-generated speech. Voice ${req.voice}, job ${j.id}.`,
      },
      { signal },
    );
    for (const p of parts) rmSync(p.path, { force: true });
    Object.assign(j, {
      audio: [`/media/voice/${j.id}.wav`],
      seconds: r.seconds,
      segments: lines.map((l) => ({ start: l.start, end: l.end })),
    } satisfies Partial<VoiceJob>);
    return [req.voice];
  }

  /** Whether Hildegard made a recording: its watermark, and the exact file when it was made here. */
  async isOurs(name: string): Promise<MarkCheck> {
    const raw = this.uploadPath(name);
    const sha = sha256File(raw);
    const src = await this.decoded(name);
    const { score } = await this.engine.call<{ score: number }>('speech', 'mark', { path: src.wav });
    let job: MarkCheck['job'] = null;
    for (const [jid, ex] of this.extra) {
      const j = this.jobs.get(jid);
      if (j && ex.sha256.includes(sha))
        job = { id: j.id, title: j.title, voice: j.voice, createdAt: j.createdAt };
    }
    if (!job) {
      try {
        for (const l of readFileSync(join(this.dir, 'ledger.jsonl'), 'utf8').split('\n')) {
          if (!l.includes(sha)) continue;
          const u = JSON.parse(l) as VoiceUse & { voice: string };
          job = { id: u.job, title: u.title, voice: u.voice, createdAt: u.at };
        }
      } catch {}
    }
    const marked = this.catalog.consent.markedAbove;
    return {
      score: Math.round(score * 1000) / 1000,
      verdict: job || score >= 0.8 ? 'ours' : score >= marked ? 'likely' : 'no',
      job,
    };
  }

  // ── Consent ─────────────────────────────────────────────────────────────────────────────────────────────────

  private sessionView(s: Session, link: string | null = null): ConsentSessionView {
    return {
      id: s.id,
      speaker: s.speaker,
      relation: s.relation,
      language: s.language,
      line: s.line.text,
      expiresAt: new Date(s.expiresAt).toISOString(),
      link,
      recording: s.recording
        ? { url: `/media/voice/${s.recording.name}`, seconds: s.recording.seconds, via: s.recording.via }
        : null,
      samples: s.samples.map((x) => ({ name: x.name, url: `/media/voice/${x.name}`, seconds: x.seconds })),
      checking: s.checking,
      check: s.check,
      voice: s.voice,
    };
  }

  private changed(s: Session) {
    this.emit({ type: 'consent', session: this.sessionView(s) });
  }

  /** Start a clone: a fresh consent line for this speaker. `link` is where they can record it on their own phone. */
  startConsent(body: unknown, base: string | null): ConsentSessionView & { token: string | null } {
    const b = z
      .object({
        speaker: z.string().trim().min(1, 'Whose voice is it?').max(60),
        relation: z.enum(['self', 'agreed', 'licensed']),
        language: z
          .string()
          .regex(/^[a-z]{2}$/)
          .default('en'),
        until: z.string().datetime().nullable().default(null),
      })
      .strict()
      .parse(body);
    const clone = this.catalog.models.find((m) => m.can.includes('clone') && this.models.usable(m.id));
    if (!clone)
      throw new VoiceError(
        409,
        'model_missing',
        'Cloning needs Chatterbox or Qwen3-TTS Base. Install one in Voice › Models, then try again.',
      );
    this.transcriber();
    const s: Session = {
      id: id(),
      token: newToken(),
      speaker: b.speaker,
      relation: b.relation,
      language: b.language,
      until: b.until,
      line: consentLine(b.speaker),
      expiresAt: Date.now() + this.catalog.consent.phraseMinutes * 60_000,
      recording: null,
      samples: [],
      checking: false,
      check: null,
      ref: null,
      voice: null,
    };
    this.sessions.set(s.id, s);
    for (const [k, old] of this.sessions) if (old.expiresAt + FINISH_MS < Date.now()) this.sessions.delete(k);
    const link = base ? `${base}/#/consent/${s.token}` : null;
    return { ...this.sessionView(s, link), token: base ? s.token : null };
  }

  session(sessionId: string): ConsentSessionView {
    return this.sessionView(this.mustSession(sessionId));
  }

  private mustSession(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new VoiceError(404, 'consent', 'That consent session isn’t here any more. Start again.');
    return s;
  }

  /** What the speaker's phone sees through the link: their name and the line. Nothing else. */
  byToken(token: string): { speaker: string; line: string; expiresAt: string; recorded: boolean } {
    const s = [...this.sessions.values()].find((x) => x.token === token);
    if (!s || s.expiresAt < Date.now())
      throw new VoiceError(410, 'expired', 'This consent link has expired. Ask for a new one.');
    return {
      speaker: s.speaker,
      line: s.line.text,
      expiresAt: new Date(s.expiresAt).toISOString(),
      recorded: !!s.recording,
    };
  }

  /** The speaker reading the consent line, recorded just now in the Studio or on their phone. */
  async record(ref: { session: string } | { token: string }, bytes: Uint8Array): Promise<ConsentSessionView> {
    const s =
      'session' in ref
        ? this.mustSession(ref.session)
        : [...this.sessions.values()].find((x) => x.token === ref.token);
    if (!s) throw new VoiceError(410, 'expired', 'This consent link has expired. Ask for a new one.');
    if (s.expiresAt < Date.now())
      throw new VoiceError(410, 'expired', 'The consent line expired. Start again for a fresh one.');
    if (s.voice) throw new VoiceError(409, 'done', 'This voice is already made.');
    const kind = sniffAudio(bytes);
    if (!kind) throw new VoiceError(415, 'type', 'That recording couldn’t be read.');
    const raw = `c-${s.id}-raw.${kind}`;
    writeFileSync(join(this.mediaDir, raw), bytes);
    const wav = `c-${s.id}.wav`;
    const r = await this.engine.call<{ seconds: number }>('speech', 'decode', {
      path: join(this.mediaDir, raw),
      out: join(this.mediaDir, wav),
      sampleRate: SR,
    });
    s.recording = {
      name: wav,
      wav: join(this.mediaDir, wav),
      seconds: r.seconds,
      via: 'session' in ref ? 'here' : 'link',
      at: now(),
    };
    s.check = null;
    this.changed(s);
    return this.sessionView(s);
  }

  /** Samples to clone from: uploads, or more recordings. They must be the voice that gave consent. */
  async addSamples(sessionId: string, names: string[]): Promise<ConsentSessionView> {
    const s = this.mustSession(sessionId);
    if (s.voice) throw new VoiceError(409, 'done', 'This voice is already made.');
    for (const name of names) {
      if (s.samples.some((x) => x.name === name)) continue;
      const d = await this.decoded(name);
      s.samples.push({ name, wav: d.wav, seconds: d.speech || d.seconds });
    }
    s.check = null;
    this.changed(s);
    return this.sessionView(s);
  }

  removeSample(sessionId: string, name: string): ConsentSessionView {
    const s = this.mustSession(sessionId);
    s.samples = s.samples.filter((x) => x.name !== name);
    s.check = null;
    this.changed(s);
    return this.sessionView(s);
  }

  /** Check the consent recording and samples. Only the Studio does this: agents never start a clone. */
  check(sessionId: string): VoiceJob {
    const s = this.mustSession(sessionId);
    if (!s.recording)
      throw new VoiceError(409, 'recording', `Record ${s.speaker} reading the consent line first.`);
    if (s.checking) throw new VoiceError(409, 'checking', 'It’s being checked now.');
    s.checking = true;
    s.check = null;
    this.changed(s);
    return this.newJob(
      'clone-check',
      { source: { kind: 'studio' }, priority: 'forced' },
      {
        title: `Consent check for ${s.speaker}`,
        model: TRANSCRIBER,
        request: { session: s.id },
      },
    );
  }

  private async runCheck(j: VoiceJob, sessionId: string, signal: AbortSignal) {
    const s = this.mustSession(sessionId);
    const rules = this.catalog.consent;
    try {
      const rec = s.recording!;
      const why: string[] = [];
      // Not made by AI: Hildegard's own watermark, which every clip it speaks carries.
      const mark = await this.engine.call<{ score: number }>('speech', 'mark', { path: rec.wav }, { signal });
      const live = { ok: mark.score < rules.markedAbove, score: Math.round(mark.score * 1000) / 1000 };
      if (!live.ok) why.push('The consent recording was made by AI, not read aloud by a person.');
      this.progress(j, 1, 4);
      // The line, heard.
      const t = await this.hear(rec.wav, s.language, signal, s.line.text);
      const text = t.segments
        .map((x) => x.text)
        .join(' ')
        .trim();
      const h = heardLine(s.line, text);
      const heard = {
        ok: h.score >= rules.phraseMatch && h.missing.length === 0,
        text,
        score: Math.round(h.score * 1000) / 1000,
        missing: h.missing,
      };
      if (!heard.ok)
        why.push(
          h.missing.length
            ? `The consent line wasn’t heard: “${h.missing.join('”, “')}” ${h.missing.length === 1 ? 'is' : 'are'} missing. Read the whole line, clearly.`
            : 'The consent line wasn’t heard clearly. Read it again, word for word.',
        );
      this.progress(j, 2, 4);
      // Samples marked by AI can't be cloned from either.
      for (const x of s.samples) {
        const m = await this.engine.call<{ score: number }>('speech', 'mark', { path: x.wav }, { signal });
        if (m.score >= rules.markedAbove)
          why.push(`${x.name.slice(0, 8)}… was made by AI. Use recordings of the person.`);
      }
      // Same person throughout.
      const enc = this.models.encoderPath();
      if (!existsSync(enc))
        throw new VoiceError(
          409,
          'model_missing',
          'The speaker check isn’t installed. Reinstall the cloning model.',
        );
      const { embeddings } = await this.engine.call<{ embeddings: number[][] }>(
        'speech',
        'embed',
        { model: { engine: 'speaker', dir: enc }, paths: [rec.wav, ...s.samples.map((x) => x.wav)] },
        { signal },
      );
      const scores = embeddings.slice(1).map((e) => Math.round(cosine(embeddings[0]!, e) * 1000) / 1000);
      const lowest = scores.length ? Math.min(...scores) : 1;
      const speaker = { ok: lowest >= rules.sameSpeaker, scores, lowest };
      if (!speaker.ok)
        why.push(`These clips aren’t from the person who gave consent. Use recordings of ${s.speaker} only.`);
      this.progress(j, 3, 4);
      const seconds = rec.seconds + s.samples.reduce((n, x) => n + x.seconds, 0);
      const length = {
        ok: seconds >= rules.quickSeconds,
        seconds: Math.round(seconds * 10) / 10,
        need: rules.quickSeconds,
      };
      if (!length.ok)
        why.push(
          `That’s ${length.seconds} seconds of speech. Add samples until there are ${rules.quickSeconds} or more.`,
        );
      const ok = live.ok && heard.ok && speaker.ok && length.ok && why.length === 0;
      s.check = { ok, heard, live, speaker, length, why };
      if (ok) {
        // The reference: the longest sample, or the consent recording itself.
        const best = [...s.samples].sort((a, b) => b.seconds - a.seconds)[0];
        const wav = best && best.seconds >= rec.seconds ? best.wav : rec.wav;
        const refText =
          wav === rec.wav
            ? text
            : (await this.hear(wav, s.language, signal)).segments
                .map((x) => x.text)
                .join(' ')
                .trim();
        s.ref = { wav, text: refText };
      }
      this.progress(j, 4, 4);
    } finally {
      s.checking = false;
      this.changed(s);
    }
  }

  /** Make the voice from a passed check, with a signed certificate. */
  finish(sessionId: string, name: string): Voice {
    const s = this.mustSession(sessionId);
    if (s.voice) return this.voice(s.voice);
    if (!s.check?.ok || !s.ref || !s.recording)
      throw new VoiceError(409, 'check', 'The consent check hasn’t passed, so this voice can’t be made.');
    if (s.expiresAt + FINISH_MS < Date.now())
      throw new VoiceError(410, 'expired', 'This check is over an hour old. Start again.');
    const vid = `clone-${id()}`;
    copyFileSync(s.ref.wav, join(this.refs, `${vid}.wav`));
    const cert = this.signer.sign({
      voice: vid,
      speaker: s.speaker,
      relation: s.relation,
      line: s.line.text,
      via: s.recording.via,
      recordedAt: s.recording.at,
      until: s.until,
      consentSha256: sha256File(s.recording.wav),
      samplesSha256: s.samples.map((x) => sha256File(x.wav)),
      match: s.check.speaker.lowest,
      heard: s.check.heard.score,
    });
    const v: StoredVoice = {
      id: vid,
      kind: 'clone',
      name,
      language: s.language,
      accent: null,
      gender: null,
      blurb: `${s.speaker}’s voice, with their recorded consent.`,
      uses: [],
      model: 'chatterbox-multilingual',
      models: [],
      preview: null,
      createdAt: now(),
      hue: voiceHue(vid),
      ref: `${vid}.wav`,
      refText: s.ref.text,
      cert,
      consent: {
        speaker: s.speaker,
        relation: s.relation,
        status: 'active',
        recordedAt: s.recording.at,
        recording: `/media/voice/${s.recording.name}`,
        match: s.check.speaker.lowest,
        until: s.until,
        certificate: JSON.stringify(cert),
      },
    };
    this.voices.push(v);
    s.voice = vid;
    this.saveLibrary();
    this.changed(s);
    return this.view(v);
  }

  /** What an engine environment a model needs. */
  envOf(modelId: string): VoiceEnv {
    return this.catalogModel(modelId).env;
  }
}

/** A short title from the first words. */
function titleOf(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').slice(0, 7).join(' ');
  return (words.length < clean.length ? `${words}…` : words) || 'Untitled';
}

const HINTS: Record<string, string> = {
  out_of_memory: 'Close other apps using the GPU, or choose a smaller model, then retry.',
  model_missing: 'Install the model in Voice › Models, then retry.',
  not_installed: 'Run `hildegard voice install`, then retry.',
  audio_unreadable: 'Try a WAV or MP3 recording.',
  unsupported: 'Choose another model for this.',
  content_blocked: 'Change the script. Hildegard doesn’t make sexual content.',
  consent: 'Ask the speaker to record consent again.',
  canceled: 'Retry when you want it.',
};

export function explainVoice(e: unknown): NonNullable<VoiceJob['error']> {
  if (e instanceof VoiceError || e instanceof VoiceEngineError) {
    const detail = e instanceof VoiceEngineError ? e.detail : '';
    return {
      code: e.code,
      message: e.message,
      hint: HINTS[e.code] ?? 'Retry. If it fails again, the details say what happened.',
      ...(detail ? { detail } : {}),
    };
  }
  if (e instanceof z.ZodError)
    return {
      code: 'bad_request',
      message: e.issues[0]?.message ?? 'That request isn’t right.',
      hint: 'Fix it and retry.',
    };
  return {
    code: 'engine_failed',
    message: 'Something went wrong in the voice engine.',
    hint: 'Retry. If it fails again, the details say what happened.',
    detail: String((e as Error)?.message ?? e),
  };
}

/** Translation through a local language model, for dubbing. */
export function llmTranslator(llm: Pick<LocalModels, 'pick' | 'chat'>, jsonFrom: (s: string) => unknown) {
  return async (lines: string[], from: string, to: string): Promise<string[]> => {
    const ask = async () => {
      const { endpoint, model } = await llm.pick();
      return llm.chat(endpoint, {
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You translate dialogue for dubbing. Keep each line about as long to say as the original. Answer with JSON only: {"lines": [string, ...]}, one per input line, in order.',
          },
          { role: 'user', content: JSON.stringify({ from, to, lines }) },
        ],
      });
    };
    const msg = await ask().catch((e: Error) => {
      throw new VoiceError(409, 'translate', `${e.message} Or give the translated lines yourself.`);
    });
    const out = (jsonFrom(msg.content ?? '') as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(out) || out.length !== lines.length || !out.every((x) => typeof x === 'string'))
      throw new VoiceError(
        409,
        'translate',
        'The local model didn’t translate every line. Give the lines yourself.',
      );
    return out as string[];
  };
}
