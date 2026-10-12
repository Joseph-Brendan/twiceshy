# SPEC Compliance Review

Phase 6.2 of SPEC.md, a strict review. The reviewer did not write the code and tried to find reasons to block the release. No code was changed in this step.

- Revision reviewed: `fc7beaf` (Phase 6.1: mutation testing), working tree clean apart from untracked debris noted at the end.
- Reviewer environment: macOS, pnpm 10.6.1, Node 24.10.0 for project scripts.
- Rule applied: an item is marked `met` only when code or a passing test proves it. Belief is not evidence. Every command in this document was run and the real output is in the appendix.

Status values: `met`, `partly met`, `not met`.

## 1. Spec sections

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Part A (how to use this document) | met | `SPEC.md` in repo root; phases committed in order (`git log`: Phase 1 to Phase 6.1 commits) | Process section. |
| B1 (the problem) | met (descriptive) | `README.md:1-12`, `docs/choosing-key-fields.md:16-41` (Kola case) | No code obligation. |
| B2 (what Twiceshy is) | met | `packages/core/package.json` name `twiceshy`; `packages/mcp-proxy/package.json` name `@twiceshy/mcp-proxy`, bin `twiceshy` | Both forms ship. |
| B3 (goals) | met | Goal 1: `engine.test.ts:174` D1, `engine.test.ts:243` D2, stress X2/X3/X4. Goal 2: `guard.test.ts` IN_DOUBT tests. Goal 3: `examples/`, one-line proxy config. Goal 4: records in stores, `GuardEvent` in `guard.ts:81-97`. Goal 5: `errors.ts:55-67`, `errors.test.ts:33` C4 | |
| B4 (non-goals) | met | No hosted service anywhere; no undo (nothing reverses actions); only Memory and Sqlite stores (`stores/`); keyFields declared by developer (`fingerprint.ts:162-192`); sampling and elicitation refused (`proxy.ts:743-748`), P8 | |
| B5 (existing work) | met (descriptive) | Positioning in `README.md` | No code obligation. |
| C1 (stack and versions) | met | Root `package.json`, package manifests. TypeScript 5.9.3, Node engines `>=22.14.0`, pnpm 10.6.1, tsup 8.5.1, Vitest 4.1.11, fast-check 4.10.2, Zod 4.6.5, better-sqlite3 13.0.3 (optional peer in core), MCP SDK `~2.3.1`, Biome 2.5.15, Changesets 3.0.3, publint 0.3.25, attw 0.18.5, GitHub Actions | Stryker 10.0.0 added by Phase 6.1 and not in the C1 table. |
| C2 (core concepts) | met | Defaults `guard.ts:32-37` (10m window, 7d retention); concepts in `engine.ts`, `fingerprint.ts`, `stores/types.ts` | |
| C3 (which actions are guarded) | met | `classify.ts:33-54` implements the exact rule order; `classify.test.ts:6-77` covers every row including `guard: false` beating `destructiveHint` | |
| C4 (the fingerprint) | met, note | `computeFingerprint` `fingerprint.ts:428-443`; canonical JSON `fingerprint.ts:43-141`; selection `162-231`; normalisers `275-393`; tests F1 to F9 | Code JSON-encodes each part before joining (`fingerprint.ts:432-440`) instead of joining raw parts as the spec string shows. This is a deliberate strengthening of the separator rule and does not change the contract. |
| C5 (record states) | met | `engine.ts:12-18`; state machine enforced in `engine.ts:159-202` | |
| C6 (decision table) | met | `decide` `engine.ts:143-203`, `afterExecution` `210-236`, `lateCompletion` `243-271`; atomic claiming `memory.ts:30-46` and `sqlite.ts:401-440`; lease `guard.ts:39-43`, renewal `guard.ts:973-1001`; edge rules `engine.ts:121-127`, `220-222`; tests D1 to D9, X1 to X4 | |
| C7 (classifying failures) | met | `classify.ts:83-229`; rules match the C7 lists; `classifyError` never throws (`classify.ts:192-205`); tests C2, C3 | |
| C8 (what callers receive) | met | Library `GuardOutcome` `guard.ts:201-218`; duplicate result `proxy.ts:156-185` with text matching the spec quote and `_meta["dev.twiceshy/outcome"]` (`proxy.ts:49`); blocked results are `isError: true` tool results (`proxy.ts:130-135`); tests P2, P3 | `originalAt` can be `null` (defensive) where C8 shows `Date`. |
| C9 (error design) | partly met | Nine codes and fields `errors.ts:8-18`, `47-85`; C4 test `errors.test.ts:33`; rules 2 and 3 implemented (`guard.ts:888-889`, `944-961`, S5 test) | Rule 1 is broken by several silent or empty catches, listed in section 4c. Rules 4 and 5 pass (Biome floating promise rule, redaction). |
| C10 (failure of Twiceshy itself) | met | `guard.ts:794-804` closed refuses, open bypasses with `guard-bypassed`; test `guard.test.ts:532` S4 | |
| C11 (library API) | met, note | `createGuard` `guard.ts:1106`, `wrap` `584-606`, `run` `573-582`, `list`, `get`, `resolve`, `allowRepeat`, `close` `608-666`; Zod validation lists all problems (`429-433`); ESM and CJS via tsup; core runtime dependency zod only | Extra API surface beyond the C11 example (`purge()`, `maxResultBytes`, `timeoutMs`, `leaseMs`, `closeTimeoutMs`, `closeStore`, hooks `onGuardBypassed` and `onWarning`). Listed in section 4a. |
| C12 (storage) | met | Interface `stores/types.ts:97-111`; WAL and busy timeout `sqlite.ts:171-200`; `BEGIN IMMEDIATE` `sqlite.ts:120-137` and transaction use `sqlite.ts:401-440`; folder creation `sqlite.ts:194`; migrations `120-137`, test `sqlite-store.test.ts:216` S3; retention and hourly purge `guard.ts:48-49`, `1003-1014`; redaction `redact.ts`, S6 `sqlite-store.test.ts:251`; contract S1 to S8 | |
| C13 (MCP proxy) | met, note | `config.ts` schema, `proxy.ts` merging and guarding, `downstream.ts` connect/restart; tests P1 to P12; stdout rule `logger.ts:53-65`, P9 | Extra config keys beyond the C13 example: `cwd`, per-tool `ignoreFields` and `timeoutMs`, `exposeRecentActions`, `store.type: "memory"`, and a second bin alias `mcp-proxy`. Listed in section 4a. |
| C14 (CLI) | met, note | `cli.ts` implements all seven commands; help with examples `cli.ts:81-146`; exit codes `cli.ts:872-908`; tests L1 to L3; doctor free-text warning `cli.ts:403-414` | `resolve` and `allow` require `--by <name>` (`cli.ts:120-139`), which the C14 table does not show. See section 4a. |
| C15 (observability) | met, note | Event shape `guard.ts:81-97`; hook isolation `guard.ts:1085-1089`; JSON lines to stderr `logger.ts:93-115`; levels and `--log-level` `cli.ts:887-890`; tests `guard.test.ts` hooks test, `logger.test.ts` | Events carry extra fields `reason`, `missing`, `error` beyond the C15 field list. The `error` field is a secret path, section 4d. |
| C16 (repository layout) | partly met | Structure is close: both packages, `src` modules, `stores/`, fixtures. Root has `vitest.workspace.ts`, `tsconfig.base.json`, `biome.json`, workflows | Deviations: `packages/mcp-proxy/src/tools/status.ts` does not exist (proxy tools live in `proxy.ts:450-500`); extra modules `logger.ts`, `restart.ts`, `version.ts`, `index.ts`, `stores/record.ts`, `stores/types.ts`; extra root files `stryker.config.json`, `vitest.mutation.config.ts`, `vitest.stress.config.ts`, `NOTES.md`, `scripts/`; extra workflow `mutation.yml`. See section 4a. |
| C17 (testing strategy) | met | 100 percent lines and branches on the four core modules (appendix gate 4); 453 tests in 27 files; required tests all present (section 2); property tests F1 to F3; contract suite S1; real multi-process X2, X3; proxy integration P1 to P12; story tests Kola (P3) and Ada parallel booking (`guard.test.ts:152` D3) | Mutation testing added in 6.1 at 96.62 percent, above the 85 percent bar. |
| C18 (quality gates) | met | Appendix: all six gates pass, plus stress five times, pack, and mutation | |
| C19 (documentation) | met | `README.md`, `packages/core/README.md`, `packages/mcp-proxy/README.md`, `docs/` five guides, `CITATION.cff` | |
| D kickoff | partly met | `NOTES.md` holds the v2 SDK notes | The kickoff response (unclear points, version check, Phase 0 plan) is not preserved in the repository, so it cannot be verified from code. |
| D Phase 0 | met | Skeleton commits `746dab8`, `459c27c`; all gates run from Phase 0 onward | |
| D Phase 1 | met | Commits `2a37236`, `d9eada7`, `3f0996a`, `04a882e`; F1 to F9 and C1 to C5 tests pass | |
| D Phase 2 | met | Commits `1ec2c71` to `4f32aaa`; D, X, S tests pass | |
| D Phase 3 | met | Commits `7e503fe`, `2a38dce`; P1 to P5, P9, P10, P12 pass | |
| D Phase 4 | met | Commits `2036755`, `7b3d536`, `571aa4e`; P6 to P8, P11, L1 to L3 pass | |
| D Phase 5 | met | Commits `ab63bb4`, `0f38cb7`; packaging, docs, examples, changeset present | |
| D Phase 6 | met | 6.1: commits `fc7beaf`, mutation score 96.62. 6.2: this document | |
| D Phase 7 (publish) | not met | `package.json` versions are 0.0.0; no npm publication attempted | This is a `[HAND]` step for Joseph and is expected to be pending. Nothing to block code quality. |
| E1 (spec is source of truth) | met | `NOTES.md` records spec interpretations; this review lists disagreements | |
| E2 (ask before building) | partly met | Open spec questions are recorded in `NOTES.md` Phase 2 rules | The chat history is not in the repository, so mid-phase questions cannot be verified. |
| E3 (read installed libraries) | met | `NOTES.md:23-44` documents the installed MCP SDK v2 API; Stryker configuration was written from the installed schema and runner source | |
| E4 (tests named by ID) | met | Every C17 ID exists with its ID in the test name (section 2) | |
| E5 (never weaken tests) | met | No `.skip`, `.todo`, `.only`, commented tests, or lowered thresholds found (section 4b) | |
| E6 (C9 rules, no any, no floating promises, no console.log in proxy) | partly met | Biome bans `any` and floating promises; proxy bans `console.log` with a test; `guard.ts:293` contains console.log only inside an example string, not code | C9 rule 1 breaks on empty catches (section 4c). |
| E7 (never log or store secrets) | partly met | Arguments redacted before storage `guard.ts:715`; default list `redact.ts:4-17`; S6 test passes | Result values are stored unredacted and proxy logs can include downstream error text; section 4d. |
| E8 (engine pure) | met | `engine.ts` imports only `./errors.js`; no clock, database, network, or file access | |
| E9 (run every gate, show output) | met | Appendix | |
| E10 (stay in phase, NOTES) | met | `NOTES.md`; phase commits | |
| E11 (commit per phase) | met | `git log` shows one commit per phase, named by phase | |
| E12 (plain English summary) | met | Phase summaries in commit messages and `NOTES.md` | |
| F risks and open questions | met, note | Wrong keyFields: guide, F8 test, doctor warning `cli.ts:403-414`. Legitimate repeats: `allowRepeat` plus clear IN_DOUBT text. Annotations: `trustIdempotentHint`, doctor reasons. SDK pin: `~2.3.1` in the manifest and CI runs. Single machine: stated up front in `README.md` and `docs/limits.md` | Open questions 1 to 3 (name, v1.1 presets, shared base layer) remain open by design; the name is settled as Twiceshy in code. |

