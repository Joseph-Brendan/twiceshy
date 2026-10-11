import type { EngineRecord, RecordPatch } from '../engine.js';
import { StoreUnavailableError } from '../errors.js';
import type { ActionRecord } from './types.js';

/** Maps a stored record onto the pure engine's view. */
export function toEngineRecord(record: ActionRecord): EngineRecord {
  return {
    id: record.id,
    fingerprint: record.fingerprint,
    state: record.state,
    attempt: record.attempt,
    leaseUntil: record.leaseExpiresAt,
    completedAt: record.completedAt,
    result: record.result,
    repeatGrant: record.repeatGrant,
  };
}

/** Applies an engine patch to a record, returning a new object. */
export function applyPatch(record: ActionRecord, patch: RecordPatch): ActionRecord {
  return {
    ...record,
    state: patch.state ?? record.state,
    leaseExpiresAt: patch.leaseUntil === undefined ? record.leaseExpiresAt : patch.leaseUntil,
    completedAt: patch.completedAt === undefined ? record.completedAt : patch.completedAt,
    result: 'result' in patch ? patch.result : record.result,
  };
}

/** A consistent STORE_UNAVAILABLE for a record id the store does not have. */
export function recordNotFound(id: string): StoreUnavailableError {
  return new StoreUnavailableError({
    recordId: id,
    what: `The record "${id}" was not found in the store.`,
    why: 'The record was purged or never existed, but the caller expected it to be present.',
    fix: 'Check the record id, or list the current records with `twiceshy list`.',
  });
}
