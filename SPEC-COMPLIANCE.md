# SPEC Compliance Review

Phase 6.2 of SPEC.md, second pass, after the C20 amendments. The reviewer did not write the review; each claim below was checked against the code and the real gate output in the appendix. No code was changed while writing this document.

- Revision reviewed: `bbadca1`, with the updated `SPEC.md` (section C20) in the working tree. Only `SPEC.md` differs from the reviewed code commit.
- Reviewer environment used for this pass: macOS, pnpm 10.6.1, Node 24.10.0 local; Windows, macOS, and Linux on Node 22 and 24 in GitHub Actions.
- Rule applied: an item is `met` only when code or a passing test proves it. Belief is not evidence.

Status values: `met`, `partly met`, `not met`.

## 1. Spec sections

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Part A (how to use this document) | met | `SPEC.md` in the repo root; phases committed in order (`git log`: Phase 1 to Phase 6.2) | Process section. |
| B1 (the problem) | met (descriptive) | `README.md:1-12`, `docs/choosing-key-fields.md` (Kola case) | No code obligation. |
| B2 (what Twiceshy is) | met | `packages/core/package.json` name `twiceshy`; `packages/mcp-proxy/package.json` name `@twiceshy/mcp-proxy`, bin `twiceshy` and `mcp-proxy` | Both forms ship. |
| B3 (goals) | met | Goal 1: D1/D2, X2/X3/X4, `engine.ts` decision table. Goal 2: IN_DOUBT blocks in `guard.ts` and the proxy. Goal 3: `examples/`, one-line proxy config. Goal 4: records plus `GuardEvent` in `guard.ts:81-121`. Goal 5: `errors.ts` what/why/fix and `errors.test.ts` C4 | |
| B4 (non-goals) | met | No hosted service; no undo; only Memory and Sqlite stores; developer-declared keyFields; sampling and elicitation refused (`proxy.ts`), P8 | |
| B5 (existing work) | met (descriptive) | Positioning in `README.md` | No code obligation. |
| C1 (stack and versions) | met | Root and package manifests: TypeScript 5.9.3, Node engines `>=22.14.0`, pnpm 10.6.1, tsup 8.x, Vitest 4.x, fast-check 4.x, Zod 4.x, better-sqlite3 13 optional peer, MCP SDK `~2.3.1`, Biome, Changesets, publint, attw, Stryker 10.0.0 (accepted by C20.16 for mutation testing), GitHub Actions | |
| C2 (core concepts) | met | Defaults `guard.ts` (10m window, 7d retention); concepts in `engine.ts`, `fingerprint.ts`, `stores/types.ts` | |
| C3 (which actions are guarded) | met | `classify.ts` implements the rule order; `classify.test.ts` covers every row including `guard: false` beating `destructiveHint` | |
| C4 (the fingerprint) | met, note | `computeFingerprint` `fingerprint.ts`; tests F1 to F9, golden fingerprints checked in CI on three OS and Node 22/24 | JSON-encodes each part before joining, a deliberate strengthening of the separator rule. Unchanged by this pass. |
| C5 (record states) | met | `engine.ts:12-18`; state machine in `decide`, `afterExecution`, `lateCompletion`, `completeRecord` | |
| C6 (decision table) | met | `decide` `engine.ts:143-203`; atomic claiming `memory.ts` and `sqlite.ts`; leases and renewal `guard.ts`; tests D1 to D9, X1 to X4 | C20.1 strengthens completion with an attempt token inside the store transaction. |
| C7 (classifying failures) | met | `classify.ts`; tests C2, C3; `classifyError` never throws | |
| C8 (what callers receive) | met | `GuardOutcome` `guard.ts`; duplicate result plus `_meta["dev.twiceshy/outcome"]` in `proxy.ts` (now includes `resultRedacted`); blocked results are `isError: true` tool results; tests P2, P3 | `originalAt` may be `null`, explicitly accepted by C20.11. |
| C9 (error design) | met | Nine codes and fields `errors.ts`; C4 test; rules 2 and 3 covered by C5 and S5 tests; rule 1 holds across all catches except the three marked `// last resort:` under C20.9; rules 4 and 5 hold (Biome floating promises, redaction) | `errorSummary` is now populated (C20.8), closing the old dead-plumbing item. |
| C10 (failure of Twiceshy itself) | met | `guard.ts` closed refuses, open bypasses with `guard-bypassed`; test S4 | |
| C11 (library API) | met, note | `createGuard`, `wrap`, `run`, `list`, `get`, `resolve`, `allowRepeat`, `purge`, `close`; Zod validation lists all problems; ESM and CJS; core runtime dependency zod only | Extra API surface beyond the example is listed in section 4a and accepted by C20.13. |
| C12 (storage) | met | `stores/types.ts` interface; WAL and busy timeout; `BEGIN IMMEDIATE` transactions; additive migrations (version 2 adds `attempt_token` and `result_redacted`); folder creation; retention and hourly purge; S1 to S8 | `complete` is now conditional on the attempt token (C20.1). |
| C13 (MCP proxy) | met, note | `config.ts` schema, `proxy.ts` merging and guarding, `downstream.ts` connect/restart; tests P1 to P12; stdout rule in `logger.ts`, P9 | Extra config keys are listed in 4a and accepted by C20.14; `storeResult` and `resolvedEnvValues` added by C20.6/C20.7. |
| C14 (CLI) | met, note | All seven commands; help with examples; exit codes 0/1/2; tests L1 to L3; doctor free-text warning | `resolve` and `allow` require `--by <name>`, accepted by C20.12. `show` displays `errorSummary` (C20.8). |
| C15 (observability) | met, note | Event shape `guard.ts:81-121`; hook isolation; JSON lines to stderr in `logger.ts`; levels and `--log-level`; tests | Events carry `reason`, `missing`, `error` beyond the listed fields; below debug the `error` field is reduced to name, code, and classification (C20.5). New event type `resolution-conflict` accepted by C20.13. |
| C16 (repository layout) | met, note | Both packages, `src` modules, `stores/`, fixtures, root configs and workflows | Proxy tools live in `proxy.ts`; extra modules `logger.ts`, `restart.ts`, `version.ts`, `mask.ts`, `stores/record.ts`, `stores/types.ts`; extra root files `stryker.config.json`, extra Vitest configs, `vitest.global-setup.ts`, `scripts/`, `NOTES.md`, `SPEC-COMPLIANCE.md`. All accepted by C20.15 except `mask.ts` and `vitest.global-setup.ts`, recommended for acceptance in section 9. |
| C17 (testing strategy) | met | 100 percent lines and branches on the four core modules; 503 tests in 28 files; every required test present (section 2); property tests F1 to F3; contract S1; real multi-process X2/X3; proxy integration P1 to P12; story tests Kola (P3) and Ada parallel booking (D3) | New C20.1, C20.3, C20.4, C20.5, C20.6, C20.7, C20.8, C20.10 tests added. Mutation score 96.81, above the 85 break threshold. |
| C18 (quality gates) | met | Appendix section 8: every gate passes, stress five times, pack, mutation | CI now builds before test so the real-binary tests never race over one dist folder; all six GitHub Actions jobs are green (run 38253032405). |
| C19 (documentation) | met | Root and package READMEs, five guides in `docs/`, `CITATION.cff` | C20 behaviours documented: result redaction, `storeResult`, cancellation before start, resolution conflict, debug log warning, free-text limit, surface listing failures. |
| C20.1 (conditional completion) | met | `completeRecord` `engine.ts:308-346`; MemoryStore `memory.ts:130-176`; SqliteStore `sqlite.ts:560-641` inside `tx.immediate()`; contract tests "complete refuses a write from anything but the claiming attempt token", "a stale completion leaves a newer attempt alone", "complete only writes while the record is IN_FLIGHT on the same attempt"; guard test "a late result upgrades an IN_DOUBT record through late completion even when the re-read failed", "a late completion never overwrites a newer attempt claimed by another process" | The attempt token is a per-claim opaque value stored in `attempt_token`; the check and the write are in one atomic operation in both stores. |
| C20.2 (late result against another process) | met | `completeRecord` IN_DOUBT branch, `guard.ts` watchLateCompletion and finishExecute; guard tests "late completion upgrades a record another caller put in doubt while the action ran" and the D5 tests | |
| C20.3 (late result against a human decision) | met | `completeRecord` RESOLVED_FAILED and RESOLVED_SUCCEEDED branches; `guard.ts:923-935` and `guard.ts:974-982` emit `resolution-conflict`; `proxy.ts` logs it at error level even at the default warn level; contract test "C20.3: a late success against a human "failed" decision reports a conflict and blocks with IN_DOUBT"; guard test "C20.3: a late success against a human "failed" resolution emits resolution-conflict and blocks the retry" | The human fields (`resolvedBy`, `resolutionNote`) stay on the record; only `state` returns to IN_DOUBT so the next call blocks. A late result that agrees with the resolution changes nothing. |
| C20.4 (cancelled before start) | met | `ExecutionOutcome` variant `cancelled-before-start` `engine.ts:92`; `afterExecution`/`lateCompletion` map it to FAILED_DEFINITE; `guard.ts:824-834`; engine test "C20.4: a cancellation before start is a definite failure"; guard tests "C20.4: cancellation before the tool function is invoked records FAILED_DEFINITE with cancelled before start" and "C20.4: cancellation after the tool was invoked stays IN_DOUBT" | `errorSummary` contains the exact phrase "cancelled before start". |
| C20.5 (no raw downstream text below debug) | met | `proxy.ts:266-311` reduces an event's error to name, code, and classification unless `logger.level === 'debug'`; `downstream.ts` uses `describeErrorForLevel` for close/restart/startup logs; `proxy-secrets.test.ts` proves a downstream error containing `sk_live_TESTSECRET` never appears at warn or info and does appear at debug | |
| C20.6 (results redacted, `resultRedacted`, `storeResult: false`) | met | `redactReporting` `redact.ts`; `guard.ts:1005-1045` redacts a successful result before `complete`; `ActionRecord.resultRedacted`; SQL column `result_redacted`; `duplicateResult` adds `resultRedacted` to `_meta` and returns a short text summary when no result was stored; S6 test "a structured result with secret fields never reaches the database files"; proxy tests "a duplicate returns the stored redacted result and says so in _meta", "storeResult false keeps no result and a duplicate returns a short summary"; contract test "C20.6: storeResult false stores no result at all"; `docs/limits.md` states the free-text limit | |
| C20.7 (masked resolved env values) | met | `mask.ts` masks values of six or more characters; `config.ts` records `resolvedEnvValues`; `downstream.ts` masks forwarded stderr, failure `why`, `target`, and the stderr tail; `cli.ts` masks doctor output; `proxy-secrets.test.ts` unit tests; `doctor-output.test.ts` runs a failing server that prints its own secret env value and proves doctor masks it | |
| C20.8 (safe `errorSummary`) | met | `guard.ts:1218-1232` fills class name, Twiceshy code, classification, and a fixed reason; called from every failure completion; guard test "C20.8: errorSummary is a safe description that never contains the raw message"; CLI test shows `show` prints `Error [none/ambiguous]: ambiguous error` and never `socket hang up` | |
| C20.9 (last-resort catches) | met | `guard.ts:1203`, `sqlite.ts:218`, `logger.ts:113` each carry a comment starting `// last resort:`; no other empty catches remain (`grep` in section 6); the proxy shutdown catches a failed guard close and logs it at warn (`proxy.ts`, close path) | |
| C20.10 (surface listing failures) | met | `downstream.ts` `loadSurface` logs at warn and records `SurfaceFailure`; refresh handlers in `proxy.ts` record and keep the previous list; `twiceshy_status` prints `could not list <surface>`; doctor renders the same; test "C20.10: a failed resource or prompt listing is logged at warn and shown in status and doctor" | The old silent `[]` wrappers and the debug-only log are gone. |
| C20.11 (`originalAt` may be null) | met | `guard.ts` `GuardOutcome.originalAt: Date \| null`; docs unchanged | Explicitly accepted by the spec. |
| C20.12 (`--by`, `--config`, `--json`, `--log-level`, `mcp-proxy` bin) | met | `cli.ts`; `packages/mcp-proxy/package.json` bins | |
| C20.13 (extra guard options and hooks) | met | `guard.ts`: `purge()`, `maxResultBytes`, `timeoutMs`, `leaseMs`, `closeTimeoutMs`, `closeStore`, `onGuardBypassed`, `onWarning`, `onResolutionConflict` | |
| C20.14 (extra proxy config) | met | `config.ts`: `cwd`, per-tool `ignoreFields`, `timeoutMs`, `storeResult`, top-level `retention`, `exposeRecentActions`, `store.type: "memory"`; plus the internal `resolvedEnvValues` recorded for masking | `resolvedEnvValues` is new and recommended for acceptance in section 9. |
| C20.15 (extra repository files) | met | `logger.ts`, `restart.ts`, `version.ts`, `stores/record.ts`, `stores/types.ts`, `scripts/`, extra Vitest configs, `stryker.config.json`, `NOTES.md`, `SPEC-COMPLIANCE.md` all exist | `mask.ts`, `vitest.global-setup.ts`, and the `broken-surfaces-server.mjs` fixture are new; recommended for acceptance. |
| C20.16 (Stryker in the toolchain) | met | `stryker.config.json`, mutation workflow, mutation gate in the appendix | |
| D kickoff | partly met | `NOTES.md` holds the v2 SDK notes | The kickoff chat response is not preserved in the repository, so it cannot be verified from code. Nothing in the code depends on it. |
| D Phase 0 to 6 | met | Commits in order; every phase's tests pass | Phase 6.2 is this document plus the C20 fixes. |
| D Phase 7 (publish) | not met | Versions are 0.0.0; nothing is published | This is the `[HAND]` step for Joseph, expected to be pending. Not a code-quality problem. |
| E1 (spec is source of truth) | met | `NOTES.md` records interpretations; this review lists every place code exceeds the spec | |
| E2 (ask before building) | partly met | Open questions recorded in `NOTES.md` | Chat history is not in the repository. |
| E3 (read installed libraries) | met | `NOTES.md` documents the installed MCP SDK v2 API; Stryker config written from the installed schema | |
| E4 (tests named by ID) | met | Every C17 ID exists with its ID in the test name; C20 tests named the same way | |
| E5 (never weaken tests) | met | No `.skip`, `.todo`, `.only`, commented tests, or lowered thresholds; the C20 changes replaced two tests that asserted the old, now-superseded behaviour with stronger assertions | |
| E6 (C9 rules, no any, no floating promises, no console.log in proxy) | met | Biome bans `any` and floating promises; the proxy bans `console.log` and P9 enforces stdout purity; all catches handled or marked `// last resort:` | |
| E7 (never log or store secrets) | met | Arguments redacted before storage; results redacted before storage (C20.6); logs carry no raw error text below debug (C20.5); known env values masked (C20.7); S6 and the proxy secrets tests pass | |
| E8 (engine pure) | met | `engine.ts` imports only `./errors.js`; no clock, database, network, or file access | `completeRecord` is pure. |
| E9 (run every gate, show output) | met | Appendix section 8 | |
| E10 (stay in phase, NOTES) | met | `NOTES.md`; phase commits | C20 decisions recorded in NOTES. |
| E11 (commit per phase) | met | `git log` shows the phase commits, the four review-fix commits, and this review | |
| E12 (plain English summary) | met | Commit messages and `NOTES.md` | |
| F risks and open questions | met, note | Wrong keyFields: guide, F8, doctor warning. Legitimate repeats: `allowRepeat`. Annotations: `trustIdempotentHint`, doctor reasons. SDK pin: `~2.3.1`. Single machine only: stated up front | `commandExists` adds a deterministic "command not found" on Windows; recommended for acceptance. |

