import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

/**
 * Smoke scenario: close() while a late result is on its way. The call times
 * out and becomes IN_DOUBT, then close() cancels the late-completion watcher,
 * so the later reply must not reopen or overwrite the record. Run as a plain
 * node process from the smoke folder.
 */

const dbPath = join(process.cwd(), 'scenario-close-late.db');
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
  timeoutMs: 200,
  closeTimeoutMs: 5_000,
});

let lateResolved = false;
const running = guard.run({ tool: 'smoke.late', args: { id: 1 } }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  lateResolved = true;
  return 'late value';
});
const settled = running.then(
  (value) => ({ value, error: null }),
  (error) => ({ value: null, error }),
);

// Wait for the timeout (200 ms), then close while the reply is still coming.
await new Promise((resolve) => setTimeout(resolve, 300));
const [record] = await guard.list({ state: 'IN_DOUBT' });
await guard.close();
const timeoutResult = await settled;

// Let the late reply arrive; the cancelled watcher must ignore it.
await new Promise((resolve) => setTimeout(resolve, 700));
const stored = new SqliteStore({ path: dbPath });
const after = await stored.get(String(record?.id));
await stored.close();

const timedOut = timeoutResult.error?.code === 'IN_DOUBT';
pass(
  'close while a late result is on its way leaves the record in doubt',
  timedOut &&
    lateResolved &&
    record?.state === 'IN_DOUBT' &&
    after?.state === 'IN_DOUBT' &&
    after?.result === undefined,
  `${String(timeoutResult.error?.code)} then ${String(after?.state)}`,
);
