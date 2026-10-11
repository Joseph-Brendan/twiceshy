import { z } from 'zod';
import type { CustomErrorClassifier } from './classify.js';
import { classifyError } from './classify.js';
import { parseDuration } from './duration.js';
import type { EngineSettings, ExecutionOutcome } from './engine.js';
import {
  ConfigInvalidError,
  InDoubtError,
  InProgressError,
  KeyConflictError,
  StoreUnavailableError,
} from './errors.js';
import type { NormalizerMap } from './fingerprint.js';
import { computeFingerprint } from './fingerprint.js';
import { redact } from './redact.js';
import type {
  ActionRecord,
  ActionStore,
  BeginInput,
  BeginResult,
  ListFilter,
  RepeatGrant,
} from './stores/types.js';
import { DEFAULT_MAX_RESULT_BYTES } from './stores/types.js';

/**
 * The guard: the C11 public library API. It combines the pure decision engine
 * with a store, an injectable clock, and structured events (C15).
 */

/** Defaults from C11/C12. */
const DEFAULT_NAMESPACE = 'local';
const DEFAULT_WINDOW = '10m';
const DEFAULT_RETENTION = '7d';
const DEFAULT_WAIT_FOR_IN_FLIGHT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

/** C6: the default lease is timeoutMs + 30 s. */
const LEASE_SLACK_MS = 30_000;

/** C6: renew the lease every leaseMs / 3. */
const LEASE_RENEW_DIVISOR = 3;

/** How often a waiting caller re-checks the in-flight record. */
const WAIT_POLL_MS = 50;

/** C12: automatic purge runs at most once an hour. */
const PURGE_INTERVAL_MS = 3_600_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Injectable clock (C11: "clock: undefined // injectable for tests"). Tests
 * substitute a manual clock, so no test ever waits for real time.
 */
