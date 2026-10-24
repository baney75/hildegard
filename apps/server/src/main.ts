#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { VERSION } from './app.ts';
import { parseArgs } from './config.ts';
import { guardProcess } from './lifecycle.ts';
import { startServer } from './server.ts';

const config = parseArgs(process.argv.slice(2));
let running: Awaited<ReturnType<typeof startServer>> | undefined;
const stop = async () => {
  await running?.close();
  process.exit(0);
};
try {
  running = await startServer(config, { onStop: () => void stop() });
  console.log(
    `Hildegard ${VERSION} is running at ${running.url}${config.fake ? ' (stand-in GPU: no real video)' : ''}`,
  );

  guardProcess(stop);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE')
    console.error(`Port ${config.port} is in use. Is Hildegard already running? Try --port.`);
  else console.error(err.message);
  process.exit(1);
}
