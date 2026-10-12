import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

/**
 * Smoke scenario: close() while an action is running. close() must wait for
 * the call (up to closeTimeoutMs), let it finish, and then close the store.
 * Run as a plain node process from the smoke folder.
 */

const dbPath = join(process.cwd(), 'scenario-close-running.db');
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

function pass(name, ok, details = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details === '' ? '' : `: ${details}`}`);
  if (!ok) {
    process.exitCode = 1;
  }
}

const guard = createGuard({
  store: new SqliteStore({ path: dbPath }),
  closeTimeoutMs: 5_000,
});

const running = guard.run({ tool: 'smoke.slow', args: { id: 1 } }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  return 'finished';
});
const settled = running.then(
  (value) => ({ value, error: null }),
  (error) => ({ value: null, error }),
);

await new Promise((resolve) => setTimeout(resolve, 50));
await guard.close();
const result = await settled;

const stored = new SqliteStore({ path: dbPath });
const record = await stored.get(result.value?.record?.id ?? 'missing');
await stored.close();

pass(
  'close while an action is running waits for it and records the result',
  result.error === null &&
    result.value?.status === 'executed' &&
    result.value.value === 'finished' &&
    record?.state === 'SUCCEEDED',
  result.error === null ? `state ${record?.state ?? 'missing'}` : String(result.error),
);
