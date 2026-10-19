// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Catalog, Snapshot } from '@hildegard/presets';
import {
  AGENTS,
  connectAgent,
  detectGpu,
  disconnectAgent,
  findAgent,
  fit,
  type Gpu,
  installRuntime,
  layout,
  listAgents,
  mcpCommand,
  readRuntime,
  resource,
  type Step,
  snippet,
} from '@hildegard/runtime';
import { type Config, startServer, VERSION } from '@hildegard/server';
import { printStep, type Result, result } from './output.ts';

export interface Ctx {
  config: Config;
  json: boolean;
  yes: boolean;
  flags: Set<string>;
  opts: Map<string, string>;
}

/** The script that is `hildegard`: the release bundle, or apps/cli/src/main.ts in a checkout. */
export const entry = () =>
  process.env.HILDEGARD_ENTRY ?? fileURLToPath(new URL('./main.ts', import.meta.url));

const baseUrl = (c: Config) => `http://127.0.0.1:${c.port}`;

async function api<T>(c: Config, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${baseUrl(c)}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.method ? { 'x-hildegard': '1', 'content-type': 'application/json' } : {},
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok)
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export async function running(c: Config): Promise<{ version: string } | null> {
  try {
    const res = await fetch(`${baseUrl(c)}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as { version: string }) : null;
  } catch {
    return null;
  }
}

const tryResource = (rel: string) => {
  try {
    return resource(rel);
  } catch {
    return null;
  }
};

// ── start / stop ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs the server in this process until it's stopped: what the background start, and services, run. */
export async function serveForeground(c: Config): Promise<never> {
  const uiDir = c.uiDir ?? tryResource('studio') ?? tryResource(join('apps', 'studio', 'dist'));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await srv.close();
    process.exit(0);
  };
  const srv = await startServer({ ...c, uiDir }, { onStop: () => void stop() });
  console.log(`Hildegard ${VERSION} is running at ${srv.url}`);
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  return new Promise<never>(() => {});
}

export async function start(ctx: Ctx): Promise<Result> {
  const c = ctx.config;
  const url = baseUrl(c);
  const up = await running(c);
  if (up)
    return result(
      [{ id: 'start', title: 'Start Hildegard', status: 'skipped', detail: `Already running at ${url}.` }],
      `Hildegard is running at ${url}`,
      { url },
    );
  const L = layout(c.dataDir);
  mkdirSync(L.logs, { recursive: true });
  const log = join(L.logs, 'server.log');
  const fd = openSync(log, 'a');
  const args = [entry(), 'start', '--foreground', '--port', String(c.port), '--data', c.dataDir];
  if (c.fake) args.push('--fake-gpu');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, HILDEGARD_ENTRY: entry() },
  });
  closeSync(fd);
  child.unref();
  for (let i = 0; i < 120; i++) {
    if (await running(c))
      return result(
        [{ id: 'start', title: 'Start Hildegard', status: 'done', detail: `Running at ${url}.` }],
        `Hildegard is running at ${url}`,
        { url },
      );
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return result(
    [
      {
        id: 'start',
        title: 'Start Hildegard',
        status: 'failed',
        detail: `It didn’t start. The log is ${log}.`,
      },
    ],
    'Hildegard didn’t start.',
  );
}

export async function stop(ctx: Ctx): Promise<Result> {
  const c = ctx.config;
  if (!(await running(c)))
    return result(
      [{ id: 'stop', title: 'Stop Hildegard', status: 'skipped', detail: 'It wasn’t running.' }],
      'Hildegard is stopped.',
    );
  await api(c, '/api/system/stop', { method: 'POST' }).catch(() => {});
  for (let i = 0; i < 80; i++) {
    if (!(await running(c)))
      return result(
        [{ id: 'stop', title: 'Stop Hildegard', status: 'done', detail: 'Stopped, with ComfyUI.' }],
        'Hildegard is stopped.',
      );
    await new Promise((r) => setTimeout(r, 250));
  }
  return result(
    [{ id: 'stop', title: 'Stop Hildegard', status: 'failed', detail: 'It didn’t stop within 20 seconds.' }],
    'Hildegard is still running.',
  );
}

// ── install ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function install(ctx: Ctx): Promise<Result> {
  const c = ctx.config;
  const steps = await installRuntime({
    dataDir: c.dataDir,
    cpu: ctx.flags.has('cpu'),
    onStep: ctx.json ? undefined : printStep,
    onLog: ctx.json || !ctx.flags.has('verbose') ? undefined : (l) => console.log(`    ${l}`),
  });
  const printed = ctx.json ? 0 : steps.length;
  const failed = steps.find((s) => s.status === 'failed' || s.status === 'needs-owner');
  if (failed)
    return { ...result(steps, failed.status === 'failed' ? 'The install stopped.' : failed.detail), printed };
  // Restart, so the server runs the ComfyUI it just installed.
  if (await running(c)) await stop(ctx);
  const s = await start(ctx);
  steps.push(...s.steps);
  return {
    ...result(
      steps,
      s.ok
        ? `Hildegard is installed and running at ${baseUrl(c)}. Next: \`hildegard setup\` picks a model and links your AI apps.`
        : 'ComfyUI is installed, but Hildegard didn’t start.',
      { url: baseUrl(c) },
    ),
    printed,
  };
}

