import { appendFileSync } from 'node:fs';
import { createGuard } from '../../dist/index.js';
import { SqliteStore } from '../../dist/sqlite.js';

/**
 * X2 child process: fires `calls` identical guarded calls as fast as it can.
 * Every execution appends one line to `counterFile`, which is the shared,
 * store-independent record of how many times the tool actually ran.
 */
const [dbPath, counterFile, callsText] = process.argv.slice(2);
const calls = Number(callsText ?? '25');

const store = new SqliteStore({ path: dbPath });
const guard = createGuard({
  store,
  namespace: 'stress',
  window: '1m',
  leaseMs: 1_000,
  timeoutMs: 30_000,
  waitForInFlightMs: 2_000,
});

let ran = 0;
const results = await Promise.all(
  Array.from({ length: calls }, () =>
    guard
      .run({ tool: 'stress.transfer', args: { amount: 1500, to: 'ife' } }, async () => {
        ran += 1;
        appendFileSync(counterFile, `${process.pid}\n`);
        return { receipt: 'R1', amount: 1500 };
      })
      .then(
        (outcome) => ({ status: outcome.status }),
        (error) => ({ status: 'error', code: error?.code ?? String(error) }),
      ),
  ),
);

console.log(JSON.stringify({ ran, results }));
await guard.close();