## 2. Required C17 test IDs

Every required test exists and passes. Evidence is the file and the test name.

| ID | Status | Evidence (file, test name) |
|---|---|---|
| F1 | met | `packages/core/test/fingerprint.test.ts`, `F1: key order at any depth never changes the fingerprint` (property) |
| F2 | met | `fingerprint.test.ts`, `F2: changing any value in a selected field always changes the fingerprint` |
| F3 | met | `fingerprint.test.ts`, `F3: changing a field outside keyFields never changes the fingerprint` |
| F4 | met | `fingerprint.test.ts`, number normaliser accepts one form and rejects bad values with clear errors |
| F5 | met | `fingerprint.test.ts`, `F5: a Date and the matching ISO string give different fingerprints` |
| F6 | met | `fingerprint.test.ts`, NaN, Infinity, function, symbol, circular each throw with the field path |
| F7 | met | `fingerprint.test.ts`, `F7: same arguments with a different tool, server, or scope give different fingerprints` |
| F8 | met | `fingerprint.test.ts`, `F8: the Kola case gives one fingerprint when the reason text is rephrased` |
| F9 | met | `fingerprint.test.ts`, `F9: golden fingerprints never change`; `test/golden-fingerprints.json`; CI on 3 OS and Node 22/24 |
| C1 | met | `classify.test.ts`, eleven tests covering every C3 row, including config beating `destructiveHint` |
| C2 | met | `classify.test.ts`, every C7 category and `classifyToolResult` mapping |
| C3 | met | `classify.test.ts`, thrown strings, numbers, null, undefined, plain objects, functions, hostile getters, Proxy |
| C4 | met | `errors.test.ts`, `C4: every TwiceshyError code has non-empty what, why, and fix, and toJSON() output has no stack trace` |
| C5 | met | `guard.test.ts`, `C5: the user's own error reaches the caller as the identical object` |
| D1 | met | `engine.test.ts`, `D1: the decision table implements every row of C6` |
| D2 | met | `engine.test.ts`, `D2: window boundaries...` |
| D3 | met | `guard.test.ts`, `D3: in-flight wait returns the first call's result, or IN_PROGRESS when the wait runs out` |
| D4 | met | `engine.test.ts` and `guard.test.ts`, lease renewal while alive |
| D5 | met | `engine.test.ts` and `guard.test.ts`, late completion including another caller's in-doubt and human resolution cases |
| D6 | met | `guard.test.ts`, `D6: resolve as succeeded makes the next call a duplicate...` |
| D7 | met | `engine.test.ts` and `guard.test.ts`, repeat grant allows one execution |
| D8 | met | `engine.test.ts` and `guard.test.ts`, key conflict |
| D9 | met | `engine.test.ts` and `guard.test.ts`, cancellation during execution leaves IN_DOUBT |
| X1 | met | `guard-concurrency.test.ts`, 100 simultaneous calls on MemoryStore |
| X2 | met | `test/stress/x2-multiprocess.stress.test.ts`, 4 child processes, one shared SQLite file |
| X3 | met | `test/stress/x3-crash.stress.test.ts`, SIGKILL mid-action, next process sees IN_DOUBT |
| X4 | met | `test/stress/x4-parallel.stress.test.ts`, 1,000 different actions, no false duplicates |
| S1 | met | `memory-store.test.ts` and `sqlite-store.test.ts` run the shared contract in `stores/contract.ts` |
| S2 | met | `sqlite-store.test.ts`, missing folders created; unwritable path names the full path |
| S3 | met | `sqlite-store.test.ts`, v0 fixture migrates to version 2 without row loss |
| S4 | met | `guard.test.ts`, closed refuses, open bypasses and fires `guard-bypassed` |
| S5 | met | `guard.test.ts`, result returned and `store-write-failed` emitted |
| S6 | met | `sqlite-store.test.ts`, raw DB and WAL bytes contain neither fake card number, PIN, nor result-field secret |
| S7 | met | `stores/contract.ts` and `guard.test.ts`, purge removes only past-retention records and never unresolved IN_DOUBT |
| S8 | met | `sqlite-store.test.ts`, over-limit results fail with RESULT_TOO_LARGE and storeResult false stores nothing |
| P1 | met | `proxy.test.ts`, merge, prefix, annotations and `_meta` exact, pagination |
| P2 | met | `proxy-guard.test.ts`, three retries, one charge, duplicate text and `_meta` |
| P3 | met | `proxy-guard.test.ts`, the Kola scenario with late completion |
| P4 | met | `proxy-guard.test.ts`, unguarded and read-only forward untouched, no record |
| P5 | met | `proxy.test.ts`, failed server does not stop the proxy, `twiceshy_status` reports it |
| P6 | met | `proxy-resilience.test.ts` and `restart.test.ts`, backoff schedule |
| P7 | met | `proxy-resilience.test.ts`, progress and cancellation forwarding |
| P8 | met | `proxy-resilience.test.ts`, sampling and elicitation return UNSUPPORTED_FEATURE |
| P9 | met | `p9-stdio.test.ts`, real binary over stdio, JSON-RPC only on stdout |
| P10 | met | `config.test.ts` and `proxy.test.ts`, config errors list every problem |
| P11 | met | `p11-shutdown.test.ts`, SIGTERM waits for in-flight, exits 0 |
| P12 | met | `proxy-tools.test.ts`, no proxy tool can resolve, delete, purge, or approve |
| L1 | met | `cli-commands.test.ts`, help and exit codes |
| L2 | met | `cli-commands.test.ts`, doctor snapshot for one working and one broken server |
| L3 | met | `cli-commands.test.ts`, purge confirmation |
| K1 | met | `pnpm check:package` passes publint and attw for both packages |
| K2 | met | `scripts/test-pack.mjs` builds fresh tarballs, ESM import, CJS require, `npx twiceshy --help` |
| K3 | met | `packaging.test.ts`, core runtime dependencies are zod only, better-sqlite3 optional peer |
| C20.1 | met | `stores/contract.ts`, "complete refuses a write from anything but the claiming attempt token" and "a stale completion leaves a newer attempt alone"; `guard.test.ts`, "a late result upgrades an IN_DOUBT record through late completion even when the re-read failed" and "a late completion never overwrites a newer attempt claimed by another process"; `engine.test.ts`, the `completeRecord (C20 rule 1)` block |
| C20.2 | met | `engine.test.ts`, "an in-doubt record is upgraded through late completion"; `guard.test.ts`, late completion after timeout and after another caller put the record in doubt |
| C20.3 | met | `stores/contract.ts`, "a late success against a human "failed" decision reports a conflict and blocks with IN_DOUBT" and "a result that agrees with the human resolution changes nothing"; `guard.test.ts`, "a late success against a human "failed" resolution emits resolution-conflict and blocks the retry" and "a resolution made while the action runs is never overwritten silently" |
| C20.4 | met | `engine.test.ts`, "C20.4: a cancellation before start is a definite failure"; `guard.test.ts`, the two C20.4 tests |
| C20.5 | met | `proxy-secrets.test.ts`, "a downstream error containing a secret never appears at warn or info level" and "the full downstream message appears only at debug level" |
| C20.6 | met | `sqlite-store.test.ts`, "S6: a structured result with secret fields never reaches the database files"; `proxy-secrets.test.ts`, duplicate `_meta` and `storeResult: false` tests; `stores/contract.ts`, "C20.6: storeResult false stores no result at all" |
| C20.7 | met | `doctor-output.test.ts`, "masks a value resolved from ${VAR} that the failing server printed to its stderr"; `proxy-secrets.test.ts`, masking unit tests and `resolvedEnvValues` test |
| C20.8 | met | `guard.test.ts`, "C20.8: errorSummary is a safe description that never contains the raw message"; `cli-commands.test.ts`, the show test asserts the summary and the absence of `socket hang up` |
| C20.10 | met | `proxy-resilience.test.ts`, "C20.10: a failed resource or prompt listing is logged at warn and shown in status and doctor" |
| commandExists | met | `downstream-startup.test.ts`, absolute path, bare PATH command, PATHEXT, and missing command |

