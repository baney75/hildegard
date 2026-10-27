// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AgentEnv,
  connectAgent,
  detectGpu,
  disconnectAgent,
  download,
  findUv,
  fit,
  fitWhy,
  layout,
  listAgents,
  type Probe,
  run,
  torchMismatch,
  UV,
} from '../src/index.ts';

const probe = (over: Partial<Probe> & { files?: Record<string, string> }): Probe => ({
  platform: 'linux',
  arch: 'x64',
  totalmem: 32 * 1024 ** 3,
  run: () => null,
  read: (p) => over.files?.[p.replaceAll('\\', '/')] ?? null,
  list: (d) => [
    ...new Set(
      Object.keys(over.files ?? {})
        .filter((f) => f.startsWith(`${d}/`))
        .map((f) => f.slice(d.length + 1).split('/')[0]!),
    ),
  ],
  ...over,
});

describe('detectGpu', () => {
  it('picks the NVIDIA card with the most memory and the CUDA build its driver supports', () => {
    const smi = 'NVIDIA GeForce RTX 3060, 12288, 581.15, 8.6\nNVIDIA GeForce RTX 4090, 24564, 581.15, 8.9\n';
    const g = detectGpu(probe({ run: (c) => (c === 'nvidia-smi' ? smi : null) }));
    expect(g).toEqual({
      backend: 'cuda',
      name: 'NVIDIA GeForce RTX 4090',
      vramGb: 24,
      torchBackend: 'cu130',
    });
  });

  it('finds the card under WSL, where nvidia-smi lives in /usr/lib/wsl/lib', () => {
    const smi = 'NVIDIA GeForce GTX 1650, 4096, 595.95, 7.5\n';
    const g = detectGpu(
      probe({ platform: 'linux', run: (c) => (c === '/usr/lib/wsl/lib/nvidia-smi' ? smi : null) }),
    );
    expect(g).toMatchObject({ backend: 'cuda', name: 'NVIDIA GeForce GTX 1650', vramGb: 4 });
  });

  it('falls back to older CUDA builds for older drivers and cards, and says why', () => {
    const run = (line: string) => () => line;
    const older = detectGpu(probe({ run: run('NVIDIA GeForce RTX 3090, 24576, 572.16, 8.6') }));
    expect(older.torchBackend).toBe('cu128');
    expect(older.note).toContain('older than 580');
    expect(
      detectGpu(probe({ run: run('NVIDIA GeForce GTX 1080 Ti, 11264, 581.15, 6.1') })).torchBackend,
    ).toBe('cu126');
  });

  it('reads AMD cards from the kernel on Linux and skips integrated graphics', () => {
    const g = detectGpu(
      probe({
        files: {
          '/sys/class/drm/card0/device/vendor': '0x1002\n',
          '/sys/class/drm/card0/device/mem_info_vram_total': String(512 * 1024 ** 2),
          '/sys/class/drm/card1/device/vendor': '0x1002\n',
          '/sys/class/drm/card1/device/mem_info_vram_total': String(16 * 1024 ** 3),
          '/sys/class/drm/card1/device/product_name': 'AMD Radeon RX 7800 XT',
          '/sys/class/drm/card1-DP-1/status': 'connected',
        },
      }),
    );
    expect(g).toEqual({
      backend: 'rocm',
      name: 'AMD Radeon RX 7800 XT',
      vramGb: 16,
      torchBackend: 'rocm7.2',
    });
  });

  it('uses Metal on Apple silicon with three quarters of unified memory', () => {
    const g = detectGpu(
      probe({ platform: 'darwin', arch: 'arm64', totalmem: 64 * 1024 ** 3, run: () => 'Apple M3 Max\n' }),
    );
    expect(g).toEqual({ backend: 'mps', name: 'Apple M3 Max', vramGb: 48, torchBackend: null });
  });

  it('says plainly when there is no GPU to use', () => {
    const g = detectGpu(probe({ platform: 'win32' }));
    expect(g.backend).toBe('cpu');
    expect(g.note).toMatch(/NVIDIA/);
    expect(fit(g, { minVramGb: 12 })).toBe('no');
  });

  it('counts unified memory on the DGX Spark (GB10), where nvidia-smi reports no memory total', () => {
    const smi = 'NVIDIA GB10, [N/A], 580.95.05, 12.1\n';
    const g = detectGpu(
      probe({ arch: 'arm64', totalmem: 128 * 1024 ** 3, run: (c) => (c === 'nvidia-smi' ? smi : null) }),
    );
    expect(g).toEqual({
      backend: 'cuda',
      name: 'NVIDIA GB10',
      vramGb: 115.2,
      unified: true,
      torchBackend: 'cu130',
    });
    const files = (gb: number) => [{ size: gb * 1024 ** 3 }];
    expect(fit(g, { minVramGb: 24 })).toBe('fits');
    // Nothing to offload to: weights plus a quarter must fit the shared memory.
    expect(fit(g, { minVramGb: 24, files: files(90) })).toBe('fits');
    expect(fit(g, { minVramGb: 24, files: files(95) })).toBe('no');
    expect(fit(g, { minVramGb: 100 })).toBe('no');
    expect(fitWhy(g, { minVramGb: 100 })).toBe('memory');
  });

  it('compares a unified part’s share with discrete memory, and keeps the flag on the right card', () => {
    const smi = 'NVIDIA GB10, [N/A], 580.95.05, 12.1\nNVIDIA GeForce RTX 3060, 12288, 580.95.05, 8.6\n';
    const g = detectGpu(probe({ totalmem: 128 * 1024 ** 3, run: (c) => (c === 'nvidia-smi' ? smi : null) }));
    expect(g).toMatchObject({ name: 'NVIDIA GB10', unified: true });
    const small = detectGpu(
      probe({ totalmem: 8 * 1024 ** 3, run: (c) => (c === 'nvidia-smi' ? smi : null) }),
    );
    expect(small).toMatchObject({ name: 'NVIDIA GeForce RTX 3060', vramGb: 12 });
    expect(small.unified).toBeUndefined();
  });

  it('never takes a discrete card in trouble for unified memory', () => {
    const smi = 'NVIDIA GeForce RTX 4090, [Unknown Error], 581.15, 8.9\n';
    const g = detectGpu(
      probe({
        platform: 'linux',
        arch: 'x64',
        totalmem: 64 * 1024 ** 3,
        run: (c) => (c === 'nvidia-smi' ? smi : null),
      }),
    );
    expect(g).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', vramGb: null });
    expect(g.unified).toBeUndefined();
    const na = detectGpu(
      probe({
        platform: 'linux',
        arch: 'x64',
        totalmem: 64 * 1024 ** 3,
        run: (c) => (c === 'nvidia-smi' ? 'NVIDIA GeForce RTX 4090, [N/A], 581.15, 8.9\n' : null),
      }),
    );
    expect(na.unified).toBeUndefined();
    // Nor an Arm server's discrete card, nor a Jetson that hasn't been checked.
    for (const line of ['NVIDIA L40S, [N/A], 580.95.05, 8.9', 'Orin (nvgpu), [N/A], 540.4.0, 8.7']) {
      const arm = detectGpu(
        probe({
          arch: 'arm64',
          totalmem: 64 * 1024 ** 3,
          run: (c) => (c === 'nvidia-smi' ? `${line}\n` : null),
        }),
      );
      expect(arm.vramGb).toBeNull();
      expect(arm.unified).toBeUndefined();
    }
  });

  it('judges fit with room for offloading', () => {
    const g = { backend: 'cuda' as const, name: 'x', vramGb: 10, torchBackend: 'cu130' };
    expect(fit(g, { minVramGb: 8 })).toBe('fits');
    expect(fit(g, { minVramGb: 12 })).toBe('tight');
    expect(fit(g, { minVramGb: 24 })).toBe('no');
  });

  it('keeps room on Apple’s unified memory and skips models it can’t run', () => {
    const mac = detectGpu(
      probe({ platform: 'darwin', arch: 'arm64', totalmem: 32 * 1024 ** 3, run: () => 'Apple M5\n' }),
    );
    const files = (gb: number) => [{ size: gb * 1024 ** 3 }];
    // 24 GB for the GPU used to read as room for a 24 GB model; there is nowhere to offload the rest.
    expect(fit(mac, { minVramGb: 24 })).toBe('no');
    expect(fit(mac, { minVramGb: 12, files: files(17) })).toBe('fits');
    expect(fit(mac, { minVramGb: 12, files: files(22) })).toBe('no');
    expect(fit({ ...mac, vramGb: 96 }, { minVramGb: 24, files: files(37), mps: false })).toBe('no');
    // And says which of the two it is, since "too big" is the wrong reason for a model Apple's GPU can't render.
    expect(fitWhy({ ...mac, vramGb: 96 }, { minVramGb: 24, mps: false })).toBe('apple-gpu');
    expect(fitWhy(mac, { minVramGb: 24 })).toBe('memory');
    expect(fitWhy(mac, { minVramGb: 12, files: files(17) })).toBeNull();
  });
});