## 2. Required C17 test IDs

Every required test exists and passes in `pnpm test` (453 tests) or in `test:stress`. Evidence is the file and the test name.

| ID | Status | Evidence (file, test name) |
|---|---|---|
| F1 | met | `packages/core/test/fingerprint.test.ts:509`, `F1: key order at any depth never changes the fingerprint` (property, 1000 runs) |
| F2 | met | `fingerprint.test.ts:521`, `F2: changing any value in a selected field always changes the fingerprint` |
| F3 | met | `fingerprint.test.ts:533`, `F3: changing a field outside keyFields never changes the fingerprint` |
| F4 | met | `fingerprint.test.ts:255`, `262`, `276`, number normaliser accepts one form and rejects bad values with clear errors |
| F5 | met | `fingerprint.test.ts:382`, `F5: a Date and the matching ISO string give different fingerprints` |
| F6 | met | `fingerprint.test.ts:387`, `395`, `408`, `415`, `422` cover NaN, Infinity, function, symbol, circular with field path |
| F7 | met | `fingerprint.test.ts:431`, `F7: same arguments with a different tool, server, or scope give different fingerprints` |
| F8 | met | `fingerprint.test.ts:444`, `F8: the Kola case gives one fingerprint when the reason text is rephrased` |
| F9 | met | `fingerprint.test.ts:576`, `F9: golden fingerprints never change`; `test/golden-fingerprints.json`, checked by CI on 3 OS and Node 22/24 |
| C1 | met | `packages/core/test/classify.test.ts:6-77`, eleven tests covering every C3 row, including config beating `destructiveHint` |
| C2 | met | `classify.test.ts:81-253`, every C7 category and `classifyToolResult` maps |
| C3 | met | `classify.test.ts:203-236`, thrown strings, numbers, null, undefined, plain objects, functions, hostile getters, Proxy |
| C4 | met | `packages/core/test/errors.test.ts:33`, `C4: every TwiceshyError code has non-empty what, why, and fix, and toJSON() output has no stack trace` |
| C5 | met | `packages/core/test/guard.test.ts:500`, `C5: the user's own error reaches the caller as the identical object` |
| D1 | met | `packages/core/test/engine.test.ts:174`, `D1: the decision table implements every row of C6` (table row per state and condition) |
| D2 | met | `engine.test.ts:243`, `D2: window boundaries...` with fake clock |
| D3 | met | `guard.test.ts:152`, `D3: in-flight wait returns the first call's result, or IN_PROGRESS when the wait runs out` |
| D4 | met | `engine.test.ts:256` and `guard.test.ts:190` (lease renewal while alive) |
| D5 | met | `engine.test.ts:399-433` and `guard.test.ts` late completion tests including another caller's in-doubt and human resolution cases |
| D6 | met | `guard.test.ts:379`, `D6: resolve as succeeded makes the next call a duplicate...` |
| D7 | met | `engine.test.ts:278` and `guard.test.ts:414` |
| D8 | met | `engine.test.ts:297` and `guard.test.ts:451` |
| D9 | met | `engine.test.ts:373` and `guard.test.ts:477` |
| X1 | met | `guard-concurrency.test.ts:9`, 100 simultaneous calls on MemoryStore |
| X2 | met | `test/stress/x2-multiprocess.stress.test.ts:41`, 4 child processes, one shared SQLite file |
| X3 | met | `test/stress/x3-crash.stress.test.ts:47`, SIGKILL mid-action, next process sees IN_DOUBT |
| X4 | met | `test/stress/x4-parallel.stress.test.ts:22`, 1,000 different actions, no false duplicates |
| S1 | met | `memory-store.test.ts:6` and `sqlite-store.test.ts:78` run the shared contract in `stores/contract.ts` |
| S2 | met | `sqlite-store.test.ts:84` and `:107` (missing folders created; unwritable path names the full path) |
| S3 | met | `sqlite-store.test.ts:216`, v0 fixture migrates without row loss |
| S4 | met | `guard.test.ts:532`, closed refuses, open bypasses and fires `guard-bypassed` |
| S5 | met | `guard.test.ts:559`, result returned and `store-write-failed` emitted |
| S6 | met | `sqlite-store.test.ts:251`, raw DB and WAL bytes contain neither fake card number nor PIN |
| S7 | met | `stores/contract.ts:575` and `guard.test.ts:732`, purge removes only past-retention records and never unresolved IN_DOUBT |
| S8 | met | `sqlite-store.test.ts:283`, over-limit results follow the summary behaviour |
| P1 | met | `proxy.test.ts:82`, merge, prefix, annotations and `_meta` exact, pagination |
| P2 | met | `proxy-guard.test.ts:50`, three retries, one charge, duplicate text and `_meta` |
| P3 | met | `proxy-guard.test.ts:86`, the Kola scenario with late completion |
| P4 | met | `proxy-guard.test.ts:124`, unguarded and read-only forward untouched, no record |
| P5 | met | `proxy.test.ts:180`, failed server does not stop the proxy, `twiceshy_status` reports it |
| P6 | met | `proxy-resilience.test.ts:52` and `restart.test.ts:9` (1s, 2s, 4s, 8s, 16s, five attempts) |
| P7 | met | `proxy-resilience.test.ts:149`, progress and cancellation forwarding |
| P8 | met | `proxy-resilience.test.ts:199`, sampling and elicitation return UNSUPPORTED_FEATURE |
| P9 | met | `p9-stdio.test.ts:28`, real binary over stdio, JSON-RPC only on stdout |
| P10 | met | `config.test.ts:36` (missing env, unknown field, bad window in one error) and `proxy.test.ts:216` (name collision in none mode) |
| P11 | met | `p11-shutdown.test.ts:63`, SIGTERM waits for in-flight, exits 0 |
| P12 | met | `proxy-tools.test.ts:44`, no proxy tool can resolve, delete, purge, or approve |
| L1 | met | `cli-commands.test.ts:117` (help and exit 0) and `:131` (usage exit 2, runtime exit 1) |
| L2 | met | `cli-commands.test.ts:561`, doctor snapshot for one working and one broken server |
| L3 | met | `cli-commands.test.ts:422` (refused confirmation) and `:441` (`--yes` purges and reports) |
| K1 | met | `pnpm check:package` passes publint and attw for both packages (appendix gate 6); manifest assertions in `packages/core/test/packaging.test.ts:52` |
| K2 | met | `scripts/test-pack.mjs` (run by `pnpm test:pack`): fresh temp project installs both packed tarballs, ESM import, CJS require, `npx twiceshy --help`. Implemented as a script, not a Vitest test. |
| K3 | met | `packaging.test.ts:68`, core runtime dependencies are zod only, better-sqlite3 optional peer |