## 3. Places the code does something the spec does not describe

1. Guard API extras: `Guard.purge()`, options `maxResultBytes`, `timeoutMs`, `leaseMs`, `closeTimeoutMs`, `closeStore`, hooks `onGuardBypassed`, `onWarning`, `onResolutionConflict`, event type `resolution-conflict`. Accepted by C20.13.
2. `GuardOutcome.originalAt` may be `null`. Accepted by C20.11.
3. CLI requires `--by <name>` for `resolve` and `allow`, and supports `--log-level`, `--json`, and `--config` on every command, plus the `mcp-proxy` bin alias. Accepted by C20.12.
4. Proxy config keys beyond the C13 example: `cwd`, per-tool `ignoreFields`, `timeoutMs`, `storeResult`, `exposeRecentActions`, `store.type: "memory"`, top-level `retention`. Accepted by C20.14.
5. `ProxyConfig.resolvedEnvValues` is an internal field added by C20.7 so doctor and the proxy can mask known secrets. Not in C20.14's list; recommended for acceptance in section 9.
6. The proxy's own tools live in `proxy.ts`. Accepted by C20.15.
7. Unknown tool and unknown resource calls return `isError` text results; the spec does not fix their shape.
8. Extra repository files: `stryker.config.json`, `vitest.mutation.config.ts`, `vitest.stress.config.ts`, `vitest.global-setup.ts`, `.github/workflows/mutation.yml`, `scripts/test-pack.mjs`, `scripts/generate-schema.mjs`, `NOTES.md`, `SPEC-COMPLIANCE.md`. The first set is accepted by C20.15; `vitest.global-setup.ts` is recommended for acceptance in section 9.
9. `mask.ts` and `packages/mcp-proxy/test/fixtures/broken-surfaces-server.mjs` are new modules for C20.7 and C20.10. Recommended for acceptance.
10. `commandExists` pre-checks a stdio command before spawning so "command not found" is deterministic on Windows. Not described in C13; recommended for acceptance because the old behaviour reported a confusing handshake failure there.
11. CI runs Build before Test, the reverse of C18's listing order, so two parallel test workers cannot race over one `dist` folder. All C18 gates still run.
12. `complete()` returns `CompleteResult` and `BeginResult` records carry `attemptToken`. A spec-level interface change mandated by C20.1. Adapter authors see a new required field; the package is still 0.x.
13. `resultTruncated` means "the result was not stored in full"; with `storeResult: false` the record keeps no result and duplicates return a text summary. C20.6 requires the behaviour and `docs/limits.md` explains it.
14. When a human resolved as succeeded and a late result disagrees, the conflict is reported but the state is left alone (the next call is a duplicate anyway). C20.3 mandates the event; the no-write choice is the conservative reading.

