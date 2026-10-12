import { ensureBuilt } from './packages/mcp-proxy/test/helpers/built-binary.js';

/**
 * Builds both packages once, before any test worker starts. The real-binary
 * tests (P9, P11) need a dist that matches the sources; building here removes
 * any chance of two parallel workers racing over the same dist folder.
 */
export default function setup(): void {
  ensureBuilt();
}
