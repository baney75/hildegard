// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice tools: speech in the owner's voices, designed voices, speech to speech, transcripts, dubbing and the watermark
 * check. Agents can use any voice in the library, cloned ones included, and every use is written down for the person
 * whose voice it is. Agents can never clone a voice: that takes the person, reading a fresh consent line aloud.
 */
import { readFile } from 'node:fs/promises';
import type { VoiceJob, VoiceState } from '@hildegard/presets';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError, type VoiceJobDetail } from './client.ts';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });
const DONE: VoiceJob['status'][] = ['done', 'failed', 'canceled'];

const source = {
  source_path: z
    .string()
    .optional()
    .describe(
      'Absolute path to a recording (WAV, MP3, M4A, OGG, FLAC or WebM) on the computer Hildegard runs on.',
    ),
  source_data: z
    .string()
    .max(140_000_000)
    .optional()
    .describe(
      'The recording itself, as base64, when it isn’t on the computer Hildegard runs on. Up to 100 MB.',
    ),
};
const wait = z
  .boolean()
  .optional()
  .describe('Wait for it to finish (up to 10 minutes) and return the result. Default true.');
const lang = z
  .string()
  .regex(/^[a-z]{2}$/)
  .describe('Two-letter language code, e.g. en, es, ja.');

