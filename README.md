# Twiceshy

**Twiceshy is a zero-setup, local-first repeat-action guard for AI agents that stops duplicate side effects (refunds, payments, messages, bookings) before they reach the real world.**

### The Kola Scenario

> Kola runs a food delivery app in Lagos. His refund agent sends a ₦1,500 refund to a customer, Ife, through Paystack. Paystack is slow that afternoon, so the agent's request times out after 30 seconds. The refund had actually gone through, but the agent retries. Ife receives ₦3,000.
> 
> Twiceshy sits between the agent and tools to stop this exact duplicate execution.

---

## 30-Second Quickstart

### 1. Library (`twiceshy`)

```bash
npm install twiceshy
```

```ts
import { createGuard } from 'twiceshy';

const guard = createGuard();

const safeRefund = guard.wrap('refund', paystackRefund, {
  keyFields: ['transaction', 'amount'],
});

// Retrying this with identical keyFields will not execute twice
await safeRefund({ transaction: 'TX_123', amount: 1500, reason: 'missing drink' });
```

### 2. MCP Proxy (`@twiceshy/mcp-proxy`)

Add one line to your MCP client config (Claude Desktop, Cursor, Antigravity):

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

---

## Documentation

Full documentation, including "Choosing keyFields", "What in-doubt means", and configuration guides are in the repository and accompanying guides. See [SPEC.md](./SPEC.md) for the formal specification.

## License

MIT © 2026 Joseph Brendan, Dev and Design HQ
