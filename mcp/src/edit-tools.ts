// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Video editing for agents: an edit list rendered and proven on the output. edit_plan proposes the list (transcribe,
 * fillers, false starts, pauses, a length), edit_write saves one a model wrote, edit_render makes the video and its contact
 * sheet, edit_verify is the gate that checks the finished file. The flow and its recipes are in the hildegard-video-edit skill.
 */
import type { EditView } from '@hildegard/presets';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError } from './client.ts';
import { importPath } from './record-tools.ts';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Content = CallToolResult['content'];
const text = (s: string, more: Content = []): CallToolResult => ({
  content: [{ type: 'text', text: s }, ...more],
});
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

const WORDS_SHOWN = 14_000;
const mmss = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

const edlShape = z
  .record(z.string(), z.unknown())
  .describe(
    'The edit list: {"version":1,"sources":{"a":{"path":"recording:rec_…"}},"keep":[{"start":2,"end":9.5}],"cuts":[{"start":4,"end":4.8}],"pauses":{"max":0.7},"blur":[{"start":10,"end":14,"box":[0.1,0.2,0.5,0.06],"style":"solid"}],"titles":[…],"captions":{"transcript":"transcript.json"},"music":{…},"reframe":{…},"target":"youtube"}. Seconds are source seconds except titles and chapters (output seconds). A box is [x,y,width,height] as fractions of the frame. Unknown fields are refused. Read the hildegard-video-edit skill for every field.',
  );

