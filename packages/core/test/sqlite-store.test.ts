import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionRecord, BeginInput, CompleteInput, EngineSettings } from '../src/index.js';
import {
  createGuard,
  DEFAULT_MAX_RESULT_BYTES,
  NotSerializableError,
  ResultTooLargeError,
  redact,
  StoreUnavailableError,
} from '../src/index.js';
import { runStoreContract } from '../src/stores/contract.js';
import {
  assertBetterSqlite3Supported,
  expandHome,
  loadBetterSqlite3,
  MIN_BETTER_SQLITE3_VERSION,
  readBetterSqlite3Version,
  SqliteStore,
} from '../src/stores/sqlite.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const SETTINGS: EngineSettings = {
  windowMs: 600_000,
  waitForInFlightMs: 5_000,
  leaseMs: 30_000,
};

const tempDirs = new Set<string>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-sqlite-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function beginInput(redactedArgs: unknown, overrides: Partial<BeginInput> = {}): BeginInput {
  return {
    fingerprint: 'fp-1',
    explicitKey: null,
    serverId: 'local',
    toolName: 'test.tool',
    scope: '',
    redactedArgs,
    now: NOW,
    settings: SETTINGS,
    ...overrides,
  };
}

async function executeOnce(store: SqliteStore, fingerprint: string): Promise<ActionRecord> {
  const result = await store.begin(beginInput({ amount: 1 }, { fingerprint }));
  if (result.kind !== 'execute') {
    throw new Error(`expected execute, got ${result.kind}`);
  }
  return result.record;
}

function completeInput(
  record: ActionRecord,
  outcome: CompleteInput['outcome'],
  overrides: Partial<CompleteInput> = {},
): CompleteInput {
  return { attemptToken: record.attemptToken, outcome, now: NOW, settings: SETTINGS, ...overrides };
}

runStoreContract(
  'S1: SqliteStore',
  () => new SqliteStore({ path: join(tempDir(), 'actions.db') }),
  () => undefined,
);

