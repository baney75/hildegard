// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The voice engine's Python environments: one per model family, because Chatterbox, Qwen3-TTS and Kokoro pin
 * versions of torch and transformers that can't share. Each gets its own uv environment inside Hildegard's data
 * folder, its pinned packages from voice-engine/requirements, and PyTorch for this GPU. Safe to run again.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectGpu, type Gpu } from './gpu.ts';
import { downloadUv, findUv, layout, resource, run, type Step, torchMismatch, uvEnv } from './install.ts';

export type VoiceEnv = 'speech' | 'chatterbox' | 'qwen';
export const VOICE_ENVS: readonly VoiceEnv[] = ['speech', 'chatterbox', 'qwen'];

/** The Python each environment wants: Chatterbox pins a torch that has no 3.12 wheels on every platform. */
export const VOICE_PYTHON: Record<VoiceEnv, string> = { speech: '3.12', chatterbox: '3.11', qwen: '3.12' };

const ENV_TITLE: Record<VoiceEnv, string> = {
  speech: 'speech, transcription and the consent checks',
  chatterbox: 'Chatterbox, for cloning',
  qwen: 'Qwen3-TTS, for designing voices',
};

const win = process.platform === 'win32';

/** Where voice lives in Hildegard's data folder. */
export function voiceLayout(dataDir: string) {
  const root = join(dataDir, 'voice');
  return {
    root,
    models: join(root, 'models'),
    envs: join(root, 'envs'),
    /** The worker's code, copied from the release so an update doesn't change it under a running worker. */
    engine: join(root, 'engine'),
    python: (env: VoiceEnv) =>
      win ? join(root, 'envs', env, 'Scripts', 'python.exe') : join(root, 'envs', env, 'bin', 'python'),
    /** Written last by the installer: its presence means the environment is ready. */
    manifest: (env: VoiceEnv) => join(root, 'envs', env, 'hildegard-voice.json'),
  };
}

export interface VoiceEnvInfo {
  env: VoiceEnv;
  python: string;
  torch: string;
  torchBackend: string | null;
  gpu: string;
  usesGpu: boolean;
  engine: string;
  installedAt: string;
}

export function readVoiceEnv(dataDir: string, env: VoiceEnv): VoiceEnvInfo | null {
  try {
    return JSON.parse(readFileSync(voiceLayout(dataDir).manifest(env), 'utf8')) as VoiceEnvInfo;
  } catch {
    return null;
  }
}

/**
 * The PyTorch build an environment gets on this GPU. Chatterbox pins torch 2.6, whose newest CUDA build is 12.6
 * (it runs on newer drivers too) and whose ROCm build is 6.2.4.
 */
export function voiceTorchBackend(env: VoiceEnv, gpu: Gpu): string | null {
  const b = gpu.torchBackend;
  if (env !== 'chatterbox' || !b) return b;
  if (b === 'cu128' || b === 'cu130') return 'cu126';
  if (b.startsWith('rocm')) return 'rocm6.2.4';
  return b;
}

/**
 * Which environments to set up when the owner doesn't say: speech always (every voice feature needs it), Chatterbox
 * for cloning, and Qwen3-TTS only where its 1.7B model fits in GPU memory.
 */
export function defaultVoiceEnvs(gpu: Gpu): VoiceEnv[] {
  const roomy = gpu.backend !== 'cpu' && (gpu.vramGb ?? 0) >= 8;
  return roomy ? ['speech', 'chatterbox', 'qwen'] : ['speech', 'chatterbox'];
}

/**
 * A lock file without the CUDA libraries and Triton it pins for PyPI's default torch build: the PyTorch index's
 * build for this GPU brings its own, and the CPU build needs none.
 */
export function withoutGpuLibraries(lock: string): string {
  return lock
    .split(/\r?\n/)
    .filter((line) => !/^(nvidia-|cuda-|triton)/i.test(line))
    .join('\n');
}

export interface VoiceInstallOptions {
  dataDir: string;
  envs?: VoiceEnv[];
  gpu?: Gpu;
  /** The CPU build even when there's a GPU (tests, CI). */
  cpu?: boolean;
  onStep?(step: Step): void;
  onLog?(line: string): void;
  fetchFn?: typeof fetch;
}

