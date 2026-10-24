// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Gpu } from '../src/gpu.ts';
import { resource } from '../src/install.ts';
import { UV } from '../src/pins.ts';
import {
  defaultVoiceEnvs,
  installVoice,
  readVoiceEnv,
  voiceLayout,
  voiceTorchBackend,
  withoutGpuLibraries,
} from '../src/voice.ts';

const cuda = (vramGb: number, torchBackend = 'cu130'): Gpu => ({
  backend: 'cuda',
  name: 'NVIDIA GeForce RTX 4080',
  vramGb,
  torchBackend,
});

describe('voice environments', () => {
  it('gives Chatterbox the newest PyTorch build its pinned torch has', () => {
    expect(voiceTorchBackend('chatterbox', cuda(12, 'cu130'))).toBe('cu126');
    expect(voiceTorchBackend('chatterbox', cuda(4, 'cu126'))).toBe('cu126');
    expect(voiceTorchBackend('speech', cuda(12, 'cu130'))).toBe('cu130');
    expect(voiceTorchBackend('chatterbox', { ...cuda(16), backend: 'rocm', torchBackend: 'rocm7.2' })).toBe(
      'rocm6.2.4',
    );
    expect(
      voiceTorchBackend('chatterbox', { backend: 'mps', name: 'M3', vramGb: 18, torchBackend: null }),
    ).toBe(null);
  });

  it('sets up voice design only where it fits', () => {
    expect(defaultVoiceEnvs(cuda(12))).toEqual(['speech', 'chatterbox', 'qwen']);
    expect(defaultVoiceEnvs(cuda(4, 'cu126'))).toEqual(['speech', 'chatterbox']);
    expect(defaultVoiceEnvs({ backend: 'cpu', name: 'CPU', vramGb: null, torchBackend: 'cpu' })).toEqual([
      'speech',
      'chatterbox',
    ]);
  });

  it('leaves the CUDA libraries for the PyTorch index to choose', () => {
    const lock = [
      'numpy==2.3.0',
      "nvidia-cublas-cu12==12.4.5.8 ; sys_platform == 'linux'",
      '    # via torch',
      "triton==3.2.0 ; sys_platform == 'linux'",
      "cuda-toolkit==13.0.3.0 ; sys_platform == 'linux'",
      'torch==2.6.0',
    ].join('\n');
    expect(withoutGpuLibraries(lock)).toBe(['numpy==2.3.0', '    # via torch', 'torch==2.6.0'].join('\n'));
  });
});

describe('voice locks', () => {
  it('give the watermark everything it imports: pkg_resources from an older setuptools, and torchaudio', () => {
    for (const env of ['speech', 'chatterbox', 'qwen']) {
      const lock = readFileSync(resource(`voice-engine/requirements/${env}.txt`), 'utf8');
      expect(lock, env).toMatch(/^resemble-perth==/m);
      const v = /^setuptools==(\d+)\./m.exec(lock)?.[1];
      expect(Number(v), env).toBeLessThan(81);
      expect(lock, env).toMatch(/^torchaudio==/m);
    }
  });
});

// A uv and a Python that only record what they're asked, so the installer's own steps run without a download.
describe.skipIf(process.platform === 'win32')('installVoice', () => {
  const saved = process.env.HILDEGARD_UV;
  afterEach(() => {
    if (saved === undefined) delete process.env.HILDEGARD_UV;
    else process.env.HILDEGARD_UV = saved;
  });

  function fakeUv(dir: string, usable = 'True') {
    const calls = join(dir, 'uv-calls.txt');
    const python = `#!/bin/sh
case "$2" in
  *hildegard_voice*)
    [ -f "$PYTHONPATH/hildegard_voice/__init__.py" ] || exit 3
    echo "2.6.0+cu126 ${usable}" ;;
  *) [ -f "$(dirname "$0")/../torch" ] && cat "$(dirname "$0")/../torch" || exit 1 ;;
esac
`;
    const uv = `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  --version) echo "uv ${UV.version}" ;;
  venv) for d; do :; done; mkdir -p "$d/bin"; cat > "$d/bin/python" <<'PY'
${python}PY
    chmod +x "$d/bin/python" ;;
  pip) py="$4"; echo "2.6.0+cu126" > "$(dirname "$py")/../torch"; echo "Installed 42 packages" ;;
esac
`;
    const path = join(dir, 'uv');
    writeFileSync(path, uv);
    chmodSync(path, 0o755);
    process.env.HILDEGARD_UV = path;
    return () => readFileSync(calls, 'utf8').trim().split('\n');
  }

  it('makes each environment with its own Python, pinned packages and GPU build, then the manifest last', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hildegard-voice-'));
    const calls = fakeUv(dir);
    const steps = await installVoice({ dataDir: dir, gpu: cuda(4, 'cu130') });
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ['gpu', 'done'],
      ['uv', 'skipped'],
      ['engine', 'done'],
      ['speech', 'done'],
      ['chatterbox', 'done'],
      ['qwen', 'skipped'],
    ]);
    const V = voiceLayout(dir);
    expect(existsSync(join(V.engine, 'hildegard_voice', '__main__.py'))).toBe(true);
    expect(existsSync(join(V.engine, 'LICENSE'))).toBe(true);
    const pip = calls().filter((c) => c.startsWith('pip install'));
    expect(pip).toHaveLength(2);
    expect(pip[0]).toContain('--torch-backend cu130');
    expect(pip[1]).toContain('--torch-backend cu126');
    expect(calls().filter((c) => c.startsWith('venv'))).toEqual([
      expect.stringContaining('--python 3.12'),
      expect.stringContaining('--python 3.11'),
    ]);
    // Chatterbox's lock, without the CUDA 12.4 libraries PyPI's torch would pull in.
    expect(readFileSync(join(V.envs, 'chatterbox', 'requirements.txt'), 'utf8')).not.toMatch(/^nvidia-/m);
    expect(readVoiceEnv(dir, 'chatterbox')).toMatchObject({
      env: 'chatterbox',
      torchBackend: 'cu126',
      usesGpu: true,
    });
    expect(readVoiceEnv(dir, 'qwen')).toBe(null);
  });

  it('says what the owner must do when PyTorch can’t see the GPU, and marks nothing ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hildegard-voice-'));
    fakeUv(dir, 'False');
    const steps = await installVoice({ dataDir: dir, gpu: cuda(12), envs: ['speech'] });
    const s = steps.find((x) => x.id === 'speech')!;
    expect(s.status).toBe('needs-owner');
    expect(s.detail).toMatch(/Update the NVIDIA driver/);
    expect(s.command).toBe('hildegard voice install --env speech --json');
    expect(readVoiceEnv(dir, 'speech')).toBe(null);
  });
});
