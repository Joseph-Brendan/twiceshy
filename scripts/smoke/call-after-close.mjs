import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

/**
 * Smoke scenario: every call after close() gets STORE_UNAVAILABLE, never a
 * crash. Run as a plain node process from the smoke folder.
 */

const dbPath = join(process.cwd(), 'scenario-call-after-close.db');
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

function pass(name, ok, details = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details === '' ? '' : `: ${details}`}`);
  if (!ok) {
    process.exitCode = 1;
  }
}

const guard = createGuard({ store: new SqliteStore({ path: dbPath }) });
await guard.run({ tool: 'smoke.before', args: {} }, async () => 'ok');
await guard.close();

let guardError = null;
try {
  await guard.run({ tool: 'smoke.after', args: {} }, async () => 'never');
} catch (error) {
  guardError = error;
}

const store = new SqliteStore({ path: dbPath });
await store.close();
let storeError = null;
try {
  await store.get('missing');
} catch (error) {
  storeError = error;
}

pass(
  'a guard and store call after close() get STORE_UNAVAILABLE',
  guardError?.code === 'STORE_UNAVAILABLE' && storeError?.code === 'STORE_UNAVAILABLE',
  `guard ${String(guardError?.code)}, store ${String(storeError?.code)}`,
);
