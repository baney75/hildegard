// SPDX-License-Identifier: AGPL-3.0-only
// Turns two bench reports into a before/after table:  node scripts/perf/compare.mjs before.json after.json
import { readFileSync } from 'node:fs';

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error('Usage: node scripts/perf/compare.mjs before.json after.json');
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(readFileSync(afterFile, 'utf8'));

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const fmt = { kb, ms: (n) => `${n} ms`, n: (n) => `${n}`, mb: (n) => `${n} MB`, fps: (n) => `${n}` };
const rows = [];
const row = (label, path, unit = 'ms') => {
  const b = get(before, path);
  const a = get(after, path);
  if (b == null && a == null) return;
  const delta = b && a != null ? `${a <= b ? '−' : '+'}${Math.abs(Math.round(((a - b) / b) * 100))}%` : '';
  rows.push(`| ${label} | ${b == null ? '' : fmt[unit](b)} | ${a == null ? '' : fmt[unit](a)} | ${delta} |`);
};

for (const route of ['Cinema', 'Images', 'Queue', 'Settings', 'Sites', 'Voice', 'Talk']) {
  row(`${route}: first-load JS+CSS, brotli`, `bundles.${route}.brotli`, 'kb');
}
for (const route of ['Cinema', 'Images', 'Queue', 'Settings', 'Sites', 'Voice', 'Talk']) {
  for (const [name, key] of [
    ['FCP', 'fcp'],
    ['LCP', 'lcp'],
    ['TTI (est.)', 'tti'],
  ]) {
    row(`${route}: ${name}, cold`, `studio.routes.${route}.cold.${key}`);
  }
  row(`${route}: long tasks, cold`, `studio.routes.${route}.cold.longMs`);
  row(`${route}: FCP, warm`, `studio.routes.${route}.warm.fcp`);
}
for (const route of ['Images', 'Queue', 'Settings', 'Sites', 'Voice', 'Talk', 'Cinema']) {
  row(`Switch to ${route}, first visit`, `studio.switches.${route}.first.ms`);
}
for (const g of ['Queue (500 takes)', 'Images (500 stills)']) {
  row(`${g}: DOM nodes`, `studio.grid.${g}.domNodes`, 'n');
  row(`${g}: scroll fps`, `studio.grid.${g}.fps`, 'fps');
  row(`${g}: frame p95`, `studio.grid.${g}.frameP95Ms`);
  row(`${g}: JS heap`, `studio.grid.${g}.heapMbAfter`, 'mb');
}
row('Server: cold start to /api/health', 'server.coldStartMs');
for (const e of ['/api/snapshot', '/api/catalog', '/api/agents', '/api/tunnel', '/api/llm']) {
  row(`Server ${e}: p50`, `server.endpoints.${e}.p50`);
  row(`Server ${e}: p95`, `server.endpoints.${e}.p95`);
}
row('Server: event stream, first event p50', 'server.eventStream.p50');
row('Server: idle memory', 'server.idleRssMb', 'mb');
for (const c of [
  '--help',
  'status',
  'doctor',
  'models',
  'host status',
  'tunnel',
  'agents',
  'lint (10k words)',
]) {
  row(`CLI ${c}: median`, `cli.${c}.p50`);
}
row('MCP: spawn to initialize', 'mcp.spawnToInitializeMs');
row('MCP: tools/list', 'mcp.toolsListMs');
row('MCP: hildegard_status call', 'mcp.calls.hildegard_status');

console.log('| Measure | Before | After | Change |\n| --- | --- | --- | --- |');
console.log(rows.join('\n'));
