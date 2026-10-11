/**
 * Error types for Twiceshy.
 *
 * Every error carries a stable `code` plus `what`, `why`, and `fix` text, so a
 * human (or an agent) reading a log knows what happened and what to do next.
 */

export const ERROR_CODES = [
  'IN_DOUBT',
  'IN_PROGRESS',
  'KEY_CONFLICT',
  'NOT_SERIALIZABLE',
  'STORE_UNAVAILABLE',
  'CONFIG_INVALID',
  'RESULT_TOO_LARGE',
  'DOWNSTREAM_UNAVAILABLE',
  'UNSUPPORTED_FEATURE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface TwiceshyErrorOptions {
  what?: string;
  why?: string;
  fix?: string;
  fingerprint?: string;
  recordId?: string;
  cause?: unknown;
}

export interface TwiceshyErrorJSON {
  code: ErrorCode;
  what: string;
  why: string;
  fix: string;
  fingerprint: string | undefined;
  recordId: string | undefined;
  cause: unknown;
}

interface ErrorDefaults {
  what: string;
  why: string;
  fix: string;
}

export class TwiceshyError extends Error {
  readonly code: ErrorCode;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly fingerprint: string | undefined;
  readonly recordId: string | undefined;

  constructor(code: ErrorCode, defaults: ErrorDefaults, options: TwiceshyErrorOptions = {}) {
    const what = options.what ?? defaults.what;
    const why = options.why ?? defaults.why;
    const fix = options.fix ?? defaults.fix;
    super(`${what} Why: ${why} Fix: ${fix}`, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.what = what;
    this.why = why;
    this.fix = fix;
    this.fingerprint = options.fingerprint;
    this.recordId = options.recordId;
  }

  /** All fields, safe to log or send to an agent. Never includes the stack. */
  toJSON(): TwiceshyErrorJSON {
    const cause =
      this.cause instanceof Error
        ? { name: this.cause.name, message: this.cause.message }
        : this.cause;
    return {
      code: this.code,
      what: this.what,
      why: this.why,
      fix: this.fix,
      fingerprint: this.fingerprint,
      recordId: this.recordId,
      cause,
    };
  }
}

export class InDoubtError extends TwiceshyError {
  constructor(options: TwiceshyErrorOptions = {}) {
    super(
      'IN_DOUBT',
      {
        what:
          options.recordId === undefined
            ? 'The action is in doubt: it may or may not have happened.'
            : `The action in record "${options.recordId}" is in doubt.`,
        why: 'A previous attempt stopped without confirming whether it completed, so running it again could duplicate it.',
        fix:
          options.recordId === undefined
            ? 'A person must check whether the action happened, then run `twiceshy resolve <id> --succeeded` or `--failed`. Do not retry.'
            : `A person must check whether the action happened, then run \`twiceshy resolve ${options.recordId} --succeeded\` or \`--failed\`. Do not retry.`,
      },
      options,
    );
  }
}

export class InProgressError extends TwiceshyError {
  constructor(options: TwiceshyErrorOptions = {}) {
    super(
      'IN_PROGRESS',
      {
        what: 'The action is still in progress.',
        why: 'An identical call is already running and did not finish within the allowed wait time.',
        fix: 'Wait a moment, then call again. The first call may still complete.',
      },
      options,
    );
  }
}

export interface KeyConflictErrorOptions extends TwiceshyErrorOptions {
  key?: string;
}

export class KeyConflictError extends TwiceshyError {
  constructor(options: KeyConflictErrorOptions = {}) {
    super(
      'KEY_CONFLICT',
      {
        what:
          options.key === undefined
            ? 'The explicit key was already used for a different action.'
            : `The explicit key "${options.key}" was already used for a different action.`,
        why: 'The same explicit key arrived with different arguments, so it cannot refer to the same action.',
        fix: 'Use a new key for a new action.',
      },
      options,
    );
  }
}

export interface NotSerializableErrorOptions extends TwiceshyErrorOptions {
  path?: string;
}

export class NotSerializableError extends TwiceshyError {
  constructor(options: NotSerializableErrorOptions = {}) {
    super(
      'NOT_SERIALIZABLE',
      {
        what:
          options.path === undefined
            ? 'The arguments or result cannot be serialized.'
            : `The value at "${options.path}" cannot be serialized.`,
        why: 'They contain a value that cannot be stored, such as a circular reference, a function, NaN, or Infinity.',
        fix: 'Remove functions, circular data, NaN, or Infinity, or set storeResult: false.',
      },
      options,
    );
  }
}

export interface StoreUnavailableErrorOptions extends TwiceshyErrorOptions {
  path?: string;
}

export class StoreUnavailableError extends TwiceshyError {
  constructor(options: StoreUnavailableErrorOptions = {}) {
    super(
      'STORE_UNAVAILABLE',
      {
        what: 'The action store is unavailable.',
        why:
          options.path === undefined
            ? 'Twiceshy could not read from or write to the database.'
            : `Twiceshy could not read from or write to the database at "${options.path}".`,
        fix: 'Check the file path and permissions. Guarded actions are paused for safety.',
      },
      options,
    );
  }
}

export interface ConfigInvalidErrorOptions extends TwiceshyErrorOptions {
  issues?: readonly string[];
}

export class ConfigInvalidError extends TwiceshyError {
  constructor(options: ConfigInvalidErrorOptions = {}) {
    const issues = options.issues ?? [];
    super(
      'CONFIG_INVALID',
      {
        what: 'The configuration is invalid.',
        why:
          issues.length > 0
            ? `One or more configuration values failed validation: ${issues.join('; ')}.`
            : 'One or more configuration values failed validation.',
        fix: 'Fix the listed fields and try again. Each message names the field, the expected value, and an example.',
      },
      options,
    );
  }
}

export interface ResultTooLargeErrorOptions extends TwiceshyErrorOptions {
  sizeBytes?: number;
  maxBytes?: number;
}

export class ResultTooLargeError extends TwiceshyError {
  constructor(options: ResultTooLargeErrorOptions = {}) {
    const sizesKnown = options.sizeBytes !== undefined && options.maxBytes !== undefined;
    super(
      'RESULT_TOO_LARGE',
      {
        what: sizesKnown
          ? `The result is too large to store: ${options.sizeBytes} bytes (limit: ${options.maxBytes} bytes).`
          : 'The result is too large to store.',
        why: 'The result is above the maxResultBytes limit.',
        fix: 'Raise the limit or set storeResult: false. Duplicates will then return a summary, not the full result.',
      },
      options,
    );
  }
}

export interface DownstreamUnavailableErrorOptions extends TwiceshyErrorOptions {
  server?: string;
}

export class DownstreamUnavailableError extends TwiceshyError {
  constructor(options: DownstreamUnavailableErrorOptions = {}) {
    super(
      'DOWNSTREAM_UNAVAILABLE',
      {
        what:
          options.server === undefined
            ? 'A downstream MCP server is unavailable.'
            : `The downstream MCP server "${options.server}" is unavailable.`,
        why: 'Twiceshy could not connect to the server, or the connection dropped while calling it.',
        fix: 'Check the server command or URL in config.',
      },
      options,
    );
  }
}

export interface UnsupportedFeatureErrorOptions extends TwiceshyErrorOptions {
  feature?: string;
}

export class UnsupportedFeatureError extends TwiceshyError {
  constructor(options: UnsupportedFeatureErrorOptions = {}) {
    super(
      'UNSUPPORTED_FEATURE',
      {
        what:
          options.feature === undefined
            ? 'This feature is not supported by Twiceshy v1.'
            : `The feature "${options.feature}" is not supported by Twiceshy v1.`,
        why: 'The feature is planned for v1.1 and is refused rather than silently dropped.',
        fix: 'Remove the feature from your setup for now, or wait for v1.1.',
      },
      options,
    );
  }
}

const DEFINITE_FAILURE = Symbol('twiceshy.definiteFailure');

/**
 * Marks an error as a definite failure, meaning the action certainly did not
 * happen and is safe to retry. The marker uses a symbol, so it can never
 * collide with a user property, and it does not show up in JSON.
 */
export function definiteFailure<T>(error: T): T {
  if (typeof error === 'object' && error !== null) {
    Object.defineProperty(error, DEFINITE_FAILURE, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return error;
}

/** True when `definiteFailure` was applied to this value. */
export function isDefiniteFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { [DEFINITE_FAILURE]?: unknown })[DEFINITE_FAILURE] === true
  );
}

/** Type guard: true when `value` is a TwiceshyError. */
export function isTwiceshyError(value: unknown): value is TwiceshyError {
  return value instanceof TwiceshyError;
}
