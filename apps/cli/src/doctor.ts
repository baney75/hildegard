// SPDX-License-Identifier: AGPL-3.0-only
import type { GrantsResponse, HostState, Snapshot } from '@hildegard/presets';
import { detectGpu, listAgents, readRuntime, type Step } from '@hildegard/runtime';
import { COMFY_STARTING, tailnetSelf } from '@hildegard/server';
import { api, baseUrl, type Ctx, running } from './commands.ts';
import { hostStep } from './host.ts';
import { type Result, result } from './output.ts';

/**
 * `hildegard doctor`: every part, whether it works, and the command that fixes it. Each step's `command` is the fix;
 * `needs-owner` steps are the owner's to do. It never changes anything.
 */
export async function doctor(ctx: Ctx): Promise<Result> {
  const c = ctx.config;
  const steps: Step[] = [];
  const gpu = detectGpu();
  steps.push(
    gpu.backend === 'cpu'
      ? {
          id: 'gpu',
          title: 'GPU',
          status: 'skipped',
          detail: `${gpu.note ?? 'No supported GPU here.'} Renders would take hours on the CPU; render on another device instead.`,
          command: 'hildegard choir join',
        }
      : {
          id: 'gpu',
          title: 'GPU',
          status: 'done',
          detail: `${gpu.name}${gpu.vramGb ? `, ${gpu.vramGb} GB` : ''}${gpu.note ? `. ${gpu.note}` : ''}`,
        },
  );

  const up = await running(c);
  steps.push(
    up
      ? {
          id: 'server',
          title: 'Hildegard',
          status: 'done',
          detail: `Running at ${baseUrl(c)} (version ${up.version}).`,
        }
      : {
          id: 'server',
          title: 'Hildegard',
          status: 'failed',
          detail: 'Not running.',
          command: 'hildegard start --json',
        },
  );
  const snap = up ? await api<Snapshot>(c, '/api/snapshot').catch(() => null) : null;
  const runtime = readRuntime(c.dataDir);

  steps.push(comfyStep(snap?.engine, runtime, { up: !!up, fake: c.fake, external: !!c.comfyExternal }));
  const e = snap?.engine;

  // Models.
  if (snap) steps.push(...modelSteps(snap));

  // Tailscale, the Choir and the link.
  const ts = await tailnetSelf();
  steps.push(
    ts
      ? {
          id: 'tailscale',
          title: 'Tailscale',
          status: 'done',
          detail: `Signed in as ${ts.dns ?? ts.ip}${ts.dns ? ` (${ts.ip})` : ''}.`,
        }
      : {
          id: 'tailscale',
          title: 'Tailscale',
          status: 'skipped',
          detail:
            'Not running here. It’s needed only to render on your other devices or to host Hildegard at a link. Install it from tailscale.com; the owner signs in.',
          command: 'tailscale up',
        },
  );
  if (snap?.choir) {
    const ch = snap.choir;
    if (!ch.devices.length && !ch.sharing.on)
      steps.push({ id: 'choir', title: 'Devices', status: 'skipped', detail: 'No other devices paired.' });
    for (const d of ch.devices)
      steps.push(
        d.online
          ? {
              id: `device-${d.name}`,
              title: d.name,
              status: 'done',
              detail: `${d.name === ch.use ? 'Takes render here. ' : ''}Online${d.gpu ? ` · ${d.gpu}` : ''}.`,
            }
          : {
              id: `device-${d.name}`,
              title: d.name,
              status: d.name === ch.use ? 'failed' : 'skipped',
              detail: `${d.problem ?? 'Not answering.'} Is Hildegard running there, and Tailscale up?`,
              ...(d.name === ch.use ? { command: 'hildegard choir use local' } : {}),
            },
      );
    if (ch.sharing.on)
      steps.push({
        id: 'sharing',
        title: 'Sharing this GPU',
        status: ch.sharing.problem ? 'failed' : 'done',
        detail: ch.sharing.problem ?? `Paired devices reach it at ${ch.sharing.url}.`,
        ...(ch.sharing.problem ? { command: 'tailscale up' } : {}),
      });
  }
  const h = up ? await api<HostState>(c, '/api/host').catch(() => null) : null;
  if (h) steps.push(hostStep(h));
  // MCP from other devices: only once there is a link to reach it at.
  const g = h?.on ? await api<GrantsResponse>(c, '/api/auth/grants').catch(() => null) : null;
  if (h?.on && g) {
    const keys = g.grants.filter((x) => x.kind === 'key').length;
    const bots = g.grants.length - keys;
    steps.push({
      id: 'mcp',
      title: 'MCP for AI apps elsewhere',
      status: g.mcpUrl ? 'done' : 'skipped',
      detail: g.mcpUrl
        ? `${g.mcpUrl} · ${keys === 1 ? '1 key' : `${keys} keys`}, ${bots === 1 ? '1 chatbot' : `${bots} chatbots`}${h.via === 'funnel' ? '' : '. Chatbots on the web need `hildegard host --funnel`'}.`
        : 'Waiting on the link.',
      ...(g.mcpUrl && !g.grants.length ? { command: 'hildegard host key "<app and device>"' } : {}),
    });
  }

  const agents = listAgents().filter((a) => a.connected);
  steps.push({
    id: 'agents',
    title: 'AI apps',
    status: agents.length ? 'done' : 'skipped',
    detail: agents.length ? `Linked: ${agents.map((a) => a.name).join(', ')}.` : 'None linked.',
    ...(agents.length ? {} : { command: 'hildegard connect --all' }),
  });

  const broken = steps.filter((s) => s.status === 'failed');
  const owner = steps.filter((s) => s.status === 'needs-owner');
  return result(
    steps,
    broken.length
      ? `${broken.length === 1 ? 'One thing needs' : `${broken.length} things need`} fixing: run each command shown.`
      : owner.length
        ? 'Everything works; the steps marked ! wait on the owner.'
        : 'Everything works.',
    { running: !!up, url: baseUrl(c), gpu, tailscale: ts, host: h, engine: e ?? null },
  );
}

