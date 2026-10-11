import { describe, expect, it } from 'vitest';
import type {
  DecisionKind,
  EngineRecord,
  EngineSettings,
  ExecutionOutcome,
  RecordState,
} from '../src/index.js';
import {
  afterExecution,
  decide,
  lateCompletion,
  leaseExpired,
  nextLeaseExpiry,
} from '../src/index.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const SETTINGS: EngineSettings = {
  windowMs: 600_000,
  waitForInFlightMs: 5_000,
  leaseMs: 30_000,
};
const REQUEST = { fingerprint: 'fp-1' };

function makeRecord(overrides: Partial<EngineRecord> = {}): EngineRecord {
  return {
    fingerprint: 'fp-1',
    state: 'SUCCEEDED',
    attempt: 1,
    leaseUntil: null,
    completedAt: new Date(NOW.getTime() - 1_000),
    result: { ok: true },
    repeatGrant: null,
    ...overrides,
  };
}

interface TableRow {
  existing: RecordState | null;
  condition: string;
  record?: Partial<EngineRecord>;
  expect: DecisionKind;
  expectState: RecordState;
  runs: boolean;
  expectAttempt?: number;
}

const TABLE: TableRow[] = [
  {
    existing: null,
    condition: 'no record',
    expect: 'execute',
    expectState: 'IN_FLIGHT',
    runs: true,
    expectAttempt: 1,
  },
  {
    existing: 'SUCCEEDED',
    condition: 'inside window',
    record: { completedAt: new Date(NOW.getTime() - 60_000) },
    expect: 'duplicate',
    expectState: 'SUCCEEDED',
    runs: false,
  },
  {
    existing: 'SUCCEEDED',
    condition: 'window passed',
    record: { completedAt: new Date(NOW.getTime() - SETTINGS.windowMs - 1) },
    expect: 'execute',
    expectState: 'IN_FLIGHT',
    runs: true,
    expectAttempt: 1,
  },
  {
    existing: 'SUCCEEDED',
    condition: 'completion time unknown',
    record: { completedAt: null },
    expect: 'duplicate',
    expectState: 'SUCCEEDED',
    runs: false,
  },
  {
    existing: 'RESOLVED_SUCCEEDED',
    condition: 'inside window',
    record: { completedAt: new Date(NOW.getTime() - 60_000) },
    expect: 'duplicate',
    expectState: 'RESOLVED_SUCCEEDED',
    runs: false,
  },
  {
    existing: 'RESOLVED_SUCCEEDED',
    condition: 'window passed',
    record: { completedAt: new Date(NOW.getTime() - SETTINGS.windowMs - 1) },
    expect: 'execute',
    expectState: 'IN_FLIGHT',
    runs: true,
    expectAttempt: 1,
  },
  {
    existing: 'IN_FLIGHT',
    condition: 'lease still valid',
    record: { leaseUntil: new Date(NOW.getTime() + 1_000) },
    expect: 'wait',
    expectState: 'IN_FLIGHT',
    runs: false,
  },
  {
    existing: 'IN_FLIGHT',
    condition: 'lease expired',
    record: { leaseUntil: new Date(NOW.getTime() - 1) },
    expect: 'block-in-doubt',
    expectState: 'IN_DOUBT',
    runs: false,
  },
  {
    existing: 'IN_FLIGHT',
    condition: 'lease missing',
    record: { leaseUntil: null },
    expect: 'block-in-doubt',
    expectState: 'IN_DOUBT',
    runs: false,
  },
  {
    existing: 'FAILED_DEFINITE',
    condition: 'any',
    record: { attempt: 3 },
    expect: 'execute',
    expectState: 'IN_FLIGHT',
    runs: true,
    expectAttempt: 4,
  },
  {
    existing: 'RESOLVED_FAILED',
    condition: 'any',
    record: { attempt: 2 },
    expect: 'execute',
    expectState: 'IN_FLIGHT',
    runs: true,
    expectAttempt: 3,
  },
  {
    existing: 'IN_DOUBT',
    condition: 'any',
    expect: 'block-in-doubt',
    expectState: 'IN_DOUBT',
    runs: false,
  },
];

