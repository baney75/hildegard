// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard cloud`: rented GPUs. `cloud runpod up` starts a Runpod pod that installs Hildegard, shares its GPU with a
 * key made here, and stops itself when idle; this computer joins it like any device in the fleet and renders there.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceName, type Pod, PROVIDERS, podSpec, proxyUrl, Runpod, RunpodError } from '@hildegard/cloud';
import type { Catalog, ChoirState } from '@hildegard/presets';
import { resource, type Step } from '@hildegard/runtime';
import { encodeJoinCode, fileStore, keychainStore, secretStores, VERSION } from '@hildegard/server';
import { api, type Ctx, ensureRunning, readStdin } from './commands.ts';
import { dim, type Result, result } from './output.ts';

const KEY_ACCOUNT = 'cloud-runpod';
const JOIN_ACCOUNT = 'cloud-runpod-join';
const DEFAULT_MODEL = 'wan-2-2-ti2v-5b';

interface PodState {
  podId: string;
  name: string;
  url: string;
  model: string | null;
  createdAt: string;
}

const stateFile = (ctx: Ctx) => join(ctx.config.dataDir, 'cloud', 'runpod.json');
const readState = (ctx: Ctx): PodState | null => {
  try {
    return JSON.parse(readFileSync(stateFile(ctx), 'utf8')) as PodState;
  } catch {
    return null;
  }
};
const writeState = (ctx: Ctx, s: PodState) => {
  mkdirSync(join(ctx.config.dataDir, 'cloud'), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(ctx), JSON.stringify(s, null, 2), { mode: 0o600 });
};
const secrets = async (ctx: Ctx) => await secretStores(join(ctx.config.dataDir, 'secrets'));

const step = (id: string, title: string, status: Step['status'], detail: string, command?: string): Step => ({
  id,
  title,
  status,
  detail,
  ...(command ? { command } : {}),
});

const cost = (p: Pod) => p.adjustedCostPerHr ?? p.costPerHr;
const gpuOf = (p: Pod) => p.gpu?.displayName ?? p.machine?.gpuDisplayName ?? 'GPU';

export async function cloud(ctx: Ctx, args: string[], fetchFn: typeof fetch = fetch): Promise<Result> {
  const [provider, action = 'status', ...rest] = args;
  if (!provider)
    return result(
      PROVIDERS.map((p) =>
        step(
          p.id,
          p.ready ? p.name : `${p.name} (coming next)`,
          'skipped',
          `${p.mode}\nPrivacy: ${p.privacy}\nTerms: ${p.terms} (${p.termsUrl})`,
          p.ready ? p.command : undefined,
        ),
      ),
      'Rented GPUs join your fleet or render a batch. Your own computers come first; these are for when you need more.',
      { providers: PROVIDERS },
    );
  const known = PROVIDERS.find((p) => p.id === provider || (provider === 'hf' && p.id === 'huggingface'));
  if (known && !known.ready)
    return result(
      [
        step(
          known.id,
          known.name,
          'skipped',
          `${known.name} batches aren’t built yet. Use Runpod for now: \`hildegard cloud runpod up\`.`,
        ),
      ],
      'Nothing changed.',
    );
  if (provider !== 'runpod')
    return result(
      [step('cloud', 'Cloud', 'failed', `Hildegard doesn’t know “${provider}”. Use runpod, hf or colab.`)],
      'Nothing changed.',
    );
  return runpod(ctx, action, rest, fetchFn);
}