## 3. Section 4a: places the code does something the spec does not describe

1. Guard API extras: `Guard.purge()` (`guard.ts:258`), options `maxResultBytes`, `timeoutMs`, `leaseMs`, `closeTimeoutMs`, `closeStore` (`guard.ts:135-150`), hooks `onGuardBypassed` and `onWarning`, event type `warning` (`guard.ts:70-119`). The C11 example does not show them.
2. Cancellation before the tool body starts still writes IN_DOUBT (`guard.ts:811-817`). C6 says a cancellation "while it was running" becomes IN_DOUBT. The widened behaviour is the safe direction but is not described.
3. `GuardOutcome.originalAt` may be `null` (`guard.ts:217`) where C8 shows `Date`.
4. `errorSummary` exists in the store schema and types (`stores/types.ts:29`, `sqlite.ts:228`) but the guard never passes it (`guard.ts:950-956`), so the column is always null in product use. Dead plumbing.
5. CLI requires `--by <name>` for `resolve` and `allow` (`cli.ts:120-139`), which C14's table omits. C11's library signatures do require `by`.
6. CLI extras beyond C14: `--log-level` (`cli.ts:91`), `--json` on every command, `--config` on every command (`cli.ts:170-176`), and a second bin alias `mcp-proxy` (`packages/mcp-proxy/package.json`).
7. Proxy config keys beyond the C13 example: `cwd` on stdio servers, per-tool `ignoreFields` and `timeoutMs`, `exposeRecentActions`, `store.type: "memory"`, and `retention` at the top level (`config.ts:88-133`). Some are described elsewhere in the spec (retention C12, ignoreFields C4, treatToolErrorsAsDefinite C7); the rest are not.
8. The proxy's own tools live in `proxy.ts:450-500`, not in `src/tools/status.ts` as C16's layout lists.
9. Unknown tool and unknown resource calls return `isError` text results (`proxy.ts:540-552`, `610-614`) where the spec does not say what shape these take.
10. Extra repository files not in C16: `stryker.config.json`, `vitest.mutation.config.ts`, `vitest.stress.config.ts` (C16 lists `vitest.workspace.ts`, which also exists), `.github/workflows/mutation.yml`, `scripts/test-pack.mjs`, `scripts/generate-schema.mjs`, `NOTES.md`, `SPEC-COMPLIANCE.md`.
11. When another process or a human changed the record during a local execution, the guard emits an `execute` event with reason `record already <state>` and returns the local result without writing anything (`guard.ts:863-870`). C6 describes this only as "uses the late-completion path".
12. `process.stderr.write` inside the core library (`guard.ts:1092-1097`) is an implicit output channel the spec does not mention for the library (C15 describes stderr for the proxy).