## 4. TODO, FIXME, skipped, or commented tests

Method: `grep` for `TODO|FIXME|XXX|HACK` across `packages/`, `examples/`, `scripts/`, `docs/`, and for `.skip`, `.todo`, `.only`, `xit`, `xdescribe`, and commented-out `it(` lines.

- TODO, FIXME, XXX, HACK: none.
- Skipped or focused tests: none.
- `@ts-ignore` or `@ts-expect-error`: none. A few `biome-ignore` comments exist for the documented `${VAR}` placeholder and similar, each with a reason.
- Commented-out tests: none.

## 5. Every catch block

Source catches only (test and fixture catches excluded). Judgement is against C9 rule 1 as amended by C20.9: no empty catches; every catch handles fully, adds context and rethrows, converts to a `TwiceshyError` with `cause`, or carries a `// last resort:` comment explaining why there is nowhere left to report.

| Location | What it does | C9/C20 judgement |
|---|---|---|
| `guard.ts:280` | duration Zod validator returns false | follows |
| `guard.ts:291` | positive duration validator returns false | follows |
| `guard.ts:483` | captures the tool error into a settled result | follows: rethrown unchanged later (rule 2) |
| `guard.ts:797` | rethrows unless StoreUnavailable in open mode, then bypasses with event | follows |
| `guard.ts:916` | late completion failure logged to stderr | follows: logged |
| `guard.ts:958` | completion write failure emits `store-write-failed` and returns null | follows rule 3 |
| `guard.ts:967` | record re-read failure emits `warning` and returns null | follows: the write can no longer be fooled by it (C20.1) |
| `guard.ts:983` | lease renewal failure logged to stderr | follows: logged |
| `guard.ts:1011` | automatic purge failure emits `warning` | follows |
| `guard.ts:1087` | hook exception logged to stderr | follows: C15 requires exactly this |
| `guard.ts:1202` | stderr write failure | last resort: a broken stderr must never break a guarded call |
| `classify.ts:157` | unprintable value becomes a description | follows |
| `classify.ts:169` | throwing custom classifier becomes ambiguous plus warning | follows |
| `classify.ts:200` | default classifier crash becomes ambiguous | follows |
| `classify.ts:227` | result read failure becomes ambiguous | follows |
| `sqlite.ts:48` | missing better-sqlite3 converted to STORE_UNAVAILABLE with cause | follows |
| `sqlite.ts:179` | busy retry loop, rethrows other errors | follows |
| `sqlite.ts:203` | open failure converted with path; closes half-open handle | follows |
| `sqlite.ts:217` | close during cleanup failure | last resort: the open error below is the one the caller needs |
| `sqlite.ts:266` | JSON storage failure converted to NOT_SERIALIZABLE with cause | follows |
| `sqlite.ts:740` | raw database error converted to STORE_UNAVAILABLE with cause | follows |
| `memory.ts:19` | structuredClone failure converted to NOT_SERIALIZABLE with cause | follows |
| `downstream.ts:313` | `commandExists` stat failure | follows: the search continues and reports not-found |
| `downstream.ts:418` | startup failure converted to a typed startup failure | follows |
| `downstream.ts:497` | close failure logged as warn, class name only below debug | follows |
| `downstream.ts:608` | restart failure logged as warn, class name only below debug | follows |
| `downstream.ts:647` | wraps unknown connect errors into startup failure | follows |
| `cli.ts:214` | argument parse converted to CliUsageError | follows |
| `cli.ts:246` | bad duration converted to CliUsageError with example | follows |
| `cli.ts:875` | usage errors print help, exit 2 | follows |
| `cli.ts:897` | other errors printed as what/why/fix by caller | follows |
| `cli.ts:953` | top-level failure prints and sets exit 1 | follows |
| `restart.ts:67` | failed recovery sets `recovered = false` | follows: caller logs |
| `logger.ts:112` | closed stream write failure | last resort: there is nowhere left to report this |
| `proxy.ts:343` | startup failure closes downstreams then rethrows | follows |
| `proxy.ts:684` | unguarded forward failure converted to `downstreamUnavailable` | follows |
| `proxy.ts:713` | downstream tool error returned unchanged; Twiceshy errors become blocked results | follows rule 2 |
| `proxy.ts:745` | tool list refresh failure logged as error | follows |
| `proxy.ts:772` | resources refresh failure logged as warn and recorded for status/doctor | follows C20.10 |
| `proxy.ts:792` | prompts refresh failure logged as warn and recorded | follows C20.10 |
| `proxy.ts:806` | guard close during shutdown logged at warn | follows C20.9 (fixed this pass) |
| `proxy.ts:817` | server close failure logged as warn | follows |
| `proxy.ts:828` | connect failure closes handle then rethrows | follows |
| `config.ts:57` | duration validator returns false | follows |
| `config.ts:429` | config read failure converted to CONFIG_INVALID with cause message | follows |
| `config.ts:441` | JSON parse failure converted to CONFIG_INVALID with cause message | follows |

