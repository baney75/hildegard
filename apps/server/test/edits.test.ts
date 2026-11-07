// SPDX-License-Identifier: AGPL-3.0-only
// Video edits over REST and the MCP: whose edit is whose, what a director may name as footage, the real script behind the
// routes (render, contact sheet, the gate), a plan from a transcript, and the files /media serves. The script's own
// behavior is tested in video-edit.test.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import type { EditView } from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directorMay } from '../src/access.ts';
import { parseArgs } from '../src/config.ts';
import { exportPython } from '../src/export.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const RAW = { 'x-hildegard': '1', 'content-type': 'application/octet-stream' };
const PASS = 'a long and private passphrase';
const tools = join(__dirname, '..', '..', '..', 'tools');

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
async function until<T>(fn: () => Promise<T | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

const work = mkdtempSync(join(tmpdir(), 'hg-edits-'));
const dataDir = join(work, 'data');
const uiDir = join(work, 'ui');
let srv: Running;
let remote: string;
let clip: Buffer;
let clipPath: string;

const local = (path: string, method = 'GET', body?: unknown) =>
  fetch(srv.url + path, {
    method,
    headers: method === 'GET' ? {} : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const there = (cookie: string | null, path: string, method = 'GET', body?: unknown) =>
  fetch(remote + path, {
    method,
    headers: { ...(method === 'GET' ? {} : H), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function director(name: string): Promise<string> {
  const inv = (await (await local('/api/people/invites', 'POST', { role: 'director' })).json()) as {
    url: string;
  };
  const accept = await fetch(`${remote}/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name, passphrase: PASS }),
  });
  expect(accept.status).toBe(201);
  const res = await fetch(`${remote}/api/auth/signin`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name, passphrase: PASS }),
  });
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
}
const importClip = async (cookie: string | null) => {
  const res = await fetch(`${cookie ? remote : srv.url}/api/record/imports?kind=video`, {
    method: 'POST',
    headers: { ...RAW, ...(cookie ? { cookie } : {}) },
    body: clip,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const settled = (cookie: string | null, id: string) =>
  until(async () => {
    const v = (await (
      await (cookie ? there(cookie, `/api/edits/${id}`) : local(`/api/edits/${id}`))
    ).json()) as EditView;
    return v.job?.status === 'running' ? false : v;
  });

beforeAll(async () => {
  process.env.HILDEGARD_EDIT_ENCODER = 'libx264';
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Studio</title><div id="root"></div>');
  // The hosted listener's port is picked free and bound a moment later; another test file can take it in between.
  for (let attempt = 0; attempt < 4; attempt++) {
    const hostPort = await freePort();
    srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', dataDir, '--ui', uiDir]), port: 0, hostPort },
      {
        fakeTickMs: 20,
        secrets: memoryStore(),
        exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
        limits: { perName: 50, perClient: 1000 },
      },
    );
    remote = srv.hostedUrl() ?? '';
    if (remote) break;
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  expect((await local('/api/people/owner', 'POST', { name: 'Ada', passphrase: PASS })).status).toBe(201);
  // A small recording with sound: a voice, a pause, a voice.
  clipPath = join(work, 'clip.mp4');
  execFileSync(exportPython(dataDir), [
    '-I',
    '-c',
    `import sys; sys.path.insert(0, sys.argv[1])
from hgedit import selftest
selftest.write_recording(sys.argv[2], 6.0, 12, (320, 180), selftest.voice_track(6.0, [(0.3, 2.0), (4.0, 5.6)]), None)`,
    tools,
    clipPath,
  ]);
  clip = readFileSync(clipPath);
}, 60_000);
afterAll(() => srv.close());

describe('who may name what', () => {
  it('lets a director use only their own recordings, never a path', async () => {
    const bo = await director('Bo');
    const cy = await director('Cy');
    const boClip = await importClip(bo);
    // Their own recording: fine.
    const made = await there(bo, '/api/edits', 'POST', { title: 'Bo’s cut', source: `recording:${boClip}` });
    expect(made.status).toBe(201);
    const edit = (await made.json()) as EditView;
    expect(edit.check?.ok).toBe(true);
    expect(edit.check?.summary?.frames).toBe(72);
    // Somebody else's recording is answered as if it were not there, and so is a path on the computer.
    expect((await there(cy, '/api/edits', 'POST', { source: `recording:${boClip}` })).status).toBe(404);
    const path = await there(bo, '/api/edits', 'POST', { source: '/etc/passwd' });
    expect(path.status).toBe(403);
    expect(((await path.json()) as { error: string }).error).toContain('Only this computer may give a path');
    const sneak = await there(bo, '/api/edits', 'POST', {
      edl: { version: 1, sources: { a: { path: `recording:${boClip}` } }, music: { path: '/etc/passwd' } },
    });
    expect(sneak.status).toBe(403);
    const transcript = await there(bo, `/api/edits`, 'POST', {
      edl: {
        version: 1,
        sources: { a: { path: `recording:${boClip}` } },
        captions: { transcript: '../../../../etc/passwd' },
      },
    });
    expect(transcript.status).toBe(422);

    // Whose edit is whose: each sees their own; the owner and this computer see both; strangers are signed out.
    expect((await there(cy, `/api/edits/${edit.id}`)).status).toBe(404);
    expect((await there(cy, `/api/edits/${edit.id}`, 'DELETE')).status).toBe(404);
    expect(((await (await there(cy, '/api/edits')).json()) as { edits: unknown[] }).edits).toHaveLength(0);
    expect(((await (await there(bo, '/api/edits')).json()) as { edits: unknown[] }).edits).toHaveLength(1);
    expect((await local(`/api/edits/${edit.id}`)).status).toBe(200);
    expect((await there(null, `/api/edits/${edit.id}`)).status).toBe(401);
    expect((await there(null, '/api/edits', 'POST', {})).status).toBe(401);

    // This computer itself may give a path.
    const mine = await local('/api/edits', 'POST', { source: clipPath });
    expect(mine.status).toBe(201);
    expect(((await mine.json()) as EditView).check?.ok).toBe(true);
    // The owner's recording is not Bo's to use.
    const ownerClip = await importClip(null);
    expect((await there(bo, '/api/edits', 'POST', { source: `recording:${ownerClip}` })).status).toBe(404);
  }, 60_000);

  it('gives directors these routes and no others', () => {
    const id = 'ed_0123456789abcdef';
    for (const [m, p] of [
      ['GET', '/api/edits'],
      ['GET', `/api/edits/${id}`],
      ['GET', `/api/edits/${id}/words`],
      ['POST', '/api/edits'],
      ['POST', `/api/edits/${id}/render`],
      ['POST', `/api/edits/${id}/verify`],
      ['POST', `/api/edits/${id}/plan`],
      ['POST', `/api/edits/${id}/check`],
      ['PUT', `/api/edits/${id}/edl`],
      ['DELETE', `/api/edits/${id}`],
    ] as const)
      expect(directorMay(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [
      ['GET', '/api/edits/../people'],
      ['POST', `/api/edits/${id}/render/x`],
      ['PUT', '/api/edits'],
      ['DELETE', '/api/edits'],
      ['POST', '/api/edits/not-an-id/render'],
    ] as const)
      expect(directorMay(m, p), `${m} ${p}`).toBe(false);
  });
});

describe('an edit from a list to a proven video', () => {
  it('says what is wrong with a list by field, and renders and proves a good one', async () => {
    const bo = await director('Dee');
    const rec = await importClip(bo);
    const edit = (await (
      await there(bo, '/api/edits', 'POST', { source: `recording:${rec}` })
    ).json()) as EditView;
    // A list with an unknown field and a range past the end: saved, with every problem named.
    const bad = (await (
      await there(bo, `/api/edits/${edit.id}/edl`, 'PUT', {
        version: 1,
        sources: { a: { path: `recording:${rec}` } },
        keep: [{ start: 2, end: 99 }],
        fadeout: 2,
      })
    ).json()) as EditView;
    expect(bad.check?.ok).toBe(false);
    expect(bad.check?.errors.map((e) => e.path)).toContain('fadeout');
    expect(bad.check?.errors[0]?.message).toContain('Allowed:');

    const good = (await (
      await there(bo, `/api/edits/${edit.id}/edl`, 'PUT', {
        version: 1,
        sources: { a: { path: `recording:${rec}` } },
        keep: [
          { start: 0, end: 2.5 },
          { start: 3.5, end: 5.8 },
        ],
        blur: [{ start: 0.5, end: 1.5, box: [0.1, 0.1, 0.3, 0.1], style: 'solid' }],
        titles: [{ text: 'Hello', start: 0.2, end: 1.5 }],
        target: 'youtube',
        audio: { clean: 'no' },
      })
    ).json()) as EditView;
    expect(good.check?.ok).toBe(true);
    // Verify before render is refused with a reason.
    expect((await there(bo, `/api/edits/${edit.id}/verify`, 'POST', {})).status).toBe(409);

    const started = await there(bo, `/api/edits/${edit.id}/render`, 'POST', {
      encoder: 'libx264',
      workers: 1,
    });
    expect(started.status).toBe(202);
    expect(((await started.json()) as EditView).job?.status).toBe('running');
    // One job at a time on an edit.
    expect((await there(bo, `/api/edits/${edit.id}/render`, 'POST', {})).status).toBe(409);
    const done = await settled(bo, edit.id);
    expect(done.job?.status, done.job?.error ?? '').toBe('done');
    expect(done.render?.frames).toBe(30 + 28);
    expect(done.render?.audioTracks).toBe(2);
    expect(done.render?.sheetUrl).toContain(`/media/edits/`);
    expect(done.render?.file).toBeNull(); // a path on disk is for this computer only

    // The video and the sheet are Dee’s: she gets them, a stranger and another director don't.
    const mp4 = await there(bo, done.render!.url);
    expect(mp4.status).toBe(200);
    expect(mp4.headers.get('content-type')).toBe('video/mp4');
    expect((await there(bo, done.render!.sheetUrl!)).headers.get('content-type')).toBe('image/jpeg');
    expect((await there(null, done.render!.url)).status).toBe(401);
    const cy = await director('Eve');
    expect((await there(cy, done.render!.url)).status).toBe(404);
    expect((await local(done.render!.url)).status).toBe(200);
    expect((await local(done.render!.url.replace('out.mp4', 'edit.json'))).status).toBe(404);
    expect((await local(done.render!.url.replace('out.mp4', 'edl.run.json'))).status).toBe(404);

    // The gate, on the output.
    const v = (await (await there(bo, `/api/edits/${edit.id}/verify`, 'POST', {})).json()) as EditView;
    expect(v.job?.kind).toBe('verify');
    const proven = await settled(bo, edit.id);
    expect(proven.verify?.ok, JSON.stringify(proven.verify)).toBe(true);
    expect(proven.verify?.checks.find((c) => c.id === 'frames')).toMatchObject({ status: 'pass' });

    // Change the list after rendering and the old output no longer proves it.
    await there(bo, `/api/edits/${edit.id}/edl`, 'PUT', {
      version: 1,
      sources: { a: { path: `recording:${rec}` } },
      keep: [{ start: 0, end: 5 }],
    });
    await there(bo, `/api/edits/${edit.id}/verify`, 'POST', {});
    const stale = await settled(bo, edit.id);
    expect(stale.verify?.ok).toBe(false);
    expect(stale.verify?.checks.find((c) => c.id === 'frames')?.status).toBe('fail');

    // The owner’s computer sees where it is on disk.
    const own = (await (await local(`/api/edits/${edit.id}`)).json()) as EditView;
    expect(own.render?.file).toMatch(/out\.mp4$/);
    expect(existsSync(own.render!.file!)).toBe(true);

    expect((await there(bo, `/api/edits/${edit.id}`, 'DELETE')).status).toBe(200);
    expect((await there(bo, `/api/edits/${edit.id}`)).status).toBe(404);
  }, 180_000);

  it('plans from a transcript: cuts the filler, keeps the words that were not deleted, and gives the text to cut from', async () => {
    const rec = await importClip(null);
    const edit = (await (
      await local('/api/edits', 'POST', { source: `recording:${rec}` })
    ).json()) as EditView;
    const transcript = {
      language: 'en',
      segments: [
        {
          start: 0,
          end: 5.6,
          text: '',
          words: [
            { start: 0.3, end: 0.8, word: 'Welcome' },
            { start: 0.8, end: 1.2, word: 'back.' },
            { start: 1.4, end: 1.7, word: 'Um,' },
            { start: 2.5, end: 2.9, word: 'today' },
            { start: 4.0, end: 4.4, word: 'we' },
            { start: 4.4, end: 4.9, word: 'build' },
            { start: 4.9, end: 5.5, word: 'this.' },
          ],
        },
      ],
    };
    const r = await local(`/api/edits/${edit.id}/plan`, 'POST', { transcript, pauses: false });
    expect(r.status).toBe(202);
    const v = await settled(null, edit.id);
    expect(v.job?.status, v.job?.error ?? '').toBe('done');
    const cuts = (v.edl.cuts as Array<{ start: number; end: number; why: string }>) ?? [];
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.why).toContain('filler');
    expect(cuts[0]!.start).toBeCloseTo(1.25, 2);
    expect(cuts[0]!.end).toBeCloseTo(2.45, 2);
    expect(v.edl.sources).toEqual({ a: { path: `recording:${rec}` } }); // never a path
    expect(JSON.stringify(v.edl)).not.toContain(work);
    expect(v.check?.ok).toBe(true);
    expect((v.plan as { filler_cuts: number }).filler_cuts).toBe(1);
    const words = await (await local(`/api/edits/${edit.id}/words`)).text();
    expect(words).toContain('[0.3] Welcome back.');
    expect(words).toContain('[1.4] Um, today');
    // Deleting "Welcome back." in the text cuts exactly those two words.
    await local(`/api/edits/${edit.id}/plan`, 'POST', {
      text: words.replace('[0.3] Welcome back.', ''),
      pauses: false,
    });
    const v2 = await settled(null, edit.id);
    const c2 = (v2.edl.cuts as Array<{ start: number; end: number; why: string }>).find((c) =>
      c.why.includes('deleted'),
    );
    expect(c2).toBeTruthy();
    expect(c2!.start).toBeCloseTo(0, 2);
    expect(c2!.end).toBeCloseTo(2.45, 2); // the filler right after it joins the same cut
    // Without a voice studio's help a director can't make the server transcribe.
    const bo = await director('Fay');
    const own = (await (
      await there(bo, '/api/edits', 'POST', { source: `recording:${await importClip(bo)}` })
    ).json()) as EditView;
    const t = await there(bo, `/api/edits/${own.id}/plan`, 'POST', {});
    expect(t.status).toBe(409);
    expect(((await t.json()) as { error: string }).error).toContain('voice studio');
  }, 120_000);
});

describe('the MCP tools', () => {
  it('plan, write, render and verify an edit, and look at the contact sheet', async () => {
    const server = createMcpServer(new HildegardClient(srv.url), { files: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (r: CallToolResult) =>
      r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    try {
      const plan = await call('edit_plan', {
        source_path: clipPath,
        transcribe: false,
        keep_pauses: false,
        title: 'agent cut',
      });
      expect(plan.isError, text(plan)).toBeFalsy();
      const id = /Edit (ed_[0-9a-f]{16})/.exec(text(plan))![1]!;
      expect(text(plan)).toContain('Edit list:');

      const bad = await call('edit_write', {
        edit_id: id,
        edl: { version: 1, sources: { a: { path: 'recording:rec_0000000000000000' } } },
      });
      expect(bad.isError).toBe(true);
      const own = (await (await local(`/api/edits/${id}`)).json()) as EditView;
      const src = (own.edl.sources as { a: { path: string } }).a.path;
      const wrote = await call('edit_write', {
        edit_id: id,
        edl: { version: 1, sources: { a: { path: src } }, keep: [{ start: 0, end: 2.4 }], keep_all: true },
      });
      expect(text(wrote)).toContain('keep_all');
      expect(text(wrote)).toContain('problems');
      const good = await call('edit_write', {
        edit_id: id,
        edl: {
          version: 1,
          sources: { a: { path: src } },
          keep: [{ start: 0, end: 2.4 }],
          audio: { clean: 'no' },
        },
      });
      expect(text(good)).toContain('a good edit list');

      const rendered = await call('edit_render', { edit_id: id, encoder: 'libx264' });
      expect(rendered.isError, text(rendered)).toBeFalsy();
      expect(rendered.content.some((c) => c.type === 'image')).toBe(true);
      const file = /File: (\S+out\.mp4)/.exec(text(rendered))![1]!;
      expect(existsSync(file)).toBe(true);

      const verified = await call('edit_verify', { edit_id: id });
      expect(verified.isError, text(verified)).toBeFalsy();
      expect(text(verified)).toContain('the output matches the edit list');
      expect(text(await call('edit_status', { edit_id: id }))).toContain('Gate: passed');
    } finally {
      await client.close();
    }
  }, 180_000);
});