export interface GuardClock {
  now(): Date;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const systemClock: GuardClock = {
  now: () => new Date(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** The event type emitted for each decision (C15). */
export type GuardEventType =
  | 'execute'
  | 'duplicate'
  | 'blocked'
  | 'in-doubt'
  | 'late-completion'
  | 'store-write-failed'
  | 'guard-bypassed'
  | 'warning';

/** One structured event, with the fields required by C15. */
export interface GuardEvent {
  type: GuardEventType;
  at: Date;
  recordId: string | null;
  fingerprint: string;
  tool: string;
  server: string;
  scope: string;
  durationMs: number;
  attempt: number;
  /** Short reason, for example "timeout", "key-conflict", "in-progress". */
  reason?: string;
  /** keyFields that were missing from the arguments. */
  missing?: readonly string[];
  /** The original error, for store-write-failed and in-doubt events. */
  error?: unknown;
}

/** Hooks receive events (C11/C15). A throwing hook never breaks the call. */
export interface GuardHooks {
  onExecute?: (event: GuardEvent) => void;
  onDuplicate?: (event: GuardEvent) => void;
  onBlocked?: (event: GuardEvent) => void;
  onInDoubt?: (event: GuardEvent) => void;
  onLateCompletion?: (event: GuardEvent) => void;
  onStoreWriteFailed?: (event: GuardEvent) => void;
  onGuardBypassed?: (event: GuardEvent) => void;
  onWarning?: (event: GuardEvent) => void;
}

const HOOK_FOR_EVENT: Readonly<Record<GuardEventType, keyof GuardHooks>> = {
  execute: 'onExecute',
  duplicate: 'onDuplicate',
  blocked: 'onBlocked',
  'in-doubt': 'onInDoubt',
  'late-completion': 'onLateCompletion',
  'store-write-failed': 'onStoreWriteFailed',
  'guard-bypassed': 'onGuardBypassed',
  warning: 'onWarning',
};

/** Options accepted by createGuard (C11). Every field is validated by Zod. */
export interface CreateGuardOptions {
  store: ActionStore;
  /** Becomes serverId in fingerprints. Default "local". */
  namespace?: string;
  /** How long a finished action counts as a duplicate. Default "10m". */
  window?: number | string;
  /** How long records are kept for audit. Default "7d". */
  retention?: number | string;
  /** Behaviour when the store is down. Default "closed". */
  onStoreFailure?: 'closed' | 'open';
  /** How long a second caller waits. Default 5000. */
  waitForInFlightMs?: number;
  /** Largest result stored in full. Default 256 KB. */
  maxResultBytes?: number;
  /** Default per-call timeout. Default 30000. */
  timeoutMs?: number;
  /** How long close() waits for in-flight calls. Default 30000. */
  closeTimeoutMs?: number;
  /** Trust MCP idempotentHint annotations. Default true. */
  trustIdempotentHint?: boolean;
  /** Extra fields to redact, on top of the C12 defaults. */
  redact?: readonly string[];
  /** Replaces the built-in C7 classifier. */
  classifyError?: CustomErrorClassifier;
  hooks?: GuardHooks;
  clock?: GuardClock;
}

/** Normalized options after parsing and defaults. */
interface NormalizedGuardOptions {
  store: ActionStore;
  namespace: string;
  windowMs: number;
  retentionMs: number;
  onStoreFailure: 'closed' | 'open';
  waitForInFlightMs: number;
  maxResultBytes: number;
  timeoutMs: number;
  closeTimeoutMs: number;
  trustIdempotentHint: boolean;
  redact: readonly string[];
  classifyError: CustomErrorClassifier | undefined;
  hooks: GuardHooks;
  clock: GuardClock;
}

/** A request to guard one call (C11 examples). */
export interface RunRequest {
  tool: string;
  args: Record<string, unknown>;
  /** Explicit key; overrides the fingerprint as the identity. */
  key?: string;
  scope?: string;
  keyFields?: readonly string[];
  ignoreFields?: readonly string[];
  normalize?: NormalizerMap;
  /** Overrides the guard's default timeout for this call. */
  timeoutMs?: number;
  /** Cancellation signal; a cancelled call becomes IN_DOUBT (C6). */
  signal?: AbortSignal;
  /** Store the result (default true); false keeps a short summary. */
  storeResult?: boolean;
}

/** What guard.run returns on success (C8). */
export type GuardOutcome<T> =
  | {
      status: 'executed';
      value: T;
      /** Null only when onStoreFailure "open" bypassed an unavailable store. */
      record: ActionRecord | null;
    }
  | {
      status: 'duplicate';
      value: T;
      record: ActionRecord;
      /**
       * When the original completed. Null mirrors the engine's defensive case
       * for a SUCCEEDED record without a completion time; the store contract
       * makes that impossible in practice.
       */
      originalAt: Date | null;
    };

/** Options accepted by guard.wrap (C11). */
export interface WrapOptions<A extends object> {
  keyFields?: readonly string[];
  ignoreFields?: readonly string[];
  normalize?: NormalizerMap;
  /** Who the action belongs to; computed from the arguments. */
  scope?: (args: A) => string;
  timeoutMs?: number;
  storeResult?: boolean;
}

/** Human resolution of an in-doubt record (C11). */
export interface ResolveRequest {
  as: 'succeeded' | 'failed';
  /** The person approving. Required: agents cannot approve their own work. */
  by: string;
  note?: string;
}

/** A human-approved repeat (C11). */
export interface AllowRepeatRequest {
  /** The person approving. Required. */
  by: string;
  note?: string;
}

/** The public guard API (C11). */
export interface Guard {
  run<T>(request: RunRequest, fn: () => T | Promise<T>): Promise<GuardOutcome<T>>;
  wrap<A extends object, R>(
    tool: string,
    fn: (args: A) => R | Promise<R>,
    options?: WrapOptions<A>,
  ): (args: A) => Promise<Awaited<R>>;
  list(filter?: ListFilter): Promise<ActionRecord[]>;
  get(id: string): Promise<ActionRecord | null>;
  resolve(id: string, resolution: ResolveRequest): Promise<void>;
  allowRepeat(fingerprint: string, grant: AllowRepeatRequest): Promise<void>;
  purge(olderThan?: Date): Promise<number>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Option validation (C11: one CONFIG_INVALID listing every problem at once)
// ---------------------------------------------------------------------------

const DURATION_EXPECTED =
  'expected a duration such as "10m", "30s", "7d", or a whole number of milliseconds such as 600000';

const durationSchema = z.custom<number | string>(
  (value) => {
    try {
      parseDuration(value);
      return true;
    } catch {
      return false;
    }
  },
  { error: `${DURATION_EXPECTED}, for example "10m"` },
);

const hookSchema = z.custom<(event: GuardEvent) => void>((value) => typeof value === 'function', {
  error: 'expected a function, for example (event) => console.log(event.type)',
});

const storeSchema = z.custom<ActionStore>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const required = [
      'begin',
      'renewLease',
      'complete',
      'get',
      'findByIdentity',
      'list',
      'resolve',
      'grantRepeat',
      'purge',
      'close',
    ] as const;
    const candidate = value as Record<string, unknown>;
    return required.every((name) => typeof candidate[name] === 'function');
  },
  { error: 'expected an ActionStore, for example new MemoryStore()' },
);

const clockSchema = z.custom<GuardClock>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.now === 'function' &&
      typeof candidate.setTimeout === 'function' &&
      typeof candidate.clearTimeout === 'function'
    );
  },
  {
    error:
      'expected an object with now(), setTimeout(), and clearTimeout(), for example { now: () => new Date(), setTimeout, clearTimeout }',
  },
);

