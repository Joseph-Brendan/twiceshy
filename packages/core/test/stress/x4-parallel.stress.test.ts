import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Guard } from '../../src/index.js';
import { createGuard } from '../../src/index.js';
import { SqliteStore } from '../../src/stores/sqlite.js';

const tempDirs = new Set<string>();
const guards = new Set<Guard>();

afterEach(async () => {
  await Promise.all([...guards].map((guard) => guard.close().catch(() => undefined)));
  guards.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('X4: parallel fan-out', () => {
  it('X4: 1,000 different actions run in parallel on SqliteStore with zero false duplicates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twiceshy-x4-'));
    tempDirs.add(dir);
    const guard = createGuard({
      store: new SqliteStore({ path: join(dir, 'actions.db') }),
      window: '1m',
      leaseMs: 1_000,
      timeoutMs: 30_000,
    });
    guards.add(guard);

    let ran = 0;
    const calls = Array.from({ length: 1_000 }, (_, index) =>
      guard.run({ tool: 'stress.action', args: { index } }, async () => {
        ran += 1;
        return { index };
      }),
    );
    const outcomes = await Promise.all(calls);

    expect(ran).toBe(1_000);
    const notExecuted = outcomes.filter((outcome) => outcome.status !== 'executed');
    expect(notExecuted).toEqual([]);
  });
});
