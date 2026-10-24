// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      'cancel_take',
      'direct_shot',
      'export_film',
      'get_shot',
      'hildegard_status',
      'install_model',
      'list_presets',
      'make_sequence',
      'review_prompt',
      'review_take',
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

  it('reviews a prompt before rendering, and says what to write instead', async () => {
    const bad = textOf(await call('review_prompt', { prompt: 'epic sunset, 8k, masterpiece, cinematic, hdr' }));
    expect(bad).toMatch(/^Fix these before rendering:/);
    expect(bad).toContain('quality-words (8k, hdr, masterpiece, epic, cinematic)');
    const good = textOf(
      await call('review_prompt', {
        prompt:
          'A night nurse in green scrubs pauses at a rain-streaked window at the end of the ward and rubs her eyes before the next round.',
      }),
    );
    expect(good).toMatch(/^No problems found/);
    // direct_shot still renders, and passes the advice along for the next shot.
    const r = textOf(await call('direct_shot', { prompt: 'epic dragon, 8k, masterpiece, trending on artstation' }));
    expect(r).toMatch(/Directed shot \w+/);
    expect(r).toContain('About the prompt (review_prompt explains): quality-words');
  });

  it('reviews a finished take with checks, a contact sheet and the questions to answer', async () => {
    await call('direct_shot', {
      prompt: 'A lighthouse keeper winds the clockwork lamp at dusk while the beam sweeps the grey sea below',
      wait: true,
    });
    const id = [...srv.store.takes.values()].findLast((t) => t.prompt.startsWith('A lighthouse keeper winds'))!.id;
    const review = await call('review_take', { take_id: id });
    expect(review.isError).toBeFalsy();
    expect(textOf(review)).toMatch(new RegExp(`^Take ${id}\\. Technical checks`));
    expect(review.content.some((c) => c.type === 'image')).toBe(true);
    expect(textOf(review)).toContain('Answer each, one line each');
    expect(textOf(review)).toContain('anatomy:');
    const missing = await call('review_take', { take_id: 'nope' });
    expect(missing.isError).toBe(true);
  }, 60_000);

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
    // And joined into one file.
    const exported = await call('export_film', { film_id: filmId, wait_seconds: 60 });
    expect(exported.isError).toBeFalsy();
    const path = /at (\S+\.mp4)\./.exec(textOf(exported))![1]!;
    expect(readFileSync(path).subarray(4, 8).toString()).toBe('ftyp');
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

  it('puts a shot in a film named by title, reusing it, or by id', async () => {
    const first = textOf(
      await call('direct_shot', { prompt: 'A door opens', seconds: 1, film: 'Agent Cut' }),
    );
    const [, filmId, title] = /in film (\w+) "([^"]+)"/.exec(first)!;
    expect(title).toBe('Agent Cut');
    expect(srv.store.projects.get(filmId!)!.title).toBe('Agent Cut');
    // The same title again lands in the same film, and so does its id.
    const again = textOf(
      await call('direct_shot', { prompt: 'A door closes', seconds: 1, film: 'Agent Cut' }),
    );
    expect(again).toContain(`in film ${filmId} "Agent Cut"`);
    const byId = textOf(await call('direct_shot', { prompt: 'The hall is empty', seconds: 1, film: filmId }));
    expect(byId).toContain(`in film ${filmId} "Agent Cut"`);
    expect(srv.store.projects.get(filmId!)!.shotIds).toHaveLength(3);
    expect([...srv.store.projects.values()].filter((p) => p.title === 'Agent Cut')).toHaveLength(1);
    // Status names the film too.
    const shotId = /Directed shot (\w+)/.exec(byId)![1]!;
    expect(textOf(await call('shot_status', { shot_id: shotId }))).toMatch(
      new RegExp(`^Shot ${shotId} ".+" in film ${filmId} "Agent Cut"`),
    );
    // Without a film, a new untitled one.
    const lone = textOf(await call('direct_shot', { prompt: 'Rain on glass', seconds: 1 }));
    expect(lone).toMatch(/in film \w+ "Untitled film"/);
    expect(lone).not.toContain(filmId);
  });

  it('lists recent takes and cancels one the way the Studio does', async () => {
    // Paused, so the take is still waiting when we cancel it.
    srv.scheduler.setPaused(true);
    const r = textOf(
      await call('direct_shot', { prompt: 'A long tracking shot', seconds: 2, film: 'Cancel me' }),
    );
    const takeId = /queued \((\w+)\)/.exec(r)![1]!;
    const status = textOf(await call('hildegard_status', { recent_takes: 3 }));
    expect(status).toContain('Recent takes');
    expect(status).toMatch(new RegExp(`- ${takeId}: (waiting|rendering).* in film \\w+ "Cancel me"`));
    expect(
      status.split('\n').filter((l) => /^- \w+: (waiting|rendering|done|failed|canceled)/.test(l)),
    ).toHaveLength(3);
    const canceled = await call('cancel_take', { take_id: takeId, reason: 'queued twice' });
    expect(canceled.isError).toBeFalsy();
    expect(textOf(canceled)).toMatch(
      new RegExp(
        `^Canceled take ${takeId} \\(take 1 of shot \\w+ ".+" in film \\w+ "Cancel me"\\): queued twice\\.$`,
      ),
    );
    expect(srv.store.takes.get(takeId)!.status).toBe('canceled');
    // Same rules as the API: a finished take stays as it is.
    const again = await call('cancel_take', { take_id: takeId });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('already finished (canceled)');
    const missing = await call('cancel_take', { take_id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('hildegard_status lists recent takes');
    srv.scheduler.setPaused(false);
  });
});
