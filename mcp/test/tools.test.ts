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

describe('characters', () => {
  const mara = {
    id: '0123456789abcdef',
    name: 'Mara',
    description: 'Early thirties',
    wardrobe: '',
    references: [{ file: `${'a'.repeat(64)}.png`, view: 'portrait', source: 'still', addedAt: '' }],
    cover: `${'a'.repeat(64)}.png`,
    voice: null,
    likeness: 'invented',
    consent: null,
    createdAt: '',
    updatedAt: '',
  };
  const anna = {
    ...mara,
    id: 'fedcba9876543210',
    name: 'Anna',
    likeness: 'real',
    consent: {
      status: 'waiting',
      person: null,
      expiresAt: null,
      givenAt: null,
      revokedAt: null,
      certificate: null,
    },
  };
  async function withCharacters() {
    const sent: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ url, body });
      if (url.endsWith('/api/catalog')) return Response.json(catalog);
      if (url.endsWith('/api/snapshot'))
        return Response.json({
          models: [],
          projects: [],
          takes: [],
          shots: [],
          characters: [mara, anna],
          stills: [],
        });
      if (url.endsWith('/api/characters')) return Response.json({ ...mara, ...body, id: '1111111111111111' });
      if (url.endsWith('/api/shots')) return Response.json({ error: 'stop here' }, { status: 418 });
      return Response.json({ error: 'not here' }, { status: 404 });
    }) as typeof fetch;
    const server = createMcpServer(new HildegardClient('https://studio.example', fetchFn), {});
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'unit', version: '1' });
    await client.connect(b);
    return { client, sent };
  }
  const call = (client: Client, name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  it('casts by name, and sends the id', async () => {
    const { client, sent } = await withCharacters();
    await call(client, 'direct_shot', { prompt: 'Mara walks the rows', characters: ['mara'] });
    const shot = sent.find((s) => s.url.endsWith('/api/shots'));
    expect((shot!.body as { request: { characters: string[] } }).request.characters).toEqual([mara.id]);
    await client.close();
  });

  it('refuses an unknown character with the ones that exist, and a real person who hasn’t consented', async () => {
    const { client, sent } = await withCharacters();
    const unknown = await call(client, 'direct_shot', { prompt: 'x', characters: ['Konrad'] });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain(`${mara.id} (Mara)`);
    const real = await call(client, 'direct_shot', { prompt: 'x', characters: ['Anna'] });
    expect(real.isError).toBe(true);
    expect(JSON.stringify(real.content)).toContain('hasn’t consented');
    const both = await call(client, 'direct_shot', {
      prompt: 'x',
      characters: ['Mara'],
      start_frame_data: 'AAAA',
    });
    expect(JSON.stringify(both.content)).toContain('not both');
    expect(sent.some((s) => s.url.endsWith('/api/shots'))).toBe(false);
    await client.close();
  });

  it('makes only invented characters: a real person consents for themselves', async () => {
    const { client, sent } = await withCharacters();
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === 'create_character')!;
    expect(Object.keys(create.inputSchema.properties ?? {})).not.toContain('likeness');
    expect(create.description).toContain('consent');
    await call(client, 'create_character', { name: 'Brother Konrad', portraits: 0 });
    expect(sent.find((s) => s.url.endsWith('/api/characters'))?.body).toMatchObject({
      name: 'Brother Konrad',
      likeness: 'invented',
    });
    const list = await call(client, 'list_characters', {});
    expect(JSON.stringify(list.content)).toContain('Ready to cast');
    expect(JSON.stringify(list.content)).toContain('(real person)');
    await client.close();
  });
});