describe('decide', () => {
  it('D1: the decision table implements every row of C6', () => {
    for (const row of TABLE) {
      const existing =
        row.existing === null ? null : makeRecord({ state: row.existing, ...row.record });
      const snapshot = existing === null ? null : structuredClone(existing);
      const decision = decide(existing, REQUEST, NOW, SETTINGS);
      const label = `${row.existing ?? 'None'} / ${row.condition}`;

      expect(decision.kind, label).toBe(row.expect);
      const resultingState = decision.changes.state ?? existing?.state ?? 'IN_FLIGHT';
      expect(resultingState, label).toBe(row.expectState);
      expect(decision.kind === 'execute', label).toBe(row.runs);
      if (row.expectAttempt !== undefined && decision.kind === 'execute') {
        expect(decision.changes.attempt, label).toBe(row.expectAttempt);
      }
      if (existing !== null && snapshot !== null) {
        expect(existing, label).toEqual(snapshot);
      }
    }
  });

  it('an execute decision claims the record with a fresh lease', () => {
    const decision = decide(null, REQUEST, NOW, SETTINGS);
    expect(decision.kind).toBe('execute');
    expect(decision.changes.state).toBe('IN_FLIGHT');
    expect(decision.changes.leaseUntil).toEqual(nextLeaseExpiry(NOW, SETTINGS));
    expect(decision.changes.completedAt).toBeNull();
    if (decision.kind === 'execute') {
      expect(decision.archiveExisting).toBe(false);
    }
  });

  it('a window-passed execute archives the old record and clears its result and grant', () => {
    const old = makeRecord({
      completedAt: new Date(NOW.getTime() - SETTINGS.windowMs - 1),
      repeatGrant: { grantedAt: NOW },
    });
    const decision = decide(old, REQUEST, NOW, SETTINGS);
    expect(decision.kind).toBe('execute');
    if (decision.kind === 'execute') {
      expect(decision.archiveExisting).toBe(true);
    }
    expect('result' in decision.changes && decision.changes.result === undefined).toBe(true);
    expect(decision.changes.repeatGrant).toBeNull();
  });

  it('a duplicate decision returns the stored result and its completion time', () => {
    const completedAt = new Date(NOW.getTime() - 1_000);
    const record = makeRecord({ completedAt, result: { receipt: 'R1' } });
    const decision = decide(record, REQUEST, NOW, SETTINGS);
    expect(decision.kind).toBe('duplicate');
    if (decision.kind === 'duplicate') {
      expect(decision.originalResult).toEqual({ receipt: 'R1' });
      expect(decision.originalAt).toEqual(completedAt);
    }
  });

  it('a wait decision reports the configured wait time', () => {
    const record = makeRecord({
      state: 'IN_FLIGHT',
      leaseUntil: new Date(NOW.getTime() + 1_000),
    });
    const decision = decide(record, REQUEST, NOW, SETTINGS);
    expect(decision.kind).toBe('wait');
    if (decision.kind === 'wait') {
      expect(decision.waitMs).toBe(SETTINGS.waitForInFlightMs);
    }
  });

  it('D2: window boundaries: one millisecond before the end is a duplicate, at and after it executes', () => {
    const inside = makeRecord({
      completedAt: new Date(NOW.getTime() - SETTINGS.windowMs + 1),
    });
    const atEnd = makeRecord({ completedAt: new Date(NOW.getTime() - SETTINGS.windowMs) });
    const afterEnd = makeRecord({
      completedAt: new Date(NOW.getTime() - SETTINGS.windowMs - 1),
    });
    expect(decide(inside, REQUEST, NOW, SETTINGS).kind).toBe('duplicate');
    expect(decide(atEnd, REQUEST, NOW, SETTINGS).kind).toBe('execute');
    expect(decide(afterEnd, REQUEST, NOW, SETTINGS).kind).toBe('execute');
  });

  it('D4: an expired lease turns IN_FLIGHT into IN_DOUBT and a renewed lease prevents it', () => {
    const expired = makeRecord({
      state: 'IN_FLIGHT',
      leaseUntil: new Date(NOW.getTime() - 1),
    });
    const expiredDecision = decide(expired, REQUEST, NOW, SETTINGS);
    expect(expiredDecision.kind).toBe('block-in-doubt');
    expect(expiredDecision.changes.state).toBe('IN_DOUBT');

    const renewed = makeRecord({
      state: 'IN_FLIGHT',
      leaseUntil: nextLeaseExpiry(NOW, SETTINGS),
    });
    const renewedDecision = decide(renewed, REQUEST, NOW, SETTINGS);
    expect(renewedDecision.kind).toBe('wait');
    expect(renewedDecision.changes.state).toBeUndefined();

    expect(leaseExpired(makeRecord({ leaseUntil: new Date(NOW.getTime()) }), NOW)).toBe(true);
    expect(leaseExpired(makeRecord({ leaseUntil: new Date(NOW.getTime() + 1) }), NOW)).toBe(false);
    expect(nextLeaseExpiry(NOW, SETTINGS).getTime()).toBe(NOW.getTime() + SETTINGS.leaseMs);
  });

  it('D7: a repeat grant allows exactly one more execution and is consumed', () => {
    const granted = makeRecord({
      completedAt: new Date(NOW.getTime() - 1_000),
      repeatGrant: { grantedAt: new Date(NOW.getTime() - 500) },
    });
    const decision = decide(granted, REQUEST, NOW, SETTINGS);
    expect(decision.kind).toBe('execute');
    expect(decision.changes.state).toBe('IN_FLIGHT');
    expect(decision.changes.repeatGrant).toBeNull();

    const afterGrant = {
      ...granted,
      ...decision.changes,
      state: 'SUCCEEDED' as const,
      completedAt: new Date(NOW.getTime() - 1),
    };
    expect(decide(afterGrant, REQUEST, NOW, SETTINGS).kind).toBe('duplicate');
  });

  it('D8: an explicit key with a different fingerprint is rejected, the same fingerprint is a duplicate', () => {
    const existing = makeRecord({
      fingerprint: 'fp-1',
      completedAt: new Date(NOW.getTime() - 1_000),
    });
    expect(
      decide(existing, { fingerprint: 'fp-2', explicitKey: 'order-1' }, NOW, SETTINGS).kind,
    ).toBe('reject-key-conflict');
    expect(
      decide(existing, { fingerprint: 'fp-1', explicitKey: 'order-1' }, NOW, SETTINGS).kind,
    ).toBe('duplicate');
    expect(decide(existing, { fingerprint: 'fp-1' }, NOW, SETTINGS).kind).toBe('duplicate');
    expect(decide(null, { fingerprint: 'fp-2', explicitKey: 'order-1' }, NOW, SETTINGS).kind).toBe(
      'execute',
    );
  });

  it('a key conflict is rejected even when the record is in doubt', () => {
    const existing = makeRecord({ fingerprint: 'fp-1', state: 'IN_DOUBT' });
    expect(
      decide(existing, { fingerprint: 'fp-2', explicitKey: 'order-1' }, NOW, SETTINGS).kind,
    ).toBe('reject-key-conflict');
  });

  it('decide throws for an unknown stored state (defensive never check)', () => {
    const corrupt = makeRecord({ state: 'BANANA' as RecordState });
    expect(() => decide(corrupt, REQUEST, NOW, SETTINGS)).toThrow(/Unhandled/);
  });
});

