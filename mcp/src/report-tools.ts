// SPDX-License-Identifier: AGPL-3.0-only
/**
 * report_draft and report_file: an agent tells Hildegard's makers about a bug it hit or a thing its person wants,
 * with what the computer says about itself. The person sees the exact text first, and nothing is filed without
 * their yes.
 */
import { arch, homedir, hostname, platform, release, userInfo } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError } from './client.ts';
import { type Draft, describeDraft, draftReport, HOW, type Known, similarIssues } from './report.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

function knownHere(): Known {
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {}
  return { home: homedir(), user, host: hostname().replace(/\.local$/, '') };
}

export function registerReportTools(
  server: McpServer,
  client: HildegardClient,
  agentName: () => string,
  version: string,
  remote: boolean,
) {
  server.registerTool(
    'report_draft',
    {
      title: 'Draft a bug report or an idea for Hildegard',
      description:
        'Tell the people who make Hildegard about a bug (Hildegard itself failed or did the wrong thing, not a bad request) or an idea (something your user wants to make that Hildegard can’t do yet). Nothing is sent: this writes the report, adds what the computer says about itself (version, system, GPU, the end of the log) with keys, paths, names and addresses taken out, and finds issues already open that sound the same. Then show your user the exact text and the matches, and file it with report_file only if they say yes.',
      inputSchema: {
        kind: z
          .enum(['bug', 'idea'])
          .describe('bug: something is broken. idea: something to add or make easier.'),
        title: z
          .string()
          .min(4)
          .max(120)
          .describe(
            'One plain line a maintainer can act on, e.g. "Draft takes fail on a 4 GB GPU with LTX".',
          ),
        what: z
          .string()
          .min(1)
          .max(6000)
          .describe(
            'bug: what you did, what you expected, and what happened, with the exact error words. idea: the work your user wants to make or do, not the feature ("cut a trailer from my takes" beats "add a timeline").',
          ),
        now: z
          .string()
          .max(4000)
          .optional()
          .describe('bug: the steps that make it happen again. idea: how they do it today, if at all.'),
        more: z
          .string()
          .max(4000)
          .optional()
          .describe('Anything else that helps: the tool call, the model, the prompt. Nothing private.'),
        how: z.enum(HOW).optional().describe('How Hildegard runs here. Default: An AI app over MCP.'),
        include_log: z
          .boolean()
          .optional()
          .describe('Add the end of Hildegard’s log to a bug, private things taken out. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      const input = {
        kind: a.kind,
        title: a.title,
        what: a.what,
        now: a.now,
        more: a.more,
        how: a.how ?? (remote ? 'Hildegard at a link' : 'An AI app over MCP'),
        agent: agentName(),
      } as const;
      try {
        const { draft, filer } = await client.reportDraft({
          ...input,
          logs: a.include_log ?? a.kind === 'bug',
        });
        return text(describeDraft(draft, filer));
      } catch (e) {
        if (!(e instanceof HildegardError) || e.status !== 0) return fail((e as Error).message);
        // Hildegard isn't running, which may be the bug: draft it here, with what this process knows.
        const known = knownHere();
        const d = draftReport(
          input,
          {
            facts: {
              Hildegard: `${version} (the server isn’t running)`,
              System: `${platform()} ${release()} · ${arch()}`,
              Node: process.versions.node,
            },
          },
          known,
        );
        const draft: Draft = {
          ...d,
          id: 'unsaved',
          at: new Date().toISOString(),
          similar: await similarIssues(d.title, d.repo, client.fetchFn),
        };
        return text(
          `${describeDraft(draft, null)}\n\nHildegard isn’t running, so this draft can’t be filed from here; the link is the way to send it.`,
        );
      }
    },
  );

  server.registerTool(
    'report_file',
    {
      title: 'File a report your user approved',
      description:
        'File a draft from report_draft on Hildegard’s GitHub, exactly as your user read it. Call it only after they saw the text and said yes. With on, it adds the report to an issue already open instead (do this when report_draft found the same thing). It files as the owner through the GitHub CLI on the computer Hildegard runs on; when that can’t (no GitHub CLI, not the owner, or the day’s limit is reached), it returns the form filled in for your user to send.',
      inputSchema: {
        draft: z.string().max(20).describe('The draft id report_draft gave.'),
        confirm: z.literal(true).describe('true: your user read this draft and said to file it.'),
        on: z.number().int().positive().optional().describe('An open issue’s number, to add to it instead.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        const { draft } = await client.reportFile(a.draft, a.on);
        return text(
          `${a.on ? `Added to #${a.on}` : 'Filed'}: ${draft.filed?.url}. Tell your user, with the link; the maintainers answer there.`,
        );
      } catch (e) {
        const url = e instanceof HildegardError && typeof e.body.url === 'string' ? e.body.url : null;
        return fail(
          `${(e as Error).message}${url ? `\n\nGive your user this link instead: it opens the issue on GitHub filled in, to send from their own account. ${url}` : ''}`,
        );
      }
    },
  );
}