Summary: every catch handles its error, and the three with nowhere left to report carry a `// last resort:` comment. C9 rule 1 now holds without exception.

## 6. Places a secret could reach a log, an error message, or the database

| Path | What happens | Judgement |
|---|---|---|
| Arguments before storage | `redact(args, options.redact)` runs before `begin`; default list plus caller fields; S6 passes | Safe. |
| Results before storage | `redactReporting` runs before `complete`; the record keeps the redacted copy and `resultRedacted`; S6 extended to results passes | Safe (new this pass). |
| Proxy logs | Below debug the event error is reduced to name, code, and classification; `proxy-secrets.test.ts` proves the secret does not appear at warn or info and appears only at debug | Safe; debug is documented as sensitive. |
| Downstream stderr forwarding | Forwarded lines are passed through the resolved-env masker; values shorter than six characters are left alone per C20.7 | Safe for known config values; unknown downstream text at debug is documented. |
| Doctor and `twiceshy_status` output | Failure `what`, `why`, `fix`, `target`, `stderr`, and surface-failure messages are masked with `resolvedEnvValues`; doctor test passes | Safe (new this pass). |
| Config environment variables | Missing variables are reported by name only; resolved values are never in error text and are now masked wherever diagnostics print them | Safe. |
| Blocked and duplicate results to the agent | Blocked results contain `what`, `why`, `fix` only; duplicates return the stored redacted result plus record id and time | Safe. |
| Twiceshy errors | Detail fields are paths, record ids, fingerprints, and field names; `toJSON` never includes a stack | Safe. |
| Internal stderr lines in the core library | `guard.ts` prints store/hook failure messages; these are Twiceshy or store text, never downstream tool text | Low; no level system exists in the core library. Recommended for acceptance in section 9. |
| Scope values in the database | Scope is stored and appears in logs; scope is often a customer id, expected per spec | Expected. |

