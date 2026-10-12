# Error reference

Every error from Twiceshy carries a stable code and three pieces of text: what happened, why it happened, and what to do next. Error messages never contain private values. This page explains each code in plain words.

## IN_DOUBT

**What it means:** the action may or may not have happened. Twiceshy cannot tell.

**Common cause:** a timeout, a dropped connection, an unknown error, or a caller that cancelled while the action was running. For example, Kola's refund request timed out, but Paystack had already accepted the refund. A cancellation *before* the tool function was invoked is different: that records `FAILED_DEFINITE` with reason "cancelled before start", because the action certainly did not happen.

**Fix:** a person must check the provider, then resolve the record. Do not retry. The exact fix text:

```text
A person must check whether the action happened, then run `twiceshy resolve <id> --succeeded` or `--failed`. Do not retry.
```

## IN_PROGRESS

**What it means:** an identical call is already running and did not finish inside the allowed wait.

**Common cause:** two agents called the same tool at the same moment. The first one is still working after `waitForInFlightMs`, 5 seconds by default.

**Fix:** wait a moment, then call again. The first call may still complete and return its result.

## KEY_CONFLICT

**What it means:** the explicit key was already used for a different action.

**Common cause:** the same order number or reference was reused, but the arguments changed. For example, a second transfer with key `order-1` and a different amount.

**Fix:** use a new key for a new action. If the arguments are truly identical, the call returns a duplicate instead.

## NOT_SERIALIZABLE

**What it means:** the arguments or the result cannot be stored.

**Common cause:** the value contains a function, a symbol, `NaN`, `Infinity`, or a circular reference. For example, an argument object that points back to itself.

**Fix:** remove the unsupported value, or set `storeResult: false` when the result is the problem. The error names the field path, for example `args.callback`.

## STORE_UNAVAILABLE

**What it means:** the database cannot be read or written.

**Common cause:** the folder is missing or not writable, the file is not a SQLite database, the file is locked by another process for too long, or the optional `better-sqlite3` package is not installed.

**Fix:** check the file path and permissions. Guarded actions are paused for safety. When `onStoreFailure` is `'open'`, guarded calls run unprotected instead and a `guard-bypassed` event fires.

## CONFIG_INVALID

**What it means:** one or more configuration values failed validation.

**Common cause:** a typo such as `keyfield` instead of `keyFields`, a bad duration such as `"10 minutes"`, a missing environment variable, or an unknown option.

**Fix:** the single error lists every problem, with the field, the expected value, and an example. Fix them all, then try again.

## RESULT_TOO_LARGE

**What it means:** the result is larger than `maxResultBytes`, 256 KB by default.

**Common cause:** a tool returned a long list or a large document. For example, 300,000 bytes against a 262,144 byte limit.

**Fix:** raise the limit, or set `storeResult: false`. With `storeResult: false` the record keeps no result at all, and duplicates return a short summary, not the full result.

## DOWNSTREAM_UNAVAILABLE

**What it means:** the proxy cannot reach a downstream MCP server.

**Common cause:** the server failed to start, crashed, or refused the connection. A guarded call that was in progress when the server crashed becomes `IN_DOUBT`.

**Fix:** check the server command or URL in the config. The proxy restarts crashed servers with backoff, up to five attempts, then reports the server as failed in `twiceshy_status`. Use `doctor` to see the exact command and the real reason.

## UNSUPPORTED_FEATURE

**What it means:** a feature that Twiceshy v1 does not implement was requested.

**Common cause:** a downstream server asked for sampling or elicitation.

**Fix:** remove the feature from your setup for now, or wait for v1.1. The message names the feature, and nothing is silently dropped.

## How Twiceshy classifies failures

When a tool throws, Twiceshy decides between two answers:

- **Definite:** the action certainly did not happen, for example invalid input. The record becomes `FAILED_DEFINITE` and the next call runs.
- **Ambiguous:** anything else, including timeouts and unknown errors. The record becomes `IN_DOUBT` and a person decides.

Twiceshy leans toward ambiguous when it is unsure, because a wrong "definite" answer allows a duplicate charge. Developers can mark errors as definite with `definiteFailure(error)` or supply a custom classifier.
