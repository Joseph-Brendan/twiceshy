# Library example: the Kola refund

This example runs the Kola scenario as a small script. A fake Paystack refund
accepts the money and then waits 400 milliseconds before replying. Twiceshy is
given a 150 millisecond timeout.

Run it with one command from the repository root:

```bash
pnpm --filter @twiceshy/example-library-paystack-refund start
```

The script prints:

1. Attempt 1 times out. Twiceshy records the refund as IN_DOUBT and refuses to guess.
2. Attempt 2 is blocked, because the answer from attempt 1 never arrived.
3. The slow Paystack reply arrives, and Twiceshy upgrades the record to SUCCEEDED by itself.
4. Attempt 3 returns the original receipt as a duplicate, without calling Paystack again.

At the end it prints how many times Paystack was called. The number is 1, so Ife
was refunded exactly once.

The important line in the code is the set of key fields:

```js
const refund = guard.wrap('paystack.refund', fakePaystackRefund, {
  keyFields: ['transaction', 'amount'],
  timeoutMs: 150,
});
```

`transaction` and `amount` define the refund. The free text `reason` is not part
of the fingerprint, so a retry with a rephrased reason is still the same refund.
See [Choosing keyFields](../../docs/choosing-key-fields.md) for the full guide.