## 7. Dependencies

Prod means it ships to users; dev means build and test only. Versions are from the manifests.

| Package | Version | Where | Why it is needed |
|---|---|---|---|
| `zod` | ^4.6.5 | core dep, proxy dep | Runtime validation per C1/C11; the only core runtime dependency, proven by K3. |
| `better-sqlite3` | ^13.0.3 | core optional peer, proxy dep, dev | SQLite store per C1/C12. |
| `@modelcontextprotocol/client` | ~2.3.1 | proxy dep | MCP client side, C1/C13, minor-pinned per risk F. |
| `@modelcontextprotocol/server` | ~2.3.1 | proxy dep | MCP server side. |
| `twiceshy` | workspace:* | proxy dep, examples | The proxy uses the guard library. |
| `typescript` | ~5.9.3 | dev | Strict TypeScript per C1/C18. |
| `vitest` | ^4.1.11 | dev, core optional peer | Test runner per C1; peer entry lets adapter maintainers run the contract suite. |
| `@vitest/coverage-v8` | ^4.1.11 | dev | Coverage thresholds per C17. |
| `fast-check` | ^4.10.2 | core dev | Property tests F1 to F3. |
| `tsup` | ^8.5.1 | dev | ESM and CJS builds plus types. |
| `@types/better-sqlite3` | ^7.6.12 | dev | Types for the optional SQLite driver. |
| `@types/node` | ^22.13.0 | dev | Node 22 compatibility types. |
| `@biomejs/biome` | ^2.5.15 | dev | Lint and format, including the `any` ban and proxy console rules. |
| `@changesets/cli` | ^3.0.3 | dev | Release notes and versioning. |
| `publint` | ^0.3.25 | dev | Package correctness per K1. |
| `@arethetypeswrong/cli` | ^0.18.5 | dev | Types correctness per K1. |
| `@stryker-mutator/core` | 10.0.0 | dev | Mutation testing, accepted by C20.16. |
| `@stryker-mutator/vitest-runner` | 10.0.0 | dev | Stryker runner for Vitest. |

