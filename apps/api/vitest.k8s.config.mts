import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// M10: the lifecycle suites against the KubernetesDriver (model servers as kind pods).
// global-setup.ts runs in this process and reads this: needs `pnpm kind:up` and `pnpm dev:obs`.
process.env.MO_TEST_RUNTIME = 'kubernetes';

export default defineConfig({
  test: {
    include: ['test/integration/deployments.int.spec.ts', 'test/integration/tracing.int.spec.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000, // image loading into kind on the first run
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
