import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGuard, MemoryStore } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';
import { demoDir } from './lib.mjs';

/**
 * Demo 6 measures the cost per guarded call. It only prints numbers, so it has
 * no PASS or FAIL line: a payment API call takes hundreds of milliseconds, and
 * the point is to compare that with the guard's overhead.
 */

const benchPath = join(demoDir, 'bench.db');
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${benchPath}${suffix}`, { force: true });
}

async function measure(label, store) {
  const guard = createGuard({ store });
  const op = guard.wrap('noop', async ({ n }) => n);
  const start = performance.now();
  for (let n = 0; n < 1000; n++) {
    await op({ n });
  }
  const ms = performance.now() - start;
  console.log(`${label}: ${(ms / 1000).toFixed(2)} ms per guarded call`);
  await guard.close();
}

await measure('MemoryStore', new MemoryStore());
await measure('SqliteStore', new SqliteStore({ path: benchPath }));
