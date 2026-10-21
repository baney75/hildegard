// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { arch, platform, totalmem } from 'node:os';
import { join } from 'node:path';

export type Backend = 'cuda' | 'rocm' | 'mps' | 'cpu';

export interface Gpu {
  backend: Backend;
  /** For people: "NVIDIA GeForce RTX 4090", "Apple M3 Max", "No supported GPU". */
  name: string;
  /** Memory the GPU can use, in GB; unified memory on Apple silicon. Null when unknown. */
  vramGb: number | null;
  /** uv's --torch-backend for this GPU; null means PyPI's default build (macOS). */
  torchBackend: string | null;
  /** Something the owner should know, such as an old driver. */
  note?: string;
}

export interface Probe {
  platform: NodeJS.Platform;
  arch: string;
  totalmem: number;
  /** Runs a program and returns its stdout, or null if it's missing or fails. */
  run(cmd: string, args: string[]): string | null;
  /** Reads a file, or null. */
  read(path: string): string | null;
  list(dir: string): string[];
}

export const systemProbe: Probe = {
  platform: platform(),
  arch: arch(),
  totalmem: totalmem(),
  run(cmd, args) {
    try {
      return execFileSync(cmd, args, {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  },
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** The best GPU on this computer and the PyTorch build that runs on it. */
export function detectGpu(p: Probe = systemProbe): Gpu {
  const nvidia = detectNvidia(p);
  if (nvidia) return nvidia;
  if (p.platform === 'darwin')
    return p.arch === 'arm64'
      ? {
          backend: 'mps',
          name: appleChip(p),
          // Apple silicon shares memory; macOS lets the GPU use about three quarters of it.
          vramGb: gb(p.totalmem * 0.75),
          torchBackend: null,
        }
      : cpu(
          'Intel Macs have no GPU PyTorch can use. Hildegard runs on the CPU, which is too slow for video.',
        );
  if (p.platform === 'linux') {
    const amd = detectAmd(p);
    if (amd) return amd;
  }
  return cpu(
    p.platform === 'win32'
      ? 'No NVIDIA GPU found. On Windows Hildegard needs an NVIDIA card for video; AMD support is coming.'
      : 'No supported GPU found. Hildegard runs on the CPU, which is too slow for video.',
  );
}

function cpu(note: string): Gpu {
  return { backend: 'cpu', name: 'No supported GPU', vramGb: null, torchBackend: 'cpu', note };
}

function detectNvidia(p: Probe): Gpu | null {
  const out = p.run('nvidia-smi', [
    '--query-gpu=name,memory.total,driver_version,compute_cap',
    '--format=csv,noheader,nounits',
  ]);
  if (!out) return null;
  const gpus = out
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter((f) => f.length >= 4 && f[0])
    .map(([name, mem, driver, cap]) => ({
      name: name!,
      vramGb: Math.round((Number(mem) / 1024) * 10) / 10,
      driver: Number.parseFloat(driver!),
      cap: Number.parseFloat(cap!),
    }));
  const best = gpus.sort((a, b) => b.vramGb - a.vramGb)[0];
  if (!best) return null;
  // PyTorch's CUDA 13 builds need driver 580+ and a Turing (7.5) or newer card; older ones get CUDA 12.6.
  const modern = best.cap >= 7.5;
  const torchBackend =
    modern && best.driver >= 580 ? 'cu130' : modern && best.driver >= 570 ? 'cu128' : 'cu126';
  return {
    backend: 'cuda',
    name: best.name,
    vramGb: Number.isFinite(best.vramGb) ? best.vramGb : null,
    torchBackend,
    ...(modern && best.driver < 580
      ? {
          note: `NVIDIA driver ${best.driver} is older than 580. Updating it makes newer PyTorch builds available.`,
        }
      : {}),
  };
}

/** AMD on Linux, read from the kernel driver: PyTorch's ROCm wheels bring their own runtime. */
function detectAmd(p: Probe): Gpu | null {
  let best: { name: string; vram: number } | null = null;
  for (const card of p.list('/sys/class/drm')) {
    if (!/^card\d+$/.test(card)) continue;
    const dev = join('/sys/class/drm', card, 'device');
    if (p.read(join(dev, 'vendor'))?.trim() !== '0x1002') continue;
    const vram = Number(p.read(join(dev, 'mem_info_vram_total'))?.trim() ?? 0);
    // Integrated Radeon graphics report a small carve-out; video models need a discrete card.
    if (vram < 4 * 1024 ** 3) continue;
    const name = p.read(join(dev, 'product_name'))?.trim() || 'AMD Radeon GPU';
    if (!best || vram > best.vram) best = { name, vram };
  }
  return best ? { backend: 'rocm', name: best.name, vramGb: gb(best.vram), torchBackend: 'rocm7.2' } : null;
}

function appleChip(p: Probe): string {
  return p.run('sysctl', ['-n', 'machdep.cpu.brand_string'])?.trim() || 'Apple silicon';
}

/** What a model asks of the GPU, as the catalog declares it. */
export interface Need {
  minVramGb: number;
  /** Its weight files, for their size on disk. */
  files?: { size: number }[];
  /** False when its weights need int8 or fp8 kernels that Apple's GPU lacks. */
  mps?: boolean;
}

/** How a model fits this GPU: the Studio and the CLI show the same words. */
export function fit(gpu: Gpu, need: Need): 'fits' | 'tight' | 'no' {
  if (gpu.backend === 'cpu' || gpu.vramGb === null) return 'no';
  if (gpu.backend === 'mps') {
    if (need.mps === false) return 'no';
    // Unified memory has nothing to offload to, and macOS and open apps share it: the weights and the activations
    // must fit with a quarter to spare.
    const weightsGb = (need.files ?? []).reduce((n, f) => n + f.size, 0) / 1024 ** 3;
    return gpu.vramGb >= Math.max(need.minVramGb, weightsGb) * 1.25 ? 'fits' : 'no';
  }
  if (gpu.vramGb >= need.minVramGb) return 'fits';
  // ComfyUI offloads weights to system memory, so a little under the minimum still runs, slowly.
  return gpu.vramGb >= need.minVramGb * 0.75 ? 'tight' : 'no';
}
