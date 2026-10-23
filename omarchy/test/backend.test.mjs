// SPDX-License-Identifier: AGPL-3.0-only
// bin/hildegard-omarchy against a real Hildegard server on a stand-in GPU, with Omarchy's own commands and the
// hildegard command replaced by stubs that write down how they were called.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'omarchy/bin/hildegard-omarchy');
const tmp = mkdtempSync(join(tmpdir(), 'hildegard-omarchy-'));
const stubs = join(tmp, 'bin');
const calls = join(tmp, 'calls');
let port;
let server;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function stub(name, body = '') {
  writeFileSync(join(stubs, name), `#!/bin/bash\nprintf '%s\\n' "${name} $*" >>"${calls}"\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
}

const env = () => ({
  ...process.env,
  PATH: `${stubs}:/usr/bin:/bin`,
  HOME: tmp,
  XDG_BIN_HOME: join(tmp, 'nobin'),
  HILDEGARD_PORT: String(port),
});

async function run(...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(cli, args, { env: env() });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const logged = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}
const api = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hildegard': '1' },
    body: JSON.stringify(body),
  });

before(async () => {
  writeFileSync(join(tmp, '.keep'), '');
  rmSync(stubs, { recursive: true, force: true });
  (await import('node:fs')).mkdirSync(stubs);
  for (const name of ['omarchy-launch-browser', 'omarchy-notification-send', 'omarchy-launch-tui'])
    stub(name);
  port = await freePort();
});

after(() => {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test('not installed and not running', async () => {
  const r = await run('snapshot');
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    installed: false,
    running: false,
    url: `http://127.0.0.1:${port}`,
  });
  const start = await run('start');
  assert.equal(start.code, 1);
  assert.equal(start.stderr, "hildegard: Hildegard isn't installed yet. Use Set up.\n");
});

test('start and stop go through the hildegard command', async () => {
  stub('hildegard', 'exit 0');
  assert.equal(JSON.parse((await run('snapshot')).stdout).installed, true);
  assert.equal((await run('start')).code, 0);
  assert.equal((await run('stop')).code, 0);
  assert.match(
    logged(),
    new RegExp(`hildegard start --json --port ${port}\nhildegard stop --json --port ${port}`),
  );
  stub('hildegard', `echo '{"ok":false,"message":"Port ${port} is taken by something else"}'; exit 1`);
  const r = await run('start');
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `hildegard: Port ${port} is taken by something else\n`);
});

test('snapshot of a running Hildegard', async () => {
  server = spawn(
    process.execPath,
    [
      join(root, 'apps/server/src/main.ts'),
      '--fake-gpu',
      '--port',
      String(port),
      '--data',
      join(tmp, 'data'),
    ],
    { cwd: root, stdio: 'ignore' },
  );
  await until(() =>
    api('/api/health').then(
      (r) => r.ok,
      () => false,
    ),
  );
  const request = (prompt) => ({
    prompt,
    rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
    format: { quality: 'draft', seconds: 3 },
  });
  const film = await (await post('/api/projects', { title: 'Lighthouse' })).json();
  const good = await (
    await post('/api/shots', { projectId: film.id, request: request('A keeper climbs the stairs') })
  ).json();
  const bad = await (
    await post('/api/shots', { projectId: film.id, request: request('A lantern swings [fail:oom]') })
  ).json();
  const takeIds = [...good.takes, ...bad.takes].map((t) => t.id);

  // While one renders, it is the current take, with its shot's title and its progress.
  const busy = await until(async () => {
    const s = JSON.parse((await run('snapshot')).stdout);
    return s.current ? s : null;
  });
  assert.equal(busy.engine.fake, true);
  assert.equal(busy.queue.running, 1);
  assert.ok([good.shot.title, bad.shot.title].includes(busy.current.title));
  assert.equal(busy.current.projectId, film.id);
  assert.ok(busy.current.progress >= 0 && busy.current.progress <= 1);

  const snap = await until(async () => {
    const s = JSON.parse((await run('snapshot')).stdout);
    return s.recent.length === takeIds.length ? s : null;
  });
  assert.deepEqual(snap.queue, { running: 0, queued: 0 });
  assert.equal(snap.current, null);
  assert.equal(snap.url, `http://127.0.0.1:${port}`);
  assert.deepEqual(
    snap.recent.map((t) => [t.title, t.status, t.projectId]).sort(),
    [
      [good.shot.title, 'done', film.id],
      [bad.shot.title, 'failed', film.id],
    ].sort(),
  );
  for (const t of snap.recent) assert.ok(!Number.isNaN(Date.parse(t.at)));
});

test('open only sends Studio routes to the browser', async () => {
  await run('open', '#/film/p1/take/t1');
  await until(() => logged().includes(`omarchy-launch-browser http://127.0.0.1:${port}/#/film/p1/take/t1`));
  for (const route of ['javascript:alert(1)', '#/a b', '#/x?y=1', 'https://example.com']) {
    const r = await run('open', route);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `hildegard: not a Studio route: ${route}\n`);
  }
  assert.doesNotMatch(logged(), /alert|example\.com/);
});

