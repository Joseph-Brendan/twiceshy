# Twiceshy

Twiceshy is a repeat-action guard for AI agents. It makes sure the same refund, transfer, message, or booking does not happen twice when an agent retries.

The Kola scenario, in four lines:

1. Kola runs a food delivery app in Lagos. His refund agent sends Ife a 1,500 naira refund through Paystack.
2. Paystack is slow, so the request times out, even though the refund went through.
3. The agent retries, and Ife receives 3,000 naira.
4. Twiceshy records the first refund, blocks the retry, and asks a person when it cannot tell what happened.

**Twiceshy protects one machine.** The SQLite store works for agents on a single computer or server. Teams running agents on several servers need the future Redis or Postgres store. See [Limits](docs/limits.md).

## Pick the right package in under a minute

- Choose **`twiceshy`** if you write your own tool functions in TypeScript or JavaScript and want to protect them. You call `wrap` around your refund, transfer, message, or booking function.
- Choose **`@twiceshy/mcp-proxy`** if your tools already speak MCP and you do not want to change their code. You add one entry to your MCP client config and point the agent at the proxy.

Both packages share the same guard and the same record store. You can start with one and add the other later.

## Quick start: the library

```bash
npm install twiceshy better-sqlite3
```

`better-sqlite3` is the optional SQLite driver used for records that must survive a restart; the in-memory store works without it.

```js
import { createGuard, MemoryStore } from 'twiceshy';

const guard = createGuard({ store: new MemoryStore(), window: '10m' });
const refund = guard.wrap('paystack.refund', paystackRefund, {
  keyFields: ['transaction', 'amount'],
});

await refund({ transaction: 'T123', amount: 1500, reason: 'missing drink' });
```

A retry with the same `transaction` and `amount` returns the first result and does not run the refund again. Full details are in [packages/core/README.md](packages/core/README.md).

## Quick start: the proxy

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

Then run the health check:

```bash
npx -y @twiceshy/mcp-proxy doctor --config /path/to/twiceshy.config.json
```

Full details are in [packages/mcp-proxy/README.md](packages/mcp-proxy/README.md).

## What Twiceshy records and logs

- Arguments and successful results are redacted before storage, using the same field-name rules. Duplicates return the stored, redacted copy.
- `storeResult: false` stores no result at all; a duplicate then returns a short text summary saying the action already ran.
- A cancellation before the tool function is invoked is a definite failure (`FAILED_DEFINITE`, reason "cancelled before start"), which is safe to retry. A cancellation after invocation leaves the record in doubt.
- A late result that contradicts a human resolution fires a `resolution-conflict` event at error level. If the human said "failed" but the action actually succeeded, the record blocks the next call with `IN_DOUBT` until a person decides again.
- Proxy logs at `warn` and `info` carry only an error's class name, Twiceshy code, and classification. The full downstream message appears only at `--log-level debug`, which may contain text from downstream servers.

## Examples

- [Library example: the Kola refund](examples/library-paystack-refund): one refund, two retries, one payment.
- [Proxy example: point Claude at Twiceshy](examples/proxy-claude-config): a real config with the counter fixture server.

## Guides

- [Choosing keyFields](docs/choosing-key-fields.md): the most important safety page.
- [What in doubt means and what to do](docs/in-doubt.md): written for a business owner.
- [Window versus retention](docs/window-and-retention.md): the two time settings.
- [Limits](docs/limits.md): what Twiceshy does not do.
- [Error reference](docs/errors.md): every error code in plain words.

The formal specification is in [SPEC.md](SPEC.md).

## Citation

If you use Twiceshy in research or production, please cite it. The archived release has DOI [10.5281/zenodo.23319599](https://doi.org/10.5281/zenodo.23319599). Machine-readable metadata is in [CITATION.cff](CITATION.cff).

## License

MIT. Copyright 2026 Joseph Brendan, Dev and Design HQ.
