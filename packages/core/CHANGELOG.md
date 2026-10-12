# twiceshy

## 0.1.0

### Minor Changes

- 0f38cb7: First release of Twiceshy 0.1.0.
  
  **What Twiceshy does.** AI agents retry. When a refund, transfer, message, or booking times out, the agent tries again, and the action happens twice. Twiceshy sits between the agent and the tool and asks one question before every irreversible action: "has this exact action already happened, or is it happening right now?" If yes, it does not run it again. When it cannot tell, it stops and says the action is **in doubt** until a person decides, because guessing "probably failed" is how customers get paid twice. You can use it two ways: **`twiceshy`**, a library that wraps your own tool functions, or **`@twiceshy/mcp-proxy`**, an MCP proxy that protects existing MCP servers by changing one line of client config. Every action is recorded and can be inspected with the `twiceshy` CLI or settled with `resolve` or `allow`.
  
  **Main limits, stated honestly.**
  
  - One machine only in v1. `SqliteStore` protects agents on a single computer or server; agents spread over several servers need the future Redis or Postgres store.
  - `MemoryStore` loses every record on restart, so a retry after a restart looks new. Use `SqliteStore` for anything that matters.
  - `SqliteStore` needs Node 22.14 or newer because `better-sqlite3` ships prebuilt binaries that use a newer Node API.
  - MCP tool annotations are hints, not guarantees. A tool marked `idempotentHint: true` that is not idempotent runs unguarded unless you set `trustIdempotentHint: false` or `guard: true`.
  - A wrong `keyFields` choice is the main way protection fails. If free text such as `reason` is part of the fingerprint, a rephrased retry looks like a new action.
  - A genuinely intended repeat inside the window is blocked on purpose. A person can approve exactly one repeat with `twiceshy allow`.
  - Redaction works by field name, so it cannot find a secret hidden inside free text. Results are redacted before storage, and `storeResult: false` stores no result at all.
  - No sampling or elicitation forwarding in v1; such requests get `UNSUPPORTED_FEATURE`. No undo, no hosted service, and no central view across machines.
  - The in-flight wait is bounded (5 seconds by default), and templated resource reads are not matched back to their downstream server yet.
  
  **Note for store authors.** `ActionStore.complete()` now returns a `CompleteResult` instead of `void`, and every record from `begin()` carries an opaque `attemptToken`. A store must write a normal completion only when the record is still `IN_FLIGHT` and the token matches the claim, and it must do that check inside the same atomic operation as the write (C20 rule 22). This is what stops a late writer from overwriting a state another process or a person already set; the shared contract suite in `twiceshy/stores/contract` covers it.
