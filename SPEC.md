# Twiceshy: Repeat-Action Guard
## Build Specification v1.0

Owner: Joseph Brendan, Dev and Design HQ
Build tool: Antigravity, on a personal laptop
Status: ready to build
Date: 11 October 2026

---

## Part A. For Joseph: how to use this document

This file is two things at once. It is the full design of the tool, and it is the instruction set your coding agent works from. You do not need to understand every line before you start. The agent does.

**Setup, once:**

1. Create an empty folder called `twiceshy` on your laptop.
2. Save this file inside it as `SPEC.md`.
3. Open the folder in Antigravity.
4. Paste the **Kickoff prompt** from Part D into the agent chat.
5. Work through the phases in Part D one at a time. Each phase has a prompt to paste and a plain check for you to do by hand.

**Three labels appear in Part D:**

- **[PROMPT]**: paste this into Antigravity.
- **[HAND]**: you do this yourself. Usually it means running a command and checking what you see.
- **[REVIEW]**: the agent finished. Read its summary, run the checks, and only then move on.

**One rule above all:** never move to the next phase while any test is failing. A guard that protects money must not be built on top of broken parts.

---

## Part B. The product

### B1. The problem

AI agents retry. When a tool call times out, returns something unclear, or the connection drops, the agent tries again. For reading data, that is harmless. For a refund, a payment, a sent message, or a booking, the action happens twice.

The worst case is the silent one. The first call actually succeeded, but the success message got lost on the way back. The agent believes it failed and tries again. Now the customer has two refunds, and nobody knows until the bank statement arrives.

Some payment APIs, like Stripe, accept an idempotency key: a unique ID that tells the server "if you have seen this ID before, do not do it again." Most tools that agents call do not support this, and agents almost never send one when they could.

**Scenario.** Kola runs a food delivery app in Lagos. His refund agent sends a ₦1,500 refund to a customer, Ife, through Paystack. Paystack is slow that afternoon, so the agent's request times out after 30 seconds. The refund had actually gone through. The agent retries. Ife receives ₦3,000. This happens to 40 customers in one bad hour. Kola switches the agent off and goes back to doing refunds by hand. That is the **duplicate side effect problem** this tool exists to stop.

### B2. What Twiceshy is

Twiceshy is a checkpoint that sits between an agent and the tools it calls. Before an action that changes the world runs, Twiceshy asks one question: "Has this exact action already happened, or is it happening right now?" If yes, it does not run it again.

It ships in two forms:

1. **`twiceshy`**, an npm library. A developer wraps their own tool functions with it.
2. **`@twiceshy/mcp-proxy`**, an MCP proxy. MCP (Model Context Protocol) is the standard way agents connect to outside tools. The proxy sits in front of existing MCP servers, so a team gets protection without changing any server code. They point their agent at the proxy instead of at the servers directly.

The name comes from "once bitten, twice shy." The npm names `twiceshy` and `@twiceshy/*` were checked as free on 11 October 2026. Joseph must create a free npm organisation called `twiceshy` before the first publish to claim the scope. If he prefers another name, replace it everywhere in Phase 0 before any code is written.

### B3. Goals

1. An irreversible action with the same meaning runs at most once inside a set time window, even under retries, parallel calls, and process crashes.
2. When Twiceshy cannot tell whether an action happened, it stops and says so. It never guesses "probably failed" and lets the action run again.
3. A developer adds protection in under five minutes. A team using MCP adds it by changing one line of config.
4. Every decision Twiceshy makes is recorded and can be inspected later.
5. Every error message tells the reader what happened, why, and what to do next.

### B4. Non-goals for v1

These are out of scope on purpose. Building them now would delay the core and add risk.

- No hosted service, dashboard, or accounts. Everything runs locally.
- No undo or reversal of actions.
- No distributed store (Redis, Postgres) in v1. The storage interface must make adding them later easy.
- No automatic detection of which tool fields matter. Developers declare them, or Twiceshy falls back to safe defaults.
- No forwarding of MCP sampling or elicitation in v1. These are advanced MCP features where a server asks the client's model or user for something. They are planned for v1.1 and must fail with a clear message, not silently.

### B5. Existing work, and why Twiceshy is still worth building

Others have seen this problem. Being honest about them shapes what Twiceshy must do better.

| Tool | What it is | Gap Twiceshy fills |
|---|---|---|
| safeact-mcp | Python decorator for MCP tools, with crash-safe "in doubt" state | Python only. Twiceshy serves the TypeScript and npm world. |
| Warmplane | Rust proxy with idempotency, needs an explicit key header | Needs a key per call. Twiceshy fingerprints automatically, and installs with `npx`. |
| ONCE, Ratchet | Hosted APIs that record and suppress duplicate actions | Require a remote service, an account, and a network hop on every action. Twiceshy runs locally with zero infrastructure. |

Twiceshy's position: **the zero-setup, local-first, TypeScript-native guard that works automatically from MCP tool annotations and fingerprints, with an honest "in doubt" state.** The design ideas it shares with these tools (in-doubt states, treating unclear failures as unsafe) are good engineering, not copying. They are the correct answers to the problem.

---

## Part C. Technical specification

### C1. Stack, and why each part was chosen

| Choice | Version | Why |
|---|---|---|
| **TypeScript**, strict mode | 5.x, latest at build time | The target users install from npm. Strict types catch whole classes of bugs before tests even run. Antigravity agents write strong TypeScript. Frame-Relay already uses this stack, so Joseph's knowledge carries over. |
| **Node.js** | Supports 22 and 24 LTS. Develop on 24. | LTS means long-term support, the stable versions companies actually run. Node 22 is still widely used, so supporting it widens the audience at little cost. |
| **pnpm workspaces** | latest 10.x | One repository holds two packages. pnpm handles that well, is fast, and stops packages from secretly using dependencies they did not declare. |
| **tsup** | 8.x | Builds both module formats (ESM and CommonJS) plus type files from one config. Users on old and new setups can both import the library. |
| **Vitest** | 4.x | Fast test runner with built-in coverage, fake timers, and good TypeScript support. |
| **fast-check** | latest | Property-based testing: instead of writing ten example inputs, you describe a rule ("key order never changes the fingerprint") and the tool tries thousands of random inputs to break it. Essential for the fingerprint logic. |
| **Zod** | 4.x | Validates config files and options at runtime with clear error messages. The MCP SDK also uses Zod v4, so there is one version, not two. |
| **better-sqlite3** | 13.x, **optional** peer dependency | SQLite is a database stored in a single file. It gives atomic transactions, meaning "check and claim" happens as one step that cannot be split by another process. That property is the heart of correctness. It is optional so the core library stays dependency-free for users who only need in-memory protection. |
| **MCP TypeScript SDK v2** | `@modelcontextprotocol/client` and `@modelcontextprotocol/server`, 2.x | v2 is the current stable line and implements the 2026-07-28 MCP spec. It negotiates older protocol versions with older servers, which a proxy needs. Only the proxy package depends on it. |
| **Biome** | latest | One tool for linting (finding mistakes) and formatting (consistent style). Simpler than running ESLint and Prettier together. |
| **Changesets** | latest | Tracks version bumps and writes changelogs, so every release is documented. |
| **publint** and **@arethetypeswrong/cli** | latest | Check that the published package actually works when installed, in both module formats, with correct types. Many npm packages ship broken. These catch it before users do. |
| **GitHub Actions** | n/a | Runs every test on Windows, macOS, and Linux, on Node 22 and 24, for every change. A laptop only proves it works on one machine. |