test('notify', async () => {
  await run('notify', 'Take ready', 'A <b>keeper</b> & co', '#/film/p/take/t');
  await run('notify', 'Take ready', 'Odd route', 'file:///etc/passwd');
  const lines = logged().split('\n');
  assert.ok(
    lines.includes(
      `omarchy-notification-send --app-name Hildegard Take ready A bkeeper/b  co --exec omarchy-launch-browser http://127.0.0.1:${port}/#/film/p/take/t`,
    ),
  );
  assert.ok(
    lines.includes(
      `omarchy-notification-send --app-name Hildegard Take ready Odd route --exec omarchy-launch-browser http://127.0.0.1:${port}/`,
    ),
  );
});

test('setup opens a terminal', async () => {
  await run('setup');
  await until(() =>
    logged().includes(
      `omarchy-launch-tui --app-id=org.omarchy.hildegard-setup ${join(root, 'omarchy/bin/hildegard-omarchy-setup')}`,
    ),
  );
});

test('anything else is a usage error', async () => {
  const r = await run('rm');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^hildegard: usage: /);
});

// Set up, from a copy of the plugin pinned to a release served on loopback.
async function setup(installer, pinnedSha) {
  const { cpSync, mkdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { createServer: http } = await import('node:http');
  const plugin = join(tmp, `plugin-${Math.random().toString(36).slice(2)}`);
  cpSync(join(root, 'omarchy'), plugin, { recursive: true });
  const sha = pinnedSha ?? createHash('sha256').update(installer).digest('hex');
  writeFileSync(join(plugin, 'release.env'), `HILDEGARD_VERSION=0.1.0\nINSTALL_SH_SHA256=${sha}\n`);
  const site = http((req, res) => {
    if (req.url === '/install.sh') res.end(installer);
    else res.writeHead(404).end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const home = join(tmp, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home);
  try {
    const { stdout } = await promisify(execFile)(join(plugin, 'bin/hildegard-omarchy-setup'), [], {
      env: {
        ...env(),
        PATH: '/usr/bin:/bin',
        HOME: home,
        XDG_BIN_HOME: join(home, 'bin'),
        XDG_STATE_HOME: join(home, 'state'),
        HILDEGARD_RELEASE_URL: `http://127.0.0.1:${site.address().port}`,
        NO_PROXY: '127.0.0.1',
        no_proxy: '127.0.0.1',
      },
    });
    return { code: 0, stdout, home };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, home };
  } finally {
    site.close();
  }
}

// A stand-in install.sh: puts a hildegard command that writes down its arguments where the real one would go.
const installer = `#!/bin/sh
set -e
[ "$HILDEGARD_SKIP_SETUP" = 1 ]
mkdir -p "$XDG_BIN_HOME"
printf '#!/bin/sh\\necho "hildegard $*" >>"$HOME/ran"\\n' >"$XDG_BIN_HOME/hildegard"
chmod +x "$XDG_BIN_HOME/hildegard"
echo "install.sh from $HILDEGARD_RELEASE_URL" >>"$HOME/ran"
`;

test('setup installs the pinned release, then runs hildegard install, setup and hf status', async () => {
  const r = await setup(installer);
  assert.equal(r.code, 0, r.stdout);
  const ran = readFileSync(join(r.home, 'ran'), 'utf8').split('\n').filter(Boolean);
  assert.match(ran[0], /^install\.sh from http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(ran.slice(1), ['hildegard install', 'hildegard setup', 'hildegard hf status']);
  assert.match(r.stdout, /Installing Hildegard 0\.1\.0 for you alone/);
});

test('setup refuses an installer that does not match its checksum', async () => {
  const r = await setup(installer, '0'.repeat(64));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /didn't match its checksum .* Nothing was installed\./);
  assert.equal(existsSync(join(r.home, 'ran')), false);
  assert.equal(existsSync(join(r.home, 'bin/hildegard')), false);
});

test('finds the port Hildegard last started on when HILDEGARD_PORT isn’t set', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hildegard-omarchy-home-'));
  const data = join(home, '.local', 'share', 'hildegard');
  (await import('node:fs')).mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'server.json'), JSON.stringify({ port: 7351 }));
  const { HILDEGARD_PORT: _, ...rest } = env();
  const { stdout } = await promisify(execFile)(cli, ['snapshot'], { env: { ...rest, HOME: home } });
  assert.equal(JSON.parse(stdout).url, 'http://127.0.0.1:7351');
  rmSync(join(data, 'server.json'));
  const { stdout: fallback } = await promisify(execFile)(cli, ['snapshot'], { env: { ...rest, HOME: home } });
  assert.equal(JSON.parse(fallback).url, 'http://127.0.0.1:7341');
});