## 4. Section 4b: TODO, FIXME, skipped, or commented tests

Method: `grep` for `TODO|FIXME|XXX|HACK` across `packages/`, `examples/`, `scripts/`, `docs/` and for `.skip`, `.todo`, `.only`, `xit`, `xdescribe`, and commented-out `it(` lines.

- TODO, FIXME, XXX, HACK: none.
- Skipped or focused tests: none. No `.skip`, `.todo`, `.only`, `xit`, or `xdescribe`.
- `@ts-ignore` or `@ts-expect-error`: none. One `biome-ignore` comment in `config.ts:33` for the documented `${VAR}` placeholder.
- Commented-out tests: none.

The only matches were false positives such as a helper named `waitForExit` and `process.exit` inside fixtures.

## 5. Section 4c: every catch block

Source catches only (test and fixture catches excluded). Judgement is against C9 rule 1: no empty catches; every catch handles fully, adds context and rethrows, or converts to a `TwiceshyError` with `cause`.

| Location | What it does | C9 judgement |
|---|---|---|
| `guard.ts:274` | duration Zod validator returns false | follows: converts to invalid input. |
| `guard.ts:285` | positive duration validator returns false | follows. |
| `guard.ts:483` | captures the tool error into a settled result | follows: error rethrown unchanged later (rule 2). |
| `guard.ts:797` | rethrows unless StoreUnavailable in open mode, then bypasses with event | follows. |
| `guard.ts:916` | late completion failure logged to stderr | follows-ish: logged loudly, not silent. |
| `guard.ts:958` | completion write failure emits `store-write-failed` and returns false | follows rule 3. |
| `guard.ts:967` | record re-read failure emits `warning` and returns null | follows-ish: emits event; consequence noted in problems. |
| `guard.ts:983` | lease renewal failure logged to stderr | follows-ish: logged. |
| `guard.ts:1011` | automatic purge failure emits `warning` | follows. |
| `guard.ts:1087` | hook exception logged to stderr | follows: C15 requires exactly this. |
| `guard.ts:1095` | stderr write failure | breaks rule 1 literally: empty catch with a comment. Deliberate and harmless. |
| `classify.ts:157` | unprintable value becomes a description | follows. |
| `classify.ts:169` | throwing custom classifier becomes ambiguous plus warning | follows. |
| `classify.ts:200` | default classifier crash becomes ambiguous | follows. |
| `classify.ts:227` | result read failure becomes ambiguous | follows. |
| `sqlite.ts:48` | missing better-sqlite3 converted to STORE_UNAVAILABLE with cause | follows. |
| `sqlite.ts:179` | busy retry loop, rethrows other errors | follows. |
| `sqlite.ts:203` | open failure converted with path; closes half-open handle | follows. |
| `sqlite.ts:207` | close during cleanup failure | breaks rule 1 literally: empty catch with a comment; the real error is rethrown below. |
| `sqlite.ts:266` | JSON storage failure converted to NOT_SERIALIZABLE with cause | follows. |
| `sqlite.ts:740` | raw database error converted to STORE_UNAVAILABLE with cause, Twiceshy errors rethrown | follows. |
| `memory.ts:19` | structuredClone failure converted to NOT_SERIALIZABLE with cause | follows. |
| `downstream.ts:320` | surface listing failure logged at debug and treated as empty | partially follows: swallowed without a visible error; a real list failure looks like "no resources". |
| `downstream.ts:367` | startup failure converted to a typed startup failure | follows. |
| `downstream.ts:399` | close failure logged as warn | follows-ish: logged. |
| `downstream.ts:507` | restart failure logged as warn and returns false | follows-ish: logged; caller schedules next attempt. |
| `downstream.ts:545` | wraps unknown connect errors into startup failure | follows. |
| `cli.ts:213` | argument parse converted to CliUsageError | follows. |
| `cli.ts:244` | bad duration converted to CliUsageError with example | follows. |
| `cli.ts:875` | usage errors print help, exit 2; other errors printed as what/why/fix by caller | follows. |
| `cli.ts:897` | same as above for another command group | follows. |
| `cli.ts:953` | top-level failure prints and sets exit 1 | follows. |
| `restart.ts:67` | failed recovery sets `recovered = false` | follows: state machine, caller logs. |
| `logger.ts:112` | closed stream write failure | breaks rule 1 literally: empty catch with a comment. Acceptable but literal break. |
| `proxy.ts:329` | startup failure closes downstreams then rethrows | follows. |
| `proxy.ts:630` | unguarded forward failure converted to `downstreamUnavailable` | follows. |
| `proxy.ts:659` | downstream tool error returned unchanged; Twiceshy errors become blocked results; others become DOWNSTREAM_UNAVAILABLE | follows rule 2. |
| `proxy.ts:691` | tool list refresh failure logged as error | follows-ish: logged. |
| `proxy.ts:704` | resources refresh failure logged as error | follows-ish: logged. |
| `proxy.ts:717` | prompts refresh failure logged as error | follows-ish: logged. |
| `proxy.ts:764` | guard close during shutdown swallowed with `.catch(() => undefined)` | breaks rule 1: empty handler, no log. |
| `proxy.ts:769` | server close failure logged as warn | follows-ish: logged. |
| `proxy.ts:780` | resource list failure returns `[]` silently | breaks rule 1 in spirit: no log, no event. |
| `proxy.ts:789` | prompt list failure returns `[]` silently | breaks rule 1 in spirit: no log, no event. |
| `proxy.ts:808` | connect failure closes handle then rethrows | follows. |
| `config.ts:56` | duration validator returns false | follows. |
| `config.ts:428` | config read failure converted to CONFIG_INVALID with cause message | follows. |
| `config.ts:439` | JSON parse failure converted to CONFIG_INVALID with cause message | follows. |

