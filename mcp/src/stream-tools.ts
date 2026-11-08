// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Go live, for AI apps. An app may read how a stream is going and nothing more: starting or stopping one is the
 * owner's click in the Studio, because it uses their screen, camera and microphone and sends their stream key to a
 * service. `stream_start` and `stream_stop` say so (needs-owner) and make no request. No tool here returns a stream key
 * (the server never gives one to anyone), a device name or an address.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HildegardClient, StreamStatus } from './client.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

export function describeStream(s: StreamStatus): string {
  const where = s.destinations.filter((d) => d.enabled);
  const lines: string[] = [];
  switch (s.phase) {
    case 'live':
      lines.push(
        `Live for ${clock(s.seconds ?? 0)} on the ${s.scene} scene${s.recording ? ', and recording' : ''}.`,
      );
      break;
    case 'countdown':
      lines.push(`Going live in ${s.countdown} seconds.`);
      break;
    case 'reconnecting':
      lines.push(`Lost the connection; trying again (try ${s.attempt}).`);
      break;
    case 'preview':
      lines.push('Not live. The owner is setting up the picture.');
      break;
    case 'stopping':
      lines.push('Stopping.');
      break;
    default:
      lines.push('Not live.');
  }
  if (where.length)
    lines.push(
      `Destinations: ${where.map((d) => `${d.name} (${d.keySet ? d.state : 'no key yet'}${d.detail ? `: ${d.detail}` : ''})`).join(', ')}.`,
    );
  else lines.push('No destination is turned on.');
  if (s.phase === 'live') {
    const st = s.stats;
    lines.push(
      `Stats: ${st.kbps ?? '?'} kbps out, ${st.fps ?? '?'} fps, ${st.dropped} dropped frames${st.cpu !== null ? `, ${Math.round(st.cpu)}% of a core` : ''}${st.speed !== null && st.speed < 0.97 ? ' (the computer is falling behind real time)' : ''}.`,
    );
  }
  if (s.message) lines.push(s.message);
  return lines.join('\n');
}

export function registerStreamTools(server: McpServer, client: HildegardClient) {
  server.registerTool(
    'stream_status',
    {
      title: 'How is the stream going?',
      description:
        'Whether the owner is live, on which scene and to which services, how long, the bit rate, dropped frames and any problem. A read: it shows no stream keys, devices or addresses. You can’t start or stop a stream; the owner does that in Hildegard’s Studio, under Go live.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return text(describeStream(await client.streamStatus()));
      } catch (e) {
        return { ...text((e as Error).message), isError: true };
      }
    },
  );

  const needsOwner = (what: string, hint: string) =>
    text(
      `needs-owner: ${what} is the owner’s to do, with a click. ${hint} Tell them where to press it: Hildegard’s Studio, Go live, on the computer it runs on. Nothing was started or changed.`,
    );

  server.registerTool(
    'stream_start',
    {
      title: 'Go live (the owner’s click)',
      description:
        'Going live uses the owner’s screen, camera and microphone and sends their stream key to a service, so an AI app can’t start it. This returns needs-owner and makes no request. Tell the owner to open Go live in the Studio and press the button; stream_status then shows how it goes.',
      inputSchema: {
        note: z.string().max(200).optional().describe('Anything the owner should know before they press it.'),
      },
    },
    async () => {
      let ready = '';
      try {
        const s = await client.streamStatus();
        const on = s.destinations.filter((d) => d.enabled);
        const missing = on.filter((d) => !d.keySet).map((d) => d.name);
        ready = missing.length
          ? `They still need to add a stream key for ${missing.join(', ')}.`
          : on.length
            ? `Everything they turned on has a key saved (${on.map((d) => d.name).join(', ')}).`
            : 'They haven’t picked a destination yet.';
      } catch {}
      return needsOwner('Going live', ready);
    },
  );

  server.registerTool(
    'stream_stop',
    {
      title: 'Stop the stream (the owner’s click)',
      description:
        'Ending a stream is the owner’s Stop button in the Studio, so an AI app can’t do it. This returns needs-owner and makes no request.',
      inputSchema: {},
    },
    async () => needsOwner('Stopping the stream', 'The big Stop button on the Go live page always works.'),
  );
}
