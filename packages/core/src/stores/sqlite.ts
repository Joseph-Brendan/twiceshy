import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { RecordState } from '../engine.js';
import { afterExecution, decide, lateCompletion } from '../engine.js';
import {
  isTwiceshyError,
  NotSerializableError,
  ResultTooLargeError,
  StoreUnavailableError,
} from '../errors.js';
import { applyPatch, recordNotFound, toEngineRecord } from './record.js';
import type {
  ActionRecord,
  ActionStore,
  BeginInput,
  BeginResult,
  CompleteInput,
  ListFilter,
  RepeatGrant,
  Resolution,
} from './types.js';
import { DEFAULT_MAX_RESULT_BYTES } from './types.js';

type SqliteDatabase = BetterSqlite3.Database;
type SqliteStatement = BetterSqlite3.Statement;

export interface SqliteStoreOptions {
  /** Database file. "~" at the start expands to the home folder. */
  path: string;
}

const nodeRequire = createRequire(import.meta.url);

/**
 * Loads better-sqlite3. The optional dependency is required lazily so the
 * core package keeps working for users who never touch SqliteStore.
 * `requireFn` is injectable for tests.
 */
export function loadBetterSqlite3(
  requireFn: (id: string) => unknown = nodeRequire,
): typeof BetterSqlite3 {
  try {
    return requireFn('better-sqlite3') as typeof BetterSqlite3;
  } catch (cause) {
    throw new StoreUnavailableError({
      what: 'SqliteStore needs the optional dependency better-sqlite3, which is not installed.',
      why: `better-sqlite3 could not be loaded: ${String(cause)}`,
      fix: 'Run "npm install better-sqlite3" (or "pnpm add better-sqlite3") and try again.',
      cause,
    });
  }
}

/** Expands a leading "~" to the home folder on every operating system. */
export function expandHome(input: string, home: string = homedir()): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(home, input.slice(2));
  }
  return input;
}

function openError(path: string, cause: unknown): StoreUnavailableError {
  return new StoreUnavailableError({
    what: `The SQLite database at "${path}" could not be opened.`,
    why: `SQLite reported: ${String(cause)}`,
    fix: 'Check that the folder exists and is writable, and that the file is a valid SQLite database.',
    cause,
  });
}

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    redacted_args TEXT,
    created_at INTEGER NOT NULL
  );
`;

/** Migrations only add; they never delete data (C12). */
const MIGRATIONS: readonly { version: number; up: (db: SqliteDatabase) => void }[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        ALTER TABLE actions ADD COLUMN explicit_key TEXT;
        ALTER TABLE actions ADD COLUMN server_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE actions ADD COLUMN tool_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE actions ADD COLUMN scope TEXT NOT NULL DEFAULT '';
        ALTER TABLE actions ADD COLUMN result TEXT;
        ALTER TABLE actions ADD COLUMN result_truncated INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE actions ADD COLUMN error_summary TEXT;
        ALTER TABLE actions ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE actions ADD COLUMN completed_at INTEGER;
        ALTER TABLE actions ADD COLUMN lease_expires_at INTEGER;
        ALTER TABLE actions ADD COLUMN resolved_at INTEGER;
        ALTER TABLE actions ADD COLUMN resolved_by TEXT;
        ALTER TABLE actions ADD COLUMN resolution_note TEXT;
        ALTER TABLE actions ADD COLUMN repeat_grant TEXT;
        CREATE INDEX IF NOT EXISTS idx_actions_identity ON actions (identity);
        CREATE INDEX IF NOT EXISTS idx_actions_fingerprint ON actions (fingerprint);
        CREATE INDEX IF NOT EXISTS idx_actions_state ON actions (state);
        CREATE INDEX IF NOT EXISTS idx_actions_completed_at ON actions (completed_at);
      `);
    },
  },
];

/** Runs schema migrations inside one IMMEDIATE transaction. */
function migrate(db: SqliteDatabase): void {
  const migrateTx = db.transaction(() => {
    db.exec(BASE_SCHEMA);
    const existing = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    let version = existing?.version ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version > version) {
        migration.up(db);
        version = migration.version;
      }
    }
    if (existing === undefined) {
      db.prepare('INSERT INTO schema_version (version) VALUES (@version)').run({ version });
    } else if (existing.version !== version) {
      db.prepare('UPDATE schema_version SET version = @version').run({ version });
    }
  });
  migrateTx.immediate();
}