Summary: 41 of the 48 catches follow the rules, 6 break rule 1 either literally (`guard.ts:1095`, `sqlite.ts:207`, `logger.ts:112`, `proxy.ts:764`) or in spirit by returning an empty list with no log (`proxy.ts:780`, `proxy.ts:789`), and 1 logs only at debug level (`downstream.ts:320`). This is why C9 is marked `partly met`.

## 6. Section 4d: places a secret could reach a log, an error message, or the database

| Path | What happens | Judgement |
|---|---|---|
| Arguments before storage | `redact(args, options.redact)` runs before `begin` (`guard.ts:715`), default list plus caller fields (`redact.ts:4-17`, `98-101`). S6 passes. | Safe. |
| Results in the database | Results are JSON encoded and stored without redaction (`guard.ts:950-956`, `sqlite.ts:346-364` COMPLETE_WITH_RESULT_SQL). A tool result that echoes a secret (for example a newly issued key) is persisted. | Spec only mandates argument redaction (C12), so this is letter compliant. Flagged as a real risk because results can contain secrets. |
| Proxy logs | `logGuardEvent` logs the whole event (`proxy.ts:222-252`) and events can carry the original tool error (`guard.ts:886`). The default level `warn` includes in-doubt failures. A downstream API error message that echoes a secret reaches stderr logs. | Undocumented and real. Fix belongs in a later phase (do not log raw `error`). |
| Doctor and shutdown child stderr | `downstream.ts` captures child stderr for diagnostics and doctor prints those lines (`cli.ts:516-517`). A downstream server that prints a secret leaks it into console output. | Real but outside Twiceshy's own secrets; the child chose to print it. Worth a note in limits. |
| Config environment variables | Missing variables are reported by name only (`config.ts:271-286`); resolved values are never included in error text. Doctor prints `command` or `url`, not `env` (`cli.ts:367-380`). | Safe. |
| Blocked and duplicate results to the agent | Blocked results contain `what`, `why`, `fix` only (`proxy.ts:130-135`); duplicate results add record id plus ISO time (`proxy.ts:156-185`). No cause, no args. | Safe. |
| Twiceshy errors | Detail fields are paths, record ids, fingerprints, and field names; `toJSON` never includes a stack (`errors.ts:70-85`). | Safe. |
| Internal stderr lines | `guard.ts:917`, `984`, `1088`, `1094` print `error.message` for store and hook failures. Twiceshy's own messages do not contain secret values; a store implementation's message could in theory. | Low. |
| Scope values in the database | `scope` is stored and appears in logs (`guard.ts:1078`). Scope is often a customer id, personal data rather than a secret, and the spec defines it. | Expected per spec. |

