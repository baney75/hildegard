// SPDX-License-Identifier: AGPL-3.0-only
import type { GrantsResponse, HostState, Snapshot, TunnelReport } from '@hildegard/presets';
import { detectGpu, listAgents, readRuntime, readVoiceEnv, type Step } from '@hildegard/runtime';
import { COMFY_STARTING, tailnetSelf } from '@hildegard/server';
import { api, baseUrl, type Ctx, entry, running } from './commands.ts';
import { hostStep } from './host.ts';
import { type Result, result } from './output.ts';
import { serviceStep } from './service.ts';
import { providerStep } from './tunnel.ts';

/**
 * The owner's own front door, seen from this computer: its `/.well-known/oauth-protected-resource` should name
 * `<url>/mcp`. When it can't be reached or answers wrongly this warns (a `skipped` step with the reason) and
 * never fails: the door may be reachable only from outside this network.
 */
export async function frontDoorStep(url: string, get: typeof fetch = fetch): Promise<Step> {
  const base = url.replace(/\/$/, '');
  const warn = (detail: string): Step => ({
    id: 'front-door',
    title: 'Your own front door',
    status: 'skipped',
    detail,
    command: 'hildegard host status',
  });
  try {
    const res = await get(`${base}/.well-known/oauth-protected-resource`, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok)
      return warn(
        `${base} answered ${res.status} instead of Hildegard’s sign-in details. Check that the tunnel or proxy forwards to this computer’s hosted port, with the Host header set to the public name.`,
      );
    const j = (await res.json().catch(() => null)) as { resource?: unknown } | null;
    if (j?.resource !== `${base}/mcp`)
      return warn(
        `${base} answered, but not as this Hildegard (it named ${typeof j?.resource === 'string' ? j.resource : 'no resource'}, not ${base}/mcp). Check where the tunnel or proxy forwards to, and its Host header.`,
      );
    return {
      id: 'front-door',
      title: 'Your own front door',
      status: 'done',
      detail: `${base} reaches this Hildegard: its MCP is ${j.resource}.`,
    };
  } catch (e) {
    return warn(
      `Couldn’t reach ${base} from this computer (${(e as Error).message}). If the tunnel runs elsewhere and only the outside can see it, that may be fine; otherwise check that it is up.`,
    );
  }
}

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

  // Tailscale, the Choir and the link. The server's tunnel report tells "not installed" from "signed out".
  const ts = await tailnetSelf();
  const tr = up ? await api<TunnelReport>(c, '/api/tunnel').catch(() => null) : null;
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
          detail: `${tr?.tailscale.problem ?? 'Not running here.'} It’s needed only to render on your other devices or to host Hildegard at a link through Tailscale. ${tr?.tailscale.state === 'missing' ? `Install it from ${tr.tailscale.download}; the owner signs in.` : 'The owner signs in.'}`,
          command: tr?.tailscale.fix ?? 'tailscale up',
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
  }
  // What this computer serves the others: Talk's speech and language models, and the listener they reach it on.
  const svc = serviceStep(c, entry());
  if (svc) steps.push(svc);
  if (snap?.choir)
    steps.push(
      ...serveSteps(snap.choir, {
        server: svc?.status === 'done' || svc?.status === 'failed',
        speech: !!readVoiceEnv(c.dataDir, 'speech'),
      }),
    );
  const h = up ? await api<HostState>(c, '/api/host').catch(() => null) : null;
  if (h) steps.push(hostStep(h));
  // A tunnel Hildegard runs: is cloudflared there, signed in and connected, and if not, the exact fix.
  if (h?.on && h.tunnel && tr)
    steps.push({ ...providerStep('cloudflare', tr, true), id: 'tunnel', title: 'Cloudflare tunnel' });
  if (h?.on && h.via === 'custom' && h.url) steps.push(await frontDoorStep(h.url));
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
        ? `${g.mcpUrl} · ${keys === 1 ? '1 key' : `${keys} keys`}, ${bots === 1 ? '1 chatbot' : `${bots} chatbots`}${h.via === 'funnel' || h.via === 'custom' ? '' : '. Chatbots on the web need `hildegard host --funnel` or your own front door (`hildegard host --public-url https://<name>`)'}.`
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

/**
 * Voice, the language model and the Choir listener, from what the server says this computer can do. On a server
 * (the service from `install --server` runs it) each missing one is a fault; elsewhere it's optional.
 */
export function serveSteps(
  ch: Pick<Snapshot['choir'], 'capabilities' | 'sharing'>,
  { server, speech }: { server: boolean; speech: boolean },
): Step[] {
  const missing = server ? 'failed' : 'skipped';
  const cap = ch.capabilities;
  const looking = 'Hildegard hasn’t looked yet. Run doctor again in a minute.';
  const voice: Step = !cap
    ? { id: 'voice', title: 'Voice', status: 'skipped', detail: looking }
    : cap.stt.length && cap.tts.length
      ? {
          id: 'voice',
          title: 'Voice',
          status: 'done',
          detail: `Transcribes with ${cap.stt.join(', ')}; speaks with ${cap.tts.join(', ')}.`,
        }
      : !speech
        ? {
            id: 'voice',
            title: 'Voice',
            status: missing,
            detail:
              'Speech and transcription aren’t installed here, so Talk can’t hear or answer on this computer.',
            command: 'hildegard voice install --env speech --json',
          }
        : {
            id: 'voice',
            title: 'Voice',
            status: missing,
            detail: `Installed, but there’s no ${cap.stt.length ? 'speech' : cap.tts.length ? 'transcription' : 'speech or transcription'} model yet. Download Whisper and Kokoro on the Studio’s Voice page, or with the voice_models MCP tool.`,
            command: 'hildegard open',
          };
  const llm: Step = !cap
    ? { id: 'llm', title: 'Language model', status: 'skipped', detail: looking }
    : cap.llm.length
      ? {
          id: 'llm',
          title: 'Language model',
          status: 'done',
          detail: `Talk answers with ${cap.llm
            .slice(0, 4)
            .map((m) => `${m.model} (${m.runtime})`)
            .join(', ')}${cap.llm.length > 4 ? ` and ${cap.llm.length - 4} more` : ''}.`,
        }
      : {
          id: 'llm',
          title: 'Language model',
          status: missing,
          detail:
            'None runs on this computer. Start Ollama, LM Studio, llama.cpp, vLLM or another OpenAI-compatible server and Hildegard finds it, or add one with the command.',
          command: 'hildegard llm add <name> <address>',
        };
  const s = ch.sharing;
  const sharing: Step = s.on
    ? {
        id: 'sharing',
        title: 'Sharing this GPU',
        status: s.problem ? 'failed' : 'done',
        detail: s.problem ?? `Paired devices reach it at ${s.url}.`,
        ...(s.problem ? { command: 'tailscale up' } : {}),
      }
    : {
        id: 'sharing',
        title: 'Sharing this GPU',
        status: missing,
        detail:
          'Not listening for your other devices. Make a join code with the command and type it on the other device.',
        command: 'hildegard choir invite',
      };
  return [voice, llm, sharing];
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
