import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