// ── models ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function ensureRunning(ctx: Ctx): Promise<Step | null> {
  if (await running(ctx.config)) return null;
  const s = await start(ctx);
  return s.steps[0] ?? null;
}

/** The first model in the catalog that fits this GPU, or one that fits tightly. */
export function starterModel(catalog: Catalog, gpu: Gpu) {
  return (
    catalog.models.find((m) => fit(gpu, m.minVramGb) === 'fits') ??
    catalog.models.find((m) => fit(gpu, m.minVramGb) === 'tight') ??
    null
  );
}

export async function installModel(ctx: Ctx, id: string, accept: boolean): Promise<Step> {
  const catalog = await api<Catalog>(ctx.config, '/api/catalog');
  const m = catalog.models.find((x) => x.id === id);
  const title = `Install ${m?.name ?? id}`;
  if (!m)
    return {
      id: 'model',
      title,
      status: 'failed',
      detail: `No model “${id}”. Models: ${catalog.models.map((x) => x.id).join(', ')}.`,
    };
  const snap = await api<Snapshot>(ctx.config, '/api/snapshot');
  if (snap.models.find((x) => x.id === id)?.installed)
    return { id: 'model', title, status: 'skipped', detail: `${m.name} is installed.` };
  try {
    await api(ctx.config, `/api/models/${id}/install`, { method: 'POST', body: { acceptLicense: accept } });
    return {
      id: 'model',
      title,
      status: 'done',
      detail: `Downloading ${m.name} in the background. \`hildegard status\` and the Studio show progress.`,
    };
  } catch (e) {
    if ((e as { status?: number }).status === 409)
      return {
        id: 'model',
        title,
        status: 'needs-owner',
        detail: `${m.name} comes under the ${m.license} (${m.licenseUrl}). The owner must accept it first:\n${m.terms.map((t) => `• ${t}`).join('\n')}`,
        command: `hildegard models install ${id} --accept-license`,
      };
    return { id: 'model', title, status: 'failed', detail: (e as Error).message };
  }
}

export async function models(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  if (args[0] === 'install') {
    const id = args[1];
    if (!id) return result([], 'Say which model: `hildegard models install <id>`.', { ok: false });
    const step = await installModel(ctx, id, ctx.flags.has('accept-license'));
    return result([step], step.status === 'needs-owner' ? 'Waiting on the license.' : step.detail);
  }
  const [catalog, snap] = await Promise.all([
    api<Catalog>(ctx.config, '/api/catalog'),
    api<Snapshot>(ctx.config, '/api/snapshot'),
  ]);
  const gpu = detectGpu();
  const list = catalog.models.map((m) => {
    const s = snap.models.find((x) => x.id === m.id);
    return {
      id: m.id,
      name: m.name,
      license: m.license,
      licenseUrl: m.licenseUrl,
      minVramGb: m.minVramGb,
      fit: fit(gpu, m.minVramGb),
      installed: s?.installed ?? false,
      licenseAccepted: s?.licenseAccepted ?? false,
      downloading: s?.downloading ?? null,
    };
  });
  const steps: Step[] = list.map((m) => ({
    id: m.id,
    title: `${m.name} (${m.id})`,
    status: m.installed ? 'done' : 'skipped',
    detail: `${m.installed ? 'Installed' : m.downloading ? `Downloading, ${Math.round((m.downloading.done / m.downloading.total) * 100)}%` : 'Not installed'} · needs ${m.minVramGb} GB · ${{ fits: 'fits this GPU', tight: 'tight on this GPU, slower', no: 'won’t fit this GPU' }[m.fit]} · ${m.license}`,
  }));
  return result(steps, '', { models: list, gpu });
}

