// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadCatalog, videoModels } from '@hildegard/presets';
import { fitWhy } from '@hildegard/runtime';
import { type Exec, fileStore, parseArgs, startServer, VERSION } from '@hildegard/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { starterModel } from '../src/commands.ts';
import { frontDoorStep } from '../src/doctor.ts';
import { printEvent, printResult, result } from '../src/output.ts';

// HILDEGARD_CLI tests an installed release's hildegard.mjs instead of the source.
const main = process.env.HILDEGARD_CLI ?? fileURLToPath(new URL('../src/main.ts', import.meta.url));
const run = promisify(execFile);

/** An OS-allocated free port, for the hosted listener (otherwise `port + 1` can collide with a parallel worker). */
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

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

/**
 * The homes and data folders of every command a test ran. Many of them (start, setup, open, models) can start a
 * background server that outlives the command, and a test that fails or times out never reaches its own `stop`.
 */
const touched = new Map<string, { home: string; data: string }>();
function track(home: string, args: string[]) {
  const at = args.findIndex((a) => a === '--data' || a.startsWith('--data='));
  if (at < 0) return;
  const data = args[at] === '--data' ? args[at + 1] : args[at]!.slice('--data='.length);
  if (data) touched.set(`${home}\0${data}`, { home, data });
}

/** The background servers (`… start --foreground …`) still running on this data folder. Not on Windows. */
async function serversOn(data: string) {
  if (process.platform === 'win32') return [];
  const { stdout } = await run('ps', ['-axo', 'pid=,command=']).catch(() => ({ stdout: '' }));
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .filter(
      (m) => Number(m[1]) !== process.pid && m[2]!.includes('start --foreground') && m[2]!.includes(data),
    )
    .map((m) => Number(m[1]));
}

// Whatever a test started is stopped, passed or failed: `hildegard stop` first, then the process (and its group,
// since it starts detached) for a server that didn't answer it.
afterEach(async () => {
  const left = [...touched.values()];
  touched.clear();
  await Promise.all(
    left.map(({ home, data }) =>
      run(process.execPath, [main, 'stop', '--data', data, '--json'], {
        env: cliEnv(home),
        timeout: 30_000,
      }).catch(() => {}),
    ),
  );
  for (const { data } of left)
    for (const pid of await serversOn(data)) {
      for (const target of [-pid, pid])
        try {
          process.kill(target, 'SIGKILL');
        } catch {}
    }
}, 60_000);

/** Runs `hildegard …` in its own home folder, so no real app config is ever touched. */
async function hildegard(home: string, ...args: string[]) {
  track(home, args);
  const { stdout } = await run(process.execPath, [main, ...args, '--json'], {
    env: cliEnv(home),
    timeout: 60_000,
  }).catch((e: { stdout: string }) => ({ stdout: e.stdout }));
  return JSON.parse(stdout) as Out;
}

/** The same, with more environment (test doubles for outside services). */
async function hildegardEnv(home: string, env: Record<string, string>, ...args: string[]) {
  track(home, args);
  const { stdout } = await run(process.execPath, [main, ...args, '--json'], {
    env: { ...cliEnv(home), ...env },
    timeout: 60_000,
  }).catch((e: { stdout: string }) => ({ stdout: e.stdout }));
  return JSON.parse(stdout) as Out;
}