**Why not Python or Rust:** the competitors above already cover Python and Rust. The audience Joseph can reach, and the one using MCP most heavily in coding tools, installs from npm.

**Rule for the agent on versions:** install the latest version of each dependency at build time, then read the installed package's own README and type definitions before writing code against it. Do not write MCP SDK code from memory. The v2 API differs from v1, and the agent's training may describe v1.

### C2. Core concepts

| Term | Meaning |
|---|---|
| **Action** | One call to one tool with one set of arguments. |
| **Guarded action** | An action Twiceshy protects, because it changes something outside the program. |
| **Fingerprint** | A short ID made by hashing the meaning of an action: the tool, its server, its scope, and its key arguments. Two calls with the same meaning get the same fingerprint. |
| **Explicit key** | An ID the caller supplies, such as an order number. Overrides the fingerprint as the identity of the action. |
| **Scope** | Who the action belongs to, for example one agent or one end customer. Part of the fingerprint, so two customers' actions never collide. |
| **Window** | How long after an action finishes that an identical action counts as a duplicate. Default 10 minutes. |
| **Record** | What Twiceshy stores about each guarded action: its state, timing, redacted arguments, and result. |
| **Lease** | A time limit on the claim "I am running this action now." If the process dies, the lease runs out and Twiceshy knows something went wrong. |
| **In doubt** | Twiceshy cannot tell whether the action happened. It refuses to run it again until a human decides. |
| **Definite failure** | The action certainly did not happen, for example the tool rejected invalid input. Safe to retry. |
| **Ambiguous failure** | The action may or may not have happened, for example a timeout after the request was sent. Not safe to retry. |

### C3. Which actions are guarded

Twiceshy decides per tool, using the first rule below that gives an answer:

1. **Explicit config or wrap options.** `guard: true` or `guard: false` set by the developer always wins.
2. **MCP tool annotations**, when present. MCP tools can carry hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
   - `readOnlyHint: true` → not guarded.
   - `idempotentHint: true` → not guarded by default, because the tool claims repeats are harmless. Configurable with `trustIdempotentHint` (default `true`).
   - Anything else → guarded.
3. **Default:** guarded.

**Why default to guarded:** the MCP spec says annotations are hints, not guarantees, and many servers set none. Treating an unknown tool as safe is the mistake that causes double charges. Guarding a read-only tool by mistake costs only a little storage and a short block on a repeated read, which `guard: false` fixes in one line.

**Why trust `idempotentHint` by default but allow turning it off:** a correct idempotent tool does not need protection, and blocking it would annoy developers. But tools sometimes claim this wrongly, such as an "upsert" that also sends an email every time. Teams that have been burned can turn trust off.

### C4. The fingerprint

The fingerprint is `SHA-256` of a canonical string built from:

```
v1 | serverId | toolName | scope | canonical(selectedArgs)
```

- `v1` is the fingerprint format version. If the format ever changes, old and new fingerprints can never collide.
- `serverId` is the downstream server name in the proxy, or a fixed namespace in the library (default `"local"`).
- `selectedArgs` are the arguments after field selection and normalisation, described below.

**Field selection, in order:**

1. If `keyFields` is set, use only those fields. Supports dot paths like `customer.email`.
2. Otherwise, use all arguments, minus any listed in `ignoreFields`.

**Why `keyFields` matters most:** agents often rephrase free text between retries. The first call says `reason: "Refund for missing drink"`, the retry says `reason: "Refunding the missing drink"`. If `reason` is part of the fingerprint, the two look different and the duplicate slips through. For money tools, documentation must tell developers to set `keyFields` to the fields that define the action, such as transaction, amount, and recipient. Tests must prove this case.

**Normalisers,** set per field:

- `number`: turns `"1500"`, `1500`, and `1500.0` into the same value. Rejects values that are not valid numbers with a clear error.
- `trim`: removes spaces at the start and end.
- `lowercase`: for emails and similar.
- `lowercase-trim`: both.
- A custom function, for anything else.

No normaliser runs unless the developer asks for it. Twiceshy never changes argument values silently, because changing a value can change meaning.

**Canonical JSON rules:**

- Object keys are sorted, at every depth.
- Array order is kept, because order can carry meaning.
- `undefined` values and missing keys are treated the same and dropped.
- `NaN`, `Infinity`, functions, symbols, and circular references are rejected with `NOT_SERIALIZABLE`.
- `BigInt` and `Date` are converted to tagged strings so they cannot collide with plain strings that happen to look the same.
- Strings are compared exactly, including Unicode. Unicode normalisation is available only through the `trim` family of normalisers, not by default.

**Explicit keys:** if the caller supplies an explicit key, it becomes the action's identity. Twiceshy still computes the fingerprint and stores it. If the same explicit key arrives later with a different fingerprint, Twiceshy rejects it with `KEY_CONFLICT`. Stripe behaves the same way, because reusing a key for a different action is almost always a bug.

### C5. Record states

Every guarded action has one record. Its state is one of:

| State | Meaning |
|---|---|
| `IN_FLIGHT` | Claimed and running. Has a lease. |
| `SUCCEEDED` | Finished, result stored. |
| `FAILED_DEFINITE` | Failed in a way that certainly had no effect. |
| `IN_DOUBT` | May or may not have happened. Needs a human. |
| `RESOLVED_SUCCEEDED` | A human confirmed it happened. Acts like `SUCCEEDED`. |
| `RESOLVED_FAILED` | A human confirmed it did not happen. Acts like `FAILED_DEFINITE`. |

### C6. The decision table

When a guarded call arrives, Twiceshy reads the existing record for its identity, if any, and decides. **This read-and-claim must be atomic.** Two calls arriving at the same moment must never both see "no record" and both run.

| Existing record | Condition | Decision | What the caller gets |
|---|---|---|---|
| None | n/a | **Execute.** Create `IN_FLIGHT` record with lease. | The real result. |
| `SUCCEEDED` or `RESOLVED_SUCCEEDED` | Inside window | **Duplicate.** Do not execute. | The stored original result, marked as a duplicate. |
| `SUCCEEDED` or `RESOLVED_SUCCEEDED` | Window passed | **Execute** as a new action. Archive the old record. | The real result. |
| `IN_FLIGHT` | Lease still valid | **Wait** up to `waitForInFlightMs` (default 5 s) for it to finish. If it finishes, follow the row for its new state. If not, return `IN_PROGRESS`. | The other call's result, or an `IN_PROGRESS` error. |
| `IN_FLIGHT` | Lease expired | Mark record `IN_DOUBT`, then **block**. | `IN_DOUBT` error. |
| `FAILED_DEFINITE` or `RESOLVED_FAILED` | Any | **Execute** again. Increment attempt count. | The real result. |
| `IN_DOUBT` | Any | **Block.** | `IN_DOUBT` error. |

**After execution:**

