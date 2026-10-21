// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadCatalog } from '@hildegard/presets';
import { fit } from '@hildegard/runtime';
import { fileStore, parseArgs, startServer } from '@hildegard/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { starterModel } from '../src/commands.ts';
import { printResult, result } from '../src/output.ts';

// HILDEGARD_CLI tests an installed release's hildegard.mjs instead of the source.
const main = process.env.HILDEGARD_CLI ?? fileURLToPath(new URL('../src/main.ts', import.meta.url));
const run = promisify(execFile);

/** Runs `hildegard …` in its own home folder, so no real app config is ever touched. */
async function hildegard(home: string, ...args: string[]) {
  const { stdout } = await run(process.execPath, [main, ...args, '--json'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData'),
      XDG_CONFIG_HOME: join(home, '.config'),
      PATH: '',
      HF_TOKEN: '',
      // As the installed launcher does.
      ...(process.env.HILDEGARD_CLI ? { HILDEGARD_ENTRY: main } : {}),
    },
    timeout: 60_000,
  }).catch((e: { stdout: string }) => ({ stdout: e.stdout }));
  return JSON.parse(stdout) as {
    ok: boolean;
    needsOwner: boolean;
    message: string;
    steps: { id: string; status: string; detail: string }[];
    [k: string]: unknown;
  };
}

describe('hildegard', () => {
  it('starts in the background, reports status, links an app, and stops', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const port = String(7400 + Math.floor(Math.random() * 400));
    const common = ['--port', port, '--data', data, '--fake-gpu'];

    const started = await hildegard(home, 'start', ...common);
    expect(started.ok).toBe(true);
    expect(started.steps[0]).toMatchObject({ id: 'start', status: 'done' });
    expect((await hildegard(home, 'start', ...common)).steps[0]!.status).toBe('skipped');

    const st = await hildegard(home, 'status', ...common);
    expect(st.running).toBe(true);
    expect(st.version).toBe('0.1.0');
    expect(st.engine).toMatchObject({ comfy: 'fake', online: true });

    const linked = await hildegard(home, 'connect', 'cursor', ...common);
    expect(linked.steps[0]).toMatchObject({ id: 'connect-cursor', status: 'done' });
    const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.hildegard.args).toEqual([main, 'mcp']);
    expect(cfg.mcpServers.hildegard.env).toEqual({ HILDEGARD_URL: `http://127.0.0.1:${port}` });

    const lic = await hildegard(home, 'models', 'install', 'wan-2-2-ti2v-5b', ...common);
    expect(lic.needsOwner).toBe(true);
    expect(lic.steps[0]!.detail).toContain('Apache-2.0');

    // Linking Hugging Face is the owner's to do: an agent gets the command to hand them, never a token prompt.
    expect((await hildegard(home, 'hf', 'status', ...common)).steps[0]).toMatchObject({
      status: 'needs-owner',
    });
    const login = await hildegard(home, 'hf', 'login', ...common);
    expect(login.needsOwner).toBe(true);
    expect(login.steps[0]).toMatchObject({ id: 'huggingface', command: 'hildegard hf login' });

    expect((await hildegard(home, 'stop', ...common)).steps[0]!.status).toBe('done');
    expect((await hildegard(home, 'status', ...common)).running).toBe(false);
  });

  it('serves MCP on stdio, as AI apps run it', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-mcp-'));
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 },
      { fakeTickMs: 20, secrets: fileStore(join(data, 'secret.json')) },
    );
    const client = new Client({ name: 'cli-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [main, 'mcp'],
        env: { ...(process.env as Record<string, string>), HILDEGARD_URL: srv.url },
        stderr: 'ignore',
      }),
    );
    const r = (await client.callTool({ name: 'hildegard_status', arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain('stand-in GPU');
    await client.close();
    await srv.close();
  });

  it('says what an agent must ask the owner when ComfyUI is not installed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const r = await hildegard(home, 'setup', '--data', data, '--port', '7399');
    expect(r.needsOwner).toBe(true);
    expect(r.steps[0]).toMatchObject({ id: 'install', status: 'needs-owner' });
  });

  it('starts people on the best model that fits their GPU', () => {
    const { catalog } = loadCatalog();
    const gpu = (vramGb: number) => ({ backend: 'cuda' as const, name: 'x', vramGb, torchBackend: 'cu130' });
    expect(starterModel(catalog, gpu(24))?.id).toBe('ltx-2-5-distilled');
    expect(starterModel(catalog, gpu(16))?.id).toBe('wan-2-2-ti2v-5b');
    expect(starterModel(catalog, gpu(10))?.id).toBe('wan-2-2-ti2v-5b');
    expect(starterModel(catalog, gpu(6))).toBeNull();
  });

  it('starts a 32 GB Apple silicon Mac on Wan 2.2 5B, not LTX-2.5', () => {
    const { catalog } = loadCatalog();
    // macOS gives the GPU three quarters of unified memory, as detectGpu reports it.
    const mac = { backend: 'mps' as const, name: 'Apple M5', vramGb: 24, torchBackend: null };
    expect(starterModel(catalog, mac)?.id).toBe('wan-2-2-ti2v-5b');
    expect(fit(mac, catalog.models.find((m) => m.id === 'ltx-2-5-distilled')!)).toBe('no');
  });
});

describe('printResult', () => {
  it('leaves its terminal bookkeeping out of --json output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const r = {
        ...result([{ id: 'start', title: 'Start', status: 'done', detail: 'Running.' }], 'Done.'),
        printed: 1,
      };
      printResult(r, true, 1);
      const out = JSON.parse(log.mock.calls[0]![0] as string);
      expect(out).not.toHaveProperty('printed');
      expect(out.steps).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
});