/** The same, with something piped to its stdin, as an agent pipes a secret the owner gave it. */
function hildegardWithStdin(home: string, input: string, ...args: string[]) {
  track(home, args);
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
    expect(st.version).toBe(VERSION);
    expect(st.engine).toMatchObject({ comfy: 'fake', online: true });

    const linked = await hildegard(home, 'connect', 'cursor', ...common);
    expect(linked.steps[0]).toMatchObject({ id: 'connect-cursor', status: 'done' });
    const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.hildegard.args).toEqual([main, 'mcp']);
    expect(cfg.mcpServers.hildegard.env).toEqual({ HILDEGARD_URL: `http://127.0.0.1:${port}` });

    // A coding agent gets its skills and a sign-in step its provider's terms allow, in the same command.
    const omp = await hildegard(home, 'connect', 'omp', ...common);
    expect(omp.steps.map((s: { id: string }) => s.id)).toEqual(['connect-omp', 'skills', 'sign-in-omp']);
    expect(omp.steps[2]!.detail).toMatch(/API key/);
    expect(omp.message).toMatch(/^Hildegard is in Cursor and OMP\. /);
    expect(readFileSync(join(home, '.claude', 'skills', 'hildegard-video-edit', 'SKILL.md'), 'utf8')).toMatch(
      /name:/,
    );

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
  }, 60_000);

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

  it('leaves another home’s server alone and starts on the next free port', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const mine = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const theirs = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const port = 7400 + 2 * Math.floor(Math.random() * 200);
    expect((await hildegard(home, 'start', '--port', String(port), '--data', theirs, '--fake-gpu')).ok).toBe(
      true,
    );
    try {
      // Another home's server on the port is neither running here nor this one's to stop.
      expect((await hildegard(home, 'status', '--port', String(port), '--data', mine)).running).toBe(false);
      const left = await hildegard(home, 'stop', '--port', String(port), '--data', mine);
      expect(left.steps[0]).toMatchObject({ status: 'skipped' });
      expect(left.steps[0]!.detail).toContain('another home');

      const started = await hildegard(home, 'start', '--port', String(port), '--data', mine, '--fake-gpu');
      expect(started.ok).toBe(true);
      expect(started.steps[0]!.detail).toContain(`Port ${port} is another Hildegard’s`);
      const moved = Number(new URL(String(started.url)).port);
      expect(moved).toBeGreaterThan(port);
      // Later commands find it from its folder, and both servers keep running.
      expect(await hildegard(home, 'status', '--data', mine)).toMatchObject({
        running: true,
        url: `http://127.0.0.1:${moved}`,
      });
      expect((await hildegard(home, 'status', '--data', theirs)).running).toBe(true);
      expect((await hildegard(home, 'stop', '--data', mine)).steps[0]!.status).toBe('done');
      expect((await hildegard(home, 'status', '--data', theirs)).running).toBe(true);
    } finally {
      await hildegard(home, 'stop', '--data', theirs);
    }
  }, 60_000);

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
    // Commands for the GPU name its folder as well as its port: a server is only theirs when the folders match.
    const nodeData = mkdtempSync(join(tmpdir(), 'hg-cli-node-'));
    const node = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', nodeData]), port: 0 },
      { fakeTickMs: 20, secrets: fileStore(join(tmpdir(), `hg-cli-node-${process.pid}.json`)) },
    );
    const nodePort = new URL(node.url).port;
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-mac-'));
    const mac = ['--port', String(7400 + Math.floor(Math.random() * 400)), '--data', data];
    try {
      // Without Tailscale, the owner has to say where this computer is reachable.
      const bare = await hildegard(home, 'choir', 'invite', '--port', nodePort, '--data', nodeData);
      if (!bare.ok || bare.needsOwner) expect(bare.steps[0]).toMatchObject({ status: 'needs-owner' });
      const outside = await hildegard(
        home,
        'choir',
        'invite',
        '--port',
        nodePort,
        '--data',
        nodeData,
        '--url',
        'http://192.168.0.9:1',
      );
      expect(outside.ok).toBe(false);

      const invite = await hildegard(
        home,
        'choir',
        'invite',
        '--port',
        nodePort,
        '--data',
        nodeData,
        '--url',
        node.url,
        '--long',
      );
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

      // The primary for Talk is its own choice, and the list says which it is.
      const made = await hildegard(home, 'choir', 'primary', name, ...mac);
      expect(made.message).toBe(
        `Talk hears and answers on ${name} by default. The microphone and speaker stay where you talk.`,
      );
      expect(made.choir).toMatchObject({ primary: name, use: 'local' });
      const listed = await hildegard(home, 'choir', 'list', ...mac);
      expect(listed.steps.find((x) => x.id === `device-${name}`)!.detail).toMatch(/^Primary for Talk\. /);
      expect(listed.steps.find((x) => x.id === 'local')!.detail).not.toContain('Primary');
      expect((await hildegard(home, 'choir', 'primary', 'nowhere', ...mac)).ok).toBe(false);
      expect((await hildegard(home, 'choir', 'primary', ...mac)).ok).toBe(false);
      expect((await hildegard(home, 'choir', 'primary', 'local', ...mac)).message).toBe(
        'Talk hears and answers on this computer by default.',
      );
      await hildegard(home, 'choir', 'primary', name, ...mac);
      expect((await hildegard(home, 'choir', 'leave', name, ...mac)).ok).toBe(true);
      // Removing the primary hands Talk back to this computer.
      expect((await hildegard(home, 'choir', 'list', ...mac)).choir).toMatchObject({ primary: 'local' });
      expect((await hildegard(home, 'choir', 'list', ...mac)).choir).toMatchObject({ devices: [] });

      expect((await hildegard(home, 'choir', 'revoke', '--port', nodePort, '--data', nodeData)).ok).toBe(
        true,
      );
      expect(node.choir.state().sharing.on).toBe(false);
    } finally {
      await hildegard(home, 'stop', ...mac);
      await node.close();
    }
  }, 90_000);

  it('rents a Runpod GPU that joins the fleet, reports it, and stops it', async () => {
    // A stand-in pod: a Hildegard server with a fake GPU, which "boots" when the fake Runpod creates it.
    const pod = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-cli-pod-'))]), port: 0 },
      { fakeTickMs: 20, secrets: fileStore(join(tmpdir(), `hg-cli-pod-${process.pid}.json`)) },
    );
    const pods = new Map<
      string,
      { id: string; desiredStatus: string; costPerHr: number; env: Record<string, string> }
    >();
    const auths: (string | undefined)[] = [];
    const runpod = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        auths.push(req.headers.authorization);
        const send = (status: number, v: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        };
        const [, , id, verb] = (req.url ?? '').split('/');
        if (req.method === 'POST' && req.url === '/pods') {
          const spec = JSON.parse(body) as { env: Record<string, string>; cloudType: string };
          const p = {
            id: 'pod7XYZ',
            desiredStatus: 'RUNNING',
            costPerHr: 0.69,
            env: spec.env,
            gpu: { displayName: 'RTX 4090' },
          };
          pods.set(p.id, p);
          // What boot.sh does on the pod: share the GPU with the key the owner's computer made.
          pod.choir.invite(pod.url, 'pod', spec.env.HILDEGARD_JOIN_KEY);
          return send(200, p);
        }
        const p = id ? pods.get(id) : undefined;
        if (!p) return send(404, { error: 'not found' });
        if (req.method === 'GET') return send(200, p);
        if (req.method === 'POST' && verb === 'stop') p.desiredStatus = 'EXITED';
        if (req.method === 'POST' && verb === 'start') p.desiredStatus = 'RUNNING';
        if (req.method === 'DELETE') pods.delete(p.id);
        return send(200, p);
      });
    });
    await new Promise<void>((r) => runpod.listen(0, '127.0.0.1', r));
    const rpPort = (runpod.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-mac-'));
    const mac = ['--port', String(7400 + Math.floor(Math.random() * 400)), '--data', data];
    const env = { HILDEGARD_RUNPOD_API: `http://127.0.0.1:${rpPort}`, HILDEGARD_RUNPOD_PROXY: pod.url };
    const cloud = (...a: string[]) => hildegardEnv(home, env, 'cloud', 'runpod', ...a, ...mac);
    try {
      const overview = await hildegard(home, 'cloud');
      expect(overview.steps.map((s) => s.id)).toEqual(['runpod', 'huggingface', 'colab']);

      const noKey = await cloud('up');
      expect(noKey.steps[0]).toMatchObject({ id: 'key', status: 'needs-owner' });
      expect(
        (await hildegardWithStdin(home, 'short', 'cloud', 'runpod', 'key', '--key-stdin', ...mac)).ok,
      ).toBe(false);
      const key = `rpa_${'x'.repeat(40)}`;
      expect((await hildegardWithStdin(home, key, 'cloud', 'runpod', 'key', '--key-stdin', ...mac)).ok).toBe(
        true,
      );
      // Kept as a secret, never in the settings.
      expect(JSON.stringify(await hildegard(home, 'cloud', 'runpod', 'key', ...mac))).not.toContain(key);

      // Never accepts a license for the owner.
      const license = await cloud('up', '--model', 'wan-2-2-ti2v-5b');
      expect(license.steps[0]).toMatchObject({ id: 'model', status: 'needs-owner' });
      expect(pods.size).toBe(0);

      const up = await cloud('up', '--model', 'wan-2-2-ti2v-5b', '--accept-license', 'wan-2-2-ti2v-5b');
      expect(up.ok).toBe(true);
      expect(up.steps.map((s) => [s.id, s.status])).toEqual([
        ['pod', 'done'],
        ['join', 'done'],
        ['use', 'done'],
      ]);
      expect(auths.every((a) => a === `Bearer ${key}`)).toBe(true);
      const created = [...pods.values()][0]!;
      expect(created.env).toMatchObject({
        HILDEGARD_MODEL: 'wan-2-2-ti2v-5b',
        HILDEGARD_ACCEPT_LICENSE: 'wan-2-2-ti2v-5b',
      });
      expect(created.env).not.toHaveProperty('HF_TOKEN');

      const list = await hildegard(home, 'choir', 'list', ...mac);
      expect(list.choir).toMatchObject({
        use: 'runpod-pod7xyz',
        devices: [{ name: 'runpod-pod7xyz', online: true }],
      });
      const st = await cloud('status');
      expect(st).toMatchObject({ pod: { status: 'RUNNING', costPerHr: 0.69 }, device: { online: true } });

      // Up again does nothing new; down stops it; up starts it again.
      expect((await cloud('up')).steps.map((s) => s.id)).toEqual(['use']);
      expect((await cloud('down')).ok).toBe(true);
      expect(created.desiredStatus).toBe('EXITED');
      expect((await cloud('up')).steps[0]).toMatchObject({ id: 'pod', status: 'done' });
      expect(created.desiredStatus).toBe('RUNNING');

      expect((await cloud('down', '--delete')).ok).toBe(true);
      expect(pods.size).toBe(0);
      expect((await hildegard(home, 'choir', 'list', ...mac)).choir).toMatchObject({ devices: [] });
      expect((await cloud('status')).steps[0]).toMatchObject({ status: 'skipped' });
    } finally {
      await hildegard(home, 'stop', ...mac);
      runpod.close();
      await pod.close();
    }
  }, 90_000);

  it('says what an agent must ask the owner when ComfyUI is not installed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const r = await hildegard(home, 'setup', '--data', data, '--port', '7399');
    expect(r.needsOwner).toBe(true);
    expect(r.steps[0]).toMatchObject({ id: 'install', status: 'needs-owner' });
  });

  it('says which voice environments are set up, and the command for each one that isn’t', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-data-'));
    const r = await hildegard(home, 'voice', '--data', data);
    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['speech', 'skipped'],
      ['chatterbox', 'skipped'],
      ['qwen', 'skipped'],
    ]);
    expect(r.steps[1]!.command).toBe('hildegard voice install --env chatterbox --json');
    expect(r.message).toMatch(/hildegard voice install/);
    const bad = await hildegard(home, 'voice', 'install', '--env', 'speech,bark', '--data', data);
    expect(bad).toMatchObject({ ok: false, steps: [] });
    expect(bad.message).toMatch(/no voice environment called “bark”/);
  });

  it('starts people on the best model that fits their GPU', () => {
    const { catalog } = loadCatalog();
    const gpu = (vramGb: number) => ({ backend: 'cuda' as const, name: 'x', vramGb, torchBackend: 'cu130' });
    expect(starterModel(catalog, gpu(24))?.id).toBe('ltx-2-5-distilled');
    expect(starterModel(catalog, gpu(16))?.id).toBe('wan-2-2-ti2v-5b');
    expect(starterModel(catalog, gpu(10))?.id).toBe('wan-2-2-ti2v-5b');
    expect(starterModel(catalog, gpu(6))).toBeNull();
  });

  it('starts no Apple silicon Mac on a local model, since none renders well on Apple’s GPU yet', () => {
    const { catalog } = loadCatalog();
    // macOS gives the GPU three quarters of unified memory, as detectGpu reports it.
    const mac = { backend: 'mps' as const, name: 'Apple M5', vramGb: 24, torchBackend: null };
    // Wan 2.2 on a 24 GB M5 came out a blurred blob after 70 minutes; LTX needs int8 kernels Apple lacks.
    expect(starterModel(catalog, mac)).toBeNull();
    expect(starterModel(catalog, { ...mac, vramGb: 96 })).toBeNull();
    for (const m of videoModels(catalog)) expect(fitWhy(mac, m)).toBe('apple-gpu');
    // Stills are another matter: FLUX.2 [klein] draws characters on Apple’s GPU, though it starts no video.
    const klein = catalog.models.find((m) => m.id === 'flux-2-klein-4b')!;
    expect(fitWhy(mac, klein)).not.toBe('apple-gpu');
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
            Self: { DNSName: 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] },
          }),
        };
      return { ok: true, out: args[0] === 'serve' && args[1] === 'status' ? '{}' : '' };
    };
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-host-'));
    const hostPort = await freePort();
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0, hostPort },
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
        'Alex',
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
        'Alex',
        '--passphrase-stdin',
        ...at,
      );
      expect(owner.steps[0]).toMatchObject({ id: 'owner', status: 'done' });
      expect(srv.people.find('alex')).toMatchObject({ role: 'owner' });

      const on = await hildegard(home, 'host', ...at);
      expect(on.ok).toBe(true);
      expect(on.url).toBe('https://studio.example.ts.net');
      expect(on.steps.at(-1)).toMatchObject({ id: 'host', status: 'done' });
      // AI apps on the owner's devices reach the MCP there with a key; chatbots on the web need Funnel.
      expect(on.mcpUrl).toBe('https://studio.example.ts.net/mcp');
      expect(on.mcp).toMatch(/--funnel/);
      expect(calls).toContainEqual(['serve', '--bg', '--https=443', srv.hostedUrl()]);
      // Again: nothing changes, nothing breaks.
      expect((await hildegard(home, 'host', ...at)).url).toBe('https://studio.example.ts.net');

      const invite = await hildegard(home, 'host', 'invite', '--role', 'director', '--hours', '24', ...at);
      expect(invite.url).toMatch(/^https:\/\/studio\.example\.ts\.net\/#\/invite\/[A-Za-z0-9_-]{43}$/);
      const people = await hildegard(home, 'host', 'people', ...at);
      expect(people.people).toMatchObject([{ name: 'Alex', role: 'owner' }]);
      expect(people.invites).toMatchObject([{ role: 'director' }]);

      expect(await hildegard(home, 'host', 'limit', ...at)).toMatchObject({ ok: true, directorQueue: 3 });
      const limit = await hildegard(home, 'host', 'limit', '5', ...at);
      expect(limit).toMatchObject({ ok: true, directorQueue: 5 });
      expect(limit.steps[0]).toMatchObject({
        id: 'limit',
        status: 'done',
        detail: expect.stringMatching(/5 takes/),
      });
      const bad = await hildegard(home, 'host', 'limit', 'lots', ...at);
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/1 to 100/);
      expect((await hildegard(home, 'host', 'limit', ...at)).directorQueue).toBe(5);

      const st = await hildegard(home, 'status', ...at);
      expect(st.host).toMatchObject({ on: true, via: 'tailscale', url: 'https://studio.example.ts.net' });
      expect(st.steps.find((x) => x.id === 'host')).toMatchObject({ status: 'done' });

      const funnel = await hildegard(home, 'host', '--funnel', ...at);
      expect(funnel.warning).toMatch(/public internet/);
      expect(funnel.mcp).toMatch(/claude\.ai/);
      expect(calls).toContainEqual(['funnel', '--bg', '--https=443', srv.hostedUrl()]);
      const off = await hildegard(home, 'host', 'off', ...at);
      expect(off.host).toMatchObject({ on: false });
      expect(calls).toContainEqual(['funnel', '--https=443', 'off']);
      expect((await hildegard(home, 'host', 'revoke', 'Alex', ...at)).ok).toBe(false);
    } finally {
      await srv.close();
    }
  }, 90_000);

  it('hosts at the owner’s own front door: checks the address first, makes no Tailscale call, shows the route', async () => {
    const calls: string[][] = [];
    const tailscale: Exec = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'status')
        return {
          ok: true,
          out: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] },
          }),
        };
      return { ok: true, out: args[0] === 'serve' && args[1] === 'status' ? '{}' : '' };
    };
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-door-'));
    const hostPort = await freePort();
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0, hostPort },
      { fakeTickMs: 20, secrets: fileStore(join(data, 'secret.json')), exec: tailscale },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data];
    const mutating = () => calls.filter((a) => a[0] === 'serve' || a[0] === 'funnel');
    try {
      // Bad addresses and mixed routes are refused before anything is asked of the server.
      for (const bad of [
        'http://hildegard.example.com',
        'https://hildegard.example.com/mcp',
        'https://hildegard.example.com?x=1',
        'https://100.64.0.1',
        'https://studio.example.ts.net',
        'hildegard.example.com',
      ]) {
        const r = await hildegard(home, 'host', '--public-url', bad, ...at);
        expect(r.ok, bad).toBe(false);
        expect(r.steps[0], bad).toMatchObject({ id: 'host', status: 'failed' });
        expect(r.message, bad).toBeTruthy();
      }
      const mixed = await hildegard(
        home,
        'host',
        '--public-url',
        'https://hildegard.example.com',
        '--funnel',
        ...at,
      );
      expect(mixed.ok).toBe(false);
      expect(mixed.message).toMatch(/pick one route/);

      // A good address still needs the owner account first.
      const first = await hildegard(home, 'host', '--public-url', 'https://hildegard.example.com', ...at);
      expect(first.needsOwner).toBe(true);
      expect(first.steps[0]).toMatchObject({ id: 'owner', command: 'hildegard host owner' });
      await hildegardWithStdin(
        home,
        'a long and private passphrase\n',
        'host',
        'owner',
        '--name',
        'Alex',
        '--passphrase-stdin',
        ...at,
      );

      const on = await hildegard(home, 'host', '--public-url=https://Hildegard.Example.com/', ...at);
      expect(on.ok, on.message).toBe(true);
      expect(on.url).toBe('https://hildegard.example.com');
      expect(on.mcpUrl).toBe('https://hildegard.example.com/mcp');
      expect(on.host).toMatchObject({ on: true, via: 'custom' });
      expect(on.steps.at(-1)).toMatchObject({
        id: 'host',
        status: 'done',
        detail: expect.stringContaining('HTTPS through your own front door'),
      });
      expect(on.mcp).toMatch(/claude\.ai/);
      expect(on.warning).toMatch(/public internet/);
      expect(on.warning).toMatch(/front door/);
      expect(mutating()).toEqual([]);

      const status = await hildegard(home, 'host', 'status', ...at);
      expect(status.steps.find((x) => x.id === 'host')?.detail).toMatch(
        /https:\/\/hildegard\.example\.com · HTTPS through your own front door/,
      );
      expect(status.mcpUrl).toBe('https://hildegard.example.com/mcp');

      const off = await hildegard(home, 'host', 'off', ...at);
      expect(off.host).toMatchObject({ on: false });
      expect(mutating()).toEqual([]);
    } finally {
      await srv.close();
    }
  }, 90_000);

  it('doctor checks the front door’s OAuth answer, and warns instead of failing when it can’t', async () => {
    const url = 'https://hildegard.example.com';
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const seen: string[] = [];
    const spy = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ resource: `${url}/mcp` }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await frontDoorStep(url, spy)).toMatchObject({ id: 'front-door', status: 'done' });
    expect(seen).toEqual([`${url}/.well-known/oauth-protected-resource`]);
    // Somewhere else answers, or the door is down: a warning (skipped), never a failure.
    const wrong = await frontDoorStep(url, answer(200, { resource: 'https://other.example.com/mcp' }));
    expect(wrong).toMatchObject({ status: 'skipped' });
    expect(wrong.detail).toContain('https://other.example.com/mcp');
    expect(await frontDoorStep(url, answer(502, {}))).toMatchObject({ status: 'skipped' });
    const down = await frontDoorStep(url, (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch);
    expect(down).toMatchObject({ status: 'skipped' });
    expect(down.detail).toContain('ENOTFOUND');
  });

  it('joins with a short code only at the address given, and with a long code on request', async () => {
    const nodeData = mkdtempSync(join(tmpdir(), 'hg-cli-short-node-'));
    const node = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', nodeData]), port: 0 },
      { fakeTickMs: 20, secrets: fileStore(join(tmpdir(), `hg-cli-short-${process.pid}.json`)) },
    );
    const nodePort = new URL(node.url).port;
    const macData = mkdtempSync(join(tmpdir(), 'hg-cli-short-mac-'));
    const mac = await startServer(
      { ...parseArgs(['--data', macData]), port: 0 },
      {
        secrets: fileStore(join(macData, 'secret.json')),
        choirSecrets: () => fileStore(join(macData, 'choir-secret.json')),
      },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', nodePort, '--data', nodeData];
    const onMac = ['--port', new URL(mac.url).port, '--data', macData];
    try {
      const invite = await hildegard(home, 'choir', 'invite', '--url', node.url, ...at);
      expect(invite.ok).toBe(true);
      expect(invite.shortCode).toMatch(/^HG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(invite.command).toBe(`hildegard choir join ${invite.shortCode} --url ${node.url}`);
      expect(invite.code).toBeUndefined();
      expect(Date.parse(invite.expiresAt as string) - Date.now()).toBeGreaterThan(9 * 60_000);

      // A wrong code with the address: refused, nothing kept.
      const wrong = await hildegard(home, 'choir', 'join', 'HG-0000-0000', '--url', node.url, ...onMac);
      expect(wrong.ok).toBe(false);
      expect(wrong.steps[0]!.detail).toMatch(/isn’t good|didn’t accept the code/);
      expect(mac.choir.state().devices).toEqual([]);

      // The right one with the address, typed the way people type it.
      const joined = await hildegard(
        home,
        'choir',
        'join',
        (invite.shortCode as string).toLowerCase(),
        '--url',
        node.url,
        ...onMac,
      );
      expect(joined.ok, joined.message).toBe(true);
      const name = (joined.device as { name: string }).name;
      expect(joined.message).toBe(`Takes now render on ${name}.`);
      // Once: the same code is spent.
      expect(
        (await hildegard(home, 'choir', 'join', invite.shortCode as string, '--url', node.url, ...onMac)).ok,
      ).toBe(false);
      expect((await hildegard(home, 'choir', 'leave', name, ...onMac)).ok).toBe(true);

      // With no address, nothing is sent anywhere: it says the command to run.
      const second = await hildegard(home, 'choir', 'invite', '--url', node.url, ...at);
      const bare = await hildegard(home, 'choir', 'join', second.shortCode as string, ...onMac);
      expect(bare.ok).toBe(false);
      expect(bare.steps[0]!.detail).toContain('--url');
      expect(mac.choir.state().devices).toEqual([]);

      // The long code still joins, when asked for.
      const third = await hildegard(home, 'choir', 'invite', '--url', node.url, '--long', ...at);
      expect((await hildegard(home, 'choir', 'join', third.code as string, ...onMac)).ok).toBe(true);
    } finally {
      await mac.close();
      await node.close();
    }
  }, 120_000);

  it('makes a one-time connect code for a chatbot, and lists the chatbot as approved by code', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-code-'));
    const hostPort = await freePort();
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0, hostPort },
      {
        fakeTickMs: 20,
        secrets: fileStore(join(data, 'secret.json')),
        exec: async (_c, a) => ({
          ok: true,
          out:
            a[0] === 'status'
              ? JSON.stringify({
                  BackendState: 'Running',
                  Self: { DNSName: 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] },
                })
              : a[1] === 'status'
                ? '{}'
                : '',
        }),
      },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data];
    const link = srv.hostedUrl()!;
    try {
      // No owner yet: nobody to approve as.
      const none = await hildegard(home, 'host', 'code', ...at);
      expect(none.needsOwner).toBe(true);
      expect(none.steps[0]).toMatchObject({ id: 'code', command: 'hildegard host owner' });
      await hildegardWithStdin(
        home,
        'a long and private passphrase\n',
        'host',
        'owner',
        '--name',
        'Alex',
        '--passphrase-stdin',
        ...at,
      );

      // Before there is a link, the code exists but the chatbot has nowhere to go.
      const early = await hildegard(home, 'host', 'code', ...at);
      expect(early.code).toMatch(/^HG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(early.mcpUrl).toBeNull();
      expect(early.steps[0]).toMatchObject({ status: 'needs-owner', command: 'hildegard host' });

      expect((await hildegard(home, 'host', ...at)).ok).toBe(true);
      // The link's address can lag `host` by a moment under load; wait for it rather than race it.
      let made = await hildegard(home, 'host', 'code', ...at);
      for (let i = 0; i < 40 && !made.mcpUrl; i++) {
        await new Promise((r) => setTimeout(r, 250));
        made = await hildegard(home, 'host', 'code', ...at);
      }
      expect(made.ok).toBe(true);
      expect(made.mcpUrl).toBe('https://studio.example.ts.net/mcp');
      expect(made.person).toMatchObject({ name: 'Alex' });
      expect(Date.parse(made.expiresAt as string) - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(made.steps[0]).toMatchObject({
        id: 'code',
        status: 'done',
        detail: expect.stringContaining(made.code as string),
      });

      // A chatbot uses it on Hildegard’s page (through the link’s listener, as Tailscale would forward it).
      const redirect = 'https://chat.example/oauth/callback';
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-0123456789';
      const reg = await fetch(`${link}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Chat Example', redirect_uris: [redirect] }),
      });
      const clientId = ((await reg.json()) as { client_id: string }).client_id;
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://studio.example.ts.net/mcp',
      });
      const authz = `${link}/oauth/authorize?${q}`;
      // The page is served for the link’s own name, as Tailscale would present it.
      const page = await new Promise<string>((resolve, reject) => {
        const u = new URL(authz);
        httpRequest(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            headers: { host: 'studio.example.ts.net', 'x-forwarded-proto': 'https' },
          },
          (r) => {
            let b = '';
            r.on('data', (d) => (b += d));
            r.on('end', () => resolve(b));
          },
        )
          .on('error', reject)
          .end();
      });
      const request = /name="request" value="([^"]+)"/.exec(page)![1]!;
      const posted = await new Promise<{ status: number; location: string }>((resolve, reject) => {
        const body = new URLSearchParams({
          request,
          decision: 'allow',
          code: made.code as string,
        }).toString();
        const u = new URL(`${link}/oauth/authorize`);
        const req = httpRequest(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: {
              host: 'studio.example.ts.net',
              'x-forwarded-proto': 'https',
              origin: 'https://studio.example.ts.net',
              'content-type': 'application/x-www-form-urlencoded',
            },
          },
          (r) => resolve({ status: r.statusCode!, location: String(r.headers.location ?? '') }),
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(posted.status).toBe(303);
      const authCode = new URL(posted.location).searchParams.get('code')!;
      const tok = await new Promise<number>((resolve, reject) => {
        const u = new URL(`${link}/oauth/token`);
        const req = httpRequest(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: {
              host: 'studio.example.ts.net',
              'x-forwarded-proto': 'https',
              'content-type': 'application/x-www-form-urlencoded',
            },
          },
          (r) => resolve(r.statusCode!),
        );
        req.on('error', reject);
        req.end(
          new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: clientId,
            redirect_uri: redirect,
            code_verifier: verifier,
          }).toString(),
        );
      });
      expect(tok).toBe(200);

      const keys = await hildegard(home, 'host', 'keys', ...at);
      expect(keys.steps[0]!.detail).toContain('approved by code from Alex');
      expect(keys.grants).toMatchObject([{ kind: 'chatbot', approval: 'code', person: { name: 'Alex' } }]);
    } finally {
      await srv.close();
    }
  }, 90_000);

  it('makes a key on one device and links an app on another to that Hildegard, key kept out of its config', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-key-'));
    const hostPort = await freePort();
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0, hostPort },
      {
        fakeTickMs: 20,
        secrets: fileStore(join(data, 'secret.json')),
        exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
      },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const laptop = mkdtempSync(join(tmpdir(), 'hg-cli-laptop-'));
    const at = ['--port', new URL(srv.url).port, '--data', data];
    const link = srv.hostedUrl()!;
    try {
      // A key acts as someone: with nobody here yet, the owner comes first.
      const none = await hildegard(home, 'host', 'key', 'Laptop', ...at);
      expect(none.needsOwner).toBe(true);
      expect(none.steps[0]).toMatchObject({ id: 'key', command: 'hildegard host owner' });
      await srv.people.setOwner('Alex', 'a long and private passphrase');
      const made = await hildegard(home, 'host', 'key', 'Claude Desktop on the laptop', ...at);
      expect(made.ok).toBe(true);
      const key = made.key as string;
      expect(key).toMatch(/^hgk_/);
      expect((await hildegard(home, 'host', 'keys', ...at)).grants).toMatchObject([
        { name: 'Claude Desktop on the laptop', kind: 'key', person: { name: 'Alex' } },
      ]);

      // On the laptop: no key yet is the owner's step; a wrong one is refused; the right one links the app.
      const laptopAt = ['--data', join(laptop, 'data')];
      const waiting = await hildegardWithStdin(
        laptop,
        '',
        'connect',
        'claude-desktop',
        '--remote',
        link,
        ...laptopAt,
      );
      expect(waiting.needsOwner).toBe(true);
      const wrong = await hildegardWithStdin(
        laptop,
        `hgk_${'x'.repeat(43)}`,
        'connect',
        'claude-desktop',
        '--remote',
        link,
        '--key-stdin',
        ...laptopAt,
      );
      expect(wrong.ok).toBe(false);
      const linked = await hildegardWithStdin(
        laptop,
        `${key}\n`,
        'connect',
        'claude-desktop',
        '--remote',
        link,
        '--key-stdin',
        ...laptopAt,
      );
      expect(linked.ok, linked.message).toBe(true);
      // Where Claude Desktop keeps its settings on each OS, under the laptop's home (see cliEnv).
      const settings =
        process.platform === 'darwin'
          ? join(laptop, 'Library', 'Application Support')
          : process.platform === 'win32'
            ? join(laptop, 'AppData')
            : join(laptop, '.config');
      const config = readFileSync(join(settings, 'Claude', 'claude_desktop_config.json'), 'utf8');
      expect(config).toContain('--remote');
      expect(config).not.toContain(key);

      // The app runs `hildegard mcp --remote`, which carries its messages to the other device.
      const client = new Client({ name: 'Claude Desktop', version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [main, 'mcp', '--remote', link, ...laptopAt],
          env: cliEnv(laptop) as Record<string, string>,
          stderr: 'ignore',
        }),
      );
      const r = (await client.callTool({ name: 'hildegard_status', arguments: {} })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      expect(JSON.stringify(r.content)).toContain('stand-in GPU');
      await client.close();

      // Revoked on the GPU device: the laptop's app is turned away with a reason, not a hang.
      expect(
        (await hildegard(home, 'host', 'keys', 'revoke', 'Claude Desktop on the laptop', ...at)).ok,
      ).toBe(true);
      const after = new Client({ name: 'Claude Desktop', version: '1.0.0' });
      await expect(
        after.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [main, 'mcp', '--remote', link, ...laptopAt],
            env: cliEnv(laptop) as Record<string, string>,
            stderr: 'ignore',
          }),
        ),
      ).rejects.toThrow(/refused/);
      await after.close();
    } finally {
      await srv.close();
    }
  }, 90_000);

  it('lists local models, adds an endpoint with its key piped in, and lets a local model direct', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-llm-'));
    let round = 0;
    const runtimes = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: [{ name: 'qwen3:4b' }] });
      if (url === 'http://127.0.0.1:11434/v1/chat/completions')
        return Response.json({
          choices: [
            round++ === 0
              ? {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'direct_shot', arguments: '{"prompt":"Rain on a tin roof"}' },
                      },
                    ],
                  },
                }
              : { message: { role: 'assistant', content: 'One shot of rain.' } },
          ],
        });
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 },
      {
        fakeTickMs: 20,
        secrets: fileStore(join(data, 'secret.json')),
        llm: { fetch: runtimes, env: {}, localAi: { gateways: async () => [], key: () => null } },
      },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data];
    try {
      const list = await hildegard(home, 'llm', ...at);
      expect(list.ok).toBe(true);
      expect(list.steps).toMatchObject([
        { id: 'llm-ollama', status: 'done', detail: expect.stringContaining('qwen3:4b') },
      ]);
      const added = await hildegardWithStdin(
        home,
        'sk-secret\n',
        'llm',
        'add',
        'Desk',
        'http://10.0.0.9:8000',
        '--key-stdin',
        ...at,
      );
      expect(added.endpoint).toMatchObject({
        id: 'custom-desk',
        keyed: true,
        url: 'http://10.0.0.9:8000/v1',
      });
      expect(JSON.stringify(added)).not.toContain('sk-secret');
      expect((await hildegard(home, 'llm', 'remove', 'Desk', ...at)).ok).toBe(true);
      const directed = await hildegard(home, 'llm', 'direct', 'rain on a tin roof', ...at);
      expect(directed.ok, directed.message).toBe(true);
      expect(directed.message).toContain('qwen3:4b directed a shot');
    } finally {
      await srv.close();
    }
  }, 60_000);

  it('lists templates, starts a site from one, and links Figma with the token piped in', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-sites-'));
    const figmaFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const token = new Headers(init?.headers).get('x-figma-token');
      if (url === 'https://api.figma.com/v1/me' && token === 'figd_abcdefghijklmnopqrstuvwxyz')
        return Response.json({ handle: 'Donna' });
      return new Response('{}', { status: 403 });
    }) as typeof fetch;
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 },
      { fakeTickMs: 20, secrets: fileStore(join(data, 'secret.json')), chrome: null, figmaFetch },
    );
    const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
    const at = ['--port', new URL(srv.url).port, '--data', data];
    try {
      const tpl = await hildegard(home, 'sites', 'templates', ...at);
      expect(tpl.steps.map((s) => s.id)).toContain('template-hearth');
      const made = await hildegard(home, 'sites', 'new', 'hearth', '--name', 'Corner Bakery', ...at);
      expect(made.ok, made.message).toBe(true);
      expect(made.site).toMatchObject({ title: 'Corner Bakery', pages: ['index.html'] });
      expect((await hildegard(home, 'sites', ...at)).steps[0]).toMatchObject({ title: 'Corner Bakery' });
      const needs = await hildegard(
        home,
        'sites',
        'new',
        '--figma',
        'https://www.figma.com/design/AbCdEf123456/X',
        ...at,
      );
      expect(needs.ok).toBe(false);
      expect(needs.steps[0]?.command).toBe('hildegard figma token');
      expect((await hildegard(home, 'figma', 'token', ...at)).needsOwner).toBe(true);
      const linked = await hildegardWithStdin(
        home,
        'figd_abcdefghijklmnopqrstuvwxyz\n',
        'figma',
        'token',
        '--token-stdin',
        ...at,
      );
      expect(linked.ok, linked.message).toBe(true);
      expect(JSON.stringify(linked)).not.toContain('figd_');
      expect((await hildegard(home, 'figma', ...at)).figma).toEqual({ linked: true });
      expect((await hildegard(home, 'figma', 'unlink', ...at)).ok).toBe(true);
    } finally {
      await srv.close();
    }
  }, 60_000);

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

describe('printEvent', () => {
  it('prints each install step and log line as one line of JSON, for the Hildegard app', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printEvent({ step: { id: 'uv', title: 'Get uv', status: 'done', detail: 'Installed uv.\nIn tools.' } });
      printEvent({ log: 'Downloading torch' });
      const lines = log.mock.calls.map((c) => c[0] as string);
      expect(lines.every((l) => !l.includes('\n'))).toBe(true);
      expect(lines.map((l) => JSON.parse(l))).toEqual([
        { step: { id: 'uv', title: 'Get uv', status: 'done', detail: 'Installed uv.\nIn tools.' } },
        { log: 'Downloading torch' },
      ]);
    } finally {
      log.mockRestore();
    }
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

  it('prints each fix without --json for people, and keeps it for agents', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const r = result(
        [
          {
            id: 'host',
            title: 'Link',
            status: 'needs-owner',
            detail: 'Off.',
            command: 'hildegard host --json',
          },
          {
            id: 'model',
            title: 'Model',
            status: 'needs-owner',
            detail: 'License.',
            command: 'hildegard setup --model m --accept-license m --yes --json',
          },
          {
            id: 'server',
            title: 'Server',
            status: 'failed',
            detail: 'Down.',
            command: 'hildegard start --json',
          },
        ],
        'Not yet.',
      );
      printResult(r, false);
      const human = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(human).not.toContain('--json');
      expect(human).toContain('hildegard host\n');
      expect(human).toContain('hildegard setup --model m --accept-license m --yes');
      log.mockClear();
      printResult(r, true);
      const out = JSON.parse(log.mock.calls[0]![0] as string);
      expect(out.steps.map((s: { command: string }) => s.command)).toEqual([
        'hildegard host --json',
        'hildegard setup --model m --accept-license m --yes --json',
        'hildegard start --json',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('doctor’s ComfyUI step', () => {
  it('treats ComfyUI still loading as a wait, with no fix to run', async () => {
    const { comfyStep } = await import('../src/doctor.ts');
    const { COMFY_STARTING } = await import('@hildegard/server');
    const runtime = { comfyui: '0.42.1', torch: '2.14.1' } as Parameters<typeof comfyStep>[1];
    const starting = comfyStep(
      { comfy: 'managed', online: false, fake: false, problem: COMFY_STARTING } as Parameters<
        typeof comfyStep
      >[0],
      runtime,
      { up: true, fake: false, external: false },
    );
    expect(starting).toMatchObject({
      status: 'skipped',
      detail: 'ComfyUI is starting. Run doctor again in a minute.',
    });
    expect(starting.command).toBeUndefined();
    const stuck = comfyStep(
      { comfy: 'managed', online: false, fake: false, problem: 'It stopped.' } as Parameters<
        typeof comfyStep
      >[0],
      runtime,
      { up: true, fake: false, external: false },
    );
    expect(stuck).toMatchObject({ status: 'failed', command: 'hildegard restart --json' });
  });
});

describe('doctor’s model steps', () => {
  type Snap = Parameters<typeof import('../src/doctor.ts').modelSteps>[0];
  const model = (id: string, fitWhy: 'memory' | 'apple-gpu' | null, gated = false) =>
    ({ id, installed: false, downloading: null, gated, fitWhy }) as unknown as Snap['models'][number];
  const hf = { linked: false } as Snap['hf'];

  it('on a Mac no model renders on, points to pairing and asks for no Hugging Face account', async () => {
    const { modelSteps } = await import('../src/doctor.ts');
    const [models, account] = modelSteps({
      models: [model('wan', 'apple-gpu'), model('ltx', 'apple-gpu', true)],
      hf,
    });
    expect(models).toMatchObject({ status: 'skipped', command: 'hildegard choir join' });
    expect(account).toMatchObject({ status: 'skipped', detail: 'Not linked; no model here needs it.' });
  });

  it('asks for no Hugging Face account while takes render on a paired device', async () => {
    const { modelSteps } = await import('../src/doctor.ts');
    const [, account] = modelSteps({ models: [model('ltx', null, true)], hf, choir: { use: 'gpu-a' } });
    expect(account).toMatchObject({ status: 'skipped' });
  });

  it('elsewhere, setup picks a model and a gated one needs the account', async () => {
    const { modelSteps } = await import('../src/doctor.ts');
    const [models, account] = modelSteps({ models: [model('wan', null), model('ltx', null, true)], hf });
    expect(models).toMatchObject({ status: 'needs-owner', command: 'hildegard setup --json' });
    expect(account).toMatchObject({ status: 'needs-owner', command: 'hildegard hf login' });
  });
});

describe('starting from Windows ssh', () => {
  it('hands WMI one cmd line that notes the entry, quotes every part and logs both streams', async () => {
    const { wmiLine } = await import('../src/commands.ts');
    const line = wmiLine(
      'D:\\Hildegard\\app\\hildegard.mjs',
      ['D:\\Hildegard\\app\\hildegard.mjs', 'start', '--foreground', '--port', '7341'],
      'D:\\Hildegard\\logs\\server.log',
    );
    expect(line).toBe(
      `cmd.exe /d /s /c "set "HILDEGARD_ENTRY=D:\\Hildegard\\app\\hildegard.mjs" && "${process.execPath}" "D:\\Hildegard\\app\\hildegard.mjs" "start" "--foreground" "--port" "7341" >> "D:\\Hildegard\\logs\\server.log" 2>&1"`,
    );
  });
});

describe('a foreground start that fails', () => {
  it('reports in JSON like any error, names the busy port, and exits instead of idling', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-fg-'));
    const busy = createServer().listen(0, '127.0.0.1');
    await once(busy, 'listening');
    const port = (busy.address() as AddressInfo).port;
    try {
      const t = Date.now();
      const out = await hildegard(
        home,
        'start',
        '--foreground',
        '--port',
        String(port),
        '--data',
        join(home, 'data'),
      );
      expect(out).toMatchObject({
        ok: false,
        message: `Port ${port} is in use. Is Hildegard already running? Try --port.`,
      });
      expect(Date.now() - t).toBeLessThan(30_000);
    } finally {
      busy.close();
    }
  }, 60_000);
});
