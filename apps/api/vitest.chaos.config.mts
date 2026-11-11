import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// M9 chaos runs: real faults (killed worker process, flushed or restarted Redis, paused Postgres,
// killed model server) against the same throwaway test environment as the integration tests.
// Needs `pnpm --filter @modelops/api build` first: the worker runs as a real process (dist/).
export default defineConfig({
  test: {
    include: ['test/chaos/**/*.chaos.spec.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    environment: 'node',
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 240_000,
    silent: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
