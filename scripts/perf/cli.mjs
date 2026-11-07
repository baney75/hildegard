// SPDX-License-Identifier: AGPL-3.0-only
// CLI bench: wall time of the commands people run most, against a fake-GPU server on the bench port, plus `lint` on
// a 10,000-word file. Each is run several times; the first run is kept apart as the cold one.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_MAIN, isolatedEnv, median, round, scratch, startServer, timeCommand } from './lib.mjs';

export const COMMANDS = [
  ['--help', ['--help']],
  ['status', ['status']],
  ['doctor', ['doctor']],
  ['models', ['models']],
  ['host status', ['host', 'status']],
  ['tunnel', ['tunnel']],
  ['agents', ['agents']],
];

/** About 10,000 words of ordinary prose, with a few of the tells the lint looks for. */
export function tenKWords() {
  const sentences = [
    'The harbor was quiet before the boats came in and the gulls had not started yet.',
    'She walked the length of the pier and counted the nets drying on the rail.',
    'Delve into the rich tapestry of it all, said the man selling coffee from a cart.',
    'Nobody answered, so he poured another cup and watched the water change color.',
    'By noon the fog had lifted and the town looked like itself again.',
  ];
  const out = [];
  let words = 0;
  for (let i = 0; words < 10000; i++) {
    const s = sentences[i % sentences.length];
    out.push(s);
    words += s.split(' ').length;
    if (i % 6 === 5) out.push('\n\n');
  }
  return out.join(' ');
}

export async function benchCli({ port, runs = 5, log = () => {} } = {}) {
  const s = scratch();
  const srv = await startServer({ port, data: s.data, home: s.home });
  const env = isolatedEnv(s.home, { HILDEGARD_FAKE_TICK_MS: '40' });
  const common = ['--port', String(port), '--data', s.data];
  const out = {};
  try {
    const lintFile = join(s.dir, 'ten-thousand-words.md');
    writeFileSync(lintFile, tenKWords());
    const list = [...COMMANDS, ['lint (10k words)', ['lint', lintFile]]];
    for (const [name, args] of list) {
      const times = [];
      let code = 0;
      for (let i = 0; i < runs; i++) {
        const r = await timeCommand(process.execPath, [CLI_MAIN, ...args, ...common], { env, cwd: s.dir });
        times.push(r.ms);
        code = r.code;
      }
      out[name] = {
        exit: code,
        cold: round(times[0]),
        p50: round(median(times.slice(1))),
        max: round(Math.max(...times)),
      };
      log(`hildegard ${name}: first ${out[name].cold} ms, p50 ${out[name].p50} ms (exit ${code})`);
    }
  } finally {
    await srv.stop();
  }
  return out;
}

if (import.meta.main) {
  const r = await benchCli({ port: Number(process.env.PERF_PORT ?? 7542), log: (m) => console.error(m) });
  console.log(JSON.stringify(r, null, 2));
}