/** Installs the voice engine and the environments it needs. Needs no admin rights. */
export async function installVoice(opts: VoiceInstallOptions): Promise<Step[]> {
  const L = layout(opts.dataDir);
  const V = voiceLayout(opts.dataDir);
  for (const d of [L.dataDir, L.logs, L.downloads, L.tools, V.envs]) mkdirSync(d, { recursive: true });
  const logFile = join(L.logs, 'voice-install.log');
  appendFileSync(logFile, `\n=== ${new Date().toISOString()} hildegard voice install\n`);
  const log = (line: string) => {
    appendFileSync(logFile, `${line}\n`);
    opts.onLog?.(line);
  };
  const steps: Step[] = [];
  const record = (s: Step) => {
    steps.push(s);
    log(`[${s.status}] ${s.title}: ${s.detail}`);
    opts.onStep?.(s);
    return s;
  };

  const detected = opts.gpu ?? detectGpu();
  const gpu: Gpu = opts.cpu
    ? { backend: 'cpu', name: detected.name, vramGb: detected.vramGb, torchBackend: 'cpu' }
    : detected;
  const envs = opts.envs ?? defaultVoiceEnvs(gpu);
  record({
    id: 'gpu',
    title: 'Find the GPU',
    status: 'done',
    detail:
      gpu.backend === 'cpu'
        ? (gpu.note ?? 'Using the CPU build. Speech works; cloning and designing voices are slow.')
        : `${gpu.name}${gpu.vramGb ? `, ${gpu.vramGb} GB` : ''}.`,
  });

  try {
    let uv = findUv(L);
    if (uv) record({ id: 'uv', title: 'Get uv', status: 'skipped', detail: `Using ${uv}.` });
    else {
      uv = await downloadUv(L, opts.fetchFn ?? fetch, log);
      record({ id: 'uv', title: 'Get uv', status: 'done', detail: 'Installed uv.' });
    }

    // The engine's code: replaced whole, so a file a newer release removed doesn't linger.
    const engineVersion =
      /^version = "([^"]+)"/m.exec(readFileSync(resource('voice-engine/pyproject.toml'), 'utf8'))?.[1] ?? '?';
    rmSync(V.engine, { recursive: true, force: true });
    mkdirSync(V.engine, { recursive: true });
    cpSync(resource('voice-engine/hildegard_voice'), join(V.engine, 'hildegard_voice'), {
      recursive: true,
      filter: (src) => !/__pycache__|\.pyc$/.test(src),
    });
    cpSync(resource('voice-engine/LICENSE'), join(V.engine, 'LICENSE'));
    record({
      id: 'engine',
      title: 'Add the voice engine',
      status: 'done',
      detail: `Hildegard’s voice engine ${engineVersion}.`,
    });

    for (const env of envs) {
      const dir = join(V.envs, env);
      const python = V.python(env);
      const backend = voiceTorchBackend(env, gpu);
      const title = `Set up ${ENV_TITLE[env]}`;
      if (!existsSync(python))
        await run(uv, ['venv', '--managed-python', '--python', VOICE_PYTHON[env], dir], {
          log,
          env: uvEnv(L),
        });
      const installed = await run(python, ['-c', 'import torch; print(torch.__version__)'], { log }).then(
        (v) => v.trim(),
        () => null,
      );
      const rebuild = installed !== null && torchMismatch(installed, backend);
      const lock = join(dir, 'requirements.txt');
      const text = readFileSync(resource(`voice-engine/requirements/${env}.txt`), 'utf8');
      writeFileSync(lock, backend ? withoutGpuLibraries(text) : text);
      const out = await run(
        uv,
        [
          'pip',
          'install',
          '--python',
          python,
          '-r',
          lock,
          ...(backend ? ['--torch-backend', backend] : []),
          ...(rebuild ? ['--reinstall-package', 'torch', '--reinstall-package', 'torchaudio'] : []),
        ],
        { log, env: uvEnv(L) },
      );
      const probe = (
        await run(
          python,
          [
            '-c',
            'import torch, hildegard_voice; mps = getattr(torch.backends, "mps", None); ' +
              'print(torch.__version__, torch.cuda.is_available() or bool(mps and mps.is_available()))',
          ],
          { log, env: { PYTHONPATH: V.engine, PYTHONNOUSERSITE: '1' } },
        )
      )
        .trim()
        .split(/\s+/);
      const [torch = '?', usable] = probe;
      if (gpu.backend !== 'cpu' && usable !== 'True') {
        record({
          id: env,
          title,
          status: 'needs-owner',
          detail: `PyTorch ${torch} can’t use the ${gpu.name}. ${
            gpu.backend === 'cuda'
              ? 'Update the NVIDIA driver, restart, then run `hildegard voice install` again.'
              : 'Check the GPU driver is loaded, then run `hildegard voice install` again.'
          }`,
          command: `hildegard voice install --env ${env} --json`,
        });
        continue;
      }
      const info: VoiceEnvInfo = {
        env,
        python: VOICE_PYTHON[env],
        torch,
        torchBackend: backend,
        gpu: gpu.name,
        usesGpu: usable === 'True',
        engine: engineVersion,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(V.manifest(env), `${JSON.stringify(info, null, 2)}\n`);
      record({
        id: env,
        title,
        status:
          /^(Audited|Checked) \d+ packages?/m.test(out) && !/^(Installed|Uninstalled) \d+/m.test(out)
            ? 'skipped'
            : 'done',
        detail: `PyTorch ${torch} ${info.usesGpu ? `on the ${gpu.name}` : 'on the CPU'}.`,
      });
    }
    const left = VOICE_ENVS.filter((e) => !envs.includes(e) && !existsSync(V.manifest(e)));
    if (left.includes('qwen'))
      record({
        id: 'qwen',
        title: `Set up ${ENV_TITLE.qwen}`,
        status: 'skipped',
        detail:
          'Designing voices needs about 8 GB of GPU memory. Add it anyway with `hildegard voice install --env qwen`.',
      });
  } catch (e) {
    record({
      id: 'error',
      title: 'Install voice',
      status: 'failed',
      detail: `${(e as Error).message} The full log is in ${logFile}.`,
    });
  }
  return steps;
}
