# @twiceshy/mcp-proxy

The Twiceshy proxy is an MCP server that stands in front of your existing MCP servers and stops an AI agent from repeating a money-moving action.

The Kola scenario, in four lines:

1. Kola runs a food delivery app in Lagos. His agent calls a slow payment server to refund Ife 1,500 naira.
2. The payment server commits the charge and then delays its reply past the timeout.
3. The agent retries through the proxy, but Twiceshy has the action in doubt and blocks it.
4. The late reply arrives, Twiceshy upgrades the record to succeeded, and Ife is charged exactly once.

## 30 second install and use

Add one entry to your MCP client config:

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

Then write `twiceshy.config.json`:

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
        "create_refund": { "guard": true, "keyFields": ["transaction", "amount"] },
        "list_transactions": { "guard": false }
      }
    }
  }
}
```

Check the config before your agent uses it:

```bash
npx -y @twiceshy/mcp-proxy doctor --config /path/to/twiceshy.config.json
```

Real output from the runnable example in this repository:

```text
Store    sqlite  ./.twiceshy/actions.db  0 records in doubt

counter       connected   3 tools
  create_charge   GUARDED    (config: guard true)
  get_count       open       (config: guard false)
  upsert          open       (annotation: idempotentHint (trusted))

1 of 1 server connected. 1 tool guarded, 2 open. 0 warnings.
```

`doctor` starts every downstream server, lists every tool as GUARDED or open with the reason, and exits 1 when any server fails. It always shuts down the servers it started.

A runnable version of this setup lives in [examples/proxy-claude-config](../../examples/proxy-claude-config). Run it with `pnpm --filter @twiceshy/example-proxy-claude-config run doctor`.

## Concepts

- **MCP:** Model Context Protocol, the standard way agents connect to outside tools.
- **Proxy:** a process that speaks MCP to the agent on one side and to your real servers on the other side.
- **Downstream server:** a real MCP server behind the proxy, for example a Paystack server or a calendar server.
- **Guarded tool:** a tool the proxy protects with the Twiceshy guard.
- **Open tool:** a tool the proxy forwards untouched, for example a read-only tool.
- **Annotations:** hints a tool can carry, such as `readOnlyHint` or `idempotentHint`. Twiceshy treats them as hints, not guarantees.
- **Duplicate result:** the stored result, which was redacted before storage, plus a note under `_meta["dev.twiceshy/outcome"]`. A visible text line explains what happened. The note says `resultRedacted: true` when any field was replaced, and when `storeResult: false` kept no result the duplicate is a short text summary instead.
- **Blocked result:** a tool error with `isError: true` that tells the agent what happened, why, and what to do next. The proxy never sends a protocol error for a block.

### Which tools are guarded

The first rule that gives an answer wins:

1. Your config: `guard: true` or `guard: false`.
2. Tool annotations: `readOnlyHint: true` means open. `idempotentHint: true` means open while `trustIdempotentHint` is true.
3. Default: guarded. An unknown tool is protected until you say otherwise.

`doctor` shows the reason for every decision.

## Configuration reference

Global options:

| Option | Default | What it does |
|---|---|---|
| `store` | required | `{ "type": "sqlite", "path": "~/.twiceshy/actions.db" }` or `{ "type": "memory" }`. |
| `window` | `'10m'` | How long a finished action counts as a duplicate. |
| `retention` | `'7d'` | How long records are kept for audit. |
| `onStoreFailure` | `'closed'` | `'closed'` refuses guarded calls when the store is down. `'open'` runs them unprotected and emits `guard-bypassed`. |
| `toolNaming` | `'prefix'` | `'prefix'` exposes `server__tool`. `'none'` passes names through and fails when two servers collide. |
| `trustIdempotentHint` | `true` | Trusts the `idempotentHint` annotation. |
| `annotateDuplicates` | `true` | Adds a visible text line to duplicate results. |
| `exposeRecentActions` | `false` | Adds the read-only `twiceshy_recent_actions` tool. |
| `mcpServers` | required | One entry per downstream server. |

Server options:

| Option | What it does |
|---|---|
| `command` and `args` | Starts a local server over stdio. |
| `url` | Connects to a remote server over Streamable HTTP. |
| `env` | Extra environment variables for the child process. `${VAR}` reads from the environment. A missing variable is a config error. |
| `cwd` | Working directory for the child process. `~` expands to your home folder. |
| `tools` | Per-tool options, keyed by the downstream tool name. |

Per-tool options:

| Option | What it does |
|---|---|
| `guard` | `true` or `false` overrides the annotation rules. |
| `keyFields` | The argument fields that define the action. |
| `ignoreFields` | Used when `keyFields` is not set. |
| `normalize` | Per field: `number`, `trim`, `lowercase`, or `lowercase-trim`. |
| `timeoutMs` | Time limit for this tool. A timeout becomes `IN_DOUBT`. |
| `treatToolErrorsAsDefinite` | Treats a tool result with `isError: true` as a definite failure instead of in doubt. |
| `storeResult` | `false` stores no result at all; a duplicate then returns a short text summary saying the action already ran. |

## CLI

| Command | What it does |
|---|---|
| `twiceshy proxy --config <file>` | Runs the proxy. This is what your MCP client launches. With no subcommand, the package runs `proxy`. |
| `twiceshy doctor --config <file>` | Checks the config, starts every server, lists every tool with its reason, and warns about free-text fields. |
| `twiceshy list [--state IN_DOUBT] [--since 1h]` | Shows records in a table. |
| `twiceshy show <id>` | Shows one record in full. |
| `twiceshy resolve <id> --succeeded\|--failed --by <name> [--note "..."]` | A person settles an in-doubt record. |
| `twiceshy allow <fingerprint> --by <name> [--note "..."]` | A person approves one repeat. |
| `twiceshy purge [--older-than 30d] [--yes]` | Removes records past retention. |

Every command supports `--help` with an example and `--json` for machine output. Exit codes: 0 success, 1 error, 2 bad usage. Errors print what, why, and fix on separate lines.

Logs go to stderr as JSON lines. `--log-level` accepts `error`, `warn`, `info`, or `debug`. Standard output carries MCP messages only, so the stream stays clean.

At `warn` and `info`, a log line carries only an error's class name, Twiceshy code, and classification. The full downstream message appears only at `debug`, and debug logs may contain text printed by downstream servers, so treat them as sensitive.

A cancellation before the downstream tool is invoked records `FAILED_DEFINITE` with reason "cancelled before start", which is safe to retry. A cancellation after invocation leaves the record `IN_DOUBT`. A late result that contradicts a human resolution logs an error-level `resolution-conflict` event; if the human said "failed" but the action succeeded, the record blocks the next call with `IN_DOUBT`.

## Proxy tools

- `twiceshy_status`: read-only. Shows which servers are connected, how many tools are guarded, and how many records are in doubt.
- `twiceshy_recent_actions`: read-only, off by default. Lists recent guarded actions with redacted arguments.

No proxy tool can resolve, delete, purge, or approve anything. Those actions belong to a person, through the CLI.

## Limits

- `SqliteStore` protects one machine only. Agents on several servers need the future Redis or Postgres store.
- Twiceshy does not forward sampling or elicitation in v1. A downstream server that asks gets `UNSUPPORTED_FEATURE`, and the message says the feature is planned for v1.1.
- Annotations are hints. A tool marked `idempotentHint: true` that is not idempotent runs unguarded unless you set `trustIdempotentHint: false` or `guard: true`.

The full list is in [Limits](../../docs/limits.md).

## Guides

- [Choosing keyFields](../../docs/choosing-key-fields.md)
- [What in doubt means and what to do](../../docs/in-doubt.md)
- [Window versus retention](../../docs/window-and-retention.md)
- [Limits](../../docs/limits.md)
- [Error reference](../../docs/errors.md)

## License

MIT. Copyright 2026 Joseph Brendan, Dev and Design HQ.