- The tool returned normally → `SUCCEEDED`, store the result.
- The tool threw or returned an error → classify it (C7). Definite → `FAILED_DEFINITE`. Ambiguous → `IN_DOUBT`.
- The caller cancelled the call while it was running → `IN_DOUBT`, because the tool may already have acted.
- A result arrives **after** Twiceshy marked the record `IN_DOUBT`, because of a timeout or because another process saw the lease expire → upgrade to `SUCCEEDED` or `FAILED_DEFINITE` and emit a `late-completion` event. This turns many in-doubt cases into clean answers without a human.
- When an action finishes, the guard re-reads its record. If the record is still `IN_FLIGHT` and still owned by this call, it applies the normal after-execution rules. If anything else changed it, it must use the late-completion path. It must never overwrite a state set by another process or by a human.

**Edge rules decided during Phase 1:**

- A `SUCCEEDED` record with no completion time counts as inside the window. Blocking is the safe direction. Stores must make this impossible in practice: `complete()` always sets `completedAt`, and the store contract suite tests it.
- Repeat grants are checked after the window. If the window has passed, the action runs as a new action and any unused grant is cleared. Inside the window, a grant allows one execution and is then consumed.
- A record in a state the engine does not recognise throws `STORE_UNAVAILABLE`, not a plain error. Its `why` explains that the database may be corrupted or written by a newer Twiceshy version. Its `fix` says to upgrade, or to inspect the record with `twiceshy show`.

**Lease:** default lease is `timeoutMs + 30 s`. While the action runs, Twiceshy renews the lease every `leaseMs / 3`. A crashed process stops renewing, so its lease expires.

**Scenario.** Ada's booking agent calls `book_slot` twice in parallel by mistake, both for Saturday at 3 pm. The first call claims the record and starts. The second sees `IN_FLIGHT` with a valid lease, so it waits. Two seconds later the first call succeeds. The second call receives the same booking confirmation, marked as a duplicate. Ada's salon has one booking, not two. That is **atomic claiming plus in-flight waiting**.

### C7. Classifying failures

The default classifier is `classifyError(error, options) → { classification: 'definite' | 'ambiguous', warning?: string }`. It returns an object, not a bare value, so it can report a misbehaving custom classifier through `warning` without ever throwing.

**Definite:**
- Zod validation errors, detected by `instanceof` or by the error name `ZodError` (to handle duplicate Zod copies). Other validation libraries are not detected by name, because generic names like `ValidationError` collide with unrelated libraries. Mark those errors with `definiteFailure` or use a custom classifier.
- MCP protocol errors for unknown tool or invalid params (JSON-RPC error codes `-32601` and `-32602`).
- HTTP errors that carry status 400, 401, 403, 404, 409, 422. The status is read from `status`, `statusCode`, or `response.status`, as a number or a three-digit string.
- Errors marked by the developer with `definiteFailure(error)`, a helper the library exports.

**Ambiguous, everything else, including:**
- Timeouts of any kind.
- `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `socket hang up`.
- HTTP 5xx and 429.
- MCP tool results with `isError: true` whose content Twiceshy cannot interpret.
- Unknown errors.

**Why unknown means ambiguous:** a wrong "definite" answer allows a duplicate charge. A wrong "ambiguous" answer causes one blocked action that a human clears in a minute. The second mistake is far cheaper, so the default leans that way. Developers can pass their own classifier for tools whose errors they understand.

**MCP `isError: true` results:** when a downstream MCP tool returns a result with `isError: true`, the tool ran and reported failure. Many such tools fail before doing anything, but Twiceshy cannot know. Default: ambiguous. Config option `treatToolErrorsAsDefinite` (per server or per tool) lets teams opt in once they know their server's behaviour. `classifyToolResult` returns `null` when `isError` is not `true`, because there is nothing to classify, and returns `'ambiguous'` if reading the result throws.

### C8. What callers receive

**Library, `guard.run()`,** returns an outcome object:

```ts
type Outcome<T> =
  | { status: 'executed';  value: T; record: ActionRecord }
  | { status: 'duplicate'; value: T; record: ActionRecord; originalAt: Date };
```

**Library, wrapped functions,** return `T` directly and throw `TwiceshyError` subclasses for blocks. Developers who need to know about duplicates use `onDuplicate` hooks or `guard.run()`.

**Proxy, duplicate:** returns the original `CallToolResult` unchanged, plus metadata under `_meta["dev.twiceshy/outcome"]`. When `annotateDuplicates` is `true` (default), it also adds one text content block at the start:

> Twiceshy: this action already ran at 14:02:11 UTC and was not repeated. The original result follows. If the user really wants it done again, ask them to confirm, then tell them a person must approve the repeat.

**Why add text:** many agents ignore `_meta`. Without visible text, the agent might think the retry worked fresh and report the action twice to the user.

**Proxy, blocked:** returns a `CallToolResult` with `isError: true`, not a protocol error. MCP clients show tool-result errors to the model, so the agent can read and act on them. Protocol errors are often hidden or crash the client.

### C9. Error design

Every error Twiceshy produces is a subclass of `TwiceshyError` with these fields:

```ts
class TwiceshyError extends Error {
  code: ErrorCode;      // stable, machine-readable
  what: string;         // what happened, one sentence
  why: string;          // why it happened
  fix: string;          // what to do next
  fingerprint?: string;
  recordId?: string;
  cause?: unknown;      // original error, when there is one
}
```

`message` is `what`, `why`, and `fix` joined. `toJSON()` returns all fields without the stack trace, safe to log or send to an agent.

| Code | When | Default `fix` text, in substance |
|---|---|---|
| `IN_DOUBT` | Record is in doubt | A person must check whether the action happened, then run `twiceshy resolve <id> --succeeded` or `--failed`. Do not retry. |
| `IN_PROGRESS` | Same action still running after the wait | Wait and call again. The first call may still complete. |
| `KEY_CONFLICT` | Explicit key reused with different arguments | Use a new key for a new action. |
| `NOT_SERIALIZABLE` | Arguments or result cannot be stored | Remove functions, circular data, `NaN`, or `Infinity`, or set `storeResult: false`. |
| `STORE_UNAVAILABLE` | Database cannot be read or written | Check the file path and permissions. Guarded actions are paused for safety. |
| `CONFIG_INVALID` | Config or options fail validation | Lists every invalid field with the expected type and an example. |
| `RESULT_TOO_LARGE` | Result above `maxResultBytes` (default 256 KB) | Raise the limit or set `storeResult: false`. Duplicates will then return a summary, not the full result. |
| `DOWNSTREAM_UNAVAILABLE` | Proxy cannot reach a downstream server | Check the server command or URL in config. |
| `UNSUPPORTED_FEATURE` | A v1.1 feature, such as sampling, was requested | Names the feature and says it is planned. |

**Rules for all error handling in the codebase:**

1. No empty `catch` blocks. Every catch either handles the error fully, adds context and rethrows, or converts it to a `TwiceshyError` with `cause` set.
2. Never swallow an error from the user's own tool. It must reach the caller, unchanged, after Twiceshy records the outcome.
3. Recording the outcome must not hide the tool's result. If the tool succeeded but saving the record failed, return the tool's result and emit a `store-write-failed` event loudly. Losing a record is bad. Hiding a real result and making the agent retry is worse.
4. All async work is awaited or deliberately handled. Biome must flag floating promises.
5. Errors never contain raw secret values (C12).

### C10. Failure of Twiceshy itself

When the store cannot be reached, behaviour depends on `onStoreFailure`:

- `'closed'` (default): guarded actions are refused with `STORE_UNAVAILABLE`. Unguarded actions still run.
- `'open'`: guarded actions run unprotected and a `guard-bypassed` event fires for each one.

**Why closed is the default:** a tool whose job is to prevent double payments must not quietly stop doing its job. Teams who value uptime over safety can choose open, knowingly.

### C11. Library API

```ts
import { createGuard, MemoryStore, definiteFailure } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

