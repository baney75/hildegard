// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post tools: prepare_post makes a finished film or image ready for each platform, in a Ready to post folder, and
 * returns the files and words. It never posts. Nothing in it holds a platform account or contacts a platform; the person
 * presses Post themselves.
 */
import { join } from 'node:path';
import {
  POST_PLATFORM_IDS,
  POST_TARGET_IDS,
  type PostFile,
  type PostSourceRef,
  type PostState,
  platformName,
} from '@hildegard/presets';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError } from './client.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerPostTools(
  server: McpServer,
  client: HildegardClient,
  remote?: { link: (path: string) => string },
) {
  server.registerTool(
    'prepare_post',
    {
      title: 'Prepare a post',
      description: `Get a finished film or image ready to post: for each platform Hildegard makes the file in that platform's own size, shape and loudness (YouTube 16:9, Shorts, Reels and TikTok 9:16, X 16:9 or 1:1 within its limits, Instagram and Facebook 4:5, and Threads, Reddit and LinkedIn), a thumbnail, and the title, caption and hashtags written only from facts you give it, inside each platform's character limits. ${
        remote
          ? 'Returns links to the files, good for a day.'
          : 'Returns the files’ paths in a Ready to post folder on the computer Hildegard runs on.'
      } This never posts anything and cannot: it holds no platform account and contacts no platform. The person presses Post themselves, in Studio's Post sheet (it copies the caption, shows the file and opens the site in Hildegard's own window or their browser). Never sign in to a platform, click inside its site or read its pages for them. Give only facts the person told you: a title, a line about it, their own tags, a link.`,
      inputSchema: {
        film_id: z
          .string()
          .optional()
          .describe('A film id: its finished export is used, and made first if there is none.'),
        take_id: z.string().optional().describe('Or one finished take.'),
        still_id: z.string().optional().describe('Or a finished image, from the Images room.'),
        platforms: z
          .array(z.enum(POST_PLATFORM_IDS))
          .min(1)
          .describe(
            'Where it will be posted: youtube, instagram, tiktok, x, facebook, threads, reddit, linkedin.',
          ),
        formats: z
          .array(z.enum(POST_TARGET_IDS as [string, ...string[]]))
          .optional()
          .describe(
            'To choose a format other than each platform’s default (youtube makes the video, instagram makes Reels): youtube-shorts, instagram-feed.',
          ),
        title: z.string().max(300).optional().describe('Default: the film’s title.'),
        about: z.string().max(5000).optional().describe('A line or two about it, in the person’s words.'),
        tags: z.array(z.string().max(60)).max(40).optional().describe('The person’s own hashtags.'),
        link: z.string().max(500).optional().describe('A link they want in the caption.'),
        disclose_ai: z
          .boolean()
          .optional()
          .describe('Say in the caption that it is AI-generated. Default true; platforms ask for it.'),
        on_screen_text: z
          .string()
          .max(300)
          .optional()
          .describe('Words to show on the picture, kept inside each platform’s safe area. Default none.'),
        youtube_4k: z.boolean().optional().describe('Make YouTube’s file 3840×2160 instead of 1920×1080.'),
        fill_frame: z
          .boolean()
          .optional()
          .describe(
            'Fill each frame, cropping the edges, instead of fitting the whole picture over a soft backdrop.',
          ),
        wait_seconds: z.number().int().min(0).max(900).optional().describe('How long to wait. Default 300.'),
      },
    },
    async (a): Promise<CallToolResult> => {
      try {
        const given = [a.film_id, a.take_id, a.still_id].filter(Boolean);
        if (given.length !== 1) return fail('Give one of film_id, take_id or still_id.');
        let source: PostSourceRef;
        const end = Date.now() + (a.wait_seconds ?? 300) * 1000;
        if (a.film_id) {
          const snap = await client.snapshot();
          let ex = snap.exports.find((e) => e.projectId === a.film_id && e.status === 'done');
          if (!ex) {
            ex = await client.exportFilm(a.film_id);
            while (ex.status === 'running' && Date.now() < end) {
              await sleep(1000);
              ex = await client.exportState(ex.id);
            }
            if (ex.status === 'failed') return fail(`The film couldn’t be exported: ${ex.error}`);
            if (ex.status !== 'done')
              return text(`The film is still exporting (export ${ex.id}). Call prepare_post again later.`);
          }
          source = { kind: 'export', id: ex.id };
        } else if (a.take_id) source = { kind: 'take', id: a.take_id };
        else source = { kind: 'still', id: a.still_id! };

        let post = await client.preparePost({
          source,
          platforms: a.platforms,
          formats: a.formats,
          facts: {
            title: a.title,
            about: a.about,
            tags: a.tags,
            link: a.link,
            disclose: a.disclose_ai,
          },
          onScreenText: a.on_screen_text,
          youtube4k: a.youtube_4k,
          fit: a.fill_frame ? 'crop' : 'blur',
        });
        while (post.status === 'running' && Date.now() < end) {
          await sleep(1000);
          post = await client.postState(post.id);
        }
        return report(post, client, remote);
      } catch (e) {
        return fail(e instanceof HildegardError || e instanceof Error ? e.message : String(e));
      }
    },
  );
}

const sizeOf = (n: number | null) =>
  n == null ? '' : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function describeFile(
  f: PostFile,
  post: PostState,
  client: HildegardClient,
  remote?: { link: (p: string) => string },
) {
  const where = (name: string) =>
    remote
      ? remote.link(`/api/post/${post.id}/files/${name}`)
      : post.folder
        ? join(post.folder, name)
        : `${client.url}/api/post/${post.id}/files/${name}`;
  if (f.status !== 'done') return `${f.label}: ${f.status === 'failed' ? `failed: ${f.error}` : f.status}`;
  const shape = `${f.width}×${f.height}${f.seconds != null ? `, ${f.seconds} s` : ''}, ${sizeOf(f.bytes)}${
    f.lufs != null ? `, ${f.lufs.toFixed(1)} LUFS` : ''
  }${f.trimmed ? ', cut to the platform’s longest' : ''}`;
  return [
    `${f.label} (${shape})`,
    `  File: ${where(f.file!)}`,
    f.thumbnail ? `  Thumbnail: ${where(f.thumbnail)}` : '',
    f.text.title ? `  Title: ${f.text.title}` : '',
    `  ${f.text.title ? 'Description' : 'Caption'} (${f.text.length} of ${f.text.limit}):\n${f.text.caption
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function report(
  post: PostState,
  client: HildegardClient,
  remote?: { link: (p: string) => string },
): CallToolResult {
  if (post.status === 'running')
    return text(`Still preparing (post ${post.id}). Call prepare_post again later.`);
  if (post.status === 'failed') return fail(`Nothing could be prepared: ${post.error}`);
  const lines = [
    `Prepared “${post.title}” for ${[...new Set(post.files.map((f) => platformName(f.platform)))].join(', ')}. Nothing was posted.`,
    ...post.files.map((f) => describeFile(f, post, client, remote)),
    ...post.skipped.map((s) => s.why),
    ...post.notes,
    remote
      ? 'The person posts it themselves: they open Studio’s Post sheet, or take these files to each site.'
      : `The person posts it themselves: Studio → Post (${client.url}) copies each caption, shows the file and opens the site. Don’t sign in to a site or act inside it for them.`,
  ];
  return text(lines.filter(Boolean).join('\n\n'));
}
