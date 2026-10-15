import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests use the core sources directly so `pnpm test` does not depend on a
    // prior build. The built package is exercised separately by the P9 test.
    alias: [
      {
        find: /^twiceshy\/sqlite$/,
        replacement: fileURLToPath(
          new URL('./packages/core/src/stores/sqlite.ts', import.meta.url),
        ),
      },
      {
        find: /^twiceshy$/,
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // SQLite tests on slow CI disks (especially Windows) can exceed the 5 s
    // default under parallel load without anything being wrong. A real hang
    // still fails; it just gets 20 s to prove itself.
    testTimeout: 20_000,
    // Builds both packages once, before parallel workers can race over dist.
    globalSetup: ['./vitest.global-setup.ts'],
    // X2 to X4 are real multi-process stress tests with their own script.
    exclude: [...configDefaults.exclude, '**/*.stress.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: [['text', { skipFull: false }], 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/test/**', '**/node_modules/**', '**/dist/**'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        'packages/core/src/errors.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/core/src/classify.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/core/src/duration.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/core/src/engine.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/core/src/fingerprint.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/core/src/redact.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
