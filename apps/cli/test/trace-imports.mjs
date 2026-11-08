// SPDX-License-Identifier: AGPL-3.0-only
// Preloaded by lazy-imports.test.ts: writes every module the command resolved to stderr when it exits.
import { registerHooks } from 'node:module';

const seen = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    seen.add(resolved.url);
    return resolved;
  },
});
process.on('exit', () => process.stderr.write(`\nLOADED ${JSON.stringify([...seen])}\n`));
