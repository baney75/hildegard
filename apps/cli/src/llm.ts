// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard llm`: the language models running on this computer (Ollama, LM Studio, llama.cpp, vLLM, MLX, SGLang,
 * Jan, KoboldCpp, TabbyAPI, Local AI on Omarchy) and any OpenAI-compatible endpoint the owner adds, and letting one
 * of them direct an idea with Hildegard's tools.
 */
import type { LlmDirectResult, LlmEndpoint, LlmState } from '@hildegard/presets';
import type { Step } from '@hildegard/runtime';
import { api, askSecret, type Ctx, ensureRunning, readStdin } from './commands.ts';
import { type Result, result } from './output.ts';

const gb = (n: number | null) => (n ? ` ${(n / 1e9).toFixed(1)} GB` : '');

const endpointStep = (e: LlmEndpoint, use: LlmState['use']): Step => ({
  id: `llm-${e.id}`,
  title: `${e.name}${use?.endpoint === e.id ? ' (directs)' : ''}`,
  status: e.online ? 'done' : 'failed',
  detail: e.online
    ? `${e.url} · ${
        e.models.length
          ? e.models
              .slice(0, 8)
              .map(
                (m) =>
                  `${m.id}${gb(m.size)}${m.loaded ? ', loaded' : ''}${use?.endpoint === e.id && use.model === m.id ? ' ✓' : ''}`,
              )
              .join('; ') + (e.models.length > 8 ? `; and ${e.models.length - 8} more` : '')
          : 'no models yet'
      }`
    : `${e.url}: ${e.error ?? 'not answering'}`,
  ...(e.online ? {} : { command: `hildegard llm remove ${JSON.stringify(e.name)}` }),
});

function failure(id: string, title: string, e: unknown): Result {
  const message = (e as Error).message;
  return result([{ id, title, status: 'failed', detail: message }], message);
}

export async function llm(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  const c = ctx.config;
  const action = args[0] ?? 'list';
  switch (action) {
    case 'list': {
      const s = await api<LlmState>(c, '/api/llm?fresh', { timeoutMs: 30_000 });
      return result(
        s.endpoints.map((e) => endpointStep(e, s.use)),
        s.endpoints.length
          ? s.use
            ? ''
            : 'Choose which one directs with `hildegard llm use <endpoint> [<model>]`, or Hildegard takes the first that runs.'
          : 'No local models running. Start Ollama, LM Studio, llama.cpp, vLLM or another OpenAI-compatible server, or add one with `hildegard llm add <name> <address>`.',
        { endpoints: s.endpoints, use: s.use },
      );
    }
    case 'add': {
      const [, name, url] = args;
      if (!name || !url)
        return result(
          [],
          'Give a name and an address: `hildegard llm add "Desk vLLM" http://desk:8000/v1`.',
          { ok: false },
        );
      let key = '';
      if (ctx.flags.has('key-stdin')) key = (await readStdin()).trim();
      else if (ctx.flags.has('key') && process.stdin.isTTY && !ctx.json)
        key = await askSecret('API key (it won’t show): ');
      try {
        const e = await api<LlmEndpoint>(c, '/api/llm/endpoints', {
          method: 'POST',
          body: { name, url, ...(key ? { key } : {}) },
          timeoutMs: 30_000,
        });
        return result(
          [endpointStep(e, null)],
          e.online ? '' : 'Saved; it will be listed as soon as it answers.',
          {
            endpoint: e,
          },
        );
      } catch (e) {
        return failure('add', `Add ${name}`, e);
      }
    }
    case 'remove': {
      const which = args.slice(1).join(' ');
      if (!which) return result([], 'Say which: `hildegard llm remove <name>`.', { ok: false });
      try {
        await api<LlmState>(c, `/api/llm/endpoints/${encodeURIComponent(which)}`, { method: 'DELETE' });
        return result(
          [{ id: 'remove', title: `Remove ${which}`, status: 'done', detail: 'Gone, with its key.' }],
          '',
        );
      } catch (e) {
        return failure('remove', `Remove ${which}`, e);
      }
    }
    case 'use': {
      const [, endpoint, model] = args;
      if (!endpoint) return result([], 'Say which: `hildegard llm use <endpoint> [<model>]`.', { ok: false });
      try {
        const s = await api<LlmState>(c, '/api/llm/use', {
          method: 'POST',
          body: { endpoint, model },
          timeoutMs: 30_000,
        });
        return result([], `${s.use!.model} on ${s.use!.endpoint} directs now.`, { use: s.use });
      } catch (e) {
        return failure('use', `Use ${endpoint}`, e);
      }
    }
    case 'direct': {
      const idea = args.slice(1).join(' ').trim();
      if (!idea)
        return result([], 'Give the idea: `hildegard llm direct "a heron lifting off a lake at dawn"`.', {
          ok: false,
        });
      try {
        const r = await api<LlmDirectResult>(c, '/api/llm/direct', {
          method: 'POST',
          body: {
            idea,
            film: ctx.opts.get('film'),
            endpoint: ctx.opts.get('endpoint'),
            model: ctx.opts.get('model'),
            mode: ctx.flags.has('plan') ? 'plan' : undefined,
          },
          // A local model can take minutes over a few rounds of tool calls.
          timeoutMs: 15 * 60_000,
        });
        return result(
          r.steps.map((s, i) => ({
            id: `step-${i + 1}`,
            title: s.tool,
            status: s.ok ? 'done' : 'skipped',
            detail: s.result.split('\n')[0]!.slice(0, 240),
          })),
          r.shots.length
            ? `${r.model} directed ${r.shots.length === 1 ? 'a shot' : `${r.shots.length} shots`}. Follow them in the Studio's Queue.${r.reply ? ` It says: ${r.reply.slice(0, 300)}` : ''}`
            : `${r.model} didn’t direct any shots.${r.reply ? ` It says: ${r.reply.slice(0, 300)}` : ''}`,
          { ...r, ok: r.shots.length > 0 },
        );
      } catch (e) {
        return failure('direct', 'Direct with a local model', e);
      }
    }
    default:
      return result(
        [],
        'Use `hildegard llm`, `llm add <name> <address> [--key-stdin]`, `llm remove <name>`, `llm use <endpoint> [<model>]` or `llm direct "<idea>"`.',
        { ok: false },
      );
  }
}
