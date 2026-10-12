import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';
import { demoDir, pass } from './lib.mjs';

const dbPath = join(demoDir, 'demo.db');
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

let refundsSent = 0;
async function slowRefund({ transaction, amount }) {
  refundsSent += 1;
  console.log(`  REFUND SENT: ${amount} naira for ${transaction}`);
  await new Promise((resolve) => setTimeout(resolve, 3000)); // the reply is slow
  return { ok: true };
}

async function attempt(refund, transaction) {
  try {
    await refund({ transaction, amount: 1500 });
    return 'succeeded';
  } catch (error) {
    console.log(`  ${error.code}: ${error.what}`);
    console.log(`    Fix: ${error.fix}`);
    return error.code;
  }
}

// Phase 1: the Kola case. The refund is sent once, the first attempt times out,
// the next two are blocked, and the slow reply upgrades the record later.
console.log('Phase 1: the silent success');
const guard = createGuard({ store: new SqliteStore({ path: dbPath }) });
const refund = guard.wrap('paystack.refund', slowRefund, {
  keyFields: ['transaction', 'amount'],
  timeoutMs: 1000,
});
const codes = [];
for (let call = 1; call <= 3; call += 1) {
  console.log(`Attempt ${call}:`);
  codes.push(await attempt(refund, 'T999'));
}
console.log(`Total refunds sent: ${refundsSent}`);
await new Promise((resolve) => setTimeout(resolve, 3000)); // let the slow reply arrive
const records = await guard.list({ toolName: 'paystack.refund' });
const lateRecord = records.find((record) => record.redactedArgs?.transaction === 'T999');
await guard.close();

// Phase 2: practise a human decision. This run closes before the slow reply
// arrives, so the record stays IN_DOUBT and a person must resolve it.
console.log('\nPhase 2: leaving a record in doubt');
const guard2 = createGuard({ store: new SqliteStore({ path: dbPath }) });
const refund2 = guard2.wrap('paystack.refund', slowRefund, {
  keyFields: ['transaction', 'amount'],
  timeoutMs: 1000,
});
const doubtCodes = [];
for (let call = 1; call <= 3; call += 1) {
  doubtCodes.push(await attempt(refund2, 'T1000'));
}
await guard2.close(); // cancels the late write, so the record stays in doubt
const store = new SqliteStore({ path: dbPath });
const doubtRecord = (await store.list({ toolName: 'paystack.refund' })).find(
  (record) => record.redactedArgs?.transaction === 'T1000',
);
await store.close();

const phase1 = codes[0] === 'IN_DOUBT' && codes[1] === 'IN_DOUBT' && codes[2] === 'IN_DOUBT';
const phase2 = doubtCodes[0] === 'IN_DOUBT' && doubtRecord?.state === 'IN_DOUBT';
pass(
  'Demo 2: in doubt stops the retry, and the late reply upgrades it',
  phase1 && lateRecord?.state === 'SUCCEEDED' && phase2 && refundsSent === 2,
  `phase 1 ${lateRecord?.state ?? 'missing'}, phase 2 ${doubtRecord?.state ?? 'missing'}, refunds sent ${refundsSent}`,
);
console.log('Resolve the in-doubt record with:');
console.log(
  `  npx -y @twiceshy/mcp-proxy resolve ${doubtRecord?.id ?? '<id>'} --succeeded --by "<your name>" --config twiceshy.config.json`,
);
