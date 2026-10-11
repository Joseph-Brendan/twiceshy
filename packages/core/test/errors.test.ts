import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '../src/index.js';
import {
  ConfigInvalidError,
  DownstreamUnavailableError,
  definiteFailure,
  ERROR_CODES,
  InDoubtError,
  InProgressError,
  isDefiniteFailure,
  isTwiceshyError,
  KeyConflictError,
  NotSerializableError,
  ResultTooLargeError,
  StoreUnavailableError,
  TwiceshyError,
  UnsupportedFeatureError,
} from '../src/index.js';

const FACTORIES: Record<ErrorCode, () => TwiceshyError> = {
  IN_DOUBT: () => new InDoubtError(),
  IN_PROGRESS: () => new InProgressError(),
  KEY_CONFLICT: () => new KeyConflictError(),
  NOT_SERIALIZABLE: () => new NotSerializableError(),
  STORE_UNAVAILABLE: () => new StoreUnavailableError(),
  CONFIG_INVALID: () => new ConfigInvalidError(),
  RESULT_TOO_LARGE: () => new ResultTooLargeError(),
  DOWNSTREAM_UNAVAILABLE: () => new DownstreamUnavailableError(),
  UNSUPPORTED_FEATURE: () => new UnsupportedFeatureError(),
};

describe('TwiceshyError', () => {
  it('C4: every TwiceshyError code has non-empty what, why, and fix, and toJSON() output has no stack trace', () => {
    for (const code of ERROR_CODES) {
      const error = FACTORIES[code]();
      expect(error).toBeInstanceOf(TwiceshyError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name.length).toBeGreaterThan(0);
      expect(error.what.trim().length).toBeGreaterThan(0);
      expect(error.why.trim().length).toBeGreaterThan(0);
      expect(error.fix.trim().length).toBeGreaterThan(0);
      expect(error.message).toContain(error.what);
      expect(error.message).toContain(error.why);
      expect(error.message).toContain(error.fix);
      const json = error.toJSON();
      expect(json.code).toBe(code);
      expect(json.what).toBe(error.what);
      expect(json.why).toBe(error.why);
      expect(json.fix).toBe(error.fix);
      expect('stack' in json).toBe(false);
      expect(JSON.stringify(json)).not.toContain('stack');
    }
  });

  it('joins what, why, and fix into a readable message', () => {
    const error = new TwiceshyError('CONFIG_INVALID', { what: 'A.', why: 'B.', fix: 'C.' });
    expect(error.message).toBe('A. Why: B. Fix: C.');
  });

  it('keeps fingerprint, recordId, and cause, and serialises an Error cause safely', () => {
    const cause = new Error('connection reset');
    const error = new InDoubtError({ fingerprint: 'fp1', recordId: 'rec1', cause });
    expect(error.fingerprint).toBe('fp1');
    expect(error.recordId).toBe('rec1');
    expect(error.cause).toBe(cause);
    const json = error.toJSON();
    expect(json.fingerprint).toBe('fp1');
    expect(json.recordId).toBe('rec1');
    expect(json.cause).toEqual({ name: 'Error', message: 'connection reset' });
  });

  it('passes a non-Error cause through toJSON unchanged', () => {
    const error = new InProgressError({ cause: 'timed out' });
    expect(error.toJSON().cause).toBe('timed out');
  });

  it('isTwiceshyError recognises Twiceshy errors and rejects other values', () => {
    expect(isTwiceshyError(new InDoubtError())).toBe(true);
    expect(isTwiceshyError(new Error('plain'))).toBe(false);
    expect(isTwiceshyError(null)).toBe(false);
    expect(isTwiceshyError('IN_DOUBT')).toBe(false);
  });

  it('definiteFailure marks the same error object with a non-enumerable symbol', () => {
    const error = new Error('rejected');
    const marked = definiteFailure(error);
    expect(marked).toBe(error);
    expect(isDefiniteFailure(error)).toBe(true);
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe('{}');
    expect(isDefiniteFailure(new Error('other'))).toBe(false);
  });

  it('definiteFailure leaves primitives and null unchanged and unmarked', () => {
    expect(definiteFailure('boom')).toBe('boom');
    expect(isDefiniteFailure('boom')).toBe(false);
    expect(definiteFailure(null)).toBeNull();
    expect(isDefiniteFailure(null)).toBe(false);
  });
});

describe('error context', () => {
  it('InDoubtError names the record and the resolve command when a record id is given', () => {
    const error = new InDoubtError({ recordId: 'rec-9' });
    expect(error.what).toContain('rec-9');
    expect(error.fix).toContain('twiceshy resolve rec-9');
  });

  it('KeyConflictError names the explicit key when given', () => {
    const error = new KeyConflictError({ key: 'refund-order-7' });
    expect(error.what).toContain('refund-order-7');
  });

  it('NotSerializableError names the field path when given', () => {
    const error = new NotSerializableError({ path: 'card.number' });
    expect(error.what).toContain('card.number');
  });

  it('StoreUnavailableError names the database path when given', () => {
    const error = new StoreUnavailableError({ path: '/tmp/actions.db' });
    expect(error.why).toContain('/tmp/actions.db');
  });

  it('ConfigInvalidError lists every issue when given', () => {
    const error = new ConfigInvalidError({
      issues: ['window: expected a duration like "10m"', 'store: expected an object'],
    });
    expect(error.why).toContain('window: expected a duration like "10m"');
    expect(error.why).toContain('store: expected an object');
  });

  it('ResultTooLargeError reports both sizes when both are given', () => {
    const error = new ResultTooLargeError({ sizeBytes: 300_000, maxBytes: 262_144 });
    expect(error.what).toContain('300000');
    expect(error.what).toContain('262144');
  });

  it('ResultTooLargeError falls back to the generic message when a size is missing', () => {
    const error = new ResultTooLargeError({ sizeBytes: 300_000 });
    expect(error.what).toBe('The result is too large to store.');
  });

  it('DownstreamUnavailableError names the server when given', () => {
    const error = new DownstreamUnavailableError({ server: 'paystack' });
    expect(error.what).toContain('paystack');
  });

  it('UnsupportedFeatureError names the feature when given', () => {
    const error = new UnsupportedFeatureError({ feature: 'sampling' });
    expect(error.what).toContain('sampling');
  });

  it('InProgressError stores context while keeping its default message', () => {
    const error = new InProgressError({ fingerprint: 'fp' });
    expect(error.fingerprint).toBe('fp');
    expect(error.why.length).toBeGreaterThan(0);
  });
});
