# twiceshy

Twiceshy is a library that stops an AI agent from doing the same money-moving action twice.

The Kola scenario, in four lines:

1. Kola runs a food delivery app in Lagos. His refund agent sends a 1,500 naira refund to Ife through Paystack.
2. Paystack is slow, so the agent's request times out after 30 seconds, even though the refund went through.
3. The agent retries, and Ife receives 3,000 naira instead of 1,500.
4. Twiceshy sits between the agent and the tool. It records the first refund, blocks the retry, and says the refund is in doubt until someone checks.

## 30 second install and use

```bash
npm install twiceshy
```

```js
import { createGuard, MemoryStore } from 'twiceshy';

let refundsSent = 0;

const guard = createGuard({ store: new MemoryStore(), window: '10m' });
const refund = guard.wrap(
  'paystack.refund',
  async (args) => {
    refundsSent += 1;
    return { receipt: 'PS-T123', amount: args.amount };
  },
  { keyFields: ['transaction', 'amount'] },
);

await refund({ transaction: 'T123', amount: 1500, reason: 'missing drink' });
await refund({ transaction: 'T123', amount: 1500, reason: 'customer asked again' });

console.log(`Refunds sent: ${refundsSent}.`);
console.log('The second call returned the first result without running the refund again.');
await guard.close();
```

Real output:

```text
Refunds sent: 1.
The second call returned the first result without running the refund again.
```

The second call had a different `reason`, but `reason` is free text and not part of the key, so Twiceshy saw the same refund. See [Choosing keyFields](../../docs/choosing-key-fields.md).

For several processes on one machine, add the optional SQLite store:

```bash
npm install better-sqlite3
```

```js
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

const guard = createGuard({ store: new SqliteStore({ path: '~/.twiceshy/actions.db' }) });
const outcome = await guard.run(
  { tool: 'paystack.refund', args: { transaction: 'T1', amount: 1500 } },
  async () => ({ receipt: 'PS-T1' }),
);
console.log(`Outcome: ${outcome.status}.`);
await guard.close();
```

Real output:

```text
Outcome: executed.
Value: {"receipt":"PS-T1"}.
```

`SqliteStore` needs Node 22.14 or newer, because `better-sqlite3` ships prebuilt binaries that use a newer Node API. See [Limits](../../docs/limits.md).

## Concepts

- **Action:** one call to one tool with one set of arguments, for example a refund of 1,500 naira for transaction T123.
- **Fingerprint:** a short ID built from the tool, the server, the scope, and the key arguments. Two calls with the same meaning get the same fingerprint.
- **Key fields:** the argument fields that define the action, for example `transaction` and `amount`. Everything else is ignored.
- **Identity:** the fingerprint, or the explicit key when you pass one. A record is looked up by identity.
- **Scope:** who the action belongs to, for example one customer or one agent. It is part of the fingerprint.
- **Record:** what Twiceshy stores about one action: state, timing, redacted arguments, and the redacted result. Field-name redaction cannot find a secret inside free text.
- **Window:** how long after an action finishes an identical action counts as a duplicate. Default: 10 minutes.
- **Lease:** a timed claim that says "this action is running now". If the process dies, the lease runs out.
- **In doubt:** Twiceshy cannot tell whether the action happened. It stops and asks a person.
- **Duplicate:** the action already ran inside the window, so Twiceshy returns the original result instead of running it again.
- **Blocked:** Twiceshy refuses to run the action because the record is in doubt, in progress, or because an explicit key was reused with different arguments.

### Record states

| State | Meaning |
|---|---|
| `IN_FLIGHT` | Claimed and running. It has a lease. |
| `SUCCEEDED` | Finished, result stored. |
| `FAILED_DEFINITE` | Failed in a way that certainly had no effect. Safe to retry. |
| `IN_DOUBT` | May or may not have happened. A person must decide. |
| `RESOLVED_SUCCEEDED` | A person confirmed it happened. Acts like `SUCCEEDED`. |
| `RESOLVED_FAILED` | A person confirmed it did not happen. Acts like `FAILED_DEFINITE`. |

## Configuration reference

`createGuard(options)` validates every option with Zod. A bad option throws one `CONFIG_INVALID` error that lists every problem.

