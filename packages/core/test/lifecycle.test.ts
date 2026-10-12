import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionStore,
  BeginInput,
  CompleteInput,
  CreateGuardOptions,
  Guard,
} from '../src/index.js';
import { createGuard, InDoubtError, MemoryStore, StoreUnavailableError } from '../src/index.js';
import { SqliteStore } from '../src/stores/sqlite.js';
import { flushAsync, TestClock, until } from './helpers/test-clock.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

const tempDirs = new Set<string>();
const guards = new Set<Guard>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-lifecycle-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...guards].map((guard) => guard.close().catch(() => undefined)));
  guards.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeGuard(
  store: ActionStore,
  clock: TestClock,
  options: Partial<CreateGuardOptions> = {},
): Guard {
  const guard = createGuard({ store, clock, ...options });
  guards.add(guard);
  return guard;
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

const BEGIN: BeginInput = {
  fingerprint: 'fp-life',
  explicitKey: null,
  serverId: 'local',
  toolName: 'test.tool',
  scope: '',
  redactedArgs: {},
  now: NOW,
  settings: { windowMs: 600_000, waitForInFlightMs: 5_000, leaseMs: 30_000 },
};

const COMPLETE: CompleteInput = {
  attemptToken: 'token-1',
  outcome: { type: 'success', result: { ok: true } },
  now: NOW,
  settings: BEGIN.settings,
};

describe('store calls after close()', () => {
  it('every SqliteStore call after close() throws STORE_UNAVAILABLE instead of crashing', async () => {
    const store = new SqliteStore({ path: join(tempDir(), 'actions.db') });
    await store.close();

    const calls: (() => Promise<unknown>)[] = [
      () => store.begin(BEGIN),
      () => store.renewLease('missing', NOW),
      () => store.complete('missing', COMPLETE),
      () => store.get('missing'),
      () => store.findByIdentity('missing'),
      () => store.list({}),
      () => store.resolve('missing', { as: 'failed', by: 'kola', at: NOW }),
      () => store.grantRepeat('missing', { grantedAt: NOW }),
      () => store.purge(NOW),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(StoreUnavailableError);
    }

    // Closing twice is safe.
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('every MemoryStore call after close() throws STORE_UNAVAILABLE', async () => {
    const store = new MemoryStore();
    await store.close();

    const calls: (() => Promise<unknown>)[] = [
      () => store.begin(BEGIN),
      () => store.renewLease('missing', NOW),
      () => store.complete('missing', COMPLETE),
      () => store.get('missing'),
      () => store.findByIdentity('missing'),
      () => store.list({}),
      () => store.resolve('missing', { as: 'failed', by: 'kola', at: NOW }),
      () => store.grantRepeat('missing', { grantedAt: NOW }),
      () => store.purge(NOW),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(StoreUnavailableError);
    }

    await expect(store.close()).resolves.toBeUndefined();
  });

  it('a guard call after close() throws STORE_UNAVAILABLE', async () => {
    const clock = new TestClock(NOW);
    const guard = makeGuard(new MemoryStore(), clock, { timeoutMs: 60_000 });
    await guard.close();
    await expect(
      guard.run({ tool: 'after.close', args: {} }, async () => 'x'),
    ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
  });
});

class CountingMemoryStore extends MemoryStore {
  completes = 0;

  override async complete(id: string, input: CompleteInput) {
    this.completes += 1;
    return super.complete(id, input);
  }
}

class SlowPurgeStore extends MemoryStore {
  readonly gate = controlled<void>();
  closedByGuard = false;

  override async purge(olderThan: Date): Promise<number> {
    await this.gate.promise;
    return super.purge(olderThan);
  }

  override async close(): Promise<void> {
    this.closedByGuard = true;
    await super.close();
  }
}

describe('guard close() waits for and cancels pending work', () => {
  it('close() waits for an in-flight automatic purge before closing the store', async () => {
    const clock = new TestClock(NOW);
    const store = new SlowPurgeStore();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000, closeTimeoutMs: 10_000 });

    const outcome = await guard.run({ tool: 'purge.tool', args: {} }, async () => 'ok');
    expect(outcome.status).toBe('executed');

    let closed = false;
    const closing = guard.close().then(() => {
      closed = true;
    });
    await flushAsync();
    expect(closed).toBe(false);
    expect(store.closedByGuard).toBe(false);

    store.gate.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(store.closedByGuard).toBe(true);
  });

  it('close() gives up waiting for a stuck purge after closeTimeoutMs', async () => {
    const clock = new TestClock(NOW);
    const store = new SlowPurgeStore();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000, closeTimeoutMs: 500 });

    await guard.run({ tool: 'stuck.purge', args: {} }, async () => 'ok');
    const closing = guard.close();
    await flushAsync();
    await clock.advance(500);
    await expect(closing).resolves.toBeUndefined();
    expect(store.closedByGuard).toBe(true);
  });

  it('close() cancels a late-completion watcher, so nothing is written after close', async () => {
    const clock = new TestClock(NOW);
    const path = join(tempDir(), 'late.db');
    const guard = makeGuard(new SqliteStore({ path }), clock, { timeoutMs: 1_000 });

    const running = controlled<string>();
    const call = guard.run({ tool: 'slow.payment', args: { amount: 1 } }, () => running.promise);
    await flushAsync();
    const rejection = expect(call).rejects.toBeInstanceOf(InDoubtError);
    await clock.advance(1_000);
    await rejection;

    const [record] = await guard.list({ state: 'IN_DOUBT' });
    const recordId = record?.id as string;

    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await guard.close();
      running.resolve('late result that must not be written');
      for (let flush = 0; flush < 5; flush += 1) {
        await flushAsync();
      }
    } finally {
      spy.mockRestore();
    }

    expect(stderr.join('')).not.toContain('late completion failed');
    const reopened = new SqliteStore({ path });
    const stored = await reopened.get(recordId);
    expect(stored?.state).toBe('IN_DOUBT');
    expect(stored?.result).toBeUndefined();
    await reopened.close();
  });

  it('close() stops the hourly purge from being scheduled again', async () => {
    const clock = new TestClock(NOW);
    const store = new SlowPurgeStore();
    store.gate.resolve();
    const guard = makeGuard(store, clock, { timeoutMs: 60_000, closeTimeoutMs: 10_000 });
    await guard.close();

    // A call that started before close cannot schedule a new purge after it.
    expect(clock.pendingTimers()).toBe(0);
  });

  it('a late result arriving after close() is dropped without another store write', async () => {
    const clock = new TestClock(NOW);
    const inner = new CountingMemoryStore();
    const guard = makeGuard(inner, clock, { timeoutMs: 1_000 });

    const running = controlled<string>();
    const call = guard.run({ tool: 'slow.drop', args: {} }, () => running.promise);
    await flushAsync();
    const rejection = expect(call).rejects.toBeInstanceOf(InDoubtError);
    await clock.advance(1_000);
    await rejection;
    const writesBeforeClose = inner.completes;
    expect(writesBeforeClose).toBe(1);

    await guard.close();
    running.resolve('too late');
    await until(() => clock.pendingTimers() === 0);
    for (let flush = 0; flush < 5; flush += 1) {
      await flushAsync();
    }
    expect(inner.completes).toBe(writesBeforeClose);
  });
});
