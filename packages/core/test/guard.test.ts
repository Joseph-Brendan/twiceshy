import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  ActionRecord,
  ActionStore,
  AllowRepeatRequest,
  BeginInput,
  BeginResult,
  CompleteInput,
  CreateGuardOptions,
  Guard,
  GuardEvent,
  ResolveRequest,
} from '../src/index.js';
import {
  ConfigInvalidError,
  createGuard,
  definiteFailure,
  InDoubtError,
  InProgressError,
  KeyConflictError,
  MemoryStore,
  StoreUnavailableError,
} from '../src/index.js';
import { SqliteStore } from '../src/stores/sqlite.js';
import { flushAsync, TestClock, until } from './helpers/test-clock.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

const tempDirs = new Set<string>();
const guards = new Set<Guard>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-guard-'));
  tempDirs.add(dir);
  return dir;
}

interface StoreCase {
  name: string;
  createStore: () => ActionStore;
}

const STORE_CASES: StoreCase[] = [
  { name: 'MemoryStore', createStore: () => new MemoryStore() },
  {
    name: 'SqliteStore',
    createStore: () => new SqliteStore({ path: join(makeTempDir(), 'actions.db') }),
  },
];

function makeClock(): TestClock {
  return new TestClock(NOW);
}

function makeGuard(
  store: ActionStore,
  clock: TestClock,
  options: Omit<Partial<CreateGuardOptions>, 'store' | 'clock'> = {},
): Guard {
  const guard = createGuard({ store, clock, ...options });
  guards.add(guard);
  return guard;
}

afterEach(async () => {
  await Promise.all([...guards].map((guard) => guard.close().catch(() => undefined)));
  guards.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

class UnavailableStore extends MemoryStore {
  override async begin(_input: BeginInput): Promise<BeginResult> {
    throw new StoreUnavailableError({});
  }
}

class WriteFailStore extends MemoryStore {
  override async complete(_id: string, _input: CompleteInput): Promise<void> {
    throw new StoreUnavailableError({});
  }
}

class ReadFailStore extends MemoryStore {
  override async get(_id: string): Promise<ActionRecord | null> {
    throw new StoreUnavailableError({});
  }
}

class CloseSpyStore extends MemoryStore {
  closes = 0;
  override async close(): Promise<void> {
    this.closes += 1;
  }
}

function failingRenewStore(inner: ActionStore): ActionStore {
  return {
    begin: (input) => inner.begin(input),
    renewLease: async () => {
      throw new StoreUnavailableError({});
    },
    complete: (id, input) => inner.complete(id, input),
    get: (id) => inner.get(id),
    findByIdentity: (identity) => inner.findByIdentity(identity),
    list: (filter) => inner.list(filter),
    resolve: (id, resolution) => inner.resolve(id, resolution),
    grantRepeat: (fingerprint, grant) => inner.grantRepeat(fingerprint, grant),
    purge: (olderThan) => inner.purge(olderThan),
    close: () => inner.close(),
  };
}

function failingPurgeStore(inner: ActionStore): ActionStore {
  return {
    begin: (input) => inner.begin(input),
    renewLease: (id, until) => inner.renewLease(id, until),
    complete: (id, input) => inner.complete(id, input),
    get: (id) => inner.get(id),
    findByIdentity: (identity) => inner.findByIdentity(identity),
    list: (filter) => inner.list(filter),
    resolve: (id, resolution) => inner.resolve(id, resolution),
    grantRepeat: (fingerprint, grant) => inner.grantRepeat(fingerprint, grant),
    purge: async () => {
      throw new StoreUnavailableError({});
    },
    close: () => inner.close(),
  };
}

/** A promise that only settles when the test calls resolve/reject. */
function controlled<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveLater!: (value: T) => void;
  let rejectLater!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveLater = resolve;
    rejectLater = reject;
  });
  return { promise, resolve: resolveLater, reject: rejectLater };
}

