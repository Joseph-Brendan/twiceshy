import { describe, expect, it } from 'vitest';
import type { BeginInput, EngineSettings } from '../src/index.js';
import { MemoryStore, NotSerializableError } from '../src/index.js';
import { runStoreContract } from '../src/stores/contract.js';

runStoreContract('S1: MemoryStore', () => new MemoryStore());

const NOW = new Date('2026-01-01T00:00:00.000Z');
const SETTINGS: EngineSettings = {
  windowMs: 600_000,
  waitForInFlightMs: 5_000,
  leaseMs: 30_000,
};

function beginInput(redactedArgs: unknown): BeginInput {
  return {
    fingerprint: 'fp',
    explicitKey: null,
    serverId: 'local',
    toolName: 'test.tool',
    scope: '',
    redactedArgs,
    now: NOW,
    settings: SETTINGS,
  };
}

describe('MemoryStore specifics', () => {
  it('rejects unclonable arguments with NOT_SERIALIZABLE and stores nothing', async () => {
    const store = new MemoryStore();
    await expect(store.begin(beginInput({ callback: () => undefined }))).rejects.toBeInstanceOf(
      NotSerializableError,
    );
    expect(await store.list({})).toEqual([]);
    await store.close();
  });

  it('rejects an unclonable result with NOT_SERIALIZABLE and leaves the record in flight', async () => {
    const store = new MemoryStore();
    const result = await store.begin(beginInput({ amount: 1 }));
    if (result.kind !== 'execute') throw new Error('expected execute');
    await expect(
      store.complete(result.record.id, {
        attemptToken: result.record.attemptToken,
        outcome: { type: 'success', result: { callback: () => undefined } },
        now: NOW,
        settings: SETTINGS,
      }),
    ).rejects.toBeInstanceOf(NotSerializableError);
    expect((await store.get(result.record.id))?.state).toBe('IN_FLIGHT');
    await store.close();
  });
});