No dependency is unused: lint, typecheck, build, and check:package pass, and K3 proves the core runtime list is zod only.

## 8. Gate results (real output)

### 8.1 C18 gates

```
$ pnpm install --frozen-lockfile

Done in 432ms using pnpm v10.6.1
EXIT=0

$ pnpm typecheck
> pnpm -r --filter="./packages/*" exec tsc --noEmit

EXIT=0

$ pnpm lint

Checked 94 files in 296ms. No fixes applied.
EXIT=0

$ pnpm test
 Test Files  28 passed (28)
      Tests  503 passed (503)
File             | % Stmts | % Branch | % Funcs | % Lines
All files        |   96.16 |     90.5 |   96.51 |   96.24
  classify.ts    |     100 |      100 |     100 |     100
  engine.ts      |     100 |      100 |     100 |     100
  fingerprint.ts |     100 |      100 |     100 |     100
  redact.ts      |     100 |      100 |     100 |     100
EXIT=0

$ pnpm build
EXIT=0

$ pnpm check:package
packages/core check:package:  No problems found
packages/mcp-proxy check:package: All good!
packages/mcp-proxy check:package:  No problems found
EXIT=0
```

attw prints one informational "ignored per resolution" note for the core package's contract export; it is excluded from the gating check by the package's own `--exclude-entrypoints`, and the gate exits 0.

