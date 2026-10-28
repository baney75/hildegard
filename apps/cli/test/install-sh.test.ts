// SPDX-License-Identifier: AGPL-3.0-only
// The real install.sh, run against a release and a Node.js made here: fake programs that log what they're asked to do.
// It checks what an update leaves behind when the new version's setup fails, and when it works.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const target = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** A fake `node`: prints its version, or runs the app's fake.sh with the command it was given. */
const fakeNode = (version: string) =>
  `#!/bin/sh\n[ "$1" = --version ] && { echo v${version}; exit 0; }\napp=$1\nshift\n. "$(dirname "$app")/fake.sh"\n`;
/** A fake app: logs each command, and installs with which bundle paths it was given; a command fails when told to. */
const fakeApp = (version: string, fails: string | null) =>
  [
    `if [ "$1" = install ]; then echo "${version} install resources=\${HILDEGARD_RESOURCES:-unset} presets=\${HILDEGARD_PRESETS_DIR:-unset} commit=\${HILDEGARD_COMMIT:-unset}" >> "$HG_LOG"; else echo "${version} $1" >> "$HG_LOG"; fi`,
    `if [ "$1" = "${fails ?? ''}" ]; then echo "PyTorch download timed out" >&2; exit 3; fi`,
    'exit 0',
  ].join('\n');
/** A fake `df` with plenty of room, so the free-space check passes on a runner with a small /tmp. */
const fakeDf =
  '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "fake 999999999 0 999999999 0% /"\n';

