// SPDX-License-Identifier: AGPL-3.0-only
// The server profile: the service `install --server` writes, how it's turned on, and doctor's serving steps. Service
// managers are test doubles; one test starts the unit's own command line and waits for /api/health.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceCapabilities, Snapshot } from '@hildegard/presets';
import { parseArgs } from '@hildegard/server';
import { afterEach, describe, expect, it } from 'vitest';
import { serveSteps } from '../src/doctor.ts';
import {
  installService,
  LABEL,
  launch,
  launchAgent,
  managedService,
  type Run,
  serviceFile,
  serviceStep,
  UNIT,
  unitFile,
} from '../src/service.ts';

const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function config(port = 7341, extra: string[] = []) {
  const data = mkdtempSync(join(tmpdir(), 'hg-server-data-'));
  return parseArgs(['--port', String(port), '--data', data, ...extra], {});
}

/** A service manager that answers each command from a table and keeps what it was asked. */
function manager(answers: Record<string, { status: number; stdout?: string }> = {}) {
  const asked: string[] = [];
  const run: Run = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    asked.push(line);
    const hit = Object.entries(answers).find(([k]) => line.startsWith(k));
    return { status: hit ? hit[1].status : 0, stdout: hit?.[1].stdout ?? '' };
  };
  return { run, asked };
}

const home = () => mkdtempSync(join(tmpdir(), 'hg-server-home-'));

/** systemd's `"…"` words, unescaped as systemd reads them. */
const words = (line: string) =>
  [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1]!.replace(/\\(.)/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$'),
  );

describe('the user systemd unit', () => {
  it('runs this Node.js and hildegard’s `start --foreground` for this port and folder', () => {
    const c = config(7351, ['--fake-gpu']);
    const u = unitFile(launch(c, entry, { PATH: '/usr/bin', HILDEGARD_HOME: '/h' }));
    const exec = u.split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(words(exec)).toEqual([
      process.execPath,
      entry,
      'start',
      '--foreground',
      '--port',
      '7351',
      '--data',
      c.dataDir,
      '--fake-gpu',
    ]);
    // Each value as systemd reads it back, backslashes in a Windows-style path included.
    const env = u
      .split('\n')
      .filter((l) => l.startsWith('Environment='))
      .map((l) => words(l));
    expect(env).toEqual([['HILDEGARD_HOME=/h'], [`HILDEGARD_ENTRY=${entry}`], ['PATH=/usr/bin']]);
    // A clean `hildegard stop` stays stopped; a crash comes back; an update the server started survives it.
    expect(u).toMatch(/^Restart=on-failure$/m);
    expect(u).toMatch(/^KillMode=process$/m);
    expect(u).toContain(`StandardOutput=append:${join(c.dataDir, 'logs', 'server.log')}`);
    expect(u).toMatch(/^WantedBy=default\.target$/m);
  });

  it('keeps quotes, % and $ in a path as they are', () => {
    const c = parseArgs(['--port', '7341', '--data', '/srv/a "b" 100%/$HOME'], {});
    const exec = unitFile(launch(c, entry, {}))
      .split('\n')
      .find((l) => l.startsWith('ExecStart='))!;
    expect(exec).toContain('"/srv/a \\"b\\" 100%%/$$HOME"');
    expect(words(exec)).toContain('/srv/a "b" 100%/$HOME');
  });

  it('doubles backslashes, so a path with them reaches the server whole', () => {
    const u = unitFile(launch(parseArgs(['--port', '7341', '--data', 'C:\\data'], {}), 'D:\\a\\main.ts', {}));
    expect(u).toContain('Environment="HILDEGARD_ENTRY=D:\\\\a\\\\main.ts"');
    const exec = u.split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(exec).toContain('"C:\\\\data"');
    expect(words(exec)).toContain('C:\\data');
  });
});

describe('the macOS LaunchAgent', () => {
  it('runs the same command, starts at sign-in, and lets an update outlive the server', () => {
    const c = parseArgs(['--port', '7341', '--data', '/Users/me/R&D'], {});
    const p = launchAgent(launch(c, entry, { PATH: '/usr/bin' }));
    expect(p).toContain(`<string>${LABEL}</string>`);
    const block = p.split('<key>ProgramArguments</key>')[1]!.split('</array>')[0]!;
    const args = [...block.matchAll(/<string>(.*)<\/string>/g)].map((m) => m[1]);
    expect(args).toEqual([
      process.execPath,
      entry,
      'start',
      '--foreground',
      '--port',
      '7341',
      '--data',
      '/Users/me/R&amp;D',
    ]);
    expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(p).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(p).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    expect(p).toContain('<key>HILDEGARD_ENTRY</key>');
  });
});

