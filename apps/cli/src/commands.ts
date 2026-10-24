// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Catalog, ChoirDevice, ChoirState, HfState, HostState, Snapshot } from '@hildegard/presets';
import {
  AGENTS,
  connectAgent,
  detectGpu,
  disconnectAgent,
  findAgent,
  fit,
  fitWhy,
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
import { type Config, guardProcess, startServer, VERSION } from '@hildegard/server';
import { hostStep } from './host.ts';
import { printEvent, printStep, type Result, result } from './output.ts';

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

export const baseUrl = (c: Config) => `http://127.0.0.1:${c.port}`;

export async function api<T>(
  c: Config,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
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
  const srv = await startServer(
    { ...c, uiDir },
    {
      onStop: () => {
        console.error(`${new Date().toISOString()} Stopping: asked to from this computer.`);
        void stop();
      },
    },
  );
  console.log(`Hildegard ${VERSION} is running at ${srv.url}`);
  guardProcess(stop);
  return new Promise<never>(() => {});
}

/** The command line WMI runs on Windows: the server, with its entry noted and its output in the log. */
export function wmiLine(entryPath: string, args: string[], log: string): string {
  const q = (a: string) => `"${a}"`;
  return `cmd.exe /d /s /c "set "HILDEGARD_ENTRY=${entryPath}" && ${q(process.execPath)} ${args.map(q).join(' ')} >> ${q(log)} 2>&1"`;
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
  // The background server gets the same choices as this command.
  if (c.host !== '127.0.0.1') args.push('--host', c.host);
  if (c.allowedHosts.length) args.push('--allow-host', c.allowedHosts.join(','));
  if (c.hostPort !== null) args.push('--host-port', String(c.hostPort));
  if (c.comfyExternal) args.push('--comfy', c.comfyUrl);
  // Windows' OpenSSH ends every process of a session when it closes, detached or not, so from ssh the server is
  // started by Windows itself (WMI), outside the session.
  const viaWmi = process.platform === 'win32' && !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT);
  let child: ReturnType<typeof spawn>;
  if (viaWmi) {
    closeSync(fd);
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:HILDEGARD_WMI_LINE }; exit $r.ReturnValue',
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, HILDEGARD_WMI_LINE: wmiLine(entry(), args, log) },
      },
    );
  } else {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, HILDEGARD_ENTRY: entry() },
    });
    closeSync(fd);
    child.unref();
  }
  for (let i = 0; i < 120; i++) {
    if (await running(c))
      return result(
        [{ id: 'start', title: 'Start Hildegard', status: 'done', detail: `Running at ${url}.` }],
        `Hildegard is running at ${url}`,
        { url },
      );
    // Through WMI, the launcher exits at once; only a launch it couldn't make ends the wait early.
    if (child.exitCode !== null && (!viaWmi || child.exitCode !== 0)) break;
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
  const events = ctx.flags.has('events');
  const steps = await installRuntime({
    dataDir: c.dataDir,
    cpu: ctx.flags.has('cpu'),
    onStep: events ? (step) => printEvent({ step }) : ctx.json ? undefined : printStep,
    onLog: events
      ? (log) => printEvent({ log })
      : ctx.json || !ctx.flags.has('verbose')
        ? undefined
        : (l) => console.log(`    ${l}`),
  });
  const printed = ctx.json ? 0 : steps.length;
  const failed = steps.find((s) => s.status === 'failed' || s.status === 'needs-owner');
  if (failed)
    return { ...result(steps, failed.status === 'failed' ? 'The install stopped.' : failed.detail), printed };
  // Restart, so the server runs the ComfyUI it just installed.
  if (await running(c)) await stop(ctx);
  const s = await start(ctx);
  if (events) for (const step of s.steps) printEvent({ step });
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

export async function ensureRunning(ctx: Ctx): Promise<Step | null> {
  if (await running(ctx.config)) return null;
  const s = await start(ctx);
  return s.steps[0] ?? null;
}

/** The first model in the catalog that fits this GPU, or one that fits tightly. */
export function starterModel(catalog: Catalog, gpu: Gpu) {
  return (
    catalog.models.find((m) => fit(gpu, m) === 'fits') ??
    catalog.models.find((m) => fit(gpu, m) === 'tight') ??
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
  const state = snap.models.find((x) => x.id === id);
  if (state?.installed) return { id: 'model', title, status: 'skipped', detail: `${m.name} is installed.` };
  if (state?.gated && !snap.hf.linked)
    return {
      id: 'model',
      title,
      status: 'needs-owner',
      detail: `${m.name} downloads from Hugging Face, which wants the owner's account: link it, and accept the model's license on its Hugging Face page when asked.`,
      command: 'hildegard hf login',
    };
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
    const named = ctx.opts.get('accept-license');
    const id = args[1] ?? named;
    if (!id) return result([], 'Say which model: `hildegard models install <id>`.', { ok: false });
    // `--accept-license` accepts the license of the model named here, and only that one.
    if (named && named !== id)
      return result([], `--accept-license names ${named}, but this installs ${id}. Nothing changed.`, {
        ok: false,
      });
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
      fit: fit(gpu, m),
      fitWhy: fitWhy(gpu, m),
      installed: s?.installed ?? false,
      licenseAccepted: s?.licenseAccepted ?? false,
      downloading: s?.downloading ?? null,
    };
  });
  const steps: Step[] = list.map((m) => ({
    id: m.id,
    title: `${m.name} (${m.id})`,
    status: m.installed ? 'done' : 'skipped',
    detail: `${m.installed ? 'Installed' : m.downloading ? `Downloading, ${Math.round((m.downloading.done / m.downloading.total) * 100)}%` : 'Not installed'} · needs ${m.minVramGb} GB · ${m.fitWhy === 'apple-gpu' ? 'doesn’t render on Apple’s GPU yet, use a paired device' : { fits: 'fits this GPU', tight: 'tight on this GPU, slower', no: 'won’t fit this GPU' }[m.fit]} · ${m.license}`,
  }));
  return result(steps, '', { models: list, gpu });
}

