// SPDX-License-Identifier: AGPL-3.0-only
import { loadCatalog } from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer, HildegardClient, toRequest } from '../src/index.ts';

const { catalog } = loadCatalog();

/** A client whose server answers nothing: enough to see what the tools say, and what they refuse before asking. */
async function connect(remote: boolean) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith('/api/catalog')) return Response.json(catalog);
    if (url.endsWith('/api/snapshot'))
      return Response.json({ models: [], projects: [], takes: [], shots: [] });
    return Response.json({ error: 'not here' }, { status: 404 });
  }) as typeof fetch;
  const server = createMcpServer(new HildegardClient('https://studio.example', fetchFn), {
    ...(remote ? { remote: { link: (p: string) => `https://studio.example${p}?sig=x` } } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'unit', version: '1' });
  await client.connect(b);
  return { client, calls };
}

describe('toRequest', () => {
  it('names the ids that would work when one is wrong, so a small model can fix it in one step', () => {
    expect(() => toRequest({ prompt: 'x', lens: 'fisheye-9000' }, catalog, new Set())).toThrow(
      /Use one of: /,
    );
    const r = toRequest({ prompt: 'A cat sleeps' }, catalog, new Set());
    expect(r.rig.focal).toBe(35);
    expect(r.format?.quality).toBe('draft');
  });
});

describe('tools for an app on another device', () => {
  it('promise links, not paths', async () => {
    const { client } = await connect(true);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'get_shot')!.description).toContain('links');
    expect(tools.find((t) => t.name === 'export_film')!.description).toContain('link');
    await client.close();
  });

  it('refuse a start frame path, which would be read on the wrong computer, before uploading anything', async () => {
    const { client, calls } = await connect(true);
    const r = (await client.callTool({
      name: 'direct_shot',
      arguments: { prompt: 'A door opens', start_frame_path: '/etc/hosts' },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('start_frame_data');
    expect(calls.some((u) => u.includes('/api/uploads'))).toBe(false);
    await client.close();
  });

  it('refuse both kinds of start frame at once', async () => {
    const { client } = await connect(false);
    const r = (await client.callTool({
      name: 'direct_shot',
      arguments: { prompt: 'A door opens', start_frame_path: '/tmp/a.png', start_frame_data: 'AAAA' },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('not both');
    await client.close();
  });
});
