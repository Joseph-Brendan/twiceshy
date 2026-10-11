/**
 * Restart backoff for a crashed downstream server (C13): 1 s, 2 s, 4 s, 8 s,
 * 16 s, capped at 30 s, five attempts, then give up. The timer functions are
 * injectable so the schedule can be proven with fake timers.
 */

export const RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];
export const RESTART_MAX_DELAY_MS = 30_000;

export interface RestartSchedulerOptions {
  /** Attempts a reconnection. Resolves true when the server is back. */
  tryRestart: () => Promise<boolean>;
  /** Called once after the last attempt fails. */
  onGaveUp: () => void;
  /** Called (debugging only) with the delay before each attempt. */
  onScheduled?: (attempt: number, delayMs: number) => void;
  /** Overrides the default backoff schedule; tests use tiny delays. */
  delaysMs?: readonly number[];
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class RestartScheduler {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: RestartSchedulerOptions) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      (this.options.clearTimeoutFn ?? clearTimeout)(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    const delays = this.options.delaysMs ?? RESTART_DELAYS_MS;
    if (this.attempt >= delays.length) {
      this.options.onGaveUp();
      return;
    }
    const delay = Math.min(delays[this.attempt] as number, RESTART_MAX_DELAY_MS);
    this.attempt += 1;
    this.options.onScheduled?.(this.attempt, delay);
    const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout;
    this.timer = setTimeoutFn(() => {
      void this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    if (this.stopped) {
      return;
    }
    let recovered = false;
    try {
      recovered = await this.options.tryRestart();
    } catch {
      recovered = false;
    }
    if (this.stopped) {
      return;
    }
    if (recovered) {
      this.attempt = 0;
      return;
    }
    this.schedule();
  }
}
