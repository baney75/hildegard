// SPDX-License-Identifier: AGPL-3.0-only
// Runs the performance bench and writes one JSON report.
//
//   node scripts/perf/run.mjs [--only bundles,server,cli,mcp,studio] [--out report.json] [--port 7540]
//
// It starts its own fake-GPU servers on ports from --port up (default 7540), in throwaway folders with their own home,
// and never touches an installed Hildegard. Build the Studio first: pnpm --filter @hildegard/studio build.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { routeBundles } from './bundles.mjs';
import { benchCli } from './cli.mjs';
import { benchMcp } from './mcp.mjs';
import { benchServer } from './server.mjs';
import { benchStudio } from './studio.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = new Set((opt('only', 'bundles,server,cli,mcp,studio') ?? '').split(','));
const port = Number(opt('port', process.env.PERF_PORT ?? 7540));
const log = (m) => console.error(m);

const report = {
  at: new Date().toISOString(),
  node: process.version,
  cpus: os.cpus().length,
  platform: `${process.platform}-${process.arch}`,
};
if (only.has('bundles')) report.bundles = routeBundles();
if (only.has('server')) report.server = await benchServer({ port, log });
if (only.has('cli')) report.cli = await benchCli({ port: port + 1, log });
if (only.has('mcp')) report.mcp = await benchMcp({ port: port + 2, log });
if (only.has('studio'))
  report.studio = await benchStudio({
    port: port + 3,
    throttle: Number(process.env.PERF_THROTTLE ?? 4),
    repeats: Number(process.env.PERF_REPEATS ?? 3),
    log,
  });

const out = opt('out');
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
else console.log(JSON.stringify(report, null, 2));