async function runpod(ctx: Ctx, action: string, _args: string[], fetchFn: typeof fetch): Promise<Result> {
  const store = await secrets(ctx);
  const keyStore = store(KEY_ACCOUNT);
  if (action === 'key') {
    if (ctx.flags.has('remove')) {
      keyStore.delete();
      return result([step('key', 'Forget the Runpod key', 'done', 'Removed.')], 'Done.');
    }
    if (!ctx.flags.has('key-stdin')) return result([needKey()], 'Waiting for the key.');
    const key = await readStdin();
    if (!/^\S{20,}$/.test(key))
      return result(
        [step('key', 'Runpod API key', 'failed', 'That doesn’t look like a Runpod API key.')],
        'Nothing changed.',
      );
    keyStore.set(key);
    return result(
      [
        step(
          'key',
          'Keep your Runpod API key',
          'done',
          `Kept in ${keyStore.kind === 'keychain' ? 'your system keychain' : 'a file only you can read'}.`,
        ),
      ],
      'Next: `hildegard cloud runpod up`.',
    );
  }

  const key = keyStore.get();
  if (!key) return result([needKey()], 'Hildegard needs your Runpod API key first.');
  const rp = new Runpod(key, fetchFn);
  const state = readState(ctx);

  try {
    if (action === 'status') return await podStatus(ctx, rp, state);
    if (action === 'down') return await podDown(ctx, rp, state);
    if (action === 'up') return await podUp(ctx, rp, state, store);
  } catch (e) {
    if (e instanceof RunpodError) return result([step('runpod', 'Runpod', 'failed', e.message)], e.message);
    throw e;
  }
  return result(
    [step('runpod', 'Runpod', 'failed', `Unknown action “${action}”. Use key, up, status or down.`)],
    'Nothing changed.',
  );
}

const needKey = () =>
  step(
    'key',
    'Add your Runpod API key',
    'needs-owner',
    'Make a key at https://console.runpod.io/user/settings (API Keys, with read and write), then pipe it in. It goes to your system keychain, never a file or a command line. Rented GPUs are billed to your Runpod account by the second.',
    'printf %s "$RUNPOD_API_KEY" | hildegard cloud runpod key --key-stdin --json',
  );

async function podStatus(ctx: Ctx, rp: Runpod, state: PodState | null): Promise<Result> {
  if (!state)
    return result(
      [step('pod', 'Runpod GPU', 'skipped', 'No pod. `hildegard cloud runpod up` starts one.')],
      '',
    );
  const pod = await rp.getPod(state.podId).catch((e) => {
    if (e instanceof RunpodError && e.status === 404) return null;
    throw e;
  });
  if (!pod || pod.desiredStatus === 'TERMINATED') {
    rmSync(stateFile(ctx), { force: true });
    return result(
      [
        step(
          'pod',
          'Runpod GPU',
          'skipped',
          'The pod is gone. `hildegard cloud runpod up` starts a new one.',
        ),
      ],
      '',
    );
  }
  const pre = await ensureRunning(ctx);
  const choir =
    pre?.status === 'failed' ? null : await api<ChoirState>(ctx.config, '/api/choir').catch(() => null);
  const device = choir?.devices.find((d) => d.name === state.name);
  const running = pod.desiredStatus === 'RUNNING';
  return result(
    [
      step(
        'pod',
        `Runpod ${gpuOf(pod)}`,
        'done',
        running
          ? `Running at $${cost(pod)?.toFixed(2) ?? '?'}/hour. ${device?.online ? 'Online in your fleet' : 'Not answering yet (installing, or starting)'}${choir?.use === state.name ? ', and renders go there' : ''}. It stops itself when idle; \`hildegard cloud runpod down\` stops it now.`
          : 'Stopped: costs only its disk. `hildegard cloud runpod up` starts it again in a minute or two.',
      ),
    ],
    '',
    {
      pod: {
        id: pod.id,
        status: pod.desiredStatus,
        gpu: gpuOf(pod),
        costPerHr: cost(pod) ?? null,
        url: state.url,
      },
      device: device ?? null,
    },
  );
}

