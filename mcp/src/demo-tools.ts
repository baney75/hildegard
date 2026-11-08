// SPDX-License-Identifier: AGPL-3.0-only
/**
 * demo_browser: record a site or an unpacked extension as a tech demo, driven by a step script, with nobody clicking.
 * The browser is Playwright's Chromium with a throwaway profile on the computer Hildegard runs on; the result is a
 * video on a clean backdrop with the person's recordings.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HildegardClient } from './client.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

const Target = {
  text: z.string().max(200).optional().describe('Visible text of what to click or wait for.'),
  selector: z.string().max(300).optional().describe('A CSS selector, when the text isn’t unique.'),
};
const StepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('goto'), url: z.string().max(2000) }),
  z.object({ do: z.literal('click'), ...Target }),
  z.object({
    do: z.literal('type'),
    text: z.string().max(2000),
    selector: z.string().max(300).optional(),
    delay: z.number().int().min(0).max(1000).optional().describe('Milliseconds between keys. Default 90.'),
    mask: z.boolean().optional().describe('Show it as dots in the step log (anything key-like is anyway).'),
  }),
  z.object({
    do: z.literal('key'),
    key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp']),
  }),
  z.object({ do: z.literal('wait'), ms: z.number().int().min(0).max(30_000).optional(), ...Target }),
  z.object({
    do: z.literal('scroll'),
    y: z.number().int().optional(),
    selector: z.string().max(300).optional(),
  }),
  z.object({ do: z.literal('pause'), ms: z.number().int().min(0).max(30_000) }),
  z.object({
    do: z.literal('caption'),
    text: z.string().max(200),
    ms: z.number().int().min(0).max(30_000).optional(),
  }),
]);

export function registerDemoTools(
  server: McpServer,
  client: HildegardClient,
  remote?: { link: (p: string) => string },
) {
  server.registerTool(
    'demo_browser',
    {
      title: 'Record a browser demo',
      description:
        'Record a tech demo of a website or an unpacked browser extension with nobody clicking: Hildegard opens Playwright’s Chromium with a throwaway profile (none of the person’s own cookies or sign-ins), runs your steps with a visible cursor and click ripples, and puts the video on a clean backdrop with their recordings. Steps: goto, click (by text or selector), type (human-paced), key, wait (time, text or selector), scroll, pause, caption. Never sign in to anything; anything key-like you type shows as dots in the log. If Chromium isn’t installed, you get the command to give the person; nothing is downloaded. Extensions and file addresses work only when you run on the computer Hildegard runs on.',
      inputSchema: {
        url: z.string().max(2000).describe('Where to start: http(s), or a file in the project (with root).'),
        steps: z.array(StepSchema).max(200).describe('What to do, in order.'),
        extension: z
          .string()
          .max(1000)
          .optional()
          .describe('Full path to an unpacked extension’s folder (with manifest.json).'),
        root: z.string().max(1000).optional().describe('The project folder, for file addresses.'),
        size: z
          .string()
          .regex(/^\d{3,4}x\d{3,4}$/)
          .optional()
          .describe('The browser’s size, width x height. Default 1280x800.'),
        backdrop: z
          .string()
          .max(20)
          .optional()
          .describe('viridian (default), dusk, vellum, ember, ink, paper, none, or a color like #1f5a3d.'),
        aspect: z.enum(['16:9', '1:1', '9:16']).optional().describe('The video’s shape. Default 16:9.'),
        zoom: z.boolean().optional().describe('Ease in toward each click and back out.'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(900)
          .optional()
          .describe('Wait up to this long. Default 300.'),
        job_id: z.string().max(40).optional().describe('Follow a demo that was still running.'),
      },
      annotations: { openWorldHint: true },
    },
    async (a, extra) => {
      try {
        if (remote && (a.extension || a.root || /^file:/i.test(a.url)))
          return fail(
            'Hildegard runs on another computer, so it can’t open a folder or file on yours. Give an http(s) address.',
          );
        const [w, h] = (a.size ?? '1280x800').split('x').map(Number);
        let job = a.job_id
          ? await client.demo(a.job_id)
          : await client.startDemo({
              url: a.url,
              steps: a.steps,
              extension: a.extension,
              root: a.root,
              width: w!,
              height: h!,
              backdrop: a.backdrop,
              aspect: a.aspect,
              zoom: a.zoom,
            });
        const until = Date.now() + (a.wait_seconds ?? 300) * 1000;
        while (
          !['done', 'failed', 'stopped'].includes(job.status) &&
          Date.now() < until &&
          !extra.signal.aborted
        ) {
          await new Promise((r) => setTimeout(r, 750));
          job = await client.demo(job.id);
        }
        if (job.status === 'failed')
          return fail(`The demo stopped: ${job.error ?? 'unknown'}\nSteps done:\n${job.log.join('\n')}`);
        if (!job.recording)
          return text(
            `Still ${job.status} (${job.stage ?? 'working'}). Call demo_browser again with job_id ${job.id}.`,
          );
        const r = job.recording;
        const where = r.url ? (remote ? remote.link(r.url) : (r.file ?? `${client.url}${r.url}`)) : null;
        return text(
          [
            `Recorded: media id ${r.id}${r.seconds ? `, ${r.seconds.toFixed(1)} seconds` : ''}. It is with the person’s recordings.`,
            where ? `${remote ? 'Link (opens without signing in, for a day)' : 'File'}: ${where}` : '',
            'Steps:',
            ...job.log.map((l) => `- ${l}`),
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
}
