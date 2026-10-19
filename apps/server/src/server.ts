// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ComfySdkEngine } from '@hildegard/comfy';
import { type FakeProxy, startFakeProxy } from '@hildegard/comfy/fake';
import { type LoadedCatalog, loadCatalog } from '@hildegard/presets';
import { serve } from '@hono/node-server';
import { createApp, VERSION } from './app.ts';
import type { Config } from './config.ts';
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
  close(): Promise<void>;
}

/** Start everything: the store, the render queue, model installs, the Hugging Face link and the HTTP server. */
export async function startServer(
  config: Config,
  opts: { loaded?: LoadedCatalog; fakeTickMs?: number; secrets?: SecretStore } = {},
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
  const engine = new ComfySdkEngine(comfyUrl);
  const scheduler = new Scheduler({
    store,
    engine,
    catalog,
    mediaDir,
    fake: config.fake,
    onEngine: (engineState) => store.emit({ type: 'engine', engine: engineState }),
  });
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

  const app = createApp({ config, store, scheduler, catalog, models, hf, mediaDir });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
    s.once('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  scheduler.start();

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    config,
    store,
    scheduler,
    models,
    hf,
    async close() {
      scheduler.stop();
      store.flush();
      await new Promise<void>((r) => server.close(() => r()));
      await fake?.close();
    },
  };
}

export { VERSION };