const optionsSchema = z.object({
  store: storeSchema,
  namespace: z
    .string()
    .min(1, { error: 'expected a non-empty string, for example "kola-delivery"' })
    .optional(),
  window: durationSchema.optional(),
  retention: durationSchema.optional(),
  onStoreFailure: z
    .enum(['closed', 'open'], { error: 'expected "closed" or "open", for example "closed"' })
    .optional(),
  waitForInFlightMs: z
    .number()
    .int({ error: 'expected a whole number of milliseconds, for example 5000' })
    .nonnegative({ error: 'expected zero or more milliseconds, for example 5000' })
    .optional(),
  maxResultBytes: z
    .number()
    .int({ error: 'expected a whole number of bytes, for example 262144' })
    .positive({ error: 'expected a positive number of bytes, for example 262144' })
    .optional(),
  timeoutMs: durationSchema.optional(),
  closeTimeoutMs: durationSchema.optional(),
  trustIdempotentHint: z.boolean({ error: 'expected true or false, for example true' }).optional(),
  redact: z
    .array(
      z.string().min(1, { error: 'expected non-empty field names, for example ["card.number"]' }),
      { error: 'expected an array of field names, for example ["card.number", "pin"]' },
    )
    .optional(),
  classifyError: z
    .custom<CustomErrorClassifier>((value) => typeof value === 'function', {
      error: 'expected a function, for example (error) => "ambiguous"',
    })
    .optional(),
  hooks: z
    .object({
      onExecute: hookSchema.optional(),
      onDuplicate: hookSchema.optional(),
      onBlocked: hookSchema.optional(),
      onInDoubt: hookSchema.optional(),
      onLateCompletion: hookSchema.optional(),
      onStoreWriteFailed: hookSchema.optional(),
      onGuardBypassed: hookSchema.optional(),
      onWarning: hookSchema.optional(),
    })
    .optional(),
  clock: clockSchema.optional(),
});

const resolutionSchema = z.object({
  as: z.enum(['succeeded', 'failed'], {
    error: 'expected "succeeded" or "failed", for example "succeeded"',
  }),
  by: z.string().min(1, { error: 'expected the name of the person approving, for example "kola"' }),
  note: z.string().optional(),
});

const repeatGrantSchema = z.object({
  by: z.string().min(1, { error: 'expected the name of the person approving, for example "kola"' }),
  note: z.string().optional(),
});

function normalizeHooks(hooks: z.infer<typeof optionsSchema>['hooks']): GuardHooks {
  if (hooks === undefined) {
    return {};
  }
  return {
    ...(hooks.onExecute === undefined ? {} : { onExecute: hooks.onExecute }),
    ...(hooks.onDuplicate === undefined ? {} : { onDuplicate: hooks.onDuplicate }),
    ...(hooks.onBlocked === undefined ? {} : { onBlocked: hooks.onBlocked }),
    ...(hooks.onInDoubt === undefined ? {} : { onInDoubt: hooks.onInDoubt }),
    ...(hooks.onLateCompletion === undefined ? {} : { onLateCompletion: hooks.onLateCompletion }),
    ...(hooks.onStoreWriteFailed === undefined
      ? {}
      : { onStoreWriteFailed: hooks.onStoreWriteFailed }),
    ...(hooks.onGuardBypassed === undefined ? {} : { onGuardBypassed: hooks.onGuardBypassed }),
    ...(hooks.onWarning === undefined ? {} : { onWarning: hooks.onWarning }),
  };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.length === 0 ? 'options' : issue.path.join('.');
  return `${field}: ${issue.message}`;
}