const guard = createGuard({
  store: new SqliteStore({ path: './.twiceshy/actions.db' }),
  namespace: 'kola-delivery',        // becomes serverId in fingerprints
  window: '10m',                     // number of ms, or a string: '30s', '10m', '2h'
  onStoreFailure: 'closed',
  waitForInFlightMs: 5_000,
  redact: ['card.number', 'pin', 'otp', 'authorization'],
  classifyError: undefined,          // use default classifier
  hooks: {
    onExecute(e) {},
    onDuplicate(e) {},
    onBlocked(e) {},
    onInDoubt(e) {},
    onLateCompletion(e) {},
    onStoreWriteFailed(e) {},
  },
  clock: undefined,                  // injectable for tests
});

// Wrap a function
const refund = guard.wrap('paystack.refund', paystackRefund, {
  keyFields: ['transaction', 'amount'],
  normalize: { amount: 'number' },
  scope: (args) => args.customerId,
  timeoutMs: 30_000,
});
await refund({ transaction: 'T123', amount: 1500, customerId: 'ife', reason: 'missing drink' });

// Or run once, with full outcome
const outcome = await guard.run(
  { tool: 'paystack.refund', args, key: `refund-order-${orderId}` },
  () => paystackRefund(args),
);

// Inspection and resolution
await guard.list({ state: 'IN_DOUBT' });
await guard.get(recordId);
await guard.resolve(recordId, { as: 'succeeded', note: 'Checked Paystack dashboard', by: 'kola' });
await guard.allowRepeat(fingerprint, { by: 'kola', note: 'Customer asked for a second refund' });
await guard.close();
```

**API rules:**

- `createGuard` validates all options with Zod and throws `CONFIG_INVALID` listing every problem at once, not just the first.
- `wrap` keeps the original function's TypeScript types. Hovering the wrapped function in an editor shows the same parameters and return type.
- Both ESM (`import`) and CommonJS (`require`) work.
- The core entry point, `twiceshy`, has **zero runtime dependencies** except Zod. SQLite lives at `twiceshy/sqlite` so users who do not need it never install it.
- `allowRepeat` grants one future execution of a fingerprint inside the window. It is how a human approves a genuine repeat, such as a second, intentional ₦1,500 transfer. Agents cannot call it through the proxy.

**Why agents cannot approve their own repeats:** if an agent could pass a flag saying "repeat anyway," a confused agent would learn to pass it every time and the guard would protect nothing. The approval has to come from outside the agent.

### C12. Storage

**Store interface,** every store implements:

```ts
interface ActionStore {
  begin(input: BeginInput): Promise<BeginResult>;   // atomic read-decide-claim
  renewLease(id: string, until: Date): Promise<void>;
  complete(id: string, outcome: CompleteInput): Promise<void>;
  get(id: string): Promise<ActionRecord | null>;
  findByIdentity(identity: string): Promise<ActionRecord | null>;
  list(filter: ListFilter): Promise<ActionRecord[]>;
  resolve(id: string, resolution: Resolution): Promise<void>;
  grantRepeat(fingerprint: string, grant: RepeatGrant): Promise<void>;
  purge(olderThan: Date): Promise<number>;
  close(): Promise<void>;
}
```

`begin` carries the whole decision table from C6 inside one atomic operation. The engine does not read first and write later, because the gap between the two is exactly where duplicates slip in.

**MemoryStore:** for single-process use and tests. Atomicity comes from doing the whole decision synchronously, with no `await` between reading and claiming. Data is lost on restart, and the README must say so plainly.

**SqliteStore:** for real use on one machine, including several processes sharing one file.

- WAL mode on, `busy_timeout` 5 s, so processes wait briefly for each other instead of failing.
- `begin` runs inside `BEGIN IMMEDIATE` transactions, which lock for writing at the start, so two processes cannot both claim.
- Schema has a version table. Migrations run on open, in a transaction, and never delete data.
- The file and its folder are created if missing, with a clear error if the location is not writable.

**Retention:** records stay for `retention` (default 7 days) after the window ends, for audit. `purge` removes older ones. It runs automatically at most once an hour, never during a guarded call's critical path.

**Window versus retention:** the window decides what counts as a duplicate. Retention decides how long the history is kept. They are separate settings, and the docs must explain the difference with an example.

**Privacy and redaction:**

- Arguments are stored only after redaction. Fields listed in `redact` are replaced with `"[redacted]"` before anything touches disk.
- Default redact list, always applied: `password`, `pin`, `otp`, `cvv`, `cvc`, `secret`, `token`, `apiKey`, `api_key`, `authorization`, `card.number`, `cardNumber`. Matching is case-insensitive, at any depth.
- Fingerprints are computed from real values before redaction, so redaction never makes two different actions look the same.
- A test must write a record containing a fake card number and PIN, then read the raw database file bytes and prove neither string appears anywhere.

### C13. MCP proxy

**What it does:** the proxy is an MCP server to the agent's client, and an MCP client to one or more downstream servers. It forwards everything, and guards tool calls.

**Config file, `twiceshy.config.json`:**

```json
{
  "$schema": "https://unpkg.com/@twiceshy/mcp-proxy/schema.json",
  "store": { "type": "sqlite", "path": "~/.twiceshy/actions.db" },
  "window": "10m",
  "onStoreFailure": "closed",
  "toolNaming": "prefix",
  "mcpServers": {
    "paystack": {
      "command": "npx",
      "args": ["-y", "paystack-mcp"],
      "env": { "PAYSTACK_SECRET_KEY": "${PAYSTACK_SECRET_KEY}" },
      "tools": {
        "create_refund": {
          "guard": true,
          "keyFields": ["transaction", "amount"],
          "normalize": { "amount": "number" }
        },
        "list_transactions": { "guard": false }
      }
    },
    "calendar": { "url": "https://example.com/mcp" }
  }
}
```

**Why `mcpServers` matches the common client format:** developers can copy their existing server entries from their agent's config straight into this file. Lower effort means more installs.

- `${VAR}` reads environment variables. Secrets never need to sit in the file. A missing variable is a `CONFIG_INVALID` error naming it.
- `~` expands to the home folder on every operating system.
- Downstream servers connect by `command` (stdio, a local process) or `url` (Streamable HTTP, a remote server).

**Client setup after install,** the one-line change:

```json
{
  "mcpServers": {
    "twiceshy": {
      "command": "npx",
      "args": ["-y", "@twiceshy/mcp-proxy", "--config", "/path/to/twiceshy.config.json"]
    }
  }
}
```

**Tool naming:** with several downstream servers, two may have tools with the same name. `toolNaming`:

- `"prefix"` (default): tools appear as `paystack__create_refund`.
- `"none"`: names pass through unchanged. If two collide, startup fails with a `CONFIG_INVALID` error naming both.

**What passes through:**

| MCP feature | v1 behaviour |
|---|---|
| `tools/list` | Merged from all servers. Annotations preserved unchanged. Pagination handled. |
| `tools/call` | Guarded per C3. Unguarded calls forwarded directly. |
| `resources/*`, `prompts/*` | Forwarded, prefixed the same way as tools. |
| `notifications/tools/list_changed` | Re-reads that server's tools and re-sends the merged notification. |
| Progress notifications | Forwarded with the correct progress token mapping. |
| Cancellation | Forwarded downstream. A cancelled guarded call becomes `IN_DOUBT` unless a result arrives. |
| Logging | Forwarded. |
| Sampling, elicitation | Not forwarded in v1. Returns `UNSUPPORTED_FEATURE` with a clear message. |

**Startup and failure behaviour:**

- If one downstream server fails to start, the proxy still starts with the others, logs the failure to stderr, and lists that server's absence in `twiceshy_status`. One broken server must not take down every tool.
- If a downstream server crashes later, calls to it return `DOWNSTREAM_UNAVAILABLE`. A guarded call in progress at crash time becomes `IN_DOUBT`. The proxy restarts the server with backoff: 1 s, 2 s, 4 s, up to 30 s, five attempts, then gives up and reports it.
- On shutdown (SIGINT, SIGTERM, or the client disconnecting), the proxy stops accepting calls, waits up to 10 s for in-flight calls, closes downstream connections, closes the store, and exits. Calls still running at the deadline are left `IN_FLIGHT` and become `IN_DOUBT` when their lease expires, which is the honest outcome.

**The stdout rule.** In stdio mode, stdout carries only MCP messages. One stray `console.log` corrupts the stream and breaks the client in confusing ways. All logging goes to stderr. Biome must ban `console.log` in the proxy package, and a test must run the proxy and confirm every line on stdout is valid JSON-RPC.

**Proxy's own tools:**

- `twiceshy_status`: read-only. Shows which servers are connected, how many tools are guarded, and how many records are in doubt.
- `twiceshy_recent_actions`: read-only, off by default. Lists recent guarded actions with redacted arguments, so an agent can check "did I already do this?" before trying.

Both carry `readOnlyHint: true`. The proxy exposes no tool that resolves, deletes, or approves anything. Those are human-only, through the CLI.

### C14. CLI

The proxy package ships one command, `twiceshy`:

| Command | Purpose |
|---|---|
| `twiceshy proxy --config <file>` | Run the proxy. This is what the agent's client launches. Running `@twiceshy/mcp-proxy` with no subcommand means `proxy`. |
| `twiceshy doctor --config <file>` | Check the config, start each downstream server, list its tools and whether each is guarded and why, then exit. The first thing to run when something is wrong. |
| `twiceshy list [--state IN_DOUBT] [--since 1h]` | Show records in a readable table. |
| `twiceshy show <id>` | Full detail of one record. |
| `twiceshy resolve <id> --succeeded \| --failed [--note "..."]` | A human settles an in-doubt record. |
| `twiceshy allow <fingerprint> [--note "..."]` | A human approves one repeat of an action inside its window. |
| `twiceshy purge [--older-than 30d]` | Remove old records. Asks for confirmation unless `--yes`. |

Every command supports `--json` for scripts, `--help` with an example, and exits with code 0 on success, 1 on error, 2 on bad usage. Errors print `what`, `why`, and `fix` on separate lines.

**`doctor` output must be readable by a beginner,** for example:

```
paystack      connected   4 tools
  create_refund       GUARDED    (config: guard true)
  list_transactions   open       (config: guard false)
  get_balance         open       (annotation: readOnlyHint)
  verify_payment      GUARDED    (no annotation, default)
calendar      FAILED      Could not connect to https://example.com/mcp
              Why: connection refused
              Fix: check the URL, or remove this server from the config
```

### C15. Observability

- Each decision emits one structured event: `{ type, at, recordId, fingerprint, tool, server, scope, durationMs, attempt }`.
- Hooks receive these events. Exceptions thrown inside hooks are caught and logged to stderr, never allowed to break the guarded call.
- The proxy writes events as JSON lines to stderr when `--log-level` is `info` or lower. Default is `warn`, which logs only blocks, in-doubt records, and failures.

### C16. Repository layout

```
twiceshy/
  SPEC.md
  README.md
  LICENSE                      MIT
  CITATION.cff
  package.json                 workspace root, scripts only
  pnpm-workspace.yaml
  biome.json
  tsconfig.base.json
  vitest.workspace.ts
  .changeset/
  .github/workflows/ci.yml
  packages/
    core/                      published as "twiceshy"
      src/
        index.ts
        guard.ts               createGuard, wrap, run
        engine.ts              decision logic from C6, pure functions
        fingerprint.ts         canonical JSON, selection, normalisers, hashing
        classify.ts            error classification
        redact.ts
        errors.ts              TwiceshyError and subclasses
        duration.ts            '10m' parsing
        stores/
          memory.ts
          sqlite.ts            exported at "twiceshy/sqlite"
          contract.ts          shared store test suite, exported for adapters
      test/
    mcp-proxy/                 published as "@twiceshy/mcp-proxy"
      src/
        cli.ts
        config.ts              Zod schema, env and ~ expansion
        proxy.ts
        downstream.ts          connect, restart, list tools
        naming.ts
        tools/status.ts
      schema.json              generated from the Zod schema
      test/
        fixtures/              fake MCP servers used in tests
  examples/
    library-paystack-refund/
    proxy-claude-config/
```

**Why `engine.ts` holds pure functions:** the decision table is the most important logic in the project. Pure functions, which take inputs and return outputs with no database, clock, or network inside them, can be tested exhaustively and quickly. Stores then call the engine inside their transactions.

### C17. Testing strategy

Testing is the main work of this project, not a final step. A guard that has not been proven under stress is worse than no guard, because people trust it.

**Coverage targets, enforced in CI:**

- `engine.ts`, `fingerprint.ts`, `classify.ts`, `redact.ts`: 100% of lines and branches.
- Whole repository: at least 90% of lines and branches.

**Why coverage alone is not enough:** coverage proves a line ran during tests, not that the test checked the right thing. The required tests below are what actually matter. Phase 6 adds mutation testing, which deliberately breaks the code in small ways and checks that some test fails each time.

**Test layers:**

1. **Unit tests:** each module alone.
2. **Property tests** with fast-check, for rules that must hold for every input.
3. **Store contract tests:** one shared suite in `stores/contract.ts`, run against every store. Any future Redis or Postgres store must pass the same suite.
4. **Concurrency and crash tests:** real parallel calls and real killed processes.
5. **Proxy integration tests:** real MCP clients and fake MCP servers, connected by in-memory transport and by real stdio processes.
6. **End-to-end story tests:** the scenarios from this document, run as tests.

**Required tests.** Each one is mandatory. Test names should read as plain sentences.

*Fingerprint*
- F1. Changing key order at any depth never changes the fingerprint. (property)
- F2. Changing any value in a selected field always changes the fingerprint. (property)
- F3. Changing a field outside `keyFields` never changes the fingerprint.
- F4. With `normalize: { amount: 'number' }`, `"1500"`, `1500`, and `1500.0` give one fingerprint. `"1,500"` and `"abc"` are rejected with a clear error.
- F5. The string `"2026-01-01T00:00:00.000Z"` and a `Date` of the same moment give different fingerprints.
- F6. Circular references, `NaN`, `Infinity`, and functions throw `NOT_SERIALIZABLE`, and the error names the field path.
- F7. Same arguments, different tool or server or scope, give different fingerprints.
- F8. A rephrased `reason` field with `keyFields` set still produces a duplicate (the Kola case).
- F9. Fingerprints are identical across Node 22 and 24 and across operating systems. A fixed set of golden fingerprints is stored in the repo and checked in CI.

*Classification (C3) and errors (C7, C9)*
- C1. Every row of the classification rules in C3 has a test, including conflicts, for example config `guard: false` beating `destructiveHint: true`.
- C2. Every error category in C7 maps as specified, with one test per listed error code or status.
- C3. Unknown error shapes, including thrown strings, `null`, and plain objects, classify as ambiguous without crashing.
- C4. Every `TwiceshyError` code has non-empty `what`, `why`, and `fix`, and `toJSON()` output contains no stack trace.
- C5. A tool's own error reaches the caller as the same object, not a wrapped copy, after the outcome is recorded.

*Decision table (C6)*
- D1. One table-driven test with a row for every existing-state and condition combination in C6, checking decision, final state, and whether the tool function ran.
- D2. Window boundaries: one millisecond before the window ends is a duplicate. Exactly at and after the end, it executes. (fake clock)
- D3. In-flight wait: the second call returns the first call's result when the first finishes inside the wait, and `IN_PROGRESS` when it does not.
- D4. Lease expiry turns `IN_FLIGHT` into `IN_DOUBT`, and the lease renews while a long action runs, so a slow but alive action is never marked in doubt.
- D5. Late completion upgrades `IN_DOUBT` to `SUCCEEDED` and emits the event.
- D6. `resolve` as succeeded makes the next identical call a duplicate. `resolve` as failed lets it execute.
- D7. `allowRepeat` allows exactly one extra execution, then duplicates are blocked again.
- D8. Explicit key reused with different arguments throws `KEY_CONFLICT`. Reused with the same arguments returns a duplicate.
- D9. Cancellation during execution leaves the record `IN_DOUBT`.

*Concurrency and crashes*
- X1. 100 identical calls started at once on MemoryStore: the tool runs exactly once, and all 100 callers receive the same result.
- X2. The same with SqliteStore across 4 separate child processes sharing one database file: exactly one execution in total.
- X3. A child process is killed (`SIGKILL`) in the middle of a guarded action. After the lease expires, a new process sees `IN_DOUBT` and refuses to run the action.
- X4. 1,000 different actions in parallel all execute, with no false duplicates.

*Store and storage*
- S1. The full contract suite passes on MemoryStore and SqliteStore.
- S2. SqliteStore creates missing folders, and gives `STORE_UNAVAILABLE` with the path in the message when the location is not writable.
- S3. A database made by an older schema version migrates on open without data loss. (Write a v0 fixture database to prove this from the first release.)
- S4. With `onStoreFailure: 'closed'`, a broken store refuses guarded calls and still allows unguarded ones. With `'open'`, guarded calls run and `guard-bypassed` fires.
- S5. Tool succeeds but record write fails: the caller still gets the tool's result, and `store-write-failed` fires.
- S6. Redaction: the raw bytes of the database file contain neither a test card number nor a test PIN, at any nesting depth, in any letter case of the field name.
- S7. `purge` removes only records past retention and never removes `IN_DOUBT` records that are unresolved.
- S8. Results above `maxResultBytes` follow the documented behaviour.

*Proxy*
- P1. `tools/list` merges two fake servers, prefixes names, keeps annotations exactly, and handles a server that paginates.
- P2. A guarded call to a fake "counter" server, retried three times, increments the counter once. The retries return the original result with the duplicate note and `_meta`.
- P3. A fake "slow payment" server that commits the charge and then delays its reply past the timeout: the call becomes `IN_DOUBT`, the retry is blocked, and the counter shows one charge. This is the Kola scenario.
- P4. Unguarded and read-only tools forward untouched, with no record created.
- P5. A downstream server that fails at startup does not stop the proxy. `twiceshy_status` reports it.
- P6. A downstream crash mid-call leaves the record `IN_DOUBT`, and the restart backoff follows the documented schedule. (fake timers)
- P7. Progress notifications and cancellation pass through correctly.
- P8. Sampling and elicitation requests return `UNSUPPORTED_FEATURE`.
- P9. stdout purity: run the real proxy binary over stdio through a full session. Every stdout line parses as JSON-RPC.
- P10. Config errors: missing env var, name collision with `toolNaming: "none"`, unknown fields, and bad window strings each produce `CONFIG_INVALID` with every problem listed.
- P11. Graceful shutdown on SIGTERM waits for in-flight calls and exits with code 0.
- P12. No exposed proxy tool can resolve, delete, or approve records.

*CLI*
- L1. Each command's `--help`, success path, `--json` output, and exit codes.
- L2. `doctor` output matches a snapshot for a fixture config with one working and one broken server.
- L3. `purge` without `--yes` does nothing when the confirmation is not given.

*Packaging*
- K1. publint and arethetypeswrong pass for both packages.
- K2. A fresh temporary project installs the packed tarballs and successfully imports with both `import` and `require`, and runs `npx twiceshy --help`.
- K3. The core package's runtime dependency list contains only Zod.

**Test rules:**

- No test depends on real time. Use the injectable clock and Vitest fake timers. Tests that need real parallel processes use short leases, never long sleeps.
- No test touches the network. Fake MCP servers live in `test/fixtures`.
- Every test that creates files uses a fresh temporary folder and deletes it afterwards.
- The whole suite runs in under 60 seconds on a normal laptop, except the stress tests, which have their own script.
- A flaky test, one that sometimes passes and sometimes fails, counts as a failing test. Fix the cause. Never add retries to a test to hide flakiness.

### C18. Quality gates

A phase is done only when all of these pass:

```
pnpm install --frozen-lockfile
pnpm typecheck        # tsc --noEmit, zero errors
pnpm lint             # biome check, zero errors, zero warnings
pnpm test             # all tests pass, coverage targets met
pnpm build
pnpm check:package    # publint + arethetypeswrong (from Phase 5)
```

TypeScript settings must include `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `noFallthroughCasesInSwitch`. `any` is banned. Use `unknown` and narrow it.

### C19. Documentation required for v1.0

- **README** for each package. Opens with one sentence on what it does, then the Kola scenario in four lines, then a 30-second install example.
- **"Choosing keyFields"** guide, with examples for refunds, transfers, messages, and bookings. This is the most important page for real safety.
- **"What in doubt means and what to do"**, written for a non-developer business owner.
- **Window versus retention**, with an example.
- **Limits**, stated plainly: single machine only in v1, no sampling or elicitation forwarding, annotations are hints, MemoryStore loses data on restart.
- **Error reference**, one entry per code.
- `CITATION.cff` so the repo can be cited, matching Joseph's Zenodo plan.

### C20. Amendments after the Phase 6.2 compliance review

These rules were decided after the first compliance review. Where they conflict with earlier sections, these win.

**Correctness**

1. **Conditional completion.** `complete()` writes only when the record is still `IN_FLIGHT` and still belongs to the same attempt that claimed it. Each claim gets an attempt token, and the store checks it inside the same atomic operation. If the condition fails, `complete()` writes nothing and reports that the record changed, and the guard follows the late-completion rules below. This holds even when the guard's own re-read of the record failed.
2. **Late result against another process.** If another process marked the record `IN_DOUBT`, the late result upgrades it through `lateCompletion`.
3. **Late result against a human decision.** Twiceshy never overwrites a human resolution. If the late result agrees with it, nothing changes. If it contradicts it, Twiceshy emits a `resolution-conflict` event at error level, logged even at the default level. If the human said "failed" but the action actually succeeded, the record must block the next identical call with `IN_DOUBT` until a human resolves it again. A contradiction that could allow a duplicate must never pass silently.
4. **Cancelled before start.** If a call is cancelled after the claim but before the tool function was invoked, the guard knows the action did not happen. It records `FAILED_DEFINITE` with reason "cancelled before start", not `IN_DOUBT`. A cancellation after invocation still becomes `IN_DOUBT`.

**Secrets**

5. **Logs never contain raw downstream error text by default.** At `warn` and `info` levels, events log the error's class name, Twiceshy error code, and classification only. The full message appears only at `debug`, and the docs warn that debug logs may contain text from downstream servers.
6. **Results are redacted before storage** with the same field rules as arguments. Duplicate results returned to callers come from the stored, redacted copy, and `_meta["dev.twiceshy/outcome"]` includes `resultRedacted: true` when any field was replaced. `storeResult: false` stores no result at all, and a duplicate then returns a short text summary saying the action already ran. Field-name redaction cannot find secrets inside free text. `docs/limits.md` must say so.
7. **Known secret values are masked in diagnostics.** Any environment variable value that Twiceshy resolved from `${VAR}` in config is replaced with `[redacted]` wherever downstream stderr is printed, including in `doctor`. Values shorter than 6 characters are not masked, to avoid hiding ordinary text.
8. **`errorSummary` is filled in** by Twiceshy with a safe description: the error class name, Twiceshy code, classification, and one of these reasons: timeout after N ms, cancelled, downstream crashed, or ambiguous error. It never contains the raw error message. `twiceshy show` displays it.

**Error handling**

9. **C9 rule 1 exception.** A catch may swallow an error only when there is nowhere left to report it, for example a failed write to stderr, or a cleanup failure while the original error is already being rethrown. Each such catch must carry a comment starting `// last resort:` explaining why. Every other failure must be logged at `warn` or higher, or returned as an error.
10. A failure to list a downstream server's resources or prompts is logged at `warn` and shown in `twiceshy_status` and `doctor`. It never looks like an empty list.

**Spec catches up with the code**

11. `GuardOutcome.originalAt` may be `null` when the stored record has no completion time (see the C6 edge rules).
12. The CLI `resolve` and `allow` commands require `--by <name>`. Every command accepts `--config`, `--json`, and `--log-level`. The proxy package also installs a `mcp-proxy` bin alias.
13. Additional guard options: `purge()`, `maxResultBytes`, `timeoutMs`, `leaseMs`, `closeTimeoutMs`, `closeStore`, and the hooks `onGuardBypassed`, `onWarning`, `onResolutionConflict`.
14. Additional proxy config: `cwd` for stdio servers, per-tool `ignoreFields`, `timeoutMs`, `storeResult`, top-level `retention`, `exposeRecentActions`, and `store.type: "memory"`.
15. Repository layout: proxy tools may live in `proxy.ts`. The extra modules `logger.ts`, `restart.ts`, `version.ts`, `stores/record.ts`, `stores/types.ts`, the `scripts/` folder, the extra Vitest configs, `stryker.config.json`, `NOTES.md`, and `SPEC-COMPLIANCE.md` are accepted.
16. Stryker is part of the dev toolchain for mutation testing (C1).

---

## Part D. Build phases

Each phase ends with every quality gate in C18 passing. Do them in order.

### Kickoff prompt

**[PROMPT]** Paste this first:

> Read SPEC.md in full before doing anything. It is the single source of truth for this project. Then do three things and stop. First, list every point in the spec that is unclear, contradicts itself, or that you believe is wrong, with your reason. Second, check the latest published versions of every dependency in section C1 using npm, and read the README and type definitions of `@modelcontextprotocol/client` and `@modelcontextprotocol/server` version 2. Report any place where the real SDK API differs from what the spec assumes. Third, write a short plan for Phase 0 only. Do not write any project code yet. Follow every rule in Part E for the whole project.

**[REVIEW]** Read the agent's list of unclear points. If it found real problems, bring them back to this chat and they will be fixed in the spec before building. Do not let the agent quietly decide spec questions on its own.

### Phase 0: Repository skeleton

**Goal:** an empty but fully working project where every quality gate runs.

**[HAND]** Before starting:
1. Check Node is installed: open a terminal and run `node --version`. You should see `v24` followed by numbers. If not, install Node 24 LTS from nodejs.org.
2. Install pnpm: run `npm install -g pnpm`, then `pnpm --version` to confirm.
3. Create a free npm organisation called `twiceshy` at npmjs.com, under your account's "Add Organization" option. Do this now so nobody takes the name.
4. Create an empty public GitHub repository called `twiceshy`.

**[PROMPT]**

> Implement Phase 0 from SPEC.md Part D: create the repository layout from section C16 with both packages, pnpm workspaces, strict TypeScript settings from C18, Biome, Vitest with coverage thresholds from C17, tsup builds for ESM and CommonJS, Changesets, the GitHub Actions workflow running on ubuntu, windows, and macos with Node 22 and 24, the MIT licence, and CITATION.cff. Add one placeholder test per package so every gate in C18 runs and passes. Add root scripts for typecheck, lint, test, test:stress, build, and check:package. Then run every gate and show me the output.

**[REVIEW]** **[HAND]** In the terminal, inside the project folder, run each command one at a time:

```
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Each must finish without the word "error" in red. Push to GitHub, open the "Actions" tab, and check all six jobs show a green tick.

### Phase 1: Fingerprints, errors, and pure decision logic

**Goal:** the brain of the tool, with no database yet.

**[PROMPT]**

> Implement Phase 1 from SPEC.md: errors.ts per C9, duration.ts, fingerprint.ts per C4, classify.ts per C7, redact.ts per C12, and engine.ts as pure functions implementing the full decision table in C6. Write tests first for each module, then the code. Include every required test from C17 in the groups Fingerprint (F1 to F9), Classification and errors (C1 to C5), and the engine-level parts of D1, D2, D4, D5, and D8 using pure inputs and a fake clock. Meet the 100% coverage target for these modules. Run all gates and show me the coverage report.

**[REVIEW]** **[HAND]** Run `pnpm test`. At the end you will see a coverage table. Find the rows for `engine.ts`, `fingerprint.ts`, `classify.ts`, and `redact.ts`. Every number in those rows must be 100. Then open `test` and read three test names out loud. Each should read as a clear sentence describing behaviour. If a name is vague, ask the agent to rename it.

### Phase 2: Stores and the guard

**Goal:** a working library you could use today.

**[PROMPT]**

> Implement Phase 2 from SPEC.md: the store interface and shared contract suite from C12, MemoryStore, SqliteStore with WAL, BEGIN IMMEDIATE, schema versioning and migrations, retention and purge, and createGuard with wrap, run, list, get, resolve, allowRepeat, close, and hooks per C11. Implement store-failure behaviour per C10 and the error rules in C9. Write and pass every remaining required test in groups D, X, and S from C17, including the real multi-process tests X2 and X3 using child processes. Put stress tests behind the test:stress script. Run all gates and show me the output of test and test:stress.

**[REVIEW]** **[HAND]** Run `pnpm test`, then `pnpm test:stress`. Both must pass. Run `pnpm test:stress` two more times. It must pass all three times. If it fails even once, tell the agent: "test:stress failed once in three runs, find the cause, do not add retries."

### Phase 3: Proxy core

**Goal:** an agent can connect through Twiceshy to a real MCP server.

**[PROMPT]**

> Implement Phase 3 from SPEC.md: config.ts with the Zod schema, environment variable and home folder expansion, and schema.json generation; downstream.ts connecting over stdio and Streamable HTTP; tool merging and naming per C13; guarded tool calls using the core guard; the duplicate and blocked result formats from C8; the twiceshy_status and twiceshy_recent_actions tools; and the stdout rule. Build the fake MCP servers in test/fixtures: a counter server, a slow payment server that commits before delaying its reply, a paginating server, and a server that crashes on demand. Pass tests P1 to P5, P9, P10, and P12. Use the version 2 MCP SDK exactly as its installed documentation describes. Run all gates.

**[REVIEW]** Read the agent's summary of how it used the MCP SDK. If it mentions version 1 import paths such as `@modelcontextprotocol/sdk/server/mcp.js`, ask it to confirm against the installed version 2 packages.

### Phase 4: Proxy resilience and CLI

**Goal:** the proxy survives real-world trouble, and humans can manage it.

**[PROMPT]**

> Implement Phase 4 from SPEC.md: downstream crash handling and restart backoff, progress and cancellation forwarding, UNSUPPORTED_FEATURE responses for sampling and elicitation, graceful shutdown, structured logging to stderr per C15, and every CLI command in C14 with help, JSON output, and exit codes. Make doctor output readable by a beginner, matching the example in C14. Pass tests P6, P7, P8, P11, and L1 to L3. Run all gates.

**[REVIEW]** **[HAND]** Try the real thing:
1. In the project folder run `pnpm build`.
2. Run `node packages/mcp-proxy/dist/cli.js doctor --config packages/mcp-proxy/test/fixtures/example.config.json`.
3. You should see a list of servers and tools, each tool labelled GUARDED or open with a reason in brackets, like the example in section C14 of this spec. If any line is confusing to you, it will confuse users. Tell the agent which line and why.

### Phase 5: Packaging, docs, and examples

**Goal:** someone else can install and use it without help.

**[PROMPT]**

> Implement Phase 5 from SPEC.md: package exports for both packages including the twiceshy/sqlite subpath, check:package with publint and arethetypeswrong, packaging tests K1 to K3 that install packed tarballs into a temporary project, every document listed in C19, and the two examples in the examples folder. Each example must run with one command and print what happened in plain words. Add the first changeset for version 0.1.0. Run all gates.

**[REVIEW]** **[HAND]** Read the main README as if you were a stranger. You should understand in under one minute what problem it solves and how to start. Then follow the "Choosing keyFields" page and check that its refund example matches the Kola story.

### Phase 6: Hardening

**Goal:** prove the tests actually catch bugs.

**[PROMPT]**

> Implement Phase 6 from SPEC.md: add Stryker mutation testing for engine.ts, fingerprint.ts, and classify.ts with a mutation score of at least 85%, fix every gap it reveals by adding meaningful tests, then do a full self-review of the repository against every section of SPEC.md. Produce a table listing each spec section, whether it is fully met, and any deviation with a reason. Do not mark anything met that is not proven by a test or by code you can point to.

**[REVIEW]** Bring the agent's compliance table back to this chat for a second review before publishing.

### Phase 7: Publish

**[HAND]**
1. Run `npm login` in the terminal and sign in.
2. In the project folder run `pnpm changeset version`, then `pnpm build`, then `pnpm -r publish --access public`.
3. Check npmjs.com/package/twiceshy shows version 0.1.0.
4. In a new empty folder, run `npx -y @twiceshy/mcp-proxy --help`. You should see the help text.
5. Connect the GitHub repository to Zenodo and create a GitHub release, so the release gets a DOI.

Publish as 0.1.0, not 1.0.0. Version 1.0.0 should come after real users have run it on real tools and no correctness bugs have appeared for some weeks. A 0.x version tells users the API may still change.

---

## Part E. Rules for the coding agent

Copy this part into Antigravity's rules or customisation settings for this workspace as well, so it applies to every conversation.

1. SPEC.md is the source of truth. If code and spec disagree, stop and report it. Do not silently pick one.
2. If anything in the spec is unclear or seems wrong, ask before building. Never invent behaviour for money-moving logic.
3. Read the installed version of every library before using it. Never write SDK code from memory.
4. Write tests before or alongside code, never after. Every required test in C17 must exist with a name that matches its ID, for example `D3: in-flight wait returns first result or IN_PROGRESS`.
5. Never weaken, skip, or delete a test to make it pass. Never add retries to hide a flaky test. Never lower a coverage threshold.
6. Follow every error-handling rule in C9. No empty catch blocks, no `any`, no floating promises, no `console.log` in the proxy package.
7. Never log, store, or print secret values. Redaction tests must stay green.
8. Keep `engine.ts` pure: no database, clock, network, or file access inside it.
9. Finish each phase by running every gate in C18 and showing the real output. Never claim a test passes without running it.
10. Keep changes inside the current phase. Note ideas for later phases in a `NOTES.md` file instead of building them early.
11. Commit after each phase with a clear message naming the phase.
12. Explain decisions in plain English in your phase summary, short enough for a busy reader.

---

## Part F. Known risks and open questions

**Risks**

- **Wrong `keyFields` is the main way protection fails.** If a developer leaves free text in the fingerprint, rephrased retries slip through. Mitigation: the keyFields guide, the F8 test as a documented example, and a `doctor` warning when a guarded tool has no `keyFields` and has free-text-looking string fields such as `note`, `reason`, `message`, or `description`.
- **Legitimate repeats get blocked.** A user who truly wants two identical transfers inside the window will be stopped. This is intended, and `allowRepeat` handles it, but the message must make it obvious, or users will think the tool is broken.
- **Annotations can lie.** A tool marked `idempotentHint: true` that is not idempotent will run unguarded. `trustIdempotentHint: false` exists for this, and `doctor` shows the reason for each decision so teams can spot it.
- **MCP SDK v2 changes.** The SDK is young and versions together across packages. Pin to a minor version range and test against new releases in CI before widening it.
- **Single machine only.** SqliteStore cannot protect agents running on several servers. Teams at that scale need the future Redis or Postgres store, and the README must say so up front.

