// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, parseArgs, type Running, startServer } from '@hildegard/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, HildegardClient } from '../src/index.ts';

let srv: Running;
let client: Client;
let dir: string;

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hg-mcp-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
    { fakeTickMs: 20, secrets: fileStore(join(dir, 'secret.json')) },
  );
  const server = createMcpServer(new HildegardClient(srv.url));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  await srv.close();
});

describe('Hildegard MCP server', () => {
  it('offers the tools an agent needs, with instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'direct_shot',
      'get_shot',
      'hildegard_status',
      'install_model',
      'list_presets',
      'make_sequence',
      'shot_status',
    ]);
    expect(client.getInstructions()).toContain('hildegard_status');
  });

  it('reports status and presets in words a small model can act on', async () => {
    const status = textOf(await call('hildegard_status'));
    expect(status).toContain('stand-in GPU');
    expect(status).toContain('wan-2-2-ti2v-5b');
    const presets = textOf(await call('list_presets'));
    expect(presets).toMatch(/camera_body:\n- \S+: /);
    expect(presets).toContain('focal_mm: ');
  });

  it('directs a shot and returns the finished video with a still', async () => {
    const r = await call('direct_shot', {
      prompt: 'A heron lifts off the river at first light',
      camera_body: 'vintage-16mm',
      motion: ['dolly-in'],
      seconds: 3,
      takes: 2,
      wait: true,
    });
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t.match(/done\. Video: (\S+\.mp4)/g)).toHaveLength(2);
    const path = /done\. Video: (\S+\.mp4)/.exec(t)![1]!;
    expect(existsSync(path)).toBe(true);
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(2);
    // The takes are labelled with the agent that asked for them.
    const take = [...srv.store.takes.values()].find((x) => x.request.prompt.startsWith('A heron'))!;
    expect(take.source).toEqual({ kind: 'agent', name: 'test-agent' });
    expect(take.priority).toBe('agent');
  });

  it('corrects a wrong id with the ids that would work', async () => {
    const r = await call('direct_shot', { prompt: 'x', lens: 'fisheye-9000' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Unknown lens "fisheye-9000"\. Use one of: .*anamorphic/);
  });

  it('starts from an image on disk', async () => {
    const png = join(dir, 'frame.png');
    writeFileSync(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const r = await call('direct_shot', { prompt: 'The photograph comes to life', start_frame_path: png });
    expect(r.isError).toBeFalsy();
    const shotId = /Directed shot (\w+)/.exec(textOf(r))![1]!;
    const status = textOf(await call('get_shot', { shot_id: shotId, wait_seconds: 30 }));
    expect(status).toContain('done. Video:');
    expect([...srv.store.takes.values()].find((t) => t.shotId === shotId)!.request.startFrame).toMatch(
      /\.png$/,
    );
  });

  it('makes a sequence of shots, in order, in one film', async () => {
    const r = await call('make_sequence', {
      title: 'Morning on the river',
      shots: [
        { prompt: 'Mist hangs over the still water', seconds: 2 },
        { prompt: 'A rowing boat drifts into frame', seconds: 2, motion: ['truck-left'] },
      ],
      wait: true,
    });
    expect(r.isError).toBeFalsy();
    const filmId = /Film (\w+)/.exec(textOf(r))![1]!;
    const film = srv.store.projects.get(filmId)!;
    expect(film.title).toBe('Morning on the river');
    expect(film.shotIds.map((id) => srv.store.shots.get(id)!.prompt)).toEqual([
      'Mist hangs over the still water',
      'A rowing boat drifts into frame',
    ]);
    expect(textOf(r).match(/done\. Video/g)).toHaveLength(2);
  });

  it('shows the license and never installs without the user accepting it', async () => {
    const r = textOf(await call('install_model', { model: 'wan-2-2-ti2v-5b' }));
    expect(r).toContain('Apache-2.0');
    expect(r).toContain('accept_license: true');
    expect(srv.models.licenseAccepted('wan-2-2-ti2v-5b')).toBe(false);
  });

  it('says plainly when Hildegard is not running', async () => {
    const lone = createMcpServer(new HildegardClient('http://127.0.0.1:9'));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await lone.connect(a);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(b);
    const r = (await c.callTool({ name: 'hildegard_status', arguments: {} })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('hildegard start');
    await c.close();
  });
});