function invalidOptions(issues: readonly string[]): ConfigInvalidError {
  return new ConfigInvalidError({ issues });
}

function normalizeOptions(options: CreateGuardOptions): NormalizedGuardOptions {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw invalidOptions(parsed.error.issues.map(describeIssue));
  }
  const data = parsed.data;
  return {
    store: data.store,
    namespace: data.namespace ?? DEFAULT_NAMESPACE,
    windowMs: parseDuration(data.window ?? DEFAULT_WINDOW),
    retentionMs: parseDuration(data.retention ?? DEFAULT_RETENTION),
    onStoreFailure: data.onStoreFailure ?? 'closed',
    waitForInFlightMs: data.waitForInFlightMs ?? DEFAULT_WAIT_FOR_IN_FLIGHT_MS,
    maxResultBytes: data.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    timeoutMs: parseDuration(data.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    closeTimeoutMs: parseDuration(data.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS),
    trustIdempotentHint: data.trustIdempotentHint ?? true,
    redact: data.redact ?? [],
    classifyError: data.classifyError,
    hooks: normalizeHooks(data.hooks),
    clock: data.clock ?? systemClock,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Settled<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };

const TIMEOUT = Symbol('twiceshy.timeout');
const ABORTED = Symbol('twiceshy.aborted');

interface RunningCall<T> {
  race(): Promise<Settled<T> | typeof TIMEOUT | typeof ABORTED>;
  stop(): void;
  settled(): Promise<Settled<T>>;
}

/**
 * Runs `fn` with a timeout and an optional abort signal. The timeout timer is
 * cleared the moment the call settles, so no timer outlives the call.
 */
function startCall<T>(
  clock: GuardClock,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fn: () => T | Promise<T>,
): RunningCall<T> {
  const callPromise = (async (): Promise<Settled<T>> => {
    try {
      return { kind: 'value', value: await fn() };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();

  let timeoutHandle: TimerHandle | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timeoutHandle = clock.setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });

  let abortListener: (() => void) | undefined;
  let abortPromise: Promise<typeof ABORTED> | null = null;
  if (signal !== undefined) {
    abortPromise = new Promise<typeof ABORTED>((resolve) => {
      abortListener = () => resolve(ABORTED);
      signal.addEventListener('abort', abortListener, { once: true });
    });
  }

  let stopped = false;
  return {
    race: () => {
      const promises: Array<Promise<Settled<T> | typeof TIMEOUT | typeof ABORTED>> = [
        callPromise,
        timeoutPromise,
      ];
      if (abortPromise !== null) {
        promises.push(abortPromise);
      }
      return Promise.race(promises);
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timeoutHandle !== undefined) {
        clock.clearTimeout(timeoutHandle);
      }
      if (signal !== undefined && abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
    },
    settled: () => callPromise,
  };
}

interface EventContext {
  fingerprint: string;
  tool: string;
  scope: string;
  startedAt: Date;
  recordId: string | null;
  attempt: number;
}

interface ExecuteContext extends EventContext {
  settings: EngineSettings;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  storeResult: boolean | undefined;
}

interface EventExtras {
  reason?: string;
  missing?: readonly string[];
  error?: unknown;
}

/** A decision that could not run because the store was down in "open" mode. */
type BeginOutcome = BeginResult | { kind: 'bypass' };

function validateTool(tool: string): string {
  if (typeof tool !== 'string' || tool.length === 0) {
    throw invalidOptions(['tool: expected a non-empty string, for example "paystack.refund"']);
  }
  return tool;
}

class DefaultGuard implements Guard {
  private readonly options: NormalizedGuardOptions;
  private readonly activeRenewals = new Set<() => void>();
  private readonly activeCalls = new Set<Promise<unknown>>();
  private closed = false;
  private lastPurgeAt: number | null = null;

  constructor(options: CreateGuardOptions) {
    this.options = normalizeOptions(options);
  }

  async run<T>(request: RunRequest, fn: () => T | Promise<T>): Promise<GuardOutcome<T>> {
    this.assertOpen();
    const call = this.runClaim(request, fn);
    this.activeCalls.add(call);
    try {
      return await call;
    } finally {
      this.activeCalls.delete(call);
    }
  }

  wrap<A extends object, R>(
    tool: string,
    fn: (args: A) => R | Promise<R>,
    options: WrapOptions<A> = {},
  ): (args: A) => Promise<Awaited<R>> {
    return async (args: A): Promise<Awaited<R>> => {
      const request: RunRequest = {
        tool,
        args: args as Record<string, unknown>,
        ...(options.keyFields === undefined ? {} : { keyFields: options.keyFields }),
        ...(options.ignoreFields === undefined ? {} : { ignoreFields: options.ignoreFields }),
        ...(options.normalize === undefined ? {} : { normalize: options.normalize }),
        ...(options.scope === undefined ? {} : { scope: options.scope(args) }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.storeResult === undefined ? {} : { storeResult: options.storeResult }),
      };
      const outcome = await this.run<Awaited<R>>(
        request,
        async (): Promise<Awaited<R>> => await fn(args),
      );
      return outcome.value;
    };
  }

  async list(filter: ListFilter = {}): Promise<ActionRecord[]> {
    this.assertOpen();
    return this.options.store.list(filter);
  }

  async get(id: string): Promise<ActionRecord | null> {
    this.assertOpen();
    return this.options.store.get(id);
  }

  async resolve(id: string, resolution: ResolveRequest): Promise<void> {
    this.assertOpen();
    const parsed = resolutionSchema.safeParse(resolution);
    if (!parsed.success) {
      throw invalidOptions(parsed.error.issues.map(describeIssue));
    }
    await this.options.store.resolve(id, {
      as: parsed.data.as,
      by: parsed.data.by,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      at: this.options.clock.now(),
    });
  }

  async allowRepeat(fingerprint: string, grant: AllowRepeatRequest): Promise<void> {
    this.assertOpen();
    const parsed = repeatGrantSchema.safeParse(grant);
    if (!parsed.success) {
      throw invalidOptions(parsed.error.issues.map(describeIssue));
    }
    const stored: RepeatGrant = {
      grantedAt: this.options.clock.now(),
      grantedBy: parsed.data.by,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    };
    await this.options.store.grantRepeat(fingerprint, stored);
  }

  async purge(olderThan?: Date): Promise<number> {
    this.assertOpen();
    const cutoff =
      olderThan ?? new Date(this.options.clock.now().getTime() - this.options.retentionMs);
    return this.options.store.purge(cutoff);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const stop of [...this.activeRenewals]) {
      stop();
    }
    this.activeRenewals.clear();
    await this.waitForActiveCalls();
    await this.options.store.close();
  }

  private async runClaim<T>(
    request: RunRequest,
    fn: () => T | Promise<T>,
  ): Promise<GuardOutcome<T>> {
    const tool = validateTool(request.tool);
    const args = request.args ?? {};
    const scope = request.scope ?? '';
    const timeoutMs =
      request.timeoutMs === undefined ? this.options.timeoutMs : parseDuration(request.timeoutMs);
    const settings: EngineSettings = {
      windowMs: this.options.windowMs,
      waitForInFlightMs: this.options.waitForInFlightMs,
      leaseMs: timeoutMs + LEASE_SLACK_MS,
    };
    const startedAt = this.options.clock.now();
    const fingerprintResult = computeFingerprint({
      serverId: this.options.namespace,
      toolName: tool,
      scope,
      args,
      options: {
        ...(request.keyFields === undefined ? {} : { keyFields: request.keyFields }),
        ...(request.ignoreFields === undefined ? {} : { ignoreFields: request.ignoreFields }),
        ...(request.normalize === undefined ? {} : { normalize: request.normalize }),
      },
    });
    const context: EventContext = {
      fingerprint: fingerprintResult.fingerprint,
      tool,
      scope,
      startedAt,
      recordId: null,
      attempt: 1,
    };
    if (fingerprintResult.missing.length > 0) {
      this.emit('warning', context, {
        reason: 'keyFields missing from arguments',
        missing: fingerprintResult.missing,
      });
    }

    const beginInput: BeginInput = {
      fingerprint: fingerprintResult.fingerprint,
      explicitKey: request.key ?? null,
      serverId: this.options.namespace,
      toolName: tool,
      scope,
      redactedArgs: redact(args, this.options.redact),
      now: startedAt,
      settings,
    };

    let decision = await this.begin(beginInput, context);
    while (decision.kind === 'wait') {
      const recordId = decision.record.id;
      const current = await this.waitForRecord(recordId, decision.waitMs);
      if (current === null || current.state === 'IN_FLIGHT') {
        this.emit(
          'blocked',
          { ...context, recordId, attempt: decision.record.attempt },
          { reason: 'in-progress' },
        );
        throw new InProgressError({ recordId, fingerprint: context.fingerprint });
      }
      decision = await this.begin(beginInput, context);
    }

    if (decision.kind === 'bypass') {
      const value = await fn();
      return { status: 'executed', value, record: null };
    }

    if (decision.kind === 'duplicate') {
      const duplicateContext: EventContext = {
        ...context,
        recordId: decision.record.id,
        attempt: decision.record.attempt,
      };
      this.emit('duplicate', duplicateContext, { reason: 'inside window' });
      return {
        status: 'duplicate',
        value: decision.originalResult as T,
        record: decision.record,
        originalAt: decision.originalAt,
      };
    }

    if (decision.kind === 'block-in-doubt') {
      const blockedContext: EventContext = {
        ...context,
        recordId: decision.record.id,
        attempt: decision.record.attempt,
      };
      this.emit('in-doubt', blockedContext, { reason: 'lease expired or record in doubt' });
      throw new InDoubtError({
        recordId: decision.record.id,
        fingerprint: context.fingerprint,
      });
    }

    if (decision.kind === 'reject-key-conflict') {
      const conflictContext: EventContext = {
        ...context,
        recordId: decision.record.id,
        attempt: decision.record.attempt,
      };
      this.emit('blocked', conflictContext, { reason: 'key-conflict' });
      throw new KeyConflictError({
        ...(request.key === undefined ? {} : { key: request.key }),
        fingerprint: context.fingerprint,
        recordId: decision.record.id,
      });
    }

    const executeContext: ExecuteContext = {
      ...context,
      recordId: decision.record.id,
      attempt: decision.record.attempt,
      settings,
      timeoutMs,
      signal: request.signal,
      storeResult: request.storeResult,
    };
    return this.executeClaim<T>(decision.record, fn, executeContext);
  }

  private async begin(input: BeginInput, context: EventContext): Promise<BeginOutcome> {
    try {
      return await this.options.store.begin(input);
    } catch (error) {
      if (error instanceof StoreUnavailableError && this.options.onStoreFailure === 'open') {
        this.emit('guard-bypassed', context, { reason: 'store unavailable', error });
        return { kind: 'bypass' };
      }
      throw error;
    }
  }

  private async executeClaim<T>(
    record: ActionRecord,
    fn: () => T | Promise<T>,
    context: ExecuteContext,
  ): Promise<GuardOutcome<T>> {
    if (context.signal?.aborted === true) {
      // Cancelled before the tool ran: C6 says a cancelled call becomes
      // IN_DOUBT, and the safe direction is to refuse a silent retry.
      await this.recordCompletion(record.id, { type: 'cancelled' }, context);
      this.emit('in-doubt', { ...context, recordId: record.id }, { reason: 'cancelled' });
      throw new InDoubtError({ recordId: record.id, fingerprint: context.fingerprint });
    }
    const stopRenewal = this.startLeaseRenewal(record.id, context.settings.leaseMs);
    const running = startCall<T>(this.options.clock, context.timeoutMs, context.signal, fn);
    try {
      const raced = await running.race();
      running.stop();
      if (raced === TIMEOUT || raced === ABORTED) {
        const reason = raced === TIMEOUT ? 'timeout' : 'cancelled';
        const outcome: ExecutionOutcome =
          raced === TIMEOUT ? { type: 'ambiguous-failure' } : { type: 'cancelled' };
        await this.recordCompletion(record.id, outcome, context);
        this.emit('in-doubt', { ...context, recordId: record.id }, { reason });
        // Keep listening: a late result upgrades the in-doubt record (C6).
        this.watchLateCompletion(record.id, running.settled(), context);
        throw new InDoubtError({ recordId: record.id, fingerprint: context.fingerprint });
      }
      return await this.finishExecute(record, raced, context);
    } finally {
      running.stop();
      stopRenewal();
    }
  }

  private async finishExecute<T>(
    record: ActionRecord,
    settled: Settled<T>,
    context: ExecuteContext,
  ): Promise<GuardOutcome<T>> {
    // A read failure here must not hide the tool's result (C9 rule 3), so the
    // guard falls back to treating the record as still in flight.
    const current = await this.reload(record.id, context);
    const state = current?.state;

    if (state === 'IN_DOUBT') {
      const applied = await this.recordCompletion(record.id, this.outcomeFor(settled), context);
      const after = applied ? await this.reload(record.id, context) : null;
      if (after !== null && (after.state === 'SUCCEEDED' || after.state === 'FAILED_DEFINITE')) {
        this.emit(
          'late-completion',
          { ...context, recordId: record.id, attempt: after.attempt },
          { reason: 'result arrived after in-doubt' },
        );
      }
      return this.returnOrThrow(settled, after ?? current ?? record);
    }

    if (state !== undefined && state !== 'IN_FLIGHT') {
      // Another process or a human already decided. Never overwrite (C6).
      this.emit(
        'execute',
        { ...context, recordId: record.id, attempt: current?.attempt ?? context.attempt },
        { reason: `record already ${state}` },
      );
      return this.returnOrThrow(settled, current ?? record);
    }

    const applied = await this.recordCompletion(record.id, this.outcomeFor(settled), context);
    if (applied) {
      this.maybePurge(context);
    }
    if (settled.kind === 'value') {
      this.emit('execute', { ...context, recordId: record.id }, { reason: 'success' });
      const stored = applied ? await this.reload(record.id, context) : null;
      return { status: 'executed', value: settled.value, record: stored ?? record };
    }
    const classification = this.classify(settled.error);
    this.emit(
      classification === 'definite' ? 'execute' : 'in-doubt',
      { ...context, recordId: record.id },
      { reason: classification, error: settled.error },
    );
    // C9 rule 2: the user's own error reaches the caller unchanged.
    throw settled.error;
  }

  private watchLateCompletion<T>(
    recordId: string,
    settled: Promise<Settled<T>>,
    context: ExecuteContext,
  ): void {
    void settled
      .then(async (outcome) => {
        const before = await this.options.store.get(recordId);
        if (before === null || (before.state !== 'IN_DOUBT' && before.state !== 'IN_FLIGHT')) {
          return;
        }
        const applied = await this.recordCompletion(recordId, this.outcomeFor(outcome), context);
        if (!applied) {
          return;
        }
        const after = await this.reload(recordId, context);
        if (after !== null && (after.state === 'SUCCEEDED' || after.state === 'FAILED_DEFINITE')) {
          this.emit(
            'late-completion',
            { ...context, recordId, attempt: after.attempt },
            { reason: 'result arrived after timeout or cancellation' },
          );
        }
      })
      .catch((error: unknown) => {
        this.writeStderr(`late completion failed: ${describeError(error)}`);
      });
  }

  private outcomeFor<T>(settled: Settled<T>): ExecutionOutcome {
    if (settled.kind === 'value') {
      return { type: 'success', result: settled.value };
    }
    return this.classify(settled.error) === 'definite'
      ? { type: 'definite-failure' }
      : { type: 'ambiguous-failure' };
  }

  private classify(error: unknown): 'definite' | 'ambiguous' {
    return this.options.classifyError === undefined
      ? classifyError(error).classification
      : classifyError(error, { classifier: this.options.classifyError }).classification;
  }

  private returnOrThrow<T>(settled: Settled<T>, record: ActionRecord): GuardOutcome<T> {
    if (settled.kind === 'value') {
      return { status: 'executed', value: settled.value, record };
    }
    throw settled.error;
  }

  /** Records an outcome; a failed write emits store-write-failed (C9 rule 3). */
  private async recordCompletion(
    recordId: string,
    outcome: ExecutionOutcome,
    context: ExecuteContext,
  ): Promise<boolean> {
    try {
      await this.options.store.complete(recordId, {
        outcome,
        now: this.options.clock.now(),
        settings: context.settings,
        maxResultBytes: this.options.maxResultBytes,
        ...(context.storeResult === undefined ? {} : { storeResult: context.storeResult }),
      });
      return true;
    } catch (error) {
      this.emit('store-write-failed', { ...context, recordId }, { error });
      return false;
    }
  }

  private async reload(recordId: string, context: EventContext): Promise<ActionRecord | null> {
    try {
      return await this.options.store.get(recordId);
    } catch (error) {
      this.emit('warning', context, { reason: 'could not re-read record', error });
      return null;
    }
  }

  private startLeaseRenewal(recordId: string, leaseMs: number): () => void {
    const interval = Math.max(1, Math.floor(leaseMs / LEASE_RENEW_DIVISOR));
    let stopped = false;
    let handle: TimerHandle | undefined;
    const tick = (): void => {
      if (stopped) {
        return;
      }
      void this.options.store
        .renewLease(recordId, new Date(this.options.clock.now().getTime() + leaseMs))
        .catch((error: unknown) => {
          this.writeStderr(`lease renewal failed: ${describeError(error)}`);
        });
      handle = this.options.clock.setTimeout(tick, interval);
    };
    handle = this.options.clock.setTimeout(tick, interval);
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (handle !== undefined) {
        this.options.clock.clearTimeout(handle);
      }
      this.activeRenewals.delete(stop);
    };
    this.activeRenewals.add(stop);
    return stop;
  }

  /** C12: purge at most once an hour, never on the critical path. */
  private maybePurge(context: EventContext): void {
    const now = this.options.clock.now().getTime();
    if (this.lastPurgeAt !== null && now - this.lastPurgeAt < PURGE_INTERVAL_MS) {
      return;
    }
    this.lastPurgeAt = now;
    const cutoff = new Date(now - this.options.retentionMs);
    void this.options.store.purge(cutoff).catch((error: unknown) => {
      this.emit('warning', context, { reason: 'automatic purge failed', error });
    });
  }

  private async waitForRecord(recordId: string, waitMs: number): Promise<ActionRecord | null> {
    const deadline = this.options.clock.now().getTime() + waitMs;
    for (;;) {
      const remaining = deadline - this.options.clock.now().getTime();
      if (remaining <= 0) {
        return this.options.store.get(recordId);
      }
      await this.sleep(Math.min(WAIT_POLL_MS, remaining));
      const record = await this.options.store.get(recordId);
      if (record === null || record.state !== 'IN_FLIGHT') {
        return record;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.options.clock.setTimeout(resolve, ms);
    });
  }

  private async waitForActiveCalls(): Promise<void> {
    if (this.activeCalls.size === 0) {
      return;
    }
    let handle: TimerHandle | undefined;
    const limit = new Promise<void>((resolve) => {
      handle = this.options.clock.setTimeout(resolve, this.options.closeTimeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...this.activeCalls]).then(() => undefined), limit]);
    } finally {
      if (handle !== undefined) {
        this.options.clock.clearTimeout(handle);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StoreUnavailableError({
        what: 'The guard has been closed.',
        why: 'close() was called, so new guarded calls are refused.',
        fix: 'Create a new guard before making more guarded calls.',
      });
    }
  }

  private emit(type: GuardEventType, context: EventContext, extras: EventExtras = {}): void {
    const hookName = HOOK_FOR_EVENT[type];
    const handler = this.options.hooks[hookName];
    if (handler === undefined) {
      return;
    }
    const at = this.options.clock.now();
    const event: GuardEvent = {
      type,
      at,
      recordId: context.recordId,
      fingerprint: context.fingerprint,
      tool: context.tool,
      server: this.options.namespace,
      scope: context.scope,
      durationMs: Math.max(0, at.getTime() - context.startedAt.getTime()),
      attempt: context.attempt,
      ...(extras.reason === undefined ? {} : { reason: extras.reason }),
      ...(extras.missing === undefined ? {} : { missing: extras.missing }),
      ...(extras.error === undefined ? {} : { error: extras.error }),
    };
    try {
      (handler as (event: GuardEvent) => void)(event);
    } catch (error) {
      this.writeStderr(`hook ${hookName} threw: ${describeError(error)}`);
    }
  }

  private writeStderr(message: string): void {
    try {
      process.stderr.write(`[twiceshy] ${message}\n`);
    } catch {
      // Best effort: a broken stderr must never break a guarded call.
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates a guard; invalid options throw one CONFIG_INVALID listing them all. */
export function createGuard(options: CreateGuardOptions): Guard {
  return new DefaultGuard(options);
}
