import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    splitting: false,
  },
  {
    // The contract suite is ESM-only: vitest refuses to load through require().
    entry: { 'stores/contract': 'src/stores/contract.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    sourcemap: true,
    splitting: false,
    external: ['vitest'],
  },
]);
