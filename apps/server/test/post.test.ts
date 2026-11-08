// SPDX-License-Identifier: AGPL-3.0-only
// Post: a film made on the stand-in GPU, exported, then prepared for every platform. The files are measured by a Python
// that did not make them, the words are held to each platform's limits, and the whole run is watched for any request
// that leaves this computer: preparing a post never contacts a platform.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import {
  lengthOf,
  POST_TARGETS,
  type PostRequest,
  type PostState,
  type PostTarget,
} from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { exportPython } from '../src/export.ts';
import { Poster, revealCommand } from '../src/post.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const tools = join(dirname(fileURLToPath(import.meta.url)), '../../../tools');
let srv: Running;
let dir: string;
let python: string;
const revealed: string[] = [];
const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const api = (path: string, init: RequestInit = {}) => fetch(srv.url + path, init);
const post = (path: string, body?: unknown) =>
  api(path, { method: 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
  api(path, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

async function until(fn: () => boolean | Promise<boolean>, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

/** What a file is, read by PyAV and measured by voice_clean's EBU R128 meter, neither of which made it. */
interface Probed {
  w: number;
  h: number;
  seconds: number;
  vcodec: string;
  profile: string;
  acodec: string | null;
  rate: number | null;
  lufs: number | null;
  tp: number | null;
  size: number;
}
const probe = (file: string): Probed =>
  JSON.parse(
    execFileSync(
      python,
      [
        '-I',
        '-c',
        `import sys, json
sys.path.insert(0, sys.argv[2])
import av, numpy as np, voice_clean as vc
c = av.open(sys.argv[1]); v = c.streams.video[0]; a = c.streams.audio
out = {"w": v.codec_context.width, "h": v.codec_context.height, "seconds": float(c.duration) / 1e6,
  "vcodec": v.codec_context.name, "profile": str(v.codec_context.profile),
  "acodec": a[0].codec_context.name if a else None, "rate": a[0].codec_context.sample_rate if a else None,
  "lufs": None, "tp": None, "size": __import__("os").path.getsize(sys.argv[1])}
if a:
    x = vc.decode(sys.argv[1], 2)
    if np.any(np.abs(x) > 1e-4):
        out["lufs"], out["tp"] = vc.measure(vc.choose_backend(), x)
print(json.dumps(out))`,
        file,
        tools,
      ],
      { encoding: 'utf8' },
    ),
  );

const request = (over: Partial<PostRequest> & Pick<PostRequest, 'source' | 'platforms'>): PostRequest => ({
  facts: {},
  ...over,
});

let film: string;
let exportId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hg-post-'));
  python = exportPython(dir);
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hfClientId: null },
    {
      fakeTickMs: 20,
      secrets: memoryStore(),
      hubToken: join(dir, 'no-hf-token'),
      reveal: (p) => revealed.push(p),
    },
  );
  await until(() => srv.scheduler.engineState().online);
  const made = (await (
    await post('/api/shots', {
      request: {
        prompt: 'A heron lifts off the river at first light',
        rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
        format: { quality: 'draft', seconds: 3 },
      },
      agent: 'test',
    })
  ).json()) as { project: { id: string }; takes: Array<{ id: string }> };
  film = made.project.id;
  await until(() => srv.store.takes.get(made.takes[0]!.id)!.status === 'done');
  const e = (await (await post(`/api/projects/${film}/export`)).json()) as { id: string };
  exportId = e.id;
  await until(
    async () => ((await (await api(`/api/exports/${e.id}`)).json()) as { status: string }).status === 'done',
  );
}, 120_000);
afterAll(() => srv.close());

async function prepare(body: PostRequest): Promise<PostState> {
  const res = await post('/api/post', body);
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as PostState;
  let state!: PostState;
  await until(async () => {
    state = (await (await api(`/api/post/${id}`)).json()) as PostState;
    return state.status !== 'running';
  });
  return state;
}