describe('turning the service on', () => {
  it('writes the unit, enables it, and asks the owner about lingering', () => {
    const c = config();
    const svc = serviceFile('linux', { HOME: home() })!;
    const m = manager({ 'loginctl show-user': { status: 0, stdout: 'no\n' } });
    const steps = installService(c, entry, { run: m.run, svc, user: 'luke' });
    expect(svc.file).toMatch(/\.config\/systemd\/user\/hildegard\.service$/);
    expect(readFileSync(svc.file, 'utf8')).toContain('"start" "--foreground"');
    expect(m.asked).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${UNIT}`,
      'loginctl show-user luke --property=Linger --value',
    ]);
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ['service', 'done'],
      ['linger', 'needs-owner'],
    ]);
    expect(steps[1]!.command).toBe('loginctl enable-linger luke');
    // Lingering already: nothing to ask.
    const on = manager({ 'loginctl show-user': { status: 0, stdout: 'yes\n' } });
    expect(installService(c, entry, { run: on.run, svc, user: 'luke' }).map((s) => s.id)).toEqual([
      'service',
    ]);
  });

  it('leaves the unit in place and says how to turn it on where user systemd isn’t running', () => {
    const c = config();
    const svc = serviceFile('linux', { HOME: home() })!;
    const m = manager({ 'systemctl --user show-environment': { status: 1 } });
    const [step] = installService(c, entry, { run: m.run, svc });
    expect(existsSync(svc.file)).toBe(true);
    expect(step).toMatchObject({
      id: 'service',
      status: 'skipped',
      command: `systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}`,
    });
    expect(m.asked).toEqual(['systemctl --user show-environment']);
  });

  it('fails with the fix when systemd won’t start it', () => {
    const svc = serviceFile('linux', { HOME: home() })!;
    const m = manager({ 'systemctl --user enable': { status: 1 } });
    const [step] = installService(config(), entry, { run: m.run, svc });
    expect(step).toMatchObject({ id: 'service', status: 'failed' });
    expect(step!.command).toContain('enable --now');
  });

  it('loads the LaunchAgent on macOS, replacing one loaded before', () => {
    const svc = serviceFile('darwin', { HOME: home() })!;
    expect(svc.file).toMatch(/Library\/LaunchAgents\/io\.github\.baney75\.hildegard\.plist$/);
    const m = manager();
    const [step] = installService(config(), entry, { run: m.run, svc });
    expect(step).toMatchObject({ id: 'service', status: 'done' });
    expect(m.asked.map((a) => a.split(' ').slice(0, 2).join(' '))).toEqual([
      'launchctl bootout',
      'launchctl bootstrap',
    ]);
    expect(readFileSync(svc.file, 'utf8')).toContain('<string>--foreground</string>');
  });

  it('says there’s none on Windows', () => {
    expect(installService(config(), entry, { svc: null })).toMatchObject([
      { id: 'service', status: 'skipped' },
    ]);
  });
});

describe('which Hildegard the service runs', () => {
  it('is this one only for the same port and folder', () => {
    const c = config(7361);
    const svc = serviceFile('linux', { HOME: home() })!;
    installService(c, entry, { run: manager().run, svc });
    expect(managedService(c, entry, svc)).toEqual(svc);
    expect(managedService({ ...c, port: 7363 }, entry, svc)).toBeNull();
    expect(managedService({ ...c, dataDir: '/elsewhere' }, entry, svc)).toBeNull();
  });

  it('doctor: done when it runs Hildegard, the fix when it doesn’t, nothing when there is none', () => {
    const c = config(7365);
    const svc = serviceFile('linux', { HOME: home() })!;
    expect(serviceStep(c, entry, { svc })).toBeNull();
    installService(c, entry, { run: manager().run, svc });
    const active = manager({ 'systemctl --user is-active': { status: 0, stdout: 'active\n' } });
    expect(serviceStep(c, entry, { run: active.run, svc })).toMatchObject({ id: 'service', status: 'done' });
    const dead = manager({ 'systemctl --user is-active': { status: 3, stdout: 'inactive\n' } });
    expect(serviceStep(c, entry, { run: dead.run, svc })).toMatchObject({
      id: 'service',
      status: 'failed',
      command: 'hildegard restart --json',
    });
    expect(serviceStep({ ...c, port: 7367 }, entry, { run: active.run, svc })).toMatchObject({
      status: 'skipped',
      command: 'hildegard install --yes --server --json',
    });
  });
});

describe('the unit’s own command line', () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    child?.kill('SIGTERM');
    child = null;
  });

  it('starts a Hildegard that answers /api/health, as systemd would run it', async () => {
    const port = 7600 + Math.floor(Math.random() * 300);
    const c = config(port, ['--fake-gpu']);
    const h = home();
    const svc = serviceFile('linux', { HOME: h })!;
    // `enable --now` starts what the unit says, with only the unit's environment beside the user manager's own.
    const run: Run = (cmd, args) => {
      if (cmd === 'systemctl' && args.includes('enable')) {
        const unit = readFileSync(svc.file, 'utf8').split('\n');
        const argv = words(unit.find((l) => l.startsWith('ExecStart='))!);
        const env = Object.fromEntries(
          unit
            .filter((l) => l.startsWith('Environment='))
            .map((l) => words(l)[0]!.split(/=(.*)/s).slice(0, 2) as [string, string]),
        );
        mkdirSync(join(c.dataDir, 'logs'), { recursive: true });
        child = spawn(argv[0]!, argv.slice(1), {
          env: { HOME: h, HILDEGARD_SECRETS: 'file', ...env },
          stdio: 'ignore',
        });
      }
      return { status: 0, stdout: '' };
    };
    expect(installService(c, entry, { run, svc, user: 'x' })[0]).toMatchObject({ status: 'done' });
    let health: { version?: string } | null = null;
    for (let i = 0; i < 120 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${port}/api/health`)
        .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
        .catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 250));
    }
    expect(health?.version).toBeTruthy();
  }, 60_000);
});

