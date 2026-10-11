import type { EngineSettings, ExecutionOutcome, RecordState } from '../engine.js';

/** A human-approved repeat that has not been consumed yet. */
export interface RepeatGrant {
  grantedAt: Date;
  grantedBy?: string;
  note?: string;
}

/** One guarded action, as stored. */
export interface ActionRecord {
  id: string;
  /** Explicit key when supplied, otherwise the fingerprint. */
  identity: string;
  fingerprint: string;
  explicitKey: string | null;
  serverId: string;
  toolName: string;
  scope: string;
  state: RecordState;
  attempt: number;
  /** Arguments after redaction. */
  redactedArgs: unknown;
  /** Stored result for successful terminal states. */
  result: unknown;
  /** True when the result was replaced with a summary because it was too large. */
  resultTruncated: boolean;
  /** Short human-readable summary of the failure or in-doubt reason. */
  errorSummary: string | null;
  createdAt: Date;
  startedAt: Date;
  completedAt: Date | null;
  leaseExpiresAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  repeatGrant: RepeatGrant | null;
}

export interface BeginInput {
  fingerprint: string;
  /** Explicit key when the caller supplied one; becomes the identity. */
  explicitKey: string | null;
  serverId: string;
  toolName: string;
  scope: string;
  /** Arguments after redaction. The store keeps a copy. */
  redactedArgs: unknown;
  /** Injected time so decisions are deterministic. */
  now: Date;
  settings: EngineSettings;
}

export type BeginResult =
  | { kind: 'execute'; record: ActionRecord; archived: ActionRecord | null }
  | { kind: 'duplicate'; record: ActionRecord; originalResult: unknown; originalAt: Date | null }
  | { kind: 'wait'; record: ActionRecord; waitMs: number }
  | { kind: 'block-in-doubt'; record: ActionRecord }
  | { kind: 'reject-key-conflict'; record: ActionRecord };

export interface CompleteInput {
  outcome: ExecutionOutcome;
  /** Injected time. Terminal states always get completedAt set to this. */
  now: Date;
  settings: EngineSettings;
  /** Short human-readable summary stored for audit. */
  errorSummary?: string;
}

export interface ListFilter {
  state?: RecordState | readonly RecordState[];
  /** Only records created at or after this time. */
  since?: Date;
  fingerprint?: string;
  serverId?: string;
  toolName?: string;
  scope?: string;
  /** Newest-first maximum number of records. */
  limit?: number;
}

export interface Resolution {
  as: 'succeeded' | 'failed';
  by: string;
  note?: string;
  /** Injected time for resolvedAt. */
  at: Date;
}

/** Every store implements this interface (SPEC.md C12). */
export interface ActionStore {
  /** Atomic read-decide-claim. Uses the pure engine functions for the C6 table. */
  begin(input: BeginInput): Promise<BeginResult>;
  renewLease(id: string, until: Date): Promise<void>;
  complete(id: string, input: CompleteInput): Promise<void>;
  get(id: string): Promise<ActionRecord | null>;
  findByIdentity(identity: string): Promise<ActionRecord | null>;
  list(filter: ListFilter): Promise<ActionRecord[]>;
  resolve(id: string, resolution: Resolution): Promise<void>;
  grantRepeat(fingerprint: string, grant: RepeatGrant): Promise<void>;
  /** Removes records that finished before `olderThan`. Returns how many went. */
  purge(olderThan: Date): Promise<number>;
  close(): Promise<void>;
}
