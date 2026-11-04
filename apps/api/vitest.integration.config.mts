import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests run against the real Postgres + Redis from `pnpm dev:up`.
// global-setup.ts creates a throwaway database per run, so tests never touch dev data.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.spec.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    environment: 'node',
    // Suites share one database; run files one at a time for predictable rate-limit state.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