async function podDown(ctx: Ctx, rp: Runpod, state: PodState | null): Promise<Result> {
  if (!state) return result([step('pod', 'Runpod GPU', 'skipped', 'No pod to stop.')], '');
  if (ctx.flags.has('delete')) {
    await rp.deletePod(state.podId).catch((e) => {
      if (!(e instanceof RunpodError && e.status === 404)) throw e;
    });
    rmSync(stateFile(ctx), { force: true });
    const pre = await ensureRunning(ctx);
    if (pre?.status !== 'failed')
      await api(ctx.config, '/api/choir/leave', { method: 'POST', body: { name: state.name } }).catch(
        () => {},
      );
    return result(
      [
        step(
          'pod',
          'Delete the Runpod GPU',
          'done',
          'Deleted, with its disk and the models on it. Nothing more is billed for it.',
        ),
      ],
      'Done.',
    );
  }
  await rp.stopPod(state.podId);
  return result(
    [
      step(
        'pod',
        'Stop the Runpod GPU',
        'done',
        'Stopped. Its disk (Hildegard and the models) is kept for a fast start and costs a little; `--delete` removes it.',
      ),
    ],
    'Done.',
  );
}

async function podUp(
  ctx: Ctx,
  rp: Runpod,
  state: PodState | null,
  store: (a: string) => { get(): string | null; set(v: string): void; delete(): void },
): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running here.');
  const c = ctx.config;
  const steps: Step[] = [];
  let pod: Pod | null = null;

  if (state) {
    pod = await rp.getPod(state.podId).catch((e) => {
      if (e instanceof RunpodError && e.status === 404) return null;
      throw e;
    });
    if (!pod || pod.desiredStatus === 'TERMINATED') {
      rmSync(stateFile(ctx), { force: true });
      state = null;
      pod = null;
    } else if (pod.desiredStatus === 'EXITED') {
      pod = await rp.startPod(state.podId);
      steps.push(
        step(
          'pod',
          'Start the Runpod GPU',
          'done',
          'Started again; Hildegard and the models are on its disk.',
        ),
      );
    }
  }

  if (!state) {
    const model = ctx.opts.get('model') ?? DEFAULT_MODEL;
    const catalog = await api<Catalog>(c, '/api/catalog');
    const m = catalog.models.find((x) => x.id === model);
    if (!m)
      return result(
        [
          step(
            'model',
            'Model',
            'failed',
            `Unknown model “${model}”. Use one of: ${catalog.models.map((x) => x.id).join(', ')}.`,
          ),
        ],
        'Nothing started.',
      );
    if (ctx.opts.get('accept-license') !== model)
      return result(
        [
          step(
            'model',
            `Accept the ${m.name} license`,
            'needs-owner',
            `The pod downloads ${m.name} under the ${m.license} (${m.licenseUrl}). You become its licensee. In short:\n${m.terms.map((t) => `- ${t}`).join('\n')}`,
            `hildegard cloud runpod up --model ${model} --accept-license ${model} --json`,
          ),
        ],
        'Nothing started. Show your user the license; start the pod only if they accept it.',
      );
    let hfToken: string | undefined;
    if (m.gated) {
      if (!ctx.flags.has('send-hf-token'))
        return result(
          [
            step(
              'hf',
              'Send your Hugging Face token to the pod',
              'needs-owner',
              `${m.name} downloads from Hugging Face with your account. The pod needs your token in its environment, which your Runpod account can see. Wan 2.2 (wan-2-2-ti2v-5b) needs none.`,
              `hildegard cloud runpod up --model ${model} --accept-license ${model} --send-hf-token --json`,
            ),
          ],
          'Nothing started.',
        );
      // Where `hildegard hf login` keeps it: the keychain, or a file only the owner can read.
      const hf = (await keychainStore()) ?? fileStore(join(c.dataDir, 'secrets', 'huggingface.json'));
      hfToken = process.env.HF_TOKEN || (hf.get() ?? undefined);
      if (!hfToken)
        return result(
          [
            step(
              'hf',
              'Link Hugging Face',
              'needs-owner',
              'Link Hugging Face here first.',
              'hildegard hf login',
            ),
          ],
          'Nothing started.',
        );
    }
    const joinKey = randomBytes(32).toString('base64url');
    store(JOIN_ACCOUNT).set(joinKey);
    const idle = ctx.opts.get('idle-minutes');
    pod = await rp.createPod(
      podSpec({
        version: VERSION,
        joinKey,
        boot: readFileSync(resource(join('deploy', 'runpod', 'boot.sh')), 'utf8'),
        gpus: ctx.opts.get('gpu') ? [ctx.opts.get('gpu')!] : undefined,
        model,
        acceptLicense: ctx.opts.get('accept-license'),
        hfToken,
        idleMinutes: idle === undefined ? 30 : Number(idle),
        spot: ctx.flags.has('spot'),
        community: ctx.flags.has('community'),
        volumeGb: ctx.opts.get('disk') ? Number(ctx.opts.get('disk')) : undefined,
        networkVolumeId: ctx.opts.get('volume'),
      }),
    );
    state = {
      podId: pod.id,
      name: deviceName(pod.id),
      url: proxyUrl(pod.id),
      model,
      createdAt: new Date().toISOString(),
    };
    writeState(ctx, state);
    steps.push(
      step(
        'pod',
        `Rent a ${gpuOf(pod)} on Runpod`,
        'done',
        `Pod ${pod.id}${cost(pod) ? ` at $${cost(pod)!.toFixed(2)}/hour` : ''}, ${ctx.flags.has('community') ? 'community' : 'secure'} cloud${ctx.flags.has('spot') ? ', spot (Runpod may take it back)' : ''}. It stops itself after ${idle ?? 30} idle minutes.`,
      ),
    );
  }

  // Join it: the code is built here from the key made here, so nothing secret ever comes back from the pod.
  const joinKey = store(JOIN_ACCOUNT).get();
  const choir = await api<ChoirState>(c, '/api/choir');
  if (!choir.devices.some((d) => d.name === state!.name)) {
    if (!joinKey)
      return result(
        [
          ...steps,
          step(
            'join',
            'Join the pod',
            'failed',
            'The pairing key for this pod is gone. `hildegard cloud runpod down --delete`, then `up` again.',
          ),
        ],
        'Not joined.',
      );
    const code = encodeJoinCode({ name: state.name, url: state.url, token: joinKey });
    const waitMinutes = ctx.flags.has('no-wait') ? 0 : Number(ctx.opts.get('wait-minutes') ?? 40);
    const end = Date.now() + waitMinutes * 60_000;
    let lastError = '';
    for (;;) {
      try {
        await api(c, '/api/choir/join', { method: 'POST', body: { code, name: state.name } });
        break;
      } catch (e) {
        lastError = (e as Error).message;
      }
      if (Date.now() >= end)
        return result(
          [
            ...steps,
            step(
              'join',
              'Join the pod',
              'needs-owner',
              `The pod is still setting up (the first start installs ComfyUI, PyTorch and the model: 10 to 30 minutes). Last answer: ${lastError}`,
              'hildegard cloud runpod up --json',
            ),
          ],
          'Run the same command again in a few minutes; it picks up where it left off.',
          { pod: { id: state.podId, url: state.url } },
        );
      if (!ctx.json) process.stdout.write(dim('.'));
      await new Promise((r) => setTimeout(r, 15_000));
    }
    if (!ctx.json) process.stdout.write('\n');
    steps.push(step('join', 'Join the pod', 'done', `${state.name} is in your fleet.`));
  }
  await api(c, '/api/choir/use', { method: 'POST', body: { name: state.name } });
  steps.push(
    step(
      'use',
      'Render there',
      'done',
      `Takes from this computer render on ${state.name}. \`hildegard choir use local\` switches back.`,
    ),
  );
  return result(
    steps,
    'Ready. `hildegard cloud runpod down` stops the pod; it also stops itself when idle.',
    {
      pod: { id: state.podId, url: state.url, name: state.name },
    },
  );
}
