import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: 'server:s3',
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    globals: true,
    include: ['test/s3/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { TZ: 'UTC' },
  },
  plugins: [swc.vite()],
});
