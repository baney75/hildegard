// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmDirectResult, LlmEndpoint, LlmState, Snapshot } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { endpointUrl, jsonFrom, knownEndpoints } from '../src/llm.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };

/** What the stand-in runtimes were asked, and the chat answers queued for them. */
const asked: Array<{ url: string; auth: string | null; body?: Record<string, unknown> }> = [];
let replies: Array<(body: Record<string, unknown>) => Response> = [];
const toolCall = (name: string, args: Record<string, unknown>) =>
  Response.json({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
const say = (content: string) => Response.json({ choices: [{ message: { role: 'assistant', content } }] });

/**
 * Ollama on 11434, LM Studio on 1234, llama.cpp on 8080, Local AI's gateway on its Docker address, and nothing
 * anywhere else: a refused connection, as when no app listens.
 */
const fakeRuntimes = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const auth = new Headers(init.headers).get('authorization');
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  asked.push({ url, auth, body });
  if (url === 'http://127.0.0.1:11434/api/tags')
    return Response.json({
      models: [{ name: 'qwen3:8b', size: 5_200_000_000 }, { name: 'nomic-embed-text' }],
    });
  if (url === 'http://127.0.0.1:1234/api/v0/models')
    return Response.json({
      data: [
        { id: 'gemma-4-12b', type: 'llm', state: 'loaded', max_context_length: 32768 },
        { id: 'text-embedding-nomic', type: 'embeddings', state: 'not-loaded' },
      ],
    });
  if (url === 'http://127.0.0.1:8080/v1/models') return Response.json({ data: [{ id: 'llama-4-scout-q4' }] });
  if (url === 'http://127.0.0.1:8080/props') return Response.json({ default_generation_settings: {} });
  if (url === 'http://172.18.0.2:12434/v1/models')
    return auth === 'Bearer local-ai-key'
      ? Response.json({ data: [{ id: 'qwen38-27b-exl3' }] })
      : Response.json({ error: 'key' }, { status: 401 });
  if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
    const next = replies.shift();
    return next ? next(body!) : say('Nothing more to do.');
  }
  throw new TypeError('fetch failed');
}) as typeof fetch;

let srv: Running;
const secrets = new Map<string, ReturnType<typeof memoryStore>>();
const local = (path: string, method = 'GET', body?: unknown) =>
  fetch(srv.url + path, {
    method,
    headers: method === 'GET' ? {} : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  srv = await startServer(
    {
      ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-llm-'))]),
      port: 0,
      hostPort: 7300 + Math.floor(Math.random() * 400),
    },
    {
      fakeTickMs: 20,
      secrets: memoryStore(),
      exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
      choirSecrets: (account) => {
        if (!secrets.has(account)) secrets.set(account, memoryStore());
        return secrets.get(account)!;
      },
      llm: {
        fetch: fakeRuntimes,
        env: {},
        localAi: { gateways: async () => ['http://172.18.0.2:12434'], key: () => 'local-ai-key' },
      },
    },
  );
}, 30_000);
afterAll(() => srv.close());

describe('addresses', () => {
  it('reads an OpenAI-compatible base the way people write it', () => {
    expect(endpointUrl('http://desk:8000')).toBe('http://desk:8000/v1');
    expect(endpointUrl('http://desk:8000/v1/')).toBe('http://desk:8000/v1');
    expect(endpointUrl('https://gpu.example/openai/v1')).toBe('https://gpu.example/openai/v1');
    expect(() => endpointUrl('ftp://desk')).toThrow(/http/);
    expect(() => endpointUrl('http://user:sk-123@desk:8000')).toThrow(/key/);
  });
  it('follows OLLAMA_HOST’s port, and always asks on this computer', () => {
    expect(knownEndpoints({ OLLAMA_HOST: '0.0.0.0:11500' })[0]!.url).toBe('http://127.0.0.1:11500/v1');
  });
  it('finds the JSON in a model’s answer, fenced or not', () => {
    expect(jsonFrom('Sure!\n```json\n{"shots": []}\n```')).toEqual({ shots: [] });
    expect(jsonFrom('Here: {"title": "x"} hope it helps')).toEqual({ title: 'x' });
    expect(jsonFrom('no json')).toBeNull();
  });
});

