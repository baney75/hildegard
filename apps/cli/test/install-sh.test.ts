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
/** A fake app: logs each command; `install` fails when told to. */
const fakeApp = (version: string, installFails: boolean) =>
  [
    `echo "${version} $1" >> "$HG_LOG"`,
    `if [ "$1" = install ]; then ${installFails ? 'echo "PyTorch download timed out" >&2; exit 3' : 'exit 0'}; fi`,
    'exit 0',
  ].join('\n');

function world(opts: { installFails: boolean; newNode: boolean }) {
  const t = mkdtempSync(join(tmpdir(), 'hg-install-sh-'));
  const home = join(t, 'home');
  const bin = join(t, 'bin');
  const rel = join(t, 'rel');
  const dist = join(t, 'dist');
  const log = join(t, 'log');
  mkdirSync(rel, { recursive: true });
  // What's installed now: Hildegard 0.1.5 on Node 1.2.2.
  mkdirSync(join(home, 'node', 'bin'), { recursive: true });
  writeFileSync(join(home, 'node', 'bin', 'node'), fakeNode('1.2.2'));
  chmodSync(join(home, 'node', 'bin', 'node'), 0o755);
  mkdirSync(join(home, 'app-0.1.5'), { recursive: true });
  writeFileSync(join(home, 'app-0.1.5', 'hildegard.mjs'), '');
  writeFileSync(join(home, 'app-0.1.5', 'fake.sh'), fakeApp('0.1.5', false));
  spawnSync('ln', ['-s', 'app-0.1.5', join(home, 'app')]);
  // The release: Hildegard 9.9.9, and Node 1.2.3 when this update brings a new one.
  const appSrc = join(t, 'src', 'hildegard-9.9.9');
  mkdirSync(appSrc, { recursive: true });
  writeFileSync(join(appSrc, 'hildegard.mjs'), '');
  writeFileSync(join(appSrc, 'fake.sh'), fakeApp('9.9.9', opts.installFails));
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
  const run = () =>
    spawnSync('sh', [file], {
      encoding: 'utf8',
      input: 'echo this line must never run\n',
      env: {
        PATH: process.env.PATH,
        HOME: t,
        HILDEGARD_HOME: home,
        XDG_BIN_HOME: bin,
        HILDEGARD_RELEASE_URL: `file://${rel}`,
        HILDEGARD_NODE_URL: `file://${dist}`,
        HG_LOG: log,
      },
    });
  const said = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const nodeVersion = () =>
    spawnSync(join(home, 'node', 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim();
  return { home, run, said, nodeVersion };
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
    expect(w.said()).toEqual(['9.9.9 install', '9.9.9 stop', '0.1.5 start']);
    const last = r.stderr.trim().split('\n').at(-1);
    expect(last).toMatch(/setting up 9\.9\.9 failed \(exit 3\), so 0\.1\.5 runs again/);
    expect(r.stderr).toContain('PyTorch download timed out');
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
    expect(w.said()).toEqual(['9.9.9 install']);
  });

  it('changes nothing it can’t put back when a download is refused', () => {
    const w = world({ installFails: false, newNode: false });
    // A release whose file doesn't match its checksum.
    const rel = join(w.home, '..', 'rel');
    writeFileSync(join(rel, `hildegard-9.9.9-${target}.tar.gz`), 'not the release');
    const r = w.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/didn't match its checksum/);
    expect(readlinkSync(join(w.home, 'app'))).toBe('app-0.1.5');
    expect(w.nodeVersion()).toBe('v1.2.2');
    expect(w.said()).toEqual([]);
  });
});