## 7. Section 4e: dependencies

Prod dependency means it ships to users; dev means build and test only.

| Package | Version | Where | Why it is needed |
|---|---|---|---|
| `zod` | ^4.6.5 | core dep, proxy dep | Runtime validation of guard options and proxy config, per C1 and C11. Only core runtime dependency, K3 proves it. |
| `better-sqlite3` | ^13.0.3 | core optional peer, proxy dep, dev | SQLite file store with atomic transactions per C1 and C12. Optional in core so library users can stay dependency free. |
| `@modelcontextprotocol/client` | ~2.3.1 | proxy dep | MCP client side of the proxy, C1 and C13. Minor pinned per risk F. |
| `@modelcontextprotocol/server` | ~2.3.1 | proxy dep | MCP server side of the proxy. |
| `twiceshy` | workspace:* | proxy dep, examples | The proxy uses the guard library, C13. |
| `typescript` | ~5.9.3 | root dev, package dev | Strict TypeScript per C1 and C18. |
| `vitest` | ^4.1.11 | root dev, core optional peer | Test runner per C1; the peer entry lets adapter maintainers run the contract suite. |
| `@vitest/coverage-v8` | ^4.1.11 | root dev | Coverage reporting and thresholds per C17. |
| `fast-check` | ^4.10.2 | core dev | Property tests F1 to F3 per C1 and C17. |
| `tsup` | ^8.5.1 | package dev | ESM and CJS builds plus types per C1. |
| `@types/better-sqlite3` | ^7.6.12 | core dev, proxy dev | Types for the optional SQLite driver. |
| `@types/node` | ^22.13.0 | root dev, package dev | Node types for 22 compatibility. |
| `@biomejs/biome` | ^2.5.15 | root dev | Lint and format per C1, including the `any` ban and proxy console rules. |
| `@changesets/cli` | ^3.0.3 | root dev | Release notes and versioning per C1. |
| `publint` | ^0.3.25 | root dev | Package correctness per C1 and K1. |
| `@arethetypeswrong/cli` | ^0.18.5 | root dev | Types correctness per C1 and K1. |
| `@stryker-mutator/core` | 10.0.0 | root dev | Mutation testing added in Phase 6.1. Not in the C1 table. |
| `@stryker-mutator/vitest-runner` | 10.0.0 | root dev | Stryker runner for Vitest, Phase 6.1. |