/** C12: processes wait briefly for each other instead of failing. */
const BUSY_TIMEOUT_MS = 5_000;

/** Delay between journal-mode switch attempts while another process holds the lock. */
const WAL_RETRY_DELAY_MS = 25;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep; openDatabase cannot await. Bounded by BUSY_TIMEOUT_MS. */
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function isBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'SQLITE_BUSY'
  );
}

/**
 * Switches the database to WAL mode, waiting out other processes switching
 * the same fresh file (C12). SQLite does not run the busy handler while
 * changing the journal mode, so the pragma can fail with SQLITE_BUSY even
 * though busy_timeout is set; this waits and tries again within the same
 * 5 s budget instead of failing.
 */
function enableWal(db: SqliteDatabase): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      const mode = db.pragma('journal_mode = WAL', { simple: true });
      if (mode === 'wal') {
        return;
      }
    } catch (cause) {
      if (!isBusyError(cause) || Date.now() >= deadline) {
        throw cause;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('the database stayed locked while switching to WAL mode');
    }
    sleepSync(WAL_RETRY_DELAY_MS);
  }
}

function openDatabase(Database: typeof BetterSqlite3, path: string): SqliteDatabase {
  let db: SqliteDatabase | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // The timeout is set at open time and again explicitly, so every lock
    // acquisition can wait instead of failing (C12).
    db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL lets several processes share one file (C12).
    enableWal(db);
    migrate(db);
    return db;
  } catch (cause) {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // Best effort: the open error below is the one the caller needs.
      }
    }
    throw openError(path, cause);
  }
}

interface ActionRow {
  id: string;
  identity: string;
  fingerprint: string;
  explicit_key: string | null;
  server_id: string;
  tool_name: string;
  scope: string;
  state: string;
  attempt: number;
  redacted_args: string | null;
  result: string | null;
  result_truncated: number;
  error_summary: string | null;
  created_at: number;
  started_at: number;
  completed_at: number | null;
  lease_expires_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_note: string | null;
  repeat_grant: string | null;
}

function toEpoch(date: Date | null): number | null {
  return date === null ? null : date.getTime();
}

function fromEpoch(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

function fromJsonText(text: string | null): unknown {
  return text === null ? undefined : JSON.parse(text);
}

function toJsonText(value: unknown, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'function' || typeof item === 'symbol') {
        throw new NotSerializableError({
          what: `The ${label} contains a ${typeof item}, which cannot be stored as JSON.`,
          why: 'JSON has no representation for functions or symbols.',
          fix: `Remove the ${typeof item} from the ${label}, or set storeResult: false.`,
        });
      }
      return item;
    });
  } catch (cause) {
    if (cause instanceof NotSerializableError) {
      throw cause;
    }
    throw new NotSerializableError({
      what: `The ${label} could not be stored as JSON.`,
      why: 'It contains a value JSON cannot represent, such as a circular reference or a BigInt.',
      fix: `Remove the unsupported value from the ${label}, or set storeResult: false.`,
      cause,
    });
  }
}

function grantToJson(grant: RepeatGrant): string {
  return JSON.stringify({
    grantedAt: grant.grantedAt.getTime(),
    grantedBy: grant.grantedBy ?? null,
    note: grant.note ?? null,
  });
}

function grantFromJson(text: string): RepeatGrant {
  const parsed = JSON.parse(text) as {
    grantedAt: number;
    grantedBy: string | null;
    note: string | null;
  };
  const grant: RepeatGrant = { grantedAt: new Date(parsed.grantedAt) };
  if (parsed.grantedBy !== null) {
    grant.grantedBy = parsed.grantedBy;
  }
  if (parsed.note !== null) {
    grant.note = parsed.note;
  }
  return grant;
}

function rowToRecord(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    identity: row.identity,
    fingerprint: row.fingerprint,
    explicitKey: row.explicit_key,
    serverId: row.server_id,
    toolName: row.tool_name,
    scope: row.scope,
    state: row.state as RecordState,
    attempt: row.attempt,
    redactedArgs: fromJsonText(row.redacted_args),
    result: fromJsonText(row.result),
    resultTruncated: row.result_truncated === 1,
    errorSummary: row.error_summary,
    createdAt: new Date(row.created_at),
    startedAt: new Date(row.started_at),
    completedAt: fromEpoch(row.completed_at),
    leaseExpiresAt: fromEpoch(row.lease_expires_at),
    resolvedAt: fromEpoch(row.resolved_at),
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    repeatGrant: row.repeat_grant === null ? null : grantFromJson(row.repeat_grant),
  };
}

