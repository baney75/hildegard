// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadCatalog } from '@hildegard/presets';
import { fit } from '@hildegard/runtime';
import { type Exec, fileStore, parseArgs, startServer } from '@hildegard/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { starterModel } from '../src/commands.ts';
import { printResult, result } from '../src/output.ts';

// HILDEGARD_CLI tests an installed release's hildegard.mjs instead of the source.
const main = process.env.HILDEGARD_CLI ?? fileURLToPath(new URL('../src/main.ts', import.meta.url));
const run = promisify(execFile);

const cliEnv = (home: string) => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData'),
  XDG_CONFIG_HOME: join(home, '.config'),
  PATH: '',
  HF_TOKEN: '',
  // Never a real keychain from tests.
  HILDEGARD_SECRETS: 'file',
  // As the installed launcher does.
  ...(process.env.HILDEGARD_CLI ? { HILDEGARD_ENTRY: main } : {}),
});
type Out = {
  ok: boolean;
  needsOwner: boolean;
  message: string;
  steps: { id: string; status: string; detail: string; command?: string }[];
  [k: string]: unknown;
};

/** Runs `hildegard …` in its own home folder, so no real app config is ever touched. */
async function hildegard(home: string, ...args: string[]) {
  const { stdout } = await run(process.execPath, [main, ...args, '--json'], {
    env: cliEnv(home),
    timeout: 60_000,
  }).catch((e: { stdout: string }) => ({ stdout: e.stdout }));
  return JSON.parse(stdout) as Out;
}

/** The same, with something piped to its stdin, as an agent pipes a secret the owner gave it. */
function hildegardWithStdin(home: string, input: string, ...args: string[]) {
  return new Promise<Out>((resolve, reject) => {
    const child = spawn(process.execPath, [main, ...args, '--json'], { env: cliEnv(home) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out) as Out));
    child.stdin.end(input);
  });
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

  it('remembers the port it was started on for status and stop', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const port = String(7400 + Math.floor(Math.random() * 400));
    expect((await hildegard(home, 'start', '--port', port, '--data', data, '--fake-gpu')).ok).toBe(true);
    const st = await hildegard(home, 'status', '--data', data, '--fake-gpu');
    expect(st).toMatchObject({ running: true, url: `http://127.0.0.1:${port}` });
    expect((await hildegard(home, 'stop', '--data', data)).steps[0]!.status).toBe('done');
    expect((await hildegard(home, 'status', '--data', data, '--port', port)).running).toBe(false);
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

  // Fifteen runs of the CLI: give Windows' slow Node starts room.
  it('pairs devices: invite on the GPU, join, list, use and leave on the other, revoke', async () => {
    const node = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-cli-node-'))]), port: 0 },
      { fakeTickMs: 20, secrets: fileStore(join(tmpdir(), `hg-cli-node-${process.pid}.json`)) },
    );
    const nodePort = new URL(node.url).port;
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-mac-'));
    const mac = ['--port', String(7400 + Math.floor(Math.random() * 400)), '--data', data];
    try {
      // Without Tailscale, the owner has to say where this computer is reachable.
      const bare = await hildegard(home, 'choir', 'invite', '--port', nodePort);
      if (!bare.ok || bare.needsOwner) expect(bare.steps[0]).toMatchObject({ status: 'needs-owner' });
      const outside = await hildegard(
        home,
        'choir',
        'invite',
        '--port',
        nodePort,
        '--url',
        'http://192.168.0.9:1',
      );
      expect(outside.ok).toBe(false);

      const invite = await hildegard(home, 'choir', 'invite', '--port', nodePort, '--url', node.url);
      expect(invite.ok).toBe(true);
      expect(invite.code).toMatch(/^hgc1_/);

      expect((await hildegard(home, 'choir', 'join', 'nonsense', ...mac)).ok).toBe(false);
      const waiting = await hildegard(home, 'choir', 'join', ...mac);
      expect(waiting.needsOwner).toBe(true);
      const joined = await hildegard(home, 'choir', 'join', invite.code as string, ...mac);
      expect(joined.ok).toBe(true);
      const name = (joined.device as { name: string }).name;
      // This computer has no ComfyUI, so takes go to the device it joined.
      expect(joined.message).toBe(`Takes now render on ${name}.`);

      const list = await hildegard(home, 'choir', 'list', ...mac);
      expect(list.choir).toMatchObject({ use: name, devices: [{ name, online: true }] });
      const st = await hildegard(home, 'status', ...mac);
      expect(st.steps.find((x) => x.id === 'comfyui')!.detail).toContain(`Takes render on ${name}`);

      expect((await hildegard(home, 'choir', 'use', 'local', ...mac)).message).toBe(
        'Takes render on this computer.',
      );
      expect((await hildegard(home, 'choir', 'use', 'nowhere', ...mac)).ok).toBe(false);
      expect((await hildegard(home, 'choir', 'leave', name, ...mac)).ok).toBe(true);
      expect((await hildegard(home, 'choir', 'list', ...mac)).choir).toMatchObject({ devices: [] });

      expect((await hildegard(home, 'choir', 'revoke', '--port', nodePort)).ok).toBe(true);
      expect(node.choir.state().sharing.on).toBe(false);
    } finally {
      await hildegard(home, 'stop', ...mac);
      await node.close();
    }
  }, 90_000);

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