No dependency is unused: `pnpm lint` and the build pass, and `packages/core/test/packaging.test.ts:68` proves the core runtime list is zod only.

## 8. Gate results (real output)

### 8.1 C18 gates

```
$ pnpm install --frozen-lockfile
Done in 420ms using pnpm v10.6.1
EXIT=0

$ pnpm typecheck
(no output)
EXIT=0

$ pnpm lint
Checked 90 files in 187ms. No fixes applied.
EXIT=0

$ pnpm test
 Test Files  27 passed (27)
      Tests  453 passed (453)
File             | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
All files        |   96.71 |    90.67 |   96.89 |   96.85 |
  classify.ts    |     100 |      100 |     100 |     100 |
  engine.ts      |     100 |      100 |     100 |     100 |
  fingerprint.ts |     100 |      100 |     100 |     100 |
  redact.ts      |     100 |      100 |     100 |     100 |
EXIT=0

$ pnpm build
EXIT=0

$ pnpm check:package
packages/core check:package: All good!
packages/core check:package:  No problems found
packages/mcp-proxy check:package: All good!
packages/mcp-proxy check:package:  No problems found
EXIT=0
```

### 8.2 test:stress, five runs

```
RUN 1: EXIT=0  DURATION=5s   Test Files 3 passed, Tests 3 passed
RUN 2: EXIT=0  DURATION=4s   Test Files 3 passed, Tests 3 passed
RUN 3: EXIT=0  DURATION=4s   Test Files 3 passed, Tests 3 passed
RUN 4: EXIT=0  DURATION=4s   Test Files 3 passed, Tests 3 passed
RUN 5: EXIT=0  DURATION=4s   Test Files 3 passed, Tests 3 passed
```