export function registerEditTools(
  server: McpServer,
  client: HildegardClient,
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

  /** Waits for the edit's job to leave "running", up to `minutes`. */
  async function settle(id: string, minutes: number, extra: Extra): Promise<EditView> {
    const until = Date.now() + minutes * 60_000;
    let v = await client.edit(id);
    while (v.job?.status === 'running' && Date.now() < until) {
      if (extra.signal?.aborted) break;
      await new Promise((r) => setTimeout(r, 1500));
      v = await client.edit(id);
    }
    return v;
  }

  const problems = (v: EditView) => {
    const c = v.check;
    if (!c) return '';
    const lines = [
      ...c.errors.map((e) => `  ERROR ${e.path || 'edit list'}: ${e.message}`),
      ...c.warnings.map((w) => `  note ${w.path}: ${w.message}`),
    ];
    return lines.join('\n');
  };

  const summary = (v: EditView) => {
    const s = v.check?.summary;
    if (!s) return v.check ? 'The edit list has problems (below).' : 'Not checked yet.';
    const extras = (['cues', 'titles', 'blur', 'chapters'] as const)
      .filter((k) => s[k])
      .map((k) => `${s[k]} ${k === 'cues' ? 'caption cues' : k}`);
    return `It makes ${s.seconds.toFixed(1)} s (${s.frames} frames at ${s.fps} fps), ${s.width}x${s.height}, ${s.segments} pieces${extras.length ? `, with ${extras.join(', ')}` : ''}. Pauses: ${s.pauses_cut} shortened, ${s.pauses_kept} kept (typing or clicking).`;
  };

  const failedJob = (v: EditView) => (v.job?.status === 'failed' ? `That failed: ${v.job.error}` : null);

  server.registerTool(
    'edit_plan',
    {
      title: 'Plan a video edit',
      description:
        'Start or redo an edit of one video: it listens (a transcript with word times, on the owner’s GPU), then proposes an edit list that cuts filler words (um, uh, a hesitating “like”), earlier takes of a line said again (the last take stays), long dead pauses (by speech energy, so typing and fan noise are not mistaken for pauses; a pause with typing in it is kept), and, with target_seconds, tightens pauses and then drops the sentences with the least said per second. Give the footage as media_id (a recording id from record_link or import), export_id, or source_path (a path on this computer). The result has the edit list, what was cut and why, and the transcript as a text file: to cut exact words, delete them from that text and call edit_plan again with edited_text. Nothing is rendered yet: read the list, change it with edit_write if needed, then edit_render. Replaces the edit’s cuts, pauses and captions (keeps hidden regions, titles, music, reframe).',
      inputSchema: {
        edit_id: z
          .string()
          .max(40)
          .optional()
          .describe('An edit from an earlier edit_plan to plan again. Leave out to start a new one.'),
        media_id: z
          .string()
          .max(64)
          .optional()
          .describe('A recording id (rec_…) from record_link or an import.'),
        export_id: z.string().max(64).optional().describe('A finished film export’s id.'),
        source_path: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Absolute path to a video on the computer Hildegard runs on. Not for a remote AI app: use media_id.',
          ),
        title: z.string().max(120).optional(),
        goal: z
          .string()
          .max(500)
          .optional()
          .describe(
            'What the video is for, in a sentence. Kept with the edit as a note; it does not change the cuts.',
          ),
        target_seconds: z
          .number()
          .min(1)
          .max(86_400)
          .optional()
          .describe(
            'How long it should come out. Over this, pauses are cut harder and the least useful sentences dropped.',
          ),
        target: z
          .enum(['youtube', 'shorts', 'reels', 'tiktok', 'x', 'podcast'])
          .optional()
          .describe(
            'Where it is going: sets shape and loudness (-14 LUFS, -16 for podcast); the vertical ones crop to 9:16 around the subject.',
          ),
        edited_text: z
          .string()
          .max(2_000_000)
          .optional()
          .describe(
            'The transcript text with the words or lines you want gone deleted. Don’t add or change words.',
          ),
        transcript: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'A transcript you already have: {"segments":[{"words":[{"start","end","word"}]}]}. Skips transcribing.',
          ),
        filler_words: z
          .array(z.string().max(40))
          .max(40)
          .optional()
          .describe(
            'Replace the filler list (default: um, uh, er, ah, hmm, and a hesitating like / you know / I mean).',
          ),
        strict_fillers: z
          .boolean()
          .optional()
          .describe('Cut like / you know / I mean everywhere, not only as a hesitation.'),
        keep_fillers: z.boolean().optional().describe('Leave filler words in.'),
        keep_pauses: z.boolean().optional().describe('Leave pauses alone.'),
        auto: z.boolean().optional().describe('Also cut stretches that are quiet and still.'),
        transcribe: z
          .boolean()
          .optional()
          .describe('False: cut by loudness and motion alone, with no transcript (no captions).'),
        wait: z.boolean().optional().describe('Wait for it (up to 30 minutes). Default true.'),
      },
      annotations: {
        title: 'Plan a video edit',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async (a, extra) => {
      let id = a.edit_id;
      const given = [a.media_id, a.export_id, a.source_path].filter(Boolean).length;
      if (id && given)
        throw new HildegardError(422, 'Give an edit_id, or footage to start a new edit, not both.');
      if (!id) {
        if (given !== 1)
          throw new HildegardError(422, 'Give the footage: media_id, export_id or source_path.');
        let source: string;
        if (a.media_id) source = `recording:${a.media_id}`;
        else if (a.export_id) source = `export:${a.export_id}`;
        else source = `recording:${(await importPath(client, a.source_path!, !!remote, 'video')).id}`;
        id = (
          await client.createEdit({ title: a.title ?? (a.goal ? a.goal.slice(0, 80) : undefined), source })
        ).id;
      }
      await client.planEdit(id, {
        transcript: a.transcript,
        text: a.edited_text,
        target_seconds: a.target_seconds,
        target: a.target,
        filler_words: a.filler_words,
        strict_fillers: a.strict_fillers,
        fillers: a.keep_fillers ? false : undefined,
        pauses: a.keep_pauses ? false : undefined,
        auto: a.auto,
        transcribe: a.transcribe,
        title: a.title,
      });
      if (a.wait === false) return text(`Planning edit ${id}. Check it with edit_status (edit_id: ${id}).`);
      const v = await settle(id, 30, extra);
      return planResult(client, v);
    }),
  );

  async function planResult(c: HildegardClient, v: EditView): Promise<CallToolResult> {
    const bad = failedJob(v);
    if (bad) return fail(`Edit ${v.id}: ${bad}`);
    if (v.job?.status === 'running')
      return text(`Edit ${v.id} is still planning (${v.job.stage ?? 'working'}). Check it with edit_status.`);
    const r = (v.plan ?? {}) as Record<
      string,
      number | string[] | Array<{ at: number; text: string; why: string }>
    >;
    const removed = (r.removed as Array<{ at: number; text: string; why: string }> | undefined) ?? [];
    const words = await c.editWords(v.id).catch(() => null);
    const shown =
      words && words.length > WORDS_SHOWN
        ? `${words.slice(0, WORDS_SHOWN)}\n… (${words.length - WORDS_SHOWN} more characters)`
        : words;
    return text(
      [
        `Edit ${v.id}: ${typeof r.source_seconds === 'number' ? `${r.source_seconds.toFixed(1)} s of footage → ${(r.after_seconds as number).toFixed(1)} s` : summary(v)}.`,
        `Cuts: ${r.filler_cuts ?? 0} filler, ${r.bad_take_cuts ?? 0} earlier takes, ${r.deleted_cuts ?? 0} deleted in the text, ${r.auto_cuts ?? 0} quiet and still; ${r.pause_cuts ?? 0} pauses shortened${r.trimmed_sentences ? `; ${r.trimmed_sentences} sentences trimmed to length` : ''}.`,
        ...removed.slice(0, 25).map((x) => `  ${mmss(x.at)}  “${x.text}”  (${x.why})`),
        ...((r.notes as string[] | undefined) ?? []).map((n) => `note: ${n}`),
        summary(v),
        problems(v),
        '',
        `Edit list:\n${JSON.stringify(v.edl)}`,
        shown
          ? `\nTranscript, to cut words from (delete words or lines, then edit_plan again with edited_text):\n${shown}`
          : '',
        '\nNext: read the cuts above, change the list with edit_write if something is wrong, then edit_render.',
      ]
        .filter((x) => x !== undefined)
        .join('\n'),
    );
  }

  server.registerTool(
    'edit_write',
    {
      title: 'Save a video edit list',
      description:
        'Save an edit list you wrote or changed (keep ranges, cuts, blur regions, titles, captions, chapters, music with ducking, reframe, target) on an edit, or start a new edit from a whole list. It is checked at once: every problem is named by field (keep[2].end) with what is wrong, so fix and call again until it says it is a good list. Footage is named recording:<id>, export:<id> or edit:<id>, never by path. Replaces the whole list. Nothing is rendered.',
      inputSchema: {
        edit_id: z
          .string()
          .max(40)
          .optional()
          .describe('The edit to change. Leave out to start a new edit from this list.'),
        title: z.string().max(120).optional(),
        edl: edlShape,
      },
      annotations: {
        title: 'Save a video edit list',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (a) => {
      const v = a.edit_id
        ? await client.writeEdl(a.edit_id, a.edl)
        : await client.createEdit({ title: a.title, edl: a.edl });
      return text(
        [
          v.check?.ok
            ? `Edit ${v.id}: a good edit list. ${summary(v)}`
            : `Edit ${v.id}: the edit list has problems. Fix them and call edit_write again.`,
          problems(v),
          v.check?.ok ? 'Next: edit_render.' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'edit_status',
    {
      title: 'Look at a video edit',
      description:
        'The state of an edit: its list, its last check, whether a job is running, the render and the verdict of the gate. Without an edit_id, your edits.',
      inputSchema: {
        edit_id: z.string().max(40).optional(),
        show_list: z.boolean().optional().describe('Include the edit list as JSON.'),
      },
      annotations: { title: 'Look at a video edit', readOnlyHint: true, openWorldHint: false },
    },
    guard(async (a) => {
      if (!a.edit_id) {
        const { edits } = await client.edits();
        return text(
          edits.length
            ? edits
                .map(
                  (e) =>
                    `${e.id}  ${e.title}  ${e.job?.status === 'running' ? `(${e.job.kind} running)` : e.verify ? (e.verify.ok ? 'verified' : 'FAILED the gate') : e.render ? 'rendered' : 'draft'}`,
                )
                .join('\n')
            : 'No edits yet. Start one with edit_plan.',
        );
      }
      const v = await client.edit(a.edit_id);
      return text(
        [
          `Edit ${v.id}: ${v.title}`,
          v.job
            ? `Job: ${v.job.kind} ${v.job.status}${v.job.stage ? `, ${v.job.stage}` : ''}${v.job.done !== null ? ` (${v.job.done}/${v.job.total})` : ''}${v.job.error ? `, ${v.job.error}` : ''}`
            : 'No job running.',
          summary(v),
          problems(v),
          v.render
            ? `Rendered: ${v.render.seconds.toFixed(2)} s, ${v.render.width}x${v.render.height}, ${v.render.encoder}${v.render.lufs !== null ? `, ${v.render.lufs.toFixed(1)} LUFS` : ''}.`
            : 'Not rendered.',
          v.verify
            ? `Gate: ${v.verify.ok ? 'passed' : 'FAILED'}${v.verify.unproven.length ? ` (unproven: ${v.verify.unproven.join(', ')})` : ''}.`
            : 'Gate: not run.',
          a.show_list ? `\n${JSON.stringify(v.edl)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }),
  );

  const where = (v: EditView) =>
    v.render
      ? remote
        ? remote.link(v.render.url)
        : (v.render.file ?? `${client.url}${v.render.url}`)
      : null;

  server.registerTool(
    'edit_render',
    {
      title: 'Render a video edit',
      description:
        'Render the edit list to a video: the cuts and pauses on the frame grid, hidden regions blurred before anything else, titles, captions re-timed to the cut, music ducked under the voice, the sound cleaned and mastered to the target loudness, the original sound kept as a second audio track, encoded in parallel (a hardware encoder when this computer has one). It also makes a contact sheet of the cut with each join as a before-and-after pair, which you get back as an image: look at it. Rendering is not proof: call edit_verify next.',
      inputSchema: {
        edit_id: z.string().max(40),
        encoder: z
          .enum(['auto', 'libx264', 'h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_vaapi'])
          .optional()
          .describe('Default auto: a hardware encoder if one works, else libx264.'),
        wait: z.boolean().optional().describe('Wait for it (up to 60 minutes). Default true.'),
      },
      annotations: {
        title: 'Render a video edit',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (a, extra) => {
      await client.renderEdit(a.edit_id, { encoder: a.encoder });
      if (a.wait === false) return text(`Rendering edit ${a.edit_id}. Check it with edit_status.`);
      const v = await settle(a.edit_id, 60, extra);
      const bad = failedJob(v);
      if (bad) return fail(`Edit ${v.id}: ${bad}`);
      if (v.job?.status === 'running')
        return text(
          `Edit ${v.id} is still rendering (${v.job.stage ?? 'working'}${v.job.done !== null ? `, ${v.job.done} of ${v.job.total} groups` : ''}). Check it with edit_status.`,
        );
      const r = v.render!;
      const sheet = r.sheetUrl ? await client.bytes(r.sheetUrl) : null;
      return text(
        [
          `Rendered edit ${v.id}: ${r.seconds.toFixed(2)} s, ${r.frames} frames, ${r.width}x${r.height} at ${r.fps} fps, ${r.encoder}${r.lufs !== null ? `, ${r.lufs.toFixed(1)} LUFS and ${r.truePeak?.toFixed(1)} dBTP` : ''}, ${r.audioTracks} audio track${r.audioTracks === 1 ? '' : 's'}.`,
          `${remote ? 'Link (opens without signing in, for a day)' : 'File'}: ${where(v)}`,
          ...r.warnings.map((w) => `note ${w.path}: ${w.message}`),
          sheet
            ? 'The contact sheet is attached: the top is the cut spread through its length, the bottom is each join as a before-and-after pair. Look for a cut mid-motion or mid-word, a title off its place, a caption over a face, a region still readable.'
            : '',
          'Next: edit_verify. Done means the gate passes, not that it rendered.',
        ]
          .filter(Boolean)
          .join('\n'),
        sheet
          ? [{ type: 'image' as const, data: Buffer.from(sheet).toString('base64'), mimeType: 'image/jpeg' }]
          : [],
      );
    }),
  );

  server.registerTool(
    'edit_verify',
    {
      title: 'Prove a video edit on its output',
      description:
        'The gate. It reads the finished video, not the renderer’s account of it, and passes only if: the video is the render of this very list (change the list and it must be rendered again); the frame count is exactly what the edit list resolves to; picture and each audio track are the same length; loudness and true peak are on the target (silent sound fails when the list masters it); there is no black or frozen stretch longer than allowed; titles and captions are inside the frame; and, with tesseract installed, OCR of the output finds none of the declared secrets anywhere in the video and no API key, e-mail, IP or host name in or around the hidden stretches. When something fails it says what to change (widen a blur, use style solid, fix a range); change the list, edit_render, and verify again. If it says OCR is unproven, tell your user the hidden text was not checked. Don’t tell your user a video is finished until this passes.',
      inputSchema: {
        edit_id: z.string().max(40),
        wait: z.boolean().optional().describe('Wait for it (up to 15 minutes). Default true.'),
      },
      annotations: {
        title: 'Prove a video edit on its output',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (a, extra) => {
      await client.verifyEdit(a.edit_id);
      if (a.wait === false) return text(`Verifying edit ${a.edit_id}. Check it with edit_status.`);
      const v = await settle(a.edit_id, 15, extra);
      const bad = failedJob(v);
      if (bad) return fail(`Edit ${v.id}: ${bad}`);
      const g = v.verify;
      if (!g) return text(`Edit ${v.id} is still being verified. Check it with edit_status.`);
      const mark = { pass: 'OK  ', fail: 'FAIL', warn: 'note', skip: 'skip' } as const;
      return {
        ...text(
          [
            g.ok
              ? `Edit ${v.id}: the output matches the edit list.`
              : `Edit ${v.id}: the output does NOT match the edit list.`,
            ...g.checks.map((c) => `${mark[c.status]} ${c.id.padEnd(9)} ${c.detail}`),
            g.unproven.length
              ? `UNPROVEN: ${g.unproven.join(', ')} could not be checked here. Say so to your user; don’t call it proven.`
              : '',
            g.ok
              ? `${remote && v.render ? remote.link(v.render.url) : (where(v) ?? '')}`
              : 'Fix what failed (edit_write), edit_render, then edit_verify again.',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        ...(g.ok ? {} : { isError: true }),
      };
    }),
  );
}