describe('afterExecution', () => {
  it('a success stores the result and completes the record', () => {
    const patch = afterExecution(
      makeRecord({ state: 'IN_FLIGHT' }),
      { type: 'success', result: { id: 7 } },
      NOW,
      SETTINGS,
    );
    expect(patch.state).toBe('SUCCEEDED');
    expect(patch.result).toEqual({ id: 7 });
    expect(patch.completedAt).toEqual(NOW);
    expect(patch.leaseUntil).toBeNull();
  });

  it('a definite failure marks FAILED_DEFINITE and clears a stale result', () => {
    const patch = afterExecution(
      makeRecord({ state: 'IN_FLIGHT' }),
      { type: 'definite-failure' },
      NOW,
      SETTINGS,
    );
    expect(patch.state).toBe('FAILED_DEFINITE');
    expect(patch.completedAt).toEqual(NOW);
    expect(patch.leaseUntil).toBeNull();
    expect('result' in patch && patch.result === undefined).toBe(true);
  });

  it('an ambiguous failure marks IN_DOUBT', () => {
    const patch = afterExecution(
      makeRecord({ state: 'IN_FLIGHT' }),
      { type: 'ambiguous-failure' },
      NOW,
      SETTINGS,
    );
    expect(patch.state).toBe('IN_DOUBT');
    expect(patch.leaseUntil).toBeNull();
  });

  it('D9: cancellation during execution leads to IN_DOUBT', () => {
    const patch = afterExecution(
      makeRecord({ state: 'IN_FLIGHT' }),
      { type: 'cancelled' },
      NOW,
      SETTINGS,
    );
    expect(patch.state).toBe('IN_DOUBT');
    expect(patch.leaseUntil).toBeNull();
  });

  it('afterExecution throws for an unknown outcome type (defensive never check)', () => {
    expect(() =>
      afterExecution(
        makeRecord(),
        { type: 'banana' } as unknown as ExecutionOutcome,
        NOW,
        SETTINGS,
      ),
    ).toThrow(/Unhandled/);
  });
});