function world(opts: { installFails: boolean; newNode: boolean; oldStartFails?: boolean }) {
  const t = mkdtempSync(join(tmpdir(), 'hg-install-sh-'));
  const home = join(t, 'home');
  const bin = join(t, 'bin');
  const rel = join(t, 'rel');
  const dist = join(t, 'dist');
  const log = join(t, 'log');
  const tools = join(t, 'tools');
  mkdirSync(rel, { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'df'), fakeDf);
  chmodSync(join(tools, 'df'), 0o755);
  // What's installed now: Hildegard 0.1.5 on Node 1.2.2.
  mkdirSync(join(home, 'node', 'bin'), { recursive: true });
  writeFileSync(join(home, 'node', 'bin', 'node'), fakeNode('1.2.2'));
  chmodSync(join(home, 'node', 'bin', 'node'), 0o755);
  mkdirSync(join(home, 'app-0.1.5'), { recursive: true });
  writeFileSync(join(home, 'app-0.1.5', 'hildegard.mjs'), '');
  writeFileSync(join(home, 'app-0.1.5', 'fake.sh'), fakeApp('0.1.5', opts.oldStartFails ? 'start' : null));
  spawnSync('ln', ['-s', 'app-0.1.5', join(home, 'app')]);
  // Its hildegard command, as an earlier install.sh wrote it.
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'hildegard'),
    `#!/bin/sh\nexport HILDEGARD_HOME="${home}"\nexec "${home}/node/bin/node" "${home}/app/hildegard.mjs" "$@"\n`,
  );
  chmodSync(join(bin, 'hildegard'), 0o755);
  // The release: Hildegard 9.9.9, and Node 1.2.3 when this update brings a new one.
  const appSrc = join(t, 'src', 'hildegard-9.9.9');
  mkdirSync(appSrc, { recursive: true });
  writeFileSync(join(appSrc, 'hildegard.mjs'), '');
  writeFileSync(join(appSrc, 'fake.sh'), fakeApp('9.9.9', opts.installFails ? 'install' : null));
  const appTar = join(rel, `hildegard-9.9.9-${target}.tar.gz`);
  spawnSync('tar', ['-czf', appTar, '-C', join(t, 'src'), 'hildegard-9.9.9']);
  const node = opts.newNode ? '1.2.3' : '1.2.2';
  let nodeSha = '0'.repeat(64);
  if (opts.newNode) {
    const nodeSrc = join(t, 'nsrc', `node-v1.2.3-${target}`, 'bin');
    mkdirSync(nodeSrc, { recursive: true });
    writeFileSync(join(nodeSrc, 'node'), fakeNode('1.2.3'));
    chmodSync(join(nodeSrc, 'node'), 0o755);
    mkdirSync(join(dist, 'v1.2.3'), { recursive: true });
    const nodeTar = join(dist, 'v1.2.3', `node-v1.2.3-${target}.tar.gz`);
    spawnSync('tar', ['-czf', nodeTar, '-C', join(t, 'nsrc'), `node-v1.2.3-${target}`]);
    nodeSha = sha(nodeTar);
  }
  const key = target.replace('-', '_');
  const script = readFileSync(join(repo, 'install', 'install.sh'), 'utf8')
    .replaceAll('@VERSION@', '9.9.9')
    .replaceAll('@NODE@', node)
    .replaceAll(`@APP_SHA_${key}@`, sha(appTar))
    .replaceAll(`@NODE_SHA_${key}@`, nodeSha);
  const file = join(t, 'install.sh');
  writeFileSync(file, script);
  const run = (env: Record<string, string> = {}) =>
    spawnSync('sh', [file], {
      encoding: 'utf8',
      input: 'echo this line must never run\n',
      env: {
        PATH: `${tools}:${process.env.PATH}`,
        // What an older Hildegard updating itself passes on: its own bundle's paths.
        HILDEGARD_RESOURCES: join(home, 'app-0.1.5'),
        HILDEGARD_PRESETS_DIR: join(home, 'app-0.1.5', 'presets'),
        HILDEGARD_COMMIT: 'old',
        ...env,
        HOME: t,
        HILDEGARD_HOME: home,
        XDG_BIN_HOME: bin,
        HILDEGARD_RELEASE_URL: `file://${rel}`,
        HILDEGARD_NODE_URL: `file://${dist}`,
        HG_LOG: log,
        HILDEGARD_UPDATE_REPORT: join(t, 'report'),
      },
    });
  const said = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const nodeVersion = () =>
    spawnSync(join(home, 'node', 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim();
  const report = () => (existsSync(join(t, 'report')) ? readFileSync(join(t, 'report'), 'utf8') : null);
  return { home, bin, tools, run, said, nodeVersion, report };
}

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  it('goes back to the version it replaced, on its own Node.js, when the new one won’t set up', () => {
    const w = world({ installFails: true, newNode: true });
    const r = w.run();
    expect(r.status).toBe(3);
    expect(readlinkSync(join(w.home, 'app'))).toBe('app-0.1.5');
    // The new version stays, ready to try again; the old Node.js is back, and nothing is left half-moved.
    expect(existsSync(join(w.home, 'app-9.9.9', 'hildegard.mjs'))).toBe(true);
    expect(w.nodeVersion()).toBe('v1.2.2');
    expect(existsSync(join(w.home, 'node.prev'))).toBe(false);
    // Whatever the new version started is stopped before the old one starts.
    expect(w.said()).toEqual([
      '9.9.9 install resources=unset presets=unset commit=unset',
      '9.9.9 stop',
      '0.1.5 start',
    ]);
    // Retrying with `hildegard install` would set up 0.1.5 again, so the way back to 9.9.9 is `hildegard update`.
    const last = r.stderr.trim().split('\n').at(-1);
    expect(last).toBe(
      'hildegard: setting up 9.9.9 failed (exit 3), so 0.1.5 runs again. To try 9.9.9 again, run: hildegard update',
    );
    expect(r.stderr).toContain('PyTorch download timed out');
    // An updating Hildegard may not see stderr: the report has the version and the same last line.
    expect(w.report()).toBe(`9.9.9\n${last}\n`);
    expect(r.stderr).toContain('Hildegard 9.9.9 stays in');
  });

  it('keeps the new version and drops the old Node.js once setup works', () => {
    const w = world({ installFails: false, newNode: true });
    const r = w.run();
    expect(r.status).toBe(0);
    expect(readlinkSync(join(w.home, 'app'))).toBe('app-9.9.9');
    expect(w.nodeVersion()).toBe('v1.2.3');
    expect(existsSync(join(w.home, 'node.prev'))).toBe(false);
    // The one before it stays, for going back; setup never reads the rest of a piped script.
    expect(existsSync(join(w.home, 'app-0.1.5'))).toBe(true);
    // The old version's bundle paths never reach the new one.
    expect(w.said()).toEqual(['9.9.9 install resources=unset presets=unset commit=unset']);
  });

  it('says so when the version it went back to won’t start either', () => {
    const w = world({ installFails: true, newNode: false, oldStartFails: true });
    const r = w.run();
    expect(r.status).toBe(3);
    expect(readlinkSync(join(w.home, 'app'))).toBe('app-0.1.5');
    expect(r.stderr).not.toMatch(/runs again/);
    expect(r.stderr.trim().split('\n').at(-1)).toBe(
      'hildegard: setting up 9.9.9 failed (exit 3), and 0.1.5 didn’t start either. Run: hildegard doctor'.replace(
        '’',
        "'",
      ),
    );
  });

  it('goes back and starts the old version when something fails between switching and setup', () => {
    const w = world({ installFails: false, newNode: true });
    // chmod fails after the launcher is written: the link has moved to 9.9.9 by then.
    const chmod = join(w.home, '..', 'tools', 'chmod');
    writeFileSync(chmod, '#!/bin/sh\nexit 1\n');
    chmodSync(chmod, 0o755);
    const r = w.run();
    expect(r.status).not.toBe(0);
    expect(readlinkSync(join(w.home, 'app'))).toBe('app-0.1.5');
    expect(w.nodeVersion()).toBe('v1.2.2');
    expect(existsSync(join(w.home, 'node.prev'))).toBe(false);
    expect(r.stderr.trim().split('\n').at(-1)).toMatch(/^hildegard: .*so 0\.1\.5 runs again/);
  });

  it('says why it can’t run on another system', () => {
    const w = world({ installFails: false, newNode: false });
    writeFileSync(join(w.tools, 'uname'), '#!/bin/sh\necho FreeBSD\n');
    chmodSync(join(w.tools, 'uname'), 0o755);
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(
      'hildegard: this installer is for Linux and macOS. On Windows, use install.ps1.',
    );
  });

  it('refuses before downloading anything when the disk is short of room', () => {
    const w = world({ installFails: false, newNode: true });
    writeFileSync(
      join(w.home, '..', 'tools', 'df'),
      '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "fake 9999999 0 7340032 0% /"\n',
    );
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/needs at least 12 GB free .* has 7 GB/);
    expect(r.stderr.trim().split('\n').at(-1)).toBe(
      'hildegard: nothing was installed. Hildegard 0.1.5 is unchanged. To try 9.9.9 again, run: hildegard update',
    );
    expect(readlinkSync(join(w.home, 'app'))).toBe('app-0.1.5');
    expect(w.nodeVersion()).toBe('v1.2.2');
    expect(w.said()).toEqual([]);
  });

  it('changes nothing it can’t put back when a download is refused', () => {
    const w = world({ installFails: false, newNode: false });
    // A release whose file doesn't match its checksum.
    const rel = join(w.home, '..', 'rel');
    writeFileSync(join(rel, `hildegard-9.9.9-${target}.tar.gz`), 'not the release');
    const r = w.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/didn't match its checksum/);
    // Nothing moved or stopped, so the old version is as it was, and an update is how to try again.
    expect(r.stderr.trim().split('\n').at(-1)).toMatch(
      /^hildegard: hildegard-9\.9\.9-.*didn't match its checksum .* Nothing was installed\. Hildegard 0\.1\.5 is unchanged\. To try 9\.9\.9 again, run: hildegard update$/,
    );
    expect(readlinkSync(join(w.home, 'app'))).toBe('app-0.1.5');
    expect(w.nodeVersion()).toBe('v1.2.2');
    expect(w.said()).toEqual([]);
  });
});
