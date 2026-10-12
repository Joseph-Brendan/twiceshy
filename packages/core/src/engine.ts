import { StoreUnavailableError } from './errors.js';

/**
 * The C6 decision engine, as pure functions only.
 *
 * Nothing in this module reads the clock, touches a database, or performs
 * I/O. Time always arrives as a `now: Date` parameter, so every decision is
 * deterministic and can be tested exhaustively. Stores call these functions
 * inside their atomic transactions and persist the returned patches.
 */

export type RecordState =
  | 'IN_FLIGHT'
  | 'SUCCEEDED'
  | 'FAILED_DEFINITE'
  | 'IN_DOUBT'
  | 'RESOLVED_SUCCEEDED'
  | 'RESOLVED_FAILED';

/** A human-approved repeat that has not been consumed yet. */
export interface EngineRepeatGrant {
  grantedAt: Date;
}

/** The fields of an action record the engine reasons about. */
export interface EngineRecord {
  /** Store-assigned id, used to name the record in error messages. */
  id?: string;
  fingerprint: string;
  state: RecordState;
  attempt: number;
  /** Lease deadline while IN_FLIGHT; null otherwise. */
  leaseUntil: Date | null;
  /** When the action finished, when known. */
  completedAt: Date | null;
  /** Stored result for a successful action. */
  result: unknown;
  /** Set by allowRepeat; consumed by the next execution. */
  repeatGrant: EngineRepeatGrant | null;
}

/** The changes a decision asks the store to apply. */
export interface RecordPatch {
  state?: RecordState;
  attempt?: number;
  leaseUntil?: Date | null;
  completedAt?: Date | null;
  result?: unknown;
  repeatGrant?: EngineRepeatGrant | null;
}

export interface EngineSettings {
  /** How long after completion an identical action counts as a duplicate. */
  windowMs: number;
  /** How long a second caller waits for an IN_FLIGHT action. */
  waitForInFlightMs: number;
  /** Claim duration; callers pass timeoutMs + 30s. */
  leaseMs: number;
}

export interface DecisionRequest {
  fingerprint: string;
  /** Present when the caller supplied an explicit key as the identity. */
  explicitKey?: string;
}

export type DecisionKind =
  | 'execute'
  | 'duplicate'
  | 'wait'
  | 'block-in-doubt'
  | 'reject-key-conflict';

export type Decision =
  | { kind: 'execute'; changes: RecordPatch; archiveExisting: boolean }
  | {
      kind: 'duplicate';
      changes: RecordPatch;
      originalResult: unknown;
      originalAt: Date | null;
    }
  | { kind: 'wait'; changes: RecordPatch; waitMs: number }
  | { kind: 'block-in-doubt'; changes: RecordPatch }
  | { kind: 'reject-key-conflict'; changes: RecordPatch };

export type ExecutionOutcome =
  | { type: 'success'; result: unknown }
  | { type: 'definite-failure' }
  | { type: 'ambiguous-failure' }
  | { type: 'cancelled' }
  /** C20 rule 4: cancelled after the claim but before the tool was invoked. */
  | { type: 'cancelled-before-start' };

/**
 * The defensive never check. A stored record in a state this engine does not
 * recognise means the database may be corrupted or written by a newer
 * Twiceshy version, so the safe move is to refuse with STORE_UNAVAILABLE
 * rather than guess. The same applies to an unknown execution outcome.
 */
function unhandledEngineValue(subject: string, value: unknown, recordId?: string): never {
  throw new StoreUnavailableError({
    ...(recordId === undefined ? {} : { recordId }),
    what: `The engine received an unknown ${subject}: ${String(value)}.`,
    why: 'The stored record has an unknown state, possibly from database corruption or from a newer Twiceshy version.',
    fix: 'Upgrade Twiceshy, or inspect the record with `twiceshy show`.',
  });
}

/** The lease deadline for a claim that starts at `now`. */
export function nextLeaseExpiry(now: Date, settings: EngineSettings): Date {
  return new Date(now.getTime() + settings.leaseMs);
}

/** True when the record's lease is missing or no longer valid at `now`. */
export function leaseExpired(record: EngineRecord, now: Date): boolean {
  return record.leaseUntil === null || record.leaseUntil.getTime() <= now.getTime();
}

function hasActiveGrant(record: EngineRecord): boolean {
  return record.repeatGrant !== null;
}

function isInsideWindow(record: EngineRecord, now: Date, windowMs: number): boolean {
  if (record.completedAt === null) {
    // Completion time unknown: treat as a duplicate, the safe direction.
    return true;
  }
  return now.getTime() - record.completedAt.getTime() < windowMs;
}

function startAttempt(attempt: number, now: Date, settings: EngineSettings): RecordPatch {
  return {
    state: 'IN_FLIGHT',
    attempt,
    leaseUntil: nextLeaseExpiry(now, settings),
    completedAt: null,
    result: undefined,
  };
}

/**
 * Implements every row of the C6 decision table and returns a typed decision
 * plus the record patch to apply. Never mutates `existing`.
 */
