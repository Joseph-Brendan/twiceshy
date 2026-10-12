import { completeRecord, decide } from '../engine.js';
import { NotSerializableError, StoreUnavailableError } from '../errors.js';
import { applyPatch, recordNotFound, toEngineRecord } from './record.js';
import type {
  ActionRecord,
  ActionStore,
  BeginInput,
  BeginResult,
  CompleteInput,
  CompleteResult,
  ListFilter,
  RepeatGrant,
  Resolution,
} from './types.js';

/** Deep copy that turns unclonable values into NOT_SERIALIZABLE. */
function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new NotSerializableError({ cause });
  }
}

/**
 * In-memory store for single-process use and tests. Data is lost on restart.
 */
export class MemoryStore implements ActionStore {
  private readonly records = new Map<string, ActionRecord>();
  private sequence = 0;
  private tokenSequence = 0;
  private closed = false;

  private nextToken(): string {
    this.tokenSequence += 1;
    return `claim-${this.tokenSequence}`;
  }

  /** Every call after close() fails cleanly instead of touching dead state. */
  private assertOpen(): void {
    if (this.closed) {
      throw new StoreUnavailableError({
        what: 'The memory store has been closed.',
        why: 'A store call was made after close().',
        fix: 'Create a new MemoryStore before using the store again.',
      });
    }
  }

  async begin(input: BeginInput): Promise<BeginResult> {
    this.assertOpen();
    // Atomicity rule (C12): everything from the read on the next line to the
    // record write at the end of this method runs synchronously, with no
    // `await` in between. On a single JavaScript thread nothing can interleave
    // in that gap, so two parallel calls can never both see "no record" and
    // both run the refund — the Kola case where Ife would be paid twice.
    const identity = input.explicitKey ?? input.fingerprint;
    const existing = this.findCurrent((record) => record.identity === identity);
    const request =
      input.explicitKey === null
        ? { fingerprint: input.fingerprint }
        : { fingerprint: input.fingerprint, explicitKey: input.explicitKey };
    const decision = decide(
      existing === null ? null : toEngineRecord(existing),
      request,
      input.now,
      input.settings,
    );

    if (decision.kind === 'execute') {
      if (existing !== null && !decision.archiveExisting) {
        const restarted: ActionRecord = {
          ...existing,
          state: 'IN_FLIGHT',
          attempt: decision.changes.attempt as number,
          attemptToken: this.nextToken(),
          result: undefined,
          resultTruncated: false,
          resultRedacted: false,
          startedAt: input.now,
          completedAt: null,
          leaseExpiresAt: decision.changes.leaseUntil as Date,
          repeatGrant: null,
        };
        this.records.set(restarted.id, clone(restarted));
        return { kind: 'execute', record: clone(restarted), archived: null };
      }
      const record: ActionRecord = {
        id: this.nextId(),
        identity,
        fingerprint: input.fingerprint,
        explicitKey: input.explicitKey,
        serverId: input.serverId,
        toolName: input.toolName,
        scope: input.scope,
        state: 'IN_FLIGHT',
        attempt: decision.changes.attempt as number,
        attemptToken: this.nextToken(),
        redactedArgs: clone(input.redactedArgs),
        result: undefined,
        resultTruncated: false,
        resultRedacted: false,
        errorSummary: null,
        createdAt: input.now,
        startedAt: input.now,
        completedAt: null,
        leaseExpiresAt: decision.changes.leaseUntil as Date,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
        repeatGrant: null,
      };
      this.records.set(record.id, clone(record));
      if (existing === null) {
        return { kind: 'execute', record: clone(record), archived: null };
      }
      // A window-passed success: archive the old record and clear its unused grant.
      const archived: ActionRecord = { ...existing, repeatGrant: null };
      this.records.set(archived.id, clone(archived));
      return { kind: 'execute', record: clone(record), archived: clone(archived) };
    }

    const current = existing as ActionRecord;
    if (decision.kind === 'duplicate') {
      return {
        kind: 'duplicate',
        record: clone(current),
        originalResult: clone(current.result),
        originalAt: current.completedAt,
      };
    }
    if (decision.kind === 'wait') {
      return { kind: 'wait', record: clone(current), waitMs: decision.waitMs };
    }
    if (decision.kind === 'block-in-doubt') {
      const stored = applyPatch(current, decision.changes);
      this.records.set(stored.id, clone(stored));
      return { kind: 'block-in-doubt', record: clone(stored) };
    }
    return { kind: 'reject-key-conflict', record: clone(current) };
  }

  async renewLease(id: string, until: Date): Promise<void> {
    this.assertOpen();
    const record = this.records.get(id);
    if (record === undefined) {
      throw recordNotFound(id);
    }
    if (record.state !== 'IN_FLIGHT') {
      return;
    }
    this.records.set(id, clone({ ...record, leaseExpiresAt: new Date(until.getTime()) }));
  }