/** ComfyUI: here, or on the device takes render on. Still loading is a wait, not a fault, so it has no fix. */
export function comfyStep(
  e: Snapshot['engine'] | undefined,
  runtime: ReturnType<typeof readRuntime>,
  { up, fake, external }: { up: boolean; fake: boolean; external: boolean },
): Step {
  if (e?.comfy === 'remote')
    return e.online
      ? { id: 'comfyui', title: 'ComfyUI', status: 'done', detail: `Takes render on ${e.device}.` }
      : {
          id: 'comfyui',
          title: 'ComfyUI',
          status: 'failed',
          detail: `Takes render on ${e.device}, which isn’t answering: ${e.problem ?? 'is Hildegard running there?'} Render here again with the command, or start Hildegard there.`,
          command: 'hildegard choir use local',
        };
  if (fake || e?.fake)
    return { id: 'comfyui', title: 'ComfyUI', status: 'done', detail: 'The stand-in GPU, for testing.' };
  if (e?.online)
    return {
      id: 'comfyui',
      title: 'ComfyUI',
      status: 'done',
      detail: `Running${runtime ? ` (ComfyUI ${runtime.comfyui}, PyTorch ${runtime.torch})` : ''}.`,
    };
  if (!runtime && !external)
    return {
      id: 'comfyui',
      title: 'ComfyUI',
      status: 'failed',
      detail: 'Not installed.',
      command: 'hildegard install --yes --json',
    };
  if (e?.problem === COMFY_STARTING)
    return {
      id: 'comfyui',
      title: 'ComfyUI',
      status: 'skipped',
      detail: 'ComfyUI is starting. Run doctor again in a minute.',
    };
  return {
    id: 'comfyui',
    title: 'ComfyUI',
    status: up ? 'failed' : 'skipped',
    detail: e?.problem ?? (up ? 'Not answering.' : 'Starts with Hildegard.'),
    command: up ? 'hildegard restart --json' : 'hildegard start --json',
  };
}

/** The Models and Hugging Face steps, from what the server says about each model. */
export function modelSteps(
  snap: Pick<Snapshot, 'models' | 'hf'> & { choir?: Pick<Snapshot['choir'], 'use'> },
): Step[] {
  const out: Step[] = [];
  const installed = snap.models.filter((m) => m.installed);
  const downloading = snap.models.filter((m) => m.downloading);
  out.push(
    installed.length
      ? {
          id: 'models',
          title: 'Models',
          status: 'done',
          detail: `Installed: ${installed.map((m) => m.id).join(', ')}.`,
        }
      : downloading.length
        ? {
            id: 'models',
            title: 'Models',
            status: 'skipped',
            detail: `Downloading ${downloading.map((m) => `${m.id} (${Math.round(((m.downloading?.done ?? 0) / (m.downloading?.total || 1)) * 100)}%)`).join(', ')}.`,
          }
        : snap.models.length && snap.models.every((m) => m.fitWhy === 'apple-gpu')
          ? {
              id: 'models',
              title: 'Models',
              status: 'skipped',
              detail:
                'None of the video models render on this Mac yet. Pair a device with an NVIDIA or AMD GPU.',
              command: 'hildegard choir join',
            }
          : {
              id: 'models',
              title: 'Models',
              status: 'needs-owner',
              detail:
                'No video model yet. Setup picks one that fits; the owner accepts its license first (show them its terms).',
              command: 'hildegard setup --json',
            },
  );
  // A model this computer can't render doesn't need the account here, and while takes render on a paired device,
  // that device downloads the models.
  const paired = !!snap.choir && snap.choir.use !== 'local';
  const gated = paired ? [] : snap.models.filter((m) => m.gated && !m.installed && m.fitWhy !== 'apple-gpu');
  out.push(
    snap.hf.linked
      ? {
          id: 'huggingface',
          title: 'Hugging Face',
          status: 'done',
          detail: `Linked${snap.hf.user ? ` as ${snap.hf.user}` : ''}.`,
        }
      : {
          id: 'huggingface',
          title: 'Hugging Face',
          status: gated.length ? 'needs-owner' : 'skipped',
          detail: gated.length
            ? `Not linked. ${gated.map((m) => m.id).join(' and ')} download${gated.length === 1 ? 's' : ''} only with the owner’s account.`
            : 'Not linked; no model here needs it.',
          command: 'hildegard hf login',
        },
  );
  return out;
}