const INSERT_SQL = `
  INSERT INTO actions (
    id, identity, fingerprint, explicit_key, server_id, tool_name, scope, state, attempt,
    redacted_args, result, result_truncated, error_summary, created_at, started_at,
    completed_at, lease_expires_at, resolved_at, resolved_by, resolution_note, repeat_grant
  ) VALUES (
    @id, @identity, @fingerprint, @explicitKey, @serverId, @toolName, @scope, @state, @attempt,
    @redactedArgs, @result, @resultTruncated, @errorSummary, @createdAt, @startedAt,
    @completedAt, @leaseExpiresAt, @resolvedAt, @resolvedBy, @resolutionNote, @repeatGrant
  )
`;

const RESTART_SQL = `
  UPDATE actions SET
    state = @state,
    attempt = @attempt,
    result = NULL,
    result_truncated = 0,
    started_at = @startedAt,
    completed_at = NULL,
    lease_expires_at = @leaseExpiresAt,
    repeat_grant = NULL
  WHERE id = @id
`;

const COMPLETE_SQL = `
  UPDATE actions SET
    state = @state,
    attempt = @attempt,
    completed_at = @completedAt,
    lease_expires_at = @leaseExpiresAt,
    error_summary = @errorSummary
  WHERE id = @id
`;

const COMPLETE_WITH_RESULT_SQL = `
  UPDATE actions SET
    state = @state,
    attempt = @attempt,
    completed_at = @completedAt,
    lease_expires_at = @leaseExpiresAt,
    error_summary = @errorSummary,
    result = @result,
    result_truncated = @resultTruncated
  WHERE id = @id
`;

/**
 * SQLite store for real use on one machine, including several processes
 * sharing one file.
 */
export class SqliteStore implements ActionStore {
  readonly path: string;
  private readonly db: SqliteDatabase;
  private readonly statements = new Map<string, SqliteStatement>();
  private closed = false;

  constructor(options: SqliteStoreOptions) {
    const Database = loadBetterSqlite3();
    this.path = resolve(expandHome(options.path));
    this.db = openDatabase(Database, this.path);
  }

