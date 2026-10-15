# twiceshy

## 0.1.2

### Patch Changes

- Twiceshy now works with every better-sqlite3 version from **12.11.1 upward**,
  including future releases.
  
  - The core optional peer dependency and the proxy dependency are `>=12.11.1`
    with no upper limit, so installing the driver is simply:
  
    ```bash
    npm install twiceshy better-sqlite3
    ```
  
    npm picks the newest version and Twiceshy checks it before opening a
    database.
  - A better-sqlite3 older than 12.11.1 gives a clear error right away:
    `STORE_UNAVAILABLE` names the installed version, the required minimum, and
    the exact command to fix it (`npm install better-sqlite3@latest`), instead
    of failing later inside SQLite.
  - better-sqlite3 13.x needs Node-API 10 (Node 22.14 or newer, or Node 24). On
    older Node 22 releases, `SqliteStore` now refuses clearly and suggests
    upgrading Node or running `npm install better-sqlite3@^12.11.1`, instead of
    crashing inside the native addon.

## 0.1.1

### Patch Changes

- 692d12e: Twiceshy 0.1.1. Every demo from the launch guide now works from a fresh folder
  with plain `node`, and the test suite runs the real package the way users do.
  What changed, in plain words:
  
  - The SQLite crash is fixed at the cause. Demos 2, 4, 5, and 6 died with exit
    code 139 and no message on Node 22.13. `better-sqlite3` 13.x ships binaries
    that need Node-API 10 (Node 22.14+), and the native code segfaulted while
    opening a database, before Twiceshy could catch anything. `SqliteStore` now
    depends on `better-sqlite3` 12.x, whose prebuilt binaries support every Node
    22 and Node 24 release. The old workaround that pinned the project's scripts
    to Node 24.10.0 is removed, and the full test suite now passes on Node 22.13
    with the shell's own `node`.
  - `close()` is safe at any moment. It stops lease-renewal timers, cancels
    late-completion watchers, waits for in-flight calls, renewals, and purges
    (bounded by `closeTimeoutMs`), and only then closes the database and its
    prepared statements. Any guard or store call after `close()` gets
    `STORE_UNAVAILABLE`, never a crash.
  - The CLI is easy to find. The `twiceshy` command is installed by
    `@twiceshy/mcp-proxy`, not by the core library. Every README and guide that
    shows a CLI command now says so and shows the no-install form,
    `npx -y @twiceshy/mcp-proxy <command>`. The core README gained an
    "Inspecting and resolving records" section with a working config example.
  - The launch demos are official. `examples/demos` has one corrected, runnable
    script per demo, a local counter server for the proxy demos, both config
    files, and a README with the expected output. Demos 1 to 5 print a clear
    PASS or FAIL line; demo 6 prints timings only. Demo 4 builds its proxy
    config with absolute paths at runtime.
  - A new `test:smoke` gate proves the packages as users receive them. It packs
    both packages, installs only the tarballs plus `better-sqlite3` into a fresh
    folder outside the repository, and runs the demos plus the close/shutdown
    scenarios as plain `node` processes, repeating every SqliteStore scenario 20
    times. It also runs `list`, `show`, and `resolve` with
    `npx -y @twiceshy/mcp-proxy` against the database the demos created. The
    temporary folder is deleted even on failure. `test:smoke` runs in CI on
    Windows, macOS, and Linux on Node 22 and 24.
  - `twiceshy show` now labels a timeout summary left on a succeeded record as
    "(from an earlier attempt)", so a late success no longer looks like a
    contradiction.

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
