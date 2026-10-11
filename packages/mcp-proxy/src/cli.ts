#!/usr/bin/env node

import { isTwiceshyError } from 'twiceshy';
import { loadConfigFile } from './config.js';
import { createLogger } from './logger.js';
import { startProxy } from './proxy.js';
import { PROXY_VERSION } from './version.js';

const USAGE = `Usage: twiceshy [command] [options]

Commands:
  proxy --config <file>   Run the proxy (default when no command is given)
  --help, -h              Show this help
  --version, -v           Show the version
`;

/**
 * Runs one proxy session on stdio. Returns only when the client disconnects,
 * so the process keeps serving until then.
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`@twiceshy/mcp-proxy v${PROXY_VERSION}\n`);
    return 0;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = argv[0] ?? 'proxy';
  if (command !== 'proxy') {
    process.stderr.write(`Unknown command "${command}".\n${USAGE}`);
    return 2;
  }
  const configIndex = argv.indexOf('--config');
  const configPath = configIndex === -1 ? undefined : argv[configIndex + 1];
  if (configPath === undefined) {
    process.stderr.write(`Missing --config <file>.\n${USAGE}`);
    return 2;
  }
  try {
    const config = loadConfigFile(configPath);
    const proxy = await startProxy({ config, logger: createLogger() });
    await waitForStdinEnd();
    await proxy.close();
    return 0;
  } catch (error) {
    if (isTwiceshyError(error)) {
      process.stderr.write(`${error.what}\nWhy: ${error.why}\nFix: ${error.fix}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 1;
  }
}

function waitForStdinEnd(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded) {
      resolve();
      return;
    }
    process.stdin.once('end', () => resolve());
  });
}

/* v8 ignore start */
if (process.env.NODE_ENV !== 'test') {
  void runCli()
    .then((code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
/* v8 ignore stop */
