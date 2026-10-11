import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESTART_DELAYS_MS, RestartScheduler } from '../src/index.js';

describe('restart backoff (C13)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('P6: the restart schedule is 1s, 2s, 4s, 8s, 16s, then gives up after five attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const attempts: number[] = [];
    let gaveUp = 0;
    const scheduler = new RestartScheduler({
      tryRestart: async () => {
        attempts.push(Date.now());
        return false;
      },
      onGaveUp: () => {
        gaveUp += 1;
      },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toEqual([1_000]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toEqual([1_000, 3_000]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(attempts).toEqual([1_000, 3_000, 7_000]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(attempts).toEqual([1_000, 3_000, 7_000, 15_000]);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(attempts).toEqual([1_000, 3_000, 7_000, 15_000, 31_000]);
    expect(gaveUp).toBe(1);

    // Nothing more happens: five attempts is the limit.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(attempts).toHaveLength(5);
    expect(RESTART_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('resets the schedule after a successful restart', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let gaveUp = 0;
    const scheduler = new RestartScheduler({
      tryRestart: async () => {
        calls += 1;
        return calls >= 2;
      },
      onGaveUp: () => {
        gaveUp += 1;
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
    expect(gaveUp).toBe(0);
  });

  it('treats a throwing reconnection as a failed attempt', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let gaveUp = 0;
    const scheduler = new RestartScheduler({
      tryRestart: async () => {
        calls += 1;
        throw new Error('spawn failed');
      },
      onGaveUp: () => {
        gaveUp += 1;
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(2);
    scheduler.stop();
    expect(gaveUp).toBe(0);
  });

  it('stop during a pending attempt stops the schedule', async () => {
    vi.useFakeTimers();
    let resolveAttempt: (() => void) | undefined;
    let calls = 0;
    const scheduler = new RestartScheduler({
      tryRestart: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          resolveAttempt = resolve;
        });
        return false;
      },
      onGaveUp: () => undefined,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    scheduler.stop();
    resolveAttempt?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });

  it('stop cancels a pending attempt', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scheduler = new RestartScheduler({
      tryRestart: async () => {
        calls += 1;
        return false;
      },
      onGaveUp: () => undefined,
    });
    scheduler.start();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(0);
  });
});
