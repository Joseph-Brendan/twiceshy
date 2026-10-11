# @twiceshy/mcp-proxy

An MCP proxy that sits between an AI agent and its MCP servers and stops repeated actions.

The Kola scenario, in four lines:

1. A slow payment server commits the charge, then delays its reply past the timeout.
2. The agent retries through the proxy, but Twiceshy has the action in doubt and blocks it.
3. The payment server's late result upgrades the record so no human is needed.
4. The customer is charged exactly once.

Run it in 30 seconds:

```bash
npx -y @twiceshy/mcp-proxy --config ./twiceshy.config.json
```

```json
{
  "$schema": "https://unpkg.com/@twiceshy/mcp-proxy/schema.json",
  "store": { "type": "sqlite", "path": "~/.twiceshy/actions.db" },
  "window": "10m",
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

Use `twiceshy doctor --config <file>` first when something looks wrong; it starts every
downstream server, lists each tool as GUARDED or open with the reason, and warns about
free-text fields that can let rephrased retries slip through.