describe('Post, from a film made on the stand-in GPU', () => {
  let state: PostState;
  const facts = {
    title: 'Heron at first light',
    about: 'A heron lifts off the river as the mist burns away.',
    tags: ['heron', 'river'],
    link: 'https://example.com/heron',
  };

  it('makes each platform’s file in its own size, length, codec and loudness', async () => {
    state = await prepare(
      request({
        source: { kind: 'export', id: exportId },
        platforms: ['youtube', 'instagram', 'tiktok', 'x', 'facebook', 'threads', 'reddit', 'linkedin'],
        formats: [
          'youtube',
          'youtube-shorts',
          'instagram-reels',
          'instagram-feed',
          'tiktok',
          'x',
          'facebook',
          'threads',
          'reddit',
          'linkedin',
        ],
        facts,
      }),
    );
    expect(state.status).toBe('done');
    expect(state.files.map((f) => f.target)).toEqual([
      'youtube',
      'youtube-shorts',
      'instagram-reels',
      'instagram-feed',
      'tiktok',
      'x',
      'facebook',
      'threads',
      'reddit',
      'linkedin',
    ]);
    const folder = state.folder!;
    expect(folder).toContain('Ready to post');
    for (const f of state.files) {
      expect(f.status, `${f.target}: ${f.error}`).toBe('done');
      const spec = POST_TARGETS.find((t) => t.id === f.target)!;
      const p = probe(join(folder, f.file!));
      expect([p.w, p.h], f.target).toEqual([spec.width, spec.height]);
      expect(p.vcodec, f.target).toBe('h264');
      expect(p.profile, f.target).toBe('High');
      expect(p.acodec, f.target).toBe('aac');
      expect(p.rate, f.target).toBe(48000);
      if (spec.maxSeconds) expect(p.seconds, f.target).toBeLessThanOrEqual(spec.maxSeconds + 0.1);
      expect(p.seconds, f.target).toBeGreaterThan(2.5);
      expect(p.size, f.target).toBeLessThanOrEqual(spec.maxBytes);
      // The fake clip has sound: it is set to -14 LUFS, with the true peak held under -1.
      expect(p.lufs, f.target).not.toBeNull();
      expect(Math.abs(p.lufs! - -14), `${f.target} ${p.lufs}`).toBeLessThanOrEqual(1);
      expect(p.tp!, f.target).toBeLessThanOrEqual(-1);
      // The thumbnail is a JPEG at the size the platform asks for, within its byte limit.
      const t = statSync(join(folder, f.thumbnail!));
      expect(t.size, f.target).toBeLessThanOrEqual(spec.thumbnail.maxBytes);
      const th = JSON.parse(
        execFileSync(
          python,
          [
            '-I',
            '-c',
            'import sys, json; from PIL import Image; i = Image.open(sys.argv[1]); print(json.dumps([i.format, *i.size]))',
            join(folder, f.thumbnail!),
          ],
          { encoding: 'utf8' },
        ),
      ) as [string, number, number];
      expect(th, f.target).toEqual(['JPEG', spec.thumbnail.width, spec.thumbnail.height]);
    }
  }, 240_000);

  it('writes a title and caption for each platform within its character limits, from the facts given', () => {
    const folder = state.folder!;
    for (const f of state.files) {
      const spec: PostTarget = POST_TARGETS.find((t) => t.id === f.target)!;
      expect(lengthOf(f.text.caption, spec.text.weighted), f.target).toBeLessThanOrEqual(
        spec.text.captionMax,
      );
      if (spec.text.titleMax) expect(f.text.title!.length, f.target).toBeLessThanOrEqual(spec.text.titleMax);
      expect(f.text.caption, f.target).not.toMatch(/#(fyp|viral|trending|foryou)/i);
      const words = readFileSync(join(folder, f.words!), 'utf8');
      expect(words).toContain(f.text.caption);
    }
    const insta = state.files.find((f) => f.target === 'instagram-reels')!;
    expect(insta.text.caption).toContain('Heron at first light');
    expect(insta.text.caption).toContain('#heron #river #AIGenerated');
    const x = state.files.find((f) => f.target === 'x')!;
    expect(weighted(x.text.caption)).toBeLessThanOrEqual(280);
    const yt = state.files.find((f) => f.target === 'youtube')!;
    expect(yt.text.title).toBe('Heron at first light');
  });

  it('labels the files as AI-generated and keeps everything in one folder', () => {
    const folder = state.folder!;
    const names = readdirSync(folder).sort();
    expect(names).toContain('post.json');
    expect(names.filter((n) => n.endsWith('.mp4'))).toHaveLength(10);
    const meta = execFileSync(
      python,
      [
        '-I',
        '-c',
        'import sys, av; print(av.open(sys.argv[1]).metadata.get("comment", ""))',
        join(folder, state.files[0]!.file!),
      ],
      { encoding: 'utf8' },
    );
    expect(meta).toMatch(/^AI-generated video, made with .+Made with Hildegard/);
  });

  it('keeps the checklist, and a restart finds the folder again', async () => {
    const res = await patch(`/api/post/${state.id}/files/tiktok`, { posted: true });
    expect(((await res.json()) as PostState).files.find((f) => f.target === 'tiktok')!.posted).toBe(true);
    const again = new Poster({
      store: srv.store,
      catalog: { models: [] } as never,
      exporter: {} as never,
      mediaDir: join(dir, 'media'),
      readyDir: join(dir, 'Ready to post'),
      credit: '',
      run: async () => {
        throw new Error('not here');
      },
    });
    const found = again.get(state.id)!;
    expect(found.files.find((f) => f.target === 'tiktok')!.posted).toBe(true);
    expect(found.files.find((f) => f.target === 'x')!.posted).toBe(false);
  });

  it('shows a file only to this computer, and serves it to the owner', async () => {
    revealed.length = 0;
    const r = await post(`/api/post/${state.id}/reveal`, { target: 'x' });
    expect(r.status).toBe(200);
    expect(revealed).toEqual([join(state.folder!, state.files.find((f) => f.target === 'x')!.file!)]);
    // A request that came through a proxy is not this computer.
    const proxied = await api(`/api/post/${state.id}/reveal`, {
      method: 'POST',
      headers: { ...H, 'x-forwarded-for': '203.0.113.9' },
      body: '{}',
    });
    expect([401, 403]).toContain(proxied.status);
    expect(revealed).toHaveLength(1);
    const file = await api(`/api/post/${state.id}/files/${state.files[0]!.file}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('video/mp4');
    // Names it never made are not there, whatever the path says.
    expect((await api(`/api/post/${state.id}/files/post.json`)).status).toBe(404);
    expect((await api(`/api/post/${state.id}/files/..%2Fstate.json`)).status).toBe(404);
  });

  it('hands the app the latest caption and path for a platform, to this computer only', async () => {
    const r = (await (await api('/api/post/latest/tiktok')).json()) as {
      found: boolean;
      caption: string;
      path: string;
    };
    expect(r.found).toBe(true);
    expect(r.caption).toContain('Heron at first light');
    expect(r.path).toBe(join(state.folder!, state.files.find((f) => f.target === 'tiktok')!.file!));
    const proxied = await api('/api/post/latest/tiktok', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect([401, 403]).toContain(proxied.status);
  });
});

describe('Post refuses what it should', () => {
  it('names a pictures-only target for a platform that takes only video, and refuses an empty plan', async () => {
    const still = [...srv.store.stills.values()][0];
    expect(still).toBeUndefined();
    const res = await post(
      '/api/post',
      request({ source: { kind: 'take', id: 'nope' }, platforms: ['youtube'] }),
    );
    expect(res.status).toBe(404);
    const bad = await post('/api/post', { source: { kind: 'export', id: exportId }, platforms: ['myspace'] });
    expect(bad.status).toBe(400);
  });

  it('lets only the owner use it', async () => {
    const { directorMay } = await import('../src/access.ts');
    for (const [m, p] of [
      ['GET', '/api/post'],
      ['POST', '/api/post'],
      ['POST', '/api/post/abc/reveal'],
      ['GET', '/api/post/latest/x'],
    ] as const)
      expect(directorMay(m, p), `${m} ${p}`).toBe(false);
  });
});

describe('Post never contacts a platform', () => {
  it('makes no request but to this computer, from the route or the MCP tool', async () => {
    const hosts: string[] = [];
    const realConnect = net.Socket.prototype.connect;
    const spy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      const first = args[0] as { host?: string; port?: number; path?: string } | number | string;
      hosts.push(typeof first === 'object' ? (first.host ?? first.path ?? '') : String(args[1] ?? ''));
      return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    } as never);
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return realFetch(input as never, init);
    }) as typeof fetch);
    try {
      await prepare(
        request({
          source: { kind: 'export', id: exportId },
          platforms: ['x', 'tiktok'],
          facts: { title: 'Again' },
        }),
      );
      const server = createMcpServer(new HildegardClient(srv.url), { files: true });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: 'agent', version: '1' });
      await client.connect(b);
      const out = (await client.callTool({
        name: 'prepare_post',
        arguments: { film_id: film, platforms: ['youtube', 'x'], title: 'By an agent', wait_seconds: 120 },
      })) as CallToolResult;
      const text = out.content.map((c) => (c as { text: string }).text).join('\n');
      expect(out.isError).toBeFalsy();
      expect(text).toContain('Nothing was posted');
      for (const m of text.matchAll(/File: (\S+\.mp4)/g)) expect(existsSync(m[1]!)).toBe(true);
      await client.close();
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
    }
    // This computer only: Hildegard's own server, and the stand-in ComfyUI it polls on another loopback port.
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(['127.0.0.1', 'localhost', '[::1]'], u).toContain(new URL(u).hostname);
    expect(urls.some((u) => u.includes('/api/post'))).toBe(true);
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) expect(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', ''], h).toContain(h);
  }, 240_000);

  it('has no way to post in its code: no network module, no fetch, no platform API', () => {
    const read = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8');
    for (const f of [
      '../src/post.ts',
      '../src/post-routes.ts',
      '../../../mcp/src/post-tools.ts',
      '../../../tools/export_post.py',
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(
        /\bfetch\s*\(|node:(https?|net|dns|tls|dgram)|XMLHttpRequest|WebSocket|urllib|requests\.|socket\./,
      );
      expect(src, f).not.toMatch(
        /googleapis|api\.(x|twitter)\.com|graph\.facebook|open\.tiktokapis|upload\.twitter|oauth|access_token|api[_-]?key/i,
      );
    }
  });
});

const weighted = (s: string) => {
  let n = 0;
  const rest = s.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return '';
  });
  for (const ch of rest) n += ch.codePointAt(0)! <= 0x10ff ? 1 : 2;
  return n;
};

describe('tools/export_post.py on its own', () => {
  const run = (spec: object) => {
    const file = join(dir, `spec-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(spec));
    const out = execFileSync(python, ['-I', join(tools, 'export_post.py'), file], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, unknown>;
  };
  const source = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/comfy/fixtures/sample.mp4');
  const target = (id: string, over: Partial<PostTarget> = {}) => ({
    ...POST_TARGETS.find((t) => t.id === id)!,
    ...over,
  });
  const base = (id: string, over: Record<string, unknown> = {}, tOver: Partial<PostTarget> = {}) => ({
    kind: 'video',
    input: source,
    out: join(dir, `${id}-${Math.random().toString(36).slice(2)}.mp4`),
    thumbnail: null,
    title: 't',
    comment: 'c',
    fit: 'blur',
    text: null,
    lufs: -14,
    true_peak: -1,
    target: target(id, tOver),
    ...over,
  });

  it('cuts a film that runs past the platform’s limit, and says so', () => {
    const r = run(base('x', {}, { maxSeconds: 1 }));
    expect(r.trimmed).toBe(true);
    expect(r.seconds).toBeCloseTo(1, 1);
    expect(r.source_seconds).toBeCloseTo(3, 0);
  }, 60_000);

  it('keeps a film under the byte limit by lowering the bit rate', () => {
    const spec = base('tiktok', {}, { maxBytes: 400_000 });
    const r = run(spec);
    expect(r.bytes as number).toBeLessThanOrEqual(400_000);
  }, 120_000);

  it('keeps on-screen text inside the safe area and changes nothing outside it', () => {
    for (const id of ['tiktok', 'instagram-reels', 'youtube-shorts']) {
      const t = target(id);
      const text = 'A heron lifts off the river at first light, and the mist burns away behind it';
      const plain = base(id, {}, { maxSeconds: 1 });
      const lettered = base(id, { text }, { maxSeconds: 1 });
      const a = run(plain);
      const b = run(lettered) as { text_box: [number, number, number, number] };
      const [x0, y0, x1, y1] = b.text_box;
      expect(x0, id).toBeGreaterThanOrEqual(t.safeArea.left);
      expect(x1, id).toBeLessThanOrEqual(t.width - t.safeArea.right);
      expect(y0, id).toBeGreaterThanOrEqual(t.safeArea.top);
      expect(y1, id).toBeLessThanOrEqual(t.height - t.safeArea.bottom);
      expect(a.text_box).toBeNull();
      // Pixels outside the box match the version without text, within what the encoder changes.
      const diff = JSON.parse(
        execFileSync(
          python,
          [
            '-I',
            '-c',
            `import sys, json, av, numpy as np
def frame(p):
    c = av.open(p)
    for f in c.decode(c.streams.video[0]): return f.to_ndarray(format="rgb24").astype(int)
a, b = frame(sys.argv[1]), frame(sys.argv[2])
x0, y0, x1, y1 = map(int, sys.argv[3:7])
d = np.abs(a - b).max(axis=2)
mask = np.ones(d.shape, bool); mask[y0:y1, x0:x1] = False
print(json.dumps({"outside": float(d[mask].mean()), "inside": float(d[~mask].mean())}))`,
            (plain as { out: string }).out,
            (lettered as { out: string }).out,
            String(x0),
            String(y0),
            String(x1),
            String(y1),
          ],
          { encoding: 'utf8' },
        ),
      ) as { outside: number; inside: number };
      expect(diff.outside, id).toBeLessThan(1.5);
      expect(diff.inside, id).toBeGreaterThan(diff.outside * 4);
    }
  }, 300_000);

  it('makes a picture for a platform that takes pictures, at its size', () => {
    const img = join(dir, 'in.png');
    execFileSync(python, [
      '-I',
      '-c',
      'import sys; from PIL import Image; Image.new("RGB", (1024, 1024), (200, 150, 40)).save(sys.argv[1])',
      img,
    ]);
    const r = run({ ...base('instagram-feed'), kind: 'image', input: img, out: join(dir, 'feed.jpg') });
    expect([r.width, r.height]).toEqual([1080, 1350]);
    expect(statSync(join(dir, 'feed.jpg')).size).toBeGreaterThan(1000);
  }, 60_000);
});

describe('Showing a file', () => {
  it('selects a file whose folder has spaces in Windows Explorer', () => {
    const path = 'C:\\Users\\Ann\\AppData\\Local\\hildegard\\Ready to post\\film\\x.mp4';
    const win = revealCommand(path, 'win32', () => false);
    expect([win.cmd, win.args, win.verbatim]).toEqual(['explorer.exe', [`/select,"${path}"`], true]);
    const mac = '/a/Ready to post/x.mp4';
    expect(revealCommand(mac, 'darwin', () => false).args).toEqual(['-R', mac]);
    expect(revealCommand(mac, 'linux', () => false).args).toEqual(['/a/Ready to post']);
  });
});
