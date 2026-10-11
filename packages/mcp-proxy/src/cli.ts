#!/usr/bin/env node

import { isTwiceshyError } from 'twiceshy';
import { loadConfigFile } from './config.js';
import type { LogLevel } from './logger.js';
import { createLogger, isLogLevel } from './logger.js';
import { startProxy } from './proxy.js';
import { PROXY_VERSION } from './version.js';

const USAGE = `Usage: twiceshy [command] [options]

Commands:
  proxy --config <file>   Run the proxy (default when no command is given)
  --help, -h              Show this help
  --version, -v           Show the version

Options:
  --config <file>         Config file to load
  --log-level <level>     error, warn, info, or debug (default: warn)
`;

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export interface CliDependencies {
  /** Injectable proxy starter; tests use it to avoid touching real stdio. */
  start?: typeof startProxy;
}

/**
 * Runs one proxy session on stdio. Returns only when the client disconnects
 * or SIGINT/SIGTERM arrives, so the process keeps serving until then.
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  deps: CliDependencies = {},
): Promise<number> {
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
  const configPath = flagValue(argv, '--config');
  if (configPath === undefined) {
    process.stderr.write(`Missing --config <file>.\n${USAGE}`);
    return 2;
  }
  const levelText = flagValue(argv, '--log-level') ?? 'warn';
  if (!isLogLevel(levelText)) {
    process.stderr.write(`Invalid --log-level "${levelText}". Use error, warn, info, or debug.\n`);
    return 2;
  }
  const level: LogLevel = levelText;

  try {
    const logger = createLogger({ level });
    const config = loadConfigFile(configPath);
    const start = deps.start ?? startProxy;
    const proxy = await start({ config, logger });
    logger.info('proxy started');
    const reason = await waitForShutdown();
    logger.info(`shutting down (${reason}); waiting up to 10s for in-flight calls`);
    await proxy.close();
    logger.info('proxy stopped');
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

/**
 * Resolves once the client disconnects or the process is asked to stop.
 * Registering SIGTERM/SIGINT handlers replaces the default immediate exit, so
 * the caller can close the proxy gracefully first (C13).
 */
function waitForShutdown(): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.stdin.off('end', onStdinEnd);
      resolve(reason);
    };
    const onSigint = (): void => finish('SIGINT');
    const onSigterm = (): void => finish('SIGTERM');
    const onStdinEnd = (): void => finish('client disconnect');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.stdin.once('end', onStdinEnd);
    if (process.stdin.readableEnded) {
      finish('client disconnect');
    }
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
