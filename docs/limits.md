# Limits

These are the honest limits of Twiceshy v1. Each one is a deliberate choice, not an oversight.

## One machine only

`SqliteStore` protects agents that run on a single computer or server. If agents run on several servers at the same time, they do not share the same database, and duplicates can slip between them. Teams at that scale need the future Redis or Postgres store. The storage interface is designed for that addition.

## MemoryStore loses data on restart

`MemoryStore` keeps records in memory only. When the process stops, every record is gone. A retry after a restart looks like a brand new action. Use `SqliteStore` for anything that matters.

## Node 22.14 or newer for SQLite

`SqliteStore` uses `better-sqlite3`, which ships prebuilt native binaries. Those binaries need a newer Node API. Node 22.13 and older crash when they load the binary. Use Node 22.14 or newer, or Node 24. The in-memory store works on older Node 22 releases.

## Annotations are hints

MCP tool annotations such as `readOnlyHint` and `idempotentHint` are claims by the tool, not guarantees. A tool marked `idempotentHint: true` that actually sends an email every time runs unguarded. Set `trustIdempotentHint: false` to ignore that claim, or set `guard: true` for the tool. `doctor` shows the reason for every decision so you can spot a wrong claim.

## A wrong keyFields choice is the main way protection fails

If free text such as `reason` or `note` is part of the fingerprint, a rephrased retry looks like a new action and runs again. Read [Choosing keyFields](choosing-key-fields.md) and watch for doctor warnings.

## Legitimate repeats are blocked

A genuinely intended repeat inside the window is stopped, on purpose. A person can approve exactly one repeat with `twiceshy allow`. Without that approval, the guard treats the second call as a duplicate.

## Human decisions stay human

No proxy tool can resolve, delete, purge, or approve anything. Those actions exist only in the command line interface, and `resolve` and `allow` require the name of the person deciding.

## No sampling or elicitation in v1

Sampling and elicitation are advanced MCP features where a server asks the client's model or user for something. Twiceshy does not forward them in v1. A downstream server that asks receives `UNSUPPORTED_FEATURE`, and the message says the feature is planned for v1.1. Nothing is silently dropped.

## No undo

Twiceshy cannot reverse an action. It prevents duplicates. Reversals belong to the tool or the provider.

## No hosted service

There is no dashboard, no account, and no cloud service. Everything runs locally, and the data stays on your machine. That also means there is no central place to watch several machines at once.

## Cancelled calls become in doubt

When a caller cancels a guarded call, the tool may already have run. Twiceshy marks the record in doubt and asks a person. If a result arrives later, Twiceshy upgrades the record by itself.

## The in-flight wait is bounded

When an identical call is already running, a second caller waits up to `waitForInFlightMs`, 5 seconds by default. If the first call is still running after the wait, the second call gets `IN_PROGRESS` and should call again later.

## Large results become summaries

A result above `maxResultBytes`, 256 KB by default, is not stored in full and the write fails with `RESULT_TOO_LARGE`. Raise the limit, or set `storeResult: false` deliberately.

## storeResult: false keeps no result

With `storeResult: false`, Twiceshy stores no result at all for the action. A duplicate then returns a short text summary saying the action already ran, not the original result. Use it for tools whose results are large or contain data you do not want on disk, and accept that a duplicate shows only the summary.

## Results are redacted before storage

Like arguments, a successful result is written through the same field-name redaction list (the built-in one plus your `redact` extras). A duplicate returns that stored, redacted copy, and `_meta["dev.twiceshy/outcome"].resultRedacted` is `true` when any field was replaced. The first caller still gets the real, unredacted result.

## Debug logs can contain downstream text

At the default log levels, Twiceshy logs only an error's class name, code, and classification. `--log-level debug` includes the full message from the downstream server, which may contain text you did not expect. Keep debug logs for troubleshooting and treat them as sensitive.

## Templated resource reads are not matched back

The proxy forwards resources from downstream servers. A read of a concrete resource URI works. A read whose URI matches a downstream template is not matched back to its server yet. It returns an error.

## Free text can still reach the record

Redaction works by field name, so it cannot find a secret hidden inside free text such as a `note`, `reason`, or `message` field, or inside a result string. A tool that echoes a key into a field with an unusual name will still have that text stored, for arguments and for results alike. Keep the built-in redaction list, add extra field names when your tools use unusual ones, and prefer `storeResult: false` for tools that return sensitive free text.
