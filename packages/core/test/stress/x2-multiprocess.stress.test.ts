import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { collectChild, killRemainingChildren, parseChildJson, spawnNode } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/stress-multiprocess.mjs', import.meta.url));

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-x2-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await killRemainingChildren();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

interface WorkerReport {
  ran: number;
  results: { status: string; code?: string }[];
}

function readCounterLines(file: string): string[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

describe('X2: multi-process concurrency', () => {
  it('X2: 4 processes sharing one SqliteStore file execute the action exactly once in total', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'actions.db');
    const counterFile = join(dir, 'runs.txt');

    const workers = [1, 2, 3, 4].map(() => spawnNode([FIXTURE, dbPath, counterFile, '25']));
    const results = await Promise.all(
      workers.map((child, index) => collectChild(child, 60_000, `worker ${index + 1}`)),
    );

    results.forEach((result, index) => {
      expect(result.code, `worker ${index + 1} stderr:\n${result.stderr}`).toBe(0);
    });

    const reports = results.map((result) => parseChildJson<WorkerReport>(result.stdout));
    const entries = reports.flatMap((report) => report.results);
    const errors = entries.filter((entry) => entry.status === 'error');
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(entries.filter((entry) => entry.status === 'executed')).toHaveLength(1);

    // The shared append-only file is independent of the store under test.
    expect(readCounterLines(counterFile)).toHaveLength(1);
  });
});
