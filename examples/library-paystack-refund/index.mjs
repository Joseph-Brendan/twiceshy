import { createGuard, isTwiceshyError, MemoryStore } from 'twiceshy';

/**
 * The Kola scenario, made runnable. Paystack accepts the refund and then takes
 * its time replying. Twiceshy times out, refuses the retry, and upgrades the
 * record when the slow reply finally arrives. The ledger at the bottom shows
 * that Ife was refunded exactly once.
 */

const guard = createGuard({
  store: new MemoryStore(),
  namespace: 'kola-delivery',
  window: '10m',
});

let paystackCalls = 0;
let refundsRecorded = 0;

function fakePaystackRefund(args) {
  paystackCalls += 1;
  refundsRecorded += 1;
  console.log(
    `Paystack accepted refund ${args.transaction} for ${args.amount} naira. Paystack is slow today.`,
  );
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ receipt: `PS-${args.transaction}`, amount: args.amount });
    }, 400);
  });
}

const refund = guard.wrap('paystack.refund', fakePaystackRefund, {
  keyFields: ['transaction', 'amount'],
  timeoutMs: 150,
});

const args = { transaction: 'T123', amount: 1500, reason: 'missing drink' };

console.log('Attempt 1: the agent asks Twiceshy to run the refund.');
try {
  const result = await refund(args);
  console.log(`Attempt 1 returned ${JSON.stringify(result)}.`);
} catch (error) {
  console.log('Attempt 1 ended with no answer from Paystack.');
  if (isTwiceshyError(error)) {
    console.log(`  What happened: ${error.what}`);
    console.log(`  Why: ${error.why}`);
    console.log(`  What to do: ${error.fix}`);
  }
}

console.log('');
console.log('Attempt 2: the agent retries the same refund right away.');
try {
  const result = await refund(args);
  console.log(`Attempt 2 returned ${JSON.stringify(result)}.`);
} catch (error) {
  console.log('Attempt 2 was blocked by Twiceshy.');
  if (isTwiceshyError(error)) {
    console.log(`  What happened: ${error.what}`);
    console.log(`  Why: ${error.why}`);
  } else {
    console.log(String(error));
  }
}

console.log('');
console.log('Paystack finally replies. Twiceshy is still listening.');
await new Promise((resolve) => {
  setTimeout(resolve, 500);
});
const [record] = await guard.list({});
if (record !== undefined) {
  console.log(`Record state is now ${record.state}.`);
  console.log(`Stored receipt: ${JSON.stringify(record.result)}.`);
}

console.log('');
console.log('Attempt 3: the agent retries once more, after the answer arrived.');
const third = await refund(args);
console.log(`Attempt 3 returned the original receipt as a duplicate: ${JSON.stringify(third)}.`);

console.log('');
console.log(`Paystack calls: ${paystackCalls}. Refunds recorded at Paystack: ${refundsRecorded}.`);
console.log('Ife was refunded once, and the agent still has the receipt.');

await guard.close();