### 8.2 test:stress, five runs

```
stress run 1: Test Files 3 passed (3), Tests 3 passed (3)
stress run 2: Test Files 3 passed (3), Tests 3 passed (3)
stress run 3: Test Files 3 passed (3), Tests 3 passed (3)
stress run 4: Test Files 3 passed (3), Tests 3 passed (3)
stress run 5: Test Files 3 passed (3), Tests 3 passed (3)
```

Tests: X2 multi-process, X3 crash recovery, X4 1,000 parallel actions.

### 8.3 test:pack

```
[test:pack] esm ok
[test:pack] cjs ok
[test:pack] npx twiceshy --help ok
[test:pack] K3 ok: core dependencies are zod only
[test:pack] all packaging checks passed
```

### 8.4 test:mutation

```
Instrumented 4 source file(s) with 847 mutant(s)
All files       |  96.81 |   96.81 |      814 |         6 |         27 |        0 |        0
 classify.ts    |  96.60 |   96.60 |      199 |         0 |          7 |        0 |        0
 engine.ts      |  99.06 |   99.06 |      210 |         0 |          2 |        0 |        0
 fingerprint.ts |  96.51 |   96.51 |      327 |         5 |         12 |        0 |        0
 redact.ts      |  92.94 |   92.94 |       78 |         1 |          6 |        0 |        0
Final mutation score of 96.81 is greater than or equal to break threshold 85
```

The surviving mutants are the equivalent mutants explained in `NOTES.md`, "Mutation testing equivalents (Phase 6.1)".

### 8.5 Continuous integration

GitHub Actions run `38253032405` on `main`: all six jobs completed successfully.

```
Node 24 on ubuntu-latest: success
Node 24 on windows-latest: success
Node 24 on macos-latest: success
Node 22 on ubuntu-latest: success
Node 22 on windows-latest: success
Node 22 on macos-latest: success
```

## 9. Problems

The list is empty apart from the items below, each of which I recommend accepting.

1. **CI runs Build before Test.** C18 lists Test before Build. The swap is needed so two parallel test workers never race over one `dist` folder. Every C18 gate still runs, in every job. Recommended: accept.
2. **`vitest.global-setup.ts` builds once before workers start.** Extra root file, outside C16's list. It makes the real-binary tests deterministic on every platform. Recommended: accept.
3. **`mask.ts` is a new proxy module.** C20.7 needs a shared masker for config, downstream, and CLI code; C16's layout has no better home. Recommended: accept.
4. **`ProxyConfig.resolvedEnvValues` is new internal config state.** C20.14 lists other extras but not this one. It holds the values C20.7 asks Twiceshy to mask, and is never printed. Recommended: accept.
5. **`commandExists` pre-checks a stdio command.** Extra behaviour beyond C13. It makes "command not found" deterministic on Windows, where a missing command used to surface as a confusing handshake failure. Recommended: accept.
6. **Core library stderr lines have no log level.** C20.5's rule is written for the proxy's leveled events; the core library writes store and hook failure messages to stderr without levels. The messages are Twiceshy or store text, not downstream tool text. Recommended: accept, and revisit if the core ever grows a logger.
7. **`complete()` now returns a value and records carry `attemptToken`.** A C20.1-mandated interface change that external store authors must adopt. The packages are still 0.x and the contract suite is updated. Recommended: accept.
8. **Phase 7 publish is pending.** Versions are 0.0.0. This is Joseph's `[HAND]` step. Recommended: accept, as expected.

## 10. Verdict

Every C18 gate passes; stress five times, packaging, and mutation pass; all six CI jobs are green on Windows, macOS, and Linux on Node 22 and 24. Every required C17 test exists and passes, and the C20 amendments are covered by named tests: conditional completion with an attempt token checked atomically in both stores, late results against in-doubt records and human resolutions, cancellation before start, safe logs, redacted results, masked environment values, safe error summaries, last-resort catch comments, and visible surface-listing failures. No release blocker remains. The eight items in section 9 are recommendations to accept, not defects.
