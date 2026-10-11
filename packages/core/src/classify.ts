import { ZodError } from 'zod';
import { isDefiniteFailure } from './errors.js';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolInfo {
  name?: string;
  annotations?: ToolAnnotations | null;
}

export interface GuardSettings {
  /** Explicit developer choice; always wins (C3 rule 1). */
  guard?: boolean;
  /** Trust MCP idempotentHint annotations. Default true. */
  trustIdempotentHint?: boolean;
}

export interface GuardDecision {
  guarded: boolean;
  reason: string;
}

/**
 * Applies the C3 rules in exact order: explicit config first, then MCP
 * annotations (readOnlyHint, then idempotentHint), then the guarded default.
 * The reason is a short plain sentence for the doctor command.
 */
export function shouldGuard(toolInfo: ToolInfo, config: GuardSettings = {}): GuardDecision {
  if (config.guard !== undefined) {
    return { guarded: config.guard, reason: `config: guard ${config.guard}` };
  }
  const annotations = toolInfo.annotations ?? null;
  if (annotations === null) {
    return { guarded: true, reason: 'no annotation, default' };
  }
  if (annotations.readOnlyHint === true) {
    return { guarded: false, reason: 'annotation: readOnlyHint' };
  }
  if (annotations.idempotentHint === true) {
    if (config.trustIdempotentHint ?? true) {
      return { guarded: false, reason: 'annotation: idempotentHint (trusted)' };
    }
    return { guarded: true, reason: 'annotation: idempotentHint (not trusted)' };
  }
  if (annotations.destructiveHint === true) {
    return { guarded: true, reason: 'annotation: destructiveHint' };
  }
  return { guarded: true, reason: 'annotation: no read-only or idempotent hint' };
}

export type FailureClassification = 'definite' | 'ambiguous';

export type CustomErrorClassifier = (error: unknown) => unknown;

export interface ClassifyErrorOptions {
  /** Replaces the built-in C7 rules. Invalid results fall back to ambiguous. */
  classifier?: CustomErrorClassifier;
}

export interface ClassificationResult {
  classification: FailureClassification;
  /**
   * Present only when a custom classifier misbehaved. The fallback is always
   * "ambiguous", reported here instead of thrown.
   */
  warning?: string;
}

const DEFINITE_HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

const JSON_RPC_UNKNOWN_TOOL = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDefiniteJsonRpcCode(value: unknown): boolean {
  return value === JSON_RPC_UNKNOWN_TOOL || value === JSON_RPC_INVALID_PARAMS;
}

function isJsonRpcDefinite(record: Record<string, unknown>): boolean {
  if (isDefiniteJsonRpcCode(record.code)) {
    return true;
  }
  const nested = record.error;
  if (isRecord(nested)) {
    return isDefiniteJsonRpcCode(nested.code);
  }
  return false;
}

function toStatusCode(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d{3}$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function isDefiniteHttpStatus(value: unknown): boolean {
  const status = toStatusCode(value);
  return status !== undefined && DEFINITE_HTTP_STATUSES.has(status);
}

function hasDefiniteHttpStatus(record: Record<string, unknown>): boolean {
  if (isDefiniteHttpStatus(record.status)) {
    return true;
  }
  if (isDefiniteHttpStatus(record.statusCode)) {
    return true;
  }
  const response = record.response;
  return isRecord(response) && isDefiniteHttpStatus(response.status);
}

/**
 * The C7 default rules. Wrapped in a try/catch by the caller because hostile
 * inputs (getters that throw, proxies) must never make classifyError throw.
 */
function inspectError(error: unknown): FailureClassification {
  if (isDefiniteFailure(error)) {
    return 'definite';
  }
  if (error instanceof ZodError) {
    return 'definite';
  }
  if (typeof error !== 'object' && typeof error !== 'function') {
    return 'ambiguous';
  }
  if (error === null) {
    return 'ambiguous';
  }
  const record = error as Record<string, unknown>;
  if (record.name === 'ZodError') {
    return 'definite';
  }
  if (isJsonRpcDefinite(record)) {
    return 'definite';
  }
  if (hasDefiniteHttpStatus(record)) {
    return 'definite';
  }
  return 'ambiguous';
}

function describeOutcome(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'an unprintable value';
  }
}

function runCustomClassifier(
  classifier: CustomErrorClassifier,
  error: unknown,
): ClassificationResult {
  let outcome: unknown;
  try {
    outcome = classifier(error);
  } catch {
    return {
      classification: 'ambiguous',
      warning: 'Custom classifier threw; falling back to "ambiguous".',
    };
  }
  if (outcome === 'definite' || outcome === 'ambiguous') {
    return { classification: outcome };
  }
  return {
    classification: 'ambiguous',
    warning: `Custom classifier returned ${describeOutcome(outcome)}; falling back to "ambiguous".`,
  };
}

/**
 * Classifies a thrown error as a definite or ambiguous failure per C7.
 *
 * Returns a result object rather than a bare string so a misbehaving custom
 * classifier can be reported through `warning` (never thrown). Unknown,
 * hostile, or unrecognised inputs always fall back to "ambiguous", because a
 * wrong "definite" answer is the expensive mistake.
 */
export function classifyError(
  error: unknown,
  options: ClassifyErrorOptions = {},
): ClassificationResult {
  const classifier = options.classifier;
  if (classifier === undefined) {
    try {
      return { classification: inspectError(error) };
    } catch {
      return { classification: 'ambiguous' };
    }
  }
  return runCustomClassifier(classifier, error);
}

export interface ClassifyToolResultOptions {
  /** Config: treat this tool's isError results as definite. Default false. */
  treatToolErrorsAsDefinite?: boolean;
}

/**
 * Classifies an MCP tool result. A result with `isError: true` is ambiguous by
 * default, because many tools fail before acting but Twiceshy cannot know.
 * Returns null when the result is not an error, so the caller knows there is
 * nothing to classify.
 */
export function classifyToolResult(
  result: unknown,
  options: ClassifyToolResultOptions = {},
): FailureClassification | null {
  try {
    if (!isRecord(result) || result.isError !== true) {
      return null;
    }
    return options.treatToolErrorsAsDefinite === true ? 'definite' : 'ambiguous';
  } catch {
    return 'ambiguous';
  }
}
