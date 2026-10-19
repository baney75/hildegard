// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ComfySdkEngine } from '@hildegard/comfy';
import { type FakeProxy, startFakeProxy } from '@hildegard/comfy/fake';
import { type EngineState, type LoadedCatalog, loadCatalog } from '@hildegard/presets';
import { ComfyRuntime } from '@hildegard/runtime';
import { serve } from '@hono/node-server';
import { createApp, SOURCE, VERSION } from './app.ts';
import type { Config } from './config.ts';
import { Exporter } from './export.ts';
import { fileStore, HfLink, keychainStore, type SecretStore } from './hf.ts';
import { ModelManager } from './models.ts';
import { Scheduler } from './scheduler.ts';
import { Store } from './store.ts';

export interface Running {
  url: string;
  config: Config;
  store: Store;
  scheduler: Scheduler;
  models: ModelManager;
  hf: HfLink;
  /** The ComfyUI Hildegard runs itself, when it does. */
  runtime: ComfyRuntime | null;
  close(): Promise<void>;
}

/** Start everything: the store, the render queue, model installs, the Hugging Face link and the HTTP server. */
export async function startServer(
  config: Config,
  opts: { loaded?: LoadedCatalog; fakeTickMs?: number; secrets?: SecretStore; onStop?: () => void } = {},
): Promise<Running> {
  const { catalog, lock } = opts.loaded ?? loadCatalog();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const mediaDir = join(config.dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  let fake: FakeProxy | null = null;
  let comfyUrl = config.comfyUrl;
  if (config.fake) {
    fake = await startFakeProxy({
      tickMs: opts.fakeTickMs ?? (Number(process.env.HILDEGARD_FAKE_TICK_MS) || 120),
    });
    comfyUrl = fake.url;
  }

  const store = new Store(config.dataDir);
  const comfy: EngineState['comfy'] = config.fake
    ? 'fake'
    : config.comfyExternal
      ? 'external'
      : ComfyRuntime.installed(config.dataDir)
        ? 'managed'
        : 'not-installed';
  // The managed ComfyUI starts in the background; the engine follows it to whatever ports it gets.
  let runtime: ComfyRuntime | null = null;
  if (comfy === 'managed') {
    runtime = new ComfyRuntime({
      dataDir: config.dataDir,
      onChange: (s) => {
        if (s.url) scheduler.setEngine(new ComfySdkEngine(s.url));
        scheduler.setProblem(
          s.status === 'failed' || s.status === 'restarting'
            ? s.error
            : s.status === 'starting'
              ? 'ComfyUI is starting.'
              : null,
        );
      },
    });
  }
  const engine = new ComfySdkEngine(comfyUrl);
  const scheduler = new Scheduler({
    store,
    engine,
    catalog,
    mediaDir,
    fake: config.fake,
    comfy,
    onEngine: (engineState) => store.emit({ type: 'engine', engine: engineState }),
  });
  if (comfy === 'not-installed')
    scheduler.setProblem('ComfyUI isn’t installed yet. Run `hildegard install`.');
  await runtime?.start();
  const secrets =
    opts.secrets ?? (await keychainStore()) ?? fileStore(join(config.dataDir, 'secrets', 'huggingface.json'));
  const hf = new HfLink({
    store: secrets,
    clientId: config.hfClientId,
    onChange: (s) => store.emit({ type: 'hf', hf: s }),
  });
  const models = new ModelManager({
    comfyDir: config.comfyDir ?? join(config.dataDir, 'comfyui'),
    dataDir: config.dataDir,
    catalog,
    lock,
    tokens: hf,
    onChange: (m) => store.emit({ type: 'models', models: m }),
  });

  const exporter = new Exporter({
    store,
    catalog,
    mediaDir,
    dataDir: config.dataDir,
    credit: `Made with Hildegard ${VERSION} (${SOURCE.url}).`,
    onChange: (e) => store.emit({ type: 'export', export: e }),
  });
  const app = createApp({
    exporter,
    config,
    store,
    scheduler,
    catalog,
    models,
    hf,
    mediaDir,
    onStop: opts.onStop,
    url: `http://127.0.0.1:${config.port}`,
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
    s.once('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  // Bound to one address (a Tailscale IP, say), it still answers on loopback: the CLI and linked AI apps use that.
  const loopback = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(config.host)
    ? null
    : await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => resolve(s));
        s.once('error', reject);
      });
  scheduler.start();

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    config,
    store,
    scheduler,
    models,
    hf,
    runtime,
    async close() {
      scheduler.stop();
      await runtime?.stop();
      store.flush();
      await new Promise<void>((r) => server.close(() => r()));
      if (loopback) await new Promise<void>((r) => loopback.close(() => r()));
      await fake?.close();
    },
  };
}

export { VERSION };
