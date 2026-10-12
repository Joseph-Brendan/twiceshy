---
"twiceshy": patch
"@twiceshy/mcp-proxy": patch
---

Fix the SQLite crash on Node 22.13 and make close() safe at any moment.

- `SqliteStore` now uses better-sqlite3 12.x, whose prebuilt binaries support
  every Node 22 and Node 24 release. Node 22.13 no longer segfaults when a
  database is opened, so Twiceshy runs on all supported Node releases without
  a compiler.
- `close()` stops every timer, cancels late-completion watchers, waits for
  in-flight calls, lease renewals, and purges (bounded by `closeTimeoutMs`),
  and only then closes the store. Any guard or store call after `close()` gets
  `STORE_UNAVAILABLE` instead of a crash.
- The `twiceshy` command is installed by `@twiceshy/mcp-proxy`. Every document
  that shows a CLI command now shows how to get it, including the no-install
  form `npx -y @twiceshy/mcp-proxy <command>`.
- New `examples/demos` with one runnable script per launch demo, and a new
  `test:smoke` gate that runs them from the packed tarballs as plain `node`
  processes outside Vitest, repeated for the SqliteStore scenarios.