describe('download', () => {
  const body = (s: string) => async () => new Response(s);
  it('keeps a file whose hash matches and refuses one that does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-dl-'));
    const ok = join(dir, 'ok');
    // sha256("hello")
    const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    await download('https://x/ok', ok, sha, body('hello') as never, () => {});
    expect(readFileSync(ok, 'utf8')).toBe('hello');
    const bad = join(dir, 'bad');
    await expect(download('https://x/bad', bad, sha, body('tampered') as never, () => {})).rejects.toThrow(
      /didn't match its pinned hash/,
    );
    expect(existsSync(bad)).toBe(false);
    expect(existsSync(`${bad}.part`)).toBe(false);
  });
});

describe('findUv', () => {
  const L = layout(join(tmpdir(), 'hg-uv'));
  const ours = join(L.tools, process.platform === 'win32' ? 'uv.exe' : 'uv');
  const versions = (v: Record<string, string>) => ({ run: (cmd: string) => v[cmd] ?? null });

  it('uses only the pinned uv, and installs its own when the one on PATH differs', () => {
    expect(findUv(L, versions({ uv: 'uv 0.4.0 (abcdef 2024-08-01)\n' }))).toBeNull();
    expect(findUv(L, versions({ uv: `uv ${UV.version}0\n` }))).toBeNull();
    expect(findUv(L, versions({ uv: `uv ${UV.version} (abcdef 2026-09-01)\n` }))).toBe('uv');
    expect(findUv(L, versions({ uv: 'uv 0.4.0\n', [ours]: `uv ${UV.version} (abcdef 2026-09-01)\n` }))).toBe(
      ours,
    );
  });
});

