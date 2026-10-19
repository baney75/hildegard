#!/usr/bin/env node
import { VERSION } from './app.ts';
import { parseArgs } from './config.ts';
import { startServer } from './server.ts';

const config = parseArgs(process.argv.slice(2));
try {
  const running = await startServer(config);
  console.log(
    `Hildegard ${VERSION} is running at ${running.url}${config.fake ? ' (stand-in GPU: no real video)' : ''}`,
  );
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE')
    console.error(`Port ${config.port} is in use. Is Hildegard already running? Try --port.`);
  else console.error(err.message);
  process.exit(1);
}
