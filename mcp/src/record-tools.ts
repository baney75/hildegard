// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recording from any chat. A chat can't count on the microphone, so it asks for a link, shows it, and the person
 * records on Hildegard's own page. The tools: record_link, recording_status and clean_voice. (export_film takes the
 * cleaned recording as a voice-over.) The link is a secret for the person who asked: the call that makes it is the only
 * one that ever returns it, and nothing here writes it anywhere.
 */
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError, type Recording } from './client.ts';
import { readable } from './private.ts';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

const lu = (n: number) => `${n.toFixed(1)} LUFS`;
const tp = (n: number) => `${n.toFixed(1)} dBTP`;

/** A recording brought in from a path on the computer the AI app runs on. Never from a remote app. */
export async function importPath(
  client: HildegardClient,
  path: string,
  remote: boolean,
  kind: 'voice' | 'video' | 'auto' = 'auto',
): Promise<Recording> {
  if (remote)
    throw new HildegardError(
      422,
      'Hildegard runs on another computer, so it can’t read a path on yours. Use media_id: the id recording_status gives for a recording you made with record_link.',
    );
  const bytes = await readFile(readable(path)).catch((e) => {
    if (e instanceof HildegardError) throw e;
    throw new HildegardError(0, `Cannot read ${path}`);
  });
  return client.importRecording(bytes, kind);
}

