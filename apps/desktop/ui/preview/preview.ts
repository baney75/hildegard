// SPDX-License-Identifier: AGPL-3.0-only
// The start-up page outside the app, for working on its look: Tauri's IPC is mocked, and `?state=` picks what the
// app answers. Built by scripts/preview-ui.mjs into ui/preview/dist; never part of the app.
//
//   ?state=welcome | partly | opening | installing | downloading | starting | failed | install-failed
//          | needs-owner | offline | stopped | live
//   &theme=light | dark     (default: the system's)
//   &go=1                   presses the page's main button once it shows (the install states press it for you)
import type { InvokeArgs } from '@tauri-apps/api/core';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { InstallEvent, Launch, Outcome, Step } from '../model.ts';

const q = new URLSearchParams(location.search);
const state = q.get('state') ?? 'live';
const theme = q.get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.previewTheme = theme;

const DATA = '/home/ann/.local/share/hildegard';
const never = new Promise<never>(() => {});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const s = (
  id: string,
  title: string,
  detail: string,
  status: Step['status'] = 'done',
  command?: string,
): Step => ({
  id,
  title,
  status,
  detail,
  ...(command ? { command } : {}),
});

const EARLY: Step[] = [
  s('app', 'Put Hildegard in its folder', `Hildegard 0.4.0 is in ${DATA}.`),
  s('command', 'Add the hildegard command', 'It’s in /home/ann/.local/bin.'),
  s('gpu', 'Find the GPU', 'NVIDIA GeForce RTX 4090, 24 GB.'),
  s('uv', 'Get uv', 'Installed uv 0.13.2.'),
];
const LATER: Step[] = [
  s('comfyui', 'Get ComfyUI', 'Installed ComfyUI 0.42.1.'),
  s('python', 'Set up Python', 'Made a Python 3.13 environment.'),
  s(
    'packages',
    'Install PyTorch and ComfyUI’s packages',
    'PyTorch for CUDA (cu128), ComfyUI’s packages and comfy-api-proxy 0.1.6.',
  ),
  s('film-look', 'Add the film look', 'Installed Hildegard’s film-look node.'),
  s('check', 'Check the GPU works', 'PyTorch 2.10.0+cu128 uses the NVIDIA GeForce RTX 4090.'),
  s('start', 'Start Hildegard', 'Running at http://127.0.0.1:7341.'),
];

type Send = (e: InstallEvent) => void;

async function feed(send: Send, steps: Step[], logs: Record<string, string[]> = {}, gap = 60) {
  for (const st of steps) {
    for (const line of logs[st.id] ?? []) {
      send({ kind: 'log', line });
      await wait(gap);
    }
    send({ kind: 'step', step: st });
    await wait(gap);
  }
}

const ok = (steps: Step[]): Outcome => ({
  ok: true,
  needsOwner: false,
  steps,
  message: 'Hildegard is ready.',
});

let launches = 0;

async function launch(): Promise<Launch> {
  launches++;
  switch (state) {
    case 'opening':
      return never;
    case 'partly':
      return { kind: 'install', data: DATA, partly: true };
    case 'failed':
      return {
        kind: 'failed',
        message: 'Hildegard didn’t start. It didn’t answer within 90 seconds.',
        log: `${DATA}/logs/server.log`,
      };
    case 'starting':
      return launches > 1 ? never : { kind: 'install', data: DATA, partly: false };
    case 'live':
      if (launches > 1) {
        await wait(4000);
        return { kind: 'failed', message: 'This is the preview: there’s no Studio to open.', log: '' };
      }
      return { kind: 'install', data: DATA, partly: false };
    default:
      return { kind: 'install', data: DATA, partly: false };
  }
}

async function install(send: Send): Promise<Outcome> {
  switch (state) {
    case 'installing':
      await feed(send, EARLY, {
        uv: ['download https://github.com/astral-sh/uv/releases/download/0.13.2/uv.tar.gz'],
      });
      send({
        kind: 'log',
        line: 'download https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.42.1.tar.gz',
      });
      return never;
    case 'downloading':
      await feed(send, [...EARLY, ...LATER.slice(0, 2)]);
      send({ kind: 'log', line: 'Resolved 61 packages in 1.82s' });
      send({ kind: 'log', line: 'Downloading nvidia-cudnn-cu12 (634.0MiB)' });
      send({ kind: 'log', line: 'Downloading torch (846.3MiB)' });
      return never;
    case 'starting':
      await feed(send, [...EARLY, ...LATER]);
      return ok([...EARLY, ...LATER]);
    case 'install-failed': {
      const steps = [
        ...EARLY,
        LATER[0]!,
        LATER[1]!,
        s(
          'error',
          'Install',
          `Command failed: uv pip install (exit 2): No space left on device (os error 28). The full log is in ${DATA}/logs/install.log.`,
          'failed',
        ),
      ];
      await feed(send, steps);
      return { ok: false, needsOwner: false, steps, message: 'The install stopped.' };
    }
    case 'offline': {
      const steps = [
        ...EARLY.slice(0, 3),
        s(
          'error',
          'Install',
          `fetch failed: getaddrinfo ENOTFOUND github.com. The full log is in ${DATA}/logs/install.log.`,
          'failed',
        ),
      ];
      await feed(send, steps);
      return { ok: false, needsOwner: false, steps, message: 'The install stopped.' };
    }
    case 'needs-owner': {
      const steps = [
        ...EARLY,
        ...LATER.slice(0, 4),
        s(
          'check',
          'Check the GPU works',
          'PyTorch 2.10.0+cu128 can’t use the NVIDIA GeForce RTX 4090. Update the NVIDIA driver, restart, then run `hildegard install` again.',
          'needs-owner',
          'hildegard install --yes --json',
        ),
      ];
      await feed(send, steps);
      return { ok: false, needsOwner: true, steps, message: 'Hildegard needs you for one thing.' };
    }
    default: {
      await feed(
        send,
        [...EARLY, ...LATER],
        {
          uv: ['download https://github.com/astral-sh/uv/releases/download/0.13.2/uv.tar.gz'],
          comfyui: ['download https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.42.1.tar.gz'],
          packages: [
            'Resolved 61 packages in 1.82s',
            'Downloading nvidia-cudnn-cu12 (634.0MiB)',
            'Downloading torch (846.3MiB)',
            'Downloaded torch',
            'Prepared 61 packages in 2m 41s',
            'Installed 61 packages in 3.2s',
          ],
        },
        900,
      );
      return ok([...EARLY, ...LATER]);
    }
  }
}

if (state === 'offline') {
  Object.defineProperty(navigator, 'onLine', { get: () => false });
}

mockIPC(async (cmd: string, args?: InvokeArgs) => {
  if (cmd === 'launch') return launch();
  if (cmd === 'open_logs') return null;
  if (cmd === 'install') {
    const channel = (args as { onEvent: { onmessage: Send } }).onEvent;
    return install((e) => channel.onmessage(e));
  }
  throw new Error(`The preview has no ${cmd}.`);
});

if (state === 'stopped') location.hash = '#stopped';

await import('../main.ts');

// The install states start with the welcome page: press its button, as a person would.
const press = q.get('go') === '1' || !['welcome', 'partly', 'opening', 'failed', 'stopped'].includes(state);
if (press) {
  const go = async () => {
    for (let i = 0; i < 50; i++) {
      const b = document.querySelector<HTMLButtonElement>('[data-go], button[data-autofocus]');
      if (b) return b.click();
      await wait(20);
    }
  };
  void go();
}