Tests: X2 multi-process, X3 crash recovery, X4 1,000 parallel actions.

### 8.3 test:pack

```
[test:pack] building both packages
[test:pack] packed twiceshy-0.0.0.tgz
[test:pack] packed twiceshy-mcp-proxy-0.0.0.tgz
[test:pack] installing tarballs and better-sqlite3 into a fresh project
[test:pack] esm ok
[test:pack] cjs ok
[test:pack] npx twiceshy --help ok
[test:pack] K3 ok: core dependencies are zod only
[test:pack] all packaging checks passed
EXIT=0
```

### 8.4 test:mutation

```
Instrumented 4 source file(s) with 770 mutant(s)
Initial test run succeeded. Ran 364 tests in 1 second
File            | total | # killed | # timeout | # survived | # no cov | # errors
All files       | 96.62 |      738 |         6 |         26 |        0 |        0
 classify.ts    | 96.60 |      199 |         0 |          7 |        0 |        0
 engine.ts      | 98.58 |      139 |         0 |          2 |        0 |        0
 fingerprint.ts | 96.51 |      327 |         5 |         12 |        0 |        0
 redact.ts      | 93.67 |       73 |         1 |          5 |        0 |        0
Final mutation score of 96.62 is greater than or equal to break threshold 85
Done in 36 seconds.
EXIT=0
```

The 26 surviving mutants are the equivalent mutants explained in `NOTES.md`, "Mutation testing equivalents (Phase 6.1)".

## 9. Problems, in priority order

### Could cause a duplicate action or leak a secret

1. **Unverifiable completion write after a store read failure.** `finishExecute` treats a failed re-read as "still in flight" (`guard.ts:964-971` returning null, then `873`), and `complete()` has no state or ownership precondition (`sqlite.ts:348-364`). If the read fails after another process or a human already decided the record, the local call can still write a result over it. Needs a conditional update (only when state is IN_FLIGHT and owned by this attempt) in a later phase.
2. **Raw tool errors are logged.** `logGuardEvent` logs the whole event (`proxy.ts:222-252`), and in-doubt events can carry the original tool error (`guard.ts:883-887`). The default `warn` level logs in-doubt failures, so a downstream error message containing a secret reaches stderr logs. Undocumented and should be redacted or reduced to the message summary.
3. **Results are stored unredacted.** `complete()` stores the JSON result as-is (`guard.ts:950-956`, `sqlite.ts:346-364`). A result that echoes a secret lands in the audit database. The spec only requires argument redaction, so this is flagged as a risk, not a spec break.
4. **Downstream child stderr is printed by doctor.** Diagnostics capture child stderr and doctor prints it (`cli.ts:516-517`). A downstream server printing secrets leaks them into console output.

### Break the spec

5. **C9 rule 1, empty or silent catches.** `guard.ts:1095`, `sqlite.ts:207`, `logger.ts:112`, `proxy.ts:764` are literal empty catches. `proxy.ts:780` and `proxy.ts:789` silently return empty lists, and `downstream.ts:320` logs only at debug. Six rule breaks in total, plus one debug-only log.
6. **C16 layout deviation.** `tools/status.ts` does not exist and several extra modules and root files exist (section 4a, item 8 and 10).
7. **CLI `--by` flag is not in the C14 table.** `resolve` and `allow` fail without it (`cli.ts:120-139`). C11 does require a person name in the library, so this is a documentation gap more than a design gap.
8. **`GuardOutcome.originalAt` is nullable** (`guard.ts:217`) where C8 shows `Date`.

### Everything else

9. **Stray working tree files.** `pnpm-lock 2.yaml` (2,684 lines, untracked) and `scratch/` sit in the repository root. Neither is committed, but both are release hygiene.
10. **Dead `errorSummary` plumbing.** The column and type exist (`stores/types.ts:29`, `sqlite.ts:228`) and are never populated by the guard.
11. **Extra API and config surface** beyond the spec (section 4a). Documented in the package READMEs for the most part, but the spec text and the code have drifted.
12. **Phase 7 publish pending.** Versions remain 0.0.0 and nothing is published, as expected for a `[HAND]` step.

## 10. Verdict

All C18 gates, stress five times, packaging, and mutation testing pass. Every required C17 test exists and passes. The release blockers are one correctness caveat in the store read-failure path and three secret paths that the spec does not cover. The C9 empty-catch rule and the C16 layout are strict spec departures but do not change guarded behaviour today.
