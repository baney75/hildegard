// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The language models people already run on their own computers: Ollama, LM Studio, llama.cpp, vLLM, MLX, SGLang,
 * Jan, KoboldCpp, TabbyAPI, Local AI on Omarchy, or any OpenAI-compatible server they name. Hildegard finds the
 * ones running here, lists their models, and lets one of them direct: it is handed Hildegard's own MCP tools (or,
 * for a model that can't call tools, asked for a shot list Hildegard checks and queues itself).
 *
 * Every endpoint Hildegard finds by itself is on this computer (loopback), or Local AI's gateway on its own Docker
 * network. An endpoint's key lives in the keychain, and goes to that endpoint only.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, type HildegardClient, INSTRUCTIONS } from '@hildegard/mcp';
import type { LlmDirectResult, LlmEndpoint, LlmModel, LlmRuntime, LlmState } from '@hildegard/presets';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { type Ctx, clientKey, fromThisComputer, type HgEnv } from './access.ts';
import { type Grants, looksLikeToken } from './grants.ts';
import type { SecretStore } from './hf.ts';
import { Limiter } from './people.ts';

export class LlmError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  constructor(status: LlmError['status'], message: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

/** Where each runtime listens unless told otherwise, and how to tell it apart from others on the same port. */
interface Known {
  runtime: LlmRuntime;
  name: string;
  url: string;
}
export function knownEndpoints(env: NodeJS.ProcessEnv = process.env): Known[] {
  // OLLAMA_HOST may be "0.0.0.0:11434", "127.0.0.1:11500" or a URL: Hildegard always asks on loopback.
  const ollamaPort = /:(\d{2,5})\/?$/.exec(env.OLLAMA_HOST ?? '')?.[1] ?? '11434';
  return [
    { runtime: 'ollama', name: 'Ollama', url: `http://127.0.0.1:${ollamaPort}/v1` },
    { runtime: 'lm-studio', name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
    // llama.cpp's server, llamafile, mlx_lm.server and LocalAI all default to 8080; `identify` sorts them out.
    { runtime: 'llama-cpp', name: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' },
    { runtime: 'vllm', name: 'vLLM', url: 'http://127.0.0.1:8000/v1' },
    { runtime: 'sglang', name: 'SGLang', url: 'http://127.0.0.1:30000/v1' },
    { runtime: 'jan', name: 'Jan', url: 'http://127.0.0.1:1337/v1' },
    { runtime: 'koboldcpp', name: 'KoboldCpp', url: 'http://127.0.0.1:5001/v1' },
    { runtime: 'tabby', name: 'TabbyAPI', url: 'http://127.0.0.1:5000/v1' },
  ];
}

const RUNTIME_NAMES: Record<LlmRuntime, string> = {
  ollama: 'Ollama',
  'lm-studio': 'LM Studio',
  'llama-cpp': 'llama.cpp',
  vllm: 'vLLM',
  mlx: 'MLX LM',
  sglang: 'SGLang',
  jan: 'Jan',
  koboldcpp: 'KoboldCpp',
  tabby: 'TabbyAPI',
  'local-ai': 'Local AI',
  openai: 'OpenAI-compatible',
};

interface Custom {
  id: string;
  name: string;
  url: string;
  keyed: boolean;
}
interface LlmFile {
  version: 1;
  custom: Custom[];
  use: { endpoint: string; model: string } | null;
}

/** Local AI on Omarchy (0xSero's plugin): a keyed gateway per running model, at its own Docker network address. */
export interface LocalAiSource {
  /** The gateways' base URLs (`http://172.x.y.z:12434`), from the plugin's snapshot. */
  gateways(): Promise<string[]>;
  key(): string | null;
}

export function localAiSource(home = homedir()): LocalAiSource {
  const state = join(home, '.local', 'state', 'omarchy', 'local-ai');
  const candidates = [
    join(home, '.local', 'share', 'omarchy', 'plugins', 'sero.local-ai', 'bin', 'omarchy-local-ai'),
    join(home, '.config', 'omarchy', 'plugins', 'sero.local-ai', 'bin', 'omarchy-local-ai'),
  ];
  return {
    async gateways() {
      if (!existsSync(join(state, 'deploy'))) return [];
      if (!readdirSync(join(state, 'deploy')).length) return [];
      const bin = candidates.find(existsSync) ?? 'omarchy-local-ai';
      const out = await new Promise<string>((resolve) =>
        execFile(bin, ['snapshot'], { timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout) =>
          resolve(err ? '' : stdout),
        ),
      );
      // Read only what Hildegard needs from it, whatever else the snapshot carries: each ready model's gateway.
      return [
        ...new Set(
          [...out.matchAll(/"gw"\s*:\s*"(http:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{2,5})"/g)].map((m) => m[1]!),
        ),
      ];
    },
    key() {
      try {
        return readFileSync(join(state, 'gateway.key'), 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
  };
}

export interface LocalModelsDeps {
  dataDir: string;
  /** A keychain entry per named secret. */
  secrets: (account: string) => SecretStore;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  localAi?: LocalAiSource;
  /** How long to wait for a runtime that may not be there. */
  probeMs?: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** `http://host:1234` → `http://host:1234/v1`; a base with a path stays as given. Only http(s), no credentials. */
export function endpointUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new LlmError(400, `“${raw}” isn’t an address. Give one like http://127.0.0.1:11434/v1.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new LlmError(400, 'Give an http:// or https:// address.');
  if (u.username || u.password)
    throw new LlmError(400, 'Leave names and keys out of the address; pass the key on its own.');
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path || '/v1'}`;
}

export class LocalModels {
  private readonly file: string;
  private data: LlmFile;
  private readonly fetchFn: typeof fetch;
  private readonly secrets: LocalModelsDeps['secrets'];
  private readonly env: NodeJS.ProcessEnv;
  private readonly localAi: LocalAiSource;
  private readonly probeMs: number;
  private cache: { at: number; endpoints: LlmEndpoint[] } | null = null;
  /** Local AI's key goes to its gateways only: they are remembered here as they are found. */
  private readonly localAiUrls = new Set<string>();

  constructor(deps: LocalModelsDeps) {
    this.file = join(deps.dataDir, 'llm.json');
    this.fetchFn = deps.fetch ?? fetch;
    this.secrets = deps.secrets;
    this.env = deps.env ?? process.env;
    this.localAi = deps.localAi ?? localAiSource();
    this.probeMs = deps.probeMs ?? 700;
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as LlmFile;
      if (this.data.version !== 1) throw new Error('unknown');
    } catch {
      this.data = { version: 1, custom: [], use: null };
    }
  }

  private persist() {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.cache = null;
  }

  /** Whether an endpoint sends a key: the owner said so for theirs; Local AI's always does. */
  private keyed(id: string, key: string | null): boolean {
    return this.data.custom.find((c) => c.id === id)?.keyed ?? !!key;
  }

  private keyFor(id: string): string | null {
    if (id.startsWith('local-ai-')) return this.localAi.key();
    const c = this.data.custom.find((x) => x.id === id);
    return c?.keyed ? this.secrets(`llm-${c.id}`).get() : null;
  }

  private async get(url: string, key: string | null, ms = this.probeMs): Promise<unknown> {
    const res = await this.fetchFn(url, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new LlmError(502, `It answered ${res.status}.`);
    return res.json();
  }

  /** The models an OpenAI-compatible endpoint lists, with what its own API adds where it has one. */
  private async models(runtime: LlmRuntime, url: string, key: string | null): Promise<LlmModel[]> {
    const root = url.replace(/\/v1$/, '');
    if (runtime === 'ollama') {
      const tags = (await this.get(`${root}/api/tags`, key)) as {
        models?: Array<{ name: string; size?: number }>;
      };
      return (tags.models ?? [])
        .filter((m) => !/embed/i.test(m.name))
        .map((m) => ({
          id: m.name,
          size: m.size ?? null,
          context: null,
          loaded: null,
        }));
    }
    if (runtime === 'lm-studio') {
      const v0 = (await this.get(`${root}/api/v0/models`, key).catch(() => null)) as {
        data?: Array<{ id: string; type?: string; state?: string; max_context_length?: number }>;
      } | null;
      if (v0?.data)
        return v0.data
          .filter((m) => m.type !== 'embeddings')
          .map((m) => ({
            id: m.id,
            size: null,
            context: m.max_context_length ?? null,
            loaded: m.state ? m.state === 'loaded' : null,
          }));
    }
    const list = (await this.get(`${url}/models`, key)) as {
      data?: Array<{ id: string; max_model_len?: number; meta?: { n_ctx_train?: number; size?: number } }>;
    };
    return (list.data ?? [])
      .filter((m) => typeof m.id === 'string' && !/embed/i.test(m.id))
      .map((m) => ({
        id: m.id,
        size: m.meta?.size ?? null,
        context: m.max_model_len ?? m.meta?.n_ctx_train ?? null,
        loaded: null,
      }));
  }

  /** Port 8080 is llama.cpp's, MLX LM's and LocalAI's alike: llama.cpp answers /props, MLX lists mlx models. */
  private async identify(k: Known, models: LlmModel[]): Promise<LlmRuntime> {
    if (k.runtime !== 'llama-cpp') return k.runtime;
    const root = k.url.replace(/\/v1$/, '');
    const props = await this.get(`${root}/props`, null).catch(() => null);
    if (props && typeof props === 'object' && 'default_generation_settings' in props) return 'llama-cpp';
    if (models.some((m) => /mlx/i.test(m.id))) return 'mlx';
    return 'openai';
  }

  private async probe(
    id: string,
    k: Known,
    custom: boolean,
    key: string | null,
  ): Promise<LlmEndpoint | null> {
    try {
      const models = await this.models(k.runtime, k.url, key);
      const runtime = custom ? k.runtime : await this.identify(k, models);
      return {
        id,
        runtime,
        name: custom || runtime === k.runtime ? k.name : RUNTIME_NAMES[runtime],
        url: k.url,
        online: true,
        models,
        custom,
        keyed: this.keyed(id, key),
        error: null,
      };
    } catch (e) {
      // Found ones that aren't running aren't listed; the owner's own always are, with why.
      if (!custom) return null;
      return {
        id,
        runtime: k.runtime,
        name: k.name,
        url: k.url,
        online: false,
        models: [],
        custom,
        keyed: this.keyed(id, key),
        error:
          (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
            ? 'It didn’t answer in time.'
            : (e as Error).message.startsWith('It answered')
              ? (e as Error).message
              : 'Nothing answers there.',
      };
    }
  }

  /** Every endpoint: those running here, Local AI's, and the owner's own. Asked afresh at most every 5 seconds. */
  async endpoints(fresh = false): Promise<LlmEndpoint[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 5000) return this.cache.endpoints;
    const found = knownEndpoints(this.env).map((k) => this.probe(k.runtime, k, false, null));
    const gateways = await this.localAi.gateways().catch(() => [] as string[]);
    const localAiKey = gateways.length ? this.localAi.key() : null;
    const localAi = gateways.map((g, i) => {
      const url = `${g}/v1`;
      this.localAiUrls.add(url);
      return this.probe(
        `local-ai-${i + 1}`,
        { runtime: 'local-ai', name: gateways.length > 1 ? `Local AI ${i + 1}` : 'Local AI', url },
        false,
        localAiKey,
      );
    });
    const custom = this.data.custom.map((c) =>
      this.probe(c.id, { runtime: 'openai', name: c.name, url: c.url }, true, this.keyFor(c.id)),
    );
    const all = (await Promise.all([...found, ...localAi, ...custom])).filter(
      (x): x is LlmEndpoint => x !== null,
    );
    // One server can answer on an address the owner added too: list it once, as theirs.
    const urls = new Set(all.filter((e) => e.custom).map((e) => e.url));
    const endpoints = all.filter((e) => e.custom || !urls.has(e.url));
    this.cache = { at: Date.now(), endpoints };
    return endpoints;
  }

  async state(fresh = false): Promise<LlmState> {
    return { endpoints: await this.endpoints(fresh), use: this.data.use };
  }

  /** The owner's own endpoint: a name and an OpenAI-compatible address, with a key when it needs one. */
  async add(rawName: string, rawUrl: string, key?: string): Promise<LlmEndpoint> {
    const name = rawName.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,39}$/u.test(name))
      throw new LlmError(400, 'Name it in up to 40 letters, digits, spaces or dots, such as “Desk vLLM”.');
    const url = endpointUrl(rawUrl);
    let id = `custom-${slug(name) || 'endpoint'}`;
    if (this.data.custom.some((c) => c.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
      throw new LlmError(
        409,
        `There’s already an endpoint called ${name}. Remove it first, or choose another name.`,
      );
    while (this.data.custom.some((c) => c.id === id)) id = `${id}-${randomUUID().slice(0, 4)}`;
    if (key) this.secrets(`llm-${id}`).set(key);
    this.data.custom.push({ id, name, url, keyed: !!key });
    this.persist();
    const e = (await this.endpoints(true)).find((x) => x.id === id)!;
    return e;
  }

  remove(id: string) {
    const c = this.data.custom.find(
      (x) => x.id === id || x.name.toLocaleLowerCase() === id.toLocaleLowerCase(),
    );
    if (!c)
      throw new LlmError(404, `No endpoint called ${id} was added here. Found ones go when their app stops.`);
    if (c.keyed) this.secrets(`llm-${c.id}`).delete();
    this.data.custom = this.data.custom.filter((x) => x !== c);
    if (this.data.use?.endpoint === c.id) this.data.use = null;
    this.persist();
  }

  /** The endpoint and model to use: the ones named, else the owner's choice, else the first model that runs. */
  async pick(endpoint?: string, model?: string): Promise<{ endpoint: LlmEndpoint; model: string }> {
    const all = await this.endpoints();
    const online = all.filter((e) => e.online && e.models.length);
    if (!online.length)
      throw new LlmError(
        404,
        'No local model is running. Start Ollama, LM Studio, llama.cpp, vLLM or another OpenAI-compatible server (or add yours with `hildegard llm add`), then try again.',
      );
    const wanted = endpoint ?? (model ? undefined : this.data.use?.endpoint);
    const e = wanted
      ? all.find((x) => x.id === wanted || x.name.toLocaleLowerCase() === wanted.toLocaleLowerCase())
      : model
        ? (online.find((x) => x.models.some((m) => m.id === model)) ?? online[0])
        : online[0];
    if (!e)
      throw new LlmError(404, `No endpoint ${wanted}. Running here: ${online.map((x) => x.id).join(', ')}.`);
    if (!e.online)
      throw new LlmError(502, `${e.name} isn’t answering at ${e.url}: ${e.error ?? 'nothing there'}`);
    const m =
      model ??
      (this.data.use?.endpoint === e.id ? this.data.use.model : undefined) ??
      // A model already in memory answers soonest.
      e.models.find((x) => x.loaded)?.id ??
      e.models[0]?.id;
    if (!m) throw new LlmError(404, `${e.name} has no models yet. Pull or load one there first.`);
    if (e.models.length && !e.models.some((x) => x.id === m))
      throw new LlmError(
        404,
        `${e.name} has no model ${m}. It has: ${e.models.map((x) => x.id).join(', ')}.`,
      );
    return { endpoint: e, model: m };
  }

  async use(endpoint: string, model?: string) {
    const p = await this.pick(endpoint, model);
    this.data.use = { endpoint: p.endpoint.id, model: p.model };
    this.persist();
    return this.data.use;
  }

  /**
   * Passes one OpenAI-compatible request through to the endpoint that serves `model` (`<endpoint>/<model>`, or a
   * bare model name the first running endpoint has), streaming the answer back as it comes. The key, if any, is the
   * endpoint's own.
   */
  async forward(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const name = typeof body.model === 'string' ? body.model : '';
    const all = (await this.endpoints()).filter((e) => e.online);
    const slash = name.indexOf('/');
    let e = slash > 0 ? all.find((x) => x.id === name.slice(0, slash)) : undefined;
    let model = e ? name.slice(slash + 1) : name;
    if (!e) {
      e = all.find((x) => x.models.some((m) => m.id === name));
      model = name;
    }
    if (!e)
      return Response.json(
        {
          error: {
            message: `No model ${name || '(none given)'} here. GET /v1/models lists them.`,
            type: 'invalid_request_error',
          },
        },
        { status: 404 },
      );
    if (e.id.startsWith('local-ai-') && !this.localAiUrls.has(e.url))
      return Response.json({ error: { message: 'Unknown gateway.' } }, { status: 409 });
    const key = this.keyFor(e.id);
    try {
      const res = await this.fetchFn(`${e.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ ...body, model }),
        signal,
      });
      return new Response(res.body, {
        status: res.status,
        headers: {
          'content-type': res.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        },
      });
    } catch (err) {
      return Response.json(
        { error: { message: `${e.name} didn’t answer: ${(err as Error).message}`, type: 'server_error' } },
        { status: 502 },
      );
    }
  }

  /** One chat completion. The key goes only to the endpoint it belongs to. */
  async chat(e: LlmEndpoint, body: Record<string, unknown>, ms = 180_000): Promise<ChatMessage> {
    if (e.id.startsWith('local-ai-') && !this.localAiUrls.has(e.url))
      throw new LlmError(409, 'That Local AI gateway isn’t one Hildegard found.');
    const key = this.keyFor(e.id);
    let res: Response;
    try {
      res = await this.fetchFn(`${e.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      throw new LlmError(502, `${e.name} didn’t answer: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: ChatMessage }>;
      error?: { message?: string } | string;
    };
    if (!res.ok) {
      const why = typeof data.error === 'string' ? data.error : data.error?.message;
      throw new LlmError(
        res.status === 400 ? 400 : 502,
        `${e.name} answered ${res.status}${why ? `: ${why}` : ''}.`,
      );
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new LlmError(502, `${e.name} answered without a message.`);
    return msg;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * The tools a local model is handed. Never install_model: a license is the owner's to accept, and a model must not
 * say yes for them.
 */
const LOCAL_TOOLS = new Set([
  'hildegard_status',
  'list_presets',
  'direct_shot',
  'make_sequence',
  'shot_status',
  'cancel_take',
  'export_film',
]);

const SYSTEM = `${INSTRUCTIONS}
You are directing for the person who owns this computer. Turn their idea into shots with the tools: call list_presets once if you need ids, then direct_shot for each shot (or make_sequence for several), all with the same film title. Never set wait. Use only ids that list_presets gives. When the shots are queued, say in one or two sentences what you directed.`;

const PLAN = `You plan film shots for Hildegard, which renders them on the user's GPU.
Answer with JSON only, no prose: {"title": string, "shots": [{"prompt": string, "camera_body"?: string, "lens"?: string, "focal_mm"?: number, "motion"?: string[], "lighting"?: string, "palette"?: string, "seconds"?: number}]}.
At most 6 shots. Each prompt is literal, chronological action: who, what they do, where. Leave the camera and look out of the prompt; choose them from these ids only:
`;

/** Extracts the first JSON object from a model's answer, fenced or not. */
export function jsonFrom(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

/**
 * Let a local model direct an idea, as the person asking, through Hildegard's own MCP tools in this process. A model
 * that can call tools does so, up to `maxSteps` rounds; one that can't (or won't) writes a shot list, which Hildegard
 * checks against its presets and queues as one film.
 */
export async function directWithLocal(opts: {
  llm: LocalModels;
  /** Calls this server in-process as the person asking. */
  client: HildegardClient;
  idea: string;
  film?: string;
  endpoint?: string;
  model?: string;
  mode?: 'auto' | 'tools' | 'plan';
  maxSteps?: number;
}): Promise<LlmDirectResult> {
  const { endpoint, model } = await opts.llm.pick(opts.endpoint, opts.model);
  const server = createMcpServer(opts.client, { agentName: `${model} (local)`.slice(0, 60) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: `${model} (local)`, version: '1' });
  await mcp.connect(b);
  const steps: LlmDirectResult['steps'] = [];
  const shots = new Set<string>();
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = (await mcp.callTool({ name: tool, arguments: args })) as CallToolResult;
    const text = textOf(r);
    // The shots this run made, from what the tools that make them said.
    if (!r.isError && tool === 'direct_shot')
      for (const m of text.matchAll(/^Directed shot ([0-9a-f]{16})/g)) shots.add(m[1]!);
    if (!r.isError && tool === 'make_sequence')
      for (const m of text.matchAll(/queued in order \(([^)]+)\)/g))
        for (const id of m[1]!.split(', ')) shots.add(id.trim());
    steps.push({ tool, args, ok: !r.isError, result: text.slice(0, 2000) });
    return { text, ok: !r.isError };
  };
  const film = opts.film?.trim() || opts.idea.trim().split(/\s+/).slice(0, 6).join(' ');
  try {
    if (opts.mode !== 'plan') {
      const { tools } = await mcp.listTools();
      const offered = tools
        .filter((t) => LOCAL_TOOLS.has(t.name))
        .map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
        }));
      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Film title: ${film}\n\n${opts.idea}` },
      ];
      let reply = '';
      let toolsWork = true;
      for (let round = 0; round < (opts.maxSteps ?? 8); round++) {
        let msg: ChatMessage;
        try {
          msg = await opts.llm.chat(endpoint, {
            model,
            messages,
            tools: offered,
            tool_choice: 'auto',
            temperature: 0.4,
          });
        } catch (e) {
          // A runtime or model without tool calling says so with a 400: plan instead.
          if (e instanceof LlmError && e.status === 400 && round === 0 && opts.mode !== 'tools') {
            toolsWork = false;
            break;
          }
          throw e;
        }
        messages.push({
          role: 'assistant',
          content: msg.content ?? '',
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        });
        if (!msg.tool_calls?.length) {
          reply = msg.content ?? '';
          break;
        }
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {}
          const name = tc.function.name;
          const out = LOCAL_TOOLS.has(name)
            ? await call(name, {
                ...args,
                ...(name === 'direct_shot' || name === 'make_sequence' ? { wait: false } : {}),
              })
            : { text: `There is no tool ${name}. Use one of: ${[...LOCAL_TOOLS].join(', ')}.`, ok: false };
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text.slice(0, 6000) });
        }
      }
      if (shots.size || (toolsWork && opts.mode === 'tools'))
        return { endpoint: endpoint.id, model, mode: 'tools', steps, shots: [...shots], reply };
    }
    // A shot list instead: the model writes, Hildegard checks every id and queues.
    const presets = (await call('list_presets', {})).text;
    const msg = await opts.llm
      .chat(endpoint, {
        model,
        messages: [
          { role: 'system', content: PLAN + presets },
          { role: 'user', content: opts.idea },
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      })
      .catch(async (e) => {
        // Not every server takes response_format; the prompt alone asks for JSON.
        if (e instanceof LlmError && e.status === 400)
          return opts.llm.chat(endpoint, {
            model,
            messages: [
              { role: 'system', content: PLAN + presets },
              { role: 'user', content: opts.idea },
            ],
            temperature: 0.4,
          });
        throw e;
      });
    const plan = jsonFrom(msg.content ?? '') as { title?: unknown; shots?: unknown } | null;
    const list = Array.isArray(plan?.shots) ? (plan.shots as Array<Record<string, unknown>>).slice(0, 6) : [];
    if (!list.length)
      throw new LlmError(
        502,
        `${model} didn’t write a shot list Hildegard could read. Try a larger model, or say more in the idea.`,
      );
    const allowed = [
      'prompt',
      'camera_body',
      'lens',
      'focal_mm',
      'motion',
      'lighting',
      'palette',
      'genre',
      'era',
      'aspect',
      'seconds',
    ];
    for (const s of list) {
      if (typeof s.prompt !== 'string' || !s.prompt.trim()) continue;
      const args = Object.fromEntries(Object.entries(s).filter(([k]) => allowed.includes(k)));
      const first = await call('direct_shot', { ...args, film, wait: false });
      // A wrong id is named with the ones that would work: once more with only the prompt.
      if (!first.ok) await call('direct_shot', { prompt: s.prompt, film, wait: false });
    }
    return {
      endpoint: endpoint.id,
      model,
      mode: 'plan',
      steps,
      shots: [...shots],
      reply: typeof plan?.title === 'string' ? plan.title : film,
    };
  } finally {
    await mcp.close();
  }
}

/**
 * An OpenAI-compatible API at `/v1` over every local model here, so the owner's other devices (and the agents on
 * them) can use the models on this computer through Hildegard's link, with the same keys as its MCP. On this
 * computer it needs no key, like the runtimes themselves. Models are named `<endpoint>/<model>`.
 */
export function llmProxyRoutes(
  app: Hono<HgEnv>,
  deps: { llm: LocalModels; grants: Grants; perMinute?: number },
) {
  const perKey = new Limiter(deps.perMinute ?? 120, 60_000);
  const badTokens = new Limiter(30, 15 * 60_000);
  /** This computer, or an owner's key: a director's key, or a chatbot's token (which is for /mcp), won't do. */
  const allowed = (c: Ctx): Response | null => {
    if (fromThisComputer(c)) return null;
    const key = `v1:${clientKey(c)}`;
    if (badTokens.wait(key))
      return Response.json({ error: { message: 'Too many bad keys from here.' } }, { status: 429 });
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const auth = m && looksLikeToken(m[1]!, 'key') ? deps.grants.authenticate(m[1]!, '') : null;
    if (!auth) {
      if (m) badTokens.fail(key);
      return Response.json(
        {
          error: {
            message: 'Use a key from `hildegard host key`, as the bearer token.',
            type: 'invalid_api_key',
          },
        },
        { status: 401 },
      );
    }
    if (auth.person.role !== 'owner')
      return Response.json(
        { error: { message: 'Only the owner’s keys can use the models here.' } },
        { status: 403 },
      );
    const g = `grant:${auth.grant.id}`;
    if (perKey.wait(g)) return Response.json({ error: { message: 'Slow down a little.' } }, { status: 429 });
    perKey.fail(g);
    return null;
  };
  app.get('/v1/models', async (c) => {
    const refused = allowed(c);
    if (refused) return refused;
    const all = (await deps.llm.endpoints()).filter((e) => e.online);
    return c.json({
      object: 'list',
      data: all.flatMap((e) =>
        e.models.map((m) => ({ id: `${e.id}/${m.id}`, object: 'model', created: 0, owned_by: e.name })),
      ),
    });
  });
  for (const path of ['/chat/completions', '/completions', '/embeddings'])
    app.post(`/v1${path}`, async (c) => {
      const refused = allowed(c);
      if (refused) return refused;
      // JSON only: a browser can't send it cross-site without a preflight, which is never granted.
      if (!(c.req.header('content-type') ?? '').includes('application/json'))
        return c.json({ error: { message: 'Send JSON.' } }, 415);
      if (Number(c.req.header('content-length') ?? 0) > 16 << 20)
        return c.json({ error: { message: 'Requests up to 16 MB.' } }, 413);
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return c.json({ error: { message: 'That isn’t JSON.' } }, 400);
      return deps.llm.forward(path, body, c.req.raw.signal);
    });
}
