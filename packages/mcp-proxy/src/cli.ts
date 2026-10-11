#!/usr/bin/env node

import { PROXY_VERSION } from './index.js';

export function runCli(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`@twiceshy/mcp-proxy v${PROXY_VERSION}\n`);
    return 0;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: twiceshy [command] [options]\n');
    return 0;
  }
  return 0;
}

/* v8 ignore next 3 */
if (process.env.NODE_ENV !== 'test') {
  runCli();
}