  async begin(input: BeginInput): Promise<BeginResult> {
    return this.wrap('begin', () => {
      const tx = this.db.transaction((): BeginResult => {
        const identity = input.explicitKey ?? input.fingerprint;
        const existingRow = this.findCurrentRow('identity', identity);
        const existing = existingRow === undefined ? null : rowToRecord(existingRow);
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
          // The engine guarantees a lease on every execute decision.
          const leaseUntil = decision.changes.leaseUntil as Date;
          if (existing !== null && !decision.archiveExisting) {
            const restarted: ActionRecord = {
              ...existing,
              state: 'IN_FLIGHT',
              attempt: decision.changes.attempt as number,
              result: undefined,
              resultTruncated: false,
              startedAt: input.now,
              completedAt: null,
              leaseExpiresAt: leaseUntil,
              repeatGrant: null,
            };
            this.statement(RESTART_SQL).run({
              id: restarted.id,
              state: restarted.state,
              attempt: restarted.attempt,
              startedAt: restarted.startedAt.getTime(),
              leaseExpiresAt: leaseUntil.getTime(),
            });
            return { kind: 'execute', record: restarted, archived: null };
          }

          const record: ActionRecord = {
            id: randomUUID(),
            identity,
            fingerprint: input.fingerprint,
            explicitKey: input.explicitKey,
            serverId: input.serverId,
            toolName: input.toolName,
            scope: input.scope,
            state: 'IN_FLIGHT',
            attempt: decision.changes.attempt as number,
            redactedArgs: input.redactedArgs,
            result: undefined,
            resultTruncated: false,
            errorSummary: null,
            createdAt: input.now,
            startedAt: input.now,
            completedAt: null,
            leaseExpiresAt: leaseUntil,
            resolvedAt: null,
            resolvedBy: null,
            resolutionNote: null,
            repeatGrant: null,
          };
          this.statement(INSERT_SQL).run({
            id: record.id,
            identity: record.identity,
            fingerprint: record.fingerprint,
            explicitKey: record.explicitKey,
            serverId: record.serverId,
            toolName: record.toolName,
            scope: record.scope,
            state: record.state,
            attempt: record.attempt,
            redactedArgs: toJsonText(input.redactedArgs, 'arguments'),
            result: null,
            resultTruncated: 0,
            errorSummary: null,
            createdAt: record.createdAt.getTime(),
            startedAt: record.startedAt.getTime(),
            completedAt: null,
            leaseExpiresAt: leaseUntil.getTime(),
            resolvedAt: null,
            resolvedBy: null,
            resolutionNote: null,
            repeatGrant: null,
          });

          if (existing === null) {
            return { kind: 'execute', record, archived: null };
          }
          // A window-passed success: archive the old record and clear its unused grant.
          const archived: ActionRecord = { ...existing, repeatGrant: null };
          this.statement('UPDATE actions SET repeat_grant = NULL WHERE id = @id').run({
            id: archived.id,
          });
          return { kind: 'execute', record, archived };
        }

        const current = existing as ActionRecord;
        if (decision.kind === 'duplicate') {
          return {
            kind: 'duplicate',
            record: current,
            originalResult: current.result,
            originalAt: current.completedAt,
          };
        }
        if (decision.kind === 'wait') {
          return { kind: 'wait', record: current, waitMs: decision.waitMs };
        }
        if (decision.kind === 'block-in-doubt') {
          const updated = applyPatch(current, decision.changes);
          if (decision.changes.state !== undefined) {
            this.statement(
              'UPDATE actions SET state = @state, lease_expires_at = NULL WHERE id = @id',
            ).run({ id: updated.id, state: updated.state });
          }
          return { kind: 'block-in-doubt', record: updated };
        }
        return { kind: 'reject-key-conflict', record: current };
      });
      return tx.immediate();
    });
  }

  async renewLease(id: string, until: Date): Promise<void> {
    return this.wrap('renewLease', () => {
      const info = this.statement(
        "UPDATE actions SET lease_expires_at = @until WHERE id = @id AND state = 'IN_FLIGHT'",
      ).run({ id, until: until.getTime() });
      if (info.changes === 0 && this.findRowById(id) === undefined) {
        throw recordNotFound(id);
      }
    });
  }

  async complete(id: string, input: CompleteInput): Promise<void> {
    return this.wrap('complete', () => {
      const tx = this.db.transaction((): void => {
        const row = this.findRowById(id);
        if (row === undefined) {
          throw recordNotFound(id);
        }
        const record = rowToRecord(row);
        if (record.state !== 'IN_FLIGHT' && record.state !== 'IN_DOUBT') {
          // Never overwrite a terminal state set by another process or a human.
          return;
        }
        const patch =
          record.state === 'IN_FLIGHT'
            ? afterExecution(toEngineRecord(record), input.outcome, input.now, input.settings)
            : lateCompletion(toEngineRecord(record), input.outcome, input.now);
        const updated = applyPatch(record, patch);
        const maxBytes = input.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
        const resultChanged = 'result' in patch;
        let resultText: string | null = null;
        let resultTruncated = 0;
        if (resultChanged) {
          if (patch.result === undefined) {
            // A definite failure clears any stale result.
            resultText = null;
            resultTruncated = 0;
          } else {
            const fullText = toJsonText(patch.result, 'result') as string;
            const bytes = Buffer.byteLength(fullText, 'utf8');
            if (input.storeResult === false) {
              resultText = JSON.stringify(`[result not stored: ${bytes} bytes]`);
              resultTruncated = 1;
            } else if (bytes > maxBytes) {
              throw new ResultTooLargeError({ sizeBytes: bytes, maxBytes, recordId: id });
            } else {
              resultText = fullText;
              resultTruncated = 0;
            }
          }
        }
        const params = {
          id,
          state: updated.state,
          attempt: updated.attempt,
          completedAt: toEpoch(updated.completedAt),
          leaseExpiresAt: toEpoch(updated.leaseExpiresAt),
          errorSummary: input.errorSummary ?? record.errorSummary,
        };
        if (resultChanged) {
          this.statement(COMPLETE_WITH_RESULT_SQL).run({
            ...params,
            result: resultText,
            resultTruncated,
          });
        } else {
          this.statement(COMPLETE_SQL).run(params);
        }
      });
      tx.immediate();
    });
  }

  async get(id: string): Promise<ActionRecord | null> {
    return this.wrap('get', () => {
      const row = this.findRowById(id);
      return row === undefined ? null : rowToRecord(row);
    });
  }

  async findByIdentity(identity: string): Promise<ActionRecord | null> {
    return this.wrap('findByIdentity', () => {
      const row = this.findCurrentRow('identity', identity);
      return row === undefined ? null : rowToRecord(row);
    });
  }

  async list(filter: ListFilter): Promise<ActionRecord[]> {
    return this.wrap('list', () => {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.state !== undefined) {
        const states = Array.isArray(filter.state) ? [...filter.state] : [filter.state];
        const placeholders = states.map((state, index) => {
          params[`state${index}`] = state;
          return `@state${index}`;
        });
        conditions.push(`state IN (${placeholders.join(', ')})`);
      }
      if (filter.since !== undefined) {
        conditions.push('created_at >= @since');
        params.since = filter.since.getTime();
      }
      if (filter.fingerprint !== undefined) {
        conditions.push('fingerprint = @fingerprint');
        params.fingerprint = filter.fingerprint;
      }
      if (filter.serverId !== undefined) {
        conditions.push('server_id = @serverId');
        params.serverId = filter.serverId;
      }
      if (filter.toolName !== undefined) {
        conditions.push('tool_name = @toolName');
        params.toolName = filter.toolName;
      }
      if (filter.scope !== undefined) {
        conditions.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter.limit !== undefined) {
        params.limit = filter.limit;
      }
      const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
      const limit = filter.limit === undefined ? '' : ' LIMIT @limit';
      const sql = `SELECT * FROM actions${where} ORDER BY created_at DESC${limit}`;
      const rows = (
        Object.keys(params).length === 0
          ? this.statement(sql).all()
          : this.statement(sql).all(params)
      ) as ActionRow[];
      return rows.map(rowToRecord);
    });
  }

  async resolve(id: string, resolution: Resolution): Promise<void> {
    return this.wrap('resolve', () => {
      const info = this.statement(
        `UPDATE actions SET
          state = @state,
          completed_at = @completedAt,
          resolved_at = @resolvedAt,
          resolved_by = @resolvedBy,
          resolution_note = @resolutionNote,
          lease_expires_at = NULL
        WHERE id = @id`,
      ).run({
        id,
        state: resolution.as === 'succeeded' ? 'RESOLVED_SUCCEEDED' : 'RESOLVED_FAILED',
        completedAt: resolution.at.getTime(),
        resolvedAt: resolution.at.getTime(),
        resolvedBy: resolution.by,
        resolutionNote: resolution.note ?? null,
      });
      if (info.changes === 0) {
        throw recordNotFound(id);
      }
    });
  }

  async grantRepeat(fingerprint: string, grant: RepeatGrant): Promise<void> {
    return this.wrap('grantRepeat', () => {
      const row = this.findCurrentRow('fingerprint', fingerprint);
      if (row === undefined) {
        throw new StoreUnavailableError({
          what: `No record was found for fingerprint "${fingerprint}".`,
          why: 'A repeat grant must attach to an existing action record.',
          fix: 'Check the fingerprint, or list the current records with `twiceshy list`.',
        });
      }
      this.statement('UPDATE actions SET repeat_grant = @grant WHERE id = @id').run({
        id: row.id,
        grant: grantToJson(grant),
      });
    });
  }

  async purge(olderThan: Date): Promise<number> {
    return this.wrap('purge', () => {
      const info = this.statement(
        `DELETE FROM actions
         WHERE state NOT IN ('IN_FLIGHT', 'IN_DOUBT')
           AND COALESCE(completed_at, created_at) < @cutoff`,
      ).run({ cutoff: olderThan.getTime() });
      return info.changes;
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  private findRowById(id: string): ActionRow | undefined {
    return this.statement('SELECT * FROM actions WHERE id = @id').get({ id }) as
      | ActionRow
      | undefined;
  }

  private findCurrentRow(column: 'identity' | 'fingerprint', value: string): ActionRow | undefined {
    return this.statement(
      `SELECT * FROM actions WHERE ${column} = @value ORDER BY created_at DESC LIMIT 1`,
    ).get({ value }) as ActionRow | undefined;
  }

  private statement(sql: string): SqliteStatement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Converts raw database errors to STORE_UNAVAILABLE, keeping the cause. */
  private wrap<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (cause) {
      if (isTwiceshyError(cause)) {
        throw cause;
      }
      throw new StoreUnavailableError({
        what: `The SQLite store failed during "${operation}".`,
        why: `The database at "${this.path}" reported: ${String(cause)}`,
        fix: 'Check the database file and its permissions, then try again.',
        cause,
      });
    }
  }
}
