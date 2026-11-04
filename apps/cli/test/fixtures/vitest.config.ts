// SPDX-License-Identifier: AGPL-3.0-only
// Runs only the fixtures, which cleanup.test.ts runs in a child vitest. The normal suite never collects them: their
// names don't match its include glob (*.test.ts). The timeout is above the helpers' own 60 s limit on a command.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['**/*.fixture.ts'], testTimeout: 90_000 } });
