// SPDX-License-Identifier: AGPL-3.0-only
// The performance budgets, as a test: CI runs it after the Studio is built, and a change that makes Hildegard slower
// or heavier than budgets.json allows fails it.
//
//   pnpm --filter @hildegard/studio build && node --test scripts/perf/budgets.test.mjs
//
// Sizes are exact and the same on every machine, so their budgets sit a little above today's numbers. Times depend on
// the machine, so theirs leave room for a slow CI runner and still fail on the kind of slip that matters (the CLI
// loading the whole server again, a probe run on every request). Update budgets.json in the same pull request as a
// change that earns a bigger number, and say why.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { routeBundles } from './bundles.mjs';
import { CLI_MAIN, isolatedEnv, median, now, pct, round, scratch, startServer, timeCommand } from './lib.mjs';
import { benchStudio } from './studio.mjs';

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8'));
const PORT = Number(process.env.PERF_PORT ?? 7540);

const within = (what, got, max, unit) =>
  assert.ok(
    got <= max,
    `${what} is ${got} ${unit}, over its budget of ${max} ${unit}. If this is deserved, raise it in scripts/perf/budgets.json and say why.`,
  );

describe('Studio bundles (JS and CSS a route downloads, brotli)', () => {
  const bundles = routeBundles();
  for (const [route, max] of Object.entries(budgets.bundleBrotliBytes)) {
    test(route, () => {
      const got = route === 'shell' ? bundles.shell.brotli : bundles[route].brotli;
      within(`${route} bundle`, got, max, 'bytes');
    });
  }
  test('the shell alone stays under its raw JS budget', () => {
    within('shell (raw)', bundles.shell.raw, budgets.shellRawBytes, 'bytes');
  });
});

describe('CLI wall time', () => {
  const s = scratch();
  const env = isolatedEnv(s.home);
  const common = ['--port', String(PORT + 9), '--data', s.data];
  const run = async (args, runs) => {
    const times = [];
    for (let i = 0; i < runs + 1; i++) {
      const r = await timeCommand(process.execPath, [CLI_MAIN, ...args, ...common], { env, cwd: s.dir });
      assert.notEqual(r.code, null);
      if (i > 0) times.push(r.ms);
    }
    return round(median(times));
  };
  for (const [name, args] of [
    ['--help', ['--help']],
    ['status', ['status']],
  ]) {
    test(`hildegard ${name}`, async () => {
      within(`hildegard ${name} (median)`, await run(args, 5), budgets.cliMs[name], 'ms');
    });
  }
});

describe('Server', () => {
  test('cold start to the first /api/health', async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const s = scratch();
      const srv = await startServer({ port: PORT + 10, data: s.data, home: s.home });
      runs.push(srv.coldMs);
      await srv.stop();
    }
    within('cold start (median of 3)', round(median(runs)), budgets.server.coldStartMs, 'ms');
  });
  test('/api/snapshot p95', async () => {
    const s = scratch();
    const srv = await startServer({ port: PORT + 11, data: s.data, home: s.home });
    try {
      const times = [];
      for (let i = 0; i < 50; i++) {
        const t0 = now();
        const r = await fetch(`${srv.url}/api/snapshot`);
        await r.arrayBuffer();
        times.push(now() - t0);
      }
      within('/api/snapshot p95', round(pct(times, 95), 2), budgets.server.snapshotP95Ms, 'ms');
    } finally {
      await srv.stop();
    }
  });
});

describe('Studio lists (headless Chromium, 500 takes and 500 images in the history)', () => {
  test('the Queue and Images draw what is near the screen, not all 500', async () => {
    const r = await benchStudio({ port: PORT + 12, throttle: 1, parts: ['grid'] });
    const queue = r.grid['Queue (500 takes)'];
    const images = r.grid['Images (500 stills)'];
    const b = budgets.studio;
    within('Queue DOM nodes after load', queue.domNodesAtLoad, b.queueNodesAtLoad, 'nodes');
    within('Queue DOM nodes after scrolling to the end', queue.domNodes, b.queueNodesScrolled, 'nodes');
    within('Images DOM nodes after load', images.domNodesAtLoad, b.imagesNodesAtLoad, 'nodes');
  });
});