// ── setup ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes';
}

export async function setup(ctx: Ctx): Promise<Result> {
  const c = ctx.config;
  const steps: Step[] = [];
  const add = (s: Step) => {
    steps.push(s);
    if (!ctx.json) printStep(s);
  };
  if (!readRuntime(c.dataDir) && !c.comfyExternal && !c.fake)
    return result(
      [
        {
          id: 'install',
          title: 'Install ComfyUI',
          status: 'needs-owner',
          detail: 'ComfyUI isn’t installed yet.',
          command: 'hildegard install --yes --json',
        },
      ],
      'Run `hildegard install` first.',
    );
  const pre = await ensureRunning(ctx);
  if (pre) add(pre);
  if (pre?.status === 'failed') return { ...result(steps, 'Hildegard didn’t start.'), printed: steps.length };

  // A first model that fits.
  const gpu = detectGpu();
  const catalog = await api<Catalog>(c, '/api/catalog');
  const want = ctx.opts.get('model');
  const pick = want ? catalog.models.find((m) => m.id === want) : starterModel(catalog, gpu);
  if (!pick)
    add({
      id: 'model',
      title: 'Pick a model',
      status: want ? 'failed' : 'skipped',
      detail: want
        ? `No model “${want}”. Models: ${catalog.models.map((m) => m.id).join(', ')}.`
        : `No video model fits ${gpu.backend === 'cpu' ? 'without a GPU' : `${gpu.vramGb} GB`}. Hildegard can still render on a cloud GPU (coming soon).`,
    });
  else {
    let accept = ctx.flags.has('accept-license');
    if (!accept && !ctx.yes && !ctx.json) {
      console.log(`\n${pick.name} fits this computer. It comes under the ${pick.license}:`);
      for (const t of pick.terms) console.log(`  • ${t}`);
      console.log(`  ${pick.licenseUrl}`);
      accept = await ask(`Accept it and download ${pick.name}?`);
    }
    add(await installModel(ctx, pick.id, accept));
  }

  // Link the AI apps on this computer.
  const agents = listAgents().filter((a) => a.installed);
  const cmd = mcpCommand({ url: baseUrl(c) });
  if (!agents.length)
    add({
      id: 'agents',
      title: 'Link AI apps',
      status: 'skipped',
      detail: `No AI apps found. Later: \`hildegard connect <app>\` for ${AGENTS.map((a) => a.id).join(', ')}.`,
    });
  for (const a of agents) {
    if (a.connected) {
      add({ id: `connect-${a.id}`, title: `Link ${a.name}`, status: 'skipped', detail: 'Already linked.' });
      continue;
    }
    const go = ctx.yes || (!ctx.json && (await ask(`Let ${a.name} use Hildegard?`)));
    add(
      go
        ? connectAgent(a.id, cmd)
        : {
            id: `connect-${a.id}`,
            title: `Link ${a.name}`,
            status: 'skipped',
            detail: 'Not linked.',
            command: `hildegard connect ${a.id}`,
          },
    );
  }
  const r = result(
    steps,
    `Open the Studio at ${baseUrl(c)}${steps.some((s) => s.status === 'needs-owner') ? ', once the steps marked ! are done' : ''}.`,
    { url: baseUrl(c) },
  );
  return { ...r, printed: steps.length };
}

