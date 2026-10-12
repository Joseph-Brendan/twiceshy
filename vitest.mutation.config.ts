import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// Vitest configuration used only by mutation testing (Stryker).
//
// It mirrors the alias setup of vitest.config.ts so tests resolve `twiceshy`
// and `twiceshy/sqlite` to the sources, but it does not apply coverage
// thresholds (the Vitest runner disables coverage itself) and it skips the
// packaging and stress suites: packaging tests rebuild and install tarballs,
// which is irrelevant to the four mutated modules and slow inside Stryker's
// sandbox.
export default defineConfig({
  resolve: {
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
    include: ['packages/core/test/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/*.stress.test.ts',
      'packages/core/test/packaging.test.ts',
    ],
  },
});
