// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The server profile (`hildegard install --server`): Hildegard as a service for a computer that serves the owner's
 * other devices. A user systemd unit on Linux, a LaunchAgent on macOS; neither needs sudo. It runs the same
 * `start --foreground` as the background start, and once it's written `hildegard start` starts Hildegard through it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { layout, type Step } from '@hildegard/runtime';
import type { Config } from '@hildegard/server';

export const UNIT = 'hildegard.service';
export const LABEL = 'io.github.baney75.hildegard';

/** Runs a service manager's command; tests pass their own. */
export type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string };
const sh: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

export interface Service {
  kind: 'systemd' | 'launchd';
  file: string;
}

/** Where this system keeps a user's service, or null where Hildegard has none (Windows). */
export function serviceFile(platform: NodeJS.Platform = process.platform, env = process.env): Service | null {
  const home = env.HOME || homedir();
  if (platform === 'linux')
    return {
      kind: 'systemd',
      file: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', UNIT),
    };
  if (platform === 'darwin')
    return { kind: 'launchd', file: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`) };
  return null;
}

/** What the server is started with, after its entry: the background start and the service run the same. */
export function serverArgs(c: Config): string[] {
  const args = ['start', '--foreground', '--port', String(c.port), '--data', c.dataDir];
  if (c.fake) args.push('--fake-gpu');
  if (c.host !== '127.0.0.1') args.push('--host', c.host);
  if (c.allowedHosts.length) args.push('--allow-host', c.allowedHosts.join(','));
  if (c.hostPort !== null) args.push('--host-port', String(c.hostPort));
  if (c.comfyExternal) args.push('--comfy', c.comfyUrl);
  return args;
}

/** The command line and environment a service runs: this Node.js, the `hildegard` entry, and the server's options. */
export function launch(c: Config, entry: string, env = process.env) {
  return {
    argv: [process.execPath, entry, ...serverArgs(c)],
    env: {
      ...(env.HILDEGARD_HOME ? { HILDEGARD_HOME: env.HILDEGARD_HOME } : {}),
      HILDEGARD_ENTRY: entry,
      // A service starts with almost no PATH; Tailscale, nvidia-smi and uv are found where they were at install.
      PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    } as Record<string, string>,
    log: join(layout(c.dataDir).logs, 'server.log'),
  };
}

// systemd reads `"…"` with C escapes, expands `%` specifiers everywhere and `$` variables in ExecStart.
const sq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const execStart = (argv: string[]) => `ExecStart=${argv.map((a) => sq(a).replace(/\$/g, '$$$$')).join(' ')}`;

/** The user systemd unit. */
export function unitFile(l: ReturnType<typeof launch>): string {
  return [
    '# Written by `hildegard install --server`. Run that again to rewrite it.',
    '[Unit]',
    'Description=Hildegard',
    '',
    '[Service]',
    'Type=simple',
    ...Object.entries(l.env).map(([k, v]) => `Environment=${sq(`${k}=${v}`)}`),
    execStart(l.argv),
    // `hildegard stop` exits cleanly and stays stopped; a crash starts it again.
    'Restart=on-failure',
    'RestartSec=5',
    // Only the server stops with the unit: an update it started finishes, and starts the new version through it.
    'KillMode=process',
    `StandardOutput=append:${l.log.replace(/%/g, '%%')}`,
    'StandardError=inherit',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const programArguments = (argv: string[]) =>
  [
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
  ].join('\n');

/** The macOS LaunchAgent. */
export function launchAgent(l: ReturnType<typeof launch>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by `hildegard install --server`. Run that again to rewrite it. -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LABEL}</string>`,
    programArguments(l.argv),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(l.env).flatMap(([k, v]) => [
      `    <key>${xml(k)}</key>`,
      `    <string>${xml(v)}</string>`,
    ]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // `hildegard stop` exits cleanly and stays stopped; a crash starts it again.
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    // An update the server started outlives it, as KillMode=process does for systemd.
    '  <key>AbandonProcessGroup</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(l.log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(l.log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The service written for this port and folder, if there is one: then `hildegard start` starts through it. */
export function managedService(c: Config, entry: string, svc = serviceFile()): Service | null {
  if (!svc || !existsSync(svc.file)) return null;
  const l = launch(c, entry);
  const line = svc.kind === 'systemd' ? execStart(l.argv) : programArguments(l.argv);
  return readFileSync(svc.file, 'utf8').includes(line) ? svc : null;
}

const uid = () => process.getuid?.() ?? 0;

/** Starts the service; false when its manager can't (no user systemd here), so the caller starts Hildegard itself. */
export function startService(svc: Service, run: Run = sh): boolean {
  if (svc.kind === 'systemd') return run('systemctl', ['--user', 'start', UNIT]).status === 0;
  // Loaded already, or loaded now (RunAtLoad starts it).
  if (run('launchctl', ['kickstart', `gui/${uid()}/${LABEL}`]).status === 0) return true;
  return run('launchctl', ['bootstrap', `gui/${uid()}`, svc.file]).status === 0;
}

/**
 * Writes the service for this port and folder and turns it on. Hildegard must not be running outside it (the unit
 * would find the port taken). Returns its steps: the service, and on Linux the owner's choice to keep it running after
 * they sign out.
 */
export function installService(
  c: Config,
  entry: string,
  {
    run = sh,
    svc = serviceFile(),
    user = userInfo().username,
  }: { run?: Run; svc?: Service | null; user?: string } = {},
): Step[] {
  const title = 'Start with this computer';
  if (!svc)
    return [
      {
        id: 'service',
        title,
        status: 'skipped',
        detail: 'There’s no service for Windows yet. Run `hildegard start` after you sign in.',
        command: 'hildegard start --json',
      },
    ];
  const l = launch(c, entry);
  mkdirSync(dirname(svc.file), { recursive: true });
  mkdirSync(dirname(l.log), { recursive: true });
  writeFileSync(svc.file, svc.kind === 'systemd' ? unitFile(l) : launchAgent(l), { mode: 0o644 });

  if (svc.kind === 'launchd') {
    // A copy loaded before is replaced by this one.
    run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
    return run('launchctl', ['bootstrap', `gui/${uid()}`, svc.file]).status === 0
      ? [{ id: 'service', title, status: 'done', detail: `Starts when you sign in: ${svc.file}.` }]
      : [
          {
            id: 'service',
            title,
            status: 'skipped',
            detail: `Wrote ${svc.file}, but launchctl couldn’t load it here. It loads when you next sign in, or with the command.`,
            command: `launchctl bootstrap gui/$(id -u) ${JSON.stringify(svc.file)}`,
          },
        ];
  }

  const enable = `systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}`;
  if (run('systemctl', ['--user', 'show-environment']).status !== 0)
    return [
      {
        id: 'service',
        title,
        status: 'skipped',
        detail: `Wrote ${svc.file}, but systemd isn’t running for your user here, so nothing starts it yet. Hildegard starts now without it; once your user systemd runs, turn the service on with the command.`,
        command: enable,
      },
    ];
  run('systemctl', ['--user', 'daemon-reload']);
  if (run('systemctl', ['--user', 'enable', '--now', UNIT]).status !== 0)
    return [
      {
        id: 'service',
        title,
        status: 'failed',
        detail: `Wrote ${svc.file}, but systemd couldn’t start it. Its log is ${l.log}; \`systemctl --user status ${UNIT}\` says why.`,
        command: enable,
      },
    ];
  const steps: Step[] = [
    { id: 'service', title, status: 'done', detail: `Starts when you sign in: ${svc.file}.` },
  ];
  // A user's services stop when they sign out unless the user lingers. Changing that is the owner's call.
  const linger = run('loginctl', ['show-user', user, '--property=Linger', '--value']);
  if (linger.status === 0 && linger.stdout.trim() === 'no')
    steps.push({
      id: 'linger',
      title: 'Keep serving after you sign out',
      status: 'needs-owner',
      detail:
        'Hildegard stops when you sign out and starts again only when you sign in. To keep it serving and start it at boot, run the command; it changes this computer’s login settings, so it’s yours to choose.',
      command: `loginctl enable-linger ${user}`,
    });
  return steps;
}

/** Doctor's step for the service, when one was written: whether it's what runs Hildegard now. */
export function serviceStep(c: Config, entry: string, { run = sh, svc = serviceFile() } = {}): Step | null {
  if (!svc || !existsSync(svc.file)) return null;
  const title = 'Start with this computer';
  if (!managedService(c, entry, svc))
    return {
      id: 'service',
      title,
      status: 'skipped',
      detail: `${svc.file} starts a Hildegard with another port or folder. To have it start this one, run the command.`,
      command: 'hildegard install --yes --server --json',
    };
  const active =
    svc.kind === 'systemd'
      ? run('systemctl', ['--user', 'is-active', UNIT]).stdout.trim() === 'active'
      : run('launchctl', ['print', `gui/${uid()}/${LABEL}`]).status === 0;
  return active
    ? { id: 'service', title, status: 'done', detail: `Runs from ${svc.file}.` }
    : {
        id: 'service',
        title,
        status: 'failed',
        detail: `${svc.file} isn’t what runs Hildegard now, so it won’t come back by itself after a crash or a restart. Restart Hildegard through it with the command.`,
        command: 'hildegard restart --json',
      };
}
