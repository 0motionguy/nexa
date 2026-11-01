import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'e2e', 'dist'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@nexa/shared-zod': resolve(__dirname, '../../packages/shared-zod/src/index.ts'),
    },
  },
});