export function registerVoiceTools(
  server: McpServer,
  client: HildegardClient,
  agentName: () => string,
  remote?: { link: (path: string) => string },
) {
  const guard =
    <A>(fn: (a: A, extra: Extra) => Promise<CallToolResult>) =>
    async (a: A, extra: Extra): Promise<CallToolResult> => {
      try {
        return await fn(a, extra);
      } catch (e) {
        return fail((e as Error).message);
      }
    };

  const upload = async (a: { source_path?: string; source_data?: string }): Promise<string> => {
    if (a.source_path && a.source_data)
      throw new HildegardError(422, 'Give source_path or source_data, not both.');
    if (a.source_path) {
      if (remote)
        throw new HildegardError(
          422,
          'Hildegard runs on another computer, so it can’t read a path on yours. Send the recording itself as source_data (base64).',
        );
      const bytes = await readFile(a.source_path).catch(() => {
        throw new HildegardError(0, `Cannot read ${a.source_path}`);
      });
      return client.uploadAudio(bytes);
    }
    if (a.source_data) {
      const bytes = Buffer.from(a.source_data.replace(/^data:[a-z]+\/[\w.+-]+;base64,/, ''), 'base64');
      if (!bytes.length) throw new HildegardError(422, 'source_data isn’t base64 audio.');
      return client.uploadAudio(bytes);
    }
    throw new HildegardError(422, 'Give the recording as source_path or source_data.');
  };

  const waitFor = async (id: string, extra: Extra, seconds = 600): Promise<VoiceJobDetail> => {
    const until = Date.now() + seconds * 1000;
    for (;;) {
      const j = await client.voiceJob(id);
      const token = extra._meta?.progressToken;
      if (token !== undefined && j.progress)
        await extra
          .sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: j.progress.done, total: j.progress.total },
          })
          .catch(() => {});
      if (DONE.includes(j.status) || Date.now() >= until || extra.signal.aborted) return j;
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  /** Where the clips are: a path on this computer, or a link that opens without signing in. */
  const where = (j: VoiceJobDetail) => j.audio.map((a, i) => (remote ? remote.link(a) : (j.files[i] ?? a)));

  const describe = (j: VoiceJobDetail): string => {
    if (j.status === 'failed')
      return `Voice job ${j.id} failed: ${j.error?.message ?? 'unknown error'} ${j.error?.hint ?? ''}`.trim();
    if (j.status === 'canceled') return `Voice job ${j.id} was canceled.`;
    if (j.status !== 'done')
      return `Voice job ${j.id} is ${j.status === 'queued' ? `waiting (number ${j.queuePosition} in line)` : `running${j.progress ? `, ${j.progress.done} of ${j.progress.total}` : ''}`}. Check again with voice_job_status.`;
    const files = where(j);
    return [
      `Done: "${j.title}"${j.seconds ? `, ${j.seconds.toFixed(1)} seconds` : ''}, made with ${j.model}${j.seed !== null ? `, seed ${j.seed}` : ''}.`,
      ...files.map((f, i) => (files.length > 1 ? `Candidate ${i + 1}: ${f}` : `Audio: ${f}`)),
      'Every clip carries Hildegard’s inaudible AI watermark.',
    ].join('\n');
  };

  const result = async (j: VoiceJobDetail, includeAudio: boolean): Promise<CallToolResult> => {
    const out: CallToolResult = {
      content: [{ type: 'text', text: describe(j) }],
      isError: j.status === 'failed',
    };
    if (includeAudio && j.status === 'done')
      for (const a of j.audio.slice(0, 3)) {
        const clip = await client.audio(a);
        if (clip && clip.data.length < 14_000_000) out.content.push({ type: 'audio', ...clip });
      }
    return out;
  };

  const voiceLine = (v: VoiceState['voices'][number], s: VoiceState) => {
    const usable = v.models.filter((m) => s.models.find((x) => x.id === m)?.installed);
    const consent = v.consent ? `, ${v.consent.speaker}’s voice, consent ${v.consent.status}` : '';
    return `- ${v.id}: ${v.name} (${v.kind}${consent}), ${v.language}${v.accent ? ` ${v.accent}` : ''}${v.gender ? `, ${v.gender}` : ''}. ${v.blurb}${usable.length ? '' : ' Its model isn’t installed.'}`;
  };

  server.registerTool(
    'list_voices',
    {
      title: 'List voices',
      description:
        'The voices you can speak in (built-in, designed and the owner’s consented clones), the voice models and whether each is installed, and the tags you can put in a script, such as [whispers] or [pause 0.5s]. Call this before speak.',
      annotations: { readOnlyHint: true },
    },
    (extra) =>
      guard(async () => {
        const s = await client.voice();
        const usable = s.voices.filter((v) => !v.consent || v.consent.status === 'active');
        const tags = s.catalog.tags.map((t) => t.id);
        return text(
          [
            `Voice runs on ${s.device}${s.engine.fake ? ' (stand-in engine, test mode)' : ''}.${s.engine.problem ? ` ${s.engine.problem}` : ''}`,
            'Models:',
            ...s.catalog.models.map((m) => {
              const st = s.models.find((x) => x.id === m.id);
              const state = st?.installed
                ? st.ready
                  ? 'installed'
                  : 'downloaded; the voice engine still needs `hildegard voice install`'
                : st?.downloading
                  ? 'downloading'
                  : 'not installed (install_voice_model)';
              return `- ${m.id}: ${m.name}, ${m.license}. Can ${m.can.join(', ')}; ${m.languages.length} languages. ${state}.`;
            }),
            'Voices:',
            ...usable.map((v) => voiceLine(v, s)),
            `Tags for scripts (in square brackets, never spoken): ${tags.join(', ')}; and pauses like [pause 0.5s] or [pause 300ms].`,
          ].join('\n'),
        );
      })(undefined, extra),
  );

  server.registerTool(
    'speak',
    {
      title: 'Speak a script',
      description:
        'Turn a script into speech on the owner’s GPU, in a voice from list_voices. Put tags in square brackets to act a line ([whispers], [laughs], [excited]) and [pause 0.5s] for silence. Separate paragraphs with a blank line. Costs nothing; nothing leaves the computer. Returns the audio file.',
      inputSchema: {
        script: z.string().min(1).max(50_000).describe('What to say. Blank lines separate paragraphs.'),
        voice: z.string().describe('Voice id from list_voices.'),
        direction: z
          .string()
          .max(100)
          .optional()
          .describe(
            'One line of acting direction for the whole script, e.g. "warm, close to the mic". Models that can’t act ignore it.',
          ),
        language: lang.optional(),
        speed: z.number().min(0.5).max(2).optional().describe('1 is normal. Default 1.'),
        expressiveness: z.number().min(0).max(1).optional().describe('0 steady to 1 dramatic. Default 0.5.'),
        variety: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('0 the same every time to 1 more varied. Default 0.5.'),
        seed: z
          .number()
          .int()
          .min(0)
          .max(4294967295)
          .optional()
          .describe('Fix it to get the same read again.'),
        title: z.string().max(120).optional(),
        include_audio: z
          .boolean()
          .optional()
          .describe('Also return the audio itself in the result. Default false.'),
        wait,
      },
    },
    guard(async (a, extra) => {
      const paragraphs = a.script
        .split(/\n\s*\n/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => ({ text: t, ...(a.direction ? { direction: a.direction } : {}) }));
      const j = await client.voiceRun('speak', {
        paragraphs,
        voice: a.voice,
        language: a.language,
        settings: {
          speed: a.speed ?? 1,
          expressiveness: a.expressiveness ?? 0.5,
          stability: 0.5,
          variety: a.variety ?? 0.5,
        },
        seed: a.seed,
        title: a.title,
        agent: agentName(),
      });
      if (a.wait === false) return text(`Queued voice job ${j.id}. Follow it with voice_job_status.`);
      return result(await waitFor(j.id, extra), a.include_audio === true);
    }),
  );

  server.registerTool(
    'design_voice',
    {
      title: 'Design a voice',
      description:
        'Make a new voice from a description in words (who, age, accent, timbre, pace, mood): returns up to three candidates reading your line. Listen, then keep the one you want with keep_designed_voice.',
      inputSchema: {
        description: z
          .string()
          .min(8)
          .max(500)
          .describe('e.g. "a weathered baritone in his sixties, slow and kind, Irish accent"'),
        text: z.string().min(1).max(600).describe('A line for the candidates to read.'),
        language: lang.optional(),
        candidates: z.number().int().min(1).max(3).optional().describe('Default 3.'),
        include_audio: z.boolean().optional(),
        wait,
      },
    },
    guard(async (a, extra) => {
      const j = await client.voiceRun('design', {
        description: a.description,
        text: a.text,
        language: a.language,
        candidates: a.candidates,
        agent: agentName(),
      });
      if (a.wait === false) return text(`Queued design job ${j.id}. Follow it with voice_job_status.`);
      const r = await result(await waitFor(j.id, extra), a.include_audio === true);
      r.content.push({ type: 'text', text: `Keep one with keep_designed_voice (job_id ${j.id}).` });
      return r;
    }),
  );

  server.registerTool(
    'keep_designed_voice',
    {
      title: 'Keep a designed voice',
      description:
        'Add one candidate from design_voice to the library, under a name. It then speaks the same way every time.',
      inputSchema: {
        job_id: z.string(),
        candidate: z.number().int().min(1).max(3),
        name: z.string().min(1).max(60),
      },
    },
    guard(async (a) => {
      const v = await client.keepDesign(a.job_id, a.candidate, a.name);
      return text(`Kept "${v.name}" as voice ${v.id}. Use it with speak.`);
    }),
  );

  server.registerTool(
    'convert_voice',
    {
      title: 'Say a recording in another voice',
      description:
        'Speech to speech: keep the words, timing and delivery of a recording, in another voice from list_voices.',
      inputSchema: {
        ...source,
        voice: z.string(),
        title: z.string().max(120).optional(),
        include_audio: z.boolean().optional(),
        wait,
      },
    },
    guard(async (a, extra) => {
      const j = await client.voiceRun('convert', {
        source: await upload(a),
        voice: a.voice,
        title: a.title,
        agent: agentName(),
      });
      if (a.wait === false) return text(`Queued voice job ${j.id}. Follow it with voice_job_status.`);
      return result(await waitFor(j.id, extra), a.include_audio === true);
    }),
  );

  server.registerTool(
    'transcribe',
    {
      title: 'Transcribe a recording',
      description:
        'Words and timings from a recording, on the owner’s GPU with Whisper. Nothing leaves the computer.',
      inputSchema: { ...source, language: lang.optional().describe('Leave out to detect it.'), wait },
    },
    guard(async (a, extra) => {
      const j = await client.voiceRun('transcribe', {
        source: await upload(a),
        language: a.language,
        agent: agentName(),
      });
      if (a.wait === false) return text(`Queued voice job ${j.id}. Follow it with voice_job_status.`);
      const d = await waitFor(j.id, extra);
      if (d.status !== 'done' || !d.transcript) return result(d, false);
      const t = d.transcript;
      const stamp = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
      return text(
        [
          `Language ${t.language}, ${t.seconds.toFixed(1)} seconds.`,
          ...t.segments.map((s) => `[${stamp(s.start)}–${stamp(s.end)}] ${s.text.trim()}`),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'dub',
    {
      title: 'Dub a recording',
      description:
        'Say a recording again in another language, in a voice from list_voices, each line fitted to its place over the original. Give lines with your own translation, or leave them out to transcribe and translate with a local language model.',
      inputSchema: {
        ...source,
        language: lang.describe('The language to dub into.'),
        voice: z.string(),
        lines: z
          .array(
            z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string().min(1).max(2000) }),
          )
          .max(2000)
          .optional()
          .describe('The translation, line by line, with start and end in seconds.'),
        title: z.string().max(120).optional(),
        include_audio: z.boolean().optional(),
        wait,
      },
    },
    guard(async (a, extra) => {
      const j = await client.voiceRun('dub', {
        source: await upload(a),
        language: a.language,
        voice: a.voice,
        lines: a.lines,
        title: a.title,
        agent: agentName(),
      });
      if (a.wait === false) return text(`Queued voice job ${j.id}. Follow it with voice_job_status.`);
      return result(await waitFor(j.id, extra), a.include_audio === true);
    }),
  );

  server.registerTool(
    'voice_job_status',
    {
      title: 'Voice job status',
      description:
        'Where a voice job is: waiting, running, done with its audio, or failed and why. Set cancel to stop it.',
      inputSchema: { job_id: z.string(), cancel: z.boolean().optional() },
    },
    guard(async (a) => {
      if (a.cancel) await client.cancelVoiceJob(a.job_id);
      return result(await client.voiceJob(a.job_id), false);
    }),
  );

  server.registerTool(
    'check_watermark',
    {
      title: 'Is this Hildegard’s?',
      description:
        'Whether a recording was made by Hildegard: its inaudible watermark, and the exact job when the file was made here.',
      inputSchema: source,
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const r = await client.isOurs(await upload(a));
      const said =
        r.verdict === 'ours'
          ? 'Yes, Hildegard made this.'
          : r.verdict === 'likely'
            ? 'Probably: part of Hildegard’s watermark is there.'
            : 'No Hildegard watermark found.';
      return text(
        `${said} Watermark score ${r.score}.${r.job ? ` It is job ${r.job.id} "${r.job.title}"${r.job.voice ? ` in voice ${r.job.voice}` : ''}, made ${r.job.createdAt}.` : ''}`,
      );
    }),
  );

  server.registerTool(
    'clone_voice',
    {
      title: 'Clone a voice',
      description:
        'Explains how a voice is cloned. You can’t clone one yourself: the person whose voice it is must read a fresh consent line aloud in the Studio, and Hildegard checks it’s them before anything is made.',
      annotations: { readOnlyHint: true },
    },
    guard(async () =>
      text(
        `Cloning needs the person whose voice it is, so it can’t be done from here. Ask your user to open Voice › Clone in the Hildegard Studio (${remote ? 'the address they use for Hildegard' : client.url}/#/voice/clone). There, the speaker reads a fresh consent line aloud, live, and adds a few recordings of their voice. Hildegard checks the line was said, that it wasn’t made by AI, and that every recording is the same person, then signs a consent certificate the speaker can revoke. Once it’s in the library, list_voices shows it and you can use it with speak.`,
      ),
    ),
  );

  server.registerTool(
    'install_voice_model',
    {
      title: 'Install a voice model',
      description:
        'Download a voice model to the computer Hildegard runs on. The first call returns the license terms, and those of any model it brings with it. Show them to your user word for word and ask whether they accept; call again with accept_license true only if they say yes.',
      inputSchema: {
        model: z.string().describe('Model id from list_voices.'),
        accept_license: z
          .boolean()
          .optional()
          .describe(
            'True only after your user has read the license terms and said they accept them. Never decide this yourself.',
          ),
      },
      annotations: { openWorldHint: true },
    },
    guard(async (a) => {
      try {
        await client.installVoiceModel(a.model, a.accept_license === true);
        return text(`Installing ${a.model}. Follow it with list_voices.`);
      } catch (e) {
        if (e instanceof HildegardError && e.body.code === 'license') {
          const terms = (e.body.terms as string[]).map((t) => `- ${t}`).join('\n');
          const also =
            (e.body.also as Array<{ name: string; license: string; licenseUrl: string }> | undefined) ?? [];
          return text(
            `${a.model} comes under the ${String(e.body.license)} (${String(e.body.licenseUrl)}). Your user becomes its licensee. In short:\n${terms}${also.length ? `\n\nIt also installs ${also.map((x) => `${x.name} (${x.license}, ${x.licenseUrl})`).join(' and ')}, which checks consent when a voice is cloned.` : ''}\n\nShow this to your user and ask whether they accept. If they do, call install_voice_model again with accept_license: true.`,
          );
        }
        throw e;
      }
    }),
  );
}