  async complete(id: string, input: CompleteInput): Promise<CompleteResult> {
    this.assertOpen();
    // Everything from here to the record write runs synchronously, so the
    // conditional check and the write are one atomic operation (C12/C20).
    const record = this.records.get(id);
    if (record === undefined) {
      throw recordNotFound(id);
    }
    const decision = completeRecord(
      toEngineRecord(record),
      { attemptToken: input.attemptToken, outcome: input.outcome },
      input.now,
      input.settings,
    );
    if (decision.path === 'changed' || decision.path === 'agrees-with-resolution') {
      return { path: decision.path, written: false, record: clone(record) };
    }
    if (Object.keys(decision.patch).length === 0) {
      return { path: decision.path, written: false, record: clone(record) };
    }
    const resultInPatch = 'result' in decision.patch;
    const updated: ActionRecord = {
      ...applyPatch(record, decision.patch),
      errorSummary: input.errorSummary ?? record.errorSummary,
    };
    if (resultInPatch) {
      updated.resultTruncated = input.storeResult === false;
      updated.resultRedacted =
        input.storeResult === false ? false : (input.resultRedacted ?? false);
      if (input.storeResult === false) {
        updated.result = undefined;
      }
    }
    this.records.set(id, clone(updated));
    return { path: decision.path, written: true, record: clone(updated) };
  }

  async get(id: string): Promise<ActionRecord | null> {
    this.assertOpen();
    const record = this.records.get(id);
    return record === undefined ? null : clone(record);
  }

  async findByIdentity(identity: string): Promise<ActionRecord | null> {
    this.assertOpen();
    const record = this.findCurrent((candidate) => candidate.identity === identity);
    return record === null ? null : clone(record);
  }

  async list(filter: ListFilter): Promise<ActionRecord[]> {
    this.assertOpen();
    const states =
      filter.state === undefined
        ? null
        : Array.isArray(filter.state)
          ? filter.state
          : [filter.state];
    const records = [...this.records.values()]
      .filter((record) => states === null || states.includes(record.state))
      .filter(
        (record) =>
          filter.since === undefined || record.createdAt.getTime() >= filter.since.getTime(),
      )
      .filter(
        (record) => filter.fingerprint === undefined || record.fingerprint === filter.fingerprint,
      )
      .filter((record) => filter.serverId === undefined || record.serverId === filter.serverId)
      .filter((record) => filter.toolName === undefined || record.toolName === filter.toolName)
      .filter((record) => filter.scope === undefined || record.scope === filter.scope)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const limited = filter.limit === undefined ? records : records.slice(0, filter.limit);
    return limited.map((record) => clone(record));
  }

  async resolve(id: string, resolution: Resolution): Promise<void> {
    this.assertOpen();
    const record = this.records.get(id);
    if (record === undefined) {
      throw recordNotFound(id);
    }
    const resolved: ActionRecord = {
      ...record,
      state: resolution.as === 'succeeded' ? 'RESOLVED_SUCCEEDED' : 'RESOLVED_FAILED',
      completedAt: new Date(resolution.at.getTime()),
      resolvedAt: new Date(resolution.at.getTime()),
      resolvedBy: resolution.by,
      resolutionNote: resolution.note ?? null,
      leaseExpiresAt: null,
    };
    this.records.set(id, clone(resolved));
  }

  async grantRepeat(fingerprint: string, grant: RepeatGrant): Promise<void> {
    this.assertOpen();
    const record = this.findCurrent((candidate) => candidate.fingerprint === fingerprint);
    if (record === null) {
      throw new StoreUnavailableError({
        what: `No record was found for fingerprint "${fingerprint}".`,
        why: 'A repeat grant must attach to an existing action record.',
        fix: 'Check the fingerprint, or list the current records with `twiceshy list`.',
      });
    }
    this.records.set(record.id, clone({ ...record, repeatGrant: clone(grant) }));
  }

  async purge(olderThan: Date): Promise<number> {
    this.assertOpen();
    const cutoff = olderThan.getTime();
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.state === 'IN_FLIGHT' || record.state === 'IN_DOUBT') {
        continue;
      }
      // Terminal records always carry completedAt (proved by the contract suite).
      const finishedAt = record.completedAt as Date;
      if (finishedAt.getTime() >= cutoff) {
        continue;
      }
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.records.clear();
  }

  private findCurrent(matches: (record: ActionRecord) => boolean): ActionRecord | null {
    const candidates = [...this.records.values()].filter(matches);
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return candidates[0] as ActionRecord;
  }

  private nextId(): string {
    this.sequence += 1;
    return `mem-${this.sequence}`;
  }
}
