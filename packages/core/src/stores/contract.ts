import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineSettings } from '../engine.js';
import type {
  ActionRecord,
  ActionStore,
  BeginInput,
  BeginResult,
  CompleteInput,
  RepeatGrant,
} from './types.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 86_400_000;
const SETTINGS: EngineSettings = {
  windowMs: 10 * MINUTE,
  waitForInFlightMs: 5_000,
  leaseMs: 30_000,
};

function offset(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function beginInput(overrides: Partial<BeginInput> = {}): BeginInput {
  return {
    fingerprint: 'fp-1',
    explicitKey: null,
    serverId: 'local',
    toolName: 'test.tool',
    scope: 'scope-1',
    redactedArgs: { amount: 1500 },
    now: NOW,
    settings: SETTINGS,
    ...overrides,
  };
}

function completeInput(
  outcome: CompleteInput['outcome'],
  now: Date,
  errorSummary?: string,
): CompleteInput {
  return errorSummary === undefined
    ? { outcome, now, settings: SETTINGS }
    : { outcome, now, settings: SETTINGS, errorSummary };
}

function execute(result: BeginResult): Extract<BeginResult, { kind: 'execute' }> {
  expect(result.kind).toBe('execute');
  return result as Extract<BeginResult, { kind: 'execute' }>;
}

function duplicateResult(result: BeginResult): Extract<BeginResult, { kind: 'duplicate' }> {
  expect(result.kind).toBe('duplicate');
  return result as Extract<BeginResult, { kind: 'duplicate' }>;
}

function waitResult(result: BeginResult): Extract<BeginResult, { kind: 'wait' }> {
  expect(result.kind).toBe('wait');
  return result as Extract<BeginResult, { kind: 'wait' }>;
}

function requireRecord(record: ActionRecord | null): ActionRecord {
  expect(record).not.toBeNull();
  return record as ActionRecord;
}

/**
 * Registers the full store contract as Vitest tests (SPEC.md C12). Every store
 * must pass this suite unchanged. `createStore` is called before each test;
 * `cleanup` runs after it, for example to delete a temporary folder.
 */
export function runStoreContract(
  name: string,
  createStore: () => ActionStore | Promise<ActionStore>,
  cleanup?: () => void | Promise<void>,
): void {
  describe(name, () => {
    let store: ActionStore;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await store.close();
      await cleanup?.();
    });

    async function createCompleted(
      overrides: Partial<BeginInput> = {},
      outcome: CompleteInput['outcome'] = { type: 'success', result: { ok: true } },
    ): Promise<ActionRecord> {
      const input = beginInput(overrides);
      const record = execute(await store.begin(input)).record;
      await store.complete(record.id, completeInput(outcome, input.now));
      return requireRecord(await store.get(record.id));
    }

    async function createInDoubt(overrides: Partial<BeginInput> = {}): Promise<ActionRecord> {
      const input = beginInput(overrides);
      const record = execute(await store.begin(input)).record;
      await store.complete(record.id, completeInput({ type: 'ambiguous-failure' }, input.now));
      return requireRecord(await store.get(record.id));
    }

    describe('begin', () => {
      it('executes and claims a new record for an unseen identity', async () => {
        const result = execute(await store.begin(beginInput()));
        const record = result.record;
        expect(result.archived).toBeNull();
        expect(record.state).toBe('IN_FLIGHT');
        expect(record.identity).toBe('fp-1');
        expect(record.fingerprint).toBe('fp-1');
        expect(record.explicitKey).toBeNull();
        expect(record.serverId).toBe('local');
        expect(record.toolName).toBe('test.tool');
        expect(record.scope).toBe('scope-1');
        expect(record.attempt).toBe(1);
        expect(record.redactedArgs).toEqual({ amount: 1500 });
        expect(record.result).toBeUndefined();
        expect(record.resultTruncated).toBe(false);
        expect(record.errorSummary).toBeNull();
        expect(record.createdAt).toEqual(NOW);
        expect(record.startedAt).toEqual(NOW);
        expect(record.completedAt).toBeNull();
        expect(record.leaseExpiresAt).toEqual(offset(SETTINGS.leaseMs));
        expect(record.resolvedAt).toBeNull();
        expect(record.resolvedBy).toBeNull();
        expect(record.resolutionNote).toBeNull();
        expect(record.repeatGrant).toBeNull();
        expect(await store.get(record.id)).toEqual(record);
        expect(await store.findByIdentity('fp-1')).toEqual(record);
      });

      it('returns the stored result as a duplicate inside the window', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: { receipt: 'R1' } }, NOW),
        );
        const second = duplicateResult(await store.begin(beginInput({ now: offset(MINUTE) })));
        expect(second.originalResult).toEqual({ receipt: 'R1' });
        expect(second.originalAt).toEqual(NOW);
        expect(second.record.state).toBe('SUCCEEDED');
      });

      it('executes as a new action and archives the old record after the window', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: { ok: true } }, NOW),
        );
        const result = execute(
          await store.begin(beginInput({ now: offset(SETTINGS.windowMs + 1) })),
        );
        expect(result.record.id).not.toBe(first.id);
        expect(result.record.state).toBe('IN_FLIGHT');
        expect(result.record.attempt).toBe(1);
        expect(result.archived?.id).toBe(first.id);
        expect(result.archived?.state).toBe('SUCCEEDED');
        // Archived records stay available for audit until purge removes them.
        expect(await store.get(first.id)).toEqual(result.archived);
        expect((await store.findByIdentity('fp-1'))?.id).toBe(result.record.id);
      });

      it('executes exactly at the end of the window', async () => {
        await createCompleted();
        const result = await store.begin(beginInput({ now: offset(SETTINGS.windowMs) }));
        expect(result.kind).toBe('execute');
      });

      it('executes again after a definite failure, incrementing the attempt', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(first.id, completeInput({ type: 'definite-failure' }, NOW));
        const result = execute(await store.begin(beginInput({ now: offset(MINUTE) })));
        expect(result.record.id).toBe(first.id);
        expect(result.record.attempt).toBe(2);
        expect(result.record.createdAt).toEqual(NOW);
        expect(result.record.startedAt).toEqual(offset(MINUTE));
        expect(result.archived).toBeNull();
      });

      it('executes again after a human resolved the action as failed', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, { as: 'failed', by: 'kola', at: offset(MINUTE) });
        const result = execute(await store.begin(beginInput({ now: offset(2 * MINUTE) })));
        expect(result.record.attempt).toBe(2);
      });

      it('executes after a resolved success once the window has passed', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, { as: 'succeeded', by: 'kola', at: NOW });
        const result = await store.begin(beginInput({ now: offset(SETTINGS.windowMs + 1) }));
        expect(result.kind).toBe('execute');
      });

      it('returns a duplicate for a resolved success inside the window', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, { as: 'succeeded', by: 'kola', at: NOW });
        const result = await store.begin(beginInput({ now: offset(MINUTE) }));
        expect(result.kind).toBe('duplicate');
      });

      it('waits while another call holds a valid lease', async () => {
        const first = execute(await store.begin(beginInput())).record;
        const result = waitResult(
          await store.begin(beginInput({ now: offset(SETTINGS.leaseMs / 2) })),
        );
        expect(result.waitMs).toBe(SETTINGS.waitForInFlightMs);
        expect(result.record.id).toBe(first.id);
        expect(result.record.state).toBe('IN_FLIGHT');
      });

      it('blocks and marks IN_DOUBT when the lease has expired', async () => {
        const first = execute(
          await store.begin(beginInput({ settings: { ...SETTINGS, leaseMs: 0 } })),
        ).record;
        const result = await store.begin(beginInput());
        expect(result.kind).toBe('block-in-doubt');
        const stored = requireRecord(await store.get(first.id));
        expect(stored.state).toBe('IN_DOUBT');
        expect(stored.leaseExpiresAt).toBeNull();
      });

      it('blocks while a record is in doubt', async () => {
        const first = await createInDoubt();
        const result = await store.begin(beginInput({ now: offset(MINUTE) }));
        expect(result.kind).toBe('block-in-doubt');
        expect(result.record.id).toBe(first.id);
        expect(result.record.state).toBe('IN_DOUBT');
      });

      it('rejects an explicit key reused with a different fingerprint', async () => {
        const first = execute(await store.begin(beginInput({ explicitKey: 'order-1' }))).record;
        const result = await store.begin(
          beginInput({ explicitKey: 'order-1', fingerprint: 'fp-2' }),
        );
        expect(result.kind).toBe('reject-key-conflict');
        expect(result.record.id).toBe(first.id);
      });

      it('finds an existing record by explicit key', async () => {
        const first = execute(await store.begin(beginInput({ explicitKey: 'order-1' }))).record;
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: { ok: true } }, NOW),
        );
        const result = await store.begin(
          beginInput({ explicitKey: 'order-1', now: offset(MINUTE) }),
        );
        expect(result.kind).toBe('duplicate');
        expect(result.record.identity).toBe('order-1');
      });
    });

    describe('renewLease', () => {
      it('renews the lease of an in-flight record', async () => {
        const first = execute(await store.begin(beginInput())).record;
        const until = offset(5 * MINUTE);
        await store.renewLease(first.id, until);
        expect(requireRecord(await store.get(first.id)).leaseExpiresAt).toEqual(until);
      });

      it('leaves a finished record alone', async () => {
        const first = await createCompleted();
        await store.renewLease(first.id, offset(5 * MINUTE));
        expect(requireRecord(await store.get(first.id)).leaseExpiresAt).toBeNull();
      });

      it('throws STORE_UNAVAILABLE for an unknown record id', async () => {
        await expect(store.renewLease('missing', offset(MINUTE))).rejects.toMatchObject({
          code: 'STORE_UNAVAILABLE',
        });
      });
    });

    describe('complete', () => {
      it('stores a successful result and always sets completedAt', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: { receipt: 'R1' } }, offset(MINUTE), 'all good'),
        );
        const stored = requireRecord(await store.get(first.id));
        expect(stored.state).toBe('SUCCEEDED');
        expect(stored.result).toEqual({ receipt: 'R1' });
        expect(stored.completedAt).toEqual(offset(MINUTE));
        expect(stored.leaseExpiresAt).toBeNull();
        expect(stored.errorSummary).toBe('all good');
      });

      it('marks a definite failure and clears any stale result', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(
          first.id,
          completeInput({ type: 'definite-failure' }, offset(MINUTE), 'invalid params'),
        );
        const stored = requireRecord(await store.get(first.id));
        expect(stored.state).toBe('FAILED_DEFINITE');
        expect(stored.completedAt).toEqual(offset(MINUTE));
        expect(stored.result).toBeUndefined();
        expect(stored.errorSummary).toBe('invalid params');
      });

      it('marks an ambiguous failure IN_DOUBT without a completion time', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(
          first.id,
          completeInput({ type: 'ambiguous-failure' }, offset(MINUTE)),
        );
        const stored = requireRecord(await store.get(first.id));
        expect(stored.state).toBe('IN_DOUBT');
        expect(stored.completedAt).toBeNull();
        expect(stored.leaseExpiresAt).toBeNull();
      });

      it('marks a cancelled action IN_DOUBT', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(first.id, completeInput({ type: 'cancelled' }, offset(MINUTE)));
        expect(requireRecord(await store.get(first.id)).state).toBe('IN_DOUBT');
      });

      it('upgrades an in-doubt record through late completion when the original call finishes', async () => {
        const first = execute(
          await store.begin(beginInput({ settings: { ...SETTINGS, leaseMs: 0 } })),
        ).record;
        const blocked = await store.begin(beginInput());
        expect(blocked.kind).toBe('block-in-doubt');
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: { receipt: 'late' } }, offset(MINUTE)),
        );
        const stored = requireRecord(await store.get(first.id));
        expect(stored.state).toBe('SUCCEEDED');
        expect(stored.completedAt).toEqual(offset(MINUTE));
        expect(stored.result).toEqual({ receipt: 'late' });
      });

      it('never overwrites a human resolution', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, { as: 'failed', by: 'kola', at: offset(MINUTE) });
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: { receipt: 'R1' } }, offset(2 * MINUTE)),
        );
        const stored = requireRecord(await store.get(first.id));
        expect(stored.state).toBe('RESOLVED_FAILED');
        expect(stored.result).toBeUndefined();
      });

      it('does not overwrite an already successful record', async () => {
        const first = await createCompleted({}, { type: 'success', result: 'first' });
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: 'second' }, offset(MINUTE)),
        );
        const stored = requireRecord(await store.get(first.id));
        expect(stored.result).toBe('first');
        expect(stored.completedAt).toEqual(NOW);
      });

      it('throws STORE_UNAVAILABLE for an unknown record id', async () => {
        await expect(
          store.complete('missing', completeInput({ type: 'success', result: 1 }, NOW)),
        ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
      });
    });

    describe('get and findByIdentity', () => {
      it('returns null for unknown ids and identities', async () => {
        expect(await store.get('missing')).toBeNull();
        expect(await store.findByIdentity('missing')).toBeNull();
      });

      it('returns records by id, fingerprint, and explicit key', async () => {
        const plain = execute(await store.begin(beginInput())).record;
        const keyed = execute(
          await store.begin(beginInput({ fingerprint: 'fp-2', explicitKey: 'order-1' })),
        ).record;
        expect((await store.get(plain.id))?.id).toBe(plain.id);
        expect((await store.get(keyed.id))?.id).toBe(keyed.id);
        expect((await store.findByIdentity('fp-1'))?.id).toBe(plain.id);
        expect((await store.findByIdentity('order-1'))?.id).toBe(keyed.id);
      });
    });

    describe('list', () => {
      it('returns an empty array for an empty store', async () => {
        expect(await store.list({})).toEqual([]);
      });

      it('returns every record newest first', async () => {
        const older = execute(
          await store.begin(beginInput({ fingerprint: 'fp-a', now: offset(-2 * MINUTE) })),
        ).record;
        const newer = execute(
          await store.begin(beginInput({ fingerprint: 'fp-b', now: offset(-MINUTE) })),
        ).record;
        const listed = await store.list({});
        expect(listed.map((record) => record.id)).toEqual([newer.id, older.id]);
      });

      it('filters by a single state', async () => {
        await createCompleted({ fingerprint: 'fp-a' });
        const running = execute(
          await store.begin(beginInput({ fingerprint: 'fp-b', now: offset(MINUTE) })),
        ).record;
        const listed = await store.list({ state: 'IN_FLIGHT' });
        expect(listed.map((record) => record.id)).toEqual([running.id]);
      });

      it('filters by multiple states', async () => {
        const done = await createCompleted({ fingerprint: 'fp-a' });
        const running = execute(
          await store.begin(beginInput({ fingerprint: 'fp-b', now: offset(MINUTE) })),
        ).record;
        const listed = await store.list({ state: ['IN_FLIGHT', 'SUCCEEDED'] });
        expect(new Set(listed.map((record) => record.id))).toEqual(new Set([done.id, running.id]));
      });

      it('filters by since', async () => {
        await createCompleted({ fingerprint: 'fp-old', now: offset(-2 * MINUTE) });
        const recent = execute(
          await store.begin(beginInput({ fingerprint: 'fp-new', now: offset(-MINUTE) })),
        ).record;
        const listed = await store.list({ since: offset(-MINUTE) });
        expect(listed.map((record) => record.id)).toEqual([recent.id]);
      });

      it('filters by fingerprint, server, tool, and scope', async () => {
        const match = execute(
          await store.begin(
            beginInput({
              fingerprint: 'fp-a',
              serverId: 'srv-a',
              toolName: 'tool-a',
              scope: 'scope-a',
            }),
          ),
        ).record;
        await store.begin(
          beginInput({
            fingerprint: 'fp-b',
            serverId: 'srv-b',
            toolName: 'tool-b',
            scope: 'scope-b',
            now: offset(MINUTE),
          }),
        );
        expect((await store.list({ fingerprint: 'fp-a' })).map((record) => record.id)).toEqual([
          match.id,
        ]);
        expect((await store.list({ serverId: 'srv-a' })).map((record) => record.id)).toEqual([
          match.id,
        ]);
        expect((await store.list({ toolName: 'tool-a' })).map((record) => record.id)).toEqual([
          match.id,
        ]);
        expect((await store.list({ scope: 'scope-a' })).map((record) => record.id)).toEqual([
          match.id,
        ]);
      });

      it('applies a limit to the newest records', async () => {
        await store.begin(beginInput({ fingerprint: 'fp-a', now: offset(-2 * MINUTE) }));
        const newer = execute(
          await store.begin(beginInput({ fingerprint: 'fp-b', now: offset(-MINUTE) })),
        ).record;
        const listed = await store.list({ limit: 1 });
        expect(listed.map((record) => record.id)).toEqual([newer.id]);
      });
    });

    describe('resolve', () => {
      it('resolving as succeeded makes the next call a duplicate', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, {
          as: 'succeeded',
          by: 'kola',
          note: 'checked Paystack dashboard',
          at: offset(MINUTE),
        });
        const result = await store.begin(beginInput({ now: offset(2 * MINUTE) }));
        expect(result.kind).toBe('duplicate');
      });

      it('resolving as failed lets the next call execute', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, { as: 'failed', by: 'kola', at: offset(MINUTE) });
        const result = await store.begin(beginInput({ now: offset(2 * MINUTE) }));
        expect(result.kind).toBe('execute');
      });

      it('stores who resolved, when, and the note', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, {
          as: 'succeeded',
          by: 'kola',
          note: 'checked dashboard',
          at: offset(MINUTE),
        });
        const stored = requireRecord(await store.get(first.id));
        expect(stored.state).toBe('RESOLVED_SUCCEEDED');
        expect(stored.resolvedAt).toEqual(offset(MINUTE));
        expect(stored.resolvedBy).toBe('kola');
        expect(stored.resolutionNote).toBe('checked dashboard');
        expect(stored.completedAt).toEqual(offset(MINUTE));
      });

      it('leaves the note null when none is given', async () => {
        const first = await createInDoubt();
        await store.resolve(first.id, { as: 'failed', by: 'kola', at: offset(MINUTE) });
        expect(requireRecord(await store.get(first.id)).resolutionNote).toBeNull();
      });

      it('throws STORE_UNAVAILABLE for an unknown record id', async () => {
        await expect(
          store.resolve('missing', { as: 'failed', by: 'kola', at: NOW }),
        ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
      });
    });

    describe('grantRepeat', () => {
      const grant: RepeatGrant = {
        grantedAt: NOW,
        grantedBy: 'kola',
        note: 'customer asked again',
      };

      it('attaches a grant to the current record', async () => {
        const first = await createCompleted();
        await store.grantRepeat('fp-1', grant);
        expect(requireRecord(await store.get(first.id)).repeatGrant).toEqual(grant);
      });

      it('lets exactly one execution through and is consumed', async () => {
        await createCompleted();
        await store.grantRepeat('fp-1', grant);
        const repeated = execute(await store.begin(beginInput({ now: offset(MINUTE) })));
        expect(repeated.record.repeatGrant).toBeNull();
        expect(repeated.record.attempt).toBe(2);
        await store.complete(
          repeated.record.id,
          completeInput({ type: 'success', result: { ok: true } }, offset(2 * MINUTE)),
        );
        const after = await store.begin(beginInput({ now: offset(3 * MINUTE) }));
        expect(after.kind).toBe('duplicate');
      });

      it('does not leak an unused grant past the window', async () => {
        await createCompleted();
        await store.grantRepeat('fp-1', grant);
        const fresh = execute(
          await store.begin(beginInput({ now: offset(SETTINGS.windowMs + 1) })),
        );
        expect(fresh.record.repeatGrant).toBeNull();
        await store.complete(
          fresh.record.id,
          completeInput({ type: 'success', result: { ok: true } }, offset(SETTINGS.windowMs + 2)),
        );
        const after = await store.begin(beginInput({ now: offset(SETTINGS.windowMs + 3) }));
        expect(after.kind).toBe('duplicate');
      });

      it('throws STORE_UNAVAILABLE when there is no record for the fingerprint', async () => {
        await expect(store.grantRepeat('missing', grant)).rejects.toMatchObject({
          code: 'STORE_UNAVAILABLE',
        });
      });
    });

    describe('purge', () => {
      it('S7: purge removes only records past retention and never removes unresolved IN_DOUBT records', async () => {
        const oldSuccess = await createCompleted({
          fingerprint: 'fp-old',
          now: offset(-100 * DAY),
        });
        const recentSuccess = await createCompleted({
          fingerprint: 'fp-recent',
          now: offset(-DAY),
        });
        const doubt = await createInDoubt({ fingerprint: 'fp-doubt', now: offset(-100 * DAY) });
        const inFlight = execute(
          await store.begin(
            beginInput({
              fingerprint: 'fp-flight',
              now: offset(-100 * DAY),
              settings: { ...SETTINGS, leaseMs: 500 * DAY },
            }),
          ),
        ).record;

        const removed = await store.purge(offset(-50 * DAY));
        expect(removed).toBe(1);
        expect(await store.get(oldSuccess.id)).toBeNull();
        expect(await store.get(recentSuccess.id)).not.toBeNull();
        expect(await store.get(doubt.id)).not.toBeNull();
        expect(await store.get(inFlight.id)).not.toBeNull();
      });

      it('removes old resolved records so their identity is free', async () => {
        const first = await createInDoubt({ now: offset(-100 * DAY) });
        await store.resolve(first.id, { as: 'failed', by: 'kola', at: offset(-100 * DAY) });
        const removed = await store.purge(offset(-50 * DAY));
        expect(removed).toBe(1);
        expect(await store.findByIdentity('fp-1')).toBeNull();
      });

      it('keeps the current record when only an archived record is old enough', async () => {
        const archived = await createCompleted({ now: offset(-100 * DAY) });
        const current = execute(await store.begin(beginInput({ now: offset(DAY) }))).record;
        const removed = await store.purge(offset(-50 * DAY));
        expect(removed).toBe(1);
        expect(await store.get(archived.id)).toBeNull();
        expect(await store.get(current.id)).not.toBeNull();
        expect((await store.findByIdentity('fp-1'))?.id).toBe(current.id);
      });

      it('returns zero when nothing is old enough', async () => {
        const first = await createCompleted();
        expect(await store.purge(offset(-DAY))).toBe(0);
        expect(await store.get(first.id)).not.toBeNull();
      });
    });

    describe('close', () => {
      it('resolves and can be called twice', async () => {
        await expect(store.close()).resolves.toBeUndefined();
        await expect(store.close()).resolves.toBeUndefined();
      });
    });

    describe('isolation', () => {
      it('callers cannot mutate stored records through returned objects', async () => {
        const first = execute(await store.begin(beginInput())).record;
        await store.complete(
          first.id,
          completeInput({ type: 'success', result: { nested: { amount: 1500 } } }, NOW),
        );
        const returned = requireRecord(await store.get(first.id));
        returned.state = 'FAILED_DEFINITE';
        returned.createdAt.setTime(0);
        (returned.redactedArgs as { amount: number }).amount = 99;
        (returned.result as { nested: { amount: number } }).nested.amount = 99;
        const again = requireRecord(await store.get(first.id));
        expect(again.state).toBe('SUCCEEDED');
        expect(again.createdAt).toEqual(NOW);
        expect(again.redactedArgs).toEqual({ amount: 1500 });
        expect(again.result).toEqual({ nested: { amount: 1500 } });
      });

      it('callers cannot mutate stored records through begin results', async () => {
        const result = execute(await store.begin(beginInput()));
        (result.record.redactedArgs as { amount: number }).amount = 99;
        const stored = requireRecord(await store.get(result.record.id));
        expect(stored.redactedArgs).toEqual({ amount: 1500 });
      });

      it('stores a copy of the arguments the caller passes in', async () => {
        const args = { amount: 1500, nested: { note: 'keep' } };
        const result = execute(await store.begin(beginInput({ redactedArgs: args })));
        args.nested.note = 'changed';
        const stored = requireRecord(await store.get(result.record.id));
        expect(stored.redactedArgs).toEqual({ amount: 1500, nested: { note: 'keep' } });
      });

      it('stores a copy of a result the caller passes in', async () => {
        const first = execute(await store.begin(beginInput())).record;
        const result = { nested: { total: 1500 } };
        await store.complete(first.id, completeInput({ type: 'success', result }, NOW));
        result.nested.total = 0;
        const stored = requireRecord(await store.get(first.id));
        expect(stored.result).toEqual({ nested: { total: 1500 } });
      });
    });
  });
}