describe('linking agents', () => {
  const setup = (platform: NodeJS.Platform = 'linux', onPath: string[] = []) => {
    const home = mkdtempSync(join(tmpdir(), 'hg-home-'));
    const calls: string[][] = [];
    const env: AgentEnv = {
      home,
      platform,
      env: {},
      has: (c) => onPath.includes(c),
      exec: (c, a) => {
        calls.push([c, ...a]);
        return '';
      },
    };
    return { home, env, calls };
  };
  const m = { command: '/opt/node', args: ['/opt/hildegard.mjs', 'mcp'] };

  it('links OMP, Pi and Gemini CLI, and says which sign-ins their terms allow', () => {
    const { home, env } = setup('linux', ['omp', 'pi', 'gemini']);
    const byId = (id: string) => listAgents(env).find((a) => a.id === id)!;
    for (const [id, file] of [
      ['omp', join(home, '.omp', 'agent', 'mcp.json')],
      ['oh-my-pi', join(home, '.omp', 'agent', 'mcp.json')],
      ['pi', join(home, '.pi', 'agent', 'mcp.json')],
      ['gemini-cli', join(home, '.gemini', 'settings.json')],
    ] as const) {
      expect(connectAgent(id, m, env).status).not.toBe('failed');
      expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.hildegard).toEqual({
        command: '/opt/node',
        args: ['/opt/hildegard.mjs', 'mcp'],
      });
    }
    expect(byId('omp')).toMatchObject({ installed: true, connected: true });
    expect(byId('omp').signIn).toMatch(/API key or point it at a local model/);
    expect(byId('pi').signIn).toBe(byId('omp').signIn);
    expect(byId('opencode').signIn).toBe(byId('omp').signIn);
    expect(byId('claude-code').signIn).toMatch(/Claude plan is fine here/);
    expect(byId('codex').signIn).toMatch(/ChatGPT plan is fine here/);
    expect(byId('gemini').signIn).toMatch(/your own Google account/);
  });

  it('adds itself to Claude Desktop without touching other servers, and backs the file up once', () => {
    const { home, env } = setup('darwin');
    const file = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    expect(listAgents(env).find((a) => a.id === 'claude-desktop')).toMatchObject({
      installed: true,
      connected: false,
    });

    expect(connectAgent('claude-desktop', m, env).status).toBe('done');
    const j = JSON.parse(readFileSync(file, 'utf8'));
    expect(j).toEqual({
      mcpServers: {
        other: { command: 'x' },
        hildegard: { command: '/opt/node', args: ['/opt/hildegard.mjs', 'mcp'] },
      },
      theme: 'dark',
    });
    expect(JSON.parse(readFileSync(`${file}.before-hildegard`, 'utf8')).mcpServers.hildegard).toBeUndefined();
    expect(listAgents(env).find((a) => a.id === 'claude-desktop')?.connected).toBe(true);

    expect(disconnectAgent('Claude Desktop', env).status).toBe('done');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { other: { command: 'x' } },
      theme: 'dark',
    });
  });

  it('uses Claude Code’s own CLI when it is installed', () => {
    const { env, calls } = setup('linux', ['claude']);
    expect(
      connectAgent('claude-code', { ...m, env: { HILDEGARD_URL: 'http://127.0.0.1:9000' } }, env).status,
    ).toBe('done');
    expect(calls.at(-1)).toEqual([
      'claude',
      'mcp',
      'add',
      '--scope',
      'user',
      '--env',
      'HILDEGARD_URL=http://127.0.0.1:9000',
      'hildegard',
      '--',
      '/opt/node',
      '/opt/hildegard.mjs',
      'mcp',
    ]);
  });

  it('leaves Claude Code to the Hildegard plugin when it is on, unless the link is to another Hildegard', () => {
    const { home, env, calls } = setup('linux', ['claude']);
    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'hildegard@hildegard': true } }),
    );
    const step = connectAgent('claude-code', m, env);
    expect(step).toMatchObject({ status: 'skipped' });
    expect(step.detail).toContain('plugin');
    expect(calls).toEqual([['claude', 'mcp', 'remove', '--scope', 'user', 'hildegard']]);
    const far = {
      command: '/opt/node',
      args: ['/opt/hildegard.mjs', 'mcp', '--remote', 'https://abbey1.ts.net'],
    };
    expect(connectAgent('claude-code', far, env).status).toBe('done');
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'hildegard@hildegard': false } }),
    );
    expect(connectAgent('claude-code', m, env).status).toBe('done');
  });

  it('writes a Codex TOML table, replacing an earlier one and keeping the rest', () => {
    const { home, env } = setup();
    const file = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      file,
      'model = "gpt-6"\n\n[mcp_servers.hildegard]\ncommand = "old"\n\n[mcp_servers.hildegard.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "o"\n',
    );
    connectAgent('codex', m, env);
    connectAgent('codex', m, env);
    const t = readFileSync(file, 'utf8');
    expect(t.match(/\[mcp_servers\.hildegard\]/g)).toHaveLength(1);
    expect(t).not.toContain('old');
    expect(t).toContain('model = "gpt-6"');
    expect(t).toContain('[mcp_servers.other]\ncommand = "o"');
    expect(t).toContain('command = "/opt/node"\nargs = ["/opt/hildegard.mjs", "mcp"]');
    disconnectAgent('codex', env);
    expect(readFileSync(file, 'utf8')).not.toContain('hildegard');
  });

  it('writes OpenCode’s and VS Code’s formats', () => {
    const { home, env } = setup();
    connectAgent('opencode', m, env);
    expect(JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        hildegard: { type: 'local', command: ['/opt/node', '/opt/hildegard.mjs', 'mcp'], enabled: true },
      },
    });
    connectAgent('vscode', m, env);
    expect(JSON.parse(readFileSync(join(home, '.config', 'Code', 'User', 'mcp.json'), 'utf8'))).toEqual({
      servers: { hildegard: { type: 'stdio', command: '/opt/node', args: ['/opt/hildegard.mjs', 'mcp'] } },
    });
  });

  it('leaves a file with comments alone and shows what to paste', () => {
    const { home, env } = setup();
    const file = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'));
    const before = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    writeFileSync(file, before);
    const step = connectAgent('cursor', m, env);
    expect(step.status).toBe('needs-owner');
    expect(step.detail).toContain('"hildegard"');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('names the apps it knows when asked for one it does not', () => {
    const { env } = setup();
    expect(connectAgent('notepad', m, env).detail).toMatch(/claude-code, claude-desktop, codex/);
  });
});