export function registerRecordTools(
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

  /** Where a recording is: a link that opens without signing in, or a path on this computer. */
  const where = (r: Recording) =>
    r.url ? (remote ? remote.link(r.url) : (r.file ?? `${client.url}${r.url}`)) : null;

  server.registerTool(
    'record_link',
    {
      title: 'Ask the person to record',
      description:
        'Get a link where the person records their voice (a voice-over, a line, a narration) or a video of themselves, on their own phone or computer, even though this chat can’t use their microphone. They open it, tap Record, listen or watch back, re-record if they like, and tap Send. Show them the link and the sentence it comes with. Then call recording_status until it says received. The link works once for 30 minutes and is a secret: share it only with the person you asked it for. For voice, call clean_voice on what comes back.',
      inputSchema: {
        kind: z.enum(['voice', 'video']).describe('voice: sound only. video: camera and sound.'),
        purpose: z
          .string()
          .max(200)
          .optional()
          .describe('What you are asking them to record, in a short sentence. The page shows it to them.'),
        film_id: z
          .string()
          .max(64)
          .optional()
          .describe('The film this is for, from direct_shot or make_sequence, if there is one.'),
      },
    },
    guard(async (a) => {
      const l = await client.recordLink({ kind: a.kind, purpose: a.purpose, filmId: a.film_id });
      // Hildegard's own link when it has one. Else the address this app reached Hildegard at, which the page is on too.
      const url = !remote && l.viaLink ? l.url : `${client.url}${l.path}`;
      const mins = Math.max(1, Math.round((Date.parse(l.expiresAt) - Date.now()) / 60_000));
      const what = a.kind === 'voice' ? 'a voice recording' : 'a video with sound';
      const phone = /^https?:\/\/(127\.|localhost|\[::1\])/.test(url);
      return text(
        [
          `Link for ${what}: ${url}`,
          `Recording id: ${l.id}. Check on it with recording_status (id: ${l.id}).`,
          `Show the person this, in these words: “Open this link on the device you will record on. Tap Record, ${a.kind === 'voice' ? 'say it' : 'do it'}, then listen back and tap Send. The link works once and ends in ${mins} minutes.”`,
          phone
            ? 'This link opens only on the computer Hildegard runs on. To record on a phone, the owner turns on Hildegard’s link first (`hildegard host`), then asks again.'
            : '',
          'The link is a secret for this person. Don’t paste it anywhere else.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'recording_status',
    {
      title: 'Has the recording arrived?',
      description:
        'Where a recording from record_link stands: pending (the person has not sent it yet), received (with its media id, length, and a path or link to the file) or expired (the link ran out first). Give the recording id record_link returned; the token is accepted too.',
      inputSchema: {
        id: z.string().max(64).optional().describe('The recording id record_link returned (rec_…).'),
        token: z.string().max(100).optional().describe('The link’s token, if you have no id.'),
      },
    },
    guard(async (a) => {
      if (!!a.id === !!a.token)
        throw new HildegardError(422, 'Give the recording id or the token, not both.');
      const r = await client.recording(a.id ? { id: a.id } : { token: a.token! });
      if (r.status === 'pending') {
        const left = r.expiresAt
          ? Math.max(0, Math.round((Date.parse(r.expiresAt) - Date.now()) / 60_000))
          : 0;
        return text(`Pending: ${r.id} has not been sent yet. The link works for about ${left} more minutes.`);
      }
      if (r.status === 'expired')
        return text(
          `Expired: the link for ${r.id} ran out before anything was sent. Ask for a new one with record_link.`,
        );
      const w = where(r);
      return text(
        [
          `Received: media id ${r.id}, ${r.kind === 'voice' ? 'a voice recording' : 'a video'}${r.seconds !== null ? `, ${r.seconds.toFixed(1)} seconds` : ''}${r.clean ? `, cleaned to ${lu(r.clean.lufs)} with a true peak of ${tp(r.clean.truePeak)}` : ''}.`,
          w ? `${remote ? 'Link (opens without signing in, for a day)' : 'File'}: ${w}` : '',
          r.kind === 'voice' && !r.clean
            ? `Next: clean_voice with media_id ${r.id}, then export_film with that as the voiceover.`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'clean_voice',
    {
      title: 'Clean a voice recording',
      description: `Clean up speech: hum and rumble out, clicks and background noise down, level evened, gaps between words gated, then set to a loudness target with a true-peak ceiling. A video keeps its picture and gets the cleaned sound. The original stays; this makes a new recording and returns its media id with the loudness and true peak it measured. ${
        remote
          ? 'Give media_id, from recording_status.'
          : 'Give media_id (from recording_status) or source_path (a recording on this computer).'
      }`,
      inputSchema: {
        media_id: z.string().max(64).optional().describe('A recording’s id, from recording_status.'),
        ...(remote
          ? {}
          : {
              source_path: z
                .string()
                .optional()
                .describe(
                  'Absolute path to a recording (WAV, MP3, M4A, OGG, FLAC, WebM or MP4) on this computer.',
                ),
            }),
        target_lufs: z.number().min(-40).max(-5).optional().describe('Loudness target. Default -16 LUFS.'),
        peak: z.number().min(-9).max(0).optional().describe('True-peak ceiling in dBTP. Default -1.5.'),
        job_id: z.string().max(64).optional().describe('Follow a cleaning that was still running.'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(1800)
          .optional()
          .describe('Wait up to this long. Default 600.'),
      },
    },
    guard(
      async (
        a: {
          media_id?: string;
          source_path?: string;
          target_lufs?: number;
          peak?: number;
          job_id?: string;
          wait_seconds?: number;
        },
        extra,
      ) => {
        let job = a.job_id ? await client.cleanJob(a.job_id) : null;
        if (!job) {
          if (!!a.media_id === !!a.source_path)
            throw new HildegardError(
              422,
              remote ? 'Give media_id.' : 'Give media_id or source_path, not both and not neither.',
            );
          const id = a.media_id ?? (await importPath(client, a.source_path!, !!remote)).id;
          job = await client.cleanRecording(id, { target_lufs: a.target_lufs, peak: a.peak });
        }
        const until = Date.now() + (a.wait_seconds ?? 600) * 1000;
        while (job.status === 'running' && Date.now() < until && !extra.signal.aborted) {
          await new Promise((r) => setTimeout(r, 500));
          job = await client.cleanJob(job.id);
        }
        if (job.status === 'failed') return fail(`Cleaning failed: ${job.error ?? 'unknown error'}`);
        if (job.status === 'running')
          return text(
            `Still cleaning (${job.stage ?? 'working'}). Call clean_voice again with job_id ${job.id}.`,
          );
        const r = job.recording!;
        const w = where(r);
        return text(
          [
            `Cleaned: media id ${r.id}${r.seconds !== null ? `, ${r.seconds.toFixed(1)} seconds` : ''}${r.clean ? `, ${lu(r.clean.lufs)}, true peak ${tp(r.clean.truePeak)}` : ''}.`,
            w ? `${remote ? 'Link (opens without signing in, for a day)' : 'File'}: ${w}` : '',
            r.kind === 'voice' ? `Use it in a film: export_film with voiceover.media_id ${r.id}.` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      },
    ),
  );
}
