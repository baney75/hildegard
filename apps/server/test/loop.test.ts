// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileStore, parseArgs, type Running, startServer } from '../src/index.ts';
import { sniff } from '../src/loop.ts';

let srv: Running;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

/** A closed box as OBJ text, sitting on z = 0, `w` × `d` × `h` millimetres; `open` leaves the top off. */
function box(w: number, d: number, h: number, open = false) {
  const v = [
    [0, 0, 0],
    [w, 0, 0],
    [w, d, 0],
    [0, d, 0],
    [0, 0, h],
    [w, 0, h],
    [w, d, h],
    [0, d, h],
  ];
  const quads = [
    [1, 4, 3, 2], // bottom, facing down
    [5, 6, 7, 8], // top
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 4, 8, 7],
    [4, 1, 5, 8],
  ].filter((_, i) => !(open && i === 1));
  return `# a box\n${v.map((p) => `v ${p.join(' ')}`).join('\n')}\n${quads.map((q) => `f ${q.join(' ')}`).join('\n')}\n`;
}

const answers = (ids: string[], answer: 'yes' | 'no' = 'yes') =>
  ids.map((id) => ({ id, answer, evidence: 'front and three-quarter views, and the checks' }));
const QUESTIONS = [
  'intent',
  'silhouette',
  'proportion',
  'hierarchy',
  'surface',
  'life',
  'base',
  'near',
  'looked',
  'people',
];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-loop-'));
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0 },
    { fakeTickMs: 20, secrets: fileStore(join(dir, 'secret.json')) },
  );
  const server = createMcpServer(new HildegardClient(srv.url));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'codex-test', version: '1.0.0' });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  await srv.close();
});

describe('sniff', () => {
  it('reads what a file is from its bytes, not its name', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniff(enc(box(1, 1, 1)))).toBe('obj');
    expect(sniff(enc(`o lid\n${box(1, 1, 1)}`))).toBe('obj');
    expect(sniff(enc('solid x\n facet normal 0 0 1\n'))).toBe('stl');
    expect(sniff(enc('glTF\x02\0\0\0'))).toBe('glb');
    expect(sniff(enc('{"asset":{"version":"2.0"}}'))).toBe('gltf');
    expect(sniff(enc('#!/bin/sh\nrm -rf /\n'))).toBeNull();
    expect(sniff(enc('import bpy\n'))).toBeNull();
  });
});

describe('a 3D model loop over MCP', { timeout: 120_000 }, () => {
  it('measures each round, draws it, and won’t take the next round before the critique', async () => {
    const start = textOf(
      await call('loop_start', {
        kind: 'model',
        title: 'Desk box',
        for: 'a 3D print for my desk',
        what: 'a small box to hold pencils',
        specifics: ['40 mm square', 'walls you can see'],
        print: true,
        size_mm: [40, 40, 60],
      }),
    );
    const id = /Loop (\w{16})/.exec(start)![1]!;
    expect(start).toContain('silhouette');

    // Round 1: open at the top, so not watertight, and too short for the brief.
    const r1 = await call('loop_submit', {
      loop_id: id,
      note: 'Blocked out the box',
      text: box(40, 40, 30, true),
    });
    expect(r1.isError).toBeFalsy();
    const t1 = textOf(r1);
    expect(t1).toMatch(/FAIL watertight/);
    expect(t1).toMatch(/FAIL size/);
    const img = r1.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined;
    expect(img?.mimeType).toBe('image/jpeg');
    expect(Buffer.from(img!.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    // No second round before the first is critiqued.
    const early = await call('loop_submit', { loop_id: id, note: 'again', text: box(40, 40, 60) });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toContain('Critique round 1 first');

    // Every question must be answered; a yes can't hide a failing check.
    const partial = await call('loop_critique', { loop_id: id, round: 1, answers: answers(['intent']) });
    expect(partial.isError).toBe(true);
    expect(textOf(partial)).toContain('silhouette');
    const noChange = await call('loop_critique', { loop_id: id, round: 1, answers: answers(QUESTIONS) });
    expect(noChange.isError).toBe(true);
    expect(textOf(noChange)).toContain('one thing');
    const c1 = textOf(
      await call('loop_critique', {
        loop_id: id,
        round: 1,
        answers: answers(QUESTIONS),
        change: 'Close the top and make it 60 mm tall',
      }),
    );
    expect(c1).toContain('Revise');
    expect(c1).toContain('watertight');

    // Round 2 passes, and can be delivered once critiqued.
    const t2 = textOf(
      await call('loop_submit', { loop_id: id, note: 'Closed and taller', text: box(40, 40, 60) }),
    );
    expect(t2).not.toMatch(/FAIL/);
    const c2 = textOf(await call('loop_critique', { loop_id: id, round: 2, answers: answers(QUESTIONS) }));
    expect(c2).toContain('Finish the loop with round 2');
    const done = textOf(
      await call('loop_finish', { loop_id: id, round: 2, note: 'A closed 40 × 40 × 60 mm box; no lid yet.' }),
    );
    expect(done).toContain('finished with round 2');
    const status = textOf(await call('loop_status', { loop_id: id }));
    expect(status).toContain('done, delivered round 2');
    const after = await call('loop_submit', { loop_id: id, note: 'more', text: box(40, 40, 60) });
    expect(after.isError).toBe(true);
  });

  it('refuses a script and anything else that isn’t a model, before reading it', async () => {
    const id = /Loop (\w{16})/.exec(
      textOf(
        await call('loop_start', {
          kind: 'model',
          title: 'Script',
          for: 'a test',
          what: 'a script pretending to be a model',
          specifics: ['none'],
        }),
      ),
    )![1]!;
    const r = await call('loop_submit', {
      loop_id: id,
      note: 'try',
      text: 'import bpy\nbpy.ops.wm.quit_blender()\n',
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('GLB');
  });
});

describe('skills over MCP', () => {
  it('lists and reads them, and never reads outside a skill', async () => {
    const list = textOf(await call('list_skills'));
    expect(list).toContain('- hildegard:');
    expect(list).toContain('hildegard-3d');
    const three = textOf(await call('read_skill', { name: 'hildegard-3d' }));
    expect(three).toContain('loop_start');
    const ref = await call('read_skill', { name: 'hildegard', file: 'references/sculpture-3d.md' });
    expect(ref.isError).toBeFalsy();
    for (const file of ['../hildegard-craft/SKILL.md', '../../package.json', '/etc/hosts'])
      expect((await call('read_skill', { name: 'hildegard', file })).isError).toBe(true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('hildegard');
    const p = await client.getPrompt({ name: 'hildegard-3d', arguments: { request: 'a heron' } });
    expect(JSON.stringify(p.messages)).toContain('a heron');
  });
});
