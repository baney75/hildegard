import { defineConfig } from 'vitest/config';

// Unit tests only; the browser tests in e2e/ run under Playwright.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