describe('SqliteStore opening', () => {
  it('S2: creates missing folders for the database file', async () => {
    const path = join(tempDir(), 'deep', 'nested', 'actions.db');
    const store = new SqliteStore({ path });
    expect(existsSync(path)).toBe(true);
    await store.close();
  });

  it('opens a database in a folder whose name has a space and a non-English character', async () => {
    const dir = join(tempDir(), 'dir with space é');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'actions.db');

    const store = new SqliteStore({ path });
    const record = await executeOnce(store, 'fp-unicode-path');
    await store.complete(
      record.id,
      completeInput(record, { type: 'success', result: { ok: true } }),
    );
    expect((await store.get(record.id))?.state).toBe('SUCCEEDED');
    await store.close();

    const reopened = new SqliteStore({ path });
    expect((await reopened.get(record.id))?.state).toBe('SUCCEEDED');
    await reopened.close();
  });

  it('S2: throws STORE_UNAVAILABLE with the full path when the file cannot be created', () => {
    const dir = tempDir();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a folder');
    const path = join(blocker, 'actions.db');

    let caught: unknown;
    try {
      new SqliteStore({ path });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    const error = caught as StoreUnavailableError;
    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.message).toContain(path);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('throws STORE_UNAVAILABLE with the path when the file is not a SQLite database', () => {
    const path = join(tempDir(), 'actions.db');
    writeFileSync(path, 'this is not a sqlite database');

    let caught: unknown;
    try {
      new SqliteStore({ path });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    const error = caught as StoreUnavailableError;
    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.message).toContain(path);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('expands a leading tilde to the home folder', () => {
    expect(expandHome('~', '/home/test')).toBe('/home/test');
    expect(expandHome('~/actions.db', '/home/test')).toBe(join('/home/test', 'actions.db'));
    expect(expandHome('~\\actions.db', '/home/test')).toBe(join('/home/test', 'actions.db'));
    expect(expandHome('/var/actions.db', '/home/test')).toBe('/var/actions.db');
    expect(expandHome('~user/actions.db', '/home/test')).toBe('~user/actions.db');
  });

  it('throws a clear STORE_UNAVAILABLE when better-sqlite3 is not installed', () => {
    let caught: unknown;
    try {
      loadBetterSqlite3(() => {
        throw new Error("Cannot find module 'better-sqlite3'");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    const error = caught as StoreUnavailableError;
    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.fix).toContain('npm install better-sqlite3');
  });
});

describe('better-sqlite3 version support', () => {
  it('accepts the minimum version and anything newer on a modern Node', () => {
    expect(() => assertBetterSqlite3Supported(MIN_BETTER_SQLITE3_VERSION, '10')).not.toThrow();
    expect(() => assertBetterSqlite3Supported('13.0.3', '10')).not.toThrow();
    expect(() => assertBetterSqlite3Supported('14.2.0', '10')).not.toThrow();
  });

  it('explains the Node-API 10 requirement of 13.x on Node 22 before 22.14', () => {
    let caught: unknown;
    try {
      assertBetterSqlite3Supported('13.0.3', '9');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    const error = caught as StoreUnavailableError;
    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.what).toContain('13.0.3');
    expect(error.why).toContain('Node-API 10');
    expect(error.why).toContain('22.14');
    expect(error.fix).toContain('better-sqlite3@^12.11.1');
  });

  it('rejects a version below the minimum and names the installed version, the requirement, and the fix command', () => {
    let caught: unknown;
    try {
      assertBetterSqlite3Supported('11.10.0', '9');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    const error = caught as StoreUnavailableError;
    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.what).toContain('11.10.0');
    expect(error.why).toContain(MIN_BETTER_SQLITE3_VERSION);
    expect(error.fix).toContain('npm install better-sqlite3@latest');
  });

  it('compares major, minor, and patch correctly around the minimum', () => {
    // Above the minimum in each position.
    expect(() => assertBetterSqlite3Supported('13.0.0', '10')).not.toThrow();
    expect(() => assertBetterSqlite3Supported('12.12.0', '10')).not.toThrow();
    expect(() => assertBetterSqlite3Supported('12.11.2', '10')).not.toThrow();
    // Below the minimum in each position.
    expect(() => assertBetterSqlite3Supported('11.9.9', '9')).toThrow(StoreUnavailableError);
    expect(() => assertBetterSqlite3Supported('12.10.9', '9')).toThrow(StoreUnavailableError);
    expect(() => assertBetterSqlite3Supported('12.11.0', '9')).toThrow(StoreUnavailableError);
  });

  it('treats short or unparsable versions as too old instead of guessing', () => {
    expect(() => assertBetterSqlite3Supported('13', '10')).not.toThrow();
    expect(() => assertBetterSqlite3Supported('12.12', '10')).not.toThrow();
    expect(() => assertBetterSqlite3Supported('0.0.0', '9')).toThrow(StoreUnavailableError);
    expect(() => assertBetterSqlite3Supported('not-a-version', '9')).toThrow(StoreUnavailableError);
  });

  it('assumes the worst when the Node-API level is unknown', () => {
    expect(() => assertBetterSqlite3Supported('12.11.1', undefined)).not.toThrow();
    expect(() => assertBetterSqlite3Supported('13.0.3', undefined)).toThrow(StoreUnavailableError);
  });

  it('also refuses future majors on a Node that cannot run them', () => {
    let caught: unknown;
    try {
      assertBetterSqlite3Supported('14.0.0', '9');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    expect((caught as StoreUnavailableError).what).toContain('14.0.0');
  });

  it('reads the installed version from the package manifest', () => {
    expect(readBetterSqlite3Version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports a clear error when the version cannot be read', () => {
    expect(() =>
      readBetterSqlite3Version(() => {
        throw new Error('missing');
      }),
    ).toThrow(StoreUnavailableError);
    let caught: unknown;
    try {
      readBetterSqlite3Version(() => ({}));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    expect((caught as StoreUnavailableError).what).toContain('no version');
  });
});

describe('SqliteStore errors', () => {
  it('converts raw database errors to STORE_UNAVAILABLE with the original cause', async () => {
    const path = join(tempDir(), 'actions.db');
    const store = new SqliteStore({ path });
    const raw = new Database(path);
    raw.exec('DROP TABLE actions');
    raw.close();

    let caught: unknown;
    try {
      await store.get('missing');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreUnavailableError);
    const error = caught as StoreUnavailableError;
    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain(path);
    await store.close();
  });
});

describe('SqliteStore persistence', () => {
  it('keeps records across close and reopen without re-running migrations', async () => {
    const path = join(tempDir(), 'actions.db');
    const first = new SqliteStore({ path });
    const record = await executeOnce(first, 'fp-1');
    await first.complete(
      record.id,
      completeInput(record, { type: 'success', result: { ok: true } }),
    );
    await first.close();

    const second = new SqliteStore({ path });
    const stored = await second.get(record.id);
    expect(stored?.state).toBe('SUCCEEDED');
    expect(stored?.redactedArgs).toEqual({ amount: 1 });

    const raw = new Database(path);
    const row = raw.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
      version: number;
    };
    expect(row.version).toBe(2);
    raw.close();
    await second.close();
  });
});

describe('S3 schema migration', () => {
  const fixture = fileURLToPath(new URL('./fixtures/schema-v0.db', import.meta.url));

  it('S3: migrates a version 0 database without losing any rows', async () => {
    const path = join(tempDir(), 'actions.db');
    copyFileSync(fixture, path);
    const store = new SqliteStore({ path });

    const first = await store.get('v0-rec-1');
    expect(first?.state).toBe('SUCCEEDED');
    expect(first?.identity).toBe('fp-v0-1');
    expect(first?.attempt).toBe(1);
    expect(first?.redactedArgs).toEqual({ amount: 1500 });
    expect(first?.createdAt).toEqual(new Date(1767268800000));

    const second = await store.get('v0-rec-2');
    expect(second?.state).toBe('IN_DOUBT');
    expect(second?.attempt).toBe(2);
    expect(second?.redactedArgs).toEqual({ transaction: 'T1' });

    const raw = new Database(path);
    const row = raw.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
      version: number;
    };
    expect(row.version).toBe(2);
    const columns = raw.prepare('PRAGMA table_info(actions)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('repeat_grant');
    expect(columns.map((column) => column.name)).toContain('attempt_token');
    expect(columns.map((column) => column.name)).toContain('result_redacted');
    raw.close();

    // The migrated schema supports new writes and is fully usable.
    const record = await executeOnce(store, 'fp-new');
    await store.complete(
      record.id,
      completeInput(record, { type: 'success', result: { ok: true } }),
    );
    expect((await store.get(record.id))?.state).toBe('SUCCEEDED');
    await store.close();
  });
});

describe('S6 redaction on disk', () => {
  it('S6: a structured result with secret fields never reaches the database files', async () => {
    const path = join(tempDir(), 'actions.db');
    const store = new SqliteStore({ path });
    const guard = createGuard({ store });
    const secret = 'sk_live_RESULT-SECRET';
    const pin = 'PIN-8642-UNIQUE';
    const outcome = await guard.run(
      { tool: 'paystack.refund', args: { amount: 1500 } },
      async () => ({ receipt: { secret, pin, nested: { token: secret } } }),
    );
    expect(outcome.status).toBe('executed');

    const [record] = await guard.list({});
    expect(record?.resultRedacted).toBe(true);
    expect(record?.result).toEqual({
      receipt: { secret: '[redacted]', pin: '[redacted]', nested: { token: '[redacted]' } },
    });
    await guard.close();

    const files = [path, `${path}-wal`, `${path}-shm`].filter((file) => existsSync(file));
    expect(files).toContain(path);
    for (const file of files) {
      const bytes = readFileSync(file);
      expect(bytes.includes(secret), file).toBe(false);
      expect(bytes.includes(pin), file).toBe(false);
    }
  });

  it('S6: never writes the fake card number or PIN to the database or WAL files', async () => {
    const path = join(tempDir(), 'actions.db');
    const store = new SqliteStore({ path });
    const secretArgs = {
      card: { number: '4111111111111111' },
      CARDNUMBER: '4111111111111111',
      pin: '8642',
      profile: { PIN: '8642', nested: { pIn: '8642' } },
      payment: { Card: { Number: '4111111111111111' } },
    };
    const redacted = redact(secretArgs) as Record<string, unknown>;
    const result = await store.begin(beginInput(redacted, { fingerprint: 'fp-secrets' }));
    if (result.kind !== 'execute') throw new Error('expected execute');
    const record = result.record;
    await store.complete(
      record.id,
      completeInput(record, { type: 'success', result: { receipt: 'R1' } }),
    );

    const stored = await store.get(record.id);
    if (stored === null) throw new Error('expected a stored record');
    expect((stored.redactedArgs as Record<string, unknown>).pin).toBe('[redacted]');
    await store.close();

    const files = [path, `${path}-wal`, `${path}-shm`].filter((file) => existsSync(file));
    expect(files).toContain(path);
    for (const file of files) {
      const bytes = readFileSync(file);
      expect(bytes.includes('4111111111111111'), file).toBe(false);
      expect(bytes.includes('8642'), file).toBe(false);
    }
  });
});

describe('S8 result size policy', () => {
  it('S8: results above maxResultBytes follow the documented behaviour', async () => {
    const store = new SqliteStore({ path: join(tempDir(), 'actions.db') });
    expect(DEFAULT_MAX_RESULT_BYTES).toBe(262_144);
    const small = 'x'.repeat(10); // JSON text is 12 bytes: "xxxxxxxxxx"

    // Exactly at the limit is stored in full.
    const atLimit = await executeOnce(store, 'fp-at-limit');
    await store.complete(
      atLimit.id,
      completeInput(atLimit, { type: 'success', result: small }, { maxResultBytes: 12 }),
    );
    const storedFull = await store.get(atLimit.id);
    expect(storedFull?.result).toBe(small);
    expect(storedFull?.resultTruncated).toBe(false);

    // One byte over the limit raises RESULT_TOO_LARGE and writes nothing.
    const overLimit = await executeOnce(store, 'fp-over-limit');
    let caught: unknown;
    try {
      await store.complete(
        overLimit.id,
        completeInput(overLimit, { type: 'success', result: small }, { maxResultBytes: 11 }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResultTooLargeError);
    const error = caught as ResultTooLargeError;
    expect(error.code).toBe('RESULT_TOO_LARGE');
    expect(error.what).toContain('12');
    expect(error.what).toContain('11');
    const stuck = await store.get(overLimit.id);
    expect(stuck?.state).toBe('IN_FLIGHT');
    expect(stuck?.result).toBeUndefined();

    // The caller can recover by not storing the full result: a summary is kept.
    await store.complete(
      overLimit.id,
      completeInput(overLimit, { type: 'success', result: small }, { storeResult: false }),
    );
    const summarised = await store.get(overLimit.id);
    expect(summarised?.state).toBe('SUCCEEDED');
    expect(summarised?.result).toBeUndefined();
    expect(summarised?.resultTruncated).toBe(true);
    await store.close();
  });
});

describe('SqliteStore JSON storage', () => {
  it('rejects unclonable arguments with NOT_SERIALIZABLE and stores nothing', async () => {
    const store = new SqliteStore({ path: join(tempDir(), 'actions.db') });
    await expect(store.begin(beginInput({ callback: () => undefined }))).rejects.toBeInstanceOf(
      NotSerializableError,
    );
    await expect(store.begin(beginInput({ token: Symbol('secret') }))).rejects.toBeInstanceOf(
      NotSerializableError,
    );
    expect(await store.list({})).toEqual([]);
    await store.close();
  });

  it('rejects a circular result with NOT_SERIALIZABLE and leaves the record in flight', async () => {
    const store = new SqliteStore({ path: join(tempDir(), 'actions.db') });
    const record = await executeOnce(store, 'fp-1');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      store.complete(record.id, completeInput(record, { type: 'success', result: circular })),
    ).rejects.toBeInstanceOf(NotSerializableError);
    expect((await store.get(record.id))?.state).toBe('IN_FLIGHT');
    await store.close();
  });

  it('accepts undefined arguments and stores a grant without by or note', async () => {
    const store = new SqliteStore({ path: join(tempDir(), 'actions.db') });
    const result = await store.begin(beginInput(undefined, { fingerprint: 'fp-1' }));
    if (result.kind !== 'execute') throw new Error('expected execute');
    const record = result.record;
    expect(record.redactedArgs).toBeUndefined();
    await store.grantRepeat('fp-1', { grantedAt: NOW });
    expect((await store.get(record.id))?.repeatGrant).toEqual({ grantedAt: NOW });
    await store.close();
  });

  it('round-trips a full repeat grant', async () => {
    const store = new SqliteStore({ path: join(tempDir(), 'actions.db') });
    const record = await executeOnce(store, 'fp-1');
    const grant = { grantedAt: NOW, grantedBy: 'kola', note: 'customer asked again' };
    await store.grantRepeat('fp-1', grant);
    expect((await store.get(record.id))?.repeatGrant).toEqual(grant);
    await store.close();
  });
});
