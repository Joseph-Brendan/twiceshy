import { createGuard, MemoryStore } from 'twiceshy';
import { pass } from './lib.mjs';

let refundsSent = 0;
async function sendRefund({ transaction, amount, reason }) {
  refundsSent += 1;
  console.log(`  REFUND SENT: ${amount} naira for ${transaction} (${reason})`);
  return { ok: true, refundId: `rf_${refundsSent}` };
}

// Without Twiceshy: the agent retries three times
console.log('Without Twiceshy:');
for (let i = 0; i < 3; i++) {
  await sendRefund({ transaction: 'T123', amount: 1500, reason: 'missing drink' });
}
const unguardedSent = refundsSent;
console.log(`  Total refunds sent: ${refundsSent}\n`);

// With Twiceshy
refundsSent = 0;
const guard = createGuard({ store: new MemoryStore() });
const guardedRefund = guard.wrap('paystack.refund', sendRefund, {
  keyFields: ['transaction', 'amount'],
});

console.log('With Twiceshy:');
const reasons = ['missing drink', 'refunding the missing drink', 'drink was not delivered'];
const refundIds = [];
for (const reason of reasons) {
  const result = await guardedRefund({ transaction: 'T123', amount: 1500, reason });
  refundIds.push(result.refundId);
  console.log(`  Attempt returned refundId ${result.refundId}`);
}
console.log(`  Total refunds sent: ${refundsSent}`);
await guard.close();

pass(
  'Demo 1: a rephrased retry is the same refund',
  unguardedSent === 3 && refundsSent === 1 && new Set(refundIds).size === 1,
  `without Twiceshy ${unguardedSent} refunds, with Twiceshy ${refundsSent} refund and ids ${refundIds.join(', ')}`,
);
