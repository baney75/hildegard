// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, parseArgs, type Running, startServer } from '@hildegard/server';
import { afterEach, describe, expect, it } from 'vitest';
import { codeOnlyRefusal, scrub } from '../src/pair.ts';
import { cliEnv, hildegard, hildegardWithStdin, main, type Out, run } from './harness.ts';

const posix = process.platform !== 'win32';
const CODE = /hgc1_[A-Za-z0-9_-]{10,}/;
/** A real code: the prefix and base64 of {"n":… (others’ command lines may mention “hgc1_” in prose, e.g. this file). */
const REAL_CODE = /hgc1_eyJ[A-Za-z0-9_-]{20,}/;

/** Every command line that exists while it runs, so a code in anyone's arguments can't go unseen. */
function watchCommandLines() {
  const seen = new Set<string>();
  const look = () => {
    if (process.platform === 'linux') {
      for (const pid of readdirSync('/proc'))
        if (/^\d+$/.test(pid))
          try {
            seen.add(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '));
          } catch {}
    } else {
      try {
        for (const line of execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' }).split('\n'))
          seen.add(line);
      } catch {}
    }
  };
  const timer = setInterval(look, process.platform === 'linux' ? 4 : 25);
  return {
    seen,
    stop() {
      clearInterval(timer);
      look();
    },
  };
}

/** Every file under these folders that holds `needle`. */
function filesWith(needle: string, folders: string[], except: string[] = []) {
  const found: string[] = [];
  const walk = (p: string) => {
    if (except.includes(p)) return;
    const s = statSync(p);
    if (s.isDirectory()) {
      for (const n of readdirSync(p)) walk(join(p, n));
      return;
    }
    if (s.size < 8_000_000 && readFileSync(p).includes(needle)) found.push(p);
  };
  folders.forEach(walk);
  return found;
}

const servers: Running[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/**
 * Two fake devices: `gpu` shares its fake GPU, `plain` has none. Both run in this process, each with its own
 * folder; a stand-in `ssh` runs "the other device's" command line in a shell that knows only that device, with
 * `hildegard` where the installer puts it (~/.local/bin) and not on PATH, so the lookup is the real one.
 */
async function rig() {
  const gpuData = mkdtempSync(join(tmpdir(), 'hg-pair-gpu-'));
  const plainData = mkdtempSync(join(tmpdir(), 'hg-pair-plain-'));
  const gpu = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', gpuData]), port: 0 },
    { fakeTickMs: 20, secrets: fileStore(join(gpuData, 'secret.json')) },
  );
  const plain = await startServer(
    { ...parseArgs(['--data', plainData]), port: 0 },
    {
      secrets: fileStore(join(plainData, 'secret.json')),
      choirSecrets: () => fileStore(join(plainData, 'choir-secret.json')),
    },
  );
  servers.push(gpu, plain);
  const home = mkdtempSync(join(tmpdir(), 'hg-pair-home-'));
  const stubs = mkdtempSync(join(tmpdir(), 'hg-pair-stubs-'));
  const log = join(stubs, 'ssh-argv.log');
  const ssh = join(stubs, 'ssh');
  writeFileSync(
    ssh,
    `#!/bin/sh
printf '%s\\n' "$@" >> "$STUB_LOG"
case "$STUB_MODE" in
  unreachable) echo "ssh: connect to host gpu-box port 22: Connection refused" >&2; exit 255 ;;
  leak) echo "it broke: hgc1""_abcdefghijklmnopqrstuvwx and HG-ABCD""-EFGH" >&2; exit 1 ;;
  tailscale) echo "Sharing needs Tailscale." >&2; exit 2 ;;
  big) IFS= read -r c; m='"m"'; i=0; while [ $i -lt 15 ]; do m="$m,$m"; i=$((i+1)); done; printf '{"ok":true,"message":"Joined.","steps":[],"device":{"name":"gpu-here","models":[%s]}}' "$m"; exit 0 ;;
  reflect) IFS= read -r c; printf '{"ok":false,"message":"%s","steps":[{"id":"%s","title":"%s","status":"failed","detail":"x"}],"device":{"name":"%s","models":["%s"]},"choir":{"%s":"%s"}}' "$c" "$c" "$c" "$c" "$c" "$c" "$c"; exit 1 ;;
esac
for last; do :; done
HOME="$STUB_REMOTE_HOME" PATH="/usr/bin:/bin" exec sh -c "$last"
`,
  );
  chmodSync(ssh, 0o755);
  /** `hildegard` as the installer leaves it for one device: a launcher in ~/.local/bin. */
  const install = (remoteHome: string, server: Running, data: string) => {
    mkdirSync(join(remoteHome, '.local', 'bin'), { recursive: true });
    const launcher = join(remoteHome, '.local', 'bin', 'hildegard');
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@" --port ${new URL(server.url).port} --data "${data}"\n`,
    );
    chmodSync(launcher, 0o755);
  };
  const gpuHome = mkdtempSync(join(tmpdir(), 'hg-pair-gpuhome-'));
  const plainHome = mkdtempSync(join(tmpdir(), 'hg-pair-plainhome-'));
  install(gpuHome, gpu, gpuData);
  install(plainHome, plain, plainData);
  const at = (server: Running, data: string) => ['--port', new URL(server.url).port, '--data', data];
  /** `hildegard choir pair …` on the device named by `server`, with the stand-in ssh, its output kept whole. */
  const pair = async (
    server: Running,
    data: string,
    remoteHome: string,
    args: string[],
    mode = '',
  ): Promise<{ out: Out; stdout: string; stderr: string; env: Record<string, string> }> => {
    const env = {
      ...cliEnv(home),
      HILDEGARD_SSH: ssh,
      STUB_LOG: log,
      STUB_MODE: mode,
      STUB_REMOTE_HOME: remoteHome,
    } as Record<string, string>;
    const r = await run(process.execPath, [main, 'choir', 'pair', ...args, '--json', ...at(server, data)], {
      env,
      timeout: 90_000,
    }).catch((e: { stdout: string; stderr: string }) => e);
    return { out: JSON.parse(r.stdout) as Out, stdout: r.stdout, stderr: r.stderr, env };
  };
  return { gpu, plain, gpuData, plainData, gpuHome, plainHome, home, stubs, log, at, pair };
}

describe('pairing without anyone seeing the join code', () => {
  it('invite --code-only refuses on a terminal, and prints only the code into a pipe', async () => {
    const out = (kind: 'fifo' | 'socket' | 'tty' | 'file') => ({
      isFIFO: () => kind === 'fifo',
      isSocket: () => kind === 'socket',
      isCharacterDevice: () => kind === 'tty',
    });
    expect(codeOnlyRefusal(out('tty'))).toMatch(/screen/);
    expect(codeOnlyRefusal(out('file'))).toMatch(/to a file/);
    expect(codeOnlyRefusal(out('fifo'))).toBeNull();
    expect(codeOnlyRefusal(out('socket'))).toBeNull();

    const r = await rig();
    const gpuArgs = [...r.at(r.gpu, r.gpuData), '--url', r.gpu.url];
    const piped = await run(process.execPath, [main, 'choir', 'invite', '--code-only', ...gpuArgs], {
      env: cliEnv(r.home),
    });
    // The code and a newline: no sentences, no JSON.
    expect(piped.stdout).toMatch(/^hgc1_[A-Za-z0-9_-]{20,}\n$/);
    expect(piped.stderr).toBe('');
    // --json changes nothing: the code is still not wrapped in anything.
    const json = await run(process.execPath, [main, 'choir', 'invite', '--code-only', '--json', ...gpuArgs], {
      env: cliEnv(r.home),
    });
    expect(json.stdout).toMatch(/^hgc1_[A-Za-z0-9_-]{20,}\n$/);

    // Redirected to a file, it refuses: the file stays empty and no key is made.
    const before = r.gpu.choir.state().sharing;
    const file = join(r.home, 'code.txt');
    const fd = openSync(file, 'w');
    const status = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [main, 'choir', 'invite', '--code-only', ...gpuArgs], {
        env: cliEnv(r.home),
        stdio: ['ignore', fd, 'pipe'],
      });
      child.on('close', done);
    });
    closeSync(fd);
    expect(status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('');
    expect(r.gpu.choir.state().sharing).toEqual(before);

    // And that is what `join --code-stdin` takes.
    const joined = await hildegardWithStdin(
      r.home,
      piped.stdout,
      'choir',
      'join',
      '--code-stdin',
      ...r.at(r.plain, r.plainData),
    );
    expect(joined.ok, joined.message).toBe(true);
    expect(JSON.stringify(joined)).not.toMatch(CODE);

    // On a terminal (a pty from python3) it prints nothing but the reason, and makes no key.
    if (posix) {
      const before = r.gpu.choir.state().sharing.on;
      const tty = await run(
        'python3',
        [
          '-c',
          [
            'import os, pty, sys',
            'chunks = []',
            'def read(fd):',
            '    d = os.read(fd, 4096)',
            '    chunks.append(d)',
            '    return d',
            'status = pty.spawn(sys.argv[1:], read)',
            'sys.stdout.buffer.write(b"".join(chunks))',
            'sys.exit(os.waitstatus_to_exitcode(status))',
          ].join('\n'),
          process.execPath,
          main,
          'choir',
          'invite',
          '--code-only',
          ...r.at(r.gpu, r.gpuData),
          '--url',
          r.gpu.url,
        ],
        { env: { ...cliEnv(r.home), PATH: process.env.PATH ?? '' }, timeout: 60_000 },
      ).catch((e: { stdout: string; code: number }) => e);
      expect((tty as { code?: number }).code).toBe(1);
      expect(tty.stdout).toMatch(/pipe/i);
      expect(tty.stdout).not.toMatch(CODE);
      expect(r.gpu.choir.state().sharing.on).toBe(before);
    }
  }, 120_000);

  it.skipIf(!posix)(
    'pair joins the other device’s GPU, and the code is in no argument, output or file',
    async () => {
      const r = await rig();
      // A control: the watcher does see a code in someone’s arguments.
      const watch = watchCommandLines();
      const control = spawn(process.execPath, [
        '-e',
        'setTimeout(() => {}, 600)',
        'hgc1_eyJuIjoiY29udHJvbCJ9control_visible_arg',
      ]);
      await new Promise((resolve) => control.once('close', resolve));

      const { out, stdout, stderr, env } = await r.pair(r.plain, r.plainData, r.gpuHome, [
        'gpu-box',
        '--url',
        r.gpu.url,
        '--name',
        'gpu-box',
      ]);
      watch.stop();
      expect(out.ok, out.message).toBe(true);
      expect(out.steps.map((s) => s.id)).toEqual(['invite', 'join']);
      // The joined device and what it renders with.
      expect(out).toMatchObject({ device: { name: 'gpu-box', online: true } });
      expect(out.message).toMatch(/gpu-box/);
      expect(r.plain.choir.state().devices).toMatchObject([{ name: 'gpu-box', online: true }]);
      const list = await hildegard(r.home, 'choir', 'list', ...r.at(r.plain, r.plainData));
      expect(list.choir).toMatchObject({ devices: [{ name: 'gpu-box', online: true }] });

      const token = readFileSync(join(r.plainData, 'choir-secret.json'), 'utf8').trim();
      expect(token.length).toBeGreaterThan(20);
      const log = readFileSync(r.log, 'utf8');
      // ssh was asked for the code-only invite, with the host after `--`, and the stand-in saw nothing secret.
      expect(log).toMatch(/^-T$/m);
      expect(log).toContain('--code-only');
      expect(log.split('\n').indexOf('--')).toBeLessThan(log.split('\n').indexOf('gpu-box'));
      const seen = [...watch.seen];
      expect(seen.some((l) => REAL_CODE.test(l) && l.includes('control_visible_arg'))).toBe(true);
      expect(seen.some((l) => l.includes('choir join --code-stdin') || l.includes('code-stdin'))).toBe(true);
      expect(
        seen.filter((l) => (REAL_CODE.test(l) && !l.includes('control_visible_arg')) || l.includes(token)),
      ).toEqual([]);
      for (const secret of ['hgc1_', token]) {
        expect(log).not.toContain(secret);
        expect(stdout + stderr).not.toContain(secret);
      }
      // No file on any device holds the code; only the joiner’s keychain file holds the key it was given.
      const folders = [r.home, r.plainData, r.gpuData, r.plainHome, r.gpuHome, r.stubs];
      expect(filesWith('hgc1_', folders)).toEqual([]);
      expect(filesWith(token, folders, [join(r.plainData, 'choir-secret.json')])).toEqual([]);
      expect(env.STUB_MODE).toBe('');
    },
    120_000,
  );

  it.skipIf(!posix)(
    'pair --to is the other way: this computer has the GPU and the host joins it',
    async () => {
      const r = await rig();
      const watch = watchCommandLines();
      const { out, stdout, stderr } = await r.pair(r.gpu, r.gpuData, r.plainHome, [
        '--to',
        'plain-box',
        '--url',
        r.gpu.url,
        '--name',
        'gpu-here',
      ]);
      watch.stop();
      expect(out.ok, out.message).toBe(true);
      expect(r.plain.choir.state().devices).toMatchObject([{ name: 'gpu-here', online: true }]);
      expect(readFileSync(r.log, 'utf8')).toContain('--code-stdin');
      expect(stdout + stderr + readFileSync(r.log, 'utf8')).not.toMatch(CODE);
      expect([...watch.seen].filter((l) => REAL_CODE.test(l))).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!posix)(
    'pair says what is wrong: ssh down, Hildegard missing there, Tailscale, a bad host, and never echoes a code',
    async () => {
      const r = await rig();
      const down = await r.pair(r.plain, r.plainData, r.gpuHome, ['gpu-box'], 'unreachable');
      expect(down.out.ok).toBe(false);
      expect(down.out.message).toMatch(/reach gpu-box over ssh/);
      expect(r.plain.choir.state().devices).toEqual([]);

      // Hildegard in none of the places ssh’s PATH or the installer would put it.
      const empty = mkdtempSync(join(tmpdir(), 'hg-pair-empty-'));
      const missing = await r.pair(r.plain, r.plainData, empty, ['gpu-box']);
      expect(missing.out.ok).toBe(false);
      expect(missing.out.message).toMatch(/isn’t installed on gpu-box, or isn’t on its PATH/);

      const tailscale = await r.pair(r.plain, r.plainData, r.gpuHome, ['gpu-box'], 'tailscale');
      expect(tailscale.out.needsOwner).toBe(true);
      expect(tailscale.out.steps[0]).toMatchObject({
        status: 'needs-owner',
        command: 'ssh -t gpu-box tailscale up',
      });

      // Anything shaped like a code in a remote error is taken out before it reaches the screen.
      const leak = await r.pair(r.plain, r.plainData, r.gpuHome, ['gpu-box'], 'leak');
      expect(leak.out.ok).toBe(false);
      expect(leak.stdout + leak.stderr).not.toMatch(CODE);
      expect(leak.stdout + leak.stderr).not.toContain('HG-ABCD-EFGH');
      expect(leak.stdout).toContain('[code hidden]');
      expect(scrub('x hgc1_abcDEF123_- y hg-abcd-efgh')).toBe('x [code hidden] y [code hidden]');

      // A join that answers with the code in any field (a title, an id, the device, the choir) shows none of it.
      const reflect = await r.pair(
        r.gpu,
        r.gpuData,
        r.plainHome,
        ['--to', 'plain-box', '--url', r.gpu.url],
        'reflect',
      );
      expect(reflect.out.ok).toBe(false);
      expect(reflect.stdout + reflect.stderr).not.toMatch(CODE);
      expect(reflect.stdout).toContain('[code hidden]');

      // A join whose answer is long (many devices, many models) still reads as joined, not as no answer.
      const big = await r.pair(
        r.gpu,
        r.gpuData,
        r.plainHome,
        ['--to', 'plain-box', '--url', r.gpu.url],
        'big',
      );
      expect(big.out.message).toBe('Joined.');
      expect(big.out.ok).toBe(true);
      expect((big.out as unknown as { models: string[] }).models.length).toBe(32768);

      // A host that ssh could read as an option is never passed to it.
      const before = readFileSync(r.log, 'utf8');
      const bad = await r.pair(r.plain, r.plainData, r.gpuHome, ['-oProxyCommand=touch /tmp/x']);
      expect(bad.out.ok).toBe(false);
      expect(bad.out.message).toMatch(/isn’t a host name/);
      expect(readFileSync(r.log, 'utf8')).toBe(before);
      expect((await r.pair(r.plain, r.plainData, r.gpuHome, [])).out.ok).toBe(false);
    },
    180_000,
  );
});