describe('local models', { timeout: 30_000 }, () => {
  it('lists the runtimes running here and their models, and leaves out what isn’t running', async () => {
    const s = (await (await local('/api/llm?fresh')).json()) as LlmState;
    const byId = Object.fromEntries(s.endpoints.map((e) => [e.id, e]));
    expect(byId.ollama).toMatchObject({ name: 'Ollama', online: true, url: 'http://127.0.0.1:11434/v1' });
    expect(byId.ollama!.models.map((m) => m.id)).toEqual(['qwen3:8b']);
    expect(byId['lm-studio']!.models).toEqual([
      { id: 'gemma-4-12b', size: null, context: 32768, loaded: true },
    ]);
    expect(byId['llama-cpp']).toMatchObject({ runtime: 'llama-cpp', name: 'llama.cpp' });
    expect(byId['local-ai-1']).toMatchObject({ runtime: 'local-ai', keyed: true });
    expect(byId['local-ai-1']!.models[0]!.id).toBe('qwen38-27b-exl3');
    expect(byId.vllm).toBeUndefined();
    // Local AI's key went to its gateway and to nothing else.
    for (const a of asked.filter((x) => x.auth))
      expect(a.url.startsWith('http://172.18.0.2:12434/')).toBe(true);
  });

  it('keeps an added endpoint’s key out of its file, and says why one isn’t answering', async () => {
    const res = await local('/api/llm/endpoints', 'POST', {
      name: 'Desk vLLM',
      url: 'http://192.168.1.20:8000',
      key: 'sk-desk-secret',
    });
    expect(res.status).toBe(201);
    const e = (await res.json()) as LlmEndpoint;
    expect(e).toMatchObject({ id: 'custom-desk-vllm', custom: true, keyed: true, online: false });
    expect(e.error).toBeTruthy();
    expect(readFileSync(join(srv.config.dataDir, 'llm.json'), 'utf8')).not.toContain('sk-desk-secret');
    expect(secrets.get('llm-custom-desk-vllm')?.value).toBe('sk-desk-secret');
    expect((await local('/api/llm/endpoints/custom-desk-vllm', 'DELETE')).status).toBe(200);
    expect(secrets.get('llm-custom-desk-vllm')?.value).toBeNull();
  });

  it('lets a model that calls tools direct, with Hildegard’s tools and never the license one', async () => {
    replies = [
      () => toolCall('direct_shot', { prompt: 'A heron lifts off a misty lake at dawn', lens: 'anamorphic' }),
      () => say('I directed one shot of a heron at dawn.'),
    ];
    const before = asked.length;
    const res = await local('/api/llm/direct', 'POST', { idea: 'a heron at dawn', endpoint: 'ollama' });
    expect(res.status).toBe(200);
    const r = (await res.json()) as LlmDirectResult;
    expect(r).toMatchObject({ endpoint: 'ollama', model: 'qwen3:8b', mode: 'tools' });
    expect(r.shots).toHaveLength(1);
    expect(r.reply).toContain('heron');
    const first = asked.slice(before).find((a) => a.url.endsWith('/chat/completions'))!;
    const offered = (first.body!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(offered).toContain('direct_shot');
    expect(offered).not.toContain('install_model');
    const snap = (await (await local('/api/snapshot')).json()) as Snapshot;
    const take = snap.takes.find((t) => t.shotId === r.shots[0]);
    expect(take?.source).toEqual({ kind: 'agent', name: 'qwen3:8b (local)' });
  });

  it('asks a model that can’t call tools for a shot list, and queues what checks out', async () => {
    replies = [
      () => Response.json({ error: { message: 'model does not support tools' } }, { status: 400 }),
      (body) => {
        expect(body.response_format).toEqual({ type: 'json_object' });
        return say(
          JSON.stringify({
            title: 'Lighthouse',
            shots: [
              { prompt: 'A keeper climbs a spiral stair', lens: 'anamorphic' },
              { prompt: 'The lamp turns over a black sea', lens: 'no-such-lens' },
            ],
          }),
        );
      },
    ];
    const res = await local('/api/llm/direct', 'POST', { idea: 'a lighthouse at night', film: 'Lighthouse' });
    expect(res.status).toBe(200);
    const r = (await res.json()) as LlmDirectResult;
    expect(r.mode).toBe('plan');
    // The made-up lens was named back, and the shot queued with its prompt alone.
    expect(r.shots).toHaveLength(2);
    expect(r.steps.some((s) => !s.ok && s.result.includes('Unknown lens'))).toBe(true);
  });

  it('says plainly when nothing local is running', async () => {
    const res = await local('/api/llm/direct', 'POST', { idea: 'x', endpoint: 'vllm' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/No endpoint vllm/);
  });
});

describe('the local models, for the owner’s other devices', { timeout: 30_000 }, () => {
  const chat = (base: string, model: string, key?: string) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });

  it('lists every model as <endpoint>/<model>, and passes a request to the one that serves it', async () => {
    const models = (await (await local('/v1/models')).json()) as { data: Array<{ id: string }> };
    expect(models.data.map((m) => m.id)).toEqual(
      expect.arrayContaining(['ollama/qwen3:8b', 'lm-studio/gemma-4-12b', 'local-ai-1/qwen38-27b-exl3']),
    );
    replies = [() => say('Hello from qwen.')];
    const before = asked.length;
    const res = await chat(srv.url, 'ollama/qwen3:8b');
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message
        .content,
    ).toBe('Hello from qwen.');
    const sent = asked.slice(before).find((a) => a.url.endsWith('/chat/completions'))!;
    expect(sent.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(sent.body!.model).toBe('qwen3:8b');
    expect((await chat(srv.url, 'nobody/nothing')).status).toBe(404);
  });

  it('needs an owner’s key from elsewhere: no key and a director’s are refused', async () => {
    const remote = srv.hostedUrl()!;
    expect((await chat(remote, 'ollama/qwen3:8b')).status).toBe(401);
    expect(
      (await local('/api/people/owner', 'POST', { name: 'Ada', passphrase: 'a long and private passphrase' }))
        .status,
    ).toBe(201);
    const key = (
      (await (await local('/api/auth/keys', 'POST', { name: 'Laptop' })).json()) as { key: string }
    ).key;
    replies = [() => say('Hi.')];
    expect((await chat(remote, 'ollama/qwen3:8b', key)).status).toBe(200);
    const inv = (await (await local('/api/people/invites', 'POST', { role: 'director' })).json()) as {
      url: string;
    };
    await fetch(`${remote}/api/auth/invite/${inv.url.split('/#/invite/')[1]}/accept`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Hilde', passphrase: 'a long and private passphrase' }),
    });
    const dkey = (
      (await (await local('/api/auth/keys', 'POST', { name: 'Hilde’s', person: 'Hilde' })).json()) as {
        key: string;
      }
    ).key;
    expect((await chat(remote, 'ollama/qwen3:8b', dkey)).status).toBe(403);
    // A browser page elsewhere can't use this computer's models through it.
    const cross = await fetch(`${srv.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: '{}',
    });
    expect(cross.status).toBe(403);
  });
});
