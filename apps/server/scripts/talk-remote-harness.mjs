// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One Talk turn across two paired Hildegards, timed.
 *
 * By default it starts a worker (sharing its GPU, as a GPU desktop would) and a primary that joins it, both on the
 * stand-in GPU, stages the fixture recording and its sidecar line on the worker, and asks the primary for a turn on
 * the worker. Writes `.runs/talk-remote-latency.json` at the repository root.
 *
 * With a live sharing device in the environment, it starts only the primary, joins that device, and runs the turn
 * there. Give the device's join code as `HILDEGARD_SECOND_CODE`, or its address and key as `HILDEGARD_SECOND_URL`
 * and `HILDEGARD_SECOND_TOKEN` (with `HILDEGARD_SECOND_NAME`, default `second`). Writes
 * `.runs/talk-second-server-latency.json`. The key is never printed or written.
 *
 *   node apps/server/scripts/talk-remote-harness.mjs [--fixture path/to/recording.wav]
 *
 * The recording's words come from `<fixture>.txt` (a stand-in engine "hears" that file when it sits next to the
 * recording's hash in the worker's voice uploads). The default mode needs no network beyond loopback, no Python
 * and no models.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs as cli } from 'node:util';
import { encodeJoinCode, parseJoinCode } from '../src/choir.ts';
import { parseArgs } from '../src/config.ts';
import { startServer } from '../src/server.ts';

const here = import.meta.dirname;
const root = resolve(here, '..', '..', '..');
const { values } = cli({
  options: {
    fixture: { type: 'string', default: join(here, '..', 'test', 'fixtures', 'talk', 'lighthouse.wav') },
  },
});
const fixture = resolve(values.fixture);
const audio = readFileSync(fixture);
const line = readFileSync(`${fixture}.txt`, 'utf8').trim();

const env = process.env;
const second = env.HILDEGARD_SECOND_CODE
  ? env.HILDEGARD_SECOND_CODE
  : env.HILDEGARD_SECOND_URL && env.HILDEGARD_SECOND_TOKEN
    ? encodeJoinCode({
        name: env.HILDEGARD_SECOND_NAME || 'second',
        url: env.HILDEGARD_SECOND_URL,
        token: env.HILDEGARD_SECOND_TOKEN,
      })
    : null;
if (!second && (env.HILDEGARD_SECOND_URL || env.HILDEGARD_SECOND_TOKEN)) {
  console.error('Set both HILDEGARD_SECOND_URL and HILDEGARD_SECOND_TOKEN, or HILDEGARD_SECOND_CODE.');
  process.exit(2);
}

const memory = () => {
  const stores = new Map();
  return (account) => {
    if (!stores.has(account)) {
      const s = {
        kind: 'keychain',
        value: null,
        get: () => s.value,
        set: (v) => (s.value = v),
        delete: () => (s.value = null),
      };
      stores.set(account, s);
    }
    return stores.get(account);
  };
};
const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
const start = (dir) =>
  startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hfClientId: null },
    {
      fakeTickMs: 25,
      secrets: memory()('hf'),
      choirSecrets: memory(),
      hubToken: join(dir, 'no-hf-token'),
      llm: {
        fetch: async () => {
          throw new Error('offline');
        },
        env: {},
        localAi: { gateways: async () => [], key: () => null },
      },
    },
  );
const H = { 'x-hildegard': '1' };

const pair = async (primary, code) => {
  const joined = await fetch(`${primary.url}/api/choir/join`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (joined.status !== 201) {
    const why = await joined.json().catch(() => ({}));
    throw new Error(`join: HTTP ${joined.status} ${why.error ?? ''}`);
  }
  return parseJoinCode(code);
};

/** Ask the primary for a turn on `name`, fetch the answer it plays, and time both. */
const turn = async (primary, name) => {
  const form = new FormData();
  form.set('audio', new Blob([audio], { type: 'audio/wav' }), 'turn.wav');
  form.set('device', name);
  const t0 = performance.now();
  const res = await fetch(`${primary.url}/api/talk/turn`, { method: 'POST', headers: H, body: form });
  const r = await res.json();
  if (!res.ok) throw new Error(`turn: HTTP ${res.status} ${r.error ?? ''}`);
  const played = await fetch(primary.url + r.audio.url);
  const bytes = Buffer.from(await played.arrayBuffer());
  const ms = Math.round(performance.now() - t0);
  if (played.status !== 200 || bytes.subarray(0, 4).toString() !== 'RIFF')
    throw new Error('the answer isn’t playable');
  return { r, ms, audioBytes: bytes.length };
};

const sha = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const save = (name, out) => {
  const file = join(root, '.runs', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out));
  console.log(`Wrote ${file}`);
};
const allRemote = (route) => Object.values(route).every((x) => x === 'remote');

const primary = await start(mkdtempSync(join(tmpdir(), 'hg-harness-primary-')));
let worker = null;
try {
  if (second) {
    const { name, url } = await pair(primary, second);
    const { r, ms, audioBytes } = await turn(primary, name);
    save('talk-second-server-latency.json', {
      transcript: r.transcript,
      replyText: r.replyText,
      ms,
      route: r.route,
      sha: sha(),
      server: { name, host: new URL(url).hostname },
      heardStagedLine: r.transcript === line,
      audioBytes,
      at: new Date().toISOString(),
    });
    if (!allRemote(r.route)) {
      console.error(`The turn didn’t run on ${name}.`);
      process.exitCode = 1;
    }
  } else {
    worker = await start(mkdtempSync(join(tmpdir(), 'hg-harness-worker-')));
    const invite = await fetch(`${worker.url}/api/choir/invite`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${await freePort()}`, long: true }),
    });
    if (!invite.ok) throw new Error(`invite: HTTP ${invite.status}`);
    const { code } = await invite.json();
    const { name } = await pair(primary, code);

    const voiceDir = join(worker.config.dataDir, 'media', 'voice');
    mkdirSync(voiceDir, { recursive: true });
    writeFileSync(join(voiceDir, `${createHash('sha256').update(audio).digest('hex')}.wav.txt`), line);

    const { r, ms, audioBytes } = await turn(primary, name);
    save('talk-remote-latency.json', {
      transcript: r.transcript,
      replyText: r.replyText,
      ms,
      route: r.route,
      sha: sha(),
      engine: 'stand-in',
      audioBytes,
      at: new Date().toISOString(),
    });
    if (r.transcript !== line || !allRemote(r.route)) {
      console.error('The turn didn’t run on the worker.');
      process.exitCode = 1;
    }
  }
} finally {
  await primary.close();
  await worker?.close();
}