// ── connect ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function connect(ctx: Ctx, ids: string[], undo = false): Promise<Result> {
  const cmd = mcpCommand({ url: baseUrl(ctx.config) });
  if (ctx.flags.has('print')) {
    const a = findAgent(ids[0] ?? 'claude-desktop');
    const text = snippet(a ? (AGENTS.find((x) => x.id === a.id)?.format ?? 'mcpServers') : 'mcpServers', cmd);
    return result([], text, { snippet: text, command: cmd });
  }
  const targets = ctx.flags.has('all')
    ? listAgents()
        .filter((a) => a.installed)
        .map((a) => a.id)
    : ids;
  if (!targets.length) {
    const list = listAgents();
    return result(
      list.map((a) => ({
        id: a.id,
        title: a.name,
        status: a.connected ? 'done' : 'skipped',
        detail: a.connected ? 'Linked.' : a.installed ? 'Found, not linked.' : 'Not found on this computer.',
        ...(a.connected ? {} : { command: `hildegard connect ${a.id}` }),
      })),
      'Link one with `hildegard connect <app>`, or every app found with `hildegard connect --all`.',
      { agents: list, command: cmd },
    );
  }
  const steps = targets.map((id) => (undo ? disconnectAgent(id) : connectAgent(id, cmd)));
  return result(steps, '', { agents: listAgents() });
}

// ── status ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function status(ctx: Ctx): Promise<Result> {
  const c = ctx.config;
  const gpu = detectGpu();
  const runtime = readRuntime(c.dataDir);
  const up = await running(c);
  const snap = up ? await api<Snapshot>(c, '/api/snapshot').catch(() => null) : null;
  const steps: Step[] = [
    {
      id: 'gpu',
      title: 'GPU',
      status: gpu.backend === 'cpu' ? 'skipped' : 'done',
      detail:
        gpu.backend === 'cpu'
          ? (gpu.note ?? 'No supported GPU.')
          : `${gpu.name}${gpu.vramGb ? `, ${gpu.vramGb} GB` : ''}${gpu.note ? `. ${gpu.note}` : ''}`,
    },
    {
      id: 'comfyui',
      title: 'ComfyUI',
      status: snap?.engine.online ? 'done' : runtime || c.comfyExternal ? 'skipped' : 'needs-owner',
      detail: c.fake
        ? 'The stand-in GPU, for testing: it makes placeholder clips, not real video.'
        : snap?.engine.online
          ? `Running${runtime ? ` (ComfyUI ${runtime.comfyui}, PyTorch ${runtime.torch})` : ` at ${snap.engine.url}`}.`
          : runtime
            ? (snap?.engine.problem ?? `Installed (ComfyUI ${runtime.comfyui}); starts with Hildegard.`)
            : c.comfyExternal
              ? `Not answering at ${c.comfyUrl}.`
              : 'Not installed.',
      ...(runtime || c.comfyExternal || c.fake ? {} : { command: 'hildegard install --yes --json' }),
    },
    {
      id: 'server',
      title: 'Hildegard',
      status: up ? 'done' : 'skipped',
      detail: up ? `Running at ${baseUrl(c)} (version ${up.version}).` : 'Not running.',
      ...(up ? {} : { command: 'hildegard start' }),
    },
  ];
  for (const m of snap?.models ?? [])
    if (m.installed || m.downloading)
      steps.push({
        id: `model-${m.id}`,
        title: `Model ${m.id}`,
        status: m.installed ? 'done' : 'skipped',
        detail: m.installed
          ? 'Installed.'
          : `Downloading, ${Math.round(((m.downloading?.done ?? 0) / (m.downloading?.total || 1)) * 100)}%.`,
      });
  const agents = listAgents();
  for (const a of agents.filter((x) => x.connected))
    steps.push({ id: `agent-${a.id}`, title: a.name, status: 'done', detail: 'Linked.' });
  return result(steps, '', {
    running: Boolean(up),
    url: baseUrl(c),
    version: VERSION,
    gpu,
    runtime,
    engine: snap?.engine ?? null,
    models: snap?.models ?? [],
    agents,
    dataDir: c.dataDir,
  });
}

export function open(ctx: Ctx): Result {
  const url = baseUrl(ctx.config);
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return result([], `Opening ${url}`, { url });
}

export const dataExists = (c: Config) => existsSync(c.dataDir);
