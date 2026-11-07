// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Writing voice tools: what an agent needs to write as the person it works for. Each person has their own voice notes,
 * samples of their writing and the record of what they cut from drafts; the server decides whose, from who is signed
 * in (on this computer, the owner), so an agent never names a person and never sees anyone else's.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HildegardClient, WritingEdit } from './client.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

/** Most characters of sample text one writing_voice_samples call gives back. */
const SAMPLE_BUDGET = 20_000;

const quoted = (l: string[], n = 6) =>
  l.length
    ? `${l
        .slice(0, n)
        .map((x) => `“${x}”`)
        .join(', ')}${l.length > n ? `, and ${l.length - n} more` : ''}`
    : 'nothing';
const lintSide = (a: { fails: number; warns: number }) =>
  `${a.fails} fail${a.fails === 1 ? '' : 's'}, ${a.warns} warn${a.warns === 1 ? '' : 's'}`;
const editLine = (e: WritingEdit) =>
  `- ${e.at.slice(0, 10)}: ${e.draftWords} words became ${e.finalWords}. Cut ${quoted(e.removed)}. Added ${quoted(e.added)}. Prose lint, draft ${lintSide(e.lintBefore)}; final ${lintSide(e.lintAfter)}.${e.note ? ` Note: ${e.note}` : ''}`;

