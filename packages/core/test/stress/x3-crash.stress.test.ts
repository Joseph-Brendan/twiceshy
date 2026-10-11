import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionStore } from '../../src/index.js';
import { SqliteStore } from '../../src/stores/sqlite.js';
import {
  collectChild,
  killRemainingChildren,
  parseChildJson,
  spawnNode,
  waitFor,
} from './helpers.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/stress-crash-child.mjs', import.meta.url));

const tempDirs = new Set<string>();
const openStores = new Set<ActionStore>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-x3-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...openStores].map((store) => store.close().catch(() => undefined)));
  openStores.clear();
  await killRemainingChildren();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function readCounterLines(file: string): string[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

describe('X3: crash recovery', () => {
  it('X3: a killed process leaves the action in doubt, and the next process refuses to run it', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'actions.db');
    const counterFile = join(dir, 'runs.txt');
    const parentStore = new SqliteStore({ path: dbPath });
    openStores.add(parentStore);

    const child = spawnNode([FIXTURE, dbPath, counterFile]);
    const killed = collectChild(child, 60_000, 'crashing child');

    await waitFor(
      async () => {
        if (readCounterLines(counterFile).length !== 1) {
          return false;
        }
        const records = await parentStore.list({ toolName: 'stress.crash' });
        return records.length === 1 && records[0]?.state === 'IN_FLIGHT';
      },
      20_000,
      'the guarded action to start',
    );

    // On Windows there is no real SIGKILL; Node maps child.kill('SIGKILL') to
    // TerminateProcess, the closest forced kill available.
    child.kill('SIGKILL');
    await killed;
    expect(child.killed).toBe(true);

    // No process renews the lease now, so it expires on its own.
    await waitFor(
      async () => {
        const records = await parentStore.list({ toolName: 'stress.crash' });
        const record = records[0];
        return (
          record !== undefined &&
          record.leaseExpiresAt !== null &&
          record.leaseExpiresAt.getTime() <= Date.now()
        );
      },
      10_000,
      'the lease to expire',
    );

    const second = spawnNode([FIXTURE, dbPath, counterFile, 'try']);
    const secondResult = await collectChild(second, 60_000, 'second child');
    expect(secondResult.code, secondResult.stderr).toBe(0);
    const report = parseChildJson<{ code: string; ran: boolean }>(secondResult.stdout);
    expect(report.code).toBe('IN_DOUBT');
    expect(report.ran).toBe(false);

    // Only the killed process ever reached the tool.
    expect(readCounterLines(counterFile)).toHaveLength(1);
    const stored = await parentStore.list({ toolName: 'stress.crash' });
    expect(stored[0]?.state).toBe('IN_DOUBT');
  });
});