export function decide(
  existing: EngineRecord | null,
  request: DecisionRequest,
  now: Date,
  settings: EngineSettings,
): Decision {
  if (
    existing !== null &&
    request.explicitKey !== undefined &&
    existing.fingerprint !== request.fingerprint
  ) {
    return { kind: 'reject-key-conflict', changes: {} };
  }
  if (existing === null) {
    return { kind: 'execute', changes: startAttempt(1, now, settings), archiveExisting: false };
  }
  switch (existing.state) {
    case 'SUCCEEDED':
    case 'RESOLVED_SUCCEEDED': {
      if (!isInsideWindow(existing, now, settings.windowMs)) {
        return {
          kind: 'execute',
          changes: { ...startAttempt(1, now, settings), repeatGrant: null },
          archiveExisting: true,
        };
      }
      if (hasActiveGrant(existing)) {
        return {
          kind: 'execute',
          changes: { ...startAttempt(existing.attempt + 1, now, settings), repeatGrant: null },
          archiveExisting: false,
        };
      }
      return {
        kind: 'duplicate',
        changes: {},
        originalResult: existing.result,
        originalAt: existing.completedAt,
      };
    }
    case 'IN_FLIGHT':
      if (leaseExpired(existing, now)) {
        return {
          kind: 'block-in-doubt',
          changes: { state: 'IN_DOUBT', leaseUntil: null },
        };
      }
      return { kind: 'wait', changes: {}, waitMs: settings.waitForInFlightMs };
    case 'FAILED_DEFINITE':
    case 'RESOLVED_FAILED':
      return {
        kind: 'execute',
        changes: startAttempt(existing.attempt + 1, now, settings),
        archiveExisting: false,
      };
    case 'IN_DOUBT':
      return { kind: 'block-in-doubt', changes: {} };
    default:
      return unhandledEngineValue('record state', existing.state, existing.id);
  }
}

/**
 * Implements the C6 "after execution" rules: success stores the result,
 * definite failure is safe to retry, ambiguous failure and cancellation leave
 * the record IN_DOUBT. Returns the patch to persist.
 */
export function afterExecution(
  record: EngineRecord,
  outcome: ExecutionOutcome,
  now: Date,
  _settings: EngineSettings,
): RecordPatch {
  switch (outcome.type) {
    case 'success':
      return { state: 'SUCCEEDED', completedAt: now, leaseUntil: null, result: outcome.result };
    case 'definite-failure':
    case 'cancelled-before-start':
      return {
        state: 'FAILED_DEFINITE',
        completedAt: now,
        leaseUntil: null,
        result: undefined,
      };
    case 'ambiguous-failure':
    case 'cancelled':
      return { state: 'IN_DOUBT', leaseUntil: null };
    default:
      return unhandledEngineValue(
        'execution outcome',
        (outcome as { type?: unknown }).type,
        record.id,
      );
  }
}

/**
 * A result that arrives after the record was marked IN_DOUBT upgrades it to
 * SUCCEEDED or FAILED_DEFINITE. Callers emit the late-completion event when
 * the returned patch is not empty.
 */
export function lateCompletion(
  record: EngineRecord,
  outcome: ExecutionOutcome,
  now: Date,
): RecordPatch {
  if (record.state !== 'IN_DOUBT') {
    return {};
  }
  switch (outcome.type) {
    case 'success':
      return { state: 'SUCCEEDED', completedAt: now, leaseUntil: null, result: outcome.result };
    case 'definite-failure':
    case 'cancelled-before-start':
      return {
        state: 'FAILED_DEFINITE',
        completedAt: now,
        leaseUntil: null,
        result: undefined,
      };
    case 'ambiguous-failure':
    case 'cancelled':
      return {};
    default:
      return unhandledEngineValue(
        'completion outcome',
        (outcome as { type?: unknown }).type,
        record.id,
      );
  }
}

/** The record as a claim sees it: the attempt number plus its claim token. */
export interface EngineClaimedRecord extends EngineRecord {
  attemptToken: string;
}

/** What `complete()` did, decided by the pure rules in C20 rule 1. */
export type CompletionPath =
  | 'outcome'
  | 'late-completion'
  | 'agrees-with-resolution'
  | 'resolution-conflict'
  | 'changed';

export interface CompletionDecision {
  path: CompletionPath;
  patch: RecordPatch;
}

export interface CompletionRequest {
  /** The claim token returned by `begin`; only its owner may complete normally. */
  attemptToken: string;
  outcome: ExecutionOutcome;
}

/**
 * The conditional completion rules from C20. A normal completion writes only
 * when the record is still IN_FLIGHT and claimed by the same attempt token.
 * Everything else is routed to the late-completion, human-resolution, or
 * "record changed" path. Stores run this inside the same atomic operation
 * that reads the record, so two processes can never both write.
 */
export function completeRecord(
  record: EngineClaimedRecord,
  request: CompletionRequest,
  now: Date,
  settings: EngineSettings,
): CompletionDecision {
  if (record.state === 'IN_FLIGHT') {
    if (record.attemptToken !== request.attemptToken) {
      return { path: 'changed', patch: {} };
    }
    return { path: 'outcome', patch: afterExecution(record, request.outcome, now, settings) };
  }
  if (record.state === 'IN_DOUBT') {
    return { path: 'late-completion', patch: lateCompletion(record, request.outcome, now) };
  }
  if (record.state === 'RESOLVED_FAILED') {
    if (
      request.outcome.type === 'definite-failure' ||
      request.outcome.type === 'cancelled-before-start'
    ) {
      return { path: 'agrees-with-resolution', patch: {} };
    }
    // The human said "failed" but the action may have happened after all.
    // Block the next identical call with IN_DOUBT until a person decides
    // again; the human's name and note stay on the record (C20 rule 3).
    return { path: 'resolution-conflict', patch: { state: 'IN_DOUBT', leaseUntil: null } };
  }
  if (record.state === 'RESOLVED_SUCCEEDED') {
    if (request.outcome.type === 'success') {
      return { path: 'agrees-with-resolution', patch: {} };
    }
    // The next call is a duplicate anyway, so no state change is needed.
    return { path: 'resolution-conflict', patch: {} };
  }
  if (record.state === 'SUCCEEDED' || record.state === 'FAILED_DEFINITE') {
    return { path: 'changed', patch: {} };
  }
  return unhandledEngineValue('record state', record.state, record.id);
}
