// SPDX-License-Identifier: AGPL-3.0-only
// What the CLI tests share: running `hildegard …` in an isolated home, and stopping every server a test started,
// whether the test passed, failed or timed out. Not a test file: the fixture that proves the cleanup imports it too.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rememberedPort } from '@hildegard/server';
import { afterAll, afterEach } from 'vitest';

// HILDEGARD_CLI tests an installed release's hildegard.mjs instead of the source.
export const main = process.env.HILDEGARD_CLI ?? fileURLToPath(new URL('../src/main.ts', import.meta.url));
export const run = promisify(execFile);

/** An OS-allocated free port, for the hosted listener (otherwise `port + 1` can collide with a parallel worker). */
export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

export const cliEnv = (home: string) => ({
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
export type Out = {
  ok: boolean;
  needsOwner: boolean;
  message: string;
  steps: { id: string; status: string; detail: string; command?: string }[];
  [k: string]: unknown;
};

type Touched = { home: string; data: string; port?: string };
/**
 * The homes and data folders (with the port, when a command named one) of every command a test ran. Many of them
 * (start, setup, open, models) can start a background server that outlives the command, and a test that fails or
 * times out never reaches its own `stop`.
 */
const touched = new Map<string, Touched>();
/** The same, never cleared: the last sweep, after all tests, covers anything an earlier one missed. */
const everTouched = new Map<string, Touched>();
/** Commands still running. A test that times out leaves its command going, and its server starts later. */
const inflight = new Set<{ child: ChildProcess; done: Promise<unknown> }>();
/** Set once the last sweep has run: a test body still going must not start a server nothing will sweep. */
let closed = false;

/**
 * Only a folder under the temp directory is ever swept (realpath both: macOS' /var is /private/var). The sweep finds
 * processes by pgrep on the folder's name, which for `/` or a home folder would match, and kill, far more than a test's.
 */
export function underTmp(data: string) {
  try {
    const at = relative(realpathSync(tmpdir()), realpathSync(data));
    return at !== '' && !at.startsWith('..') && !isAbsolute(at);
  } catch {
    return false;
  }
}

const flagValue = (args: string[], name: string) => {
  const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at < 0) return undefined;
  return args[at] === `--${name}` ? args[at + 1] : args[at]!.slice(name.length + 3);
};

function track(home: string, args: string[]) {
  if (closed) throw new Error('A CLI test is still running after all the tests ended.');
  const data = flagValue(args, 'data');
  if (!data) return;
  const key = `${home}\0${data}`;
  const port = flagValue(args, 'port') ?? touched.get(key)?.port;
  touched.set(key, { home, data, port });
  everTouched.set(key, { home, data, port });
}

/** Keeps a running command where the cleanup below can end it. */
function watch<T extends Promise<unknown> & { child: ChildProcess }>(p: T): T {
  const entry = { child: p.child, done: p.catch(() => {}) };
  inflight.add(entry);
  void entry.done.then(() => inflight.delete(entry));
  return p;
}

/**
 * Whatever is still running with this data folder in its command line: the background server (`… start --foreground
 * …`) and the ComfyUI and proxy it started. Not on Windows. pgrep narrows it first, since a desktop's whole process
 * list can outgrow a buffer, and -ww keeps BSD ps from cutting the command short without a terminal.
 */
async function leftOn(data: string) {
  if (process.platform === 'win32') return [];
  // The folder's name ends at a path boundary, so one folder (`…/h`) never matches another that starts with it (`…/hg-…`).
  const named = `${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|[[:space:]]|$)`;
  const found = await run('pgrep', ['-f', '--', named])
    .then((r) => r.stdout.split('\n').filter((l) => /^\d+$/.test(l.trim())))
    .catch((e: { code?: number }) => {
      if (e.code !== 1) console.warn('pgrep failed, so servers left on', data, 'are not swept:', e);
      return [];
    });
  if (!found.length) return [];
  const { stdout } = await run(
    'ps',
    ['-ww', '-o', 'pid=,command=', '-p', found.map((l) => l.trim()).join(',')],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  ).catch((e: { stdout?: string }) => {
    // ps exits 1 when some of the numbers have already gone; what it did list is still good.
    if (!e.stdout) console.warn('ps failed, so servers left on', data, 'are not swept:', e);
    return { stdout: e.stdout ?? '' };
  });
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && Number(m[1]) !== process.pid)
    .map((m) => ({ pid: Number(m[1]), server: m[2]!.includes('start --foreground') }));
}

