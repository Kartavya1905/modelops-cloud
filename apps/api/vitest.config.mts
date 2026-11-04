import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Vitest's default transformer does not emit decorator metadata, which NestJS dependency
// injection needs. SWC does, reading `emitDecoratorMetadata` from tsconfig.json.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
