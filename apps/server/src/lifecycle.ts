// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps a long-running server up and makes every exit say why in its log. A hang-up (an ssh session that started
 * it logging out) is ignored rather than fatal; SIGINT and SIGTERM stop it cleanly; a crash logs its stack.
 */
export function guardProcess(stop: (reason: string) => Promise<void> | void, log = console.error): void {
  const at = () => new Date().toISOString();
  const signal = (name: NodeJS.Signals) => () => {
    log(`${at()} Stopping: got ${name}.`);
    void stop(name);
  };
  process.once('SIGINT', signal('SIGINT'));
  process.once('SIGTERM', signal('SIGTERM'));
  if (process.platform !== 'win32')
    process.on('SIGHUP', () => log(`${at()} Ignored SIGHUP (the terminal that started Hildegard closed).`));
  const crash = (kind: string) => (e: unknown) => {
    log(`${at()} Stopped by an ${kind}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  };
  process.on('uncaughtException', crash('uncaught error'));
  process.on('unhandledRejection', crash('unhandled rejection'));
  process.on('exit', (code) => log(`${at()} Exited with code ${code}.`));
}
