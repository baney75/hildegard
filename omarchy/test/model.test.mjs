// SPDX-License-Identifier: AGPL-3.0-only
// Model.js is a QML JavaScript library (`.pragma library`), so it loads here by dropping the pragma.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../Model.js', import.meta.url), 'utf8');
assert.match(source, /^\.pragma library\n/);
const M = {};
// Arrays made inside the vm context have another realm's prototype; compare them by value.
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
vm.runInNewContext(
  `${source.replace(/^\.pragma library\n/, '')}\nObject.assign(M, { mark, plural, status, percent, progressLine, takeRoute, ago, finished, actions, lending })`,
  { M },
);

const up = (over = {}) => ({
  installed: true,
  running: true,
  url: 'http://127.0.0.1:7341',
  engine: { online: true, fake: false, paused: false, device: 'RTX 4090', problem: null },
  queue: { running: 0, queued: 0 },
  current: null,
  recent: [],
  ...over,
});

test('mark', () => {
  assert.equal(M.mark(null), 'off');
  assert.equal(M.mark({ installed: true, running: false }), 'off');
  assert.equal(M.mark(up()), 'idle');
  assert.equal(M.mark(up({ queue: { running: 1, queued: 0 } })), 'busy');
  assert.equal(M.mark(up({ queue: { running: 0, queued: 2 } })), 'busy');
  // Another device's render keeps the GPU busy too.
  assert.equal(M.mark(up({ queue: { running: 1, queued: 0, guests: 1 } })), 'busy');
  assert.equal(M.mark(up({ engine: { online: false } })), 'failed');
  assert.equal(M.mark(up({ engine: { online: true, problem: 'Out of GPU memory' } })), 'failed');
});

test('status', () => {
  assert.equal(M.status(null), '');
  assert.equal(M.status({ installed: false, running: false }), 'Not set up on this computer yet');
  assert.equal(M.status({ installed: true, running: false }), 'Not running');
  assert.equal(M.status(up()), 'Ready on RTX 4090');
  assert.equal(M.status(up({ update: { available: '0.2.0', applying: true } })), 'Updating to 0.2.0');
  assert.equal(M.status(up({ engine: { online: true, fake: true } })), 'Ready (stand-in GPU)');
  assert.equal(M.status(up({ engine: { online: false } })), 'Waiting for ComfyUI');
  assert.equal(M.status(up({ engine: { online: true, problem: 'Out of GPU memory' } })), 'Out of GPU memory');
  assert.equal(M.status(up({ queue: { running: 1, queued: 0 } })), 'Rendering 1 take');
  assert.equal(M.status(up({ queue: { running: 2, queued: 3 } })), 'Rendering 2 takes, 3 waiting');
  assert.equal(
    M.status(up({ queue: { running: 0, queued: 1 }, engine: { online: true, paused: true } })),
    '1 waiting · paused',
  );
  assert.equal(M.status(up({ engine: { online: true, paused: true } })), 'Paused');
  // Renders paired devices sent here count, and the line says whose they are.
  assert.equal(
    M.status(up({ queue: { running: 1, queued: 0, guests: 1 } })),
    'Rendering 1 take · 1 from another device',
  );
  assert.equal(
    M.status(up({ queue: { running: 1, queued: 2, guests: 2 }, engine: { online: true, paused: true } })),
    'Rendering 1 take, 2 waiting · 2 from other devices · paused',
  );
});

test('progressLine says starting, a share, then finishing', () => {
  assert.equal(M.progressLine(0), 'Starting');
  assert.equal(M.progressLine(0.5), '50%');
  assert.equal(M.progressLine(1), 'Finishing');
});

test('percent clamps and rounds', () => {
  assert.equal(M.percent(undefined), 0);
  assert.equal(M.percent(0.426), 43);
  assert.equal(M.percent(-1), 0);
  assert.equal(M.percent(7), 100);
});

test('takeRoute', () => {
  assert.equal(M.takeRoute({ id: 't1', projectId: 'p1' }), '#/film/p1/take/t1');
  assert.equal(M.takeRoute({ id: 't1' }), '');
  assert.equal(M.takeRoute(null), '');
});

test('ago', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(M.ago('2026-10-19T11:59:40Z', now), 'just now');
  assert.equal(M.ago('2026-10-19T11:48:00Z', now), '12 min ago');
  assert.equal(M.ago('2026-10-19T09:00:00Z', now), '3 h ago');
  assert.equal(M.ago('2026-10-16T12:00:00Z', now), '3 d ago');
  assert.equal(M.ago('nonsense', now), '');
});

test('finished: only takes that newly appear after something was rendering', () => {
  const a = { id: 'a', projectId: 'p', status: 'done', title: 'A' };
  const b = { id: 'b', projectId: 'p', status: 'failed', title: 'B' };
  const busy = up({ queue: { running: 1, queued: 0 }, recent: [a] });
  same(M.finished(busy, up({ recent: [b, a] })), [b]);
  // Nothing was rendering before: an old take scrolling into view isn't news.
  same(M.finished(up({ recent: [a] }), up({ recent: [b, a] })), []);
  // First look, or Hildegard just started or stopped: no burst of notifications.
  same(M.finished(null, up({ recent: [a] })), []);
  same(M.finished({ installed: true, running: false }, up({ recent: [a] })), []);
  same(M.finished(busy, { installed: true, running: false }), []);
});

test('actions', () => {
  const ids = (s) => M.actions(s).map((a) => a.id);
  same(ids(null), []);
  same(ids({ installed: false, running: false }), ['setup']);
  same(ids({ installed: true, running: false }), ['start', 'setup']);
  same(ids(up()), ['studio', 'agents', 'stop']);
  same(ids(up({ queue: { running: 1, queued: 0 } })), ['studio', 'queue', 'agents', 'stop']);
  same(ids(up({ queue: { running: 1, queued: 0, guests: 1 } })), ['studio', 'queue', 'agents', 'stop']);
  // A newer release: offered once, and not while it installs.
  same(ids(up({ update: { available: '0.2.0', applying: false } })), ['studio', 'agents', 'update', 'stop']);
  assert.equal(
    M.actions(up({ update: { available: '0.2.0', applying: false } }))[2].label,
    'Update to 0.2.0',
  );
  same(ids(up({ update: { available: '0.2.0', applying: true } })), ['studio', 'agents', 'stop']);
  same(ids(up({ update: { available: null, applying: false } })), ['studio', 'agents', 'stop']);
  for (const s of [{ installed: false }, { installed: true, running: false }, up()])
    assert.equal(M.actions(s).filter((a) => a.primary).length, 1);
});

test('lending', () => {
  assert.equal(M.lending(up()), null);
  assert.equal(M.lending({ installed: true, running: false, sharing: { opportunistic: true } }), null);
  same(M.lending(up({ sharing: { opportunistic: false, busy: null } })), {
    text: 'Shares its GPU whenever your other devices ask',
    flip: 'on',
    label: 'Only when free',
  });
  same(M.lending(up({ sharing: { opportunistic: true, busy: null } })), {
    text: 'Shares its GPU only while it’s free',
    flip: 'off',
    label: 'Always share',
  });
  assert.equal(
    M.lending(up({ sharing: { opportunistic: true, busy: 'qwen3-coder is using the GPU.' } })).text,
    'qwen3-coder is using the GPU, so your other devices’ renders wait',
  );
});