describe('lateCompletion', () => {
  it('D5: a late success upgrades IN_DOUBT to SUCCEEDED', () => {
    const inDoubt = makeRecord({ state: 'IN_DOUBT', completedAt: null });
    const patch = lateCompletion(inDoubt, { type: 'success', result: { ok: true } }, NOW);
    expect(patch.state).toBe('SUCCEEDED');
    expect(patch.result).toEqual({ ok: true });
    expect(patch.completedAt).toEqual(NOW);
    expect(patch.leaseUntil).toBeNull();
  });

  it('D5: a late definite failure upgrades IN_DOUBT to FAILED_DEFINITE', () => {
    const inDoubt = makeRecord({ state: 'IN_DOUBT', completedAt: null });
    const patch = lateCompletion(inDoubt, { type: 'definite-failure' }, NOW);
    expect(patch.state).toBe('FAILED_DEFINITE');
    expect(patch.completedAt).toEqual(NOW);
  });

  it('D5: a late ambiguous result or cancellation leaves the record in doubt', () => {
    const inDoubt = makeRecord({ state: 'IN_DOUBT', completedAt: null });
    expect(lateCompletion(inDoubt, { type: 'ambiguous-failure' }, NOW)).toEqual({});
    expect(lateCompletion(inDoubt, { type: 'cancelled' }, NOW)).toEqual({});
  });

  it('D5: a late completion changes nothing when the record is not in doubt', () => {
    const succeeded = makeRecord({ state: 'SUCCEEDED' });
    expect(lateCompletion(succeeded, { type: 'success', result: 1 }, NOW)).toEqual({});
  });

  it('lateCompletion throws for an unknown outcome type (defensive never check)', () => {
    expect(() =>
      lateCompletion(
        makeRecord({ state: 'IN_DOUBT' }),
        { type: 'banana' } as unknown as ExecutionOutcome,
        NOW,
      ),
    ).toThrow(/Unhandled/);
  });
});

describe('purity', () => {
  it('decision functions never mutate their inputs', () => {
    const record = makeRecord({ state: 'IN_FLIGHT', leaseUntil: new Date(NOW.getTime() + 1_000) });
    const before = structuredClone(record);
    decide(record, REQUEST, NOW, SETTINGS);
    afterExecution(record, { type: 'success', result: { a: 1 } }, NOW, SETTINGS);
    afterExecution(record, { type: 'definite-failure' }, NOW, SETTINGS);
    afterExecution(record, { type: 'ambiguous-failure' }, NOW, SETTINGS);
    afterExecution(record, { type: 'cancelled' }, NOW, SETTINGS);
    lateCompletion(record, { type: 'success', result: 1 }, NOW);
    leaseExpired(record, NOW);
    expect(record).toEqual(before);
  });
});
