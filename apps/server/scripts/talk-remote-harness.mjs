// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One Talk turn across two paired Hildegards, timed. It starts a worker (sharing its GPU, as a GPU desktop would) and a
 * primary that joins it, both on the stand-in GPU, stages the fixture recording and its sidecar line on the worker,
 * and asks the primary for a turn on the worker. Writes `.runs/talk-remote-latency.json` at the repository root.
 *
 *   node apps/server/scripts/talk-remote-harness.mjs [--fixture path/to/recording.wav]
 *
 * The recording's words come from `<fixture>.txt` (the stand-in engine "hears" that file). No network beyond
 * loopback, no Python, no models.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs as cli } from 'node:util';
import { parseJoinCode } from '../src/choir.ts';
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

const worker = await start(mkdtempSync(join(tmpdir(), 'hg-harness-worker-')));
const primary = await start(mkdtempSync(join(tmpdir(), 'hg-harness-primary-')));
try {
  const invite = await fetch(`${worker.url}/api/choir/invite`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${await freePort()}` }),
  });
  if (!invite.ok) throw new Error(`invite: HTTP ${invite.status}`);
  const { code } = await invite.json();
  const joined = await fetch(`${primary.url}/api/choir/join`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (joined.status !== 201) throw new Error(`join: HTTP ${joined.status}`);
  const { name } = parseJoinCode(code);

  const voiceDir = join(worker.config.dataDir, 'media', 'voice');
  mkdirSync(voiceDir, { recursive: true });
  writeFileSync(join(voiceDir, `${createHash('sha256').update(audio).digest('hex')}.wav.txt`), line);

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

  let sha = null;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {}
  const out = {
    transcript: r.transcript,
    replyText: r.replyText,
    ms,
    route: r.route,
    sha,
    engine: 'stand-in',
    audioBytes: bytes.length,
    at: new Date().toISOString(),
  };
  const file = join(root, '.runs', 'talk-remote-latency.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out));
  if (out.transcript !== line || Object.values(out.route).some((x) => x !== 'remote')) {
    console.error('The turn didn’t run on the worker.');
    process.exitCode = 1;
  }
} finally {
  await primary.close();
  await worker.close();
}