// ── setup ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function ask(question: string): Promise<boolean> {
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
  if (!readRuntime(c.dataDir) && !c.comfyExternal && !c.fake && !rendersElsewhere(c))
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

  // A first model that fits: here, or already on the device takes render on.
  const gpu = detectGpu();
  const catalog = await api<Catalog>(c, '/api/catalog');
  const want = ctx.opts.get('model');
  const snap = await api<Snapshot>(c, '/api/snapshot');
  const remote = snap.choir?.devices.find((d) => d.name === snap.choir.use);
  const pick = want
    ? catalog.models.find((m) => m.id === want)
    : remote
      ? catalog.models.find((m) => remote.models.includes(m.id))
      : starterModel(catalog, gpu);
  if (remote && !want)
    add(
      pick
        ? {
            id: 'model',
            title: `Use ${pick.name}`,
            status: 'skipped',
            detail: `Takes render on ${remote.name}, which has ${pick.name}.`,
          }
        : {
            id: 'model',
            title: 'Pick a model',
            status: 'needs-owner',
            detail: `Takes render on ${remote.name}, which has no video model yet. Install one there.`,
            command: 'hildegard setup',
          },
    );
  else if (!pick)
    add({
      id: 'model',
      title: 'Pick a model',
      status: want ? 'failed' : 'skipped',
      detail: want
        ? `No model “${want}”. Models: ${catalog.models.map((m) => m.id).join(', ')}.`
        : gpu.backend === 'mps' && catalog.models.some((m) => fitWhy(gpu, m) === 'apple-gpu')
          ? 'None of the video models render well on Apple’s GPU yet. Pair this Mac with a computer that has an NVIDIA or AMD GPU, and takes render there.'
          : `No video model fits ${gpu.backend === 'cpu' ? 'without a GPU' : `${gpu.vramGb} GB`}. Pair this computer with one that has a bigger GPU, and takes render there.`,
      ...(want ? {} : { command: 'hildegard choir join' }),
    });
  else {
    // Without questions, a license is accepted only when `--accept-license` names this very model: the owner said
    // yes to its terms, and the agent passes that on. A bare flag accepts nothing, whichever model setup picks.
    let accept = ctx.opts.get('accept-license') === pick.id;
    if (!accept && !ctx.yes && !ctx.json && process.stdin.isTTY) {
      console.log(`\n${pick.name} fits this computer. It comes under the ${pick.license}:`);
      for (const t of pick.terms) console.log(`  • ${t}`);
      console.log(`  ${pick.licenseUrl}`);
      accept = await ask(`Accept it and download ${pick.name}?`);
    }
    if (ctx.flags.has('hf-token-stdin')) {
      // The owner's token, piped in: never on the command line, where shell history and process lists keep it.
      const linked = await hf({ ...ctx, flags: new Set([...ctx.flags, 'token-stdin']) }, ['login']);
      add({ ...linked.steps[0]!, id: 'huggingface' });
      if (!linked.ok) return { ...result(steps, linked.message), printed: steps.length };
    }
    let step = await installModel(ctx, pick.id, accept);
    if (step.status === 'needs-owner' && step.command?.endsWith('--accept-license'))
      step = {
        ...step,
        command: `hildegard setup --model ${pick.id} --accept-license ${pick.id} --yes --json`,
      };
    // At a terminal, link Hugging Face right here rather than sending the owner off to do it.
    if (step.command === 'hildegard hf login' && process.stdin.isTTY && !ctx.json) {
      const linked = await hf(ctx, ['login']);
      if (linked.ok && !linked.needsOwner) step = await installModel(ctx, pick.id, accept);
    }
    add(step);
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
    snap?.engine.comfy === 'remote'
      ? {
          id: 'comfyui',
          title: 'ComfyUI',
          status: snap.engine.online ? 'done' : 'skipped',
          detail: `Takes render on ${snap.engine.device}${snap.engine.online ? '' : `, which isn’t answering: ${snap.engine.problem ?? 'is Hildegard running there?'}`}.`,
        }
      : {
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
  const hosting = up ? await api<HostState>(c, '/api/host').catch(() => null) : null;
  if (hosting?.on) steps.push(hostStep(hosting));
  return result(steps, '', {
    running: Boolean(up),
    url: baseUrl(c),
    version: VERSION,
    gpu,
    runtime,
    engine: snap?.engine ?? null,
    models: snap?.models ?? [],
    agents,
    choir: snap?.choir ?? null,
    host: hosting,
    dataDir: c.dataDir,
  });
}

/** This computer sends its takes to a joined device, so it needs no ComfyUI of its own. */
function rendersElsewhere(c: Config): boolean {
  try {
    const f = JSON.parse(readFileSync(join(c.dataDir, 'choir', 'devices.json'), 'utf8')) as { use?: string };
    return !!f.use && f.use !== 'local';
  } catch {
    return false;
  }
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

// ── Hugging Face ─────────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN_PAGE = 'https://huggingface.co/settings/tokens/new?tokenType=read';

/** Reads a line without echoing it, so a token never shows on screen or in scrollback. */
export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    const finish = (v: string) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(v.trim());
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\u0003') {
          finish('');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Opens a URL in the default browser. Windows' `start` would cut a URL at its first `&`, so it gets rundll32. */
function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
      .on('error', () => {})
      .unref();
  } catch {}
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const linkedStep = (s: HfState): Step => ({
  id: 'huggingface',
  title: 'Link Hugging Face',
  status: 'skipped',
  detail: `Linked${s.user ? ` as ${s.user}` : ''}; the token is kept in ${{ keychain: 'your system keychain', file: 'a file only you can read', env: 'the HF_TOKEN environment variable' }[s.storage ?? 'file']}.`,
});

/**
 * `hildegard hf [status|login|logout]`. The token never goes on the command line (it would land in shell history
 * and process lists): it comes from Hugging Face's own sign-in, a hidden prompt, or stdin with --token-stdin.
 * An agent can't link an account for the owner, so without a terminal this asks the owner to.
 */
export async function hf(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  const c = ctx.config;
  const action = args[0] ?? 'status';
  const state = await api<HfState>(c, '/api/hf');

  if (action === 'status')
    return result(
      [
        state.linked
          ? linkedStep(state)
          : {
              id: 'huggingface',
              title: 'Link Hugging Face',
              status: 'needs-owner',
              detail:
                'Not linked. Open models download without it; LTX needs it, after you accept its license on huggingface.co.',
              command: 'hildegard hf login',
            },
      ],
      '',
      { hf: state },
    );

  if (action === 'logout') {
    const s = await api<HfState>(c, '/api/hf/unlink', { method: 'POST' });
    return result(
      [
        {
          id: 'huggingface',
          title: 'Unlink Hugging Face',
          status: 'done',
          detail: 'Removed the token from this computer.',
        },
      ],
      s.linked ? 'HF_TOKEN is still set in the environment, so downloads keep using it.' : 'Unlinked.',
      { hf: s },
    );
  }

  if (action !== 'login')
    return result([], 'Use `hildegard hf status`, `hf login` or `hf logout`.', { ok: false });
  if (state.linked && !ctx.flags.has('force')) return result([linkedStep(state)], '', { hf: state });

  const fail = (detail: string): Result =>
    result([{ id: 'huggingface', title: 'Link Hugging Face', status: 'failed', detail }], detail);
  const done = (s: HfState) =>
    result(
      [{ ...linkedStep(s), status: 'done' }],
      `Hugging Face is linked${s.user ? ` as ${s.user}` : ''}.`,
      { hf: s },
    );

  if (ctx.flags.has('token-stdin')) {
    try {
      return done(
        await api<HfState>(c, '/api/hf/token', { method: 'POST', body: { token: await readStdin() } }),
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  if (!process.stdin.isTTY || ctx.json)
    return result(
      [
        {
          id: 'huggingface',
          title: 'Link Hugging Face',
          status: 'needs-owner',
          detail: `The owner signs in to their own Hugging Face account; an agent never handles the token. In a terminal on this computer, run the command below${state.found ? ' and press Enter to use the Hugging Face sign-in already on this computer' : state.oauth ? ' and approve Hildegard on huggingface.co' : `, and paste a read token from ${TOKEN_PAGE}`}. Or use Settings › Hugging Face in the Studio.`,
          command: 'hildegard hf login',
        },
      ],
      'Waiting on the owner to link Hugging Face.',
      { hf: state },
    );

  const waitLinked = async (ms: number): Promise<HfState | null> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api<HfState>(c, '/api/hf');
      if (s.linked) return s;
    }
    return null;
  };

  // Signed in already with Hugging Face's own tools: one keypress.
  if (state.found) {
    if (await ask('This computer is signed in to Hugging Face already. Use that sign-in?')) {
      try {
        return done(await api<HfState>(c, '/api/hf/import', { method: 'POST' }));
      } catch (e) {
        console.log(`${(e as Error).message} Signing in another way.`);
      }
    }
  }

  // At the computer itself: the browser, nothing to copy. Over SSH there's no browser here, so a code instead.
  if (state.oauth && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) {
    try {
      const { url } = await api<{ url: string }>(c, '/api/hf/oauth/start', { method: 'POST' });
      openInBrowser(url);
      console.log(
        `Approve Hildegard on huggingface.co in your browser. If no browser opened, go to:\n${url}`,
      );
      const s = await waitLinked(5 * 60_000);
      if (s) return done(s);
      console.log('No answer from the browser. Trying a code instead.');
    } catch {
      // No browser sign-in from here: a code works just as well.
    }
  }

  if (state.oauth) {
    try {
      const d = await api<{ userCode: string; verificationUri: string; expiresIn: number }>(
        c,
        '/api/hf/device',
        {
          method: 'POST',
        },
      );
      console.log(`Open ${d.verificationUri}\nand enter the code ${d.userCode}. Waiting for Hugging Face…`);
      const s = await waitLinked(d.expiresIn * 1000);
      if (s) return done(s);
      return fail('The code expired before it was approved. Run `hildegard hf login` again.');
    } catch {
      // Hugging Face's sign-in isn't reachable: a token works just as well.
    }
  }
  console.log(
    `Make a read token at ${TOKEN_PAGE}\n(Hildegard only reads models with it.) Then paste it here; it won't show.`,
  );
  const token = await askSecret('Token: ');
  if (!token) return fail('No token given. Nothing changed.');
  try {
    return done(await api<HfState>(c, '/api/hf/token', { method: 'POST', body: { token } }));
  } catch (e) {
    return fail((e as Error).message);
  }
}

export const dataExists = (c: Config) => existsSync(c.dataDir);

// ── Choir: render on another of your devices ─────────────────────────────────────────────────────────────────────

const deviceStep = (d: ChoirDevice, use: string): Step => ({
  id: `device-${d.name}`,
  title: d.name,
  status: d.online ? 'done' : 'skipped',
  detail: `${d.name === use ? 'Takes render here. ' : ''}${d.online ? `Online${d.gpu ? ` · ${d.gpu}` : ''}${d.models.length ? ` · ${d.models.join(', ')}` : ''}.` : (d.problem ?? 'Not answering.')} ${d.url}`,
});

/**
 * `hildegard choir invite|join|list|use|leave|revoke`. The device with the GPU invites; the one without joins with
 * the code it prints. A join code holds a key, so `join` reads it from a hidden prompt or stdin by preference.
 */
export async function choir(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  const c = ctx.config;
  const action = args[0] ?? 'list';
  const fail = (title: string, e: unknown) =>
    result([{ id: 'choir', title, status: 'failed', detail: (e as Error).message }], (e as Error).message);
  switch (action) {
    case 'invite': {
      try {
        // --key-stdin: a key the joining device made itself (a rented GPU it started), never on the command line.
        const key = ctx.flags.has('key-stdin') ? await readStdin() : undefined;
        const r = await api<{ code: string; url: string }>(c, '/api/choir/invite', {
          method: 'POST',
          body: { url: ctx.opts.get('url'), key },
        });
        if (!ctx.json)
          console.log(
            `This computer shares its GPU at ${r.url}.\nOn your other device, run \`hildegard choir join\` and paste this code (it works once per device; keep it private):\n\n${r.code}\n`,
          );
        return result(
          [
            {
              id: 'invite',
              title: 'Share this GPU',
              status: 'done',
              detail: `Paired devices reach it at ${r.url}.`,
            },
          ],
          'Stop sharing any time with `hildegard choir revoke`.',
          { code: r.code, url: r.url },
        );
      } catch (e) {
        if ((e as { status?: number }).status === 409)
          return result(
            [
              {
                id: 'invite',
                title: 'Share this GPU',
                status: 'needs-owner',
                detail: (e as Error).message,
                command: 'tailscale up',
              },
            ],
            'Waiting on Tailscale.',
          );
        return fail('Share this GPU', e);
      }
    }
    case 'revoke': {
      await api<ChoirState>(c, '/api/choir/revoke', { method: 'POST' });
      return result(
        [
          {
            id: 'revoke',
            title: 'Stop sharing',
            status: 'done',
            detail: 'Every paired device’s key is gone.',
          },
        ],
        'This computer no longer shares its GPU.',
      );
    }
    case 'join': {
      let code = args[1] ?? '';
      if (!code && ctx.flags.has('code-stdin')) code = await readStdin();
      if (!code && process.stdin.isTTY && !ctx.json) code = await askSecret('Join code (it won’t show): ');
      if (!code)
        return result(
          [
            {
              id: 'join',
              title: 'Join a device',
              status: 'needs-owner',
              detail: 'Run `hildegard choir invite` on the device with the GPU, then paste its code here.',
              command: 'hildegard choir join',
            },
          ],
          'Waiting on a join code.',
        );
      try {
        const r = await api<{ device: ChoirDevice; choir: ChoirState }>(c, '/api/choir/join', {
          method: 'POST',
          body: { code, name: ctx.opts.get('name') },
        });
        const using = r.choir.use === r.device.name;
        return result(
          [
            {
              ...deviceStep(r.device, r.choir.use),
              id: 'join',
              status: 'done',
              title: `Join ${r.device.name}`,
            },
          ],
          using
            ? `Takes now render on ${r.device.name}.`
            : `Joined ${r.device.name}. Render there with \`hildegard choir use ${r.device.name}\`.`,
          { device: r.device, choir: r.choir },
        );
      } catch (e) {
        return fail('Join a device', e);
      }
    }
    case 'use': {
      const name = args[1];
      if (!name)
        return result([], 'Say where: `hildegard choir use <device>` or `use local`.', { ok: false });
      try {
        const s = await api<ChoirState>(c, '/api/choir/use', { method: 'POST', body: { name } });
        return result([], name === 'local' ? 'Takes render on this computer.' : `Takes render on ${name}.`, {
          choir: s,
        });
      } catch (e) {
        return fail('Choose where takes render', e);
      }
    }
    case 'leave': {
      const name = args[1];
      if (!name) return result([], 'Say which device: `hildegard choir leave <device>`.', { ok: false });
      try {
        const s = await api<ChoirState>(c, '/api/choir/leave', { method: 'POST', body: { name } });
        return result(
          [
            {
              id: 'leave',
              title: `Leave ${name}`,
              status: 'done',
              detail: 'Its key is gone from this computer.',
            },
          ],
          s.use === 'local' ? 'Takes render on this computer.' : '',
          { choir: s },
        );
      } catch (e) {
        return fail(`Leave ${name}`, e);
      }
    }
    case 'list': {
      const s = await api<ChoirState>(c, '/api/choir');
      const steps: Step[] = [
        {
          id: 'local',
          title: 'This computer',
          status: s.use === 'local' ? 'done' : 'skipped',
          detail: `${s.use === 'local' ? 'Takes render here. ' : ''}${s.sharing.on ? `Shares its GPU at ${s.sharing.url}${s.sharing.problem ? `, but ${s.sharing.problem}` : ''}.` : 'Not sharing its GPU.'}`,
        },
        ...s.devices.map((d) => deviceStep(d, s.use)),
      ];
      return result(
        steps,
        s.devices.length ? '' : 'No other devices yet. On one with a GPU, run `hildegard choir invite`.',
        { choir: s },
      );
    }
    default:
      return result([], 'Use `hildegard choir invite`, `join`, `list`, `use`, `leave` or `revoke`.', {
        ok: false,
      });
  }
}
