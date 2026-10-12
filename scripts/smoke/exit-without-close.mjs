import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

/**
 * Smoke scenario: the process exits without calling close(). This must not
 * crash, and the work already done must be on disk. Run as a plain node
 * process from the smoke folder.
 */

const dbPath = join(process.cwd(), 'scenario-exit-without-close.db');
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

const guard = createGuard({ store: new SqliteStore({ path: dbPath }) });
const outcome = await guard.run({ tool: 'smoke.exit', args: { id: 1 } }, async () => 'done');

console.log(
  `${outcome.status === 'executed' ? 'PASS' : 'FAIL'} exit without close keeps the finished record: state ${outcome.record?.state ?? 'missing'}`,
);
if (outcome.status !== 'executed' || outcome.record?.state !== 'SUCCEEDED') {
  process.exitCode = 1;
}
