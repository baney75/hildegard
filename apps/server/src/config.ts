// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Projects, takes, media and settings live here. */
  dataDir: string;
  host: string;
  port: number;
  /** comfy-api-proxy in front of your ComfyUI. */
  comfyUrl: string;
  /** The owner named a ComfyUI to use; otherwise Hildegard runs the one `hildegard install` set up. */
  comfyExternal: boolean;
  /** ComfyUI's own folder, when Hildegard manages it (models are installed under it). */
  comfyDir: string | null;
  /** Render with the stand-in engine: for tests and UI work only, no real video. */
  fake: boolean;
  /** Built Studio UI to serve; null in development, where Vite serves it. */
  uiDir: string | null;
  /** Hugging Face OAuth app (public client, no secret). */
  hfClientId: string | null;
  /** Extra host names this server answers to (for example a Tailscale name). */
  allowedHosts: string[];
}

export function defaultDataDir(env = process.env): string {
  if (env.HILDEGARD_HOME) return env.HILDEGARD_HOME;
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Hildegard');
    case 'win32':
      return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Hildegard');
    default:
      return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'hildegard');
  }
}

/** Where the server notes the port it last started on, so `hildegard status` and `stop` find it without --port. */
export const portFile = (dataDir: string) => join(dataDir, 'server.json');

export function rememberedPort(dataDir: string): number | undefined {
  try {
    const { port } = JSON.parse(readFileSync(portFile(dataDir), 'utf8')) as { port?: unknown };
    return Number.isInteger(port) && (port as number) > 0 ? (port as number) : undefined;
  } catch {
    return undefined;
  }
}

export function parseArgs(argv: string[], env = process.env): Config {
  const flag = (name: string) => argv.includes(`--${name}`);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq?.slice(name.length + 3);
  };
  const dataDir = opt('data') ?? defaultDataDir(env);
  return {
    dataDir,
    host: opt('host') ?? env.HILDEGARD_HOST ?? '127.0.0.1',
    port: Number(opt('port') ?? env.HILDEGARD_PORT ?? rememberedPort(dataDir) ?? 7341),
    comfyUrl: opt('comfy') ?? env.HILDEGARD_COMFY_URL ?? 'http://127.0.0.1:8189',
    comfyExternal: Boolean(opt('comfy') ?? env.HILDEGARD_COMFY_URL),
    comfyDir: opt('comfy-dir') ?? env.HILDEGARD_COMFY_DIR ?? join(dataDir, 'comfyui'),
    fake: flag('fake-gpu') || env.HILDEGARD_FAKE_GPU === '1',
    uiDir: opt('ui') ?? env.HILDEGARD_UI_DIR ?? null,
    hfClientId: env.HILDEGARD_HF_CLIENT_ID ?? null,
    allowedHosts: (opt('allow-host') ?? env.HILDEGARD_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
  };
}
