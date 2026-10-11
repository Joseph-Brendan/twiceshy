# Proxy example: point Claude at Twiceshy

This example runs the Twiceshy MCP proxy in front of a small counter server.
The counter server exposes three tools: `create_charge`, `get_count`, and
`upsert`. Only `create_charge` is guarded here, with `amount` as its key field.

Run the health check first, from the repository root:

```bash
pnpm --filter @twiceshy/example-proxy-claude-config run doctor
```

It builds both packages, starts the counter server, and prints which tools are
guarded and why. The store line points at `examples/proxy-claude-config/.twiceshy/actions.db`.

Run the proxy itself:

```bash
pnpm --filter @twiceshy/example-proxy-claude-config run proxy
```

The proxy waits on stdio for an MCP client. In a normal setup you do not run it
by hand. You add one entry to your MCP client config, exactly as the spec
describes:

```json
{
  "mcpServers": {
    "twiceshy": {
      "command": "npx",
      "args": [
        "-y",
        "@twiceshy/mcp-proxy",
        "--config",
        "/absolute/path/to/twiceshy/examples/proxy-claude-config/twiceshy.config.json"
      ]
    }
  }
}
```

The full snippet is in `claude-desktop.config.json`. Replace the absolute path
with the real path on your machine, then tell your client to load this snippet
instead of its existing server entry.

To see the protection with your own eyes, call `create_charge` twice with the
same `amount` through the proxy. The first call charges and returns a count.
The second call returns the same count as a duplicate, with a note saying the
action already ran, and the counter stays at 1.