const signal = (pid: number, server: boolean, sig: NodeJS.Signals) => {
  // The server starts detached, so it leads its own group.
  for (const target of server ? [-pid, pid] : [pid])
    try {
      process.kill(target, sig);
    } catch {}
};

/**
 * `hildegard stop` for each, then what is left on its folder: ended politely, then killed. A folder is stopped on the
 * port its server remembers (or the one the test named), never `stop`'s default: with neither, `stop --data` would
 * look for a server on 7341, which could be a real Hildegard.
 */
async function sweep(all: Touched[]) {
  const left = all.filter(({ data }) => {
    const ok = underTmp(data);
    if (!ok) console.warn('Not sweeping', data, ': it is not under the temp directory.');
    return ok;
  });
  const known = left.flatMap(({ home, data, port }) => {
    const at = rememberedPort(data) ?? port;
    return at ? [{ home, data, at }] : [];
  });
  await Promise.all(
    known.map(({ home, data, at }) =>
      run(process.execPath, [main, 'stop', '--data', data, '--port', String(at), '--json'], {
        env: cliEnv(home),
        timeout: 30_000,
      }).catch(() => {}),
    ),
  );
  const rest = (await Promise.all(left.map(({ data }) => leftOn(data)))).flat();
  for (const { pid, server } of rest) signal(pid, server, 'SIGTERM');
  if (!rest.length) return;
  await new Promise((r) => setTimeout(r, 2000));
  for (const { data } of left)
    for (const { pid, server } of await leftOn(data)) signal(pid, server, 'SIGKILL');
}

// Whatever a test started is stopped, passed or failed. A command a timed-out test left running is ended first, so
// it can't start a server after the sweep.
afterEach(async () => {
  const going = [...inflight];
  for (const { child } of going) child.kill('SIGKILL');
  await Promise.all(going.map((c) => c.done));
  const left = [...touched.values()];
  touched.clear();
  await sweep(left);
}, 60_000);

afterAll(async () => {
  closed = true;
  await sweep([...everTouched.values()]);
}, 60_000);

/** Runs `hildegard …` in its own home folder, so no real app config is ever touched. */
export async function hildegard(home: string, ...args: string[]) {
  track(home, args);
  const { stdout } = await watch(
    run(process.execPath, [main, ...args, '--json'], {
      env: cliEnv(home),
      timeout: 60_000,
    }),
  ).catch((e: { stdout: string }) => ({ stdout: e.stdout }));
  return JSON.parse(stdout) as Out;
}

/** The same, with more environment (test doubles for outside services). */
export async function hildegardEnv(home: string, env: Record<string, string>, ...args: string[]) {
  track(home, args);
  const { stdout } = await watch(
    run(process.execPath, [main, ...args, '--json'], {
      env: { ...cliEnv(home), ...env },
      timeout: 60_000,
    }),
  ).catch((e: { stdout: string }) => ({ stdout: e.stdout }));
  return JSON.parse(stdout) as Out;
}

/** The same, with something piped to its stdin, as an agent pipes a secret the owner gave it. */
export function hildegardWithStdin(home: string, input: string, ...args: string[]) {
  track(home, args);
  const child = spawn(process.execPath, [main, ...args, '--json'], { env: cliEnv(home) });
  const done = new Promise<Out>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(out) as Out);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(input);
  });
  const entry = { child, done: done.catch(() => {}) };
  inflight.add(entry);
  void entry.done.then(() => inflight.delete(entry));
  return done;
}