describe.each(STORE_CASES)('guard with $name', ({ createStore }) => {
  it("D3: in-flight wait returns the first call's result, or IN_PROGRESS when the wait runs out", async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000, waitForInFlightMs: 200 });

    // The first call finishes inside the second call's wait.
    const first = controlled<string>();
    const firstCall = guard.run(
      { tool: 'book_slot', args: { slot: 'sat-3pm' } },
      () => first.promise,
    );
    await flushAsync();
    const secondCall = guard.run(
      { tool: 'book_slot', args: { slot: 'sat-3pm' } },
      async () => 'second call ran',
    );
    await flushAsync();
    first.resolve('booking-42');
    const firstOutcome = await firstCall;
    expect(firstOutcome.status).toBe('executed');
    await clock.advance(200);
    const secondOutcome = await secondCall;
    expect(secondOutcome.status).toBe('duplicate');
    expect(secondOutcome.value).toBe('booking-42');

    // A first call that outlives the wait makes the second report IN_PROGRESS.
    const slow = controlled<string>();
    const slowCall = guard.run({ tool: 'slow.tool', args: { id: 1 } }, () => slow.promise);
    await flushAsync();
    const waiting = guard.run({ tool: 'slow.tool', args: { id: 1 } }, async () => 'never ran');
    await flushAsync();
    const rejection = expect(waiting).rejects.toBeInstanceOf(InProgressError);
    await clock.advance(200);
    await rejection;
    slow.resolve('too late for the waiter');
    await slowCall;
  });

  it('D4: a slow but alive action keeps renewing its lease and is never marked in doubt', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000, waitForInFlightMs: 200 });

    const slow = controlled<string>();
    const call = guard.run({ tool: 'slow.tool', args: { id: 1 } }, () => slow.promise);
    await flushAsync();
    const [record] = await guard.list({});
    expect(record?.state).toBe('IN_FLIGHT');

    // The lease is renewed at leaseMs / 3, so a slow but alive action stays
    // claimed instead of turning IN_DOUBT.
    await clock.advance(40_000);
    const renewed = await guard.get(record?.id as string);
    expect(renewed?.state).toBe('IN_FLIGHT');
    expect(renewed?.leaseExpiresAt?.getTime()).toBeGreaterThan(clock.now().getTime());

    // A second caller sees a live lease, so it waits rather than blocking.
    const second = guard.run({ tool: 'slow.tool', args: { id: 1 } }, async () => 'second');
    await flushAsync();
    slow.resolve('finally done');
    await call;
    await clock.advance(200);
    const outcome = await second;
    expect(outcome.status).toBe('duplicate');
    expect(outcome.value).toBe('finally done');
  });

  it('a leaseMs override replaces the timeoutMs + 30s default', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { leaseMs: '500ms', timeoutMs: 60_000 });

    const running = controlled<string>();
    const call = guard.run({ tool: 'pay.tool', args: {} }, () => running.promise);
    await flushAsync();
    const [record] = await guard.list({});
    expect(record?.leaseExpiresAt?.getTime()).toBe(NOW.getTime() + 500);
    running.resolve('done');
    await call;
  });

  it('D5: late completion after a timeout upgrades IN_DOUBT and emits the event', async () => {
    const store = createStore();
    const clock = makeClock();
    const lateEvents: GuardEvent[] = [];
    const guard = makeGuard(store, clock, {
      timeoutMs: 1_000,
      hooks: { onLateCompletion: (event) => lateEvents.push(event) },
    });

    const slow = controlled<string>();
    const call = guard.run({ tool: 'slow.payment', args: { amount: 1500 } }, () => slow.promise);
    await flushAsync();
    const rejection = expect(call).rejects.toBeInstanceOf(InDoubtError);
    await clock.advance(1_000);
    await rejection;

    const [record] = await guard.list({ state: 'IN_DOUBT' });
    expect(record?.state).toBe('IN_DOUBT');

    slow.resolve('receipt-1');
    await until(() => lateEvents.length > 0);
    expect(lateEvents[0]?.type).toBe('late-completion');
    expect(lateEvents[0]?.recordId).toBe(record?.id);
    const upgraded = await guard.get(record?.id as string);
    expect(upgraded?.state).toBe('SUCCEEDED');
    expect(upgraded?.result).toBe('receipt-1');
  });

  it('late completion upgrades a record another caller put in doubt while the action ran', async () => {
    const store = createStore();
    const clock = makeClock();
    const lateEvents: GuardEvent[] = [];
    const guard = makeGuard(store, clock, {
      timeoutMs: 60_000,
      hooks: { onLateCompletion: (event) => lateEvents.push(event) },
    });

    const running = controlled<string>();
    const call = guard.run({ tool: 'slow.payment', args: { amount: 1 } }, () => running.promise);
    await flushAsync();
    const [record] = await guard.list({});
    // Simulate another caller seeing the lease expire and marking it IN_DOUBT.
    await store.complete(record?.id as string, {
      outcome: { type: 'ambiguous-failure' },
      now: clock.now(),
      settings: { windowMs: 600_000, waitForInFlightMs: 5_000, leaseMs: 90_000 },
    });
    expect((await guard.get(record?.id as string))?.state).toBe('IN_DOUBT');

    running.resolve('receipt-late');
    const outcome = await call;
    expect(outcome.status).toBe('executed');
    expect(outcome.value).toBe('receipt-late');
    expect(outcome.record?.state).toBe('SUCCEEDED');
    expect(lateEvents).toHaveLength(1);
    expect(lateEvents[0]?.type).toBe('late-completion');
  });

  it('a late failure after another caller marked the record in doubt rethrows the original error', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    const running = controlled<string>();
    const call = guard.run({ tool: 'slow.payment', args: { amount: 2 } }, () => running.promise);
    await flushAsync();
    const [record] = await guard.list({});
    await store.complete(record?.id as string, {
      outcome: { type: 'ambiguous-failure' },
      now: clock.now(),
      settings: { windowMs: 600_000, waitForInFlightMs: 5_000, leaseMs: 90_000 },
    });

    const lateError = new Error('provider exploded late');
    const rejection = expect(call).rejects.toBe(lateError);
    running.reject(lateError);
    await rejection;
    expect((await guard.get(record?.id as string))?.state).toBe('IN_DOUBT');
  });

  it('a late result never overwrites a human resolution', async () => {
    const store = createStore();
    const clock = makeClock();
    const lateEvents: GuardEvent[] = [];
    const guard = makeGuard(store, clock, {
      timeoutMs: 1_000,
      hooks: { onLateCompletion: (event) => lateEvents.push(event) },
    });

    const running = controlled<string>();
    const call = guard.run({ tool: 'slow.payment', args: { amount: 3 } }, () => running.promise);
    await flushAsync();
    const rejection = expect(call).rejects.toBeInstanceOf(InDoubtError);
    await clock.advance(1_000);
    await rejection;
    const [record] = await guard.list({ state: 'IN_DOUBT' });
    await guard.resolve(record?.id as string, { as: 'succeeded', by: 'kola' });

    running.resolve('late answer nobody should store');
    for (let flush = 0; flush < 5; flush += 1) {
      await flushAsync();
    }
    expect(lateEvents).toHaveLength(0);
    const stored = await guard.get(record?.id as string);
    expect(stored?.state).toBe('RESOLVED_SUCCEEDED');
    expect(stored?.result).not.toBe('late answer nobody should store');
  });

  it('a resolution made while the action runs is never overwritten', async () => {
    const store = createStore();
    const clock = makeClock();
    const events: GuardEvent[] = [];
    const guard = makeGuard(store, clock, {
      timeoutMs: 60_000,
      hooks: { onExecute: (event) => events.push(event) },
    });

    const running = controlled<string>();
    const call = guard.run({ tool: 'slow.payment', args: { amount: 4 } }, () => running.promise);
    await flushAsync();
    const [record] = await guard.list({});
    await guard.resolve(record?.id as string, { as: 'failed', by: 'kola' });

    running.resolve('the tool did act');
    const outcome = await call;
    expect(outcome.status).toBe('executed');
    expect(outcome.value).toBe('the tool did act');
    const stored = await guard.get(record?.id as string);
    expect(stored?.state).toBe('RESOLVED_FAILED');
    expect(stored?.result).toBeUndefined();
    expect(events[0]?.reason).toBe('record already RESOLVED_FAILED');
  });

  it('cancellation with an already-aborted signal leaves the record IN_DOUBT', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      guard.run({ tool: 'pay.tool', args: {}, signal: controller.signal }, async () => 'never'),
    ).rejects.toBeInstanceOf(InDoubtError);
    const [record] = await guard.list({});
    expect(record?.state).toBe('IN_DOUBT');
  });

  it('D6: resolve as succeeded makes the next call a duplicate, and resolve as failed lets it execute', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    await expect(
      guard.run({ tool: 'transfer', args: { to: 'ife' } }, () => {
        throw new Error('connection reset');
      }),
    ).rejects.toThrow('connection reset');
    const [doubt] = await guard.list({ state: 'IN_DOUBT' });
    await guard.resolve(doubt?.id as string, {
      as: 'succeeded',
      by: 'kola',
      note: 'checked the bank statement',
    });
    const duplicate = await guard.run(
      { tool: 'transfer', args: { to: 'ife' } },
      async () => 'nope',
    );
    expect(duplicate.status).toBe('duplicate');

    await expect(
      guard.run({ tool: 'transfer', args: { to: 'ada' } }, () => {
        throw new Error('connection reset');
      }),
    ).rejects.toThrow('connection reset');
    const [doubt2] = await guard.list({ state: 'IN_DOUBT' });
    expect(doubt2?.state).toBe('IN_DOUBT');
    await guard.resolve(doubt2?.id as string, { as: 'failed', by: 'kola' });
    const executed = await guard.run({ tool: 'transfer', args: { to: 'ada' } }, async () => 'done');
    expect(executed.status).toBe('executed');
    expect(executed.value).toBe('done');
  });

  it('D7: allowRepeat allows exactly one extra execution, then duplicates are blocked again', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    const first = await guard.run(
      { tool: 'paystack.refund', args: { amount: 1500 } },
      async () => 'R1',
    );
    expect(first.status).toBe('executed');
    const duplicate = await guard.run(
      { tool: 'paystack.refund', args: { amount: 1500 } },
      async () => 'R2',
    );
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.value).toBe('R1');

    await guard.allowRepeat(first.record?.fingerprint as string, {
      by: 'kola',
      note: 'customer asked for a second refund',
    });
    const repeated = await guard.run(
      { tool: 'paystack.refund', args: { amount: 1500 } },
      async () => 'R3',
    );
    expect(repeated.status).toBe('executed');
    expect(repeated.value).toBe('R3');
    expect(repeated.record?.attempt).toBe(2);

    const blockedAgain = await guard.run(
      { tool: 'paystack.refund', args: { amount: 1500 } },
      async () => 'R4',
    );
    expect(blockedAgain.status).toBe('duplicate');
    expect(blockedAgain.value).toBe('R3');
  });

  it('D8: an explicit key reused with different arguments throws KEY_CONFLICT, and reused with the same arguments returns a duplicate', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    const first = await guard.run(
      { tool: 'orders.create', args: { amount: 100 }, key: 'order-1' },
      async () => 'created',
    );
    expect(first.status).toBe('executed');

    await expect(
      guard.run(
        { tool: 'orders.create', args: { amount: 200 }, key: 'order-1' },
        async () => 'different',
      ),
    ).rejects.toBeInstanceOf(KeyConflictError);

    const duplicate = await guard.run(
      { tool: 'orders.create', args: { amount: 100 }, key: 'order-1' },
      async () => 'again',
    );
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.value).toBe('created');
  });

  it('D9: cancellation during execution leaves the record IN_DOUBT', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    const controller = new AbortController();
    const running = controlled<string>();
    const call = guard.run(
      { tool: 'pay.tool', args: { amount: 500 }, signal: controller.signal },
      () => running.promise,
    );
    await flushAsync();
    const rejection = expect(call).rejects.toBeInstanceOf(InDoubtError);
    controller.abort();
    await rejection;

    const [record] = await guard.list({});
    expect(record?.state).toBe('IN_DOUBT');
    expect(record?.leaseExpiresAt).toBeNull();
    running.resolve('late answer');
    await flushAsync();
  });

  it("C5: the user's own error reaches the caller as the identical object", async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    const ambiguous = new Error('socket hang up');
    let caught: unknown;
    try {
      await guard.run({ tool: 'pay.tool', args: { amount: 1 } }, () => {
        throw ambiguous;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(ambiguous);
    const [inDoubt] = await guard.list({ state: 'IN_DOUBT' });
    expect(inDoubt?.errorSummary).toBeNull();

    const definite = definiteFailure(new Error('invalid params'));
    let caughtDefinite: unknown;
    try {
      await guard.run({ tool: 'pay.tool', args: { amount: 2 } }, () => {
        throw definite;
      });
    } catch (error) {
      caughtDefinite = error;
    }
    expect(caughtDefinite).toBe(definite);
    const [failed] = await guard.list({ state: 'FAILED_DEFINITE' });
    expect(failed?.state).toBe('FAILED_DEFINITE');
  });

  it('S4: a broken store refuses guarded calls when closed and bypasses them when open', async () => {
    const clock = makeClock();
    const unavailable = new UnavailableStore();

    const closed = makeGuard(unavailable, clock);
    let ran = false;
    await expect(
      closed.run({ tool: 'pay.tool', args: {} }, async () => {
        ran = true;
        return 'value';
      }),
    ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(ran).toBe(false);

    const bypassEvents: GuardEvent[] = [];
    const open = makeGuard(unavailable, clock, {
      onStoreFailure: 'open',
      hooks: { onGuardBypassed: (event) => bypassEvents.push(event) },
    });
    const outcome = await open.run({ tool: 'pay.tool', args: {} }, async () => 'ran unprotected');
    expect(outcome.status).toBe('executed');
    expect(outcome.value).toBe('ran unprotected');
    expect(outcome.record).toBeNull();
    expect(bypassEvents).toHaveLength(1);
    expect(bypassEvents[0]?.type).toBe('guard-bypassed');
  });

  it('S5: a tool that succeeds but fails to record still returns its result and emits store-write-failed', async () => {
    const clock = makeClock();
    const failures: GuardEvent[] = [];
    const guard = makeGuard(new WriteFailStore(), clock, {
      hooks: { onStoreWriteFailed: (event) => failures.push(event) },
    });

    const outcome = await guard.run({ tool: 'pay.tool', args: { amount: 10 } }, async () => 'paid');
    expect(outcome.status).toBe('executed');
    expect(outcome.value).toBe('paid');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.type).toBe('store-write-failed');
  });

  it('hooks: a throwing hook is logged to stderr and never breaks the call', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, {
      timeoutMs: 60_000,
      hooks: {
        onExecute: () => {
          throw new Error('hook exploded');
        },
      },
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const outcome = await guard.run({ tool: 'pay.tool', args: {} }, async () => 'safe');
      expect(outcome.status).toBe('executed');
      expect(outcome.value).toBe('safe');
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('timer cleanup: after a call finishes no lease timer remains active', async () => {
    const store = createStore();
    vi.useFakeTimers();
    try {
      const guard = createGuard({ store, timeoutMs: 1_000 });
      guards.add(guard);
      const running = controlled<string>();
      const call = guard.run({ tool: 'pay.tool', args: {} }, () => running.promise);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      running.resolve('done');
      await call;
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wrap returns the value on executed and duplicate, and throws TwiceshyError subclasses on blocks', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });
    const refund = guard.wrap('paystack.refund', async (args: { amount: number }) => {
      return `paid ${args.amount}`;
    });

    expect(await refund({ amount: 5 })).toBe('paid 5');
    expect(await refund({ amount: 5 })).toBe('paid 5');

    await expect(
      guard.run({ tool: 'other.tool', args: {} }, () => {
        throw new Error('timeout');
      }),
    ).rejects.toThrow('timeout');
    const doubtful = guard.wrap('other.tool', async () => 'never');
    await expect(doubtful({})).rejects.toBeInstanceOf(InDoubtError);
  });

  it('list, get, resolve, and allowRepeat work and require a person name', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    const outcome = await guard.run(
      { tool: 'paystack.refund', args: { amount: 1500 } },
      async () => 'R1',
    );
    const recordId = outcome.record?.id as string;
    const fingerprint = outcome.record?.fingerprint as string;

    const listed = await guard.list({});
    expect(listed).toHaveLength(1);
    expect((await guard.get(recordId))?.id).toBe(recordId);

    await expect(
      guard.resolve(recordId, { as: 'succeeded' } as unknown as ResolveRequest),
    ).rejects.toBeInstanceOf(ConfigInvalidError);
    await expect(
      guard.allowRepeat(fingerprint, {} as unknown as AllowRepeatRequest),
    ).rejects.toBeInstanceOf(ConfigInvalidError);
    expect((await guard.get(recordId))?.resolvedBy).toBeNull();

    await guard.resolve(recordId, { as: 'succeeded', by: 'kola', note: 'checked' });
    const resolved = await guard.get(recordId);
    expect(resolved?.resolvedBy).toBe('kola');
    expect(resolved?.resolutionNote).toBe('checked');
    expect(resolved?.state).toBe('RESOLVED_SUCCEEDED');

    const next = await guard.run(
      { tool: 'paystack.refund', args: { amount: 1500 } },
      async () => 'R2',
    );
    expect(next.status).toBe('duplicate');

    await guard.run({ tool: 'repeatable.tool', args: { id: 1 } }, async () => 'A');
    const grantedFingerprint = (await guard.list({ toolName: 'repeatable.tool' }))[0]
      ?.fingerprint as string;
    await guard.allowRepeat(grantedFingerprint, { by: 'kola', note: 'asked twice' });
    const grant = (await guard.list({ toolName: 'repeatable.tool' }))[0]?.repeatGrant;
    expect(grant?.grantedBy).toBe('kola');
    expect(grant?.note).toBe('asked twice');
  });

  it('close waits for in-flight calls, then closes the store', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000, closeTimeoutMs: 5_000 });

    const running = controlled<string>();
    const call = guard.run({ tool: 'pay.tool', args: {} }, () => running.promise);
    await flushAsync();
    const closing = guard.close();
    running.resolve('done');
    await call;
    await closing;
    expect(clock.pendingTimers()).toBe(0);
    await expect(
      guard.run({ tool: 'after.close', args: {} }, async () => 'x'),
    ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
  });

  it('warns about keyFields missing from the arguments and still runs', async () => {
    const store = createStore();
    const clock = makeClock();
    const warnings: GuardEvent[] = [];
    const guard = makeGuard(store, clock, {
      timeoutMs: 60_000,
      hooks: { onWarning: (event) => warnings.push(event) },
    });

    const outcome = await guard.run(
      { tool: 'pay.tool', args: { amount: 1500 }, keyFields: ['amount', 'customer'] },
      async () => 'ran',
    );
    expect(outcome.status).toBe('executed');
    expect(outcome.value).toBe('ran');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.missing).toEqual(['customer']);
  });

  it('uses a custom classifier to mark a failure definite', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, {
      timeoutMs: 60_000,
      classifyError: () => 'definite',
    });
    await expect(
      guard.run({ tool: 'pay.tool', args: {} }, () => {
        throw new Error('provider rejected it');
      }),
    ).rejects.toThrow('provider rejected it');
    const [record] = await guard.list({});
    expect(record?.state).toBe('FAILED_DEFINITE');
  });

  it('purge removes records past retention and never removes unresolved IN_DOUBT records', async () => {
    const store = createStore();
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });

    const done = await guard.run({ tool: 'old.tool', args: {} }, async () => 'done');
    await expect(
      guard.run({ tool: 'doubt.tool', args: {} }, () => {
        throw new Error('timeout');
      }),
    ).rejects.toThrow('timeout');

    await clock.advance(8 * 24 * 3_600_000);
    const removed = await guard.purge();
    expect(removed).toBe(1);
    expect(await guard.get(done.record?.id as string)).toBeNull();
    expect(await guard.list({ state: 'IN_DOUBT' })).toHaveLength(1);
  });

  it('keeps running when a lease renewal write fails', async () => {
    const base = createStore();
    const store = failingRenewStore(base);
    const clock = makeClock();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000 });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const running = controlled<string>();
      const call = guard.run({ tool: 'pay.tool', args: {} }, () => running.promise);
      await flushAsync();
      await clock.advance(31_000);
      running.resolve('still fine');
      const outcome = await call;
      expect(outcome.status).toBe('executed');
      expect(outcome.value).toBe('still fine');
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('a failed late write after a timeout is isolated and emits store-write-failed', async () => {
    const clock = makeClock();
    const failures: GuardEvent[] = [];
    const guard = makeGuard(new WriteFailStore(), clock, {
      timeoutMs: 1_000,
      hooks: { onStoreWriteFailed: (event) => failures.push(event) },
    });

    const running = controlled<string>();
    const call = guard.run({ tool: 'pay.tool', args: {} }, () => running.promise);
    await flushAsync();
    const rejection = expect(call).rejects.toBeInstanceOf(InDoubtError);
    await clock.advance(1_000);
    await rejection;
    expect(failures).toHaveLength(1);

    running.resolve('late result with nowhere to go');
    await until(() => failures.length >= 2);
    expect(failures[1]?.type).toBe('store-write-failed');
  });

  it('an automatic purge failure is isolated and emits a warning', async () => {
    const clock = makeClock();
    const warnings: GuardEvent[] = [];
    const guard = makeGuard(failingPurgeStore(createStore()), clock, {
      timeoutMs: 60_000,
      hooks: { onWarning: (event) => warnings.push(event) },
    });
    const outcome = await guard.run({ tool: 'pay.tool', args: {} }, async () => 'ok');
    expect(outcome.status).toBe('executed');
    await until(() => warnings.some((event) => event.reason === 'automatic purge failed'));
    expect(warnings[0]?.type).toBe('warning');
  });

  it('a store read failure after the tool ran still returns the tool result', async () => {
    const clock = makeClock();
    const warnings: GuardEvent[] = [];
    const guard = makeGuard(new ReadFailStore(), clock, {
      timeoutMs: 60_000,
      hooks: { onWarning: (event) => warnings.push(event) },
    });
    const outcome = await guard.run({ tool: 'pay.tool', args: {} }, async () => 'paid');
    expect(outcome.status).toBe('executed');
    expect(outcome.value).toBe('paid');
    expect(warnings.some((event) => event.reason === 'could not re-read record')).toBe(true);
  });
});

