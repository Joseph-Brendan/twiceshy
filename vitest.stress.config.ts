import { defineConfig } from 'vitest/config';

/**
 * Stress tests (C17 X2-X4). Run with `pnpm test:stress`, which builds the
 * packages first so the child-process fixtures can import the built output.
 * Kept out of the normal suite because they spawn real processes and run
 * 1,000 parallel actions.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/core/test/stress/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The files spawn child processes and write databases; running them one
    // at a time keeps the pressure real but the results stable.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