describe('doctor’s serving steps', () => {
  const caps = (over: Partial<DeviceCapabilities> = {}): DeviceCapabilities => ({
    mic: false,
    speaker: false,
    stt: ['whisper-small'],
    tts: ['kokoro-82m'],
    llm: [{ runtime: 'ollama', model: 'qwen3:8b', vramGb: null }],
    gpu: null,
    compute: 'interactive',
    ...over,
  });
  const sharing = (over: Partial<Snapshot['choir']['sharing']> = {}): Snapshot['choir']['sharing'] => ({
    on: true,
    url: 'http://parish1.tail.ts.net:7341',
    paired: 1,
    problem: null,
    opportunistic: false,
    busyCheck: null,
    busy: null,
    seesOwner: null,
    ...over,
  });
  const byId = (steps: ReturnType<typeof serveSteps>) => Object.fromEntries(steps.map((s) => [s.id, s]));

  it('passes voice, the language model and the listener when the server says they’re there', () => {
    const s = byId(serveSteps({ capabilities: caps(), sharing: sharing() }, { server: true, speech: true }));
    expect(s.voice).toMatchObject({ status: 'done', detail: expect.stringContaining('whisper-small') });
    expect(s.llm).toMatchObject({ status: 'done', detail: expect.stringContaining('qwen3:8b (ollama)') });
    expect(s.sharing).toMatchObject({
      status: 'done',
      detail: expect.stringContaining('parish1.tail.ts.net'),
    });
  });

  it('fails each on a server, with its fix', () => {
    const s = byId(
      serveSteps(
        { capabilities: caps({ stt: [], tts: [], llm: [] }), sharing: sharing({ on: false, url: null }) },
        { server: true, speech: false },
      ),
    );
    expect(s.voice).toMatchObject({
      status: 'failed',
      command: 'hildegard voice install --env speech --json',
    });
    expect(s.llm).toMatchObject({ status: 'failed', command: 'hildegard llm add <name> <address>' });
    expect(s.sharing).toMatchObject({ status: 'failed', command: 'hildegard choir invite' });
    // Installed but without a model: the fix is the Voice page.
    const server = { server: true, speech: true };
    const noModel = byId(serveSteps({ capabilities: caps({ tts: [] }), sharing: sharing() }, server));
    expect(noModel.voice).toMatchObject({ status: 'failed', command: 'hildegard open' });
    expect(noModel.voice!.detail).toMatch(/no speech model/);
    // A listener Tailscale can't reach is a fault anywhere.
    const down = byId(
      serveSteps(
        { capabilities: caps(), sharing: sharing({ problem: 'Tailscale is down.' }) },
        { server: false, speech: true },
      ),
    );
    expect(down.sharing).toMatchObject({ status: 'failed', command: 'tailscale up' });
  });

  it('only skips them on a computer that isn’t a server, and waits while the server hasn’t looked', () => {
    const s = serveSteps(
      { capabilities: caps({ stt: [], tts: [], llm: [] }), sharing: sharing({ on: false }) },
      { server: false, speech: false },
    );
    expect(s.map((x) => x.status)).toEqual(['skipped', 'skipped', 'skipped']);
    for (const x of s) expect(x.command).toBeTruthy();
    const early = serveSteps({ capabilities: null, sharing: sharing() }, { server: true, speech: true });
    expect(early.slice(0, 2).map((x) => [x.status, x.command])).toEqual([
      ['skipped', undefined],
      ['skipped', undefined],
    ]);
  });
});
