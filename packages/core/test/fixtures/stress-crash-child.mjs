import { appendFileSync } from 'node:fs';
import { createGuard } from '../../dist/index.js';
import { SqliteStore } from '../../dist/sqlite.js';

/**
 * X3 child process. In "run" mode it starts a guarded action whose tool
 * function never settles; the parent kills it with SIGKILL. In "try" mode it
 * attempts the same action again and reports the outcome code it receives,
 * without ever running the tool unless the guard allows it.
 */
const [dbPath, counterFile, mode = 'run'] = process.argv.slice(2);

const store = new SqliteStore({ path: dbPath });
const guard = createGuard({
  store,
  namespace: 'stress',
  window: '1m',
  leaseMs: 500,
  timeoutMs: 60_000,
  waitForInFlightMs: 1_000,
});

if (mode === 'try') {
  let ran = false;
  try {
    const outcome = await guard.run({ tool: 'stress.crash', args: { id: 'one' } }, async () => {
      ran = true;
      appendFileSync(counterFile, 'try\n');
      return 'should not run';
    });
    console.log(JSON.stringify({ code: 'NONE', ran, status: outcome.status }));
  } catch (error) {
    console.log(JSON.stringify({ code: error?.code ?? String(error), ran }));
  }
  await guard.close();
} else {
  await guard.run({ tool: 'stress.crash', args: { id: 'one' } }, async () => {
    appendFileSync(counterFile, 'first\n');
    return new Promise(() => {
      // Never settles: the parent kills this process mid-action.
    });
  });
}