describe('createGuard options', () => {
  it('close leaves a shared store open when closeStore is false', async () => {
    const store = new CloseSpyStore();
    const shared = createGuard({ store, closeStore: false });
    const owner = createGuard({ store, closeStore: false });
    await shared.close();
    await owner.close();
    expect(store.closes).toBe(0);

    const closing = createGuard({ store });
    await closing.close();
    expect(store.closes).toBe(1);
  });

  it('validates every option and lists all problems in a single CONFIG_INVALID error', () => {
    const invalid = {
      store: null,
      namespace: '',
      window: 'ten minutes',
      retention: -5,
      onStoreFailure: 'maybe',
      waitForInFlightMs: 1.5,
      maxResultBytes: 0,
      leaseMs: 0,
      trustIdempotentHint: 'yes',
      redact: [123],
      classifyError: 'not a function',
      hooks: { onExecute: 'not a function' },
      clock: { now: 'not a function' },
    };
    let caught: unknown;
    try {
      createGuard(invalid as unknown as CreateGuardOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    const error = caught as ConfigInvalidError;
    expect(error.code).toBe('CONFIG_INVALID');
    for (const field of [
      'store',
      'namespace',
      'window',
      'retention',
      'onStoreFailure',
      'waitForInFlightMs',
      'maxResultBytes',
      'leaseMs',
      'trustIdempotentHint',
      'redact',
      'classifyError',
      'hooks.onExecute',
      'clock',
    ]) {
      expect(error.why).toContain(field);
    }
  });

  it('accepts an empty options object apart from the store and uses spec defaults', async () => {
    const guard = createGuard({ store: new MemoryStore() });
    guards.add(guard);
    const outcome = await guard.run({ tool: 'default.tool', args: {} }, async () => 'ok');
    expect(outcome.status).toBe('executed');
    expect(outcome.value).toBe('ok');
  });

  it('rejects a run request without a tool name', async () => {
    const guard = createGuard({ store: new MemoryStore() });
    guards.add(guard);
    await expect(guard.run({ tool: '', args: {} }, async () => 'never')).rejects.toBeInstanceOf(
      ConfigInvalidError,
    );
  });

  it('rejects a clock that is not an object with now() and timers', () => {
    let caught: unknown;
    try {
      createGuard({
        store: new MemoryStore(),
        clock: 'tomorrow',
      } as unknown as CreateGuardOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    expect((caught as ConfigInvalidError).why).toContain('clock');
  });

  it('wrap keeps the wrapped function parameter and return types', () => {
    const guard = createGuard({ store: new MemoryStore() });
    guards.add(guard);
    type RefundArgs = { transaction: string; amount: number };
    const refund = async (args: RefundArgs): Promise<{ receipt: string }> => ({
      receipt: args.transaction,
    });
    const wrapped = guard.wrap('paystack.refund', refund, { keyFields: ['transaction'] });
    expectTypeOf(wrapped).parameters.toEqualTypeOf<[args: RefundArgs]>();
    expectTypeOf(wrapped).returns.toEqualTypeOf<Promise<{ receipt: string }>>();
    expectTypeOf(wrapped).toEqualTypeOf<typeof refund>();
  });
});