describe('run', () => {
  it('logs whole lines even when output arrives mid-line', async () => {
    const lines: string[] = [];
    // Writes " + torch" then "==2.14.1\n" a beat apart, as uv's package list can arrive, and ends without a newline.
    const script = `process.stdout.write(' + torch');
setTimeout(() => { process.stdout.write('==2.14.1\\n + torchaudio'); process.stderr.write('warn'); }, 50);
setTimeout(() => process.stdout.write('==2.11.0'), 100);`;
    const out = await run(process.execPath, ['-e', script], { log: (l) => lines.push(l) });
    expect(out.replace('warn', '')).toBe(' + torch==2.14.1\n + torchaudio==2.11.0');
    expect(lines.sort()).toEqual([' + torch==2.14.1', ' + torchaudio==2.11.0', 'warn']);
  });
});

describe('torchMismatch', () => {
  it('reinstalls PyTorch when the build on disk is not the one this GPU wants', () => {
    expect(torchMismatch('2.14.1+cpu', 'cu130')).toBe(true);
    expect(torchMismatch('2.14.1+cu126', 'cu130')).toBe(true);
    expect(torchMismatch('2.14.1', 'cu130')).toBe(true);
    expect(torchMismatch('2.14.1+cu130', 'cpu')).toBe(true);
  });

  it('leaves a matching build alone', () => {
    expect(torchMismatch('2.14.1+cu130', 'cu130')).toBe(false);
    expect(torchMismatch('2.14.1+cpu', 'cpu')).toBe(false);
    expect(torchMismatch('2.14.1', 'cpu')).toBe(false);
    expect(torchMismatch('2.14.1', null)).toBe(false);
  });
});
