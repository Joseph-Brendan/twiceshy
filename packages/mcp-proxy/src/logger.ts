import type { Writable } from 'node:stream';
import { Writable as WritableStream } from 'node:stream';

/**
 * The one logging path for the proxy package (C13/C15). Everything goes to
 * stderr as JSON lines; stdout is reserved for MCP messages in stdio mode.
 * No module in this package may use console.log.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Writes unconditionally; used to forward child-process stderr (C13). */
  stderr(message: string): void;
  /** A logger that tags every line with the given scope, such as a server name. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  stream?: Writable;
  scope?: string;
  now?: () => Date;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** A stream that discards everything; used to silence logs on request. */
export const nullLogStream: Writable = new WritableStream({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

/**
 * The MCP SDK occasionally writes diagnostics with console.log/debug, which
 * land on stdout and corrupt the stdio JSON-RPC stream (C13). The proxy runs
 * this guard before serving so any such line goes to stderr instead.
 */
export function redirectConsoleToStderr(logger: Logger): void {
  const write = (message: unknown): void => {
    logger.debug(typeof message === 'string' ? message : String(message));
  };
  console.log = write;
  console.info = write;
  console.debug = write;
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serialize);
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = serialize(item);
    }
    return output;
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'warn';
  const stream = options.stream ?? process.stderr;
  const scope = options.scope;
  const now = options.now ?? (() => new Date());

  const write = (lineLevel: LogLevel | 'stderr', message: string, fields?: LogFields): void => {
    if (lineLevel !== 'stderr' && LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) {
      return;
    }
    try {
      const line: Record<string, unknown> = {
        level: lineLevel,
        at: now().toISOString(),
        msg: message,
      };
      if (scope !== undefined) {
        line.scope = scope;
      }
      if (fields !== undefined) {
        for (const [key, value] of Object.entries(fields)) {
          line[key] = serialize(value);
        }
      }
      stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      // The stream is closed; there is nowhere left to report this.
    }
  };

  return {
    level,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    stderr: (message) => write('stderr', message),
    child: (childScope) =>
      createLogger({
        level,
        stream,
        scope: scope === undefined ? childScope : `${scope} ${childScope}`,
        now,
      }),
  };
}
