# Notes

## Mutation testing equivalents (Phase 6.1)

`pnpm test:mutation` runs Stryker over `engine.ts`, `fingerprint.ts`, `classify.ts`, and `redact.ts`. GitHub Actions runs it on demand and every Monday. Stryker changes the code in small ways and reports a "surviving mutant" when no test fails for a change. A survivor is either a test gap or an equivalent mutant: a change that cannot alter observable behaviour. Every survivor that is not listed below was killed by a test added in Phase 6.1, named after the behaviour it protects. This section explains the remaining survivors.

### classify.ts

- **`status !== undefined` guard (line 110) forced true.** `toStatusCode` returns either `undefined` or a number. With the guard removed, `DEFINITE_HTTP_STATUSES.has(undefined)` runs instead of being skipped. A `Set` returns false for a value that was never added, and `undefined` is never added, so the answer is false either way.
- **The `instanceof ZodError` shortcut (line 132) removed.** The next rule checks `record.name === 'ZodError'` (line 142). A real `ZodError` sets `name` to `"ZodError"`, and the C2 tests prove the name check classifies both a real instance and a copy from another module. Removing the shortcut leaves the same outcome through the name check.
- **The primitive early return (line 135) removed.** Inputs that were not objects or functions fall through to the property checks instead. A primitive has no `name`, `code`, `status`, `statusCode`, or `response` property, so every check is false and the result is still "ambiguous". A primitive with no properties cannot produce a definite answer.
- **The `error === null` early return (line 138) removed.** Without it, `null` reaches the property reads, which throw a `TypeError`, and the outer `try/catch` in `classifyError` turns that into the same "ambiguous" result. The observable output is identical; only the internal path differs.

### engine.ts

- **The `recordId === undefined` branch (line 100) forced false.** The branch decides between `{}` and `{ recordId }` when building the error options. The `TwiceshyError` constructor always assigns `this.recordId = options.recordId` (errors.ts line 66), so a missing id is already stored as an own property with the value `undefined`. Passing `{ recordId: undefined }` produces an identical error object and identical JSON output (`JSON.stringify` drops `undefined`).
- **The `request.explicitKey !== undefined` clause (line 151) forced true.** With the clause removed, every existing record is also checked for a fingerprint mismatch. Stores find an existing record either by explicit key (so `explicitKey` is defined) or by fingerprint (so `existing.fingerprint` equals `request.fingerprint` by construction). In both documented flows the extra mismatch check is false, so the decision does not change. Only a direct call to `decide` with a mismatched fingerprint and no explicit key could observe the difference, and no store makes such a call.

### fingerprint.ts

- **Array loop bound `<` changed to `<=` (line 86).** The extra iteration reads one element past the end, gets `undefined`, and `serializeValue` returns `undefined` for `undefined`. The loop skips undefined results (`if (serialized !== undefined)`), so the output string is identical for every array.
- **The `ignoreFields` default `[]` changed to `["Stryker was here"]` (line 170).** Stryker inserts its own sentinel string, which is not a field any tool sends. The documented default ("ignore nothing") is unchanged for every other field name; only an arguments object with a field literally named "Stryker was here" behaves differently, which no real caller produces.
- **The `typeof current !== 'object'` clause (line 200) forced false.** The guard returns "missing" for null, non-objects, and arrays. With the middle clause off, null and arrays still return through their clauses. A primitive continues, but `Object.hasOwn(primitive, segment)` is false for every primitive, so the path is still reported as missing. Same result.
- **The `{ found: false, value: undefined }` results (lines 201 and 204) mutated to `{}` or `found: true`.** The caller treats a result as missing when `!resolved.found || resolved.value === undefined`. The `{}` result has `found: undefined` (falsy) and the `found: true` result carries `value: undefined`, so both still count as missing. The selected object and the missing list are identical.
- **The `!Object.hasOwn(current, segment)` check (line 203) removed.** Without it, a property is read through the prototype chain. Ordinary argument objects come from JSON data with plain prototypes, where reading a missing key gives `undefined` and the caller still reports it as missing. Only an object with a same-named inherited property (for example one made by `Object.create`) behaves differently, and such objects are not valid tool arguments.
- **The `typeof existing === 'object'` clause (line 221) forced true.** The other half of the condition is `created.has(existing)`. `created` is a `WeakSet`, which returns false for every non-object value instead of throwing, so a primitive still takes the fresh container branch. For objects the clause was already true. Same result.
- **The `typeof next !== 'object'` clause in the normaliser path guard (line 383) forced false.** Same reasoning as line 200: null and arrays are still stopped by their clauses, and for primitives `Object.hasOwn(current, last)` is false, so the normaliser is skipped exactly as before.
- **The hash encoding `'utf8'` changed to `''` (line 441).** For a string input, Node treats an empty encoding as the default, which is utf8. The digest is byte for byte identical, verified by direct comparison.

### redact.ts

- **The leading empty `paths` array changed to `["Stryker was here"]` (line 28).** `hasLongerPath` compares candidate segments with the characters of a path entry. All candidate segments are lowercased field names, and the sentinel starts with an uppercase "S", so the character comparison can never be true. The mutant cannot affect redaction for any input.
- **The `hasLongerPath` condition (line 40) forced true and `>` changed to `>=`, and `every` changed to `some` (line 41).** These control only whether a prefix is carried into deeper levels so that a later dotted field can match. A deep candidate matches a configured dotted field only when its segments, joined with dots, equal that field exactly (line 72). That requires the kept prefix to be the true leading segments of the field, which is exactly the `every` test. The `>=` case is unreachable: a candidate whose length and segments equal a configured path has already matched and been redacted before recursion. And a wrong prefix can never create a false match, because joining only appends segments, so the joined string cannot equal a configured path whose middle segments differ. All three mutants produce the same redaction output.
- **The `extraFields` default `[]` changed to `["Stryker was here"]` (line 98).** Same sentinel situation as the fingerprint default: only a field literally named "Stryker was here" is affected, and the documented default ("no extra fields") is unchanged for every other name.

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