describe('host and doctor', () => {
  it('makes the owner from a piped passphrase, hosts at a link, invites, and turns it off', async () => {
    const calls: string[][] = [];
    const tailscale: Exec = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'status')
        return {
          ok: true,
          out: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'studio.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103'] },
          }),
        };
      return { ok: true, out: args[0] === 'serve' && args[1] === 'status' ? '{}' : '' };
    };
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-host-'));
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 },
      { fakeTickMs: 20, secrets: fileStore(join(data, 'secret.json')), exec: tailscale },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data];
    try {
      // No owner yet: an agent gets the command to hand the owner, never a passphrase prompt.
      const first = await hildegard(home, 'host', ...at);
      expect(first.needsOwner).toBe(true);
      expect(first.steps[0]).toMatchObject({
        id: 'owner',
        status: 'needs-owner',
        command: 'hildegard host owner',
      });
      expect((await hildegard(home, 'host', 'invite', ...at)).needsOwner).toBe(true);
      const short = await hildegardWithStdin(
        home,
        'short\n',
        'host',
        'owner',
        '--name',
        'Donovan',
        '--passphrase-stdin',
        ...at,
      );
      expect(short.ok).toBe(false);
      const owner = await hildegardWithStdin(
        home,
        'a long and private passphrase\n',
        'host',
        'owner',
        '--name',
        'Donovan',
        '--passphrase-stdin',
        ...at,
      );
      expect(owner.steps[0]).toMatchObject({ id: 'owner', status: 'done' });
      expect(srv.people.find('donovan')).toMatchObject({ role: 'owner' });

      const on = await hildegard(home, 'host', ...at);
      expect(on.ok).toBe(true);
      expect(on.url).toBe('https://studio.tail1234.ts.net');
      expect(on.steps.at(-1)).toMatchObject({ id: 'host', status: 'done' });
      expect(calls).toContainEqual(['serve', '--bg', '--https=443', srv.hostedUrl()]);
      // Again: nothing changes, nothing breaks.
      expect((await hildegard(home, 'host', ...at)).url).toBe('https://studio.tail1234.ts.net');

      const invite = await hildegard(home, 'host', 'invite', '--role', 'director', '--hours', '24', ...at);
      expect(invite.url).toMatch(/^https:\/\/studio\.tail1234\.ts\.net\/#\/invite\/[A-Za-z0-9_-]{43}$/);
      const people = await hildegard(home, 'host', 'people', ...at);
      expect(people.people).toMatchObject([{ name: 'Donovan', role: 'owner' }]);
      expect(people.invites).toMatchObject([{ role: 'director' }]);

      const st = await hildegard(home, 'status', ...at);
      expect(st.host).toMatchObject({ on: true, via: 'tailscale', url: 'https://studio.tail1234.ts.net' });
      expect(st.steps.find((x) => x.id === 'host')).toMatchObject({ status: 'done' });

      const funnel = await hildegard(home, 'host', '--funnel', ...at);
      expect(funnel.warning).toMatch(/public internet/);
      expect(calls).toContainEqual(['funnel', '--bg', '--https=443', srv.hostedUrl()]);
      const off = await hildegard(home, 'host', 'off', ...at);
      expect(off.host).toMatchObject({ on: false });
      expect(calls).toContainEqual(['funnel', '--https=443', 'off']);
      expect((await hildegard(home, 'host', 'revoke', 'Donovan', ...at)).ok).toBe(false);
    } finally {
      await srv.close();
    }
  }, 90_000);

  it('checks every part and prints the command that fixes each', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const port = String(7400 + Math.floor(Math.random() * 400));
    // Not running: that's the first thing to fix.
    const down = await hildegard(home, 'doctor', '--port', port, '--data', data);
    expect(down.ok).toBe(false);
    expect(down.steps.find((s) => s.id === 'server')).toMatchObject({
      status: 'failed',
      command: 'hildegard start --json',
    });
    const common = ['--port', port, '--data', data, '--fake-gpu'];
    expect((await hildegard(home, 'start', ...common)).ok).toBe(true);
    try {
      const d = await hildegard(home, 'doctor', ...common);
      expect(d.steps.map((s) => s.id)).toEqual(
        expect.arrayContaining([
          'gpu',
          'server',
          'comfyui',
          'models',
          'huggingface',
          'tailscale',
          'host',
          'agents',
        ]),
      );
      expect(d.steps.find((s) => s.id === 'server')!.status).toBe('done');
      // Tailscale isn't on this test's PATH.
      expect(d.steps.find((s) => s.id === 'tailscale')).toMatchObject({
        status: 'skipped',
        command: 'tailscale up',
      });
      expect(d.steps.find((s) => s.id === 'models')).toMatchObject({ status: 'needs-owner' });
      expect(d.host).toMatchObject({ on: false, owner: false });
      // Whatever is broken or waits on the owner comes with the command that fixes it.
      for (const s of d.steps.filter((x) => x.status === 'failed' || x.status === 'needs-owner'))
        expect(s.command, s.id).toBeTruthy();
    } finally {
      await hildegard(home, 'stop', ...common);
    }
  }, 60_000);

  it('accepts a license only when --accept-license names the model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const common = ['--port', String(7400 + Math.floor(Math.random() * 400)), '--data', data, '--fake-gpu'];
    try {
      for (const accept of [['--accept-license'], ['--accept-license', 'ltx-2-5-distilled'], []]) {
        const r = await hildegard(home, 'setup', '--model', 'wan-2-2-ti2v-5b', ...accept, ...common);
        const model = r.steps.find((s) => s.id === 'model')!;
        expect(model.status, accept.join(' ')).toBe('needs-owner');
        expect(model.command).toBe(
          'hildegard setup --model wan-2-2-ti2v-5b --accept-license wan-2-2-ti2v-5b --yes --json',
        );
        expect(model.detail).toContain('Apache-2.0');
      }
      const wrong = await hildegard(
        home,
        'models',
        'install',
        'wan-2-2-ti2v-5b',
        '--accept-license',
        'ltx-2-5-distilled',
        ...common,
      );
      expect(wrong.ok).toBe(false);
      expect(wrong.message).toContain('Nothing changed');
    } finally {
      await hildegard(home, 'stop', ...common);
    }
  }, 60_000);
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
