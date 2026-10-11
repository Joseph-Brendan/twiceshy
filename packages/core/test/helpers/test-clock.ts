import type { GuardClock } from '../../src/index.js';

interface ScheduledTimer {
  at: number;
  handler: () => void;
}

/**
 * A manual clock so no guard test ever waits for real time. Tests choose
 * exactly when timers fire by calling `advance(ms)`.
 */
export class TestClock implements GuardClock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, ScheduledTimer>();

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + Math.max(0, ms), handler });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Runs every timer due within `ms`, letting promises settle in between. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.nextDue();
      if (due === null || due.at > target) {
        break;
      }
      this.current = due.at;
      this.timers.delete(due.id);
      due.handler();
      await flushAsync();
    }
    this.current = target;
    await flushAsync();
  }

  private nextDue(): { id: number; at: number; handler: () => void } | null {
    let best: { id: number; at: number; handler: () => void } | null = null;
    for (const [id, timer] of this.timers) {
      if (best === null || timer.at < best.at) {
        best = { id, at: timer.at, handler: timer.handler };
      }
    }
    return best;
  }
}

/** Lets queued microtasks and immediates run without waiting for real time. */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Runs immediates until `condition` is true; fails after a bounded number. */
export async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }
    await flushAsync();
  }
  throw new Error('condition was never met');
}
