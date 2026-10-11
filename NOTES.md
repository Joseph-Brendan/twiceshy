# Notes

## The decision engine in plain English

When a guarded call arrives, Twiceshy finds the record for that action, by explicit key or fingerprint, and asks: has this already happened?

- No record: run it, and claim the record as "in flight" with a lease, a timed claim the running process keeps renewing.
- Succeeded inside the window: do not run it again; return the original result marked as a duplicate.
- Succeeded before the window started: run it as a fresh action.
- Still running: wait briefly for the first call, then follow its new state or report IN_PROGRESS.
- Running but the lease expired: the process likely died. Mark it "in doubt" and refuse; a person decides.
- Failed definitely: safe to run again, counting the attempt.
- In doubt: refuse until a person resolves it.
- A person can grant one repeat, which allows exactly one extra execution.

If a result arrives after a timeout, Twiceshy upgrades "in doubt" to succeeded or failed when it can, so no human is needed.

## Rules for Phase 2

- The store contract suite must include a test proving `complete()` always sets `completedAt`, for every terminal state.
- When an action finishes, the guard must re-read its record. If the record is no longer `IN_FLIGHT`, or is not owned by this call, it must use `lateCompletion`, never `afterExecution`. It must never overwrite a state set by another process or by a human. Phase 2 needs a test where a lease expires mid-action, another caller marks the record `IN_DOUBT`, and the original call then finishes and upgrades the record through `lateCompletion`.

## MCP SDK v2 notes

Installed: `@modelcontextprotocol/client@2.3.1`, `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/core@2.3.1`. This is the v2 line implementing the 2026-07-28 spec; it replaces the single `@modelcontextprotocol/sdk` package. Import paths are the bare package names (for example `@modelcontextprotocol/client`, `@modelcontextprotocol/client/stdio`, `@modelcontextprotocol/server`, `@modelcontextprotocol/server/stdio`). Never `@modelcontextprotocol/sdk/...`.

**Creating a client.** `new Client({ name, version }, options?)` from `@modelcontextprotocol/client`. Options include `capabilities`, `listChanged` handlers, `versionNegotiation` (default `'legacy'`, opt into `'auto'` or `{ pin: '2026-07-28' }`), and `listMaxPages` (default 64). Connect with `await client.connect(transport, { timeout?, signal? })`; `client.close()` tears down.

**Connecting over stdio.** `new StdioClientTransport({ command, args?, env?, stderr?, cwd?, maxBufferSize? })` from `@modelcontextprotocol/client/stdio`. This transport is Node-only. `env` replaces the environment; when omitted the SDK uses `getDefaultEnvironment()`, a curated safe subset, so a proxy that wants the parent environment plus overrides must pass the merge itself. `stderr: 'pipe'` exposes `transport.stderr` (a stream available before `start()`), which is how the proxy prefixes and forwards child stderr. The transport also exposes `pid`.

**Connecting over Streamable HTTP.** `new StreamableHTTPClientTransport(new URL(url), opts?)` from the main client entry. It opens one POST (plus SSE response stream) per request, honors per-request abort signals, and reconnects with its own options.

**Listing tools with pagination.** `await client.listTools(params?, options?)` returns `{ tools, nextCursor?, _meta? }`. Called with no arguments it auto-aggregates every page up to `listMaxPages` (64, `0` disables); a call with an explicit `cursor` fetches one page. Each `Tool` is `{ name, title?, icons?, description?, inputSchema, outputSchema?, annotations?, execution?, _meta? }`. `inputSchema` is a JSON Schema object; annotations are `{ title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` and must be forwarded byte-for-byte.

**Calling tools.** `await client.callTool({ name, arguments, _meta?, task? }, options?)` returns `{ content, structuredContent?, isError?, _meta? }`. Per-call `RequestOptions` carry `onprogress` (receives `Progress`), `signal` (AbortSignal for cancellation), `timeout`, `resetTimeoutOnProgress`, and `maxTotalTimeout`. `CallToolRequestParams._meta` is the `RequestMeta` envelope, currently `{ progressToken?, "io.modelcontextprotocol/related-task"? }`.

**Low-level server that can forward arbitrary calls.** `new Server({ name, version }, { capabilities: { tools: { listChanged: true } } })` from `@modelcontextprotocol/server`. Register handlers with the method string plus the built-in type map: `server.setRequestHandler('tools/list', async (request, ctx) => ({ tools }))`, `server.setRequestHandler('tools/call', async (request, ctx) => result)`, and `server.setNotificationHandler('notifications/tools/list_changed', handler)`. `server.connect(transport)` attaches; `server.close()` detaches; `server.sendToolListChanged()`, `sendResourceListChanged()`, `sendPromptListChanged()`, and `sendLoggingMessage()` push notifications. A low-level `Server` skips `McpServer` registration entirely, which is what a proxy wants because downstream tool definitions arrive as JSON Schema, not Zod.

**Serving stdio.** `@modelcontextprotocol/server/stdio` exports `StdioServerTransport` (constructor takes optional stdin/stdout streams, which makes in-memory tests possible) and `serveStdio(factory, options?)`. `serveStdio` owns the 2025-vs-2026 era decision and the factory may return either `McpServer` or the low-level `Server`.

**Notifications, progress, cancellation.** Server-to-client notifications are handled with `setNotificationHandler(method, handler)` or configured up front through `ClientOptions.listChanged` (`{ tools: { onChanged, autoRefresh?, debounceMs? } }`), which refreshes the list automatically. Progress comes through the per-request `onprogress` callback (paired with a `progressToken` in `_meta`); cancellation is the per-request `signal`. On a 2026-era Streamable HTTP connection the SDK aborts the per-request stream instead of sending `notifications/cancelled`.

**Annotations and `_meta`.** `Tool.annotations` and `Tool._meta` flow through `tools/list` untouched; `CallToolResult._meta` is the result envelope (`ResultMetaObject`). The 2026-07-28 era attaches a reserved request `_meta` envelope automatically, and user `_meta` keys win.

