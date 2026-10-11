# twiceshy

A zero-setup, local-first guard that stops AI agents from repeating an action by mistake.

The Kola scenario, in four lines:

1. An agent calls `paystack.refund` for Ife's missing drink.
2. The call times out after the money moved, so the agent retries.
3. Twiceshy sees the first attempt is in doubt, refuses the retry, and asks a human.
4. No one is paid twice, and nothing is silently lost.

Install and guard a function in 30 seconds:

```bash
npm install twiceshy
```

```ts
import { createGuard, MemoryStore } from 'twiceshy';

const guard = createGuard({ store: new MemoryStore(), window: '10m' });
const refund = guard.wrap('paystack.refund', paystackRefund, {
  keyFields: ['transaction', 'amount'],
});

await refund({ transaction: 'T123', amount: 1500, reason: 'missing drink' });
```

For multi-process use, install `better-sqlite3` and use `twiceshy/sqlite`:

```ts
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

const guard = createGuard({ store: new SqliteStore({ path: '~/.twiceshy/actions.db' }) });
```

See the repository README and `SPEC.md` for the full API, retention, and the "in doubt" workflow.