export function registerWritingTools(server: McpServer, client: HildegardClient) {
  const guard =
    <A>(fn: (a: A) => Promise<CallToolResult>) =>
    async (a: A): Promise<CallToolResult> => {
      try {
        return await fn(a);
      } catch (e) {
        return fail((e as Error).message);
      }
    };

  server.registerTool(
    'writing_voice',
    {
      title: 'Read the writer’s voice',
      description:
        'Call this before you write or edit anything in a person’s own name (a post, an email, a page, a bio, a caption). It returns their voice notes (the rules Hildegard has learned from their own words and habits), the titles, ids and sizes of the samples of their writing (read their text with writing_voice_samples), a summary of their last 10 edits to drafts, and the 30 phrases they cut most often. Write the way the notes say, and leave out the phrases they keep cutting. It is the signed-in person’s own: other people here cannot read it, but the owner of this Hildegard can. If it is empty, ask them for a few things they have written and add them with writing_voice_add_sample.',
      inputSchema: {},
      annotations: {
        title: 'Read the writer’s voice',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    guard(async () => {
      const v = await client.writingVoice();
      const notes = v.voice.md.trim();
      return text(
        [
          notes
            ? `Voice notes (voice.md, changed ${v.voice.updatedAt?.slice(0, 10) ?? 'never'}; ${v.voice.versions} earlier ${v.voice.versions === 1 ? 'version' : 'versions'} kept):\n${notes}`
            : 'No voice notes yet. Read their samples with writing_voice_samples and the edits below, learn the rules, then save them with writing_voice_update.',
          v.samples.length
            ? `Samples of their writing (${v.samples.length}):\n${v.samples.map((s) => `- “${s.title}”, ${s.words} words, ${s.source}, id ${s.id}`).join('\n')}`
            : 'No samples yet. Ask for a few things they wrote themselves and add them with writing_voice_add_sample.',
          v.edits.length
            ? `Their last ${v.edits.length} ${v.edits.length === 1 ? 'edit' : 'edits'}, newest first:\n${v.edits.map(editLine).join('\n')}`
            : 'No edits recorded yet. When they change a draft you wrote, record it with writing_voice_record_edit.',
          v.topCut.length
            ? `Phrases they cut most often:\n${v.topCut.map((p) => `- “${p.phrase}”${p.count > 1 ? ` (${p.count} times)` : ''}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }),
  );

  server.registerTool(
    'writing_voice_samples',
    {
      title: 'Read the writer’s saved samples',
      description:
        'Call this to learn how the person writes from their own saved words: it returns the text of their samples, newest first, up to 20,000 characters in all, and says when it cut and how many it did not show. Give ids (from writing_voice) to read particular samples, up to the same limit per call. Use it before you write voice notes with writing_voice_update, and read the actual sentences: the rhythm, what they open and close with, which words they reach for. Quote phrases of theirs in the rules; never copy their sentences into your drafts. It is the signed-in person’s own and nobody else’s.',
      inputSchema: {
        ids: z
          .array(z.string().regex(/^[a-f0-9]{16}$/))
          .max(50)
          .optional()
          .describe('Sample ids from writing_voice. Leave out for the newest samples.'),
      },
      annotations: {
        title: 'Read the writer’s saved samples',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    guard(async (a: { ids?: string[] }) => {
      const ids = a.ids?.length ? a.ids : (await client.writingVoice()).samples.map((s) => s.id);
      if (!ids.length)
        return text(
          'No samples yet. Ask for a few things they wrote themselves and add them with writing_voice_add_sample.',
        );
      const parts: string[] = [];
      let used = 0;
      let cut = false;
      let shown = 0;
      for (const id of ids) {
        const room = SAMPLE_BUDGET - used;
        if (room < 500) break;
        const { sample: s } = await client.writingSample(id);
        const head = `### “${s.title}” (${s.words} words, ${s.source}, added ${s.addedAt.slice(0, 10)}, id ${s.id})\n`;
        const body =
          s.text.length > room - head.length
            ? `${s.text.slice(0, Math.max(0, room - head.length))}\n[cut here]`
            : s.text;
        if (body !== s.text) cut = true;
        parts.push(head + body);
        used += head.length + body.length;
        shown++;
      }
      const left = ids.length - shown;
      if (left > 0) cut = true;
      if (cut)
        parts.push(
          `Cut to fit ${SAMPLE_BUDGET.toLocaleString('en-US')} characters${left > 0 ? `; ${left} more ${left === 1 ? 'sample is' : 'samples are'} not shown` : ''}. Ask for the rest with writing_voice_samples and their ids.`,
        );
      return text(parts.join('\n\n'));
    }),
  );

  server.registerTool(
    'writing_voice_add_sample',
    {
      title: 'Add a sample of the writer’s own writing',
      description:
        'Call this when the person gives you something they wrote themselves (an essay, an email, a post, a letter) so Hildegard can learn how they sound. Send the whole text, up to 50,000 characters, with a title and where it came from. Only their own words: never add something you wrote, or someone else’s writing. They can keep 200 samples and remove any in Studio under Settings › Writing.',
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(200)
          .describe('What it is called, such as “Letter to the parish, March”.'),
        text: z.string().min(1).max(50_000).describe('Their writing, as plain text or Markdown.'),
        source: z
          .string()
          .max(200)
          .optional()
          .describe('Where it came from, such as “pasted” or “their blog”.'),
      },
      annotations: {
        title: 'Add a sample of the writer’s own writing',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async (a: { title: string; text: string; source?: string }) => {
      const { sample } = await client.addWritingSample(a);
      return text(
        `Added “${sample.title}” (${sample.words} words). Read writing_voice for what Hildegard has so far, and save new rules with writing_voice_update.`,
      );
    }),
  );

  server.registerTool(
    'writing_voice_record_edit',
    {
      title: 'Record how the writer changed a draft',
      description:
        'Call this every time the person edits a draft you wrote for them: send your draft and their final text. Hildegard works out the phrases they cut and added, counts the prose lint on both, and keeps the record, so the next draft needs fewer fixes. It changes nothing in their voice notes. After a few edits, read writing_voice, and if the same phrases keep going, write a rule for it with writing_voice_update. Each text can be up to 30,000 characters and 1,500 sentences; for a longer piece, send the part they changed, or send it in sections.',
      inputSchema: {
        draft: z.string().max(30_000).describe('Your draft, as you gave it to them.'),
        final: z.string().max(30_000).describe('The text as they left it.'),
        note: z.string().max(500).optional().describe('Anything they said about why, in a sentence.'),
      },
      annotations: {
        title: 'Record how the writer changed a draft',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async (a: { draft: string; final: string; note?: string }) => {
      const { edit: e } = await client.recordWritingEdit(a);
      return text(
        `Recorded. They cut ${quoted(e.removed)} and added ${quoted(e.added)}. Prose lint: draft ${lintSide(e.lintBefore)}; final ${lintSide(e.lintAfter)}. ${e.removed.length ? 'If they cut the same things before, add a rule for it with writing_voice_update.' : ''}`.trim(),
      );
    }),
  );

  server.registerTool(
    'writing_voice_update',
    {
      title: 'Replace the writer’s voice notes',
      description:
        'Call this to save what you have learned about how the person writes: send the whole new voice.md, up to 50,000 characters, and it replaces the old one (the old one is kept, the last 20 versions). Write short plain rules in their own words: what to do, what never to do, and a phrase or two from their samples for each. Read writing_voice first and keep the rules that still hold. Do not put anyone else’s words or private details in it.',
      inputSchema: {
        voice_md: z.string().max(50_000).describe('The complete voice notes, in Markdown.'),
      },
      annotations: {
        title: 'Replace the writer’s voice notes',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (a: { voice_md: string }) => {
      const { voice } = await client.setWritingVoice(a.voice_md);
      return text(
        `Saved the voice notes (${a.voice_md.trim().split(/\s+/).filter(Boolean).length} words). ${voice.versions} earlier ${voice.versions === 1 ? 'version is' : 'versions are'} kept.`,
      );
    }),
  );
}
