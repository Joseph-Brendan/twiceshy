import { describe, expect, it } from 'vitest';
import { createGuard, MemoryStore } from '../src/index.js';

/**
 * X1: real in-process concurrency on MemoryStore. Kept in the normal suite
 * because it finishes in well under two seconds.
 */
describe('X1: MemoryStore concurrency', () => {
  it('X1: 100 identical calls started at once run the tool once and all callers get the same result', async () => {
    const guard = createGuard({
      store: new MemoryStore(),
      window: '1m',
      waitForInFlightMs: 2_000,
    });

    const result = { receipt: 'R-1', amount: 1500 };
    let ran = 0;
    const calls = Array.from({ length: 100 }, () =>
      guard.run({ tool: 'stress.transfer', args: { amount: 1500, to: 'ife' } }, async () => {
        ran += 1;
        return result;
      }),
    );

    const outcomes = await Promise.all(calls);

    expect(ran).toBe(1);
    expect(outcomes).toHaveLength(100);
    const executed = outcomes.filter((outcome) => outcome.status === 'executed');
    const duplicates = outcomes.filter((outcome) => outcome.status === 'duplicate');
    expect(executed).toHaveLength(1);
    expect(duplicates).toHaveLength(99);
    for (const outcome of outcomes) {
      expect(outcome.value).toEqual(result);
    }

    await guard.close();
  });
});
