import type { Writable } from 'node:stream';

/**
 * The one logging path for the proxy package (C13/C15). Everything goes to
 * stderr; stdout is reserved for MCP messages in stdio mode. No module in this
 * package may use console.log.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  readonly level: LogLevel;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Writes unconditionally; used to forward child-process stderr (C13). */
  stderr(message: string): void;
  /** A logger that tags every line with the given scope, such as a server name. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  stream?: Writable;
  scope?: string;
}

function writeLine(stream: Writable, scope: string, tag: string, message: string): void {
  try {
    const prefix = scope.length === 0 ? '' : `${scope} `;
    stream.write(`[twiceshy] ${prefix}${tag}${message}\n`);
  } catch {
    // The stream is closed; there is nowhere left to report this.
  }
}

/** Creates the package logger. Default level is "warn" (C15). */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'warn';
  const stream = options.stream ?? process.stderr;
  const scope = options.scope ?? '';
  const emit = (messageLevel: LogLevel, tag: string, message: string): void => {
    if (LEVEL_ORDER[messageLevel] < LEVEL_ORDER[level]) {
      return;
    }
    writeLine(stream, scope, tag, message);
  };
  return {
    level,
    debug: (message) => emit('debug', 'debug: ', message),
    info: (message) => emit('info', 'info: ', message),
    warn: (message) => emit('warn', 'warn: ', message),
    error: (message) => emit('error', 'error: ', message),
    stderr: (message) => writeLine(stream, scope, '', message),
    child: (childScope) =>
      createLogger({
        level,
        stream,
        scope: scope.length === 0 ? childScope : `${scope} ${childScope}`,
      }),
  };
}