| Option | Default | What it does |
|---|---|---|
| `store` | required | Where records live. Use `new MemoryStore()` or `new SqliteStore({ path })`. |
| `namespace` | `'local'` | Becomes the server name inside fingerprints. |
| `window` | `'10m'` | How long a finished action counts as a duplicate. Accepts `'30s'`, `'10m'`, `'2h'`, or milliseconds. |
| `retention` | `'7d'` | How long records are kept for audit. |
| `onStoreFailure` | `'closed'` | `'closed'` refuses guarded calls when the store is down. `'open'` runs them and emits `guard-bypassed`. |
| `waitForInFlightMs` | `5000` | How long a second caller waits for a running action. |
| `maxResultBytes` | `262144` | Largest result stored in full. A bigger result fails with `RESULT_TOO_LARGE`; set `storeResult: false` to store nothing and accept a summary on duplicates. |
| `timeoutMs` | `30000` | Default time limit for one call. |
| `leaseMs` | `timeoutMs + 30000` | Claim duration. Tests often shorten it. |
| `closeTimeoutMs` | `30000` | How long `close()` waits for running calls. |
| `closeStore` | `true` | Set `false` when several guards share one store. |
| `trustIdempotentHint` | `true` | Trusts the MCP `idempotentHint` annotation. |
| `redact` | `[]` | Extra field names to redact, on top of the built-in list. |
| `classifyError` | undefined | Replaces the built-in error classifier. |
| `hooks` | `{}` | Functions that receive structured events. See below. |
| `clock` | system clock | Injectable time and timers for tests. |

`guard.wrap(tool, fn, options)` options:

| Option | What it does |
|---|---|
| `keyFields` | The argument fields that define the action. Dot paths work. |
| `ignoreFields` | Used when `keyFields` is not set: all arguments except these. |
| `normalize` | Per field: `number`, `trim`, `lowercase`, `lowercase-trim`, or a function. |
| `scope` | A function that computes the scope from the arguments. |
| `timeoutMs` | Time limit for this tool. |
| `storeResult` | `false` stores no result at all; a duplicate then returns a short text summary saying the action already ran. |

`guard.run(request, fn)` returns `{ status: 'executed', value, record }` or `{ status: 'duplicate', value, record, originalAt }`. It throws a `TwiceshyError` subclass when the call is blocked.

Guard methods:

| Method | What it does |
|---|---|
| `run(request, fn)` | Guards one call and returns the full outcome. |
| `wrap(tool, fn, options)` | Returns a function with the same parameters and return type as `fn`. |
| `list(filter)` | Lists records, newest first. |
| `get(id)` | Reads one record, or returns `null`. |
| `resolve(id, { as, by, note })` | A person settles an in-doubt record. `by` is required. |
| `allowRepeat(fingerprint, { by, note })` | A person approves exactly one extra execution. |
| `purge(olderThan)` | Removes records past retention. |
| `close()` | Stops timers, waits for running calls, and closes the store. |

Hooks receive one structured event per decision: `onExecute`, `onDuplicate`, `onBlocked`, `onInDoubt`, `onLateCompletion`, `onResolutionConflict`, `onStoreWriteFailed`, `onGuardBypassed`, `onWarning`. Each event carries `type`, `at`, `recordId`, `fingerprint`, `tool`, `server`, `scope`, `durationMs`, and `attempt`. An exception inside a hook is written to stderr and never breaks the guarded call.

### Results, cancellation, and human decisions

- **Results are redacted before storage.** The same field-name rules used for arguments apply to a successful result. A duplicate returns the stored, redacted copy. The first caller still gets the real result.
- **`storeResult: false` stores nothing.** The action's record keeps no result, and a duplicate returns a short summary instead.
- **Cancellation before start is a definite failure.** If the caller cancels after the claim but before the tool function is invoked, the record becomes `FAILED_DEFINITE` with reason "cancelled before start", so the next call may run. Cancellation after invocation leaves the record `IN_DOUBT`.
- **Human decisions win.** A late result never overwrites a human resolution. If it agrees, nothing changes. If it contradicts the human, Twiceshy emits a `resolution-conflict` event. When a person said "failed" but the action actually succeeded, the record returns to `IN_DOUBT` and blocks the next identical call until a person decides again.

## Limits

- `MemoryStore` loses all records when the process restarts. Use `SqliteStore` for anything that matters.
- `SqliteStore` protects one machine only. Agents on several servers need the future Redis or Postgres store.
- A wrong `keyFields` choice is the main way protection fails. Read [Choosing keyFields](../../docs/choosing-key-fields.md).
- Twiceshy blocks legitimate repeats inside the window. A person can approve one with `allowRepeat`.
- `better-sqlite3` prebuilds need Node 22.14 or newer.

The full list is in [Limits](../../docs/limits.md).

## Guides

- [Choosing keyFields](../../docs/choosing-key-fields.md)
- [What in doubt means and what to do](../../docs/in-doubt.md)
- [Window versus retention](../../docs/window-and-retention.md)
- [Limits](../../docs/limits.md)
- [Error reference](../../docs/errors.md)

## License

MIT. Copyright 2026 Joseph Brendan, Dev and Design HQ.
